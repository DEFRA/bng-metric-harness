/**
 * The recipes for the corpus's individual-tree fixtures: files derived from
 * `valid/default-site.gpkg` that show the service's tree rules (an Enhanced
 * tree, a tree kept twice, a replanted tree, irreplaceable trees). Kept apart
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
// The second point of the tree kept twice, and the tree planted in the felled
// one's place.
const RETAINED_TREE_AGAIN = "T004A";
const REPLANTED_TREE = "T026";

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
      [
        setValues(
          TREES_POST,
          { [PROPOSED_CONDITION]: "Moderate" },
          { [HABITAT_REF]: ENHANCED_TREE, [RETENTION]: "Enhanced" },
        ),
      ],
      "accepted, the tree saved as Incomplete with its Proposed Condition cleared, as the Metric does not score the enhancement",
    ),
    derived(
      "attribute-problems/tree-enhanced-from-good.gpkg",
      `\`valid/default-site.gpkg\` with ${RETAINED_GOOD_TREE}, a tree Retained in Good condition, Enhanced instead, still Good: a tree in Good condition cannot be enhanced. The template's drop-downs do not offer it, so it stands for a file edited outside QGIS`,
      [
        setValues(
          TREES_POST,
          { [RETENTION]: "Enhanced" },
          { [HABITAT_REF]: RETAINED_GOOD_TREE, [RETENTION]: "Retained" },
        ),
      ],
      // The whole file, as for any baseline the service cannot enhance at all
      // (BMD-1182), though BMD-1172 AC6 has the tree saved as Incomplete.
      "BASELINE_NOT_ENHANCEABLE",
    ),
    derived(
      "valid/tree-replanted.gpkg",
      `\`valid/default-site.gpkg\` with ${REPLANTED_TREE}, a small rural tree newly planted where the felled tree ${FELLED_TREE} stood, linked to it as its parent (${PLANTED_TREE} is planted with no parent)`,
      [
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
            "Habitat Created/Enhanced in advance/years": "0",
            "Delay in starting habitat creation/enhancement in years": "0",
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
      ],
      `${accepted}: ${REPLANTED_TREE} is priced as a creation, and ${FELLED_TREE} is lost in full`,
    ),
    derived(
      "valid/tree-irreplaceable-blank.gpkg",
      "`valid/default-site.gpkg` with Irreplaceable Habitat left blank on every tree, in both stages",
      [TREES_BASELINE, TREES_POST].map((table) =>
        setValues(
          table,
          { [IRREPLACEABLE_HABITAT]: null },
          { [IRREPLACEABLE_HABITAT]: "No" },
        ),
      ),
      `${accepted}: a blank Irreplaceable Habitat is read as No`,
    ),
    derived(
      "attribute-problems/tree-kept-twice.gpkg",
      `\`valid/default-site.gpkg\` with a second Retained point, ${RETAINED_TREE_AGAIN}, linked to the Retained tree ${RETAINED_TREE}, on the same spot: two trees kept where the baseline has one`,
      [
        copyRow(
          TREES_POST,
          { [HABITAT_REF]: RETAINED_TREE },
          { [HABITAT_REF]: RETAINED_TREE_AGAIN },
        ),
      ],
      "STAGED_TREE_CHILDREN_TOO_MANY",
    ),
    derived(
      "attribute-problems/irreplaceable-tree-baseline-only.gpkg",
      `\`valid/default-site.gpkg\` with the felled tree ${FELLED_TREE} marked irreplaceable, so only the baseline holds an irreplaceable tree`,
      [
        setValues(
          TREES_BASELINE,
          { [IRREPLACEABLE_HABITAT]: "Yes" },
          { [HABITAT_REF]: FELLED_TREE },
        ),
      ],
      "IRREPLACEABLE_TREE",
      [TREES_BASELINE],
    ),
    derived(
      "attribute-problems/irreplaceable-tree-post-intervention-only.gpkg",
      `\`valid/default-site.gpkg\` with the Retained tree ${RETAINED_TREE} marked irreplaceable at post-intervention only, its baseline row left No`,
      [
        setValues(
          TREES_POST,
          { [IRREPLACEABLE_HABITAT]: "Yes" },
          { [HABITAT_REF]: RETAINED_TREE },
        ),
      ],
      "IRREPLACEABLE_TREE",
      [TREES_POST],
    ),
  ];
}
