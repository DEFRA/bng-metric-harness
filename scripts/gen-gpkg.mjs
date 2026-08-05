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
 * This file is the CLI: argument parsing, URL/LFS resolution, file naming,
 * the overwrite prompt and the --from-list loop. The actual GeoPackage
 * synthesis lives in `packages/bng-lib/` (imported as `#bng-lib`).
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { error, info, warn } from "./_lib.mjs";
import { HABITATS_LAYER, resolveHabitatPins } from "./gen-gpkg-habitat-pins.mjs";
import {
  FEATURE_REF_PAD,
  FEATURE_REF_PAD_CHAR,
  FlawSelectionError,
  MODE_BASELINE,
  MODE_BOTH,
  MODE_POST_INTERVENTION,
  VALID_MODES,
  deriveBaselineFromSynthetic,
  generateFromWorkbook,
  generateOne,
  listFlaws,
  readMetricWorkbook,
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
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: false,
});

const selectedMode = args.mode ?? MODE_BOTH;
if (!args.help && !VALID_MODES.has(selectedMode)) {
  console.error(`--mode must be one of: ${[...VALID_MODES].join(", ")} (got: ${args.mode})`);
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
// Workbook source resolution: turn a path-or-URL into a local file path,
// downloading and caching as needed.
// ---------------------------------------------------------------------------

const CACHE_DIR = path.resolve(HARNESS_ROOT, ".cache", "bng500");

/**
 * Convert a GitHub HTML blob URL to the LFS-aware media URL. The BNG500
 * corpus uses Git LFS for the workbook files, so `raw.githubusercontent.com`
 * returns only the LFS pointer; `media.githubusercontent.com/media` resolves
 * the actual file content.
 */
function rewriteGithubBlobUrl(url) {
  const m = url.match(
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/,
  );
  if (!m) {
    return url;
  }
  const [, owner, repo, ref, p] = m;
  return `https://media.githubusercontent.com/media/${owner}/${repo}/${ref}/${p}`;
}

async function downloadToCache(url) {
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true });
  }
  const hash = createHash("sha256").update(url).digest("hex").slice(0, 16);
  const ext = path.extname(new URL(url).pathname) || ".xlsx";
  const cached = path.join(CACHE_DIR, `${hash}${ext}`);
  if (existsSync(cached)) {
    info(`  cache hit: ${path.basename(cached)}`);
    return cached;
  }
  info(`  fetching ${url}`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  // Detect a Git LFS pointer accidentally returned (small text starting with
  // "version https://git-lfs"). Most often happens when callers pass a raw.
  // url instead of a media.githubusercontent.com URL.
  if (
    buf.length < 1024 &&
    buf.slice(0, 64).toString("utf8").startsWith("version https://git-lfs")
  ) {
    throw new Error(
      `${url} returned a Git LFS pointer, not the actual file. ` +
        "Use the GitHub blob URL (or the media.githubusercontent.com/media URL) for LFS-tracked files.",
    );
  }
  writeFileSync(cached, buf);
  return cached;
}

/**
 * Resolve a workbook source (local path or HTTPS URL) to a local file path.
 * Returns the resolved path; downloads remote URLs into the cache.
 */
async function resolveWorkbookSource(ref) {
  const trimmed = ref.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    const url = rewriteGithubBlobUrl(trimmed);
    return downloadToCache(url);
  }
  const abs = path.resolve(trimmed);
  if (!existsSync(abs)) {
    throw new Error(`Workbook not found: ${abs}`);
  }
  return abs;
}

function timestampSuffix(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

function workbookOutputNames(source) {
  // Strip trailing query/hash, keep last path segment, replace extension.
  const url = source.replace(/[?#].*$/, "");
  const base = path.basename(url).replace(/\.(xlsx|xlsm|xls)$/i, "") || "bng-from-workbook";
  const ts = timestampSuffix();
  return {
    baseline: `${base}-baseline-${ts}.gpkg`,
    postIntervention: `${base}-post-intervention-${ts}.gpkg`,
  };
}

async function runFromWorkbook(source, { strict, inspect, centre, mode }) {
  if (!existsSync(OUT_DIR)) {
    mkdirSync(OUT_DIR, { recursive: true });
  }
  const localPath = await resolveWorkbookSource(source);
  const workbook = readMetricWorkbook(localPath);

  if (inspect) {
    const summary = {
      source,
      resolvedPath: localPath,
      version: workbook.version,
      siteInfo: workbook.siteInfo,
      counts: {
        habitats: {
          baseline: workbook.habitats.baseline.length,
          created: workbook.habitats.created.length,
          enhancements: workbook.habitats.enhancements.length,
        },
        hedgerows: {
          baseline: workbook.hedgerows.baseline.length,
          created: workbook.hedgerows.created.length,
          enhancements: workbook.hedgerows.enhancements.length,
        },
        watercourses: {
          baseline: workbook.watercourses.baseline.length,
          created: workbook.watercourses.created.length,
          enhancements: workbook.watercourses.enhancements.length,
        },
        trees: {
          baseline: workbook.trees.baseline.length,
          created: workbook.trees.created.length,
        },
      },
      summary: workbook.summary,
    };
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  const names = workbookOutputNames(source);
  const outPaths = {
    baseline: path.join(OUT_DIR, names.baseline),
    postIntervention: path.join(OUT_DIR, names.postIntervention),
  };
  if (mode !== MODE_POST_INTERVENTION && existsSync(outPaths.baseline)) {
    unlinkSync(outPaths.baseline);
  }
  if (mode !== MODE_BASELINE && existsSync(outPaths.postIntervention)) {
    unlinkSync(outPaths.postIntervention);
  }

  generateFromWorkbook(outPaths, workbook, source, { strict, centre, mode });
}

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

function readWorkbookList(listPath) {
  return readFileSync(listPath, "utf8")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("#"));
}

async function runFromList(listPathArg, centre) {
  const listPath = path.resolve(listPathArg);
  if (!existsSync(listPath)) {
    error(`--from-list file not found: ${listPath}`);
    process.exit(1);
  }
  const opts = {
    strict: args["strict-habitats"],
    inspect: false,
    centre,
    mode: selectedMode,
  };
  for (const entry of readWorkbookList(listPath)) {
    try {
      await runFromWorkbook(entry, opts);
    } catch (e) {
      error(`Failed for ${entry}: ${e.message ?? e}`);
    }
  }
}

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
  const overwrite = await confirm(`${outPath} already exists. Overwrite? (y/N) `);
  if (!overwrite) {
    console.log("Aborted.");
    process.exit(0);
  }
  unlinkSync(outPath);
}

async function runSynthetic(centre) {
  const numParcels = Number.parseInt(args.size, PARSE_INT_BASE_10) || DEFAULT_SYNTHETIC_SIZE;
  const total = Math.max(1, Number.parseInt(args.count, PARSE_INT_BASE_10) || DEFAULT_RUN_COUNT);
  const selection = resolveFlawSelection({ bad: args.bad, flaws: args.flaw, numParcels });
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
    const suffix = total > 1 ? `-${String(i).padStart(FEATURE_REF_PAD, FEATURE_REF_PAD_CHAR)}` : "";
    const stamp = timestampSuffix();
    if (args.pair) {
      const names = syntheticPairFilenames(flawSuffix, suffix, stamp);
      await writeSyntheticPair(
        {
          baseline: path.join(OUT_DIR, names.baseline),
          postIntervention: path.join(OUT_DIR, names.postIntervention),
        },
        centre,
        plan,
        total > 1,
      );
      continue;
    }
    const outPath = path.join(OUT_DIR, syntheticFilename(flawSuffix, suffix, stamp));
    await clearExistingSyntheticOutput(outPath, total > 1);
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
  ["empty-layer", "Empty-layer flaws (a feature layer present with zero rows):"],
  ["attribute-override", "Attribute-override flaws (valid geometry; out-of-scope column values):"],
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
  --bad               Apply every composable geometric flaw at once.
  --flaw NAME         Emit a fixture targeting one flaw. Repeatable; see below.
  --from PATH|URL     Generate from a Defra metric workbook (xlsx/xlsm).
  --from-list FILE    Generate from every workbook path/URL listed in FILE.
  --mode MODE         ${[...VALID_MODES].join(" | ")} (workbook mode; default ${MODE_BOTH}).
  --centre E,N        RLB centre, BNG/EPSG:27700 (default ${DEFAULT_CENTRE_E},${DEFAULT_CENTRE_N}).
  --strict-habitats   Fail on unmapped habitat types instead of warning.
  --inspect           Print a workbook summary as JSON (requires --from).
  -h, --help          Show this help and exit.

Flaw catalogue (--flaw values; defined in bng-library):
${renderFlawCatalogue()}

Flaws of different categories cannot be mixed. Examples:
  node scripts/gen-gpkg.mjs --size 30
  node scripts/gen-gpkg.mjs --bad
  node scripts/gen-gpkg.mjs --flaw parcel-too-small
  node scripts/gen-gpkg.mjs --from ./metric.xlsm --mode baseline
  node scripts/gen-gpkg.mjs --size 3 --pair \
    --habitat "Intertidal hard structures - Artificial hard structures with integrated greening of grey infrastructure (IGGI)"`,
  );
}

// Flag combinations parseArgs can't express on its own. Lives outside main()
// so neither function carries the whole argument surface's branching.
function assertFlagCombinationsValid() {
  if (args.inspect && !args.from) {
    error("--inspect requires --from <path-or-url>");
    process.exit(1);
  }
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

async function main() {
  if (args.help) {
    printHelp();
    return;
  }
  assertFlagCombinationsValid();
  const centre = parseCentre(args.centre) ?? [DEFAULT_CENTRE_E, DEFAULT_CENTRE_N];

  if (args["from-list"]) {
    await runFromList(args["from-list"], centre);
    return;
  }
  if (args.from) {
    await runFromWorkbook(args.from, {
      strict: args["strict-habitats"],
      inspect: args.inspect,
      centre,
      mode: selectedMode,
    });
    return;
  }
  await runSynthetic(centre);
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
