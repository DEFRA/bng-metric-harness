/**
 * Single-file lineage check for BNG Service GeoPackages (BMD-1081).
 *
 *   npm run check:lineage -- <file.gpkg> [more.gpkg …]
 *   npm run check:lineage -- --dir example-files/service-template
 *
 * Each post-intervention feature must name its baseline parent by Parent
 * Ref, parent_uuid and parent_geom. A file named for a lineage flaw must
 * report exactly that flaw; every other file must report none. Legacy files
 * are skipped (check those pairs with check-gpkg-pair). Paths must be inside
 * the harness, where the corpus and test-data/ live. Exits 1 if any file
 * fails.
 */

import { readdirSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { error, header, info, resolveInsideHarness, warn } from "./_lib.mjs";
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

/**
 * The files to check: every .gpkg under --dir, or the files named. Each is
 * resolved inside the harness, where the corpus and test-data/ live; a path
 * outside it is refused.
 */
function filesToCheck() {
  if (args.dir) {
    return gpkgFilesUnder(resolveInsideHarness(args.dir, "--dir"));
  }
  return positionals.map((file) => resolveInsideHarness(file, "file"));
}

function failureText(result) {
  const count = `${result.problems.length} lineage problem(s)`;
  return result.expected
    ? `${count}, but its name says ${result.expected}`
    : count;
}

function describe(result) {
  if (result.status === "skip") {
    return `skipped: ${result.reason}`;
  }
  if (result.status === "fail") {
    return failureText(result);
  }
  return result.expected
    ? `reports ${result.expected}, as its name says`
    : "no lineage problems";
}

/** Log one file's result, and its problems if it failed. */
function report(file, result) {
  const line = `${file}: ${describe(result)}`;
  if (result.status === "pass") {
    info(`✔ ${line}`);
    return;
  }
  if (result.status === "skip") {
    warn(line);
    return;
  }
  error(line);
  for (const p of result.problems) {
    error(`    ${p.flaw}  ${p.table} ${p.ref ?? "(no ref)"}: ${p.detail}`);
  }
}

/**
 * Check one file. A file that cannot be read (corrupt, or not a GeoPackage)
 * fails with the reason, and the other files are still checked.
 */
function checkOne(file) {
  try {
    return checkFile(file, path.basename(file));
  } catch (err) {
    return {
      status: "fail",
      expected: null,
      problems: [
        {
          flaw: "unreadable-file",
          table: "(file)",
          ref: null,
          detail: err.message,
        },
      ],
    };
  }
}

function checkAll(files) {
  header(`check:lineage: ${files.length} file(s)`, "cyan");
  const counts = { pass: 0, fail: 0, skip: 0 };
  for (const file of files) {
    const result = checkOne(file);
    counts[result.status] += 1;
    report(file, result);
  }
  info(
    `\n${counts.pass} passed, ${counts.fail} failed, ${counts.skip} skipped (not BNG Service)`,
  );
  return counts.fail === 0 ? 0 : 1;
}

function main() {
  if (args.help) {
    info(USAGE);
    return 0;
  }
  let files;
  try {
    files = filesToCheck();
  } catch (err) {
    error(err.message);
    return 1;
  }
  if (files.length === 0) {
    error(args.dir ? `No .gpkg files under ${args.dir}` : USAGE);
    return 1;
  }
  return checkAll(files);
}

process.exit(main());
