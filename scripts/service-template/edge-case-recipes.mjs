/**
 * The recipes for the corpus's edge-case fixtures: files derived from the
 * default site that hold values a surveyor can type but no generator writes
 * (long, padded and non-ASCII Habitat Refs, blank values the service saves as
 * Incomplete, text the service refuses, a missing red line boundary, and
 * watercourses only post intervention). Kept apart from recipes.mjs, which
 * lists them with the rest.
 */

import { copyRow, deleteRows, setValues } from "./derive.mjs";

const HABITAT_REF = "Habitat Ref";
const PARENT_REF = "Parent Ref";
const RETENTION = "Retention Category";
const COMMENT = "Comment";
const BASELINE_CONDITION = "Baseline Condition";
const BASELINE_RIPARIAN = "Baseline Encroachment into riparian zone";
const ADVANCE_YEARS = "Habitat created in advance/years";
const DELAY_YEARS = "Delay in starting habitat creation/years";

const AREA_LAYER = "Area Habitats";
const AREA_BASELINE = `${AREA_LAYER} Baseline`;
const AREA_POST = `${AREA_LAYER} Post-Intervention`;
const HEDGEROWS_BASELINE = "Hedgerows Baseline";
const HEDGEROWS_POST = "Hedgerows Post-Intervention";
const WATERCOURSES_BASELINE = "Watercourses Baseline";
const WATERCOURSES_POST = "Watercourses Post-Intervention";
const TREES_POST = "Individual Trees Post-Intervention";
const VERTICAL_POST = "Vertical Area Habitats Post-Intervention";
const RED_LINE = "Red Line Boundary";

const BASELINE_STAGE_BASE = "valid/default-site-baseline.gpkg";

// The default site's features these fixtures change.
const RETAINED_WOODLAND = "H002";
const RETAINED_POND = "H029";
const RETAINED_MARGIN = "H034";
const RETAINED_LAST_WOODLAND = "H050";
const ENHANCED_GRASSLAND = "H001";
const ENHANCED_GREEN_ROOF = "H006";
const CREATED_ALLOTMENTS = "H005";
const RETAINED_HEDGEROW = "HG001";
const ENHANCED_HEDGEROW = "HG002";
const CREATED_HEDGEROW = "HG009";
const CREATED_GOOD_HEDGEROW = "HG015";
const LOST_HEDGEROW = "HG004";
const LOST_DITCH = "R002";
const CREATED_CULVERT = "R003";
const CREATED_DITCH = "R004";
const ENHANCED_CANAL = "R006";
const RETAINED_DITCH = "R007";
const ENHANCED_TREE = "T013";
const ENHANCED_GREEN_WALL = "V002";
// The Low Intensive orchards parcel in the baseline of
// attribute-problems/distinctiveness-out-of-scope.gpkg.
const LOW_ORCHARD = "H004";
// The default site's baseline watercourses, and every post-intervention one
// but the Created ditch the watercourses-only file keeps.
const BASELINE_WATERCOURSES = [
  "R001",
  LOST_DITCH,
  CREATED_DITCH,
  "R005",
  ENHANCED_CANAL,
  RETAINED_DITCH,
];
const WATERCOURSES_DROPPED = [
  "R001",
  CREATED_CULVERT,
  "R005",
  ENHANCED_CANAL,
  RETAINED_DITCH,
];
const RED_LINE_FID = 1;

// The Habitat Refs the long-refs files give the Retained area habitats: one
// long ASCII ref, one long ref with letters outside ASCII, one padded with
// spaces, and one at the 99-character limit.
const SHORT_TEXT_LIMIT = 99;
const LONG_REF = "WOODLAND-NORTH-EDGE";
const NON_ASCII_REF = "Étang-du-Moulin-Ælfrīc";
const PADDED_REF = `   ${RETAINED_MARGIN}   `;
const LIMIT_REF_STEM = `${RETAINED_LAST_WOODLAND}-`;
const LIMIT_REF = LIMIT_REF_STEM.padEnd(SHORT_TEXT_LIMIT, "x");
const RENAMED_REFS = [
  [RETAINED_WOODLAND, LONG_REF],
  [RETAINED_POND, NON_ASCII_REF],
  [RETAINED_MARGIN, PADDED_REF],
  [RETAINED_LAST_WOODLAND, LIMIT_REF],
];

// A comment past the 999-character limit, and one holding U+FFFD, the
// character a file's bad bytes read as.
const LONG_TEXT_LIMIT = 999;
const COMMENT_OVER_LIMIT = "Allotment plots on the old paddock. "
  .repeat(32)
  .trim();
const COMMENT_INVALID = "Allotment plots on the old \uFFFD paddock";

// Proposed encroachment better than the Enhanced canal's baseline (Major,
// Moderate/ Minor), so a page shows which side it reads.
const ENCROACHMENT_REDUCED = {
  "Proposed Encroachment into Watercourse": "Minor",
  "Proposed Encroachment into riparian zone":
    "No Encroachment/ No Encroachment",
};

const NO_CONDITION_OR_TIMING = {
  "Proposed Condition": null,
  [ADVANCE_YEARS]: null,
  [DELAY_YEARS]: null,
};

// Both years given on a Created and an Enhanced feature on each linear layer
// and the area layer.
const BOTH_YEARS = { [ADVANCE_YEARS]: "2", [DELAY_YEARS]: "3" };

// Lowland meadows, a Very High distinctiveness grassland the service leaves
// out of its scope.
const OUT_OF_SCOPE_MEADOW = {
  "Proposed Broad Habitat Type": "Grassland",
  "Proposed Habitat Type": "Lowland meadows",
  "Proposed Distinctiveness": "V.High",
};

const UNLINKED_BASELINE_WATERCOURSE = {
  [PARENT_REF]: null,
  parent_uuid: null,
  parent_geom: null,
  "Baseline River Type": null,
  "Baseline Distinctiveness": null,
  [BASELINE_CONDITION]: null,
  "Baseline Strategic Significance": null,
  "Baseline Encroachment into Watercourse": null,
  [BASELINE_RIPARIAN]: null,
  "Baseline Length": null,
};

const byRef = (ref) => ({ [HABITAT_REF]: ref });

/** Rename a baseline habitat and, where `bothStages`, its Retained child. */
function renameEdits(table, ref, newRef, bothStages) {
  const edits = [
    setValues(`${table} Baseline`, { [HABITAT_REF]: newRef }, byRef(ref)),
  ];
  if (bothStages) {
    edits.push(
      setValues(
        `${table} Post-Intervention`,
        { [HABITAT_REF]: newRef, [PARENT_REF]: newRef },
        { ...byRef(ref), [RETENTION]: "Retained" },
      ),
    );
  }
  return edits;
}

const renamedRefEdits = (bothStages) =>
  RENAMED_REFS.flatMap(([ref, newRef]) =>
    renameEdits(AREA_LAYER, ref, newRef, bothStages),
  );

/** Blank a baseline value on a feature, and on its Retained child too. */
function blankBaselineEdits(layer, ref, column, bothStages) {
  const edits = [
    setValues(`${layer} Baseline`, { [column]: null }, byRef(ref)),
  ];
  if (bothStages) {
    edits.push(
      setValues(`${layer} Post-Intervention`, { [column]: null }, byRef(ref)),
    );
  }
  return edits;
}

const incompleteBaselineEdits = (bothStages) => [
  ...blankBaselineEdits(
    AREA_LAYER,
    RETAINED_WOODLAND,
    BASELINE_CONDITION,
    bothStages,
  ),
  ...blankBaselineEdits(
    "Hedgerows",
    RETAINED_HEDGEROW,
    BASELINE_CONDITION,
    bothStages,
  ),
  ...blankBaselineEdits(
    "Watercourses",
    RETAINED_DITCH,
    BASELINE_RIPARIAN,
    bothStages,
  ),
];

const RENAMED_LIST = `${RETAINED_WOODLAND} \`${LONG_REF}\` (${LONG_REF.length} characters), ${RETAINED_POND} \`${NON_ASCII_REF}\` (letters outside ASCII), ${RETAINED_MARGIN} padded with three spaces each side, and ${RETAINED_LAST_WOODLAND} a ${SHORT_TEXT_LIMIT}-character ref, the limit`;
const INCOMPLETE_LIST = `${RETAINED_WOODLAND}'s ${BASELINE_CONDITION}, ${RETAINED_HEDGEROW}'s ${BASELINE_CONDITION} and ${RETAINED_DITCH}'s ${BASELINE_RIPARIAN} left blank`;

/** Files the service accepts, every feature Complete. */
function validRecipes({ derived, derivedFrom, accepted }) {
  return [
    derived(
      "valid/long-and-padded-refs.gpkg",
      `\`valid/default-site.gpkg\` with four Retained area habitats renamed in both stages: ${RENAMED_LIST}. The service trims the padded ref and keeps the others whole`,
      renamedRefEdits(true),
      accepted,
    ),
    derivedFrom(
      BASELINE_STAGE_BASE,
      "valid/long-and-padded-refs-baseline.gpkg",
      `\`${BASELINE_STAGE_BASE}\` with the same four area habitats renamed: ${RENAMED_LIST}`,
      renamedRefEdits(false),
      accepted,
    ),
    derived(
      "valid/watercourses-created-only.gpkg",
      `\`valid/default-site.gpkg\` with no baseline watercourses and one post-intervention one: ${CREATED_DITCH}, a ditch Created with no parent. Watercourse units are gained from a zero baseline`,
      [
        ...BASELINE_WATERCOURSES.map((ref) =>
          deleteRows(WATERCOURSES_BASELINE, byRef(ref)),
        ),
        ...WATERCOURSES_DROPPED.map((ref) =>
          deleteRows(WATERCOURSES_POST, byRef(ref)),
        ),
        setValues(
          WATERCOURSES_POST,
          UNLINKED_BASELINE_WATERCOURSE,
          byRef(CREATED_DITCH),
        ),
      ],
      accepted,
    ),
    derived(
      "valid/watercourse-enhanced-encroachment-reduced.gpkg",
      `\`valid/default-site.gpkg\` with the Enhanced ${ENHANCED_CANAL}'s proposed encroachment reduced from its baseline (Major, Moderate/ Minor) to Minor and No Encroachment/ No Encroachment`,
      [
        setValues(
          WATERCOURSES_POST,
          ENCROACHMENT_REDUCED,
          byRef(ENHANCED_CANAL),
        ),
      ],
      accepted,
    ),
  ];
}

/** Files the service accepts, saving some features Incomplete. */
function incompleteRecipes({ derived, derivedFrom }) {
  return [
    derivedFrom(
      BASELINE_STAGE_BASE,
      "incomplete/baseline-incomplete-every-layer-baseline.gpkg",
      `\`${BASELINE_STAGE_BASE}\` with one habitat on each layer missing a value its units need: ${INCOMPLETE_LIST}. Saved Incomplete at a baseline upload`,
      incompleteBaselineEdits(false),
      "saved as Incomplete: the three habitats, at no units",
    ),
    derived(
      "incomplete/watercourse-proposed-encroachment-blank.gpkg",
      `\`valid/default-site.gpkg\` with the Enhanced ${ENHANCED_CANAL}'s Proposed Encroachment into Watercourse and the Created ${CREATED_DITCH}'s Proposed Encroachment into riparian zone left blank`,
      [
        setValues(
          WATERCOURSES_POST,
          { "Proposed Encroachment into Watercourse": null },
          byRef(ENHANCED_CANAL),
        ),
        setValues(
          WATERCOURSES_POST,
          { "Proposed Encroachment into riparian zone": null },
          byRef(CREATED_DITCH),
        ),
      ],
      "saved as Incomplete: both watercourses",
    ),
    derived(
      "incomplete/hedgerow-created-no-condition-or-timing.gpkg",
      `\`valid/default-site.gpkg\` with ${CREATED_GOOD_HEDGEROW}, a Created hedgerow, given no Proposed Condition, years created in advance or delay: the hedgerow twin of \`incomplete/area-created-no-condition-or-timing.gpkg\``,
      [
        setValues(
          HEDGEROWS_POST,
          NO_CONDITION_OR_TIMING,
          byRef(CREATED_GOOD_HEDGEROW),
        ),
      ],
      "saved as Incomplete: the hedgerow, with no target condition to price it at",
    ),
    derived(
      "incomplete/advance-delay-both-set-every-layer.gpkg",
      `\`valid/default-site.gpkg\` with both years created in advance (2) and delay (3) set on a Created and an Enhanced feature on each layer: area habitats ${CREATED_ALLOTMENTS} and ${ENHANCED_GRASSLAND}, hedgerows ${CREATED_HEDGEROW} and ${ENHANCED_HEDGEROW}, watercourses ${CREATED_CULVERT} and ${ENHANCED_CANAL}`,
      [
        [AREA_POST, CREATED_ALLOTMENTS],
        [AREA_POST, ENHANCED_GRASSLAND],
        [HEDGEROWS_POST, CREATED_HEDGEROW],
        [HEDGEROWS_POST, ENHANCED_HEDGEROW],
        [WATERCOURSES_POST, CREATED_CULVERT],
        [WATERCOURSES_POST, ENHANCED_CANAL],
      ].map(([table, ref]) => setValues(table, BOTH_YEARS, byRef(ref))),
      "saved as Incomplete: the six features, as the service takes one of the two years, not both",
    ),
  ];
}

// An Enhanced feature on each post-intervention layer, given no Proposed
// Strategic Significance: the one value its units then lack, as every other
// proposed value stays.
const SIGNIFICANCE_BLANK = [
  ["area", AREA_POST, ENHANCED_GREEN_ROOF, "area habitat"],
  [
    "vertical-area",
    VERTICAL_POST,
    ENHANCED_GREEN_WALL,
    "vertical area habitat",
  ],
  ["hedgerow", HEDGEROWS_POST, ENHANCED_HEDGEROW, "hedgerow"],
  ["watercourse", WATERCOURSES_POST, ENHANCED_CANAL, "watercourse"],
  ["tree", TREES_POST, ENHANCED_TREE, "tree"],
];

/** Files the service saves Incomplete for want of a proposed significance. */
function significanceBlankRecipes({ derived }) {
  return SIGNIFICANCE_BLANK.map(([name, table, ref, feature]) =>
    derived(
      `incomplete/${name}-enhanced-significance-blank.gpkg`,
      `\`valid/default-site.gpkg\` with the Enhanced ${ref}'s Proposed Strategic Significance left blank`,
      [
        setValues(
          table,
          { "Proposed Strategic Significance": null },
          byRef(ref),
        ),
      ],
      `saved as Incomplete: the ${feature}`,
    ),
  );
}

/** Files the service refuses for a Habitat Ref or a Comment. */
function textRefusalRecipes({ derived, derivedFrom }) {
  return [
    derivedFrom(
      "attribute-problems/missing-habitat-ref.gpkg",
      "attribute-problems/missing-habitat-ref-every-layer.gpkg",
      `\`attribute-problems/missing-habitat-ref.gpkg\` with the Habitat Ref also left blank on the lost hedgerow ${LOST_HEDGEROW} and the lost ditch ${LOST_DITCH}: a habitat with no reference on three layers`,
      [
        setValues(
          HEDGEROWS_BASELINE,
          { [HABITAT_REF]: null },
          byRef(LOST_HEDGEROW),
        ),
        setValues(
          WATERCOURSES_BASELINE,
          { [HABITAT_REF]: null },
          byRef(LOST_DITCH),
        ),
      ],
      "HABITAT_REF_MISSING",
    ),
    derivedFrom(
      "attribute-problems/missing-habitat-ref.gpkg",
      "attribute-problems/missing-habitat-ref-and-comment-invalid.gpkg",
      `\`attribute-problems/missing-habitat-ref.gpkg\` with the Created ${CREATED_ALLOTMENTS}'s Comment also holding U+FFFD: two problems the same checks find, one of them a habitat with no reference`,
      [
        setValues(
          AREA_POST,
          { [COMMENT]: COMMENT_INVALID },
          byRef(CREATED_ALLOTMENTS),
        ),
      ],
      "HABITAT_REF_MISSING",
    ),
    derivedFrom(
      "attribute-problems/distinctiveness-out-of-scope.gpkg",
      "attribute-problems/distinctiveness-out-of-scope-and-comment-invalid.gpkg",
      `\`attribute-problems/distinctiveness-out-of-scope.gpkg\` with the baseline ${LOW_ORCHARD}'s Comment also holding U+FFFD: a second problem, so the out-of-scope habitats are listed with the others, under the distinctiveness bands the service allows`,
      [
        setValues(
          AREA_BASELINE,
          { [COMMENT]: COMMENT_INVALID },
          byRef(LOW_ORCHARD),
        ),
      ],
      "HABITAT_DISTINCTIVENESS_NOT_IN_SCOPE",
    ),
    derived(
      "attribute-problems/comment-too-long.gpkg",
      `\`valid/default-site.gpkg\` with the Created ${CREATED_ALLOTMENTS}'s Comment ${COMMENT_OVER_LIMIT.length} characters long, past the ${LONG_TEXT_LIMIT}-character limit`,
      [
        setValues(
          AREA_POST,
          { [COMMENT]: COMMENT_OVER_LIMIT },
          byRef(CREATED_ALLOTMENTS),
        ),
      ],
      "TEXT_TOO_LONG",
    ),
    derived(
      "attribute-problems/comment-invalid-characters.gpkg",
      `\`valid/default-site.gpkg\` with the Created ${CREATED_ALLOTMENTS}'s Comment holding U+FFFD, the character bytes that are not valid UTF-8 read as`,
      [
        setValues(
          AREA_POST,
          { [COMMENT]: COMMENT_INVALID },
          byRef(CREATED_ALLOTMENTS),
        ),
      ],
      "COMMENT_INVALID_CHARACTERS",
    ),
  ];
}

/** Files the service refuses for a missing or second red line boundary, an out-of-scope habitat or an incomplete baseline. */
function otherRefusalRecipes({ derived, derivedFrom }) {
  return [
    derivedFrom(
      BASELINE_STAGE_BASE,
      "spatial-problems/redline-missing-baseline.gpkg",
      `\`${BASELINE_STAGE_BASE}\` with its \`${RED_LINE}\` row deleted: the layer is present and empty`,
      [deleteRows(RED_LINE, { fid: RED_LINE_FID })],
      "NO_REDLINE",
    ),
    derivedFrom(
      BASELINE_STAGE_BASE,
      "spatial-problems/redline-multiple-baseline.gpkg",
      `\`${BASELINE_STAGE_BASE}\` with its \`${RED_LINE}\` row copied: the layer holds two boundaries, where the template has one`,
      [copyRow(RED_LINE, { fid: RED_LINE_FID })],
      "GPKG_RLB_TOO_MANY_POLYGONS",
    ),
    derived(
      "attribute-problems/distinctiveness-post-intervention-only.gpkg",
      `\`valid/default-site.gpkg\` with the Created ${CREATED_ALLOTMENTS} made Lowland meadows, a Very High distinctiveness grassland, in its post-intervention row only`,
      [setValues(AREA_POST, OUT_OF_SCOPE_MEADOW, byRef(CREATED_ALLOTMENTS))],
      "HABITAT_DISTINCTIVENESS_NOT_IN_SCOPE",
    ),
    derived(
      "attribute-problems/baseline-area-incomplete.gpkg",
      `\`valid/default-site.gpkg\` with the Retained ${RETAINED_WOODLAND}'s ${BASELINE_CONDITION} left blank in both stages: accepted at a baseline upload, refused at a baseline + post-intervention one`,
      blankBaselineEdits(
        AREA_LAYER,
        RETAINED_WOODLAND,
        BASELINE_CONDITION,
        true,
      ),
      "BASELINE_HABITATS_INCOMPLETE",
    ),
    derived(
      "attribute-problems/baseline-incomplete-every-layer.gpkg",
      `\`valid/default-site.gpkg\` with ${INCOMPLETE_LIST}, in both stages: refused at a baseline + post-intervention upload, without naming one`,
      incompleteBaselineEdits(true),
      "BASELINE_HABITATS_INCOMPLETE",
    ),
  ];
}

/**
 * The edge-case recipes, each built with recipes.mjs's `derived` (from
 * `valid/default-site.gpkg`) or `derivedFrom` (from another generated file);
 * `accepted` is the accepted outcome. All are passed in rather than imported,
 * as recipes.mjs imports this module.
 */
export function edgeCaseRecipes(builders) {
  return [
    ...validRecipes(builders),
    ...incompleteRecipes(builders),
    ...significanceBlankRecipes(builders),
    ...textRefusalRecipes(builders),
    ...otherRefusalRecipes(builders),
  ];
}
