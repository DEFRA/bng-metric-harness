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

import Database from "better-sqlite3";
import { readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const { values: args, positionals } = parseArgs({
  options: {
    dir: { type: "string", default: "" },
  },
  allowPositionals: true,
});

const LAYERS = [
  {
    table: "Habitats",
    refCol: "Parcel Ref",
    proposedCols: [
      "Proposed Broad Habitat Type",
      "Proposed Habitat Type",
      "Proposed Condition",
      "Proposed Strategic Significance",
      "Proposed Distinctiveness",
    ],
  },
  {
    table: "Hedgerows",
    refCol: "Parcel Ref",
    proposedCols: [
      "Proposed Hedge Type",
      "Proposed Condition",
      "Proposed Strategic Significance",
      "Proposed Distinctiveness",
    ],
  },
  {
    table: "Rivers",
    refCol: "Parcel Ref",
    proposedCols: [
      "Proposed River Type",
      "Proposed Condition",
      "Proposed Strategic Significance",
      "Proposed Distinctiveness",
      "Proposed Encroachment into Watercourse",
      "Proposed Encroachment into riparian zone",
    ],
  },
  {
    table: "Urban Trees",
    refCol: "Tree Ref",
    proposedCols: [
      "Proposed Tree Size",
      "Proposed Condition",
      "Proposed Strategic Significance",
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
    if (r.n > 0) failures.push(`${layer.table}: ${r.n} row(s) have populated Proposed/Retention columns`);
  }
  return failures;
}

function checkRedlineMatches(baseDb, postDb) {
  const b = baseDb.prepare(`SELECT HEX(geometry) AS g, Area FROM "Red Line Boundary"`).get();
  const p = postDb.prepare(`SELECT HEX(geometry) AS g, Area FROM "Red Line Boundary"`).get();
  if (!b || !p) return [`Red Line Boundary missing in one file`];
  if (b.g !== p.g) return [`Red Line Boundary geometry differs between baseline and post-intervention`];
  if (b.Area !== p.Area) return [`Red Line Boundary area differs: baseline=${b.Area} post=${p.Area}`];
  return [];
}

function stripSuffix(ref) {
  // H001a → H001, HG003b → HG003, R012 → R012 (no change), T007 → T007
  return ref.replace(/([a-z])$/i, "");
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
      const ref = row.r;
      if (!ref) continue;
      if (row.rc === "Created") continue; // fresh refs allowed
      const stripped = stripSuffix(ref);
      if (!baseRefs.has(stripped) && !baseRefs.has(ref)) {
        failures.push(`${layer.table}: post-intervention ref "${ref}" has no matching baseline ref`);
      }
    }
  }
  return failures;
}

function checkPair(baselinePath, postPath) {
  const base = new Database(baselinePath, { readonly: true });
  const post = new Database(postPath, { readonly: true });
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
    if (!m) continue;
    const key = `${m[1]}|${m[3]}`;
    const slot = pairs.get(key) ?? {};
    slot[m[2]] = path.join(dir, f);
    pairs.set(key, slot);
  }
  return [...pairs.values()].filter((p) => p.baseline && p["post-intervention"]);
}

function main() {
  let pairs;
  if (args.dir) {
    pairs = findPairs(args.dir).map((p) => [p.baseline, p["post-intervention"]]);
    if (pairs.length === 0) {
      console.error(`No baseline / post-intervention pairs found in ${args.dir}`);
      process.exit(1);
    }
  } else {
    if (positionals.length !== 2) {
      console.error("Usage: node scripts/check-gpkg-pair.mjs <baseline.gpkg> <post-intervention.gpkg>");
      console.error("   or: node scripts/check-gpkg-pair.mjs --dir test-data/");
      process.exit(1);
    }
    pairs = [positionals];
  }

  let total = 0;
  let bad = 0;
  for (const [b, p] of pairs) {
    if (!existsSync(b) || !existsSync(p)) {
      console.error(`Missing file: ${b} / ${p}`);
      bad++;
      continue;
    }
    total++;
    const failures = checkPair(b, p);
    const label = `${path.basename(b)} ↔ ${path.basename(p)}`;
    if (failures.length === 0) {
      console.log(`✔ ${label}`);
    } else {
      bad++;
      console.log(`✘ ${label}`);
      for (const f of failures) console.log(`    ${f}`);
    }
  }
  console.log(`\n${total - bad}/${total} pair(s) passed`);
  process.exit(bad === 0 ? 0 : 1);
}

main();
