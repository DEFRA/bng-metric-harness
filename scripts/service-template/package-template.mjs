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
const GPKG_MAGIC_BYTES = 2;
const GPKG_FLAGS_OFFSET = 3;
const GPKG_HEADER_SIZE = 8;
const FLAG_LITTLE_ENDIAN = 0x01;
const FLAG_EMPTY = 0x10;
const ENVELOPE_SHIFT = 1;
const ENVELOPE_MASK = 0x07;
const DOUBLE_BYTES = 8;
// An envelope's doubles, by its indicator: none, XY, XYZ, XYM, XYZM. The
// GeoPackage spec reserves indicators 5 to 7, so a blob with one is refused.
const XY_ENVELOPE = 4;
const XYZ_OR_XYM_ENVELOPE = 6;
const XYZM_ENVELOPE = 8;
const ENVELOPE_DOUBLES = [
  0,
  XY_ENVELOPE,
  XYZ_OR_XYM_ENVELOPE,
  XYZ_OR_XYM_ENVELOPE,
  XYZM_ENVELOPE,
];
// Where each bound sits in the envelope, as doubles from its start.
const ENVELOPE_MIN_X = 0;
const ENVELOPE_MAX_X = 1;
const ENVELOPE_MIN_Y = 2;
const ENVELOPE_MAX_Y = 3;
const WKB_HEADER_BYTES = 5;
const COUNT_BYTES = 4;
// An ISO WKB type is its 2D type plus 1000 for Z, 2000 for M or 3000 for
// ZM, which sets how many doubles each coordinate holds.
const WKB_TYPE_FAMILY = 1000;
const XY_DIMENSIONS = 2;
const XYZ_OR_XYM_DIMENSIONS = 3;
const XYZM_DIMENSIONS = 4;
const DIMENSIONS_BY_FAMILY = [
  XY_DIMENSIONS,
  XYZ_OR_XYM_DIMENSIONS,
  XYZ_OR_XYM_DIMENSIONS,
  XYZM_DIMENSIONS,
];
const WKB_POINT = 1;
const WKB_LINESTRING = 2;
const WKB_POLYGON = 3;
// Multi-geometries and collections (4 to 7) are lists of geometries.
const WKB_GEOMETRY_COLLECTION = 7;

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

/**
 * Collect the X and Y of every coordinate of the WKB geometry at `start`
 * into `xs` and `ys`, whatever its dimensions; returns the offset after it.
 * Refuses a geometry type it does not know, rather than read the wrong bytes.
 */
function readCoords(wkb, start, xs, ys) {
  const little = wkb[start] === 1;
  const uint = (offset) =>
    little ? wkb.readUInt32LE(offset) : wkb.readUInt32BE(offset);
  const double = (offset) =>
    little ? wkb.readDoubleLE(offset) : wkb.readDoubleBE(offset);
  const code = uint(start + 1);
  const type = code % WKB_TYPE_FAMILY;
  const dimensions = DIMENSIONS_BY_FAMILY[Math.floor(code / WKB_TYPE_FAMILY)];
  if (!dimensions || type < WKB_POINT || type > WKB_GEOMETRY_COLLECTION) {
    throw new Error(`unsupported WKB geometry type ${code}`);
  }
  const coordBytes = dimensions * DOUBLE_BYTES;
  let at = start + WKB_HEADER_BYTES;
  const point = () => {
    xs.push(double(at));
    ys.push(double(at + DOUBLE_BYTES));
    at += coordBytes;
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

/** The bounds an envelope records: min X, max X, min Y, max Y first. */
function envelopeBounds(blob, little, empty) {
  const bound = (index) => {
    const offset = GPKG_HEADER_SIZE + index * DOUBLE_BYTES;
    return little ? blob.readDoubleLE(offset) : blob.readDoubleBE(offset);
  };
  return {
    minX: bound(ENVELOPE_MIN_X),
    maxX: bound(ENVELOPE_MAX_X),
    minY: bound(ENVELOPE_MIN_Y),
    maxY: bound(ENVELOPE_MAX_Y),
    empty,
  };
}

/**
 * The bounding box of a GeoPackage geometry blob, from its envelope or, when
 * it has none, its coordinates; null for no geometry. Refuses an envelope
 * indicator the spec reserves (5 to 7).
 *
 * @returns {{ minX: number, maxX: number, minY: number, maxY: number,
 *   empty: boolean } | null}
 */
export function geometryBounds(blob) {
  if (blob?.toString("latin1", 0, GPKG_MAGIC_BYTES) !== GPKG_MAGIC) {
    return null;
  }
  const flags = blob[GPKG_FLAGS_OFFSET];
  const little = (flags & FLAG_LITTLE_ENDIAN) !== 0;
  const envelope = (flags >> ENVELOPE_SHIFT) & ENVELOPE_MASK;
  const empty = (flags & FLAG_EMPTY) !== 0;
  if (envelope >= ENVELOPE_DOUBLES.length) {
    throw new Error(`reserved GeoPackage envelope indicator ${envelope}`);
  }
  if (envelope > 0) {
    return envelopeBounds(blob, little, empty);
  }
  const xs = [];
  const ys = [];
  readCoords(
    blob,
    GPKG_HEADER_SIZE + ENVELOPE_DOUBLES[envelope] * DOUBLE_BYTES,
    xs,
    ys,
  );
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

const featureTables = (db) =>
  db
    .prepare(
      "SELECT table_name FROM gpkg_contents WHERE data_type = 'features' ORDER BY table_name",
    )
    .pluck()
    .all();

const columnsOf = (db, table) =>
  db
    .prepare(`PRAGMA table_info("${table}")`)
    .all()
    .map((c) => c.name);

const hasTable = (db, name) =>
  Boolean(
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name),
  );

/** Refuse a source whose tables or columns are not the template's. */
function assertSameSchema(db, source) {
  const template = featureTables(db);
  const sourceTables = featureTables(source);
  const missing = template.filter((t) => !sourceTables.includes(t));
  const extra = sourceTables.filter((t) => !template.includes(t));
  const problems = [];
  if (missing.length > 0) {
    problems.push(`it has no ${missing.join(", ")}`);
  }
  if (extra.length > 0) {
    problems.push(`the template has no ${extra.join(", ")}`);
  }
  for (const table of template.filter((t) => sourceTables.includes(t))) {
    const have = columnsOf(source, table);
    const lacking = columnsOf(db, table).filter((c) => !have.includes(c));
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

/** Copy every row of `columns` from `source`'s table into `db`'s. */
function copyTable(db, source, table, columns, orderBy = "") {
  const names = columns.map((c) => `"${c}"`).join(", ");
  const insert = db.prepare(
    `INSERT INTO "${table}" (${names}) VALUES (${columns.map(() => "?").join(", ")})`,
  );
  const select = source
    .prepare(`SELECT ${names} FROM "${table}" ${orderBy}`)
    .raw();
  for (const row of select.iterate()) {
    insert.run(row);
  }
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

const METADATA_TABLES = ["gpkg_metadata", "gpkg_metadata_reference"];

/** The generated file's version records, in place of the template's. */
function copyVersionRecords(db, source) {
  for (const table of [...METADATA_TABLES].reverse()) {
    if (hasTable(db, table)) {
      db.exec(`DELETE FROM ${table}`);
    }
  }
  for (const table of METADATA_TABLES) {
    if (hasTable(source, table) && hasTable(db, table)) {
      copyTable(db, source, table, columnsOf(db, table));
    }
  }
}

/**
 * A GeoPackage path as a plain local file path, for SQLite: absolute, so it
 * is never read as a `file:` URI, which SQLITE_USE_URI=1 would let carry
 * connection parameters (`?vfs=`, `?mode=`) in a name.
 */
export function localDatabasePath(file) {
  const resolved = path.resolve(file);
  if (!path.isAbsolute(resolved) || resolved.startsWith("file:")) {
    throw new Error(`${file} is not a local file path`);
  }
  return resolved;
}

/**
 * Write the template's GeoPackage, `templateGpkg`, to `outGpkg` holding every
 * feature row of `sourceGpkg`. The source is read through a connection of
 * its own, read-only, rather than attached to the output by name.
 *
 * @returns {Record<string, number>} the rows written, by table
 */
export function loadIntoTemplateGpkg(templateGpkg, sourceGpkg, outGpkg) {
  const outPath = localDatabasePath(outGpkg);
  copyFileSync(templateGpkg, outPath);
  const source = new Database(localDatabasePath(sourceGpkg), {
    readonly: true,
    fileMustExist: true,
  });
  const db = new Database(outPath);
  try {
    registerSpatialFunctions(db);
    const tables = assertSameSchema(db, source);
    const counts = {};
    db.transaction(() => {
      for (const table of tables) {
        copyTable(db, source, table, columnsOf(db, table), "ORDER BY fid");
        updateExtent(db, table);
        counts[table] = db
          .prepare(`SELECT count(*) FROM "${table}"`)
          .pluck()
          .get();
      }
      copyVersionRecords(db, source);
    })();
    db.exec("VACUUM");
    return counts;
  } finally {
    db.close();
    source.close();
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
