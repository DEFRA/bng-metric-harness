import Database from "better-sqlite3";
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
    "CREATE TABLE gpkg_metadata (id INTEGER, md_scope TEXT, metadata TEXT)",
  );
  db.exec("INSERT INTO gpkg_metadata VALUES (1, 'dataset', '{}')");
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

  it("replace the version record's text", () => {
    setVersionRecord('{"format":"bng-service"}')(db);
    expect(db.prepare("SELECT metadata FROM gpkg_metadata").get()).toEqual({
      metadata: '{"format":"bng-service"}',
    });
  });
});
