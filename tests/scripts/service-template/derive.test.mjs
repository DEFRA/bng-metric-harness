import Database from "better-sqlite3";
import { TEMPLATE_SOURCE } from "#bng-lib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gpkgPoint } from "#gpkg-io";
import {
  copyRow,
  deleteRows,
  linkToParent,
  setValues,
  setVersionRecord,
} from "../../../scripts/service-template/derive.mjs";

const TABLE = "Area Habitats Baseline";

let db;
beforeEach(() => {
  db = new Database(":memory:");
  db.exec(`CREATE TABLE "${TABLE}" ("Habitat Ref" TEXT, "Condition" TEXT)`);
  db.exec(`INSERT INTO "${TABLE}" VALUES ('H001', 'Good'), ('H002', 'Poor')`);
  db.exec(
    "CREATE TABLE gpkg_metadata (id INTEGER, md_scope TEXT, md_standard_uri TEXT, metadata TEXT)",
  );
  const insert = db.prepare(
    "INSERT INTO gpkg_metadata VALUES (?, 'dataset', ?, '{}')",
  );
  insert.run(1, TEMPLATE_SOURCE.metadataUri);
  insert.run(2, "tag:example.org,2026:provenance");
});
afterEach(() => db.close());

const rows = () =>
  db.prepare(`SELECT * FROM "${TABLE}" ORDER BY "Habitat Ref"`).all();

describe("the row edits", () => {
  it("set and delete only the rows they name", () => {
    setValues(TABLE, { Condition: null }, { "Habitat Ref": "H002" })(db);
    expect(rows()).toEqual([
      { "Habitat Ref": "H001", Condition: "Good" },
      { "Habitat Ref": "H002", Condition: null },
    ]);
    deleteRows(TABLE, { "Habitat Ref": "H001" })(db);
    expect(rows()).toEqual([{ "Habitat Ref": "H002", Condition: null }]);
  });

  // A bng-library repin that renamed a habitat would otherwise leave the
  // fixture unchanged, and the corpus would rebuild to match it.
  it("fail where no row matches, so a stale recipe shows", () => {
    expect(() =>
      setValues(TABLE, { Condition: "Poor" }, { "Habitat Ref": "H999" })(db),
    ).toThrow(/no row of "Area Habitats Baseline"/);
    expect(() => deleteRows(TABLE, { "Habitat Ref": "H999" })(db)).toThrow(
      /no row/,
    );
  });

  it("refuse to edit every row", () => {
    expect(() => deleteRows(TABLE, {})(db)).toThrow(/which rows/);
  });

  it("replace the version record's text, and no other metadata row's", () => {
    setVersionRecord('{"format":"bng-service"}')(db);
    expect(
      db.prepare("SELECT id, metadata FROM gpkg_metadata ORDER BY id").all(),
    ).toEqual([
      { id: 1, metadata: '{"format":"bng-service"}' },
      { id: 2, metadata: "{}" },
    ]);
  });

  it("fail where the file has no version record to replace", () => {
    db.prepare("DELETE FROM gpkg_metadata WHERE id = 1").run();
    expect(() => setVersionRecord("{}")(db)).toThrow(
      /no row of "gpkg_metadata"/,
    );
  });
});

describe("the tree edits", () => {
  const BASELINE = "Trees Baseline";
  const POST = "Trees Post-Intervention";
  const SRS = 27700;

  beforeEach(() => {
    db.exec(
      `CREATE TABLE "${BASELINE}" (fid INTEGER PRIMARY KEY, geom BLOB, "Habitat Ref" TEXT, "Baseline Condition" TEXT, feature_uuid TEXT)`,
    );
    db.exec(
      `CREATE TABLE "${POST}" (fid INTEGER PRIMARY KEY, geom BLOB, "Habitat Ref" TEXT, "Parent Ref" TEXT, "Baseline Condition" TEXT, parent_uuid TEXT, parent_geom TEXT)`,
    );
    db.prepare(
      `INSERT INTO "${BASELINE}" VALUES (1, ?, 'T001', 'Poor', 'u1')`,
    ).run(gpkgPoint(SRS, 530000.12345, 180000.5));
    db.prepare(
      `INSERT INTO "${POST}" VALUES (1, ?, 'T009', NULL, 'N/A', NULL, NULL)`,
    ).run(gpkgPoint(SRS, 1, 2));
  });

  const post = () =>
    db
      .prepare(
        `SELECT fid, "Habitat Ref", "Parent Ref", "Baseline Condition", parent_uuid, parent_geom FROM "${POST}" ORDER BY fid`,
      )
      .all();

  it("copy a row under a new fid, with the columns named set", () => {
    copyRow(POST, { "Habitat Ref": "T009" }, { "Habitat Ref": "T010" })(db);
    expect(post().map((r) => [r.fid, r["Habitat Ref"]])).toEqual([
      [1, "T009"],
      [2, "T010"],
    ]);
  });

  it("copy only where one row matches", () => {
    expect(() => copyRow(POST, { "Habitat Ref": "T999" }, {})(db)).toThrow(
      /0 rows/,
    );
    copyRow(POST, { "Habitat Ref": "T009" }, {})(db);
    expect(() => copyRow(POST, { "Habitat Ref": "T009" }, {})(db)).toThrow(
      /2 rows/,
    );
  });

  it("link a row to its parent by Parent Ref, parent_uuid and parent_geom, copying the columns named", () => {
    linkToParent(
      POST,
      { "Habitat Ref": "T009" },
      BASELINE,
      { "Habitat Ref": "T001" },
      { geom: "geom" },
    )(db);
    expect(post()).toEqual([
      {
        fid: 1,
        "Habitat Ref": "T009",
        "Parent Ref": "T001",
        "Baseline Condition": "N/A",
        parent_uuid: "u1",
        parent_geom: "POINT (530000.123 180000.500)",
      },
    ]);
    const { geom } = db.prepare(`SELECT geom FROM "${POST}"`).get();
    const { geom: parentGeom } = db
      .prepare(`SELECT geom FROM "${BASELINE}"`)
      .get();
    expect(geom.equals(parentGeom)).toBe(true);
  });
});
