#!/usr/bin/env node

/**
 * Permutations runner (BMD-934).
 *
 * Generates a pre-built set of paired baseline / post-intervention GeoPackages
 * covering the BNG testing scenarios catalogued in
 * `scripts/permutations/catalogue.mjs` — intervention categories across the
 * three habitat types, condition and strategic-significance spreads, met/unmet
 * 10% net gain (verified against the real metric engine), low→medium
 * distinctiveness trading, enhancement/creation advance & delay years, and
 * complete vs incomplete data.
 *
 * Output is organised one sub-folder per purpose under `test-data/permutations/`
 * (override with --outdir), with a top-level `manifest.json` and `index.md`.
 *
 * Usage:
 *   node scripts/gen-gpkg-permutations.mjs
 *   node scripts/gen-gpkg-permutations.mjs --only net-gain
 *   node scripts/gen-gpkg-permutations.mjs --outdir /tmp/perms
 *   node scripts/gen-gpkg-permutations.mjs --list
 */

import path from "node:path";
import { parseArgs } from "node:util";
import { error, HARNESS_ROOT, header, info } from "./_lib.mjs";
import { PURPOSES, SCENARIOS } from "./permutations/catalogue.mjs";
import { runPermutations } from "./permutations/runner.mjs";
import { writeManifest } from "./permutations/manifest.mjs";

const { values: args } = parseArgs({
  options: {
    outdir: { type: "string", default: "" },
    only: { type: "string", default: "" },
    list: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: false,
});

function printHelp() {
  console.log(
    `Usage: node scripts/gen-gpkg-permutations.mjs [options]

Generates paired baseline / post-intervention GeoPackages for every scenario in
the permutations catalogue, organised by purpose.

Options:
  --outdir DIR   Output root (default: <harness>/test-data/permutations).
  --only PURPOSE Restrict to one purpose (${PURPOSES.join(", ")}).
  --list         List the catalogue (scenario id, purpose, title) and exit.
  -h, --help     Show this help and exit.`,
  );
}

function printList() {
  header("Permutations catalogue", "cyan");
  for (const purpose of PURPOSES) {
    info(`\n${purpose}`);
    for (const scenario of SCENARIOS.filter((s) => s.purpose === purpose)) {
      info(`  ${scenario.id.padEnd(34)} ${scenario.title}`);
    }
  }
  info(`\n${SCENARIOS.length} scenarios across ${PURPOSES.length} purposes.`);
}

async function main() {
  if (args.help) {
    printHelp();
    return;
  }
  if (args.list) {
    printList();
    return;
  }
  if (args.only && !PURPOSES.includes(args.only)) {
    error(`Unknown purpose "${args.only}". Known: ${PURPOSES.join(", ")}`);
    process.exit(1);
  }

  const outRoot = args.outdir
    ? path.resolve(args.outdir)
    : path.resolve(HARNESS_ROOT, "test-data", "permutations");

  const entries = await runPermutations({
    outRoot,
    only: args.only || undefined,
  });
  if (entries.length === 0) {
    return;
  }

  const purposes = PURPOSES.filter((p) => entries.some((e) => e.purpose === p));
  const { manifestPath, indexPath } = writeManifest(outRoot, entries, purposes);
  info(`\n✔ ${entries.length} scenario pair(s) written to ${outRoot}`);
  info(`  manifest: ${manifestPath}`);
  info(`  index:    ${indexPath}`);
}

main().catch((err) => {
  error(err.stack || err.message || String(err));
  process.exit(1);
});
