import {
  FORMAT_BNG_SERVICE,
  FORMAT_LEGACY,
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
// The library's surplus-in-another-broad-habitat site, with its replaced
// heathland recorded the way a user's legacy file records it: Lost, which the
// service saves as the baseline loss plus a Created replacement. The relabel
// in prepareImportTiming writes every other Lost area Created, which a real
// upload reads as new habitat on empty land, so the baseline loses H004 and
// the Medium rule is met. keepLost leaves H004 Lost, so a real upload is
// refused the Medium rule, and one edit to the Created replacement in the
// service meets it: a quick trading-rules demonstration. It is not an
// import-timing case (importCases), so it carries no timing contract.
const SURPLUS_SITE_ID = "trading-surplus-in-another-broad-habitat";
const SURPLUS_SITE = PERMUTATION_SCENARIOS.find(
  (scenario) => scenario.id === SURPLUS_SITE_ID,
);
if (!SURPLUS_SITE) {
  // Without it the scenario would be drawn at random, with no trading
  // expectations to fail, under a title that promises a Medium breach.
  throw new Error(
    `bng-library no longer has ${SURPLUS_SITE_ID}, which trading-heathland-replaced-by-grassland is built on`,
  );
}
const lostReplacement = {
  ...SURPLUS_SITE,
  id: "trading-heathland-replaced-by-grassland",
  title:
    "Trading rules — a lost Medium heathland replaced by a Low grassland, met by one edit",
  description:
    "Area: three Medium grasslands are improved from Poor to Good, a large Medium surplus, while H004, a Medium heathland (Mixed scrub, Moderate), is Lost and a Low grassland (Modified grassland, Good) created on its land. The grassland surplus cannot make good the heathland loss, so the Medium rule is breached despite a net gain of over 50%. In the service, change H004's created habitat to Heathland and shrub, Mixed scrub, in Good (3) condition, and the Medium rule is met: a quick trading-rules demonstration.",
  keepLost: ["H004"],
  subject: {
    layer: "Habitats",
    ref: "H004",
    note: "the lost heathland; edit its created habitat to Mixed scrub to meet the Medium rule",
  },
};
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
  ...PERMUTATION_SCENARIOS.filter((scenario) =>
    scenarioInFormat(scenario, FORMAT_LEGACY),
  ).map((scenario) =>
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
  lostReplacement,
];
export const HARNESS_PURPOSES = [...PERMUTATION_PURPOSES, "import-timing"];

/**
 * The scenarios and purposes a corpus in `format` holds. The legacy corpus
 * holds the harness catalogue above: the library's legacy scenarios (less any
 * that lists only other formats, such as trading-trade-up-without-watercourse)
 * and the harness's own. The BNG Service corpus holds the
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
