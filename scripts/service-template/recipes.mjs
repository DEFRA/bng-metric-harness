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

const DEGRADE_NOT_CHECKED =
  "Accepted today: the service does not check habitats that get worse yet";
const VERSION_NOT_CHECKED =
  "Accepted today: the service does not check the version record yet";

/**
 * The outcome BMD-1081 asks for, where the service does not give it yet.
 * bng-library's note on these flaws describes today's behaviour, which reads
 * as the expectation in a README, so each says both.
 */
const NOT_ENFORCED_YET = {
  "lineage-parent-geom-missing":
    "refused. Accepted today: the service skips the shape check on a linked row with no parent_geom",
  "degrade-advance-missing": `refused. ${DEGRADE_NOT_CHECKED}`,
  "degrade-not-worse": `refused. ${DEGRADE_NOT_CHECKED}`,
  "degrade-watercourse-retained-and-created": `refused. ${DEGRADE_NOT_CHECKED}`,
  "degrade-watercourse-advance-not-encroachment": `saved as Incomplete. ${DEGRADE_NOT_CHECKED}`,
  "degrade-watercourse-encroachment-no-advance": `saved as Incomplete. ${DEGRADE_NOT_CHECKED}`,
  "version-record-missing": `refused (BMD-1082). ${VERSION_NOT_CHECKED}`,
  "version-record-duplicated": `refused (BMD-1082). ${VERSION_NOT_CHECKED}`,
  "version-unsupported": `refused (BMD-1082). ${VERSION_NOT_CHECKED}`,
};

function generated(path, covers, expected, options) {
  return { path, kind: KIND_GENERATED, covers, expected, options };
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
    NOT_ENFORCED_YET[name] ?? flaw.errorCode,
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
    "The default site, holding both stages and every feature only the new template records: vertical area habitats, comments, an irreplaceable parcel and tree, an Enhanced tree, habitats that get worse on each layer, a re-meandered and a shorter watercourse, and Habitat Refs that repeat",
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
    [dropColumns(AREA_BASELINE, ["Baseline Condition", "Area"])],
  ),
  derived(
    "invalid-schema/wrong-column-names-in-area-habitats.gpkg",
    `\`${AREA_BASELINE}\` names \`Baseline Habitat Type\` as \`Habitat Type\`, and \`Baseline Condition\` as \`Condition\``,
    [
      renameColumns(AREA_BASELINE, {
        "Baseline Habitat Type": "Habitat Type",
        "Baseline Condition": "Condition",
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
].map((name) => flawFixture("attribute-problems", name));

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

const BNG500 = [
  converted("BROADLAND_2024_3282", {
    templateValues: {
      "Individual Trees Baseline": [
        "Baseline Rural or Urban Tree",
        "Baseline Tree Type",
      ],
      "Individual Trees Post-Intervention": [
        "Baseline Condition",
        "Baseline Rural or Urban Tree",
        "Baseline Tree Size",
        "Baseline Tree Type",
        "Category",
        "Proposed Rural or Urban Tree",
        "Proposed Tree Size",
        "Proposed Tree Type",
        "Retention Category",
      ],
    },
  }),
  converted("BarkingandDagenham2400625FULL", {
    lineage: ["lineage-parent-missing"],
    templateValues: {
      "Individual Trees Post-Intervention": [
        "Baseline Tree Size",
        "Category",
        "Proposed Rural or Urban Tree",
        "Proposed Strategic Significance",
        "Proposed Tree Size",
        "Proposed Tree Type",
        "Retention Category",
      ],
      "Watercourses Post-Intervention": [
        "Baseline Encroachment into riparian zone",
        "Baseline Encroachment into Watercourse",
        "Proposed Encroachment into riparian zone",
        "Proposed Encroachment into Watercourse",
      ],
    },
  }),
  converted("CAMBRIDGE_24_03964_FUL", {
    templateValues: {
      "Area Habitats Post-Intervention": ["Proposed Strategic Significance"],
      "Individual Trees Baseline": [
        "Baseline Rural or Urban Tree",
        "Baseline Tree Type",
      ],
      "Individual Trees Post-Intervention": [
        "Baseline Condition",
        "Baseline Rural or Urban Tree",
        "Baseline Tree Size",
        "Baseline Tree Type",
        "Category",
        "Proposed Rural or Urban Tree",
        "Proposed Tree Size",
        "Proposed Tree Type",
        "Retention Category",
      ],
    },
  }),
  converted("Sunderland_24_00723_FU4", {
    templateValues: {
      "Area Habitats Baseline": ["Baseline Habitat Type"],
      "Area Habitats Post-Intervention": ["Habitat created in advance/years"],
      "Hedgerows Post-Intervention": ["Habitat created in advance/years"],
      "Individual Trees Baseline": [
        "Baseline Rural or Urban Tree",
        "Baseline Tree Type",
      ],
      "Individual Trees Post-Intervention": [
        "Baseline Tree Size",
        "Category",
        "Habitat Created/Enhanced in advance/years",
        "Proposed Rural or Urban Tree",
        "Proposed Tree Size",
        "Proposed Tree Type",
        "Retention Category",
      ],
      "Watercourses Post-Intervention": [
        "Baseline Encroachment into riparian zone",
        "Proposed Encroachment into riparian zone",
      ],
    },
  }),
  converted("Wiltshire_PL_2024_08441", {
    templateValues: {
      "Watercourses Post-Intervention": [
        "Baseline Encroachment into riparian zone",
        "Baseline Encroachment into Watercourse",
        "Proposed Encroachment into riparian zone",
        "Proposed Encroachment into Watercourse",
      ],
    },
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
  "A natural river left out of a watercourse that gets worse, a habitat that gets worse with a blank Habitat Ref, and an irreplaceable tree that gets worse: bng-library has no degrade flaw for these yet (BMD-1080 follow-up).",
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
