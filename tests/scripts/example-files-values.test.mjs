import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { disallowedValues } from "../../scripts/allowed-values.mjs";

// Every value in the legacy example files' drop-down and filled-in columns
// must be one the template's lists offer (BMD-1175): the service refuses any
// other with VALUE_NOT_ALLOWED before it checks anything else, so a fixture
// holding one would stop demonstrating what it was built for. The generated
// fixtures that cannot be rebuilt had their words rewritten in place (see
// "Template words (BMD-1175)" in example-files/README.md); this catches a
// rewrite that missed a value or wrote a word no list offers.
//
// The BNG Service template corpus (service-template/) is checked by
// tests/scripts/service-template/expected-codes.test.mjs.

// Reading every fixture takes a second or two; a slow runner may need more.
const SLOW_TEST_TIMEOUT = 30_000;
const EXAMPLE_FILES = path.resolve(import.meta.dirname, "../../example-files");
const SERVICE_TEMPLATE = "service-template";

// Fixtures that hold a value no list offers on purpose, each with why. Every
// one is described in example-files/README.md.
const DELIBERATELY_INVALID = new Map([
  [
    // Built for BASELINE_TYPE_MISSING: placeholders such as "N/A" and
    // "(no selection)", and hand-built tree words. The README says it is
    // refused first with VALUE_NOT_ALLOWED since BMD-1175.
    "attribute-problems/Post-intervention - blank and placeholder baseline types on every layer.gpkg",
    "refused with VALUE_NOT_ALLOWED",
  ],
  [
    // Habitats columns carry the wrong SQLite types: its conditions and
    // distinctiveness are numbers, refused by the schema check first.
    "invalid-schema/Baseline - wrong column data types in Habitats.gpkg",
    "refused by the schema check",
  ],
  [
    // Hand-built, so they keep the old generator tree words; the README says
    // they are refused with TEXT_TOO_LONG first, and would then be refused
    // with VALUE_NOT_ALLOWED.
    "attribute-problems/Baseline - habitat ref too long.gpkg",
    "refused with TEXT_TOO_LONG",
  ],
  [
    "attribute-problems/Post-intervention - habitat ref too long.gpkg",
    "refused with TEXT_TOO_LONG",
  ],
]);

// Not GeoPackages at all, so there is nothing to read.
const NOT_GEOPACKAGES = new Set(["malformed/Not a valid geopackage.gpkg"]);

const relativePath = (file) => file.split(path.sep).join("/");

const LEGACY_FIXTURES = readdirSync(EXAMPLE_FILES, { recursive: true })
  .map(relativePath)
  .filter(
    (file) =>
      file.endsWith(".gpkg") &&
      !file.startsWith(`${SERVICE_TEMPLATE}/`) &&
      !NOT_GEOPACKAGES.has(file),
  )
  .sort();

const checked = (file) => disallowedValues(path.join(EXAMPLE_FILES, file));

describe("the legacy example files' drop-down values", () => {
  it("finds the corpus", () => {
    expect(LEGACY_FIXTURES.length).toBeGreaterThan(100);
  });

  it("hold only values the template's lists offer, in every fixture not built to fail on one", () => {
    const refused = LEGACY_FIXTURES.filter(
      (file) => !DELIBERATELY_INVALID.has(file),
    ).flatMap((file) =>
      checked(file).map(
        ({ table, column, value }) =>
          `${file}: ${table}.${column} = ${JSON.stringify(value)}`,
      ),
    );
    expect(refused).toEqual([]);
  }, SLOW_TEST_TIMEOUT);

  // BASELINE_TYPE_MISSING's only fixture, which the backend refuses later,
  // past what this file can check: it holds every blank the rule treats as
  // blank, on every layer, as example-files/README.md describes it.
  it("keep the blank baseline types the BASELINE_TYPE_MISSING fixture is built on", () => {
    const db = new Database(
      path.join(
        EXAMPLE_FILES,
        "attribute-problems/Post-intervention - blank baseline types on every layer.gpkg",
      ),
      { readonly: true, fileMustExist: true },
    );
    const valueOf = (table, column, ref, refColumn = "Parcel Ref") =>
      db
        .prepare(
          `SELECT "${column}" AS value FROM "${table}" WHERE trim("${refColumn}") = ?`,
        )
        .get(ref)?.value;
    try {
      expect([
        valueOf("Habitats", "Baseline Habitat Type", "H002"),
        valueOf("Habitats", "Baseline Habitat Type", "H004"),
        valueOf("Hedgerows", "Baseline Hedge Type", "HG011"),
        valueOf("Rivers", "Baseline River Type", "R003"),
        valueOf("Urban Trees", "Baseline Tree Size", "T002", "Tree Ref"),
      ]).toEqual([null, null, "", "Null", ""]);
    } finally {
      db.close();
    }
  });

  it("still hold a refused value in each fixture listed as built to fail on one", () => {
    for (const [file, outcome] of DELIBERATELY_INVALID) {
      expect(LEGACY_FIXTURES, file).toContain(file);
      expect(checked(file).length, `${file} (${outcome})`).toBeGreaterThan(0);
    }
  });
});
