/**
 * `--help` for generate:gpkg. The flaw catalogue is rendered from the
 * library's listFlaws(), so it can never drift from the FLAWS registry that
 * drives generation.
 *
 * Split out of `gen-gpkg.mjs` to keep that file within its size budget; it is
 * the CLI's only consumer.
 */

import { DEFAULT_CENTRE_E, DEFAULT_CENTRE_N } from "./centre.mjs";
import { worseHelp } from "./gen-gpkg-worse.mjs";
import {
  BNG_SERVICE_FLAWS,
  CURRENT_TEMPLATE_VERSION,
  FORMAT_BNG_SERVICE,
  FORMAT_LEGACY,
  LEGACY_ONLY_FLAWS,
  MODE_BOTH,
  STAGE_BASELINE,
  STAGE_POST_INTERVENTION,
  VALID_FORMATS,
  VALID_MODES,
  VALID_STAGES,
  listFlaws,
} from "#bng-lib";

// Categories in the order they read most naturally in help output, each with a
// one-line gloss. Keyed by the categoryLabel listFlaws() returns.
const FLAW_CATEGORY_HEADINGS = [
  ["geometric", "Geometric flaws (each targets one backend validation error):"],
  [
    "empty-layer",
    "Empty-layer flaws (a feature layer present with zero rows):",
  ],
  [
    "attribute-override",
    "Attribute-override flaws (valid geometry; out-of-scope column values):",
  ],
  [
    "lineage",
    "Lineage flaws (--format bng-service only; a post-intervention feature's link to its parent):",
  ],
  [
    "degraded-habitat",
    "Degraded-habitat flaws (--format bng-service only; a habitat that gets worse, recorded wrongly):",
  ],
  [
    "template-version",
    "Template-version flaws (--format bng-service only; the gpkg_metadata version record):",
  ],
];

function renderFlawCatalogue() {
  // Every flaw of either format: the legacy ones, then the BNG Service
  // format's own.
  const flaws = [
    ...listFlaws(),
    ...listFlaws({ format: FORMAT_BNG_SERVICE }).filter(
      (f) => BNG_SERVICE_FLAWS[f.name],
    ),
  ];
  const nameWidth = Math.max(...flaws.map((f) => f.name.length));
  const codeWidth = Math.max(...flaws.map((f) => f.errorCode.length));
  const lines = [];
  for (const [label, heading] of FLAW_CATEGORY_HEADINGS) {
    const group = flaws.filter((f) => f.categoryLabel === label);
    if (group.length === 0) {
      continue;
    }
    lines.push("", heading);
    for (const f of group) {
      const standalone = f.standalone ? "  (standalone)" : "";
      const legacyOnly = LEGACY_ONLY_FLAWS.has(f.name) ? "  (legacy only)" : "";
      lines.push(
        `  ${f.name.padEnd(nameWidth)}  ${f.errorCode.padEnd(codeWidth)}  ${f.description}${standalone}${legacyOnly}`,
      );
    }
  }
  return lines.join("\n");
}

/**
 * Print --help.
 *
 * @param {{ defaultSize: number, defaultCount: number }} defaults  the CLI's
 *   own defaults for --size and --count
 */
export function printHelp({ defaultSize, defaultCount }) {
  // String.raw so the shell line-continuation in the examples below stays a
  // single backslash without escaping it.
  console.log(
    String.raw`Usage: node scripts/gen-gpkg.mjs [options]

Generates BNG GeoPackage fixtures matching the Natural England statutory
biodiversity metric QGIS template schema (all 5 feature layers per file), or,
with --format ${FORMAT_BNG_SERVICE}, the BNG Service QGIS template (one file
holding the baseline and post-intervention tables of all 5 habitat types).

Modes:
  Synthetic (default)   Randomised geometry + attributes. Use --size / --count.
  Workbook-driven       --from / --from-list reads a real Defra metric workbook
                        and emits a baseline + post-intervention pair.

The scenario catalogue (paired fixtures plus metric workbooks) has its own
command: npm run generate:scenarios.

Options:
  --size N            Parcels per synthetic fixture (default ${defaultSize}).
  --count N           Number of synthetic files to emit (default ${defaultCount}).
  --outdir DIR        Output directory (default: <harness>/test-data).
  --pair              Synthetic mode: emit a baseline + post-intervention pair
                      sharing one redline, instead of a single file.
  --habitat "B - T"   Synthetic mode: pin the baseline habitat of the next
                      parcel to "<Broad habitat type> - <Habitat type>".
                      Repeatable — the Nth --habitat pins the Nth parcel; the
                      rest stay randomised. Pinned rows are Retained.
  --bad               Synthetic mode: apply every composable geometric flaw at once.
  --flaw NAME         Synthetic mode: emit a fixture targeting one flaw.
                      Repeatable; see below.
  --from PATH|URL     Generate from a Defra metric workbook (xlsx/xlsm).
  --from-list FILE    Generate from every workbook path/URL listed in FILE.
  --mode MODE         ${[...VALID_MODES].join(" | ")} (workbook mode; default ${MODE_BOTH}).
  --centre E,N        RLB centre, BNG/EPSG:27700 (default ${DEFAULT_CENTRE_E},${DEFAULT_CENTRE_N}).
  --strict-habitats   Fail on unmapped habitat types instead of warning.
  --inspect           Print a workbook summary as JSON (requires --from).
  --seed N            Deterministic output: same seed → byte-identical files
                      (synthetic mode).
  --format F          ${[...VALID_FORMATS].join(" | ")} (default ${FORMAT_LEGACY}). ${FORMAT_BNG_SERVICE}
                      writes one file holding both stages, so it takes no
                      --pair or --mode.
  --stage S           ${[...VALID_STAGES].join(" | ")} (${FORMAT_BNG_SERVICE} only; default
                      ${STAGE_POST_INTERVENTION}). ${STAGE_BASELINE} leaves the post-intervention
                      tables empty.
  --template-version V  The version the file's template version record names
                      (${FORMAT_BNG_SERVICE} only; default ${CURRENT_TEMPLATE_VERSION}).
${worseHelp()}
  --package-template  ${FORMAT_BNG_SERVICE} only: also write each file as a copy of
                      the QGIS template folder, ready to open in QGIS (its
                      project reads Layers/BNG Service Layers.gpkg, so a bare
                      file shows every layer as unavailable), and that folder
                      zipped. Needs the bng-metric-template sibling
                      (npm run bootstrap) or BNG_TEMPLATE_DIR.
  -h, --help          Show this help and exit.

Each ${FORMAT_BNG_SERVICE} file is checked as it is written: its lineage (as
npm run check:lineage) and its values against the template's drop-downs. A
check that should pass and does not exits 1; one a flaw asked for may break,
or a --habitat pin may break, only warns.

Flaw catalogue (--flaw values; defined in bng-library):
${renderFlawCatalogue()}

Geometric, empty-layer and attribute flaws cannot be mixed with each other;
lineage, degraded-habitat and template-version flaws combine with any of them. Examples:
  node scripts/gen-gpkg.mjs --size 30
  node scripts/gen-gpkg.mjs --bad
  node scripts/gen-gpkg.mjs --flaw parcel-too-small
  node scripts/gen-gpkg.mjs --from ./metric.xlsm --mode baseline
  node scripts/gen-gpkg.mjs --seed 7
  node scripts/gen-gpkg.mjs --format ${FORMAT_BNG_SERVICE} --size 20
  node scripts/gen-gpkg.mjs --format ${FORMAT_BNG_SERVICE} --stage ${STAGE_BASELINE}
  node scripts/gen-gpkg.mjs --format ${FORMAT_BNG_SERVICE} --flaw lineage-parent-unknown
  node scripts/gen-gpkg.mjs --format ${FORMAT_BNG_SERVICE} --size 15 --seed 6 \
    --centre 460000,210000 --worse hedge=4 --worse partly-worse-hedge=4 \
    --package-template
  node scripts/gen-gpkg.mjs --format ${FORMAT_BNG_SERVICE} --from ./metric.xlsm
  node scripts/gen-gpkg.mjs --size 3 --pair \
    --habitat "Intertidal hard structures - Artificial hard structures with integrated greening of grey infrastructure (IGGI)"`,
  );
}
