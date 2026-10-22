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
import { splitFlaws } from "./gen-gpkg-flaws.mjs";
import { printHelp } from "./gen-gpkg-help.mjs";
import { runFromList, runFromWorkbook } from "./gen-gpkg-workbook.mjs";
import { parseWorseCounts } from "./gen-gpkg-worse.mjs";
import {
  afterBngServiceWrite,
  assertTemplateAvailable,
  failures,
} from "./gen-gpkg-after-write.mjs";
import {
  WORKBOOK_STRICTNESS,
  syntheticStrictness,
} from "./service-template/check-generated.mjs";
import {
  CURRENT_TEMPLATE_VERSION,
  FEATURE_REF_PAD,
  FEATURE_REF_PAD_CHAR,
  FORMAT_BNG_SERVICE,
  FORMAT_LEGACY,
  FlawSelectionError,
  MODE_BOTH,
  STAGE_BASELINE,
  STAGE_POST_INTERVENTION,
  VALID_FORMATS,
  VALID_MODES,
  VALID_STAGES,
  deriveBaselineFromSynthetic,
  generateBngServiceSynthetic,
  generateOne,
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
    stage: { type: "string" },
    // BNG Service format only: the version the template version record names.
    "template-version": { type: "string" },
    // BNG Service format only: also write each file as a copy of the QGIS
    // template folder, ready to open, and that folder zipped.
    "package-template": { type: "boolean", default: false },
    // BNG Service format, synthetic only: how many habitats that get worse
    // of a kind to draw, as KIND=N, in place of one each.
    worse: { type: "string", multiple: true, default: [] },
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
// --stage and --template-version carry no parseArgs default, so
// assertFormatFlagsValid can tell a flag the user passed from one they did not.
const selectedStage = args.stage ?? STAGE_POST_INTERVENTION;
if (!args.help && !VALID_STAGES.has(selectedStage)) {
  console.error(
    `--stage must be one of: ${[...VALID_STAGES].join(", ")} (got: ${selectedStage})`,
  );
  process.exit(1);
}
// As bng-library's own check: a template version is "<major>.<minor>".
const TEMPLATE_VERSION_PATTERN = /^\d+\.\d+$/;
const selectedTemplateVersion =
  args["template-version"] ?? CURRENT_TEMPLATE_VERSION;
if (!args.help && !TEMPLATE_VERSION_PATTERN.test(selectedTemplateVersion)) {
  console.error(
    `--template-version must be "<major>.<minor>", such as "${CURRENT_TEMPLATE_VERSION}" (got: ${selectedTemplateVersion})`,
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
function writeSyntheticPair(paths, centre, plan) {
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

// Remove the files a run would overwrite, asking first unless it is a batch:
// one question covers them all.
async function clearExistingSyntheticOutput(outPaths, isBatch) {
  const existing = outPaths.filter((outPath) => existsSync(outPath));
  if (existing.length === 0) {
    return;
  }
  if (!isBatch) {
    const verb = existing.length === 1 ? "exists" : "exist";
    const overwrite = await confirm(
      `${existing.join(" and ")} already ${verb}. Overwrite? (y/N) `,
    );
    if (!overwrite) {
      console.log("Aborted.");
      process.exit(0);
    }
  }
  for (const outPath of existing) {
    unlinkSync(outPath);
  }
}

// --format bng-service writes one file holding both stages, named for the
// format and, for the baseline-stage file, the stage.
function bngServiceFilename(flawSuffix, extraFlaws, suffix, stamp) {
  const extra = extraFlaws.length
    ? `-${sortFlawNames(extraFlaws).join("-")}`
    : "";
  const stage = selectedStage === STAGE_BASELINE ? "-baseline" : "";
  return `bng-service-test-data${flawSuffix}${extra}${stage}${suffix}-${stamp}.gpkg`;
}

async function runSynthetic(centre, seed) {
  const numParcels =
    Number.parseInt(args.size, PARSE_INT_BASE_10) || DEFAULT_SYNTHETIC_SIZE;
  const total = Math.max(
    1,
    Number.parseInt(args.count, PARSE_INT_BASE_10) || DEFAULT_RUN_COUNT,
  );
  const { legacy, lineageFlawNames, degradeFlawNames, versionFlawNames } =
    splitFlaws(args.flaw, { bngService, stage: selectedStage });
  const selection = resolveFlawSelection({
    bad: args.bad,
    flaws: legacy,
    numParcels,
  });
  const habitatPins = resolveHabitatPins(args.habitat, numParcels, selection);
  const worseHabitatCounts = parseWorseCounts(args.worse);
  // A geometric flaw draws the minimal bad site, which holds no habitats
  // that get worse to count.
  if (worseHabitatCounts && selection.geometricFlawNames.length > 0) {
    throw new FlawSelectionError(
      "--worse cannot be combined with --bad or a geometric flaw: their minimal site draws no habitats that get worse",
    );
  }
  const plan = {
    numParcels,
    ...selection,
    lineageFlawNames,
    degradeFlawNames,
    versionFlawNames,
  };
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
  const runs = [];
  for (let i = 1; i <= total; i++) {
    const suffix =
      total > 1
        ? `-${String(i).padStart(FEATURE_REF_PAD, FEATURE_REF_PAD_CHAR)}`
        : "";
    // Each file in a --count batch gets its own seed so the batch stays varied
    // yet reproducible: same --seed always yields the same N files.
    runs.push({
      worseHabitatCounts,
      plan: seed === null ? plan : { ...plan, seed: seed + (i - 1) },
      paths: syntheticOutPaths(plan, flawSuffix, suffix, timestampSuffix()),
      strictness: syntheticStrictness({
        contentFlaws:
          legacy.length + degradeFlawNames.length + (args.bad ? 1 : 0),
        habitatPins: args.habitat.length,
      }),
    });
  }
  // Clear everything the batch would overwrite before writing any of it, so
  // the writes run in order without stopping to ask.
  await clearExistingSyntheticOutput(
    runs.flatMap((run) => Object.values(run.paths)),
    total > 1,
  );
  for (const run of runs) {
    writeSyntheticRun(centre, run);
  }
}

// The files one synthetic run writes, in the format and layout asked for.
function syntheticOutPaths(plan, flawSuffix, suffix, stamp) {
  if (bngService) {
    const extraFlaws = [
      ...plan.lineageFlawNames,
      ...plan.degradeFlawNames,
      ...plan.versionFlawNames,
    ];
    return {
      bngService: path.join(
        OUT_DIR,
        bngServiceFilename(flawSuffix, extraFlaws, suffix, stamp),
      ),
    };
  }
  if (args.pair) {
    const names = syntheticPairFilenames(flawSuffix, suffix, stamp);
    return {
      baseline: path.join(OUT_DIR, names.baseline),
      postIntervention: path.join(OUT_DIR, names.postIntervention),
    };
  }
  return {
    legacy: path.join(OUT_DIR, syntheticFilename(flawSuffix, suffix, stamp)),
  };
}

function writeSyntheticRun(
  centre,
  { plan, paths, strictness, worseHabitatCounts },
) {
  if (paths.bngService) {
    generateBngServiceSynthetic(paths.bngService, centre, plan, {
      stage: selectedStage,
      templateVersion: selectedTemplateVersion,
      worseHabitatCounts,
    });
    afterBngServiceWrite(paths.bngService, {
      strictness,
      packageTemplate: args["package-template"],
    });
  } else if (paths.baseline) {
    writeSyntheticPair(paths, centre, plan);
  } else {
    generateOne(paths.legacy, centre, plan);
  }
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
  if (args.pair || args.habitat.length > 0 || args.worse.length > 0) {
    error(
      "--pair, --habitat and --worse are synthetic-mode only; workbook mode already emits a " +
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
    args.stage !== undefined || args["template-version"] !== undefined;
  if (!bngService && bngServiceOnly) {
    error(`--stage and --template-version need --format ${FORMAT_BNG_SERVICE}`);
    process.exit(1);
  }
  if (!bngService && args.worse.length > 0) {
    error(
      `--worse needs --format ${FORMAT_BNG_SERVICE}: it counts the BNG Service template's habitats that get worse`,
    );
    process.exit(1);
  }
  if (!bngService && args["package-template"]) {
    error(
      `--package-template needs --format ${FORMAT_BNG_SERVICE}: it packages the BNG Service template`,
    );
    process.exit(1);
  }
}

// Before anything is written, so a missing template is not found only after
// a long run.
function assertPackagingPossible() {
  if (args["package-template"] && !args.inspect) {
    assertTemplateAvailable();
  }
}

function assertFlagCombinationsValid() {
  assertInspectHasSource();
  assertSyntheticFlagsOutsideWorkbookMode();
  assertSeedOutsideWorkbookMode();
  assertFormatFlagsValid();
  assertPackagingPossible();
}

function formatOptions() {
  return {
    format: args.format,
    stage: selectedStage,
    templateVersion: selectedTemplateVersion,
    onBngServiceFile: (file) =>
      afterBngServiceWrite(file, {
        strictness: WORKBOOK_STRICTNESS,
        packageTemplate: args["package-template"],
      }),
  };
}

// A file that fails a check it should pass is still written, and named, so
// it can be looked at; the run exits 1.
function exitIfChecksFailed() {
  const failed = failures();
  if (failed.length > 0) {
    const lines = failed.map(({ file, reason }) => `${file}: ${reason}`);
    error(`${failed.length} file(s) failed:\n  ${lines.join("\n  ")}`);
    process.exit(1);
  }
}

async function main() {
  if (args.help) {
    printHelp({
      defaultSize: DEFAULT_SYNTHETIC_SIZE,
      defaultCount: DEFAULT_RUN_COUNT,
    });
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
    exitIfChecksFailed();
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
    exitIfChecksFailed();
    return;
  }
  await runSynthetic(centre, seed);
  exitIfChecksFailed();
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
