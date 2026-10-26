/**
 * The recipes for the curated BNG Service template corpus in
 * example-files/service-template/ (BMD-1081): one entry per fixture, each with
 * a fixed file name and the one way it is built, so the whole corpus
 * regenerates to the same bytes.
 *
 * A recipe is one of:
 *   - generated: drawn by bng-library from a seed, with flaws and options;
 *   - derived:   another recipe's file, changed by the SQL edits listed
 *                (see derive.mjs), for schema faults no generator writes;
 *   - copied:    a file already in the harness, copied as it is;
 *   - converted: a legacy BNG500 pair, converted by the template's own
 *                converter (see convert.mjs).
 *
 * The scenario corpus in service-template/permutations/ is built by
 * generate:scenarios, not from here.
 */

import { FORMAT_BNG_SERVICE, STAGE_BASELINE, listFlaws } from "#bng-lib";
import {
  addGeometryColumn,
  dropColumns,
  dropGeometryColumn,
  dropStage,
  dropTable,
  renameColumns,
  retypeColumns,
  setGeometryType,
  setSrs,
} from "./derive.mjs";

export const KIND_GENERATED = "generated";
export const KIND_DERIVED = "derived";
export const KIND_COPIED = "copied";
export const KIND_CONVERTED = "converted";

export const ACCEPTED = "accepted";
const SCHEMA_REFUSED =
  "refused: the file does not match the BNG Service template's schema";

// The seed every fixture uses unless it needs another site.
const SEED = 1;
const SMALL_SITE = 3;
const LARGE_SITE = 150;
// The legacy duplicate-habitat-ref fixture's size, kept.
const DUPLICATE_REF_SITE = 5;

// The file the invalid-schema fixtures are derived from.
const VALID_BASE = "valid/default-site.gpkg";

/** The families, in the order the README lists them. */
export const FAMILIES = [
  {
    dir: "valid",
    covers:
      "Valid files, combined and baseline-stage: each should upload cleanly",
  },
  {
    dir: "spatial-problems",
    covers:
      "Valid schema, invalid geometry: each trips one geometry validator. Baseline-stage files, as the legacy family's are, so a broken parcel does not also break its post-intervention lineage",
  },
  {
    dir: "invalid-schema",
    covers:
      "Wrong table or column shape, derived from `valid/default-site.gpkg` by SQL: trips schema comparison before any geometry check. Also a legacy-layout file",
  },
  {
    dir: "empty-layer",
    covers: "Valid schema, a feature layer present but with no rows",
  },
  {
    dir: "attribute-problems",
    covers:
      "Valid schema and geometry: an attribute value trips a later validator, or a habitat that gets worse breaks a rule the service refuses",
  },
  {
    dir: "lineage-problems",
    covers:
      "A post-intervention feature names its baseline parent wrongly. `npm run check:lineage` reports each file's own flaw, named in its file name",
  },
  {
    dir: "incomplete",
    covers:
      "A watercourse that gets worse is recorded in a way the service saves as Incomplete rather than refuses",
  },
  {
    dir: "version-problems",
    covers: "The template version record is missing, doubled or unsupported",
  },
  {
    dir: "bng-500",
    covers:
      "The legacy `bng-500/` pairs, built from real Defra metric workbooks, converted by the BNG Service template's own converter (`old_to_new.py`, bng-metric-template) as a user converts a legacy file. They are what the converter writes, before the manual steps it leaves to the user (its warnings), so each still holds values the template does not offer; the recipes list them, and the tests pin them",
  },
  { dir: "malformed", covers: "Not a GeoPackage at all" },
  {
    dir: "filename-problems",
    covers: "A valid file; only the upload's own file name is invalid",
  },
];

const flawsByName = new Map(
  listFlaws({ format: FORMAT_BNG_SERVICE }).map((flaw) => [flaw.name, flaw]),
);

function flawInfo(name) {
  const flaw = flawsByName.get(name);
  if (!flaw) {
    throw new Error(`bng-library has no BNG Service flaw "${name}"`);
  }
  return flaw;
}

const IRREPLACEABLE_NOT_CHECKED =
  "Accepted today: the service does not check irreplaceable habitats yet";

const DEGRADE_NOT_CHECKED =
  "Accepted today: the service does not check habitats that get worse yet";

/**
 * The outcome BMD-1081 asks for, where the service does not give it yet.
 * bng-library's note on these flaws describes today's behaviour, which reads
 * as the expectation in a README, so each says both.
 */
const NOT_ENFORCED_YET = {
  "lineage-parent-geom-missing":
    "refused. Accepted today: the service skips the shape check on a linked row with no parent_geom",
  "degrade-watercourse-advance-not-encroachment": `saved as Incomplete. ${DEGRADE_NOT_CHECKED}`,
  "degrade-watercourse-encroachment-no-advance": `saved as Incomplete. ${DEGRADE_NOT_CHECKED}`,
};

/**
 * The code the backend refuses these flaws with, where bng-library records
 * none for them yet (its NO_BACKEND_CODE_YET). The backend gives them with the
 * service-template flag on, as it does every BNG Service template outcome here.
 * Used only while the library has its placeholder, so once a repin brings the
 * library's own code, that code wins and these entries can be deleted.
 */
const BACKEND_CODES = {
  "version-record-missing": "TEMPLATE_VERSION_MISSING",
  "version-record-duplicated": "TEMPLATE_VERSION_DUPLICATED",
  "version-unsupported": "TEMPLATE_VERSION_UNSUPPORTED",
};

/** A backend error code, such as TEMPLATE_VERSION_MISSING, not a placeholder. */
const BACKEND_CODE = /^[A-Z][A-Z0-9_]*$/;

/**
 * What the service does with a file carrying the named flaw: the outcome asked
 * for where it is not enforced yet, else the library's code, else ours.
 */
function expectedForFlaw(name, flaw) {
  if (NOT_ENFORCED_YET[name]) {
    return NOT_ENFORCED_YET[name];
  }
  if (BACKEND_CODE.test(flaw.errorCode)) {
    return flaw.errorCode;
  }
  return BACKEND_CODES[name] ?? flaw.errorCode;
}

/**
 * A file bng-library draws. It marks no feature irreplaceable unless the
 * recipe asks: the service refuses an irreplaceable habitat (BMD-1176,
 * BMD-1172), so a file that should trip one check, or none, holds none.
 */
function generated(path, covers, expected, options) {
  return {
    path,
    kind: KIND_GENERATED,
    covers,
    expected,
    options: { irreplaceableLayers: [], ...options },
  };
}

/**
 * A file that carries one flaw, named for it, expecting the flaw's error, or
 * the outcome asked for where the service does not enforce it yet.
 */
function flawFixture(dir, name, options = {}) {
  const flaw = flawInfo(name);
  const suffix = options.stage === STAGE_BASELINE ? "-baseline" : "";
  return generated(
    `${dir}/${name}${suffix}.gpkg`,
    flaw.description,
    expectedForFlaw(name, flaw),
    { seed: SEED, flaws: [name], ...options },
  );
}

function derived(path, covers, edits) {
  return {
    path,
    kind: KIND_DERIVED,
    covers,
    expected: SCHEMA_REFUSED,
    from: VALID_BASE,
    edits,
  };
}

const VALID = [
  generated(
    VALID_BASE,
    "The default site, holding both stages and every feature only the new template records: vertical area habitats, comments, an Enhanced tree, habitats that get worse on each layer, a re-meandered and a shorter watercourse, Habitat Refs that repeat, and a habitat on each layer delayed by 30+ years. It marks nothing irreplaceable, as the service refuses an irreplaceable habitat (see `attribute-problems/irreplaceable-*.gpkg`)",
    ACCEPTED,
    { seed: SEED },
  ),
  generated(
    "valid/default-site-baseline.gpkg",
    "The default site's baseline-stage file: the post-intervention tables are present and empty",
    ACCEPTED,
    { seed: SEED, stage: STAGE_BASELINE },
  ),
  generated(
    "valid/plain-site.gpkg",
    "The default site without the template-only features: what the legacy generator draws, in the new format",
    ACCEPTED,
    { seed: SEED, templateFeatures: false },
  ),
  generated(
    "valid/small-site.gpkg",
    `A ${SMALL_SITE}-parcel site, holding both stages`,
    ACCEPTED,
    { seed: 2, numParcels: SMALL_SITE },
  ),
  generated(
    "valid/small-site-baseline.gpkg",
    "The small site's baseline-stage file",
    ACCEPTED,
    { seed: 2, numParcels: SMALL_SITE, stage: STAGE_BASELINE },
  ),
  generated(
    "valid/large-site.gpkg",
    `A ${LARGE_SITE}-parcel site, holding both stages`,
    ACCEPTED,
    { seed: 3, numParcels: LARGE_SITE },
  ),
  generated(
    "valid/large-site-baseline.gpkg",
    "The large site's baseline-stage file",
    ACCEPTED,
    { seed: 3, numParcels: LARGE_SITE, stage: STAGE_BASELINE },
  ),
  {
    ...flawFixture("valid", "duplicate-habitat-ref", {
      numParcels: DUPLICATE_REF_SITE,
    }),
    covers: "Two habitat parcels share one Habitat Ref",
    expected: `${ACCEPTED} since BMD-1058, which lets habitats share a reference`,
  },
  {
    ...flawFixture("valid", "tiny-gap"),
    expected: `${ACCEPTED}: the gap is below the AREA_SUM_MISMATCH tolerance`,
  },
];

const SPATIAL = [
  "self-intersecting-redline",
  "bowtie-parcel",
  "overlapping-parcels",
  "parcel-outside-redline",
  "parcel-too-small",
  "hedgerow-outside",
  "watercourse-outside",
  "tree-outside",
  "iggi-outside",
  "area-sum-mismatch",
  "redline-not-in-england",
  "redline-too-large",
].map((name) =>
  flawFixture("spatial-problems", name, { stage: STAGE_BASELINE }),
);

const AREA_BASELINE = "Area Habitats Baseline";
const HEDGEROWS_BASELINE = "Hedgerows Baseline";
const WATERCOURSES_BASELINE = "Watercourses Baseline";
const RED_LINE = "Red Line Boundary";
const BASELINE_CONDITION = "Baseline Condition";
const WGS84 = 4326;

const INVALID_SCHEMA = [
  derived(
    "invalid-schema/no-area-habitats-baseline-table.gpkg",
    `The \`${AREA_BASELINE}\` table is absent (contrast \`empty-layer/no-habitats.gpkg\`, where it is present but empty)`,
    [dropTable(AREA_BASELINE)],
  ),
  derived(
    "invalid-schema/no-post-intervention-tables.gpkg",
    "Every Post-Intervention table is absent: a baseline-stage file keeps them, empty",
    [dropStage("Post-Intervention")],
  ),
  derived(
    "invalid-schema/missing-columns-in-area-habitats.gpkg",
    `\`${AREA_BASELINE}\` has no \`Baseline Condition\` or \`Area\` column`,
    [dropColumns(AREA_BASELINE, [BASELINE_CONDITION, "Area"])],
  ),
  derived(
    "invalid-schema/wrong-column-names-in-area-habitats.gpkg",
    `\`${AREA_BASELINE}\` names \`Baseline Habitat Type\` as \`Habitat Type\`, and \`Baseline Condition\` as \`Condition\``,
    [
      renameColumns(AREA_BASELINE, {
        "Baseline Habitat Type": "Habitat Type",
        [BASELINE_CONDITION]: "Condition",
      }),
    ],
  ),
  derived(
    "invalid-schema/wrong-column-data-types-in-area-habitats.gpkg",
    `\`${AREA_BASELINE}\` declares \`Area\` as TEXT and \`Habitat Ref\` as INTEGER`,
    [retypeColumns(AREA_BASELINE, { Area: "TEXT", "Habitat Ref": "INTEGER" })],
  ),
  derived(
    "invalid-schema/wrong-geometry-type-in-area-habitats.gpkg",
    `\`${AREA_BASELINE}\` declares its geometry LINESTRING; the template's is POLYGON`,
    [setGeometryType(AREA_BASELINE, "LINESTRING")],
  ),
  derived(
    "invalid-schema/wrong-geometry-type-in-hedgerows.gpkg",
    `\`${HEDGEROWS_BASELINE}\` declares its geometry POLYGON; the template's is LINESTRING`,
    [setGeometryType(HEDGEROWS_BASELINE, "POLYGON")],
  ),
  derived(
    "invalid-schema/wrong-geometry-type-in-watercourses.gpkg",
    `\`${WATERCOURSES_BASELINE}\` declares its geometry POLYGON; the template's is LINESTRING`,
    [setGeometryType(WATERCOURSES_BASELINE, "POLYGON")],
  ),
  derived(
    "invalid-schema/wrong-geometry-type-in-red-line-boundary.gpkg",
    `\`${RED_LINE}\` declares its geometry POINT; the template's is POLYGON`,
    [setGeometryType(RED_LINE, "POINT")],
  ),
  derived(
    "invalid-schema/red-line-boundary-wrong-spatial-reference.gpkg",
    `\`${RED_LINE}\` is registered in WGS 84 (srs_id ${WGS84}) rather than British National Grid (27700); its coordinates are unchanged`,
    [setSrs(RED_LINE, WGS84)],
  ),
  derived(
    "invalid-schema/wrong-geometry-column-name-in-red-line-boundary.gpkg",
    `\`${RED_LINE}\`'s geometry column is named \`geometry\`; the template's is \`geom\``,
    [renameColumns(RED_LINE, { geom: "geometry" })],
  ),
  derived(
    "invalid-schema/no-geometry-column-in-red-line-boundary.gpkg",
    `\`${RED_LINE}\` has no geometry column`,
    [dropGeometryColumn(RED_LINE)],
  ),
  derived(
    "invalid-schema/multiple-geometry-columns-in-red-line-boundary.gpkg",
    `\`${RED_LINE}\` registers a second, empty geometry column, \`geom2\``,
    [addGeometryColumn(RED_LINE, "geom2", "POLYGON")],
  ),
  {
    path: "invalid-schema/legacy-template.gpkg",
    kind: KIND_COPIED,
    covers:
      "A valid file in the legacy (Natural England) template, uploaded where the BNG Service template is expected",
    expected: `${SCHEMA_REFUSED} (a legacy file, accepted with the service-template flag off)`,
    source: "example-files/valid/Baseline - complete with area refs.gpkg",
  },
];

const EMPTY_LAYER = [
  "no-habitats",
  "no-hedgerows",
  "no-rivers",
  "no-trees",
].map((name) => flawFixture("empty-layer", name));

const ATTRIBUTE = [
  "distinctiveness-out-of-scope",
  "missing-habitat-ref",
  "habitat-ref-invalid-characters",
  "advance-delay-both-set",
  "degrade-advance-missing",
  "degrade-not-worse",
  "degrade-watercourse-retained-and-created",
  "degrade-habitat-ref-blank",
].map((name) => flawFixture("attribute-problems", name));

const IRREPLACEABLE = [
  generated(
    "attribute-problems/irreplaceable-area-habitat.gpkg",
    "`valid/default-site.gpkg` with its woodland parcel marked irreplaceable (Irreplaceable Habitat `Yes`) in both stages",
    `refused (BMD-1176). ${IRREPLACEABLE_NOT_CHECKED}`,
    { seed: SEED, irreplaceableLayers: ["habitats"] },
  ),
  generated(
    "attribute-problems/irreplaceable-tree.gpkg",
    "`valid/default-site.gpkg` with one Retained tree marked irreplaceable (a veteran tree) in both stages",
    `refused (BMD-1172). ${IRREPLACEABLE_NOT_CHECKED}`,
    { seed: SEED, irreplaceableLayers: ["trees"] },
  ),
];

const LINEAGE = [
  "lineage-parent-missing",
  "lineage-parent-unknown",
  "lineage-parent-wrong",
  "lineage-parent-geom-mismatch",
  "lineage-parent-geom-missing",
].map((name) => flawFixture("lineage-problems", name));

const INCOMPLETE = [
  "degrade-watercourse-advance-not-encroachment",
  "degrade-watercourse-encroachment-no-advance",
].map((name) => flawFixture("incomplete", name));

const VERSION = [
  "version-record-missing",
  "version-record-duplicated",
  "version-unsupported",
].map((name) => flawFixture("version-problems", name));

/**
 * A legacy BNG500 pair, converted. `knownIssues` is what the lineage and
 * template-value checks report on the converted file: the converter leaves
 * an unprovable parent link for the service to infer, and copies values the
 * template does not offer for the user to fix.
 */
function converted(site, knownIssues) {
  return {
    path: `bng-500/${site}.gpkg`,
    kind: KIND_CONVERTED,
    covers: `\`${site}\`, converted`,
    expected:
      "not ready to upload as it stands: the converter's manual steps (its warnings) are still to do",
    baseline: `example-files/bng-500/${site}-baseline.gpkg`,
    postIntervention: `example-files/bng-500/${site}-post-intervention.gpkg`,
    seed: SEED,
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
const AREA_ADVANCE = "Habitat created in advance/years";
// Values the BNG500 files' trees carry that the template's lists do not.
const TREE_VALUES = [
  "Baseline Tree Size",
  "Category",
  "Proposed Rural or Urban Tree",
  "Proposed Tree Size",
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

const BNG500 = [
  converted("BROADLAND_2024_3282", {
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
  converted("BarkingandDagenham2400625FULL", {
    lineage: ["lineage-parent-missing"],
    templateValues: {
      [TREES_POST]: [...TREE_VALUES, PROPOSED_SIGNIFICANCE],
      [WATERCOURSES_POST]: WATERCOURSE_ENCROACHMENT,
    },
  }),
  converted("CAMBRIDGE_24_03964_FUL", {
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
  converted("Sunderland_24_00723_FU4", {
    templateValues: {
      [AREA_BASELINE]: ["Baseline Habitat Type"],
      [AREA_POST]: [AREA_ADVANCE],
      "Hedgerows Post-Intervention": [AREA_ADVANCE],
      [TREES_BASELINE]: TREE_BASELINE_VALUES,
      [TREES_POST]: [
        ...TREE_VALUES,
        "Habitat Created/Enhanced in advance/years",
      ],
      [WATERCOURSES_POST]: RIPARIAN_ENCROACHMENT,
    },
  }),
  converted("Wiltshire_PL_2024_08441", {
    templateValues: { [WATERCOURSES_POST]: WATERCOURSE_ENCROACHMENT },
  }),
];

const MALFORMED = [
  {
    path: "malformed/not-a-geopackage.gpkg",
    kind: KIND_COPIED,
    covers: "A text file with a `.gpkg` extension: not a GeoPackage at all",
    expected: "refused: the file cannot be read as a GeoPackage",
    source: "example-files/malformed/Not a valid geopackage.gpkg",
  },
];

const FILENAME = [
  {
    path: "filename-problems/default site [invalid chars].gpkg",
    kind: KIND_DERIVED,
    covers:
      "`valid/default-site.gpkg` byte for byte; the brackets are invalid in an uploaded file name",
    expected:
      "refused: the file name has characters `SAFE_FILENAME_RE` forbids",
    from: VALID_BASE,
    edits: [],
  },
];

export const RECIPES = [
  ...VALID,
  ...SPATIAL,
  ...INVALID_SCHEMA,
  ...EMPTY_LAYER,
  ...ATTRIBUTE,
  ...IRREPLACEABLE,
  ...LINEAGE,
  ...INCOMPLETE,
  ...VERSION,
  ...BNG500,
  ...MALFORMED,
  ...FILENAME,
];

/**
 * What the corpus cannot hold yet, listed in its README so the gap is
 * visible rather than silent.
 */
export const GAPS = [
  "A natural river left out, and an irreplaceable tree that gets worse: the service refuses either file for another reason first, so a fixture could not show the rule. Natural rivers (Other rivers and streams, High; Priority habitat, V.High) are out of the service's scope, and only canals and ditches may be lost (a culvert left out is refused, STAGED_NATURAL_WATERCOURSE_LOST); an irreplaceable tree is refused whether or not it gets worse (`attribute-problems/irreplaceable-tree.gpkg`).",
  "Individual trees with varied counts: the template has no Count column, and how several trees are recorded is undecided (BMD-1171, BMD-1172).",
  "The harness's import-timing scenarios: they edit legacy files, so `permutations/` builds them in the legacy format only.",
];

/** The recipe that builds `recipePath`. */
export function recipeFor(recipePath) {
  const recipe = RECIPES.find((r) => r.path === recipePath);
  if (!recipe) {
    throw new Error(`no recipe builds ${recipePath}`);
  }
  return recipe;
}
