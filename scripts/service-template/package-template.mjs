/**
 * Package a generated BNG Service GeoPackage as a copy of the QGIS template
 * folder, ready to open: the template's project, guide and reference lists,
 * with the generated rows in the template's own GeoPackage.
 *
 * The template's project (`BNG Service Habitat Mapping.qgz`) reads its
 * layers from `./Layers/BNG Service Layers.gpkg`, by that path and by table
 * name. A generated file opened any other way leaves every layer
 * "unavailable". So the rows go into a copy of the template's own (empty)
 * GeoPackage, which keeps what QGIS wrote there: its spatial indexes, kept
 * up to date by its triggers, and its feature counts. The generated file's
 * template version record replaces the template's, so a file generated for
 * another version, or with a version flaw, stays what it was.
 *
 * The template comes from the bng-metric-template sibling, or the checkout
 * BNG_TEMPLATE_DIR names (see convert.mjs).
 */

import { copyFileSync, cpSync, existsSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { zipFolder } from "../zip.mjs";
import { TEMPLATE_DIR_ENV, TEMPLATE_REPO, templateDir } from "./convert.mjs";

export const TEMPLATE_FOLDER = path.join("templates", "bng-service");
export const PROJECT_FILE = "BNG Service Habitat Mapping.qgz";
export const LAYERS_GPKG = path.join("Layers", "BNG Service Layers.gpkg");

const GPKG_MAGIC = "GP";
const GPKG_HEADER_SIZE = 8;
const FLAG_LITTLE_ENDIAN = 0x01;
const FLAG_EMPTY = 0x10;
const ENVELOPE_SHIFT = 1;
const ENVELOPE_MASK = 0x07;
// The envelope's size in bytes, by its indicator: none, XY, XYZ, XYM, XYZM.
const ENVELOPE_BYTES = [0, 32, 48, 48, 64];
const DOUBLE_BYTES = 8;
const COORD_BYTES = 16;
const WKB_HEADER_BYTES = 5;
const COUNT_BYTES = 4;
// WKB types; a Z, M or ZM type differs from its 2D type by a multiple of 1000.
const WKB_TYPE_FAMILY = 1000;
const WKB_POINT = 1;
const WKB_LINESTRING = 2;
const WKB_POLYGON = 3;

/** The template folder in the template checkout, or an error naming it. */
export function templateFolder(root = templateDir()) {
  const folder = path.join(root, TEMPLATE_FOLDER);
  if (
    !existsSync(path.join(folder, PROJECT_FILE)) ||
    !existsSync(path.join(folder, LAYERS_GPKG))
  ) {
    throw new Error(
      `No BNG Service template at ${folder}: run \`npm run bootstrap\` to clone ${TEMPLATE_REPO}, or set ${TEMPLATE_DIR_ENV} to a checkout`,
    );
  }
  return folder;
}

function readCoords(wkb, start, xs, ys) {
  const little = wkb[start] === 1;
  const uint = (at) => (little ? wkb.readUInt32LE(at) : wkb.readUInt32BE(at));
  const double = (at) => (little ? wkb.readDoubleLE(at) : wkb.readDoubleBE(at));
  const type = uint(start + 1) % WKB_TYPE_FAMILY;
  let at = start + WKB_HEADER_BYTES;
  const point = () => {
    xs.push(double(at));
    ys.push(double(at + DOUBLE_BYTES));
    at += COORD_BYTES;
  };
  const points = () => {
    const n = uint(at);
    at += COUNT_BYTES;
    for (let i = 0; i < n; i += 1) {
      point();
    }
  };
  if (type === WKB_POINT) {
    point();
  } else if (type === WKB_LINESTRING) {
    points();
  } else if (type === WKB_POLYGON) {
    const rings = uint(at);
    at += COUNT_BYTES;
    for (let r = 0; r < rings; r += 1) {
      points();
    }
  } else {
    const parts = uint(at);
    at += COUNT_BYTES;
    for (let p = 0; p < parts; p += 1) {
      at = readCoords(wkb, at, xs, ys);
    }
  }
  return at;
}

/**
 * The bounding box of a GeoPackage geometry blob, from its envelope or, when
 * it has none, its coordinates; null for no geometry.
 *
 * @returns {{ minX: number, maxX: number, minY: number, maxY: number,
 *   empty: boolean } | null}
 */
export function geometryBounds(blob) {
  if (!blob || blob.toString("latin1", 0, 2) !== GPKG_MAGIC) {
    return null;
  }
  const flags = blob[3];
  const little = (flags & FLAG_LITTLE_ENDIAN) !== 0;
  const envelope = (flags >> ENVELOPE_SHIFT) & ENVELOPE_MASK;
  const empty = (flags & FLAG_EMPTY) !== 0;
  if (envelope > 0) {
    const double = (i) => {
      const at = GPKG_HEADER_SIZE + i * DOUBLE_BYTES;
      return little ? blob.readDoubleLE(at) : blob.readDoubleBE(at);
    };
    return {
      minX: double(0),
      maxX: double(1),
      minY: double(2),
      maxY: double(3),
      empty,
    };
  }
  const xs = [];
  const ys = [];
  readCoords(blob, GPKG_HEADER_SIZE + ENVELOPE_BYTES[envelope], xs, ys);
  if (xs.length === 0) {
    return { minX: null, maxX: null, minY: null, maxY: null, empty: true };
  }
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
    empty,
  };
}

/**
 * The SQL functions the template's spatial-index triggers call, which GDAL
 * provides and plain SQLite does not.
 */
function registerSpatialFunctions(db) {
  const bound = (key) => (blob) => geometryBounds(blob)?.[key] ?? null;
  const options = { deterministic: true };
  db.function("ST_MinX", options, bound("minX"));
  db.function("ST_MaxX", options, bound("maxX"));
  db.function("ST_MinY", options, bound("minY"));
  db.function("ST_MaxY", options, bound("maxY"));
  db.function("ST_IsEmpty", options, (blob) => {
    const bounds = geometryBounds(blob);
    return !bounds || bounds.empty ? 1 : 0;
  });
}

const featureTables = (db, schema) =>
  db
    .prepare(
      `SELECT table_name FROM ${schema}.gpkg_contents WHERE data_type = 'features' ORDER BY table_name`,
    )
    .pluck()
    .all();

const columnsOf = (db, schema, table) =>
  db
    .prepare(`PRAGMA ${schema}.table_info("${table}")`)
    .all()
    .map((c) => c.name);

/** Refuse a file whose tables or columns are not the template's. */
function assertSameSchema(db) {
  const template = featureTables(db, "main");
  const source = featureTables(db, "src");
  const missing = template.filter((t) => !source.includes(t));
  const extra = source.filter((t) => !template.includes(t));
  const problems = [];
  if (missing.length > 0) {
    problems.push(`it has no ${missing.join(", ")}`);
  }
  if (extra.length > 0) {
    problems.push(`the template has no ${extra.join(", ")}`);
  }
  for (const table of template.filter((t) => source.includes(t))) {
    const want = columnsOf(db, "main", table);
    const have = columnsOf(db, "src", table);
    const lacking = want.filter((c) => !have.includes(c));
    if (lacking.length > 0) {
      problems.push(`${table} has no ${lacking.join(", ")}`);
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `The file does not match this template checkout's schema (${problems.join("; ")}). bng-library and ${TEMPLATE_REPO} are probably at different versions.`,
    );
  }
  return template;
}

function copyRows(db, table) {
  const names = columnsOf(db, "main", table)
    .map((c) => `"${c}"`)
    .join(", ");
  db.exec(
    `INSERT INTO main."${table}" (${names}) SELECT ${names} FROM src."${table}" ORDER BY fid`,
  );
}

/** Each layer's extent, as GDAL records it, so QGIS zooms to the data. */
function updateExtent(db, table) {
  const extent = db
    .prepare(
      `SELECT min(minx) minX, min(miny) minY, max(maxx) maxX, max(maxy) maxY FROM "rtree_${table}_geom"`,
    )
    .get();
  if (extent.minX !== null) {
    db.prepare(
      "UPDATE gpkg_contents SET min_x = ?, min_y = ?, max_x = ?, max_y = ? WHERE table_name = ?",
    ).run(extent.minX, extent.minY, extent.maxX, extent.maxY, table);
  }
}

const hasTable = (db, schema, name) =>
  Boolean(
    db
      .prepare(
        `SELECT 1 FROM ${schema}.sqlite_master WHERE type = 'table' AND name = ?`,
      )
      .get(name),
  );

/** The generated file's version records, in place of the template's. */
function copyVersionRecords(db) {
  for (const table of ["gpkg_metadata_reference", "gpkg_metadata"]) {
    if (hasTable(db, "main", table)) {
      db.exec(`DELETE FROM main.${table}`);
    }
  }
  for (const table of ["gpkg_metadata", "gpkg_metadata_reference"]) {
    if (hasTable(db, "src", table) && hasTable(db, "main", table)) {
      db.exec(`INSERT INTO main.${table} SELECT * FROM src.${table}`);
    }
  }
}

/**
 * Write the template's GeoPackage, `templateGpkg`, to `outGpkg` holding every
 * feature row of `sourceGpkg`.
 *
 * @returns {Record<string, number>} the rows written, by table
 */
export function loadIntoTemplateGpkg(templateGpkg, sourceGpkg, outGpkg) {
  copyFileSync(templateGpkg, outGpkg);
  const db = new Database(outGpkg);
  try {
    registerSpatialFunctions(db);
    db.prepare("ATTACH DATABASE ? AS src").run(sourceGpkg);
    const tables = assertSameSchema(db);
    const counts = {};
    db.transaction(() => {
      for (const table of tables) {
        copyRows(db, table);
        updateExtent(db, table);
        counts[table] = db
          .prepare(`SELECT count(*) FROM main."${table}"`)
          .pluck()
          .get();
      }
      copyVersionRecords(db);
    })();
    db.exec("DETACH DATABASE src");
    db.exec("VACUUM");
    return counts;
  } finally {
    db.close();
  }
}

/**
 * Package `sourceGpkg` as a template folder named `name` in `outDir`, and
 * that folder zipped beside it.
 *
 * @param {string} sourceGpkg
 * @param {{ outDir: string, name: string, templateRoot?: string }} options
 * @returns {{ folder: string, zip: string, counts: Record<string, number> }}
 */
export function packageForQgis(sourceGpkg, { outDir, name, templateRoot }) {
  const template = templateFolder(templateRoot);
  const folder = path.join(outDir, name);
  const zip = `${folder}.zip`;
  for (const target of [folder, zip]) {
    if (existsSync(target)) {
      throw new Error(
        `${target} already exists: move it, or pick another name`,
      );
    }
  }
  cpSync(template, folder, { recursive: true });
  const counts = loadIntoTemplateGpkg(
    path.join(template, LAYERS_GPKG),
    sourceGpkg,
    path.join(folder, LAYERS_GPKG),
  );
  zipFolder(folder, zip);
  return { folder, zip, counts };
}
