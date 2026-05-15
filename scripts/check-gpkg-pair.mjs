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
 *      → H001a), or is a fresh ref for a Created row.
 *
 * Usage:
 *   node scripts/check-gpkg-pair.mjs <baseline.gpkg> <post-intervention.gpkg>
 *
 * Or to scan all paired files in a directory:
 *   node scripts/check-gpkg-pair.mjs --dir test-data/
 *
 * Exits 0 on success, 1 on any failure. Prints one summary line per pair.
 */

import { readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { openGeoPackageReadonly } from "#gpkg-io";

const { values: args, positionals } = parseArgs({
  options: {
    dir: { type: "string", default: "" },
  },
  allowPositionals: true,
});

// Column names duplicated across the four layer schemas — keep them as named
// constants so any rename only happens in one place.
const COL_PARCEL_REF = "Parcel Ref";
const COL_TREE_REF = "Tree Ref";
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
    table: "Urban Trees",
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

function checkBaselineNulls(db) {
  const failures = [];
  for (const layer of LAYERS) {
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
  const b = baseDb.prepare(`SELECT HEX(geometry) AS g, Area FROM "Red Line Boundary"`).get();
  const p = postDb.prepare(`SELECT HEX(geometry) AS g, Area FROM "Red Line Boundary"`).get();
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
    const baseRefs = new Set(
      baseDb.prepare(`SELECT "${layer.refCol}" AS r FROM "${layer.table}"`).all().map((x) => x.r),
    );
    const postRows = postDb
      .prepare(`SELECT "${layer.refCol}" AS r, "Retention Category" AS rc FROM "${layer.table}"`)
      .all();
    for (const row of postRows) {
      checkPostRowRef(row, baseRefs, layer.table, failures);
    }
  }
  return failures;
}

function checkPair(baselinePath, postPath) {
  const base = openGeoPackageReadonly(baselinePath);
  const post = openGeoPackageReadonly(postPath);
  try {
    const failures = [
      ...checkBaselineNulls(base),
      ...checkRedlineMatches(base, post),
      ...checkRefsTraceBack(base, post),
    ];
    return failures;
  } finally {
    base.close();
    post.close();
  }
}

function findPairs(dir) {
  const files = readdirSync(dir);
  const pairs = new Map();
  for (const f of files) {
    const m = f.match(/^(.+)-(baseline|post-intervention)-(\d{8}-\d{4}-\d{2})\.gpkg$/);
    if (!m) {
      continue;
    }
    const [, workbookBase, side, timestamp] = m;
    const key = `${workbookBase}|${timestamp}`;
    const slot = pairs.get(key) ?? {};
    slot[side] = path.join(dir, f);
    pairs.set(key, slot);
  }
  return [...pairs.values()].filter((p) => p.baseline && p["post-intervention"]);
}

function resolvePairsFromArgs() {
  if (args.dir) {
    const pairs = findPairs(args.dir).map((p) => [p.baseline, p["post-intervention"]]);
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
  return [positionals];
}

function runPair(baselinePath, postPath) {
  if (!existsSync(baselinePath) || !existsSync(postPath)) {
    console.error(`Missing file: ${baselinePath} / ${postPath}`);
    return { counted: false, ok: false };
  }
  const failures = checkPair(baselinePath, postPath);
  const label = `${path.basename(baselinePath)} ↔ ${path.basename(postPath)}`;
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
