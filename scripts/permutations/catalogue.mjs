/**
 * The permutations catalogue: a declarative set of scenarios the runner turns
 * into paired baseline / post-intervention GeoPackages, organised by purpose.
 *
 * Each scenario is a plain recipe over the bng-library `attributeOverrides`
 * surface (see `generateOne`). A scenario names:
 *   id            kebab-case, unique; drives the output filenames
 *   purpose       the sub-folder it lands in (a testing theme)
 *   title         one-line human label
 *   description   what the fixture demonstrates
 *   size          habitat parcel count (also scales hedgerow/river/tree counts)
 *   overrides     bng-library attributeOverrides ({ habitats, hedgerows, rivers })
 *   subject       { layer, ref, note } — the feature a tester should open
 *   expectGain    'met' | 'unmet' — when set, the runner prices the habitats
 *                 through the engine and asserts the +10% threshold
 *
 * The axes from BMD-934 map onto the purposes below: intervention categories
 * across the three habitat types, conditions, strategic significance, met/unmet
 * 10% net gain, low→medium distinctiveness trading, enhancement/creation
 * advance & delay years, and complete vs incomplete data.
 */

import {
  CONDITIONS,
  HEDGE_CONDITIONS,
  IN_SCOPE_HEDGE_TYPES,
  STRATEGIC_SIGNIFICANCE,
} from "#bng-lib";

// Habitats chosen for stable distinctiveness bands and a full 5-condition
// range, so a scenario can pin any condition without hitting a "Not Possible"
// (habitat, condition) pair.
const HABITAT_LOW = "Grassland - Modified grassland";
const HABITAT_MEDIUM = "Grassland - Other neutral grassland";
const HABITAT_HIGH = "Grassland - Lowland calcareous grassland";

// Strategic significance, worst → best multiplier. Index 2 is the "Low (1)"
// value the habitat-details pages display.
const SS_LOW = STRATEGIC_SIGNIFICANCE[2];
const SS_MEDIUM = STRATEGIC_SIGNIFICANCE[1];
const SS_HIGH = STRATEGIC_SIGNIFICANCE[0];

const RIVER_TYPE = "Canals";
const HEDGE_TYPE = IN_SCOPE_HEDGE_TYPES[0];
const HEDGE_GOOD = HEDGE_CONDITIONS[0];
const HEDGE_MODERATE = HEDGE_CONDITIONS[1];

const NO_WATER_ENCROACHMENT = "No Encroachment";
const NO_RIPARIAN_ENCROACHMENT = "No Encroachment/No Encroachment";

const DEFAULT_SIZE = 6;

/** Repeat a per-row recipe `n` times to pin every row of a layer. */
function repeat(recipe, n) {
  return Array.from({ length: n }, () => ({ ...recipe }));
}

// ---------------------------------------------------------------------------
// Intervention categories across the three habitat types
// ---------------------------------------------------------------------------

const areaBase = {
  habitatFullName: HABITAT_MEDIUM,
  baselineCondition: "Moderate",
  baselineStrategicSignificance: SS_LOW,
  proposedStrategicSignificance: SS_LOW,
};

const interventionScenarios = [
  {
    id: "intervention-area-retained",
    purpose: "intervention",
    title: "Area habitat — Retained",
    description:
      "Every area parcel is retained: proposed state mirrors the baseline.",
    overrides: {
      habitats: repeat({ ...areaBase, retention: "Retained" }, DEFAULT_SIZE),
    },
    subject: {
      layer: "Habitats",
      ref: "H001",
      note: "a retained area habitat",
    },
  },
  {
    id: "intervention-area-enhanced",
    purpose: "intervention",
    title: "Area habitat — Enhanced",
    description:
      "Area parcels are enhanced from Moderate to Good condition (same habitat).",
    overrides: {
      habitats: repeat(
        {
          ...areaBase,
          retention: "Enhanced",
          proposedHabitatFullName: HABITAT_MEDIUM,
          proposedCondition: "Good",
        },
        DEFAULT_SIZE,
      ),
    },
    subject: {
      layer: "Habitats",
      ref: "H001",
      note: "an enhanced area habitat",
    },
  },
  {
    id: "intervention-area-created",
    purpose: "intervention",
    title: "Area habitat — Created",
    description:
      "Area parcels are created (written to the gpkg as the statutory 'Lost' retention).",
    overrides: {
      habitats: repeat(
        {
          ...areaBase,
          retention: "Created",
          proposedHabitatFullName: HABITAT_MEDIUM,
          proposedCondition: "Good",
        },
        DEFAULT_SIZE,
      ),
    },
    subject: { layer: "Habitats", ref: "H001", note: "a created area habitat" },
  },
  {
    id: "intervention-hedgerow-retained",
    purpose: "intervention",
    title: "Hedgerow — Retained",
    description:
      "The first hedgerow is retained; area parcels tile the redline.",
    overrides: {
      hedgerows: [
        {
          hedgeType: HEDGE_TYPE,
          retention: "Retained",
          baselineCondition: HEDGE_GOOD,
          proposedCondition: HEDGE_GOOD,
          baselineStrategicSignificance: SS_LOW,
          proposedStrategicSignificance: SS_LOW,
        },
      ],
    },
    subject: {
      layer: "Hedgerows",
      ref: "HG001",
      note: "a retained hedgerow",
    },
  },
  {
    id: "intervention-hedgerow-enhanced",
    purpose: "intervention",
    title: "Hedgerow — Enhanced",
    description:
      "The first hedgerow is enhanced from Moderate to Good condition.",
    overrides: {
      hedgerows: [
        {
          hedgeType: HEDGE_TYPE,
          retention: "Enhanced",
          baselineCondition: HEDGE_MODERATE,
          proposedCondition: HEDGE_GOOD,
          baselineStrategicSignificance: SS_LOW,
          proposedStrategicSignificance: SS_LOW,
        },
      ],
    },
    subject: {
      layer: "Hedgerows",
      ref: "HG001",
      note: "an enhanced hedgerow",
    },
  },
  {
    id: "intervention-hedgerow-created",
    purpose: "intervention",
    title: "Hedgerow — Created",
    description:
      "The first hedgerow is created; its baseline columns take the template placeholders.",
    overrides: {
      hedgerows: [
        {
          hedgeType: HEDGE_TYPE,
          retention: "Created",
          proposedCondition: HEDGE_GOOD,
          proposedStrategicSignificance: SS_LOW,
          advanceYears: "2",
        },
      ],
    },
    subject: { layer: "Hedgerows", ref: "HG001", note: "a created hedgerow" },
  },
  {
    id: "intervention-watercourse-retained",
    purpose: "intervention",
    title: "Watercourse — Retained",
    description: "The first watercourse is retained, with no encroachment.",
    overrides: {
      rivers: [
        {
          riverType: RIVER_TYPE,
          retention: "Retained",
          baselineCondition: "Fairly Good",
          proposedCondition: "Fairly Good",
          baselineStrategicSignificance: SS_LOW,
          proposedStrategicSignificance: SS_LOW,
          baselineWaterEncroachment: NO_WATER_ENCROACHMENT,
          proposedWaterEncroachment: NO_WATER_ENCROACHMENT,
          baselineRiparianEncroachment: NO_RIPARIAN_ENCROACHMENT,
          proposedRiparianEncroachment: NO_RIPARIAN_ENCROACHMENT,
        },
      ],
    },
    subject: {
      layer: "Rivers",
      ref: "R001",
      note: "a retained watercourse",
    },
  },
  {
    id: "intervention-watercourse-enhanced",
    purpose: "intervention",
    title: "Watercourse — Enhanced",
    description:
      "The first watercourse is enhanced from Moderate to Good condition.",
    overrides: {
      rivers: [
        {
          riverType: RIVER_TYPE,
          retention: "Enhanced",
          baselineCondition: "Moderate",
          proposedCondition: "Good",
          baselineStrategicSignificance: SS_LOW,
          proposedStrategicSignificance: SS_LOW,
          baselineWaterEncroachment: NO_WATER_ENCROACHMENT,
          proposedWaterEncroachment: NO_WATER_ENCROACHMENT,
          baselineRiparianEncroachment: NO_RIPARIAN_ENCROACHMENT,
          proposedRiparianEncroachment: NO_RIPARIAN_ENCROACHMENT,
        },
      ],
    },
    subject: {
      layer: "Rivers",
      ref: "R001",
      note: "an enhanced watercourse",
    },
  },
  {
    id: "intervention-watercourse-created",
    purpose: "intervention",
    title: "Watercourse — Created",
    description:
      "The first watercourse is created; its baseline columns take the template placeholders.",
    overrides: {
      rivers: [
        {
          riverType: RIVER_TYPE,
          retention: "Created",
          proposedCondition: "Good",
          proposedStrategicSignificance: SS_LOW,
          proposedWaterEncroachment: NO_WATER_ENCROACHMENT,
          proposedRiparianEncroachment: NO_RIPARIAN_ENCROACHMENT,
          delayYears: "2",
        },
      ],
    },
    subject: { layer: "Rivers", ref: "R001", note: "a created watercourse" },
  },
];

// ---------------------------------------------------------------------------
// Conditions — one parcel per condition band
// ---------------------------------------------------------------------------

const conditionScenarios = [
  {
    id: "conditions-area-spread",
    purpose: "conditions",
    title: "Area habitats across every condition band",
    description:
      "Six retained parcels, each pinned to a different condition (Good → Poor), same habitat.",
    size: CONDITIONS.length,
    overrides: {
      habitats: CONDITIONS.map((condition) => ({
        habitatFullName: HABITAT_MEDIUM,
        retention: "Retained",
        baselineCondition: condition,
        baselineStrategicSignificance: SS_LOW,
        proposedStrategicSignificance: SS_LOW,
      })),
    },
    subject: {
      layer: "Habitats",
      ref: "H001",
      note: "Good condition (H001) through Poor (H005)",
    },
  },
];

// ---------------------------------------------------------------------------
// Strategic significance — one parcel per multiplier band
// ---------------------------------------------------------------------------

const strategicSignificanceScenarios = [
  {
    id: "strategic-significance-spread",
    purpose: "strategic-significance",
    title: "Area habitats across every strategic-significance band",
    description:
      "Three retained parcels pinned to Low (1), Medium and High strategic significance.",
    size: 3,
    overrides: {
      habitats: [SS_LOW, SS_MEDIUM, SS_HIGH].map((ss) => ({
        habitatFullName: HABITAT_MEDIUM,
        retention: "Retained",
        baselineCondition: "Moderate",
        baselineStrategicSignificance: ss,
        proposedStrategicSignificance: ss,
      })),
    },
    subject: {
      layer: "Habitats",
      ref: "H001",
      note: "H001 Low (1), H002 Medium, H003 High strategic significance",
    },
  },
];

// ---------------------------------------------------------------------------
// Met / unmet 10% net gain (engine-verified)
// ---------------------------------------------------------------------------

const netGainScenarios = [
  {
    id: "net-gain-met",
    purpose: "net-gain",
    title: "Net gain met (≥ 10%)",
    description:
      "Every parcel enhanced from Low-distinctiveness/Poor to Medium-distinctiveness/Good — a large, unambiguous gain.",
    overrides: {
      habitats: repeat(
        {
          habitatFullName: HABITAT_LOW,
          proposedHabitatFullName: HABITAT_MEDIUM,
          retention: "Enhanced",
          baselineCondition: "Poor",
          proposedCondition: "Good",
          baselineStrategicSignificance: SS_LOW,
          proposedStrategicSignificance: SS_LOW,
        },
        DEFAULT_SIZE,
      ),
    },
    expectGain: "met",
    subject: {
      layer: "Habitats",
      ref: "H001",
      note: "enhanced parcels driving a net gain over 10%",
    },
  },
  {
    id: "net-gain-unmet",
    purpose: "net-gain",
    title: "Net gain unmet (< 10%)",
    description:
      "Every parcel retained unchanged — zero net change, so the 10% gain is not met.",
    overrides: {
      habitats: repeat(
        {
          habitatFullName: HABITAT_MEDIUM,
          retention: "Retained",
          baselineCondition: "Moderate",
          baselineStrategicSignificance: SS_LOW,
          proposedStrategicSignificance: SS_LOW,
        },
        DEFAULT_SIZE,
      ),
    },
    expectGain: "unmet",
    subject: {
      layer: "Habitats",
      ref: "H001",
      note: "retained parcels with no net gain",
    },
  },
];

// ---------------------------------------------------------------------------
// Trading rules — low → medium distinctiveness transfer
// ---------------------------------------------------------------------------

const tradingScenarios = [
  {
    id: "trading-low-to-medium",
    purpose: "trading-rules",
    title: "Trading rules — Low → Medium distinctiveness",
    description:
      "Parcels enhanced from a Low-distinctiveness habitat to a Medium-distinctiveness one, exercising the low→medium trading rule.",
    overrides: {
      habitats: repeat(
        {
          habitatFullName: HABITAT_LOW,
          proposedHabitatFullName: HABITAT_MEDIUM,
          retention: "Enhanced",
          baselineCondition: "Moderate",
          proposedCondition: "Good",
          baselineStrategicSignificance: SS_LOW,
          proposedStrategicSignificance: SS_LOW,
        },
        DEFAULT_SIZE,
      ),
    },
    subject: {
      layer: "Habitats",
      ref: "H001",
      note: "Low (baseline) → Medium (proposed) distinctiveness",
    },
  },
];

// ---------------------------------------------------------------------------
// Enhancement / creation advance & delay years
// ---------------------------------------------------------------------------

const advanceDelayScenarios = [
  {
    id: "advance-delay-created-advance",
    purpose: "advance-delay",
    title: "Created habitat — advance years",
    description:
      "Created parcels with habitat creation started 5 years in advance (delay 0).",
    overrides: {
      habitats: repeat(
        {
          habitatFullName: HABITAT_HIGH,
          proposedHabitatFullName: HABITAT_HIGH,
          retention: "Created",
          proposedCondition: "Good",
          baselineStrategicSignificance: SS_LOW,
          proposedStrategicSignificance: SS_LOW,
          advanceYears: "5",
          delayYears: "0",
        },
        DEFAULT_SIZE,
      ),
    },
    subject: {
      layer: "Habitats",
      ref: "H001",
      note: "created parcel with 5 advance years",
    },
  },
  {
    id: "advance-delay-created-delay",
    purpose: "advance-delay",
    title: "Created habitat — delay years",
    description:
      "Created parcels with habitat creation delayed by 3 years (advance 0).",
    overrides: {
      habitats: repeat(
        {
          habitatFullName: HABITAT_HIGH,
          proposedHabitatFullName: HABITAT_HIGH,
          retention: "Created",
          proposedCondition: "Good",
          baselineStrategicSignificance: SS_LOW,
          proposedStrategicSignificance: SS_LOW,
          advanceYears: "0",
          delayYears: "3",
        },
        DEFAULT_SIZE,
      ),
    },
    subject: {
      layer: "Habitats",
      ref: "H001",
      note: "created parcel with 3 delay years",
    },
  },
];

// ---------------------------------------------------------------------------
// Complete vs incomplete post-intervention data
// ---------------------------------------------------------------------------

const completenessScenarios = [
  {
    id: "data-complete",
    purpose: "data-completeness",
    title: "Complete post-intervention data",
    description:
      "Every enhanced parcel has all proposed attributes populated — a clean, complete file.",
    overrides: {
      habitats: repeat(
        {
          habitatFullName: HABITAT_MEDIUM,
          proposedHabitatFullName: HABITAT_MEDIUM,
          retention: "Enhanced",
          baselineCondition: "Moderate",
          proposedCondition: "Good",
          baselineStrategicSignificance: SS_LOW,
          proposedStrategicSignificance: SS_LOW,
        },
        DEFAULT_SIZE,
      ),
    },
    subject: {
      layer: "Habitats",
      ref: "H001",
      note: "a complete enhanced parcel",
    },
  },
  {
    id: "data-incomplete-mix",
    purpose: "data-completeness",
    title: "Mixed complete and incomplete data",
    description:
      "The first three parcels are complete; the last three are incomplete (blank proposed condition and strategic significance).",
    overrides: {
      habitats: [
        ...repeat(
          {
            habitatFullName: HABITAT_MEDIUM,
            proposedHabitatFullName: HABITAT_MEDIUM,
            retention: "Enhanced",
            baselineCondition: "Moderate",
            proposedCondition: "Good",
            baselineStrategicSignificance: SS_LOW,
            proposedStrategicSignificance: SS_LOW,
          },
          3,
        ),
        ...repeat(
          {
            habitatFullName: HABITAT_MEDIUM,
            retention: "Enhanced",
            baselineCondition: "Moderate",
            baselineStrategicSignificance: SS_LOW,
            incomplete: true,
          },
          3,
        ),
      ],
    },
    subject: {
      layer: "Habitats",
      ref: "H004",
      note: "H004–H006 have blank proposed data",
    },
  },
];

export const SCENARIOS = [
  ...interventionScenarios,
  ...conditionScenarios,
  ...strategicSignificanceScenarios,
  ...netGainScenarios,
  ...tradingScenarios,
  ...advanceDelayScenarios,
  ...completenessScenarios,
];

export const PURPOSES = [...new Set(SCENARIOS.map((s) => s.purpose))];

export { DEFAULT_SIZE };
