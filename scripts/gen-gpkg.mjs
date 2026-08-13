#!/usr/bin/env node

/**
 * Generates realistic BNG GeoPackages matching the Natural England
 * statutory biodiversity metric QGIS template schema. All 5 feature
 * layers per file: Red Line Boundary, Habitats, Hedgerows, Rivers,
 * Urban Trees.
 *
 * Three modes:
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
 *   3. Permutations (--permutations).
 *      Emits a whole library of paired fixtures covering the BMD-934 scenario
 *      catalogue (intervention types, conditions, strategic significance,
 *      met/unmet 10% net gain, trading rules, advance/delay, data
 *      completeness), organised one sub-folder per purpose under
 *      example-files/permutations/ with a manifest.json + index.md. The catalogue
 *      and generation logic live in scripts/permutations/*; --only restricts
 *      to one purpose and --list prints the catalogue without generating.
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
import { error, header, info, timestampSuffix, warn } from "./_lib.mjs";
import {
  HABITATS_LAYER,
  resolveHabitatPins,
} from "./gen-gpkg-habitat-pins.mjs";
import { runFromList, runFromWorkbook } from "./gen-gpkg-workbook.mjs";
import {
  FEATURE_REF_PAD,
  FEATURE_REF_PAD_CHAR,
  FlawSelectionError,
  MODE_BOTH,
  VALID_MODES,
  deriveBaselineFromSynthetic,
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
    // Permutations mode (BMD-934): emit the whole scenario catalogue as paired
    // fixtures organised by purpose. --only restricts to one purpose; --list
    // prints the catalogue without generating. Honours --outdir and --centre.
    permutations: { type: "boolean", default: false },
    only: { type: "string", default: "" },
    list: { type: "boolean", default: false },
    // Reproducibility: with an integer --seed, every random draw is
    // deterministic, so a given seed + options yields byte-identical files.
    // Applies to synthetic and permutations modes.
    seed: { type: "string", default: "" },
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

const HARNESS_ROOT = path.resolve(import.meta.dirname, "..");
const OUT_DIR = args.outdir
  ? path.resolve(args.outdir)
  : path.resolve(HARNESS_ROOT, "test-data");

// British National Grid envelope, used for sanity-checking --centre input.
// Generous bounds — England/Scotland/Wales fit comfortably inside.
const BNG_MAX_EASTING = 700000;
const BNG_MAX_NORTHING = 1300000;

// EPSG:27700 (British National Grid) coords of Maidenhead, deep inside England
// — used as the fallback Red Line Boundary centre when --centre isn't given.
const DEFAULT_CENTRE_E = 530000;
const DEFAULT_CENTRE_N = 180000;

// CLI defaults when --size / --count are missing or non-numeric.
const DEFAULT_SYNTHETIC_SIZE = 50;
const DEFAULT_RUN_COUNT = 1;
const PARSE_INT_BASE_10 = 10;

// ---------------------------------------------------------------------------
// Centre parsing
// ---------------------------------------------------------------------------

/**
 * Parse the --centre "easting,northing" CLI value. Returns null when the
 * flag wasn't given, or [easting, northing] when valid. Exits on malformed
 * input rather than throwing — caller is `main()`.
 */
function parseCentre(value) {
  if (!value) {
    return null;
  }
  const parts = value.split(",").map((s) => s.trim());
  if (parts.length !== 2) {
    error(`--centre expects "easting,northing" (got: ${value})`);
    return process.exit(1);
  }
  const e = Number(parts[0]);
  const n = Number(parts[1]);
  if (!Number.isFinite(e) || !Number.isFinite(n)) {
    error(`--centre values must be numbers (got: ${value})`);
    return process.exit(1);
  }
  // BNG covers roughly easting 0–700000, northing 0–1300000. Warn (not error)
  // outside that, since hand-typed coords often have transposed pairs.
  if (e < 0 || e > BNG_MAX_EASTING || n < 0 || n > BNG_MAX_NORTHING) {
    warn(
      `--centre ${e},${n} is outside the BNG envelope; the prototype's ` +
        "in-England check will likely reject the upload",
    );
  }
  return [e, n];
}

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

async function runSynthetic(centre, seed) {
  const numParcels =
    Number.parseInt(args.size, PARSE_INT_BASE_10) || DEFAULT_SYNTHETIC_SIZE;
  const total = Math.max(
    1,
    Number.parseInt(args.count, PARSE_INT_BASE_10) || DEFAULT_RUN_COUNT,
  );
  const selection = resolveFlawSelection({
    bad: args.bad,
    flaws: args.flaw,
    numParcels,
  });
  const habitatPins = resolveHabitatPins(args.habitat, numParcels, selection);
  const plan = { numParcels, ...selection };
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
    if (args.pair) {
      const names = syntheticPairFilenames(flawSuffix, suffix, stamp);
      await writeSyntheticPair(
        {
          baseline: path.join(OUT_DIR, names.baseline),
          postIntervention: path.join(OUT_DIR, names.postIntervention),
        },
        centre,
        iterationPlan,
        total > 1,
      );
      continue;
    }
    const outPath = path.join(
      OUT_DIR,
      syntheticFilename(flawSuffix, suffix, stamp),
    );
    await clearExistingSyntheticOutput(outPath, total > 1);
    generateOne(outPath, centre, iterationPlan);
  }
}

// ---------------------------------------------------------------------------
// Permutations mode (BMD-934). The catalogue and generation logic live in
// scripts/permutations/*; this just wires the shared CLI flags to them. The
// modules are imported lazily so a normal single-file run never loads the
// engine glue they pull in.
// ---------------------------------------------------------------------------

// Wide enough for the longest scenario id in the catalogue, so titles align.
const CATALOGUE_ID_COLUMN_WIDTH = 34;

function printPermutationsCatalogue(PURPOSES, SCENARIOS) {
  header("Permutations catalogue", "cyan");
  for (const purpose of PURPOSES) {
    info(`\n${purpose}`);
    for (const scenario of SCENARIOS.filter((s) => s.purpose === purpose)) {
      info(`  ${scenario.id.padEnd(CATALOGUE_ID_COLUMN_WIDTH)} ${scenario.title}`);
    }
  }
  info(`\n${SCENARIOS.length} scenarios across ${PURPOSES.length} purposes.`);
}

async function runPermutationsMode(centre, seed) {
  const [
    { runPermutations },
    { writeManifest },
    { PERMUTATION_PURPOSES: PURPOSES, PERMUTATION_SCENARIOS: SCENARIOS },
  ] = await Promise.all([
    import("./permutations/runner.mjs"),
    import("./permutations/manifest.mjs"),
    import("#bng-lib"),
  ]);

  if (args.list) {
    printPermutationsCatalogue(PURPOSES, SCENARIOS);
    return;
  }

  const only = args.only || undefined;
  if (only && !PURPOSES.includes(only)) {
    error(`Unknown purpose "${only}". Known: ${PURPOSES.join(", ")}`);
    process.exit(1);
  }

  const permsRoot = args.outdir
    ? path.resolve(args.outdir)
    : path.resolve(HARNESS_ROOT, "example-files", "permutations");

  const entries = await runPermutations({
    outRoot: permsRoot,
    only,
    centre,
    seed,
  });
  if (entries.length === 0) {
    return;
  }
  const purposes = PURPOSES.filter((p) => entries.some((e) => e.purpose === p));
  const { manifestPath, indexPath } = writeManifest(
    permsRoot,
    entries,
    purposes,
  );
  info(`\n✔ ${entries.length} scenario pair(s) written to ${permsRoot}`);
  info(`  manifest: ${manifestPath}`);
  info(`  index:    ${indexPath}`);
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
];

function renderFlawCatalogue() {
  const flaws = listFlaws();
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
      lines.push(
        `  ${f.name.padEnd(nameWidth)}  ${f.errorCode.padEnd(codeWidth)}  ${f.description}${standalone}`,
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
biodiversity metric QGIS template schema (all 5 feature layers per file).

Modes:
  Synthetic (default)   Randomised geometry + attributes. Use --size / --count.
  Workbook-driven       --from / --from-list reads a real Defra metric workbook
                        and emits a baseline + post-intervention pair.
  Permutations          --permutations emits a whole library of paired fixtures
                        covering the BMD-934 scenario catalogue, organised by
                        purpose with a manifest.json + index.md.

Options:
  --size N            Parcels per synthetic fixture (default ${DEFAULT_SYNTHETIC_SIZE}).
  --count N           Number of synthetic files to emit (default ${DEFAULT_RUN_COUNT}).
  --outdir DIR        Output directory (default: <harness>/test-data, or
                      <harness>/example-files/permutations with --permutations).
  --pair              Synthetic mode: emit a baseline + post-intervention pair
                      sharing one redline, instead of a single file.
  --habitat "B - T"   Synthetic mode: pin the baseline habitat of the next
                      parcel to "<Broad habitat type> - <Habitat type>".
                      Repeatable — the Nth --habitat pins the Nth parcel; the
                      rest stay randomised. Pinned rows are Retained.
  --bad               Apply every composable geometric flaw at once.
  --flaw NAME         Emit a fixture targeting one flaw. Repeatable; see below.
  --from PATH|URL     Generate from a Defra metric workbook (xlsx/xlsm).
  --from-list FILE    Generate from every workbook path/URL listed in FILE.
  --mode MODE         ${[...VALID_MODES].join(" | ")} (workbook mode; default ${MODE_BOTH}).
  --centre E,N        RLB centre, BNG/EPSG:27700 (default ${DEFAULT_CENTRE_E},${DEFAULT_CENTRE_N}).
  --strict-habitats   Fail on unmapped habitat types instead of warning.
  --inspect           Print a workbook summary as JSON (requires --from).
  --permutations      Emit the BMD-934 scenario catalogue (see Modes above).
  --only PURPOSE      Permutations mode: restrict to one purpose.
  --list              Permutations mode: print the catalogue without generating.
  --seed N            Deterministic output: same seed → byte-identical files
                      (synthetic and permutations modes).
  -h, --help          Show this help and exit.

Flaw catalogue (--flaw values; defined in bng-library):
${renderFlawCatalogue()}

Flaws of different categories cannot be mixed. Examples:
  node scripts/gen-gpkg.mjs --size 30
  node scripts/gen-gpkg.mjs --bad
  node scripts/gen-gpkg.mjs --flaw parcel-too-small
  node scripts/gen-gpkg.mjs --from ./metric.xlsm --mode baseline
  node scripts/gen-gpkg.mjs --permutations
  node scripts/gen-gpkg.mjs --permutations --only net-gain
  node scripts/gen-gpkg.mjs --permutations --list
  node scripts/gen-gpkg.mjs --seed 42
  node scripts/gen-gpkg.mjs --permutations --seed 42
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
  const syntheticOnlyFlags = args.pair || args.habitat.length > 0;
  const workbookMode = args.from || args["from-list"];
  if (syntheticOnlyFlags && workbookMode) {
    error(
      "--pair and --habitat are synthetic-mode only; workbook mode already emits a " +
        "pair and takes its habitats from the workbook (see --mode)",
    );
    process.exit(1);
  }
}

function assertPermutationsStandalone() {
  if (args.permutations && permutationsConflicts()) {
    error(
      "--permutations runs the scenario catalogue and can't be combined with " +
        "workbook / flaw / pair / habitat / mode options; it honours --outdir, " +
        "--centre, --only and --list only",
    );
    process.exit(1);
  }
}

function assertSeedOutsideWorkbookMode() {
  if (args.seed && (args.from || args["from-list"])) {
    error(
      "--seed is not supported in workbook mode yet; it applies to synthetic " +
        "and permutations generation",
    );
    process.exit(1);
  }
}

function assertFlagCombinationsValid() {
  assertInspectHasSource();
  assertSyntheticFlagsOutsideWorkbookMode();
  assertPermutationsStandalone();
  assertSeedOutsideWorkbookMode();
}

// The single-file / workbook options that make no sense alongside --permutations
// (which drives its fixtures from the catalogue, not these flags).
function permutationsConflicts() {
  const conflictingFlags = [
    args.from,
    args["from-list"],
    args.bad,
    args.flaw.length > 0,
    args.habitat.length > 0,
    args.pair,
    args.inspect,
    args.mode !== undefined,
  ];
  return conflictingFlags.some(Boolean);
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

  if (args.permutations) {
    await runPermutationsMode(centre, seed);
    return;
  }
  if (args["from-list"]) {
    await runFromList(args["from-list"], {
      outDir: OUT_DIR,
      strict: args["strict-habitats"],
      centre,
      mode: selectedMode,
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
