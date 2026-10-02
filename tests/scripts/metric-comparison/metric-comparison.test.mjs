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
import { OUTCOME, findScenarios } from "#metric-compare";
import { isBackendInstalled } from "../../../scripts/metric-comparison/backend.mjs";
import { importGeoPackagePair } from "../../../scripts/metric-comparison/import-geopackage-pair.mjs";
import {
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

  it("reports the data-quality errors of a refused post-intervention file", async () => {
    const result = await importGeoPackagePair(
      scenario("invalid-interventions/invalid-area-advance-and-delay").files,
    );

    expect(result).toMatchObject({
      accepted: false,
      rejectedFile: "postIntervention",
    });
    expect(result.errors.length).toBeGreaterThan(0);
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

  it("reports a scenario built on invalid data that the service refuses as expected", async () => {
    const { results } = await runMetricComparison({
      only: ["invalid-area-advance-and-delay"],
    });

    expect(results[0].outcome).toBe(OUTCOME.rejectedAsExpected);
  });
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
