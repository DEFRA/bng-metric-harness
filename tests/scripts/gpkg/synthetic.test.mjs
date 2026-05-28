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
    generateOne(outPath, CENTRE, { numParcels: NUM_PARCELS });
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

describe("synthetic generateOne — geometric flaws", () => {
  let outDir;
  let outPath;

  beforeAll(() => {
    outDir = mkdtempSync(path.join(tmpdir(), "bng-synthetic-bad-"));
    outPath = path.join(outDir, "bad.gpkg");
    generateOne(outPath, CENTRE, {
      numParcels: NUM_PARCELS,
      geometricFlawNames: ["bowtie-parcel"],
    });
  });

  afterAll(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  it("routes through the bad-fixture builder and emits a file", () => {
    expect(existsSync(outPath)).toBe(true);
    const db = openGeoPackageReadonly(outPath);
    try {
      const tables = db
        .prepare("SELECT table_name FROM gpkg_contents WHERE data_type = 'features'")
        .all()
        .map((r) => r.table_name);
      expect(tables).toContain("Red Line Boundary");
      expect(tables).toContain("Habitats");
    } finally {
      db.close();
    }
  });
});

describe("synthetic generateOne — empty-layer flaw", () => {
  let outDir;
  let outPath;

  beforeAll(() => {
    outDir = mkdtempSync(path.join(tmpdir(), "bng-synthetic-empty-"));
    outPath = path.join(outDir, "empty.gpkg");
    generateOne(outPath, CENTRE, {
      numParcels: NUM_PARCELS,
      emptyLayers: new Set(["habitats"]),
    });
  });

  afterAll(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  it("registers the Habitats layer with zero rows", () => {
    const db = openGeoPackageReadonly(outPath);
    try {
      const tables = db
        .prepare("SELECT table_name FROM gpkg_contents WHERE data_type = 'features'")
        .all()
        .map((r) => r.table_name);
      expect(tables).toContain("Habitats");
      const { n } = db.prepare(`SELECT COUNT(*) AS n FROM "Habitats"`).get();
      expect(n).toBe(0);
    } finally {
      db.close();
    }
  });

  it("still populates the other feature layers", () => {
    const db = openGeoPackageReadonly(outPath);
    try {
      const { n } = db.prepare(`SELECT COUNT(*) AS n FROM "Red Line Boundary"`).get();
      expect(n).toBe(1);
    } finally {
      db.close();
    }
  });
});

describe("synthetic generateOne — attribute overrides", () => {
  let outDir;
  let outPath;

  beforeAll(() => {
    outDir = mkdtempSync(path.join(tmpdir(), "bng-synthetic-attr-"));
    outPath = path.join(outDir, "attr.gpkg");
    generateOne(outPath, CENTRE, {
      numParcels: NUM_PARCELS,
      attributeOverrides: {
        habitats: [
          { habitatFullName: "Grassland - Lowland meadows", retention: "Retained" },
        ],
      },
    });
  });

  afterAll(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  it("pins the overridden row's baseline habitat and retention", () => {
    const db = openGeoPackageReadonly(outPath);
    try {
      const row = db
        .prepare(
          `SELECT "Baseline Habitat Type", "Retention Category", "Proposed Habitat Type"
           FROM "Habitats" ORDER BY "Parcel Ref" LIMIT 1`,
        )
        .get();
      expect(row["Baseline Habitat Type"]).toBe("Lowland meadows");
      expect(row["Retention Category"]).toBe("Retained");
      // Retained → proposed mirrors baseline, so the row stays coherent
      expect(row["Proposed Habitat Type"]).toBe("Lowland meadows");
    } finally {
      db.close();
    }
  });

  it("leaves un-overridden rows in place (count matches numParcels)", () => {
    const db = openGeoPackageReadonly(outPath);
    try {
      const { n } = db.prepare(`SELECT COUNT(*) AS n FROM "Habitats"`).get();
      expect(n).toBe(NUM_PARCELS);
    } finally {
      db.close();
    }
  });
});

describe("synthetic generateOne — duplicate Parcel Ref override", () => {
  let outDir;
  let outPath;

  beforeAll(() => {
    outDir = mkdtempSync(path.join(tmpdir(), "bng-synthetic-dup-ref-"));
    outPath = path.join(outDir, "dup-ref.gpkg");
    generateOne(outPath, CENTRE, {
      numParcels: NUM_PARCELS,
      attributeOverrides: {
        habitats: [{ parcelRef: "DUP-1" }, { parcelRef: "DUP-1" }],
      },
    });
  });

  afterAll(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  it("emits two habitat rows sharing the same Parcel Ref", () => {
    const db = openGeoPackageReadonly(outPath);
    try {
      const rows = db
        .prepare(`SELECT "Parcel Ref" AS ref FROM "Habitats"`)
        .all();
      const duplicated = rows.filter((r) => r.ref === "DUP-1");
      expect(duplicated).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  it("leaves un-overridden rows with their generated H-prefixed refs", () => {
    const db = openGeoPackageReadonly(outPath);
    try {
      const rows = db
        .prepare(
          `SELECT "Parcel Ref" AS ref FROM "Habitats" WHERE "Parcel Ref" != 'DUP-1' ORDER BY "Parcel Ref"`,
        )
        .all();
      const REMAINING = NUM_PARCELS - 2;
      expect(rows).toHaveLength(REMAINING);
      for (const row of rows) {
        expect(row.ref).toMatch(/^H\d+$/);
      }
    } finally {
      db.close();
    }
  });
});
