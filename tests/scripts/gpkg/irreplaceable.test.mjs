import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FlawSelectionError } from "#bng-lib";
import { parseIrreplaceableLayers } from "../../../scripts/gen-gpkg-irreplaceable.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const GEN_GPKG = path.join(ROOT, "scripts/gen-gpkg.mjs");
const IRREPLACEABLE_TABLES = [
  "Area Habitats Baseline",
  "Area Habitats Post-Intervention",
  "Individual Trees Baseline",
  "Individual Trees Post-Intervention",
];

let dir;
// Inside the harness, as --outdir must be; test-data/ is gitignored.
beforeAll(() => {
  const testData = path.join(ROOT, "test-data");
  mkdirSync(testData, { recursive: true });
  dir = mkdtempSync(path.join(testData, "irreplaceable-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

let counter = 0;
const generate = (...args) => {
  counter += 1;
  const out = path.join(dir, `run-${counter}`);
  const result = spawnSync(
    process.execPath,
    [GEN_GPKG, "--outdir", out, "--size", "15", "--seed", "6", ...args],
    { encoding: "utf8" },
  );
  return { ...result, out, output: result.stdout + result.stderr };
};

/** How many rows of each table mark a habitat irreplaceable. */
function irreplaceableCounts(file) {
  const db = new Database(file, { readonly: true });
  try {
    return Object.fromEntries(
      IRREPLACEABLE_TABLES.map((table) => [
        table,
        db
          .prepare(
            `SELECT count(*) AS n FROM "${table}" WHERE "Irreplaceable Habitat" = 'Yes'`,
          )
          .get().n,
      ]),
    );
  } finally {
    db.close();
  }
}

const onlyFile = (out) => {
  const files = readdirSync(out).filter((f) => f.endsWith(".gpkg"));
  expect(files).toHaveLength(1);
  return path.join(out, files[0]);
};

describe("parseIrreplaceableLayers", () => {
  it("leaves the library's default when the flag is not given", () => {
    expect(parseIrreplaceableLayers(undefined)).toBeUndefined();
  });

  it("reads none as no layer, and a list as those layers", () => {
    expect(parseIrreplaceableLayers("none")).toEqual([]);
    expect(parseIrreplaceableLayers("trees")).toEqual(["trees"]);
    expect(parseIrreplaceableLayers("habitats, trees,trees")).toEqual([
      "habitats",
      "trees",
    ]);
  });

  it("refuses a layer it does not know, and an empty value", () => {
    for (const value of ["hedgerows", "", "none,trees"]) {
      expect(() => parseIrreplaceableLayers(value), value).toThrow(
        FlawSelectionError,
      );
    }
  });
});

describe("gen-gpkg --irreplaceable", () => {
  it("marks a habitat and a tree irreplaceable by default, and none with none", () => {
    const marked = generate("--format", "bng-service");
    expect(marked.status, marked.output).toBe(0);
    const counts = irreplaceableCounts(onlyFile(marked.out));
    expect(counts["Area Habitats Baseline"]).toBeGreaterThan(0);
    expect(counts["Individual Trees Baseline"]).toBeGreaterThan(0);

    const none = generate("--format", "bng-service", "--irreplaceable", "none");
    expect(none.status, none.output).toBe(0);
    expect(
      Object.values(irreplaceableCounts(onlyFile(none.out))).every(
        (n) => n === 0,
      ),
    ).toBe(true);
  });

  it("marks only the layers it names", () => {
    const trees = generate(
      "--format",
      "bng-service",
      "--irreplaceable",
      "trees",
    );
    expect(trees.status, trees.output).toBe(0);
    const counts = irreplaceableCounts(onlyFile(trees.out));
    expect(counts["Individual Trees Baseline"]).toBeGreaterThan(0);
    expect(counts["Area Habitats Baseline"]).toBe(0);
    expect(counts["Area Habitats Post-Intervention"]).toBe(0);
  });

  it("is refused in the legacy format", () => {
    const legacy = generate("--irreplaceable", "none");
    expect(legacy.status).not.toBe(0);
    expect(legacy.output).toMatch(/--irreplaceable needs --format bng-service/);
  });
});
