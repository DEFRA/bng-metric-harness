import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openGeoPackageReadonly } from "#gpkg-io";
import { generateOne } from "../../../scripts/lib/synthetic/synthetic.mjs";

// Small but non-trivial: 5 parcels exercises partition + line + point pipelines
// without making the test slow.
const NUM_PARCELS = 5;
const CENTRE = [530000, 180000];

const EXPECTED_FEATURE_TABLES = ["Red Line Boundary", "Habitats", "Hedgerows", "Rivers", "Urban Trees"];

describe("synthetic generateOne", () => {
  let outDir;
  let outPath;

  beforeAll(() => {
    outDir = mkdtempSync(path.join(tmpdir(), "bng-synthetic-"));
    outPath = path.join(outDir, "synthetic.gpkg");
    generateOne(outPath, [], NUM_PARCELS, CENTRE);
  });

  afterAll(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  it("produces a single .gpkg file with no WAL / SHM sidecars", () => {
    expect(existsSync(outPath)).toBe(true);
    // The default DELETE journal mode means the .gpkg is always a single file
    // — consumers that copy only the .gpkg get the complete contents.
    expect(existsSync(`${outPath}-wal`)).toBe(false);
    expect(existsSync(`${outPath}-shm`)).toBe(false);
  });

  it("registers all five BNG feature tables in gpkg_contents", () => {
    const db = openGeoPackageReadonly(outPath);
    try {
      const rows = db
        .prepare("SELECT table_name FROM gpkg_contents WHERE data_type = 'features' ORDER BY table_name")
        .all()
        .map((r) => r.table_name);
      for (const table of EXPECTED_FEATURE_TABLES) {
        expect(rows).toContain(table);
      }
    } finally {
      db.close();
    }
  });

  it("writes one Red Line Boundary row and one Habitats row per requested parcel", () => {
    const db = openGeoPackageReadonly(outPath);
    try {
      const rlb = db.prepare(`SELECT COUNT(*) AS n FROM "Red Line Boundary"`).get();
      const habitats = db.prepare(`SELECT COUNT(*) AS n FROM "Habitats"`).get();
      expect(rlb.n).toBe(1);
      expect(habitats.n).toBe(NUM_PARCELS);
    } finally {
      db.close();
    }
  });

  it("writes at least one feature into each line / point layer", () => {
    // Hedgerows / Rivers use rejection sampling, so the exact count is not
    // pinned — we only guarantee the layer isn't empty for a non-degenerate
    // boundary.
    const db = openGeoPackageReadonly(outPath);
    try {
      for (const table of ["Hedgerows", "Rivers", "Urban Trees"]) {
        const { n } = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get();
        expect(n, `${table} should have at least one feature`).toBeGreaterThan(0);
      }
    } finally {
      db.close();
    }
  });
});
