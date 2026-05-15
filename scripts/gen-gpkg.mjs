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
 *      --count to produce N varied files at once. Emits one file per run.
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
 * backend's geometry validation. --bad is a shorthand for "apply every
 * composable geometric flaw"; a single --flaw <name> produces a minimal
 * fixture targeting one validator. Two families:
 *
 *   Geometric flaws — each maps to a backend validation error code:
 *     self-intersecting-redline   REDLINE_INVALID_GEOMETRY
 *     bowtie-parcel               AREA_PARCELS_INVALID_GEOMETRY
 *     overlapping-parcels         PARCEL_OVERLAPS
 *     parcel-outside-redline      AREA_PARCELS_OUTSIDE_REDLINE
 *     sliver                      SLIVERS_INSIDE_REDLINE
 *     hedgerow-outside            HEDGEROWS_OUTSIDE_REDLINE
 *     watercourse-outside         WATERCOURSES_OUTSIDE_REDLINE
 *     tree-outside                TREES_OUTSIDE_REDLINE
 *     iggi-outside                IGGIS_OUTSIDE_REDLINE
 *     area-sum-mismatch           AREA_SUM_MISMATCH
 *     redline-not-in-england      REDLINE_OUTSIDE_ENGLAND   (standalone)
 *     redline-too-large           REDLINE_AREA_TOO_LARGE    (standalone)
 *
 *   Empty-layer flaws — structurally valid full-size fixture with one
 *   feature layer present but containing zero rows:
 *     no-habitats                 NO_HABITAT_AREAS
 *     no-hedgerows / no-rivers / no-trees   (no specific backend error)
 *
 * --flaw is repeatable; empty-layer and geometric flaws cannot be mixed.
 *
 * This file is the CLI + orchestration. Domain logic is grouped by concern:
 *   - lib/bng-schema.mjs      — BNG SRS, the 5 feature-table DDLs, BNG layer
 *                               styles. Wraps the generic #gpkg-io package
 *                               with BNG-specific defaults.
 *   - lib/geometry.mjs        — pure geometry helpers
 *   - lib/synthetic/          — synthetic generators
 *       synthetic.mjs            random fixture (regular + empty-layer)
 *       synthetic-bad.mjs        --bad / --flaw fixture builder
 *       synthetic-constants.mjs  pick-lists + bad-fixture geometry tunables
 *       flaws.mjs                flaw registry + CLI resolution
 *   - lib/workbook/           — workbook-driven path
 *       metric-workbook*.mjs     xlsx parsing
 *       workbook-rows.mjs        row builders (pure data transformations)
 *       workbook-layers*.mjs     row → gpkg writers + geometry derivation
 *
 * Generic GeoPackage I/O (WKB, gpkg_* tables, generic styles) lives in
 * packages/gpkg-io and is imported as `#gpkg-io`. The package has no
 * BNG knowledge; it could be moved to its own repo unchanged.
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
import { color, error, header, info, warn } from "./_lib.mjs";
import { readMetricWorkbook } from "./lib/workbook/metric-workbook.mjs";
import { closeGeoPackage, envelopeFromCoords, gpkgPolygon } from "#gpkg-io";
import {
  SRS_ID,
  createAllTables,
  createLayerStyles,
  openGeoPackage,
  registerLayer,
} from "./lib/bng-schema.mjs";
import { polygonArea } from "./lib/geometry.mjs";
import { generateOne } from "./lib/synthetic/synthetic.mjs";
import { resolveFlawSelection } from "./lib/synthetic/flaws.mjs";
import {
  FEATURE_REF_PAD,
  FEATURE_REF_PAD_CHAR,
  buildBaselineRows,
  buildPostInterventionRows,
} from "./lib/workbook/workbook-rows.mjs";
import {
  MIN_GENERATED_AREA_SQ_M,
  computeWorkbookFixturePlan,
  derivePostInterventionHabitatCells,
  derivePostInterventionLinearCoords,
  derivePostInterventionTreePoints,
  generateBaselineHedgerowGeometry,
  generateBaselineRiverGeometry,
  generateBaselineTreePoints,
  generateRedLineBoundaryFromArea,
  partitionBaselineHabitats,
  writeHabitatsBaseline,
  writeHabitatsPostIntervention,
  writeHedgerowsBaseline,
  writeHedgerowsPostIntervention,
  writeRiversBaseline,
  writeRiversPostIntervention,
  writeUrbanTreesBaseline,
  writeUrbanTreesPostIntervention,
} from "./lib/workbook/workbook-layers.mjs";

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
  },
  allowPositionals: false,
});

const MODE_BASELINE = "baseline";
const MODE_POST_INTERVENTION = "post-intervention";
const MODE_BOTH = "both";
const VALID_MODES = new Set([MODE_BASELINE, MODE_POST_INTERVENTION, MODE_BOTH]);
const selectedMode = args.mode ?? MODE_BOTH;
if (!VALID_MODES.has(selectedMode)) {
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

// ---------------------------------------------------------------------------
// Workbook-driven orchestration: produce a baseline file, optionally produce
// a post-intervention file that reuses the baseline's geometry.
// ---------------------------------------------------------------------------

/**
 * Generate the baseline GeoPackage. Lays out the RLB, partitions habitats,
 * picks linear feature routes and tree positions. Returns the geometry it
 * produced so the post-intervention pass can derive from it.
 */
function generateBaselineFile(outPath, _workbook, baselineRows, plan, centre) {
  const [cx, cy] = centre;
  const db = openGeoPackage(outPath);
  createAllTables(db);

  const ring = generateRedLineBoundaryFromArea(db, cx, cy, plan.totalAreaM2);

  const { cells: habitatCells, byRef: habitatCellsByRef } =
    partitionBaselineHabitats(ring, baselineRows.habitats);
  const habitatsWritten = writeHabitatsBaseline(db, habitatCells, baselineRows.habitats);

  const { coordsList: hedgeCoords, byRef: hedgeCoordsByRef } =
    generateBaselineHedgerowGeometry(ring, baselineRows.hedgerows);
  const hedgesWritten = writeHedgerowsBaseline(db, hedgeCoords, baselineRows.hedgerows);

  const { coordsList: riverCoords, byRef: riverCoordsByRef } =
    generateBaselineRiverGeometry(ring, baselineRows.rivers);
  const riversWritten = writeRiversBaseline(db, riverCoords, baselineRows.rivers);

  const { points: treePoints, byRef: treePointsByRef } =
    generateBaselineTreePoints(ring, baselineRows.trees);
  const treesWritten = writeUrbanTreesBaseline(db, treePoints, baselineRows.trees);

  createLayerStyles(db);
  closeGeoPackage(db);

  return {
    ring,
    habitatCellsByRef,
    hedgeCoordsByRef,
    riverCoordsByRef,
    treePointsByRef,
    written: {
      habitats: habitatsWritten,
      hedgerows: hedgesWritten,
      rivers: riversWritten,
      trees: treesWritten,
    },
  };
}

/**
 * Generate the post-intervention GeoPackage, reusing the baseline RLB and
 * deriving each layer's geometry from the baseline's.
 */
function generatePostInterventionFile(outPath, workbook, postRows, baselineGeom, plan) {
  const db = openGeoPackage(outPath);
  createAllTables(db);

  // Reuse the exact baseline ring rather than regenerating, so the two files
  // share an identical RLB (story acceptance criterion).
  const ring = baselineGeom.ring;
  const geom = gpkgPolygon(SRS_ID, ring);
  db.prepare(`INSERT INTO "Red Line Boundary" (geometry, "Area", "Site Name") VALUES (?, ?, ?)`)
    .run(geom, Math.round(polygonArea(ring)), plan.siteName);
  registerLayer(db, "Red Line Boundary", "POLYGON", envelopeFromCoords(ring));

  const habitatCells = derivePostInterventionHabitatCells(
    baselineGeom.habitatCellsByRef,
    workbook.habitats.baseline,
    postRows.habitats,
    postRows.warnings,
  );
  const habitatsWritten = writeHabitatsPostIntervention(db, habitatCells, postRows.habitats);

  const hedgeCoords = derivePostInterventionLinearCoords(ring, baselineGeom.hedgeCoordsByRef, postRows.hedgerows);
  const hedgesWritten = writeHedgerowsPostIntervention(db, hedgeCoords, postRows.hedgerows);

  const riverCoords = derivePostInterventionLinearCoords(ring, baselineGeom.riverCoordsByRef, postRows.rivers);
  const riversWritten = writeRiversPostIntervention(db, riverCoords, postRows.rivers);

  const treePoints = derivePostInterventionTreePoints(ring, baselineGeom.treePointsByRef, postRows.trees);
  const treesWritten = writeUrbanTreesPostIntervention(db, treePoints, postRows.trees);

  createLayerStyles(db);
  closeGeoPackage(db);

  return {
    written: {
      habitats: habitatsWritten,
      hedgerows: hedgesWritten,
      rivers: riversWritten,
      trees: treesWritten,
    },
  };
}

function logWorkbookFixtureBanner({
  workbook,
  sourceLabel,
  centre,
  outPath,
  habitatRows,
  plan,
  mode,
}) {
  header(`Generating BNG GeoPackage from workbook`, "cyan");
  info(`  source: ${sourceLabel}`);
  info(
    `  site: ${plan.siteName} (${workbook.siteInfo.planningAuthority ?? "unknown LPA"})`,
  );
  info(`  mode: ${mode ?? MODE_BOTH}`);
  info(
    `  total area: ${plan.totalAreaHa.toFixed(4)} ha (${Math.round(plan.totalAreaM2)} m²)`,
  );
  info(
    `  habitats: ${habitatRows.length} (${workbook.habitats.baseline.length} baseline, ` +
      `${workbook.habitats.created.length} created, ${workbook.habitats.enhancements.length} enhanced)`,
  );
  info(
    `  hedgerows: ${workbook.hedgerows.baseline.length} baseline + ${workbook.hedgerows.created.length} created`,
  );
  info(
    `  rivers: ${workbook.watercourses.baseline.length} baseline + ${workbook.watercourses.created.length} created`,
  );
  info(
    `  trees: ${workbook.trees.baseline.length} baseline + ${workbook.trees.created.length} created`,
  );
  info(`  centre: ${centre[0]},${centre[1]} (BNG)`);
  info(`  → ${outPath}`);
}

function logWorkbookFileSummary(label, written, outPath) {
  info(
    `  ${label}: ${written.habitats} habitats, ${written.hedgerows} hedgerows, ${written.rivers} rivers, ${written.trees} trees → ${outPath}`,
  );
}

function surfaceWorkbookWarnings(workbook, baselineRows, postRows) {
  for (const w of workbook.summary.warnings) {
    warn(`  ${w}`);
  }
  for (const s of workbook.summary.skipped) {
    warn(`  skipped ${s.sheet}:${s.row} (${s.reason})`);
  }
  for (const r of baselineRows.skipReasons) {
    warn(`  ${r}`);
  }
  if (postRows) {
    for (const r of postRows.skipReasons) {
      warn(`  ${r}`);
    }
    for (const r of postRows.warnings) {
      warn(`  ${r}`);
    }
  }
}

function bannerOutPath(outPaths, mode) {
  if (mode === MODE_BOTH) {
    return `${outPaths.baseline} + ${outPaths.postIntervention}`;
  }
  return outPaths.baseline ?? outPaths.postIntervention;
}

function generateFromWorkbook(
  outPaths,
  workbook,
  sourceLabel,
  { strict = false, centre, mode = MODE_BOTH } = {},
) {
  const baselineRows = buildBaselineRows(workbook, { strict });
  const postRows = mode === MODE_BASELINE ? null : buildPostInterventionRows(workbook, { strict });

  // Use the baseline habitat areas (not the post-intervention sub-areas) to
  // size the RLB so it can hold the full pre-development site.
  const habitatRowsForSizing = baselineRows.habitats.map((r) => ({ area: r.area }));
  const plan = computeWorkbookFixturePlan(workbook, habitatRowsForSizing);

  logWorkbookFixtureBanner({
    workbook,
    sourceLabel,
    centre,
    outPath: bannerOutPath(outPaths, mode),
    habitatRows: baselineRows.habitats,
    plan,
    mode,
  });

  if (plan.totalAreaM2 < MIN_GENERATED_AREA_SQ_M) {
    warn(
      `  total area is < ${MIN_GENERATED_AREA_SQ_M} m² — workbook may be empty or unparseable; aborting`,
    );
    return false;
  }

  // We always need baseline geometry — it's the input to post-intervention
  // derivation. If the user asked for post-intervention only, the baseline
  // pipeline still runs but writes to an in-memory throwaway db.
  const baselineDest = mode === MODE_POST_INTERVENTION ? ":memory:" : outPaths.baseline;
  const baselineGeom = generateBaselineFile(baselineDest, workbook, baselineRows, plan, centre);
  if (mode !== MODE_POST_INTERVENTION) {
    logWorkbookFileSummary("baseline", baselineGeom.written, outPaths.baseline);
  }

  if (mode !== MODE_BASELINE) {
    const postWritten = generatePostInterventionFile(
      outPaths.postIntervention,
      workbook,
      postRows,
      baselineGeom,
      plan,
    );
    logWorkbookFileSummary("post-intervention", postWritten.written, outPaths.postIntervention);
  }

  surfaceWorkbookWarnings(workbook, baselineRows, postRows);
  console.log(color("green", `✔ Done.`));
  return true;
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

// Output basename suffix following `bng-test-data`. Examples:
//   --bad                          → "-bad"
//   --flaw sliver (no --bad)       → "-bad-sliver"
//   --bad --flaw sliver            → "-bad"
//   --flaw no-habitats             → "-no-habitats"
//   --flaw no-habitats no-rivers   → "-no-habitats-no-rivers"
//   (no flaws)                     → ""
// Empty-layer flaws don't get the "bad-" prefix because the file is
// structurally valid — it just has zero rows in one or more layers.
function sortFlawNames(names) {
  return [...names].sort((a, b) => a.localeCompare(b));
}

function buildFlawFilenameSuffix({ bad, flagBad, geometric, emptyFlawNames }) {
  if (emptyFlawNames.length > 0) {
    return `-${sortFlawNames(emptyFlawNames).join("-")}`;
  }
  if (!bad) {
    return "";
  }
  if (flagBad) {
    return "-bad";
  }
  return `-bad-${sortFlawNames(geometric).join("-")}`;
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
  const { geometric, emptyLayers, emptyFlawNames } = resolveFlawSelection({
    bad: args.bad,
    flaws: args.flaw,
  });
  const flawSuffix = buildFlawFilenameSuffix({
    bad: geometric.length > 0,
    flagBad: args.bad,
    geometric,
    emptyFlawNames,
  });
  if (!existsSync(OUT_DIR)) {
    mkdirSync(OUT_DIR, { recursive: true });
  }
  for (let i = 1; i <= total; i++) {
    const suffix = total > 1 ? `-${String(i).padStart(FEATURE_REF_PAD, FEATURE_REF_PAD_CHAR)}` : "";
    const outPath = path.join(OUT_DIR, syntheticFilename(flawSuffix, suffix, timestampSuffix()));
    await clearExistingSyntheticOutput(outPath, total > 1);
    generateOne(outPath, geometric, numParcels, centre, emptyLayers);
  }
}

async function main() {
  if (args.inspect && !args.from) {
    error("--inspect requires --from <path-or-url>");
    process.exit(1);
  }
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
  error(err.stack || err.message || String(err));
  process.exit(1);
});
