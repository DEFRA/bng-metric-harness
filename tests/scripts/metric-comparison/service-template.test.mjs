// The metric comparison for the BNG Service template (BMD-1084): its
// scenarios imported with the service-template flag on, which is the only way
// the service reads them, and compared with the Statutory Biodiversity
// Metric's own answers.
//
// The backend reads the flag once, when its config is first imported, so this
// file sets it before any test loads the backend. Vitest runs each test file
// in a process of its own, so it does not reach metric-comparison.test.mjs,
// which compares the legacy scenarios with the flag off. The tests that import
// need an installed backend beside the harness (or BNG_BACKEND_DIR), and skip
// without one.

import { describe, expect, it } from "vitest";
import { OUTCOME, findScenarios, readWorkbookAnswers } from "#metric-compare";
import { SERVICE_TEMPLATE_FLAG } from "../../../scripts/dev-env.mjs";
import { isBackendInstalled } from "../../../scripts/metric-comparison/backend.mjs";
import { importGeoPackagePair } from "../../../scripts/metric-comparison/import-geopackage-pair.mjs";
import {
  DEFAULT_CORPUS_DIR,
  SERVICE_TEMPLATE_CORPUS_DIR,
  compareCorpusScenario,
  runMetricComparison,
  scenariosInOtherTemplate,
} from "../../../scripts/metric-comparison/run-metric-comparison.mjs";

process.env[SERVICE_TEMPLATE_FLAG] = "true";

const VERTICAL_SCENARIO = "vertical-area/every-retention";
// AC9: a vertical area habitat's Area is typed in hectares, as the metric
// prices it; the service stores it in square metres.
const SQUARE_METRES_PER_HECTARE = 10_000;
const V001_AREA_SQUARE_METRES = 400;
// V001 is a Low distinctiveness wall in Moderate condition, of Low strategic
// significance: 2 × 2 × 1 units per hectare.
const LOW_DISTINCTIVENESS_SCORE = 2;
const MODERATE_CONDITION_SCORE = 2;
// The whole vertical-area purpose runs in a few seconds.
const IMPORT_TIMEOUT_MS = 60_000;

const { scenarios } = findScenarios(SERVICE_TEMPLATE_CORPUS_DIR);
const vertical = scenarios.find((s) => s.id === VERTICAL_SCENARIO);

describe("the template each corpus is in", () => {
  it("finds every committed BNG Service scenario in that template", () => {
    expect(scenarios.length).toBeGreaterThan(0);
    expect(scenariosInOtherTemplate(scenarios, true)).toEqual([]);
    expect(scenariosInOtherTemplate(scenarios, false)).toEqual(scenarios);
  });

  it("refuses to compare a legacy scenario with the flag on, before importing anything", async () => {
    const importPair = () => {
      throw new Error("nothing should be imported");
    };
    await expect(
      runMetricComparison({
        corpusDir: DEFAULT_CORPUS_DIR,
        only: ["net-gain"],
        serviceTemplate: true,
        importPair,
      }),
    ).rejects.toThrow(/compare them without --service-template/);
  });

  it("refuses to compare a BNG Service scenario with the flag off", async () => {
    await expect(
      runMetricComparison({
        corpusDir: SERVICE_TEMPLATE_CORPUS_DIR,
        only: ["net-gain"],
        serviceTemplate: false,
      }),
    ).rejects.toThrow(/compare them with --service-template/);
  });
});

describe.skipIf(!isBackendInstalled())(
  "vertical area habitats against the metric (BMD-1084)",
  () => {
    it("has the vertical area habitat scenario in the BNG Service corpus", () => {
      expect(vertical?.files).toBeDefined();
    });

    it(
      "stores V001's 0.04 ha as 400 m², and prices it at 0.04 ha (AC9)",
      async () => {
        const result = await importGeoPackagePair(vertical.files);

        expect(result.accepted).toBe(true);
        const v001 = result.project.project.baseline.verticalHabitats.find(
          (h) => h.ref === "V001",
        );
        expect(v001.sizeSquareMetres).toBe(V001_AREA_SQUARE_METRES);
        expect(v001.units).toBeCloseTo(
          (V001_AREA_SQUARE_METRES / SQUARE_METRES_PER_HECTARE) *
            LOW_DISTINCTIVENESS_SCORE *
            MODERATE_CONDITION_SCORE,
          12,
        );
      },
      IMPORT_TIMEOUT_MS,
    );

    it(
      "matches the metric figure for figure: Retained, Enhanced, Created and Lost (AC7)",
      async () => {
        const [answers] = await readWorkbookAnswers([vertical.files.workbook]);
        const result = await compareCorpusScenario(vertical, answers);

        expect(result.discrepancies).toEqual([]);
        expect(result.outcome).toBe(OUTCOME.matched);
      },
      IMPORT_TIMEOUT_MS,
    );
  },
);
