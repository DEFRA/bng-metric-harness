#!/usr/bin/env node

/**
 * Validate that a generated <name>-baseline-*.gpkg and its paired
 * <name>-post-intervention-*.gpkg satisfy the following:
 *
 *   1. The baseline file's Proposed* columns and Retention Category are NULL
 *      across every feature layer.
 *   2. The post-intervention file's Red Line Boundary geometry is identical
 *      to the baseline file's (byte-for-byte).
 *   3. Every post-intervention Parcel Ref / Tree Ref either matches a
 *      baseline ref exactly, is a letter-suffixed variant of one (e.g. H001
 *      → H001a), or is a fresh ref for a Created row. Parcel Refs are
 *      compared as the backend stores them (cleanParcelRef), since that is
 *      what it matches a post-intervention feature to its baseline on.
 *
 * Usage:
 *   node scripts/check-gpkg-pair.mjs <baseline.gpkg> <post-intervention.gpkg>
 *
 * Or to scan all paired files in a directory and every folder under it
 * (point --dir at one folder to check only what is in it):
 *   node scripts/check-gpkg-pair.mjs --dir test-data/
 *   node scripts/check-gpkg-pair.mjs --dir example-files   # the legacy corpus
 *
 * A pair is found by any of the names the harness gives one: generate:gpkg's
 * <name>-baseline-<stamp>.gpkg, the curated corpus's "Baseline - <name>.gpkg"
 * and "Post-intervention - <name>.gpkg", and the permutation and BNG500
 * corpora's <name>-baseline.gpkg and <name>-post-intervention.gpkg. A legacy
 * file may leave a layer's table out; it is read as a layer with no rows.
 * Paths must be inside the harness, where the corpus and test-data/ live.
 * Each pair is labelled by its baseline's path under --dir, so pairs that
 * share a name in different folders are told apart. A pair that cannot be
 * read (not a GeoPackage, say) is reported as failing, and the scan goes on.
 *
 * Exits 0 on success, 1 on any failure. Prints one summary line per pair.
 */

import { readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { openGeoPackageReadonly } from "#gpkg-io";
import { resolveInsideHarness } from "./_lib.mjs";
import {
  COL_PARCEL_REF,
  COL_TREE_REF,
  LAYER_URBAN_TREES,
} from "./gpkg-columns.mjs";

const { values: args, positionals } = parseArgs({
  options: {
    dir: { type: "string", default: "" },
  },
  allowPositionals: true,
});

// Column names duplicated across the four layer schemas — keep them as named
// constants so any rename only happens in one place.
const COL_PROPOSED_CONDITION = "Proposed Condition";
const COL_PROPOSED_STRATEGIC_SIG = "Proposed Strategic Significance";
const COL_PROPOSED_DISTINCTIVENESS = "Proposed Distinctiveness";

const LAYERS = [
  {
    table: "Habitats",
    refCol: COL_PARCEL_REF,
    proposedCols: [
      "Proposed Broad Habitat Type",
      "Proposed Habitat Type",
      COL_PROPOSED_CONDITION,
      COL_PROPOSED_STRATEGIC_SIG,
      COL_PROPOSED_DISTINCTIVENESS,
    ],
  },
  {
    table: "Hedgerows",
    refCol: COL_PARCEL_REF,
    proposedCols: [
      "Proposed Hedge Type",
      COL_PROPOSED_CONDITION,
      COL_PROPOSED_STRATEGIC_SIG,
      COL_PROPOSED_DISTINCTIVENESS,
    ],
  },
  {
    table: "Rivers",
    refCol: COL_PARCEL_REF,
    proposedCols: [
      "Proposed River Type",
      COL_PROPOSED_CONDITION,
      COL_PROPOSED_STRATEGIC_SIG,
      COL_PROPOSED_DISTINCTIVENESS,
      "Proposed Encroachment into Watercourse",
      "Proposed Encroachment into riparian zone",
    ],
  },
  {
    table: LAYER_URBAN_TREES,
    refCol: COL_TREE_REF,
    proposedCols: [
      "Proposed Tree Size",
      COL_PROPOSED_CONDITION,
      COL_PROPOSED_STRATEGIC_SIG,
      "Proposed Tree Type",
      "Proposed Rural or Urban Tree",
    ],
  },
];

function tableExists(db, table) {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
  );
}

/** A layer's rows by `sql`, or none when the file leaves the layer's table out. */
function layerRows(db, table, sql) {
  return tableExists(db, table) ? db.prepare(sql).all() : [];
}

function checkBaselineNulls(db) {
  const failures = [];
  for (const layer of LAYERS.filter((l) => tableExists(db, l.table))) {
    const where = layer.proposedCols
      .map((c) => `"${c}" IS NOT NULL`)
      .concat([`"Retention Category" IS NOT NULL`])
      .join(" OR ");
    const r = db.prepare(`SELECT COUNT(*) AS n FROM "${layer.table}" WHERE ${where}`).get();
    if (r.n > 0) {
      failures.push(`${layer.table}: ${r.n} row(s) have populated Proposed/Retention columns`);
    }
  }
  return failures;
}

function checkRedlineMatches(baseDb, postDb) {
  const sql = `SELECT HEX(geometry) AS g, Area FROM "Red Line Boundary"`;
  const [b, p] = [baseDb, postDb].map((db) => layerRows(db, "Red Line Boundary", sql)[0]);
  if (!b || !p) {
    return [`Red Line Boundary missing in one file`];
  }
  if (b.g !== p.g) {
    return [`Red Line Boundary geometry differs between baseline and post-intervention`];
  }
  if (b.Area !== p.Area) {
    return [`Red Line Boundary area differs: baseline=${b.Area} post=${p.Area}`];
  }
  return [];
}

// The backend's MAX_HABITAT_REF_LENGTH (validation/geopackage/habitat-ref-check.js).
const MAX_PARCEL_REF_LENGTH = 100;

/**
 * A Parcel Ref as the backend stores it (cleanHabitatRef, BMD-1058): trimmed,
 * cut to MAX_PARCEL_REF_LENGTH code points, then trimmed again. Tree Refs are
 * not cleaned, so are compared as they are.
 */
function cleanParcelRef(ref) {
  if (typeof ref !== "string" && typeof ref !== "number") {
    return ref;
  }
  const characters = Array.from(String(ref).trim());
  return characters.slice(0, MAX_PARCEL_REF_LENGTH).join("").trimEnd();
}

function stripSuffix(ref) {
  // H001a → H001, HG003b → HG003, R012 → R012 (no change), T007 → T007
  return ref.replace(/([a-z])$/i, "");
}

/**
 * Decide whether a single post-intervention ref traces back to a baseline.
 * Used inside checkRefsTraceBack to keep the inner loop linear-flow only.
 */
function checkPostRowRef(row, baseRefs, table, failures) {
  const ref = row.r;
  if (!ref || row.rc === "Created") {
    return;
  }
  const stripped = stripSuffix(ref);
  if (!baseRefs.has(stripped) && !baseRefs.has(ref)) {
    failures.push(`${table}: post-intervention ref "${ref}" has no matching baseline ref`);
  }
}

function checkRefsTraceBack(baseDb, postDb) {
  const failures = [];
  for (const layer of LAYERS) {
    const clean = layer.refCol === COL_PARCEL_REF ? cleanParcelRef : (ref) => ref;
    const baseRefs = new Set(
      layerRows(baseDb, layer.table, `SELECT "${layer.refCol}" AS r FROM "${layer.table}"`).map((x) =>
        clean(x.r),
      ),
    );
    const postRows = layerRows(
      postDb,
      layer.table,
      `SELECT "${layer.refCol}" AS r, "Retention Category" AS rc FROM "${layer.table}"`,
    ).map((row) => ({ ...row, r: clean(row.r) }));
    for (const row of postRows) {
      checkPostRowRef(row, baseRefs, layer.table, failures);
    }
  }
  return failures;
}

function checkPair(baselinePath, postPath) {
  let base = null;
  let post = null;
  try {
    base = openGeoPackageReadonly(baselinePath);
    post = openGeoPackageReadonly(postPath);
    const failures = [
      ...checkBaselineNulls(base),
      ...checkRedlineMatches(base, post),
      ...checkRefsTraceBack(base, post),
    ];
    return failures;
  } catch (err) {
    return [`cannot check this pair: ${err.message}`];
  } finally {
    base?.close();
    post?.close();
  }
}

// The names a pair's files take. Each names the pair (`name`, and `stamp`
// for generate:gpkg's) and the stage (`side`).
const PAIR_NAMES = [
  // generate:gpkg: <name>-baseline-20260101-1200-00.gpkg
  /^(?<name>.+)-(?<side>baseline|post-intervention)-(?<stamp>\d{8}-\d{4}-\d{2})\.gpkg$/,
  // The curated corpus: "Baseline - <name>.gpkg", "Post-intervention - <name>.gpkg"
  /^(?<side>Baseline|Post-intervention) - (?<name>.+)\.gpkg$/,
  // The permutation and BNG500 corpora: <name>-baseline.gpkg
  /^(?<name>.+)-(?<side>baseline|post-intervention)\.gpkg$/,
];

/** The pair a file belongs to, as { key, side }, or null if it is no pair's. */
function pairSide(relativePath) {
  const fileName = path.basename(relativePath);
  const match = PAIR_NAMES.map((pattern) => pattern.exec(fileName)).find(Boolean);
  if (!match) {
    return null;
  }
  const { name, side, stamp = "" } = match.groups;
  return { key: [path.dirname(relativePath), name, stamp].join("|"), side: side.toLowerCase() };
}

/** Every baseline / post-intervention pair under `dir`, in path order. */
function findPairs(dir) {
  const files = readdirSync(dir, { recursive: true }).sort((a, b) => a.localeCompare(b));
  const pairs = new Map();
  for (const f of files) {
    const found = pairSide(f);
    if (!found) {
      continue;
    }
    const slot = pairs.get(found.key) ?? {};
    slot[found.side] = path.join(dir, f);
    pairs.set(found.key, slot);
  }
  return [...pairs.values()].filter((p) => p.baseline && p["post-intervention"]);
}

/** A path inside the harness, where the corpus and test-data/ live; exits if not. */
function insideHarnessOrExit(target, flag) {
  let resolved = null;
  try {
    resolved = resolveInsideHarness(target, flag);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  return resolved;
}

// --dir, resolved inside the harness; empty when files are named instead.
const scanDir = args.dir ? insideHarnessOrExit(args.dir, "--dir") : "";

function resolvePairsFromArgs() {
  if (scanDir) {
    const pairs = findPairs(scanDir).map((p) => [p.baseline, p["post-intervention"]]);
    if (pairs.length === 0) {
      console.error(`No baseline / post-intervention pairs found in ${args.dir}`);
      process.exit(1);
    }
    return pairs;
  }
  if (positionals.length !== 2) {
    console.error("Usage: node scripts/check-gpkg-pair.mjs <baseline.gpkg> <post-intervention.gpkg>");
    console.error("   or: node scripts/check-gpkg-pair.mjs --dir test-data/");
    process.exit(1);
  }
  return [positionals.map((file) => insideHarnessOrExit(file, "file"))];
}

/**
 * A pair's label: its baseline's path under --dir (as given, without it),
 * so same-named pairs in different folders read differently.
 */
function pairLabel(baselinePath, postPath) {
  const baseline = scanDir ? path.relative(scanDir, baselinePath) : baselinePath;
  return `${baseline} ↔ ${path.basename(postPath)}`;
}

function runPair(baselinePath, postPath) {
  if (!existsSync(baselinePath) || !existsSync(postPath)) {
    console.error(`Missing file: ${baselinePath} / ${postPath}`);
    return { counted: false, ok: false };
  }
  const failures = checkPair(baselinePath, postPath);
  const label = pairLabel(baselinePath, postPath);
  if (failures.length === 0) {
    console.log(`✔ ${label}`);
    return { counted: true, ok: true };
  }
  console.log(`✘ ${label}`);
  for (const f of failures) {
    console.log(`    ${f}`);
  }
  return { counted: true, ok: false };
}

function main() {
  const pairs = resolvePairsFromArgs();
  let total = 0;
  let bad = 0;
  for (const [b, p] of pairs) {
    const result = runPair(b, p);
    if (result.counted) {
      total++;
    }
    if (!result.ok) {
      bad++;
    }
  }
  console.log(`\n${total - bad}/${total} pair(s) passed`);
  process.exit(bad === 0 ? 0 : 1);
}

main();
