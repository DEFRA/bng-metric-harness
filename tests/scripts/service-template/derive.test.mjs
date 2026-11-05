import Database from "better-sqlite3";
import { TEMPLATE_SOURCE } from "#bng-lib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deleteRows,
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
