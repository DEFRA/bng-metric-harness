#!/usr/bin/env node

/**
 * Generates realistic BNG GeoPackages matching the Natural England
 * statutory biodiversity metric QGIS template schema. All 5 feature
 * layers per file: Red Line Boundary, Habitats, Hedgerows, Rivers,
 * Urban Trees.
 *
 * Two modes:
 *
 *   1. Synthetic (default).
 *      Both geometry AND attributes are randomised on each run, so repeat
 *      runs produce different files. Use --size to scale the fixture and
 *      --count to produce N varied files at once. Emits one file per run,
 *      or a baseline / post-intervention pair per run with --pair. --habitat
 *      pins individual parcels to named habitats, which is the only way to
 *      put a non-inland habitat (IGGI) into a synthetic fixture — the random
 *      pools are inland-only.
 *
 *   2. Workbook-driven (--from / --from-list).
 *      Attributes are read from a real Defra Statutory Biodiversity Metric
 *      workbook (xlsx/xlsm). Emits TWO files per workbook by default:
 *      a baseline gpkg (pre-development state, A-1 / B-1 / C-1 only, no
 *      proposed columns) and a post-intervention gpkg (proposed end-state,
 *      with retained / enhanced / created rows derived from the A-1 /
 *      B-1 / C-1 per-fate columns and the A-2 / A-3 / B-2 / B-3 / C-2 /
 *      C-3 sheets). The two files share an identical Red Line Boundary,
 *      so they can be uploaded sequentially to model the two-stage BNG
 *      service workflow. Use --mode baseline or --mode post-intervention
 *      to emit only one of the pair.
 *
 * The scenario catalogue — paired fixtures for every BNG scenario, with the
 * metric workbooks that go with them — has its own command:
 * `npm run generate:scenarios` (scripts/gen-scenarios.mjs).
 *
 * In either mode --centre <easting,northing> positions the RLB anywhere in
 * Britain (BNG, EPSG:27700). Defaults to Maidenhead (530000,180000).
 *
 * Output goes to test-data/ unless --outdir is set. See the harness README
 * "Test data generation" section for end-user docs and worked examples.
 *
 * --bad / --flaw deliberately produce invalid fixtures used to exercise the
 * backend's validation. --bad applies every composable geometric flaw at once;
 * a single --flaw <name> produces a minimal fixture targeting one validator.
 * --flaw is repeatable, and flaws fall into three categories — geometric,
 * empty-layer and attribute-override — that cannot be mixed with each other.
 *
 * The flaw catalogue itself is defined once, in bng-library's FLAWS registry;
 * this CLI renders it on demand rather than restating it. Run
 * `node scripts/gen-gpkg.mjs --help` for the current flaw names, their backend
 * error codes and descriptions.
 *
 * This file is the CLI: argument parsing, file naming and the overwrite
 * prompt. Workbook source resolution (URL/LFS download and caching) and the
 * --from-list loop live in `gen-gpkg-workbook.mjs`; the actual GeoPackage
 * synthesis lives in `packages/bng-lib/` (imported as `#bng-lib`).
 */

import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { error, info, timestampSuffix } from "./_lib.mjs";
import { DEFAULT_CENTRE_E, DEFAULT_CENTRE_N, parseCentre } from "./centre.mjs";
import {
  HABITATS_LAYER,
  resolveHabitatPins,
} from "./gen-gpkg-habitat-pins.mjs";
import { runFromList, runFromWorkbook } from "./gen-gpkg-workbook.mjs";
import {
  BNG_SERVICE_FLAWS,
  CATEGORY_LINEAGE,
  CURRENT_TEMPLATE_VERSION,
  FEATURE_REF_PAD,
  FEATURE_REF_PAD_CHAR,
  FORMAT_BNG_SERVICE,
  FORMAT_LEGACY,
  FlawSelectionError,
  LEGACY_ONLY_FLAWS,
  MODE_BOTH,
  STAGE_BASELINE,
  STAGE_POST_INTERVENTION,
  VALID_FORMATS,
  VALID_MODES,
  VALID_STAGES,
  deriveBaselineFromSynthetic,
  generateBngServiceSynthetic,
  generateOne,
  listFlaws,
  resolveFlawSelection,
} from "#bng-lib";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const { values: args } = parseArgs({
  options: {
    size: { type: "string", default: "50" },
    count: { type: "string", default: "1" },
    outdir: { type: "string", default: "" },
    bad: { type: "boolean", default: false },
    flaw: { type: "string", multiple: true, default: [] },
    // Synthetic mode: pin the baseline habitat of the first N parcels, one
    // --habitat per parcel. Lets a fixture carry a habitat the random pools
    // never draw (they are inland-only) — IGGI being the motivating case.
    habitat: { type: "string", multiple: true, default: [] },
    // Synthetic mode: emit a baseline / post-intervention pair sharing one
    // redline, the way workbook mode already does.
    pair: { type: "boolean", default: false },
    from: { type: "string", default: "" },
    "from-list": { type: "string", default: "" },
    "strict-habitats": { type: "boolean", default: false },
    inspect: { type: "boolean", default: false },
    centre: { type: "string", default: "" },
    // Two-stage upload modelling: --mode baseline writes only the pre-
    // development gpkg, --mode post-intervention writes only the proposed
    // end-state, --mode both (default) writes both side by side from the
    // same workbook.
    mode: { type: "string" },
    // Reproducibility: with an integer --seed, every random draw is
    // deterministic, so a given seed + options yields byte-identical files.
    // Applies to synthetic mode.
    seed: { type: "string", default: "" },
    // Output format: the legacy Natural England layout (default, one file per
    // stage) or the BNG Service template (one file holding both stages).
    format: { type: "string", default: FORMAT_LEGACY },
    // BNG Service format only: "baseline" leaves the post-intervention
    // tables empty — the file an ecologist has before mapping them.
    stage: { type: "string", default: STAGE_POST_INTERVENTION },
    // BNG Service format only: the version the template version record names.
    "template-version": { type: "string", default: CURRENT_TEMPLATE_VERSION },
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: false,
});

const selectedMode = args.mode ?? MODE_BOTH;
if (!args.help && !VALID_MODES.has(selectedMode)) {
  console.error(
    `--mode must be one of: ${[...VALID_MODES].join(", ")} (got: ${args.mode})`,
  );
  process.exit(1);
}

if (!args.help && !VALID_FORMATS.has(args.format)) {
  console.error(
    `--format must be one of: ${[...VALID_FORMATS].join(", ")} (got: ${args.format})`,
  );
  process.exit(1);
}
if (!args.help && !VALID_STAGES.has(args.stage)) {
  console.error(
    `--stage must be one of: ${[...VALID_STAGES].join(", ")} (got: ${args.stage})`,
  );
  process.exit(1);
}
// As bng-library's own check: a template version is "<major>.<minor>".
const TEMPLATE_VERSION_PATTERN = /^\d+\.\d+$/;
if (!args.help && !TEMPLATE_VERSION_PATTERN.test(args["template-version"])) {
  console.error(
    `--template-version must be "<major>.<minor>", such as "${CURRENT_TEMPLATE_VERSION}" (got: ${args["template-version"]})`,
  );
  process.exit(1);
}
const bngService = args.format === FORMAT_BNG_SERVICE;

const HARNESS_ROOT = path.resolve(import.meta.dirname, "..");
const OUT_DIR = args.outdir
  ? path.resolve(args.outdir)
  : path.resolve(HARNESS_ROOT, "test-data");

// CLI defaults when --size / --count are missing or non-numeric.
const DEFAULT_SYNTHETIC_SIZE = 50;
const DEFAULT_RUN_COUNT = 1;
const PARSE_INT_BASE_10 = 10;

/**
 * Parse the --seed CLI value. Returns null when the flag wasn't given, or the
 * integer seed when valid. Exits on a non-integer value.
 */
function parseSeed(value) {
  if (!value) {
    return null;
  }
  const n = Number.parseInt(value, PARSE_INT_BASE_10);
  if (!Number.isInteger(n) || String(n) !== value.trim()) {
    error(`--seed must be an integer (got: ${value})`);
    return process.exit(1);
  }
  return n;
}

// ---------------------------------------------------------------------------
// Synthetic-mode interactive overwrite prompt
// ---------------------------------------------------------------------------

function confirm(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase().startsWith("y"));
    });
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function syntheticFilename(flawSuffix, suffix, stamp) {
  return `bng-test-data${flawSuffix}${suffix}-${stamp}.gpkg`;
}

// --pair names its two halves like workbook mode does, so a directory listing
// groups the stage with the run that produced it.
function syntheticPairFilenames(flawSuffix, suffix, stamp) {
  return {
    baseline: `bng-test-data${flawSuffix}${suffix}-baseline-${stamp}.gpkg`,
    postIntervention: `bng-test-data${flawSuffix}${suffix}-post-intervention-${stamp}.gpkg`,
  };
}

/**
 * Write one synthetic file as the post-intervention half, then derive the
 * baseline half from it. Deriving rather than generating twice is what makes
 * the redline, the parcel partition and every feature ref identical across
 * the pair.
 */
async function writeSyntheticPair(paths, centre, plan, isBatch) {
  await clearExistingSyntheticOutput(paths.postIntervention, isBatch);
  await clearExistingSyntheticOutput(paths.baseline, isBatch);
  generateOne(paths.postIntervention, centre, plan);
  const cleared = deriveBaselineFromSynthetic(
    paths.postIntervention,
    paths.baseline,
  );
  const summary = cleared.map((c) => `${c.table} ${c.cleared}`).join(", ");
  info(`  baseline derived — proposed columns cleared on ${summary}`);
  info(`  → ${paths.baseline}`);
}

// Output basename suffix following `bng-test-data`. Examples:
//   --bad                                  → "-bad"
//   --flaw parcel-too-small (no --bad)     → "-bad-parcel-too-small"
//   --bad --flaw parcel-too-small          → "-bad"
//   --flaw no-habitats                     → "-no-habitats"
//   --flaw no-habitats no-rivers           → "-no-habitats-no-rivers"
//   --flaw distinctiveness-out-of-scope    → "-distinctiveness-out-of-scope"
//   (no flaws)                             → ""
// Empty-layer and attribute-override flaws don't get the "bad-" prefix because
// the file is structurally and geometrically valid — it just contains rows
// shaped to trip a specific later validator.
function sortFlawNames(names) {
  return [...names].sort((a, b) => a.localeCompare(b));
}

function buildFlawFilenameSuffix({ selection, flagBad }) {
  const { geometricFlawNames, emptyFlawNames, attributeFlawNames } = selection;
  if (attributeFlawNames.length > 0) {
    return `-${sortFlawNames(attributeFlawNames).join("-")}`;
  }
  if (emptyFlawNames.length > 0) {
    return `-${sortFlawNames(emptyFlawNames).join("-")}`;
  }
  if (geometricFlawNames.length === 0) {
    return "";
  }
  if (flagBad) {
    return "-bad";
  }
  return `-bad-${sortFlawNames(geometricFlawNames).join("-")}`;
}

async function clearExistingSyntheticOutput(outPath, isBatch) {
  if (!existsSync(outPath)) {
    return;
  }
  if (isBatch) {
    unlinkSync(outPath);
    return;
  }
  const overwrite = await confirm(
    `${outPath} already exists. Overwrite? (y/N) `,
  );
  if (!overwrite) {
    console.log("Aborted.");
    process.exit(0);
  }
  unlinkSync(outPath);
}

/**
 * Split --flaw into the legacy flaws, which the legacy generator draws, and
 * the BNG Service format's own lineage and template-version flaws, which are
 * applied to the converted file. A flaw the template cannot carry is refused.
 */
function splitFlaws(names) {
  const legacy = [];
  const lineageFlawNames = [];
  const versionFlawNames = [];
  for (const name of names) {
    const flaw = BNG_SERVICE_FLAWS[name];
    if (bngService && LEGACY_ONLY_FLAWS.has(name)) {
      throw new FlawSelectionError(
        `Flaw "${name}" cannot be written in the BNG Service template (it has no Count column).`,
      );
    }
    if (!flaw) {
      legacy.push(name);
    } else if (!bngService) {
      throw new FlawSelectionError(
        `Flaw "${name}" is a BNG Service template flaw; add --format ${FORMAT_BNG_SERVICE}.`,
      );
    } else if (flaw.category === CATEGORY_LINEAGE) {
      lineageFlawNames.push(name);
    } else {
      versionFlawNames.push(name);
    }
  }
  assertBngServiceFlawsWritable(lineageFlawNames, versionFlawNames);
  return { legacy, lineageFlawNames, versionFlawNames };
}

/**
 * Refuse a BNG Service flaw selection the file could not hold, so a file is
 * never named for a flaw it does not carry.
 */
function assertBngServiceFlawsWritable(lineageFlawNames, versionFlawNames) {
  // As bng-library's partitionFlaws: each version flaw says what the whole
  // record is, and each lineage flaw restamps the same feature, so a second
  // of either would be named in the file but not written to it.
  if (versionFlawNames.length > 1) {
    throw new FlawSelectionError(
      `Only one template-version flaw at a time; got ${versionFlawNames.join(", ")}`,
    );
  }
  if (lineageFlawNames.length > 1) {
    throw new FlawSelectionError(
      `Only one lineage flaw at a time, as each restamps the same feature; got ${lineageFlawNames.join(", ")}`,
    );
  }
  // Each lineage flaw changes a post-intervention feature, and the
  // baseline-stage file leaves those tables empty.
  if (args.stage === STAGE_BASELINE && lineageFlawNames.length > 0) {
    throw new FlawSelectionError(
      `Lineage flaws change post-intervention features, which the baseline-stage file leaves empty; drop --stage ${STAGE_BASELINE}`,
    );
  }
}

// --format bng-service writes one file holding both stages, named for the
// format and, for the baseline-stage file, the stage.
function bngServiceFilename(flawSuffix, extraFlaws, suffix, stamp) {
  const extra = extraFlaws.length
    ? `-${sortFlawNames(extraFlaws).join("-")}`
    : "";
  const stage = args.stage === STAGE_BASELINE ? "-baseline" : "";
  return `bng-service-test-data${flawSuffix}${extra}${stage}${suffix}-${stamp}.gpkg`;
}

async function writeBngServiceSynthetic(outPath, centre, plan, isBatch) {
  await clearExistingSyntheticOutput(outPath, isBatch);
  generateBngServiceSynthetic(outPath, centre, plan, {
    stage: args.stage,
    templateVersion: args["template-version"],
  });
}

async function runSynthetic(centre, seed) {
  const numParcels =
    Number.parseInt(args.size, PARSE_INT_BASE_10) || DEFAULT_SYNTHETIC_SIZE;
  const total = Math.max(
    1,
    Number.parseInt(args.count, PARSE_INT_BASE_10) || DEFAULT_RUN_COUNT,
  );
  const { legacy, lineageFlawNames, versionFlawNames } = splitFlaws(args.flaw);
  const selection = resolveFlawSelection({
    bad: args.bad,
    flaws: legacy,
    numParcels,
  });
  const habitatPins = resolveHabitatPins(args.habitat, numParcels, selection);
  const plan = { numParcels, ...selection, lineageFlawNames, versionFlawNames };
  if (habitatPins) {
    plan.attributeOverrides = {
      ...selection.attributeOverrides,
      [HABITATS_LAYER]: habitatPins,
    };
  }
  const flawSuffix = buildFlawFilenameSuffix({ selection, flagBad: args.bad });
  if (!existsSync(OUT_DIR)) {
    mkdirSync(OUT_DIR, { recursive: true });
  }
  for (let i = 1; i <= total; i++) {
    const suffix =
      total > 1
        ? `-${String(i).padStart(FEATURE_REF_PAD, FEATURE_REF_PAD_CHAR)}`
        : "";
    const stamp = timestampSuffix();
    // Each file in a --count batch gets its own seed so the batch stays varied
    // yet reproducible: same --seed always yields the same N files.
    const iterationPlan =
      seed === null ? plan : { ...plan, seed: seed + (i - 1) };
    // One file at a time: an existing file may prompt before it is
    // overwritten, and the library's seed and clock are module-wide.
    await writeSyntheticIteration(centre, iterationPlan, {
      flawSuffix,
      suffix,
      stamp,
      isBatch: total > 1,
    });
  }
}

// Write one synthetic run in the format and layout asked for.
async function writeSyntheticIteration(
  centre,
  plan,
  { flawSuffix, suffix, stamp, isBatch },
) {
  if (bngService) {
    const name = bngServiceFilename(
      flawSuffix,
      [...plan.lineageFlawNames, ...plan.versionFlawNames],
      suffix,
      stamp,
    );
    await writeBngServiceSynthetic(
      path.join(OUT_DIR, name),
      centre,
      plan,
      isBatch,
    );
  } else if (args.pair) {
    const names = syntheticPairFilenames(flawSuffix, suffix, stamp);
    await writeSyntheticPair(
      {
        baseline: path.join(OUT_DIR, names.baseline),
        postIntervention: path.join(OUT_DIR, names.postIntervention),
      },
      centre,
      plan,
      isBatch,
    );
  } else {
    const outPath = path.join(
      OUT_DIR,
      syntheticFilename(flawSuffix, suffix, stamp),
    );
    await clearExistingSyntheticOutput(outPath, isBatch);
    generateOne(outPath, centre, plan);
  }
}

// ---------------------------------------------------------------------------
// --help. The flaw catalogue is rendered from the library's listFlaws() so it
// can never drift from the FLAWS registry that actually drives generation.
// ---------------------------------------------------------------------------

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

function printHelp() {
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
  --size N            Parcels per synthetic fixture (default ${DEFAULT_SYNTHETIC_SIZE}).
  --count N           Number of synthetic files to emit (default ${DEFAULT_RUN_COUNT}).
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
  -h, --help          Show this help and exit.

Flaw catalogue (--flaw values; defined in bng-library):
${renderFlawCatalogue()}

Geometric, empty-layer and attribute flaws cannot be mixed with each other;
lineage and template-version flaws combine with any of them. Examples:
  node scripts/gen-gpkg.mjs --size 30
  node scripts/gen-gpkg.mjs --bad
  node scripts/gen-gpkg.mjs --flaw parcel-too-small
  node scripts/gen-gpkg.mjs --from ./metric.xlsm --mode baseline
  node scripts/gen-gpkg.mjs --seed 7
  node scripts/gen-gpkg.mjs --format ${FORMAT_BNG_SERVICE} --size 20
  node scripts/gen-gpkg.mjs --format ${FORMAT_BNG_SERVICE} --stage ${STAGE_BASELINE}
  node scripts/gen-gpkg.mjs --format ${FORMAT_BNG_SERVICE} --flaw lineage-parent-unknown
  node scripts/gen-gpkg.mjs --format ${FORMAT_BNG_SERVICE} --from ./metric.xlsm
  node scripts/gen-gpkg.mjs --size 3 --pair \
    --habitat "Intertidal hard structures - Artificial hard structures with integrated greening of grey infrastructure (IGGI)"`,
  );
}

// Flag combinations parseArgs can't express on its own. One small assert per
// rule so no single function carries the whole argument surface's branching.
function assertInspectHasSource() {
  if (args.inspect && !args.from) {
    error("--inspect requires --from <path-or-url>");
    process.exit(1);
  }
}

function assertSyntheticFlagsOutsideWorkbookMode() {
  const workbookMode = args.from || args["from-list"];
  if (!workbookMode) {
    return;
  }
  if (args.pair || args.habitat.length > 0) {
    error(
      "--pair and --habitat are synthetic-mode only; workbook mode already emits a " +
        "pair and takes its habitats from the workbook (see --mode)",
    );
    process.exit(1);
  }
  // Workbook mode writes what the workbook describes; it applies no flaws, so
  // a flaw asked for would be silently left out.
  if (args.bad || args.flaw.length > 0) {
    error(
      "--bad and --flaw are synthetic-mode only; workbook mode writes what the " +
        "workbook describes and applies no flaws",
    );
    process.exit(1);
  }
}

function assertSeedOutsideWorkbookMode() {
  if (args.seed && (args.from || args["from-list"])) {
    error(
      "--seed is not supported in workbook mode yet; it applies to synthetic " +
        "generation",
    );
    process.exit(1);
  }
}

// The BNG Service format writes one file holding both stages, so it has no
// --pair and no --mode; --stage asks for the baseline-stage file. --stage and
// --template-version mean nothing in the legacy format.
function assertFormatFlagsValid() {
  if (bngService && (args.pair || args.mode)) {
    error(
      `--format ${FORMAT_BNG_SERVICE} writes one file holding both stages; ` +
        "drop --pair / --mode, and use --stage baseline for the baseline-stage file",
    );
    process.exit(1);
  }
  const bngServiceOnly =
    args.stage !== STAGE_POST_INTERVENTION ||
    args["template-version"] !== CURRENT_TEMPLATE_VERSION;
  if (!bngService && bngServiceOnly) {
    error(`--stage and --template-version need --format ${FORMAT_BNG_SERVICE}`);
    process.exit(1);
  }
}

function assertFlagCombinationsValid() {
  assertInspectHasSource();
  assertSyntheticFlagsOutsideWorkbookMode();
  assertSeedOutsideWorkbookMode();
  assertFormatFlagsValid();
}

function formatOptions() {
  return {
    format: args.format,
    stage: args.stage,
    templateVersion: args["template-version"],
  };
}

async function main() {
  if (args.help) {
    printHelp();
    return;
  }
  assertFlagCombinationsValid();
  const centre = parseCentre(args.centre) ?? [
    DEFAULT_CENTRE_E,
    DEFAULT_CENTRE_N,
  ];
  const seed = parseSeed(args.seed);

  if (args["from-list"]) {
    await runFromList(args["from-list"], {
      outDir: OUT_DIR,
      strict: args["strict-habitats"],
      centre,
      mode: selectedMode,
      ...formatOptions(),
    });
    return;
  }
  if (args.from) {
    await runFromWorkbook(args.from, {
      outDir: OUT_DIR,
      strict: args["strict-habitats"],
      inspect: args.inspect,
      centre,
      mode: selectedMode,
      ...formatOptions(),
    });
    return;
  }
  await runSynthetic(centre, seed);
}

main().catch((err) => {
  // FlawSelectionError carries a user-facing message; everything else is a
  // bug, so include the stack.
  if (err instanceof FlawSelectionError) {
    error(err.message);
  } else {
    error(err.stack || err.message || String(err));
  }
  process.exit(1);
});
