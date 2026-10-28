import {
  FORMAT_BNG_SERVICE,
  PERMUTATION_PURPOSES,
  PERMUTATION_SCENARIOS,
  scenarioInFormat,
} from "#bng-lib";

const REFERENCE_NUMBER_WIDTH = 3;
const LOW = "Area/compensation not in local strategy/ no local strategy";
const TABLES = ["Habitats", "Hedgerows", "Rivers", "Urban Trees"];
const REFS = {
  Habitats: "H001",
  Hedgerows: "HG001",
  Rivers: "R001",
  "Urban Trees": "T001",
};

function identity(retention) {
  return {
    retention,
    baselineCondition: "Moderate",
    proposedCondition: "Good",
    baselineStrategicSignificance: LOW,
    proposedStrategicSignificance: LOW,
  };
}
function overrides(retentions) {
  return {
    habitats: retentions.map((retention) => ({
      ...identity(retention),
      habitatFullName: "Grassland - Modified grassland",
      proposedHabitatFullName: "Grassland - Modified grassland",
    })),
    hedgerows: retentions.map((retention) => ({
      ...identity(retention),
      hedgeType: "Native hedgerow",
      proposedHedgeType: "Native hedgerow",
    })),
    rivers: retentions.map((retention) => ({
      ...identity(retention),
      riverType: "Ditches",
      proposedRiverType: "Ditches",
      baselineWaterEncroachment: "No Encroachment",
      baselineRiparianEncroachment: "No Encroachment/No Encroachment",
      proposedWaterEncroachment: "No Encroachment",
      proposedRiparianEncroachment: "No Encroachment/No Encroachment",
    })),
    trees: retentions.map((retention) => ({
      ...identity(retention),
      treeSize: "Small",
      treeType: "Park/garden tree",
      ruralOrUrban: "Urban",
    })),
  };
}
function cases(retentions, advance, delay) {
  return TABLES.flatMap((layer) =>
    retentions.map((retention, index) => ({
      layer,
      ref: REFS[layer].replace(
        "001",
        String(index + 1).padStart(REFERENCE_NUMBER_WIDTH, "0"),
      ),
      retention,
      advance,
      delay,
    })),
  );
}
function timingScenario(id, title, description, retentions, advance, delay) {
  return {
    id,
    purpose: "import-timing",
    title,
    description,
    size: 2,
    treeCount: 2,
    overrides: overrides(retentions),
    importCases: cases(retentions, advance, delay),
    subject: {
      layer: "Habitats",
      ref: "H001",
      note: "Raw timing remains on the GeoPackage; saved timing follows the import rules.",
    },
  };
}
const additions = [
  timingScenario(
    "invalid-timing-conflicting-created-enhanced",
    "Created and Enhanced: conflicting timing is cleared",
    "AC3: both timing values are positive on Created/Enhanced features in all four layers. Import succeeds and saves null timing; BMD-1070 leaves these incomplete habitats unpriced in the workbook.",
    ["Created", "Enhanced"],
    "2",
    "3",
  ),
  timingScenario(
    "null-timing-created-enhanced",
    "Created and Enhanced: null timing stays null",
    "AC4: both timing values are null on Created/Enhanced features in all four layers. Import succeeds and preserves nulls.",
    ["Created", "Enhanced"],
    null,
    null,
  ),
  timingScenario(
    "invalid-timing-retained-lost",
    "Retained and Lost: redundant timing is cleared except area replacements",
    "AC5: populated timing is cleared on Retained features. Lost area replacements retain their timing as Created; Lost linear features and trees remain absent from the PI document; the baseline is preserved.",
    ["Retained", "Lost"],
    "4",
    "0",
  ),
];
const existingTiming = new Map([
  [
    "invalid-area-advance-and-delay",
    [
      {
        layer: "Habitats",
        ref: "H001",
        retention: "Created",
        advance: "2",
        delay: "3",
      },
    ],
  ],
  [
    "invalid-tree-advance-and-delay",
    [
      {
        layer: "Urban Trees",
        ref: "T001",
        retention: "Created",
        advance: "2",
        delay: "3",
      },
    ],
  ],
]);

export const HARNESS_SCENARIOS = [
  ...PERMUTATION_SCENARIOS.map((scenario) =>
    existingTiming.has(scenario.id)
      ? {
          ...scenario,
          expectMetricWarnings: [],
          importCases: existingTiming.get(scenario.id),
          description: `${scenario.description} BMD-1060 AC3 clears both timing values; BMD-1070 saves null units and Incomplete status.`,
        }
      : scenario,
  ),
  ...additions,
];
export const HARNESS_PURPOSES = [...PERMUTATION_PURPOSES, "import-timing"];

/**
 * The scenarios and purposes a corpus in `format` holds. The legacy corpus
 * holds the harness catalogue above. The BNG Service corpus holds the
 * library's catalogue, less any scenario that lists only other formats
 * (`scenarioInFormat`); the harness's import-timing scenarios stay legacy
 * only, as they work by editing a legacy file after it is generated.
 */
export function catalogueFor(format) {
  if (format !== FORMAT_BNG_SERVICE) {
    return { scenarios: HARNESS_SCENARIOS, purposes: HARNESS_PURPOSES };
  }
  const scenarios = PERMUTATION_SCENARIOS.filter((scenario) =>
    scenarioInFormat(scenario, format),
  );
  return {
    scenarios,
    purposes: PERMUTATION_PURPOSES.filter((purpose) =>
      scenarios.some((scenario) => scenario.purpose === purpose),
    ),
  };
}
