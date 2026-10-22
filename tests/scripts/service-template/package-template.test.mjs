import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkLineage, generateSyntheticGpkg } from "#bng-lib";
import { zipFolder } from "../../../scripts/zip.mjs";
import {
  LAYERS_GPKG,
  PROJECT_FILE,
  geometryBounds,
  loadIntoTemplateGpkg,
  packageForQgis,
  templateFolder,
} from "../../../scripts/service-template/package-template.mjs";
import {
  WORKBOOK_STRICTNESS,
  checkGenerated,
  syntheticStrictness,
} from "../../../scripts/service-template/check-generated.mjs";
import { TEMPLATE_DIR_ENV } from "../../../scripts/service-template/convert.mjs";
import {
  afterBngServiceWrite,
  failures,
} from "../../../scripts/gen-gpkg-after-write.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const GEN_GPKG = path.join(ROOT, "scripts/gen-gpkg.mjs");
const FEATURE_TABLES = [
  "Red Line Boundary",
  "Area Habitats Baseline",
  "Area Habitats Post-Intervention",
  "Vertical Area Habitats Baseline",
  "Vertical Area Habitats Post-Intervention",
  "Hedgerows Baseline",
  "Hedgerows Post-Intervention",
  "Watercourses Baseline",
  "Watercourses Post-Intervention",
  "Individual Trees Baseline",
  "Individual Trees Post-Intervention",
];
const LOCAL_HEADER = 0x04034b50;
const END_OF_CENTRAL = 0x06054b50;
const CENTRAL_HEADER_SIZE = 46;
const LOCAL_HEADER_SIZE = 30;
const METHOD_DEFLATED = 8;

// The template is the bng-metric-template sibling or BNG_TEMPLATE_DIR. CI
// clones it (REQUIRE_CONVERTER), so there a missing template fails; a local
// checkout without it skips the tests that need it.
function findTemplate() {
  try {
    return templateFolder();
  } catch (err) {
    if (process.env.REQUIRE_CONVERTER === "true") {
      throw err;
    }
    return null;
  }
}
const TEMPLATE = findTemplate();
const withTemplate = TEMPLATE ? describe : describe.skip;

let dir;
// Inside the harness, as --outdir must be; test-data/ is gitignored.
beforeAll(() => {
  const testData = path.join(ROOT, "test-data");
  mkdirSync(testData, { recursive: true });
  dir = mkdtempSync(path.join(testData, "package-template-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

let counter = 0;
function generated(options = {}) {
  counter += 1;
  const file = path.join(dir, `site-${counter}.gpkg`);
  const { buffer } = generateSyntheticGpkg({
    format: "bng-service",
    numParcels: 8,
    seed: 3,
    ...options,
  });
  writeFileSync(file, buffer);
  return file;
}

function withDb(file, fn) {
  const db = new Database(file, { readonly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

const count = (db, table) =>
  db.prepare(`SELECT count(*) FROM "${table}"`).pluck().get();

/** Every entry of a zip, read back from its central directory. */
function unzip(zipPath) {
  const zip = readFileSync(zipPath);
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(zip.readUInt32LE(end)).toBe(END_OF_CENTRAL);
  const total = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const entries = new Map();
  for (let i = 0; i < total; i += 1) {
    const method = zip.readUInt16LE(at + 10);
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const offset = zip.readUInt32LE(at + 42);
    const name = zip.toString(
      "utf8",
      at + CENTRAL_HEADER_SIZE,
      at + CENTRAL_HEADER_SIZE + nameLength,
    );
    expect(zip.readUInt32LE(offset)).toBe(LOCAL_HEADER);
    const start = offset + LOCAL_HEADER_SIZE + zip.readUInt16LE(offset + 26);
    const body = zip.subarray(start, start + size);
    entries.set(name, method === METHOD_DEFLATED ? inflateRawSync(body) : body);
    at += CENTRAL_HEADER_SIZE + nameLength;
  }
  return entries;
}

describe("zipFolder", () => {
  it("zips a folder under its own name, folders and UTF-8 names included", () => {
    const folder = path.join(dir, "Zip me");
    mkdirSync(path.join(folder, "Sub folder"), { recursive: true });
    writeFileSync(path.join(folder, "a.txt"), "a".repeat(1000));
    writeFileSync(path.join(folder, "Sub folder", "café.csv"), "x,y\n1,2\n");
    writeFileSync(path.join(folder, "tiny"), "z");
    const entries = unzip(zipFolder(folder, path.join(dir, "zip-me.zip")));
    expect([...entries.keys()]).toEqual([
      "Zip me/",
      "Zip me/Sub folder/",
      "Zip me/Sub folder/café.csv",
      "Zip me/a.txt",
      "Zip me/tiny",
    ]);
    expect(entries.get("Zip me/a.txt").toString()).toBe("a".repeat(1000));
    expect(entries.get("Zip me/Sub folder/café.csv").toString()).toBe(
      "x,y\n1,2\n",
    );
    expect(entries.get("Zip me/tiny").toString()).toBe("z");
  });

  it("gives the same bytes for the same files and date", () => {
    const folder = path.join(dir, "Same");
    mkdirSync(folder, { recursive: true });
    writeFileSync(path.join(folder, "f"), "content");
    const date = new Date(2026, 0, 2, 3, 4, 6);
    const a = readFileSync(
      zipFolder(folder, path.join(dir, "same-a.zip"), { date }),
    );
    const b = readFileSync(
      zipFolder(folder, path.join(dir, "same-b.zip"), { date }),
    );
    expect(a.equals(b)).toBe(true);
  });
});

describe("geometryBounds", () => {
  const POINT_WKB = Buffer.alloc(21);
  POINT_WKB.writeUInt8(1, 0);
  POINT_WKB.writeUInt32LE(1, 1);
  POINT_WKB.writeDoubleLE(460000.5, 5);
  POINT_WKB.writeDoubleLE(210000.25, 13);

  /** A GeoPackage blob, little-endian, SRS 27700, with no envelope. */
  function blob(wkb, flags = 0x01) {
    const header = Buffer.from([0x47, 0x50, 0, flags, 0, 0, 0, 0]);
    header.writeInt32LE(27700, 4);
    return Buffer.concat([header, wkb]);
  }

  it("reads a geometry with no envelope from its coordinates", () => {
    expect(geometryBounds(blob(POINT_WKB))).toEqual({
      minX: 460000.5,
      maxX: 460000.5,
      minY: 210000.25,
      maxY: 210000.25,
      empty: false,
    });
  });

  it("reads the envelope a generated line carries, and matches its coordinates", () => {
    const file = generated();
    withDb(file, (db) => {
      for (const { geom } of db
        .prepare('SELECT geom FROM "Hedgerows Baseline"')
        .all()) {
        const bounds = geometryBounds(geom);
        expect(bounds.minX).toBeLessThanOrEqual(bounds.maxX);
        expect(bounds.minY).toBeLessThanOrEqual(bounds.maxY);
        expect(bounds.empty).toBe(false);
      }
    });
  });

  /** ISO WKB for a line, with `dimensions` doubles a coordinate. */
  function lineWkb(code, coords) {
    const dimensions = coords[0].length;
    const wkb = Buffer.alloc(9 + coords.length * dimensions * 8);
    wkb.writeUInt8(1, 0);
    wkb.writeUInt32LE(code, 1);
    wkb.writeUInt32LE(coords.length, 5);
    coords.flat().forEach((v, i) => wkb.writeDoubleLE(v, 9 + i * 8));
    return wkb;
  }

  it.each([
    [
      "LINESTRING",
      2,
      [
        [1, 10],
        [5, 2],
      ],
    ],
    [
      "LINESTRING Z",
      1002,
      [
        [1, 10, 99],
        [5, 2, -99],
      ],
    ],
    [
      "LINESTRING M",
      2002,
      [
        [1, 10, 99],
        [5, 2, -99],
      ],
    ],
    [
      "LINESTRING ZM",
      3002,
      [
        [1, 10, 99, 7],
        [5, 2, -99, 7],
      ],
    ],
  ])("reads each coordinate of a %s with no envelope", (_, code, coords) => {
    expect(geometryBounds(blob(lineWkb(code, coords)))).toEqual({
      minX: 1,
      maxX: 5,
      minY: 2,
      maxY: 10,
      empty: false,
    });
  });

  it("refuses a geometry type it does not know, or an envelope the spec reserves", () => {
    expect(() => geometryBounds(blob(lineWkb(4002, [[1, 2]])))).toThrow(
      /unsupported WKB geometry type 4002/,
    );
    expect(() => geometryBounds(blob(lineWkb(17, [[1, 2]])))).toThrow(
      /unsupported WKB geometry type 17/,
    );
    const reserved = 0x01 | (5 << 1);
    expect(() => geometryBounds(blob(POINT_WKB, reserved))).toThrow(
      /reserved GeoPackage envelope indicator 5/,
    );
  });

  it("gives null for no geometry, or a blob that is not a GeoPackage geometry", () => {
    expect(geometryBounds(null)).toBeNull();
    expect(geometryBounds(Buffer.from("not a geometry"))).toBeNull();
  });
});

describe("checkGenerated", () => {
  /** A copy of `file` whose first Retained hedge names a parent not there. */
  function brokenLineage(file) {
    const broken = path.join(dir, `broken-${path.basename(file)}`);
    copyFileSync(file, broken);
    const db = new Database(broken);
    db.prepare(
      `UPDATE "Hedgerows Post-Intervention" SET "Parent Ref" = 'NOPE', parent_uuid = 'nope'
       WHERE fid = (SELECT min(fid) FROM "Hedgerows Post-Intervention" WHERE "Parent Ref" IS NOT NULL)`,
    ).run();
    db.close();
    return broken;
  }

  it("says why lineage was not checked, rather than reporting no problems", () => {
    const legacy = path.join(
      ROOT,
      "example-files/valid/Post-intervention - complete.gpkg",
    );
    const { ok, findings } = checkGenerated(legacy, {
      strictLineage: true,
      strictValues: false,
    });
    expect(ok).toBe(false);
    expect(findings[0]).toEqual({
      level: "error",
      text: expect.stringMatching(
        /^lineage: not checked: not a BNG Service file/,
      ),
    });
  });

  it("passes a generated file, strictly", () => {
    const { ok, findings } = checkGenerated(
      generated(),
      syntheticStrictness({ contentFlaws: 0 }),
    );
    expect(ok).toBe(true);
    expect(findings.map((f) => f.level)).toEqual(["info", "info"]);
  });

  it("fails a file whose lineage is broken, where it should pass", () => {
    const { ok, findings } = checkGenerated(
      brokenLineage(generated()),
      WORKBOOK_STRICTNESS,
    );
    expect(ok).toBe(false);
    expect(findings[0]).toMatchObject({ level: "error" });
    expect(findings[0].text).toMatch(/^lineage: \d+ problem/);
  });

  it("only warns on values where habitats are pinned, as the legacy list offers what the template does not", () => {
    expect(syntheticStrictness({ contentFlaws: 0, habitatPins: 1 })).toEqual({
      strictLineage: true,
      strictValues: false,
    });
    expect(syntheticStrictness({ contentFlaws: 0 })).toEqual({
      strictLineage: true,
      strictValues: true,
    });
  });

  it("only warns where a flaw asked for may break it", () => {
    const { ok, findings } = checkGenerated(
      brokenLineage(generated()),
      syntheticStrictness({ contentFlaws: 1 }),
    );
    expect(ok).toBe(true);
    expect(findings[0].level).toBe("warn");
  });
});

withTemplate("loadIntoTemplateGpkg", () => {
  const templateGpkg = TEMPLATE && path.join(TEMPLATE, LAYERS_GPKG);

  it("writes every feature row into the template's own file, its indexes and counts kept", () => {
    const source = generated();
    const out = path.join(dir, "loaded.gpkg");
    const counts = loadIntoTemplateGpkg(templateGpkg, source, out);
    withDb(source, (src) =>
      withDb(out, (db) => {
        for (const table of FEATURE_TABLES) {
          expect(counts[table], table).toBe(count(src, table));
          expect(count(db, table), table).toBe(count(src, table));
          expect(count(db, `rtree_${table}_geom`), table).toBe(
            count(src, table),
          );
          expect(
            db
              .prepare(
                "SELECT feature_count FROM gpkg_ogr_contents WHERE table_name = ?",
              )
              .pluck()
              .get(table),
            table,
          ).toBe(count(src, table));
        }
        const extent = db
          .prepare(
            "SELECT min_x, max_x FROM gpkg_contents WHERE table_name = 'Red Line Boundary'",
          )
          .get();
        expect(extent.min_x).toBeLessThan(extent.max_x);
        expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
      }),
    );
    expect(checkLineage(out)).toEqual([]);
  });

  it("keeps the generated file's template version record, not the template's", () => {
    const source = generated({ templateVersion: "1.7" });
    const out = path.join(dir, "version.gpkg");
    loadIntoTemplateGpkg(templateGpkg, source, out);
    const records = (file) =>
      withDb(file, (db) =>
        db.prepare("SELECT metadata FROM gpkg_metadata").pluck().all(),
      );
    expect(records(out)).toEqual(records(source));
    expect(records(out)[0]).toContain('"1.7"');
  });

  it("leaves no output file when the load fails", () => {
    const source = generated();
    const db = new Database(source);
    db.exec('ALTER TABLE "Hedgerows Baseline" DROP COLUMN "Comment"');
    db.close();
    const out = path.join(dir, "never-written.gpkg");
    expect(() => loadIntoTemplateGpkg(templateGpkg, source, out)).toThrow();
    expect(existsSync(out)).toBe(false);
  });

  it("refuses a file whose columns are not the template's", () => {
    const source = generated();
    const db = new Database(source);
    db.exec('ALTER TABLE "Hedgerows Baseline" DROP COLUMN "Comment"');
    db.close();
    expect(() =>
      loadIntoTemplateGpkg(
        templateGpkg,
        source,
        path.join(dir, "refused.gpkg"),
      ),
    ).toThrow(/Hedgerows Baseline has no Comment.*different versions/);
  });
});

withTemplate("afterBngServiceWrite", () => {
  it("records a packaging failure with the file and carries on, rather than throw", () => {
    const file = generated();
    const strictness = syntheticStrictness({ contentFlaws: 0 });
    afterBngServiceWrite(file, { strictness, packageTemplate: true });
    expect(failures().map((f) => f.file)).not.toContain(file);
    // The folder is there now, so packaging the file again fails.
    expect(() =>
      afterBngServiceWrite(file, { strictness, packageTemplate: true }),
    ).not.toThrow();
    expect(failures()).toContainEqual({
      file,
      reason: expect.stringMatching(/^not packaged: .*already exists/),
    });
  });
});

withTemplate("packageForQgis", () => {
  it("writes a copy of the template folder holding the file, and its zip", () => {
    const { folder, zip } = packageForQgis(generated(), {
      outDir: dir,
      name: "Demo site",
    });
    expect(existsSync(path.join(folder, PROJECT_FILE))).toBe(true);
    expect(readdirSync(folder)).toEqual(readdirSync(TEMPLATE));
    const entries = unzip(zip);
    expect(entries.has(`Demo site/${PROJECT_FILE}`)).toBe(true);
    expect(
      entries
        .get("Demo site/Layers/BNG Service Layers.gpkg")
        .equals(readFileSync(path.join(folder, LAYERS_GPKG))),
    ).toBe(true);
  });

  it("leaves no folder or zip when the load fails", () => {
    const source = generated();
    const db = new Database(source);
    db.exec('ALTER TABLE "Hedgerows Baseline" DROP COLUMN "Comment"');
    db.close();
    const folder = path.join(dir, "Failed site");
    expect(() =>
      packageForQgis(source, { outDir: dir, name: "Failed site" }),
    ).toThrow();
    expect(existsSync(folder)).toBe(false);
    expect(existsSync(`${folder}.zip`)).toBe(false);
  });

  it("refuses to write over a folder already there", () => {
    const file = generated();
    packageForQgis(file, { outDir: dir, name: "Twice" });
    expect(() => packageForQgis(file, { outDir: dir, name: "Twice" })).toThrow(
      /already exists/,
    );
  });
});

describe("generate:gpkg --package-template", () => {
  const run = (out, extra = [], env = {}) =>
    spawnSync(
      process.execPath,
      [GEN_GPKG, "--outdir", out, "--size", "8", "--seed", "3", ...extra],
      { encoding: "utf8", env: { ...process.env, ...env } },
    );

  it("is refused without --format bng-service", () => {
    const result = run(path.join(dir, "legacy"), ["--package-template"]);
    expect(result.status).toBe(1);
    expect(result.stderr + result.stdout).toMatch(
      /--package-template needs --format bng-service/,
    );
  });

  it("says how to get the template when there is none, before writing anything", () => {
    const out = path.join(dir, "no-template");
    const result = run(out, ["--format", "bng-service", "--package-template"], {
      [TEMPLATE_DIR_ENV]: path.join(dir, "nowhere"),
    });
    expect(result.status).toBe(1);
    expect(result.stderr + result.stdout).toMatch(/npm run bootstrap/);
    expect(existsSync(out)).toBe(false);
  });

  (TEMPLATE ? it : it.skip)(
    "writes the file, its template folder and its zip, and checks the file",
    () => {
      const out = path.join(dir, "packaged");
      const result = run(out, [
        "--format",
        "bng-service",
        "--package-template",
      ]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout + result.stderr).toMatch(
        /lineage: every post-intervention feature names its parent/,
      );
      const names = readdirSync(out).sort();
      const gpkg = names.find((n) => n.endsWith(".gpkg"));
      const stem = path.basename(gpkg, ".gpkg");
      expect(names).toEqual([gpkg, `${stem}-qgis`, `${stem}-qgis.zip`].sort());
      expect(existsSync(path.join(out, `${stem}-qgis`, LAYERS_GPKG))).toBe(
        true,
      );
    },
  );

  it("warns, not fails, on a pinned habitat the template does not offer", () => {
    const out = path.join(dir, "pinned");
    const result = run(out, [
      "--format",
      "bng-service",
      "--habitat",
      "Individual trees - Urban tree",
    ]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout + result.stderr).toMatch(
      /template values: \d+ field\(s\) hold values the template does not offer/,
    );
  });

  it("checks a file without packaging it, and passes one named for its lineage flaw", () => {
    const out = path.join(dir, "lineage-flaw");
    const result = run(out, [
      "--format",
      "bng-service",
      "--flaw",
      "lineage-parent-unknown",
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout + result.stderr).toMatch(
      /reports lineage-parent-unknown, as its name says/,
    );
    expect(readdirSync(out)).toHaveLength(1);
  });
});
