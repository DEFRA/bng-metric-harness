// The metric comparison (BMD-1036): every committed scenario imported through
// the backend's upload pipeline and compared, figure by figure, with the
// Statutory Biodiversity Metric's own answers.
//
// Differences between the service and the metric do not fail these tests —
// `npm run compare:metric -- --fail-on-unexplained` fails on the unexplained
// ones (unexplained.mjs, tested in unexplained.test.mjs). These tests check the comparison itself
// runs. They need
// an installed backend beside the harness (or BNG_BACKEND_DIR), and skip
// without one.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { OUTCOME, findScenarios, readWorkbookAnswers } from "#metric-compare";
import { readImportExpectations } from "../../../scripts/metric-comparison/import-expectations.mjs";
import { findUnexplained } from "../../../scripts/metric-comparison/unexplained.mjs";
import { isBackendInstalled } from "../../../scripts/metric-comparison/backend.mjs";
import { importGeoPackagePair } from "../../../scripts/metric-comparison/import-geopackage-pair.mjs";
import {
  compareCorpusScenario,
  DEFAULT_CORPUS_DIR,
  runMetricComparison,
} from "../../../scripts/metric-comparison/run-metric-comparison.mjs";

// The whole corpus runs in a few seconds; the margin covers a slow runner.
const CORPUS_TIMEOUT_MS = 60_000;

const { scenarios } = findScenarios(DEFAULT_CORPUS_DIR);
const scenario = (id) => scenarios.find((s) => s.id === id);

describe.skipIf(!isBackendInstalled())("importGeoPackagePair", () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "import-pair-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  it("imports an accepted pair into the project response GET /projects/{id} returns", async () => {
    const result = await importGeoPackagePair(
      scenario("trading-rules/trading-surplus-in-another-broad-habitat").files,
    );

    expect(result.accepted).toBe(true);
    const { project, tradingRuleStatuses } = result.project;
    expect(project.baseline.habitats.length).toBeGreaterThan(0);
    expect(project.baseline.units.habitatsTotal).toBeGreaterThan(0);
    expect(project.postIntervention.units.habitatsNetUnitChange).toEqual(
      expect.any(Number),
    );
    expect(project.postIntervention.tradingRules.areaHabitats).toBeDefined();
    expect(tradingRuleStatuses.areaHabitats.overall).toMatch(/^(Met|Not met)$/);
  });

  it("carries the baseline into the post-intervention enrichment", async () => {
    const result = await importGeoPackagePair(
      scenario("intervention/area-retained").files,
    );

    const retained = result.project.project.postIntervention.habitats.filter(
      (h) => h.retentionCategory === "Retained",
    );
    expect(retained.length).toBeGreaterThan(0);
    for (const habitat of retained) {
      expect(habitat.units).toEqual(expect.any(Number));
    }
  });

  it("accepts conflicting timing and preserves saved nulls (AC3)", async () => {
    const result = await importGeoPackagePair(
      scenario("invalid-interventions/invalid-area-advance-and-delay").files,
    );

    expect(result.accepted).toBe(true);
    const habitat = result.project.project.postIntervention.habitats.find(
      (h) => h.ref === "H001",
    );
    expect(habitat.proposed).toMatchObject({
      advanceYears: null,
      delayYears: null,
    });
  });

  it("refuses a baseline that is not a GeoPackage at the format gate", async () => {
    const notAGeoPackage = path.join(scratch, "not-a.gpkg");
    writeFileSync(notAGeoPackage, "not a GeoPackage");

    const result = await importGeoPackagePair({
      baseline: notAGeoPackage,
      postIntervention: scenario("trading-rules/trading-all-met").files
        .postIntervention,
    });

    expect(result).toMatchObject({ accepted: false, rejectedFile: "baseline" });
    expect(result.errors[0].code).toEqual(expect.any(String));
  });

  // BMD-1182: each enhances a baseline the service cannot enhance at all, so
  // the post-intervention file is refused once its document is built, and
  // for that reason, not at an earlier gate.
  it.each([
    "invalid-area-medium-good-enhanced",
    "invalid-tree-good-enhanced",
    "invalid-hedgerow-medium-good-enhanced",
    "invalid-watercourse-medium-good-enhanced",
    "invalid-hedgerow-very-low-enhanced",
    "invalid-hedgerow-low-good-no-medium-target",
  ])("refuses %s as a baseline the service cannot enhance", async (id) => {
    const result = await importGeoPackagePair(
      scenario(`invalid-interventions/${id}`).files,
    );

    expect(result).toMatchObject({
      accepted: false,
      rejectedFile: "postIntervention",
    });
    expect(result.errors.map((e) => e.code)).toEqual([
      "BASELINE_NOT_ENHANCEABLE",
    ]);
  });

  // BMD-820: a hedgerow move the metric's G-6 allowed-moves table does not
  // allow, from a baseline that can still be enhanced, is nulled, not refused.
  it.each([
    "invalid-hedgerow-bank-or-ditch-dropped",
    "invalid-hedgerow-medium-type-change",
  ])(
    "accepts %s and saves HG001 Incomplete, its proposed side cleared",
    async (id) => {
      const result = await importGeoPackagePair(
        scenario(`invalid-interventions/${id}`).files,
      );

      expect(result.accepted).toBe(true);
      const hedgerow = result.project.project.postIntervention.hedgerows.find(
        (h) => h.ref === "HG001",
      );
      expect(hedgerow).toMatchObject({
        retentionCategory: "Enhanced",
        status: "Incomplete",
        units: null,
        proposed: { type: null, condition: null, strategicSignificance: null },
      });
    },
  );
});

describe.skipIf(!isBackendInstalled())("runMetricComparison", () => {
  it(
    "compares every committed scenario",
    async () => {
      const { results, unmatched } = await runMetricComparison();

      expect(unmatched).toEqual([]);
      expect(results.length).toBeGreaterThan(0);
      for (const result of results) {
        expect(Object.values(OUTCOME)).toContain(result.outcome);
      }
      expect(results.some((r) => r.compared > 0)).toBe(true);
    },
    CORPUS_TIMEOUT_MS,
  );

  it("selects scenarios by purpose, name or id", async () => {
    const { results } = await runMetricComparison({
      only: ["net-gain", "trading-all-met", "intervention/area-created"],
    });

    expect(results.map((r) => r.id).sort()).toEqual([
      "intervention/area-created",
      "net-gain/met",
      "net-gain/unmet",
      "trading-rules/trading-all-met",
    ]);
  });

  it.each(["invalid-area-advance-and-delay", "invalid-tree-advance-and-delay"])(
    "compares cleansed %s in full with its explicit contract",
    async (id) => {
      const { results } = await runMetricComparison({ only: [id] });

      expect(results[0].outcome).toBe(OUTCOME.matched);
      expect(results[0].expectedImport?.accepted).toBe(true);
      expect(results[0].rawInvalidData).toBe(true);
      expect(results[0].compared).toBeGreaterThan(0);
    },
  );
});

// A stand-in for the backend's import, so these run without a backend
// checkout: what matters is how the run treats an import that throws.
describe("runMetricComparison when the service's import throws", () => {
  const throwsFor = (failing) => async (files) => {
    if (files.baseline === scenario(failing).files.baseline) {
      throw new Error("GEOS threw: TopologyException");
    }
    return { accepted: false, rejectedFile: "baseline", errors: [] };
  };

  it("reports that scenario as a failed import, with the error", async () => {
    const { results } = await runMetricComparison({
      only: ["net-gain/met"],
      importPair: throwsFor("net-gain/met"),
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: "net-gain/met",
      outcome: OUTCOME.importFailed,
      errors: [
        { code: "IMPORT_FAILED", message: "GEOS threw: TopologyException" },
      ],
    });
  });

  it("carries on and reports every other scenario", async () => {
    const { results } = await runMetricComparison({
      only: ["net-gain"],
      importPair: throwsFor("net-gain/met"),
    });

    expect(Object.fromEntries(results.map((r) => [r.id, r.outcome]))).toEqual({
      "net-gain/met": OUTCOME.importFailed,
      "net-gain/unmet": OUTCOME.rejected,
    });
  });
});

describe.skipIf(!isBackendInstalled())(
  "cleansing contracts preserve comparison sensitivity",
  () => {
    const selected = scenario(
      "invalid-interventions/invalid-area-advance-and-delay",
    );
    async function compareMutation(mutate) {
      const [answers] = await readWorkbookAnswers([selected.files.workbook]);
      const expectation = readImportExpectations(DEFAULT_CORPUS_DIR).get(
        path.resolve(selected.files.postIntervention),
      );
      expect(expectation).toBeDefined();
      return compareCorpusScenario(
        selected,
        answers,
        expectation,
        async (files) => {
          const result = await importGeoPackagePair(files);
          mutate(result);
          return result;
        },
      );
    }
    it(
      "fails when timing is zero rather than saved null even if units still match",
      async () => {
        const result = await compareMutation((imported) => {
          const habitat =
            imported.project.project.postIntervention.habitats.find(
              (f) => f.ref === "H001",
            );
          habitat.proposed.advanceYears = 0;
          habitat.proposed.delayYears = 0;
        });
        expect(result.outcome).toBe(OUTCOME.importFailed);
        expect(result.errors[0].message).toContain("expected null");
      },
      CORPUS_TIMEOUT_MS,
    );
    it(
      "fails when an incomplete habitat has fabricated zero units",
      async () => {
        const result = await compareMutation((imported) => {
          imported.project.project.postIntervention.habitats.find(
            (f) => f.ref === "H001",
          ).units = 0;
        });
        expect(result.outcome).toBe(OUTCOME.importFailed);
        expect(result.errors[0].message).toContain(
          "expected null units with Incomplete",
        );
      },
      CORPUS_TIMEOUT_MS,
    );
    it(
      "fails when a calculated unit differs after all cleansing assertions pass",
      async () => {
        const result = await compareMutation((imported) => {
          const habitat =
            imported.project.project.postIntervention.habitats.find(
              (f) => f.ref !== "H001" && Number.isFinite(f.units),
            );
          expect(habitat).toBeDefined();
          habitat.units += 1;
        });
        expect(result.outcome).toBe(OUTCOME.discrepancies);
        expect(
          result.discrepancies.some(
            (d) =>
              d.category === "feature-units" && Math.abs(d.difference) > 0.9,
          ),
        ).toBe(true);
        expect(findUnexplained([result]).discrepancies.length).toBeGreaterThan(
          0,
        );
      },
      CORPUS_TIMEOUT_MS,
    );
  },
);
