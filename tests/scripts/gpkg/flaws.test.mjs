import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CATEGORY_ATTRIBUTE,
  CATEGORY_GEOMETRIC,
  FLAWS,
  FlawSelectionError,
  resolveFlawSelection,
} from "#bng-lib";

describe("resolveFlawSelection — happy paths", () => {
  it("returns empty buckets when nothing is requested", () => {
    const sel = resolveFlawSelection({ bad: false, flaws: [] });
    expect(sel.geometricFlawNames).toEqual([]);
    expect(sel.emptyFlawNames).toEqual([]);
    expect(sel.attributeFlawNames).toEqual([]);
    expect(sel.emptyLayers.size).toBe(0);
    expect(sel.attributeOverrides).toEqual({});
  });

  it("routes a geometric flaw to the geometric bucket only", () => {
    const sel = resolveFlawSelection({ bad: false, flaws: ["bowtie-parcel"] });
    expect(sel.geometricFlawNames).toEqual(["bowtie-parcel"]);
    expect(sel.emptyFlawNames).toEqual([]);
    expect(sel.attributeFlawNames).toEqual([]);
  });

  it("routes an empty-layer flaw and resolves the target layer key", () => {
    const sel = resolveFlawSelection({ bad: false, flaws: ["no-habitats"] });
    expect(sel.emptyFlawNames).toEqual(["no-habitats"]);
    expect([...sel.emptyLayers]).toEqual(["habitats"]);
    expect(sel.geometricFlawNames).toEqual([]);
    expect(sel.attributeFlawNames).toEqual([]);
  });

  it("routes an attribute-override flaw and builds a per-layer override map", () => {
    const sel = resolveFlawSelection({
      bad: false,
      flaws: ["distinctiveness-out-of-scope"],
    });
    expect(sel.attributeFlawNames).toEqual(["distinctiveness-out-of-scope"]);
    expect(Object.keys(sel.attributeOverrides)).toEqual(["habitats"]);
    expect(sel.attributeOverrides.habitats).toHaveLength(2);
    // Override row data carries retention explicitly — generator just applies
    // fields, no hidden "force Retained" rule.
    expect(sel.attributeOverrides.habitats[0]).toMatchObject({
      habitatFullName: expect.any(String),
      retention: "Retained",
    });
  });

  it("routes the duplicate-habitat-ref flaw and pins the same ref on two rows", () => {
    const sel = resolveFlawSelection({
      bad: false,
      flaws: ["duplicate-habitat-ref"],
    });
    expect(sel.attributeFlawNames).toEqual(["duplicate-habitat-ref"]);
    expect(Object.keys(sel.attributeOverrides)).toEqual(["habitats"]);
    expect(sel.attributeOverrides.habitats).toHaveLength(2);
    const refs = sel.attributeOverrides.habitats.map((r) => r.parcelRef);
    expect(refs[0]).toBeTruthy();
    expect(refs[0]).toBe(refs[1]);
  });

  it("routes the advance-delay-both-set flaw and pins both years on a created row", () => {
    const sel = resolveFlawSelection({
      bad: false,
      flaws: ["advance-delay-both-set"],
    });
    expect(sel.attributeFlawNames).toEqual(["advance-delay-both-set"]);
    expect(Object.keys(sel.attributeOverrides)).toEqual(["habitats"]);
    expect(sel.attributeOverrides.habitats).toHaveLength(1);
    const row = sel.attributeOverrides.habitats[0];
    expect(row.retention).toBe("Created");
    expect(Number(row.advanceYears)).toBeGreaterThan(0);
    expect(Number(row.delayYears)).toBeGreaterThan(0);
  });

  it("allows attribute + empty flaws when they target different layers", () => {
    const sel = resolveFlawSelection({
      bad: false,
      flaws: ["distinctiveness-out-of-scope", "no-hedgerows"],
    });
    expect(sel.attributeFlawNames).toEqual(["distinctiveness-out-of-scope"]);
    expect(sel.emptyFlawNames).toEqual(["no-hedgerows"]);
    expect(Object.keys(sel.attributeOverrides)).toEqual(["habitats"]);
    expect([...sel.emptyLayers]).toEqual(["hedgerows"]);
  });

  it("expands --bad into the geometric default set", () => {
    const sel = resolveFlawSelection({ bad: true, flaws: [] });
    expect(sel.geometricFlawNames.length).toBeGreaterThan(0);
    expect(sel.emptyFlawNames).toEqual([]);
    expect(sel.attributeFlawNames).toEqual([]);
    // parcel-too-small is part of the default set: the too-small parcel it now
    // adds no longer conflicts with the other parcel-modifying flaws (BMD-882)
    expect(sel.geometricFlawNames).toContain("parcel-too-small");
    // Standalone flaws are excluded
    expect(sel.geometricFlawNames).not.toContain("redline-not-in-england");
    // Non-geometric flaws are excluded
    expect(sel.geometricFlawNames).not.toContain("no-habitats");
    expect(sel.geometricFlawNames).not.toContain("distinctiveness-out-of-scope");
  });
});

describe("resolveFlawSelection — conflicts", () => {
  function expectConflict(input, messageFragment) {
    expect(() => resolveFlawSelection(input)).toThrow(FlawSelectionError);
    try {
      resolveFlawSelection(input);
    } catch (err) {
      expect(err.message).toContain(messageFragment);
    }
  }

  it("rejects empty-layer + geometric flaws", () => {
    expectConflict(
      { bad: false, flaws: ["no-habitats", "bowtie-parcel"] },
      "empty-layer flaws",
    );
  });

  it("rejects attribute-override + geometric flaws", () => {
    expectConflict(
      { bad: false, flaws: ["distinctiveness-out-of-scope", "bowtie-parcel"] },
      "attribute-override flaws",
    );
  });

  it("rejects --bad combined with an empty-layer flaw", () => {
    expectConflict(
      { bad: true, flaws: ["no-habitats"] },
      "--bad cannot be combined with empty-layer",
    );
  });

  it("rejects --bad combined with an attribute-override flaw", () => {
    expectConflict(
      { bad: true, flaws: ["distinctiveness-out-of-scope"] },
      "--bad cannot be combined with attribute-override",
    );
  });

  it("rejects an attribute override on a layer that an empty-layer flaw clears", () => {
    expectConflict(
      { bad: false, flaws: ["distinctiveness-out-of-scope", "no-habitats"] },
      'overrides rows in the "habitats" layer',
    );
  });

  it("rejects a standalone flaw combined with others", () => {
    expectConflict(
      { bad: false, flaws: ["redline-not-in-england", "bowtie-parcel"] },
      "is standalone",
    );
  });

  it("rejects pairwise-conflicting geometric flaws", () => {
    // Since parcel-too-small became a standalone too-small parcel (BMD-882) no
    // shipped geometric flaws conflict, so inject a mutually-conflicting pair.
    const FLAW_A = "__test_conflict_a";
    const FLAW_B = "__test_conflict_b";
    FLAWS[FLAW_A] = {
      description: "test-only conflicting flaw A",
      errorCode: "TEST_A",
      category: CATEGORY_GEOMETRIC,
      conflictsWith: [FLAW_B],
    };
    FLAWS[FLAW_B] = {
      description: "test-only conflicting flaw B",
      errorCode: "TEST_B",
      category: CATEGORY_GEOMETRIC,
    };
    try {
      expectConflict(
        { bad: false, flaws: [FLAW_A, FLAW_B] },
        "conflict and cannot be combined",
      );
    } finally {
      delete FLAWS[FLAW_A];
      delete FLAWS[FLAW_B];
    }
  });

  it("rejects unknown flaw names", () => {
    expectConflict({ bad: false, flaws: ["nope"] }, "Unknown flaw: nope");
  });

  it("rejects an attribute-override flaw whose habitatFullName is not in HABITATS", () => {
    const TEST_FLAW = "__test_bad_full_name";
    FLAWS[TEST_FLAW] = {
      description: "test-only flaw with an unknown habitatFullName",
      errorCode: "TEST",
      category: CATEGORY_ATTRIBUTE,
      attributeOverride: {
        layer: "habitats",
        perRow: [{ habitatFullName: "Nonsense - Not real", retention: "Retained" }],
      },
    };
    try {
      expectConflict(
        { bad: false, flaws: [TEST_FLAW] },
        'unknown habitatFullName "Nonsense - Not real"',
      );
    } finally {
      delete FLAWS[TEST_FLAW];
    }
  });
});

describe("resolveFlawSelection — parcel sufficiency", () => {
  let logSpy;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  function loggedText() {
    return logSpy.mock.calls.flat().join(" ");
  }

  it("warns when numParcels is smaller than the override row count", () => {
    resolveFlawSelection({
      bad: false,
      flaws: ["distinctiveness-out-of-scope"],
      numParcels: 1,
    });
    const out = loggedText();
    expect(out).toContain('"distinctiveness-out-of-scope"');
    expect(out).toContain("pins 2 rows");
    expect(out).toContain("only 1 parcels requested");
  });

  it("does not warn when numParcels is at least the override row count", () => {
    resolveFlawSelection({
      bad: false,
      flaws: ["distinctiveness-out-of-scope"],
      numParcels: 5,
    });
    expect(loggedText()).not.toContain("silently skipped");
  });

  it("does not warn when numParcels is omitted (back-compat for tests/scripts)", () => {
    resolveFlawSelection({
      bad: false,
      flaws: ["distinctiveness-out-of-scope"],
    });
    expect(loggedText()).not.toContain("silently skipped");
  });
});
