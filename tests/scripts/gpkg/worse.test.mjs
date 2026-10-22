import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FlawSelectionError, MAX_WORSE_COUNT, WORSE_KINDS } from "#bng-lib";
import { parseWorseCounts } from "../../../scripts/gen-gpkg-worse.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const GEN_GPKG = path.join(ROOT, "scripts/gen-gpkg.mjs");
const DEGRADED_ADVANCE = "30+";

let dir;
// Inside the harness, as --outdir must be; test-data/ is gitignored.
beforeAll(() => {
  const testData = path.join(ROOT, "test-data");
  mkdirSync(testData, { recursive: true });
  dir = mkdtempSync(path.join(testData, "worse-"));
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

/** The hedgerows recorded as getting worse: whole, and the worse part b. */
function worseHedges(file) {
  const db = new Database(file, { readonly: true });
  try {
    const rows = db
      .prepare(
        `SELECT "Habitat Ref" ref, "Parent Ref" parent FROM "Hedgerows Post-Intervention"
          WHERE "Retention Category" = 'Created' AND "Habitat created in advance/years" = ?`,
      )
      .all(DEGRADED_ADVANCE);
    return {
      whole: rows.filter((r) => r.ref === r.parent).length,
      partly: rows.filter((r) => r.ref !== r.parent).length,
    };
  } finally {
    db.close();
  }
}

describe("parseWorseCounts", () => {
  it("gives undefined when --worse is not given, so the library draws one of each", () => {
    expect(parseWorseCounts([])).toBeUndefined();
  });

  it("reads KIND=N for every kind the library names", () => {
    expect(
      parseWorseCounts(WORSE_KINDS.map((kind, i) => `${kind}=${i}`)),
    ).toEqual(Object.fromEntries(WORSE_KINDS.map((kind, i) => [kind, i])));
  });

  it.each([
    ["hedge", /takes KIND=N/],
    ["hedge=", /takes KIND=N/],
    ["hedge=two", /takes KIND=N/],
    ["hedge=1=2", /takes KIND=N/],
    ["hedge=-1", /takes KIND=N/],
    ["hedgerow=2", /unknown kind of habitat that gets worse: hedgerow/],
    ["constructor=2", /unknown kind of habitat that gets worse: constructor/],
    ["toString=1", /unknown kind of habitat that gets worse: toString/],
    [`hedge=${MAX_WORSE_COUNT + 1}`, /whole number from 0/],
  ])("refuses %s", (value, message) => {
    expect(() => parseWorseCounts([value])).toThrow(FlawSelectionError);
    expect(() => parseWorseCounts([value])).toThrow(message);
  });

  it("refuses a zero count for the kind a degrade flaw breaks, and takes it otherwise", () => {
    expect(() => parseWorseCounts(["hedge=0"], ["degrade-not-worse"])).toThrow(
      /degrade-not-worse breaks .* cannot set hedge to 0/,
    );
    expect(parseWorseCounts(["hedge=0"])).toEqual({ hedge: 0 });
    expect(
      parseWorseCounts(["worse-watercourse=0"], ["degrade-not-worse"]),
    ).toEqual({ "worse-watercourse": 0 });
  });

  it("refuses a kind given twice", () => {
    expect(() => parseWorseCounts(["hedge=1", "hedge=2"])).toThrow(
      /names hedge twice/,
    );
  });
});

describe("generate:gpkg --worse", () => {
  it("draws the hedgerows that get worse it asks for, and checks the file", () => {
    const result = generate(
      "--format",
      "bng-service",
      "--worse",
      "hedge=4",
      "--worse",
      "partly-worse-hedge=3",
    );
    expect(result.status, result.output).toBe(0);
    expect(result.output).toMatch(
      /lineage: every post-intervention feature names its parent/,
    );
    const [file] = readdirSync(result.out);
    expect(worseHedges(path.join(result.out, file))).toEqual({
      whole: 4,
      partly: 3,
    });
  });

  it("draws them on a geometric flaw's minimal site when a degrade flaw adds them", () => {
    const result = generate(
      "--format",
      "bng-service",
      "--flaw",
      "bowtie-parcel",
      "--flaw",
      "degrade-not-worse",
      "--worse",
      "hedge=3",
    );
    expect(result.status, result.output).toBe(0);
    const [file] = readdirSync(result.out);
    expect(worseHedges(path.join(result.out, file)).whole).toBe(3);
  });

  it("draws one of each without --worse", () => {
    const result = generate("--format", "bng-service");
    expect(result.status, result.output).toBe(0);
    const [file] = readdirSync(result.out);
    expect(worseHedges(path.join(result.out, file))).toEqual({
      whole: 1,
      partly: 1,
    });
  });

  it.each([
    [["--worse", "hedge=2"], /--worse needs --format bng-service/],
    [
      [
        "--format",
        "bng-service",
        "--flaw",
        "bowtie-parcel",
        "--worse",
        "hedge=2",
      ],
      /with --bad or a geometric flaw needs a degrade flaw too/,
    ],
    [
      ["--format", "bng-service", "--stage", "baseline", "--worse", "hedge=2"],
      /baseline-stage file leaves empty; drop --stage baseline/,
    ],
    [
      ["--format", "bng-service", "--worse", "hedgerow=2"],
      /unknown kind of habitat that gets worse/,
    ],
    [
      [
        "--format",
        "bng-service",
        "--flaw",
        "degrade-not-worse",
        "--worse",
        "hedge=0",
      ],
      /--worse: degrade-not-worse breaks .* cannot set hedge to 0/,
    ],
  ])("refuses %j", (args, message) => {
    const result = generate(...args);
    expect(result.status).toBe(1);
    expect(result.output).toMatch(message);
  });

  it("is refused in workbook mode", () => {
    const result = spawnSync(
      process.execPath,
      [
        GEN_GPKG,
        "--format",
        "bng-service",
        "--from",
        "missing.xlsx",
        "--worse",
        "hedge=2",
      ],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toMatch(
      /--pair, --habitat and --worse are synthetic-mode only/,
    );
  });
});
