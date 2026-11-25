/**
 * The recipes for the corpus's individual-tree fixtures: files derived from
 * `valid/default-site.gpkg` that show the service's tree rules (an Enhanced
 * tree, a tree kept twice, a tree recorded twice, a replanted tree,
 * irreplaceable trees). Kept apart
 * from recipes.mjs, which lists them with the rest.
 */

import { copyRow, linkToParent, setValues } from "./derive.mjs";

const HABITAT_REF = "Habitat Ref";
const RETENTION = "Retention Category";
const TREES_BASELINE = "Individual Trees Baseline";
const TREES_POST = "Individual Trees Post-Intervention";
const IRREPLACEABLE_HABITAT = "Irreplaceable Habitat";
const PROPOSED_CONDITION = "Proposed Condition";
const COMMENT = "Comment";
// The default site's trees these fixtures change: a Retained tree, a Retained
// one in Good condition, one Enhanced from Moderate to Good, a felled one (a
// baseline row and no post-intervention one) and a newly planted one with no
// parent.
const RETAINED_TREE = "T004";
const RETAINED_GOOD_TREE = "T008";
const ENHANCED_TREE = "T006";
const FELLED_TREE = "T002";
const PLANTED_TREE = "T005";
// The second point of the tree kept twice (and of the one recorded twice),
// and the tree planted in the felled one's place.
const RETAINED_TREE_AGAIN = "T004A";
const REPLANTED_TREE = "T026";
// A felled tree in Moderate condition, so it has a lower one to get worse to,
// and the Retained row its Created again row is copied from.
const MODERATE_FELLED_TREE = "T007";
const ADVANCE_YEARS = "Habitat Created/Enhanced in advance/years";
const DELAY_YEARS = "Delay in starting habitat creation/enhancement in years";
const LOWER_CONDITION = "Poor";
const PUT_BACK_DELAY = "5";

// Each fixture's SQL edits to `valid/default-site.gpkg`.
const ENHANCED_NOT_BETTER_EDITS = [
  setValues(
    TREES_POST,
    { [PROPOSED_CONDITION]: "Moderate" },
    { [HABITAT_REF]: ENHANCED_TREE, [RETENTION]: "Enhanced" },
  ),
];
const ENHANCED_FROM_GOOD_EDITS = [
  setValues(
    TREES_POST,
    { [RETENTION]: "Enhanced" },
    { [HABITAT_REF]: RETAINED_GOOD_TREE, [RETENTION]: "Retained" },
  ),
];
const REPLANTED_EDITS = [
  copyRow(
    TREES_POST,
    { [HABITAT_REF]: PLANTED_TREE },
    {
      [HABITAT_REF]: REPLANTED_TREE,
      "Proposed Tree Size": "Small",
      "Proposed Tree Type": "Native",
      "Proposed Rural or Urban Tree": "Rural tree",
      [PROPOSED_CONDITION]: "Moderate",
      "Proposed Strategic Significance": "Low",
      [ADVANCE_YEARS]: "0",
      [DELAY_YEARS]: "0",
      [COMMENT]: `Planted in place of ${FELLED_TREE}`,
    },
  ),
  linkToParent(
    TREES_POST,
    { [HABITAT_REF]: REPLANTED_TREE },
    TREES_BASELINE,
    { [HABITAT_REF]: FELLED_TREE },
    // On the felled tree's spot. Its Baseline columns stay N/A, the only
    // value the template offers a Created tree.
    { geom: "geom" },
  ),
];
const IRREPLACEABLE_BLANK_EDITS = [TREES_BASELINE, TREES_POST].map((table) =>
  setValues(
    table,
    { [IRREPLACEABLE_HABITAT]: null },
    { [IRREPLACEABLE_HABITAT]: "No" },
  ),
);
const KEPT_TWICE_EDITS = [
  copyRow(
    TREES_POST,
    { [HABITAT_REF]: RETAINED_TREE },
    { [HABITAT_REF]: RETAINED_TREE_AGAIN },
  ),
];
// T004 kept and also Created again over itself as an Existing tree, linked
// to it, as a tree that gets worse is recorded (Poor, 30+ years in advance,
// no delay), so only the recorded-twice rule is broken.
const RECORDED_TWICE_EDITS = [
  copyRow(
    TREES_POST,
    { [HABITAT_REF]: RETAINED_TREE },
    {
      [HABITAT_REF]: RETAINED_TREE_AGAIN,
      [RETENTION]: "Created",
      Category: "Existing",
      [PROPOSED_CONDITION]: LOWER_CONDITION,
      [ADVANCE_YEARS]: "30+",
      [DELAY_YEARS]: null,
      [COMMENT]: null,
    },
  ),
];

/**
 * The felled tree T007 Created again where it stood, linked to it, in its own
 * size, type and setting, as the template records a tree that is cleared and
 * put back: `values` sets its condition and timing.
 */
function createdAgainEdits(values) {
  const createdAgain = {
    [HABITAT_REF]: MODERATE_FELLED_TREE,
    [RETENTION]: "Created",
  };
  return [
    copyRow(
      TREES_POST,
      { [HABITAT_REF]: RETAINED_TREE },
      {
        [HABITAT_REF]: MODERATE_FELLED_TREE,
        [RETENTION]: "Created",
        Category: "Existing",
        [COMMENT]: null,
        ...values,
      },
    ),
    linkToParent(
      TREES_POST,
      createdAgain,
      TREES_BASELINE,
      { [HABITAT_REF]: MODERATE_FELLED_TREE },
      {
        geom: "geom",
        "Baseline Tree Size": "Baseline Tree Size",
        "Baseline Tree Type": "Baseline Tree Type",
        "Baseline Rural or Urban Tree": "Baseline Rural or Urban Tree",
        "Baseline Condition": "Baseline Condition",
        "Baseline Strategic Significance": "Baseline Strategic Significance",
      },
    ),
    linkToParent(
      TREES_POST,
      createdAgain,
      TREES_BASELINE,
      { [HABITAT_REF]: MODERATE_FELLED_TREE },
      {
        "Baseline Tree Size": "Proposed Tree Size",
        "Baseline Tree Type": "Proposed Tree Type",
        "Baseline Rural or Urban Tree": "Proposed Rural or Urban Tree",
      },
    ),
  ];
}

// T007 got worse: Created again in a lower condition, 30+ years in advance,
// with no delay, as the guide asks; each fixture breaks one of those.
const degradedTree = (values) =>
  createdAgainEdits({
    [PROPOSED_CONDITION]: LOWER_CONDITION,
    [ADVANCE_YEARS]: "30+",
    [DELAY_YEARS]: null,
    ...values,
  });

/** Mark one tree irreplaceable in one stage only. */
function markIrreplaceable(table, ref) {
  return [
    setValues(
      table,
      { [IRREPLACEABLE_HABITAT]: "Yes" },
      { [HABITAT_REF]: ref },
    ),
  ];
}

/**
 * The felled tree T007 Created again where it stood: three that break one of
 * the guide's steps for a tree that gets worse, and one put back after a
 * delay, which the service takes.
 */
function degradedTreeRecipes({ derived, accepted }) {
  return [
    derived(
      "attribute-problems/tree-degrade-same-condition.gpkg",
      `\`valid/default-site.gpkg\` with the felled tree ${MODERATE_FELLED_TREE} (Moderate) Created again where it stood, linked to it, 30+ years in advance, in the same condition: kept as it was, it should be Retained`,
      degradedTree({ [PROPOSED_CONDITION]: "Moderate" }),
      "STAGED_TREE_DEGRADE_NOT_VALID",
    ),
    derived(
      "attribute-problems/tree-degrade-better-condition.gpkg",
      `\`valid/default-site.gpkg\` with the felled tree ${MODERATE_FELLED_TREE} (Moderate) Created again where it stood, linked to it, 30+ years in advance, in a better condition (Good): a tree that gets better is Enhanced`,
      degradedTree({ [PROPOSED_CONDITION]: "Good" }),
      "STAGED_TREE_DEGRADE_NOT_VALID",
    ),
    derived(
      "attribute-problems/tree-degrade-advance-10.gpkg",
      `\`valid/default-site.gpkg\` with the felled tree ${MODERATE_FELLED_TREE} (Moderate) Created again where it stood, linked to it, in a lower condition (${LOWER_CONDITION}), only 10 years in advance, where the Metric asks for 30 plus`,
      degradedTree({ [ADVANCE_YEARS]: "10" }),
      "STAGED_TREE_DEGRADE_NOT_VALID",
    ),
    derived(
      "valid/tree-put-back-same-condition.gpkg",
      `\`valid/default-site.gpkg\` with the felled tree ${MODERATE_FELLED_TREE} (Moderate) cleared and put back where it stood, linked to it, after a ${PUT_BACK_DELAY}-year delay, in its baseline condition`,
      createdAgainEdits({
        [PROPOSED_CONDITION]: "Moderate",
        [ADVANCE_YEARS]: null,
        [DELAY_YEARS]: PUT_BACK_DELAY,
      }),
      `${accepted}: ${MODERATE_FELLED_TREE} is lost and Created again`,
    ),
  ];
}

/**
 * The tree recipes, each built with recipes.mjs's `derived`; `accepted` is
 * its outcome for a file the service takes. Both are passed in rather than
 * imported, as recipes.mjs imports this module.
 */
export function treeRecipes({ derived, accepted }) {
  return [
    derived(
      "incomplete/tree-enhanced-not-better.gpkg",
      `\`valid/default-site.gpkg\` with ${ENHANCED_TREE}, a tree Enhanced from Moderate to Good, given a Proposed Condition of Moderate: an enhancement that does not improve its condition. The template's drop-down does not offer it, so it stands for a file edited outside QGIS`,
      ENHANCED_NOT_BETTER_EDITS,
      "accepted, the tree saved as Incomplete with its Proposed Condition cleared, as the Metric does not score the enhancement",
    ),
    derived(
      "attribute-problems/tree-enhanced-from-good.gpkg",
      `\`valid/default-site.gpkg\` with ${RETAINED_GOOD_TREE}, a tree Retained in Good condition, Enhanced instead, still Good: a tree in Good condition cannot be enhanced. The template's drop-downs do not offer it, so it stands for a file edited outside QGIS`,
      ENHANCED_FROM_GOOD_EDITS,
      // The whole file, as for any baseline the service cannot enhance at all
      // (BMD-1182, BMD-1172 AC6), with the trees' own code.
      "TREE_NOT_ENHANCEABLE",
    ),
    derived(
      "valid/tree-replanted.gpkg",
      `\`valid/default-site.gpkg\` with ${REPLANTED_TREE}, a small rural tree newly planted where the felled tree ${FELLED_TREE} stood, linked to it as its parent (${PLANTED_TREE} is planted with no parent)`,
      REPLANTED_EDITS,
      `${accepted}: ${REPLANTED_TREE} is priced as a creation, and ${FELLED_TREE} is lost in full`,
    ),
    // For a tree the column is mandatory: anything but "No", a blank
    // included, is treated as irreplaceable.
    derived(
      "attribute-problems/tree-irreplaceable-blank.gpkg",
      "`valid/default-site.gpkg` with Irreplaceable Habitat left blank on every tree, in both stages: a tree's Irreplaceable Habitat must be No",
      IRREPLACEABLE_BLANK_EDITS,
      "IRREPLACEABLE_TREE",
    ),
    derived(
      "attribute-problems/tree-kept-twice.gpkg",
      `\`valid/default-site.gpkg\` with a second Retained point, ${RETAINED_TREE_AGAIN}, linked to the Retained tree ${RETAINED_TREE}, on the same spot: two trees kept where the baseline has one`,
      KEPT_TWICE_EDITS,
      "STAGED_TREE_CHILDREN_TOO_MANY",
    ),
    derived(
      "attribute-problems/tree-recorded-twice.gpkg",
      `\`valid/default-site.gpkg\` with the Retained tree ${RETAINED_TREE} also Created again over itself as an Existing tree, ${RETAINED_TREE_AGAIN}, linked to it, on the same spot, in a lower condition (${LOWER_CONDITION}), 30+ years in advance: one tree both kept and lost and created again, so it would be scored twice`,
      RECORDED_TWICE_EDITS,
      "STAGED_TREE_RECORDED_TWICE",
    ),
    derived(
      "attribute-problems/irreplaceable-tree-baseline-only.gpkg",
      `\`valid/default-site.gpkg\` with the felled tree ${FELLED_TREE} marked irreplaceable, so only the baseline holds an irreplaceable tree`,
      markIrreplaceable(TREES_BASELINE, FELLED_TREE),
      "IRREPLACEABLE_TREE",
      [TREES_BASELINE],
    ),
    ...degradedTreeRecipes({ derived, accepted }),
    derived(
      "attribute-problems/irreplaceable-tree-post-intervention-only.gpkg",
      `\`valid/default-site.gpkg\` with the Retained tree ${RETAINED_TREE} marked irreplaceable at post-intervention only, its baseline row left No`,
      markIrreplaceable(TREES_POST, RETAINED_TREE),
      "IRREPLACEABLE_TREE",
      [TREES_POST],
    ),
  ];
}
