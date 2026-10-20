import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openGeoPackageReadonly } from "#gpkg-io";
import { checkTemplateValues, readVersionRecords } from "#bng-lib";

const GEN_GPKG = path.resolve(
  import.meta.dirname,
  "../../../scripts/gen-gpkg.mjs",
);
// A small metric workbook from the scenario catalogue.
const WORKBOOK = path.resolve(
  import.meta.dirname,
  "../../../example-files/permutations/intervention/hedgerow-created.xlsx",
);

function run(outDir, ...args) {
  return spawnSync(process.execPath, [GEN_GPKG, "--outdir", outDir, ...args], {
    encoding: "utf8",
  });
}

function onlyFile(outDir) {
  const files = readdirSync(outDir);
  expect(files).toHaveLength(1);
  return path.join(outDir, files[0]);
}

function count(file, table) {
  const db = openGeoPackageReadonly(file);
  try {
    return db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n;
  } finally {
    db.close();
  }
}

describe("gen-gpkg --format bng-service", () => {
  let root;
  let n = 0;
  const outDir = () => mkdtempSync(path.join(root, `run-${(n += 1)}-`));

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), "bng-gen-gpkg-"));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("writes one file holding both stages, every value one the template offers", () => {
    const dir = outDir();
    execFileSync(process.execPath, [
      GEN_GPKG,
      "--outdir",
      dir,
      "--format",
      "bng-service",
      "--size",
      "6",
      "--seed",
      "7",
    ]);
    const file = onlyFile(dir);
    expect(path.basename(file)).toMatch(
      /^bng-service-test-data-\d{8}-\d{4}-\d{2}\.gpkg$/,
    );
    expect(count(file, "Area Habitats Baseline")).toBe(6);
    expect(count(file, "Area Habitats Post-Intervention")).toBeGreaterThan(0);
    expect(checkTemplateValues(file)).toEqual([]);
    const db = openGeoPackageReadonly(file);
    expect(readVersionRecords(db)).toEqual([
      { format: "bng-service", version: "1.0" },
    ]);
    db.close();
  });

  it("writes the baseline-stage file, at the version asked for", () => {
    const dir = outDir();
    const result = run(
      dir,
      "--format",
      "bng-service",
      "--stage",
      "baseline",
      "--template-version",
      "1.1",
      "--size",
      "4",
    );
    expect(result.status).toBe(0);
    const file = onlyFile(dir);
    expect(path.basename(file)).toMatch(/-baseline-/);
    expect(count(file, "Area Habitats Post-Intervention")).toBe(0);
    const db = openGeoPackageReadonly(file);
    expect(readVersionRecords(db)).toEqual([
      { format: "bng-service", version: "1.1" },
    ]);
    db.close();
  });

  it("names a BNG Service flaw in the file name", () => {
    const dir = outDir();
    const result = run(
      dir,
      "--format",
      "bng-service",
      "--flaw",
      "version-record-missing",
      "--size",
      "4",
    );
    expect(result.status).toBe(0);
    const file = onlyFile(dir);
    expect(path.basename(file)).toMatch(/version-record-missing/);
    const db = openGeoPackageReadonly(file);
    expect(readVersionRecords(db)).toEqual([]);
    db.close();
  });

  it("writes a degraded-habitat flaw, and names it in the file name", () => {
    // The hedges that get worse, by their years in advance: the same seed
    // with and without the flaw, so the flaw is what clears them.
    const worseAdvance = (...flaw) => {
      const dir = outDir();
      const result = run(
        dir,
        "--format",
        "bng-service",
        ...flaw,
        "--size",
        "6",
        "--seed",
        "3",
      );
      expect(result.status, result.stderr).toBe(0);
      const file = onlyFile(dir);
      const db = openGeoPackageReadonly(file);
      try {
        const advance = db
          .prepare(
            `SELECT "Habitat created in advance/years" AS advance
               FROM "Hedgerows Post-Intervention"
              WHERE "Retention Category" = 'Created' AND parent_uuid IS NOT NULL`,
          )
          .all()
          .map((r) => r.advance);
        return { file, advance };
      } finally {
        db.close();
      }
    };
    const plain = worseAdvance();
    expect(plain.advance.length).toBeGreaterThan(0);
    expect(new Set(plain.advance)).toEqual(new Set(["30+"]));
    const flawed = worseAdvance("--flaw", "degrade-advance-missing");
    expect(path.basename(flawed.file)).toMatch(/degrade-advance-missing/);
    expect(flawed.advance).toHaveLength(plain.advance.length);
    expect(flawed.advance).toContain(null);
  });

  it("writes one file holding both stages from a workbook", () => {
    const dir = outDir();
    const result = run(dir, "--from", WORKBOOK, "--format", "bng-service");
    expect(result.status).toBe(0);
    const file = onlyFile(dir);
    expect(path.basename(file)).toMatch(
      /^hedgerow-created-bng-service-\d{8}-\d{4}-\d{2}\.gpkg$/,
    );
    expect(checkTemplateValues(file)).toEqual([]);
    expect(count(file, "Area Habitats Baseline")).toBeGreaterThan(0);
    expect(count(file, "Hedgerows Post-Intervention")).toBeGreaterThan(0);
    const db = openGeoPackageReadonly(file);
    expect(readVersionRecords(db)).toEqual([
      { format: "bng-service", version: "1.0" },
    ]);
    db.close();
  });

  it("writes the baseline-stage file from a workbook", () => {
    const dir = outDir();
    const result = run(
      dir,
      "--from",
      WORKBOOK,
      "--format",
      "bng-service",
      "--stage",
      "baseline",
    );
    expect(result.status).toBe(0);
    const file = onlyFile(dir);
    expect(path.basename(file)).toMatch(
      /^hedgerow-created-bng-service-baseline-\d{8}-\d{4}-\d{2}\.gpkg$/,
    );
    expect(count(file, "Area Habitats Baseline")).toBeGreaterThan(0);
    expect(count(file, "Hedgerows Post-Intervention")).toBe(0);
  });

  it("writes one numbered file per run in a --count batch", () => {
    const dir = outDir();
    const result = run(
      dir,
      "--format",
      "bng-service",
      "--size",
      "4",
      "--count",
      "2",
    );
    expect(result.status).toBe(0);
    const files = readdirSync(dir).sort((a, b) => a.localeCompare(b));
    expect(files).toHaveLength(2);
    expect(files[0]).toMatch(/^bng-service-test-data-001-/);
    expect(files[1]).toMatch(/^bng-service-test-data-002-/);
  });

  it("lists the BNG Service flaws in --help", () => {
    const result = spawnSync(process.execPath, [GEN_GPKG, "--help"], {
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/lineage-parent-unknown/);
    expect(result.stdout).toMatch(/version-record-missing/);
    expect(result.stdout).toMatch(/Degraded-habitat flaws/);
    expect(result.stdout).toMatch(/degrade-not-worse/);
    expect(result.stdout).toMatch(/tree-count-not-whole.*legacy only/);
  });

  it.each([
    [
      ["--format", "bng-service", "--pair"],
      /writes one file holding both stages/,
    ],
    [["--flaw", "lineage-parent-unknown"], /add --format bng-service/],
    [
      ["--format", "bng-service", "--flaw", "tree-count-not-whole"],
      /no Count column/,
    ],
    [
      [
        "--format",
        "bng-service",
        "--flaw",
        "version-record-missing",
        "--flaw",
        "version-unsupported",
      ],
      /Only one template-version flaw at a time/,
    ],
    [
      [
        "--format",
        "bng-service",
        "--flaw",
        "lineage-parent-missing",
        "--flaw",
        "lineage-parent-wrong",
      ],
      /Only one lineage flaw at a time/,
    ],
    [
      [
        "--format",
        "bng-service",
        "--stage",
        "baseline",
        "--flaw",
        "lineage-parent-unknown",
      ],
      /baseline-stage file leaves empty/,
    ],
    [
      [
        "--format",
        "bng-service",
        "--flaw",
        "degrade-advance-missing",
        "--flaw",
        "degrade-not-worse",
      ],
      /Only one degraded-habitat flaw at a time/,
    ],
    [
      [
        "--format",
        "bng-service",
        "--stage",
        "baseline",
        "--flaw",
        "degrade-not-worse",
      ],
      /Degraded-habitat flaws change post-intervention features/,
    ],
    [["--flaw", "degrade-not-worse"], /add --format bng-service/],
    [
      [
        "--from",
        WORKBOOK,
        "--format",
        "bng-service",
        "--flaw",
        "version-record-missing",
      ],
      /--bad and --flaw are synthetic-mode only/,
    ],
    [["--from", WORKBOOK, "--bad"], /--bad and --flaw are synthetic-mode only/],
    [["--stage", "baseline"], /need --format bng-service/],
    // Refused even when the value is the default: passing the flag at all
    // without --format bng-service is the mistake.
    [["--stage", "post-intervention"], /need --format bng-service/],
    [["--template-version", "1.0"], /need --format bng-service/],
    [["--format", "qgis"], /--format must be one of/],
    [
      ["--format", "bng-service", "--template-version", "2"],
      /--template-version must be "<major>.<minor>"/,
    ],
    [
      ["--format", "bng-service", "--template-version", "abc"],
      /--template-version must be "<major>.<minor>"/,
    ],
  ])("refuses %j", (args, message) => {
    const dir = outDir();
    const result = run(dir, ...args);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toMatch(message);
    expect(readdirSync(dir)).toEqual([]);
  });
});
