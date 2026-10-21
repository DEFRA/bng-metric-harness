/**
 * Single-file lineage check for BNG Service GeoPackages (BMD-1081).
 *
 *   npm run check:lineage -- <file.gpkg> [more.gpkg …]
 *   npm run check:lineage -- --dir example-files/service-template
 *
 * Each post-intervention feature must name its baseline parent by Parent
 * Ref, parent_uuid and parent_geom. A file named for a lineage flaw must
 * report exactly that flaw; every other file must report none. Legacy files
 * are skipped (check those pairs with check-gpkg-pair). Exits 1 if any file
 * fails.
 */

import { readdirSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { error, header, info, warn } from "./_lib.mjs";
import { checkFile } from "./lineage-check.mjs";

const { values: args, positionals } = parseArgs({
  options: { dir: { type: "string" }, help: { type: "boolean", short: "h" } },
  allowPositionals: true,
});

const USAGE = `Usage: npm run check:lineage -- <file.gpkg> [more.gpkg …]
   or: npm run check:lineage -- --dir DIR   (every .gpkg under DIR)`;

function gpkgFilesUnder(dir) {
  return readdirSync(dir, { recursive: true })
    .filter((name) => name.endsWith(".gpkg"))
    .sort()
    .map((name) => path.join(dir, name));
}

function describe(result) {
  if (result.status === "skip") {
    return `skipped: ${result.reason}`;
  }
  if (result.problems.length === 0) {
    return "no lineage problems";
  }
  const named = result.expected ? `, as its name says` : "";
  return result.status === "pass"
    ? `reports ${result.expected}${named}`
    : `${result.problems.length} lineage problem(s)${result.expected ? `, but its name says ${result.expected}` : ""}`;
}

function main() {
  if (args.help) {
    info(USAGE);
    return 0;
  }
  const files = args.dir ? gpkgFilesUnder(args.dir) : positionals;
  if (files.length === 0) {
    error(args.dir ? `No .gpkg files under ${args.dir}` : USAGE);
    return 1;
  }
  header(`check:lineage: ${files.length} file(s)`, "cyan");
  const counts = { pass: 0, fail: 0, skip: 0 };
  for (const file of files) {
    const result = checkFile(file, path.basename(file));
    counts[result.status] += 1;
    const line = `${file}: ${describe(result)}`;
    if (result.status === "fail") {
      error(line);
      for (const p of result.problems) {
        error(`    ${p.flaw}  ${p.table} ${p.ref ?? "(no ref)"}: ${p.detail}`);
      }
    } else if (result.status === "skip") {
      warn(line);
    } else {
      info(`✔ ${line}`);
    }
  }
  info(
    `\n${counts.pass} passed, ${counts.fail} failed, ${counts.skip} skipped (not BNG Service)`,
  );
  return counts.fail === 0 ? 0 : 1;
}

process.exit(main());
