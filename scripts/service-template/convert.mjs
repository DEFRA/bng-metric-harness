/**
 * Convert a legacy BNG500 pair into the BNG Service template with the
 * template's own converter (BMD-1081: "The BNG500 files are converted with
 * the plugin"), reproducibly.
 *
 * The converter is plugin/bng_template_convert/old_to_new.py in the
 * bng-metric-template sibling (or the checkout BNG_TEMPLATE_DIR names), as it
 * is at CONVERTER_COMMIT: another version may convert differently, so the
 * corpus records which one it was built with. CONVERTER_DIGEST, a SHA-256 of
 * the converter's Python files, checks a checkout has exactly that converter,
 * whether it is at another commit or edited locally; CI clones the commit. scripts/bng500/
 * convert.py runs it with seeded uuids; here its file's timestamps are fixed
 * and the file rewritten with VACUUM, so SQLite lays it out as it does every
 * other fixture, whatever SQLite Python has.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { HARNESS_ROOT, repoPath } from "../_lib.mjs";

export const TEMPLATE_REPO = "bng-metric-template";
export const TEMPLATE_DIR_ENV = "BNG_TEMPLATE_DIR";
/** The bng-metric-template commit the committed bng-500/ files come from. */
export const CONVERTER_COMMIT = "073550c7833d836937939a9d70980f0598201300";
/** converterDigest() of the converter at CONVERTER_COMMIT. */
export const CONVERTER_DIGEST =
  "bea7ae174bc4e9631807d7a71df96f9120c0cfe6234c0251f7eeeb1a496dd1a3";

const CONVERTER_PATH = path.join("plugin", "bng_template_convert");
const WRAPPER = path.join(HARNESS_ROOT, "scripts", "bng500", "convert.py");
const PYTHON = process.platform === "win32" ? "python" : "python3";
// The metadata timestamp bng-library's seeded generator writes.
const FIXED_TIMESTAMP = "2020-01-01T00:00:00.000Z";
const SHORT_COMMIT = 7;

export function templateDir() {
  return process.env[TEMPLATE_DIR_ENV] || repoPath(TEMPLATE_REPO);
}

/**
 * A SHA-256 of the converter's Python files, by name, with line endings
 * normalised so a Windows checkout gives the same digest.
 */
export function converterDigest(converterDir) {
  const hash = createHash("sha256");
  const files = readdirSync(converterDir)
    .filter((name) => name.endsWith(".py"))
    .sort((a, b) => a.localeCompare(b));
  for (const name of files) {
    const text = readFileSync(path.join(converterDir, name), "utf8");
    hash.update(`${name}\n${text.replaceAll("\r\n", "\n")}\n`);
  }
  return hash.digest("hex");
}

function hasPython() {
  return spawnSync(PYTHON, ["--version"], { encoding: "utf8" }).status === 0;
}

/**
 * Why the converter cannot run here, or null if it can: the template
 * checkout is missing, or its converter is not the one at CONVERTER_COMMIT
 * (another commit, or edited locally), or there is no Python. Another
 * converter would write a corpus CI's clean checkout does not.
 */
export function converterProblem() {
  const dir = templateDir();
  const converterDir = path.join(dir, CONVERTER_PATH);
  if (!existsSync(path.join(converterDir, "old_to_new.py"))) {
    return `the ${TEMPLATE_REPO} checkout is missing at ${dir}: run \`npm run bootstrap\`, or set ${TEMPLATE_DIR_ENV}`;
  }
  if (converterDigest(converterDir) !== CONVERTER_DIGEST) {
    return `the converter in ${dir} is not the one the corpus is built with, at ${TEMPLATE_REPO} ${CONVERTER_COMMIT.slice(0, SHORT_COMMIT)} (another commit, or uncommitted changes): check that commit out, or, to move on, update CONVERTER_COMMIT and CONVERTER_DIGEST and regenerate`;
  }
  if (!hasPython()) {
    return `${PYTHON} is not on the PATH`;
  }
  return null;
}

/** Fix the timestamps SQLite stamped at conversion, and rewrite the file. */
function settle(file) {
  const db = new Database(file);
  try {
    db.prepare("UPDATE gpkg_contents SET last_change = ?").run(FIXED_TIMESTAMP);
    db.prepare("UPDATE gpkg_metadata_reference SET timestamp = ?").run(
      FIXED_TIMESTAMP,
    );
    db.exec("VACUUM");
  } finally {
    db.close();
  }
}

/**
 * Convert one legacy pair into `file`. The converter's own output (its
 * report of the steps it leaves to the user) is not needed here: run it by
 * hand to read it.
 */
export function convertPair({ baseline, postIntervention, seed }, file) {
  const result = spawnSync(
    PYTHON,
    [
      WRAPPER,
      "--converter-dir",
      path.join(templateDir(), CONVERTER_PATH),
      "--seed",
      String(seed),
      "--baseline",
      path.join(HARNESS_ROOT, baseline),
      "--post-intervention",
      path.join(HARNESS_ROOT, postIntervention),
      "--out",
      file,
    ],
    // Fixed string hashing, so any set the converter walks has one order;
    // no __pycache__ left in the template checkout.
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PYTHONHASHSEED: "0",
        PYTHONDONTWRITEBYTECODE: "1",
      },
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `converting ${baseline} failed: ${result.stderr.trim() || result.error?.message}`,
    );
  }
  settle(file);
}
