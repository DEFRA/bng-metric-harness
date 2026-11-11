import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildAllowedValues,
  columnKey,
  disallowedValues,
  isAllowedValue,
  isBlankValue,
  normaliseListValue,
} from "../../scripts/allowed-values.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");

describe("normaliseListValue", () => {
  it("trims and lower-cases", () => {
    expect(normaliseListValue("  Fairly Poor ")).toBe("fairly poor");
  });

  it("strips a leading list number", () => {
    expect(normaliseListValue("4. Fairly Poor")).toBe("fairly poor");
    expect(normaliseListValue("4.Fairly Poor")).toBe("fairly poor");
  });

  it("strips only a leading list number", () => {
    expect(normaliseListValue("Grade 4. Poor")).toBe("grade 4. poor");
  });

  it("makes each run of whitespace one space", () => {
    expect(normaliseListValue("Fairly \t\n  Poor")).toBe("fairly poor");
  });

  it("removes spaces around a slash", () => {
    expect(normaliseListValue("Minor/ Minor")).toBe("minor/minor");
    expect(normaliseListValue("Minor  /  Minor")).toBe("minor/minor");
  });

  it("writes a whole number given as a decimal without its decimal places", () => {
    expect(normaliseListValue("5.0")).toBe("5");
    expect(normaliseListValue("5.00")).toBe("5");
    expect(normaliseListValue(5)).toBe("5");
  });

  it("keeps a decimal that is not whole, rather than read it as a list number", () => {
    expect(normaliseListValue("5.5")).toBe("5.5");
    expect(normaliseListValue("1.5")).toBe("1.5");
    expect(normaliseListValue("30.0")).toBe("30");
  });

  it("strips a list number of more than one digit", () => {
    expect(normaliseListValue("10. Good")).toBe("good");
  });
});

describe("isBlankValue", () => {
  it("counts null, whitespace and the word Null as blank", () => {
    for (const value of [null, undefined, "", "   ", "\t\n", "Null", " NULL "]) {
      expect(isBlankValue(value), JSON.stringify(value)).toBe(true);
    }
  });

  it("counts anything else as a value", () => {
    for (const value of ["N/A", "0", 0, "Nullish"]) {
      expect(isBlankValue(value), JSON.stringify(value)).toBe(false);
    }
  });
});

describe("columnKey", () => {
  it("compares column names trimmed and case-insensitive", () => {
    expect(columnKey(" Habitat created in advance/years ")).toBe(
      "habitat created in advance/years",
    );
  });
});

describe("buildAllowedValues", () => {
  it("joins the lists of two names that are one column once compared", () => {
    const allowed = buildAllowedValues({
      "Years ": ["1. One"],
      years: ["Two"],
    });
    expect([...allowed.keys()]).toEqual(["years"]);
    expect([...allowed.get("years")].sort()).toEqual(["one", "two"]);
  });
});

describe("isAllowedValue", () => {
  const allowed = buildAllowedValues({
    "Baseline Condition": ["4. Fairly Poor", "Good"],
    "Encroachment": ["Minor/ Minor"],
    "Advance": ["5"],
  });

  it("allows a value its lists offer, spelt any way the check compares the same", () => {
    expect(isAllowedValue("baseline condition ", "fairly  poor", allowed)).toBe(
      true,
    );
    expect(isAllowedValue("Baseline Condition", "4. Fairly Poor", allowed)).toBe(
      true,
    );
    expect(isAllowedValue("Encroachment", "minor /minor", allowed)).toBe(true);
    expect(isAllowedValue("Advance", 5, allowed)).toBe(true);
    expect(isAllowedValue("Advance", "5.0", allowed)).toBe(true);
  });

  it("refuses a value no list offers", () => {
    expect(isAllowedValue("Baseline Condition", "Poor", allowed)).toBe(false);
    expect(isAllowedValue("Baseline Condition", "N/A", allowed)).toBe(false);
    expect(isAllowedValue("Advance", "1.5", allowed)).toBe(false);
  });

  it("refuses a value that is not text", () => {
    expect(
      isAllowedValue("Baseline Condition", Buffer.from("Good"), allowed),
    ).toBe(false);
  });

  // As the backend's gate: a BLOB is blank only when its bytes are only
  // whitespace. "Null" counts as blank only as text.
  it("refuses a BLOB whose bytes spell Null, and allows one that is only whitespace", () => {
    expect(
      isAllowedValue("Baseline Condition", Buffer.from("null"), allowed),
    ).toBe(false);
    expect(
      isAllowedValue("Baseline Condition", Buffer.from(" \t"), allowed),
    ).toBe(true);
    expect(isAllowedValue("Baseline Condition", Buffer.alloc(0), allowed)).toBe(
      true,
    );
  });

  // The backend trims what String.prototype.trim() trims (BMD-1175), so a
  // value of only Unicode spaces is blank on both sides.
  it("allows a value that is only a no-break or other Unicode space", () => {
    expect(isAllowedValue("Baseline Condition", "\u00a0", allowed)).toBe(true);
    expect(isAllowedValue("Baseline Condition", "\u2003 ", allowed)).toBe(
      true,
    );
  });

  it("allows a blank, and anything in a column with no list", () => {
    expect(isAllowedValue("Baseline Condition", "Null", allowed)).toBe(true);
    expect(isAllowedValue("Baseline Condition", "  ", allowed)).toBe(true);
    expect(isAllowedValue("Comment", "anything at all", allowed)).toBe(true);
  });

  it("reads the library's lists by default", () => {
    expect(isAllowedValue("Baseline Condition", "4. Fairly Poor")).toBe(true);
    expect(isAllowedValue("Baseline Condition", "Not a condition")).toBe(false);
  });
});

describe("disallowedValues", () => {
  let dir;
  let file;

  beforeAll(() => {
    const testData = path.join(ROOT, "test-data");
    mkdirSync(testData, { recursive: true });
    dir = mkdtempSync(path.join(testData, "allowed-values-"));
    file = path.join(dir, "values.gpkg");
    const db = new Database(file);
    db.exec(`
      CREATE TABLE gpkg_contents (table_name TEXT, data_type TEXT);
      INSERT INTO gpkg_contents VALUES
        ('Habitats', 'features'), ('Red Line Boundary', 'features'), ('notes', 'attributes');
      CREATE TABLE "Habitats" ("Baseline Condition" TEXT, "Comment" TEXT);
      INSERT INTO "Habitats" VALUES
        ('4. Fairly Poor', 'x'), ('Not a condition', 'y'), (NULL, 'z'), ('Null', 'w'),
        ('Not a condition', 'v');
      CREATE TABLE "Red Line Boundary" ("Baseline Condition" TEXT);
      INSERT INTO "Red Line Boundary" VALUES ('Not a condition');
      CREATE TABLE notes ("Baseline Condition" TEXT);
      INSERT INTO notes VALUES ('Not a condition');
    `);
    db.close();
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("names each refused value of a habitat table once, and skips Red Line Boundary and tables that are not features", () => {
    expect(disallowedValues(file)).toEqual([
      {
        table: "Habitats",
        column: "Baseline Condition",
        value: "Not a condition",
      },
    ]);
  });
});
