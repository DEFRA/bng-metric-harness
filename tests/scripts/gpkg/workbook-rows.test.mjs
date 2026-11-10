import { describe, expect, it } from "vitest";
import { buildBaselineRows, buildPostInterventionRows } from "#bng-lib";

// In-memory workbook shape that mirrors what readMetricWorkbook() returns.
// Tests fill in only the layers they care about; the rest stay empty so the
// row builder never trips over an undefined `.baseline` / `.created` array.
function wb(parts = {}) {
  return {
    habitats: { baseline: [], created: [], enhancements: [], ...parts.habitats },
    hedgerows: { baseline: [], created: [], enhancements: [], ...parts.hedgerows },
    watercourses: { baseline: [], created: [], enhancements: [], ...parts.watercourses },
    trees: { baseline: [], created: [], ...parts.trees },
  };
}

// Minimal habitat baseline row. Defaults to fully-retained so callers only
// override the fate columns they're exercising.
function habBaseline(overrides = {}) {
  return {
    ref: 1,
    broad: "Grassland",
    type: "Modified grassland",
    distinctiveness: "Low",
    condition: "Moderate",
    strategicSignificance: "Low",
    area: 1,
    areaRetained: 1,
    areaEnhanced: 0,
    areaLost: 0,
    ...overrides,
  };
}

function habCreated(overrides = {}) {
  return {
    ref: 1,
    broad: "Woodland and forest",
    type: "Other woodland; broadleaved",
    distinctiveness: "Medium",
    condition: "Good",
    strategicSignificance: "Low",
    area: 0.5,
    advanceYears: 0,
    delayYears: 0,
    ...overrides,
  };
}

function hedgeBaseline(overrides = {}) {
  return {
    ref: 1,
    type: "Native species-rich hedgerow",
    distinctiveness: "High",
    condition: "Moderate",
    strategicSignificance: "Low",
    lengthM: 100,
    lengthRetainedM: 100,
    lengthEnhancedM: 0,
    lengthLostM: 0,
    ...overrides,
  };
}

describe("buildPostInterventionRows — habitats", () => {
  it("fully-retained baseline yields a single unsuffixed row", () => {
    const { habitats } = buildPostInterventionRows(
      wb({ habitats: { baseline: [habBaseline()] } }),
    );
    expect(habitats).toHaveLength(1);
    expect(habitats[0]).toMatchObject({
      ref: "H001",
      retention: "Retained",
      area: 1,
      baselineRef: "1",
    });
    expect(habitats[0].baseline).not.toBeNull();
    expect(habitats[0].proposed.broad).toBe("Grassland");
  });

  it("retained+enhanced split yields H001a (Retained) + H001b (Enhanced) pulling proposed from A-3", () => {
    const baseline = habBaseline({ area: 1, areaRetained: 0.4, areaEnhanced: 0.6, areaLost: 0 });
    const enhancement = {
      baselineRef: 1,
      proposedBroad: "Woodland and forest",
      proposedType: "Other woodland; broadleaved",
      proposedDistinctiveness: "Medium",
      proposedCondition: "Good",
      proposedStrategicSignificance: "High",
      advanceYears: 2,
      delayYears: 1,
    };
    const { habitats } = buildPostInterventionRows(
      wb({ habitats: { baseline: [baseline], enhancements: [enhancement] } }),
    );
    expect(habitats.map((h) => [h.ref, h.retention, h.area])).toEqual([
      ["H001a", "Retained", 0.4],
      ["H001b", "Enhanced", 0.6],
    ]);
    expect(habitats[1].proposed).toMatchObject({
      broad: "Woodland and forest",
      type: "Other woodland; broadleaved",
      condition: "Good",
      advanceYears: 2,
      delayYears: 1,
    });
  });

  it("fully-lost baseline with matching created yields one Created row that inlines the lost parcel's baseline shape", () => {
    const baseline = habBaseline({ area: 1, areaRetained: 0, areaEnhanced: 0, areaLost: 1 });
    const created = habCreated({ area: 0.9 });
    const { habitats } = buildPostInterventionRows(
      wb({ habitats: { baseline: [baseline], created: [created] } }),
    );
    expect(habitats).toHaveLength(1);
    expect(habitats[0]).toMatchObject({
      ref: "H001",
      retention: "Created",
      baselineRef: "1",
      area: 0.9,
    });
    // Baseline columns carry the lost parcel's attributes (Modified grassland)
    // — needed so the row is self-contained for downstream calculators that
    // don't join back to the baseline table.
    expect(habitats[0].baseline).toMatchObject({
      broad: "Grassland",
      type: "Modified grassland",
    });
    expect(habitats[0].proposed).toMatchObject({
      broad: "Woodland and forest",
      type: "Other woodland; broadleaved",
    });
  });

  it("unassigned created gets a fresh ref and a self-similar baseline shape", () => {
    // Three baselines, none with lost area, plus one created that has nowhere
    // to attach → fresh ref H004 (1-based, after the three baselines).
    const baselines = [1, 2, 3].map((ref) => habBaseline({ ref }));
    const created = habCreated({ ref: 99, area: 0.2 });
    const { habitats } = buildPostInterventionRows(
      wb({ habitats: { baseline: baselines, created: [created] } }),
    );
    const createdRow = habitats.find((h) => h.baselineRef === null);
    expect(createdRow).toMatchObject({
      ref: "H004",
      baselineRef: null,
      retention: "Created",
      area: 0.2,
    });
    // Self-similar baseline shape: copies the created's habitat data so the
    // row is self-contained for downstream calculators.
    expect(createdRow.baseline).toMatchObject({
      broad: "Woodland and forest",
      type: "Other woodland; broadleaved",
    });
  });

  it("emits no retained slice when areaRetained is 0 (suffix scheme only applies when >1 slice survives)", () => {
    const baseline = habBaseline({ area: 1, areaRetained: 0, areaEnhanced: 1, areaLost: 0 });
    const { habitats } = buildPostInterventionRows(
      wb({ habitats: { baseline: [baseline], enhancements: [{ baselineRef: 1, proposedCondition: "Good" }] } }),
    );
    expect(habitats).toHaveLength(1);
    expect(habitats[0]).toMatchObject({ ref: "H001", retention: "Enhanced" });
  });
});

describe("buildPostInterventionRows — hedgerows", () => {
  it("lengthRetained + lengthEnhanced split with B-3 enhancement yields HG001a/HG001b", () => {
    const baseline = hedgeBaseline({ lengthM: 100, lengthRetainedM: 30, lengthEnhancedM: 70 });
    const enhancement = {
      baselineRef: 1,
      proposedType: "Hedgerow with trees",
      proposedCondition: "Good",
    };
    const { hedgerows } = buildPostInterventionRows(
      wb({ hedgerows: { baseline: [baseline], enhancements: [enhancement] } }),
    );
    expect(hedgerows.map((r) => [r.ref, r.retention, r.lengthM])).toEqual([
      ["HG001a", "Retained", 30],
      ["HG001b", "Enhanced", 70],
    ]);
    expect(hedgerows[1].proposed).toMatchObject({
      type: "Hedgerow with trees",
      condition: "Good",
    });
  });

  it("no fate columns populated falls through to a single full-length Retained row", () => {
    const baseline = hedgeBaseline({
      lengthM: 50,
      lengthRetainedM: 0,
      lengthEnhancedM: 0,
      lengthLostM: 0,
    });
    const { hedgerows } = buildPostInterventionRows(
      wb({ hedgerows: { baseline: [baseline] } }),
    );
    expect(hedgerows).toHaveLength(1);
    expect(hedgerows[0]).toMatchObject({
      ref: "HG001",
      retention: "Retained",
      lengthM: 50,
    });
  });
});

describe("buildPostInterventionRows — trees", () => {
  it("a fully-lost tree is omitted post-intervention", () => {
    const lostTree = {
      ref: 1,
      type: "Mature tree",
      distinctiveness: "Medium",
      condition: "Good",
      strategicSignificance: "Low",
      areaRetained: 0,
      areaEnhanced: 0,
      areaLost: 1,
    };
    const { trees } = buildPostInterventionRows(wb({ trees: { baseline: [lostTree] } }));
    expect(trees).toEqual([]);
  });

  it("created trees get fresh sequential refs after baseline.length", () => {
    const baseline = { ref: 1, type: "Mature tree", distinctiveness: "Medium", condition: "Good", strategicSignificance: "Low", areaRetained: 1, areaEnhanced: 0, areaLost: 0 };
    const created = { ref: 99, type: "Young tree", distinctiveness: "Low", condition: "Good", strategicSignificance: "Low", advanceYears: 0, delayYears: 0 };
    const { trees } = buildPostInterventionRows(
      wb({ trees: { baseline: [baseline], created: [created] } }),
    );
    expect(trees.map((t) => [t.ref, t.retention, t.baselineRef])).toEqual([
      ["T001", "Retained", "1"],
      ["T002", "Created", null],
    ]);
  });
});

describe("buildBaselineRows", () => {
  it("formats numeric refs with zero-padded three-digit suffix per layer", () => {
    const { habitats, hedgerows, rivers, trees } = buildBaselineRows(
      wb({
        habitats: { baseline: [habBaseline({ ref: 12 })] },
        hedgerows: { baseline: [hedgeBaseline({ ref: 3 })] },
        watercourses: { baseline: [hedgeBaseline({ ref: 4 })] },
        trees: { baseline: [{ ref: 7, type: "Mature tree", distinctiveness: "Medium", condition: "Good", strategicSignificance: "Low" }] },
      }),
    );
    expect(habitats[0]).toMatchObject({ ref: "H012", baselineRef: "12" });
    expect(hedgerows[0]).toMatchObject({ ref: "HG003", baselineRef: "3" });
    expect(rivers[0]).toMatchObject({ ref: "R004", baselineRef: "4" });
    expect(trees[0]).toMatchObject({ ref: "T007", baselineRef: "7" });
  });

  it("emits no retention or proposed columns — baseline rows must be free of post-intervention data", () => {
    const { habitats, hedgerows } = buildBaselineRows(
      wb({
        habitats: { baseline: [habBaseline()] },
        hedgerows: { baseline: [hedgeBaseline()] },
      }),
    );
    expect(habitats[0]).not.toHaveProperty("retention");
    expect(habitats[0]).not.toHaveProperty("proposed");
    expect(hedgerows[0]).not.toHaveProperty("retention");
    expect(hedgerows[0]).not.toHaveProperty("proposed");
  });

  it("under --strict-habitats drops habitats with invalid (broad, type, condition) and records a skip reason", () => {
    const valid = habBaseline({ ref: 1, broad: "Grassland", type: "Modified grassland", condition: "Moderate" });
    const invalid = habBaseline({ ref: 2, broad: "Bogus broad", type: "Nonexistent type", condition: "Moderate" });
    const { habitats, skipReasons } = buildBaselineRows(
      wb({ habitats: { baseline: [valid, invalid] } }),
      { strict: true },
    );
    expect(habitats).toHaveLength(1);
    expect(habitats[0].ref).toBe("H001");
    expect(skipReasons).toHaveLength(1);
    expect(skipReasons[0]).toContain("ref 2");
  });

  it("non-strict keeps invalid habitats and records no skip reasons", () => {
    const invalid = habBaseline({ ref: 1, broad: "Bogus broad", type: "Nonexistent type" });
    const { habitats, skipReasons } = buildBaselineRows(
      wb({ habitats: { baseline: [invalid] } }),
    );
    expect(habitats).toHaveLength(1);
    expect(skipReasons).toEqual([]);
  });

  it("strict mode does not filter linear or tree layers — only habitats", () => {
    // Hedgerows, rivers, and trees have no metric-table validator, so they
    // pass through regardless of --strict-habitats.
    const hedge = hedgeBaseline({ ref: 1, type: "Anything goes" });
    const { hedgerows, rivers, trees } = buildBaselineRows(
      wb({
        hedgerows: { baseline: [hedge] },
        watercourses: { baseline: [hedge] },
        trees: { baseline: [{ ref: 1, type: "Anything", distinctiveness: "Low", condition: "Good", strategicSignificance: "Low" }] },
      }),
      { strict: true },
    );
    expect(hedgerows).toHaveLength(1);
    expect(rivers).toHaveLength(1);
    expect(trees).toHaveLength(1);
  });
});
