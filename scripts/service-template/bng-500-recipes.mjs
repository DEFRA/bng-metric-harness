/**
 * The recipes for the corpus's bng-500/ family: the legacy BNG500 pairs,
 * converted by the BNG Service template's own converter (see convert.mjs).
 * Kept apart from recipes.mjs, which lists them with the rest.
 */

export const KIND_CONVERTED = "converted";

const AREA_BASELINE = "Area Habitats Baseline";
const BASELINE_CONDITION = "Baseline Condition";
const ADVANCE_YEARS = "Habitat created in advance/years";

/**
 * A legacy BNG500 pair, converted. `knownIssues` is what the lineage and
 * template-value checks report on the converted file: the converter leaves
 * an unprovable parent link for the service to infer, and copies values the
 * template does not offer for the user to fix.
 */
function converted(site, seed, knownIssues) {
  return {
    path: `bng-500/${site}.gpkg`,
    kind: KIND_CONVERTED,
    covers: `\`${site}\`, converted`,
    expected:
      "not ready to upload as it stands: the converter's manual steps (its warnings) are still to do",
    baseline: `example-files/bng-500/${site}-baseline.gpkg`,
    postIntervention: `example-files/bng-500/${site}-post-intervention.gpkg`,
    seed,
    knownIssues: { lineage: [], ...knownIssues },
  };
}

const AREA_POST = "Area Habitats Post-Intervention";
const TREES_BASELINE = "Individual Trees Baseline";
const TREES_POST = "Individual Trees Post-Intervention";
const WATERCOURSES_POST = "Watercourses Post-Intervention";
const RURAL_OR_URBAN = "Baseline Rural or Urban Tree";
const TREE_TYPE = "Baseline Tree Type";
const PROPOSED_SIGNIFICANCE = "Proposed Strategic Significance";
// Values the BNG500 files' trees carry that the template's lists do not.
const TREE_VALUES = [
  "Baseline Tree Size",
  "Category",
  "Proposed Rural or Urban Tree",
  "Proposed Tree Type",
  "Retention Category",
];
const TREE_BASELINE_VALUES = [RURAL_OR_URBAN, TREE_TYPE];
const RIPARIAN_ENCROACHMENT = [
  "Baseline Encroachment into riparian zone",
  "Proposed Encroachment into riparian zone",
];
const WATERCOURSE_ENCROACHMENT = [
  ...RIPARIAN_ENCROACHMENT,
  "Baseline Encroachment into Watercourse",
  "Proposed Encroachment into Watercourse",
];

/** The bng-500/ recipes, each converted with the corpus's `seed`. */
export function bng500Recipes(seed) {
  return [
    converted("BROADLAND_2024_3282", seed, {
      templateValues: {
        [TREES_BASELINE]: TREE_BASELINE_VALUES,
        [TREES_POST]: [
          ...TREE_VALUES,
          BASELINE_CONDITION,
          RURAL_OR_URBAN,
          TREE_TYPE,
        ],
      },
    }),
    converted("BarkingandDagenham2400625FULL", seed, {
      lineage: ["lineage-parent-missing"],
      templateValues: {
        [TREES_POST]: [...TREE_VALUES, PROPOSED_SIGNIFICANCE],
        [WATERCOURSES_POST]: WATERCOURSE_ENCROACHMENT,
      },
    }),
    converted("CAMBRIDGE_24_03964_FUL", seed, {
      templateValues: {
        [AREA_POST]: [PROPOSED_SIGNIFICANCE],
        [TREES_BASELINE]: TREE_BASELINE_VALUES,
        [TREES_POST]: [
          ...TREE_VALUES,
          BASELINE_CONDITION,
          RURAL_OR_URBAN,
          TREE_TYPE,
        ],
      },
    }),
    converted("Sunderland_24_00723_FU4", seed, {
      templateValues: {
        [AREA_BASELINE]: ["Baseline Habitat Type"],
        [AREA_POST]: [ADVANCE_YEARS],
        "Hedgerows Post-Intervention": [ADVANCE_YEARS],
        [TREES_BASELINE]: TREE_BASELINE_VALUES,
        [TREES_POST]: [
          ...TREE_VALUES,
          "Habitat Created/Enhanced in advance/years",
        ],
        [WATERCOURSES_POST]: RIPARIAN_ENCROACHMENT,
      },
    }),
    converted("Wiltshire_PL_2024_08441", seed, {
      templateValues: { [WATERCOURSES_POST]: WATERCOURSE_ENCROACHMENT },
    }),
  ];
}
