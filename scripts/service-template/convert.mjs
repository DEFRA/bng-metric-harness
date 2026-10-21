/**
 * Convert a legacy BNG500 pair into the BNG Service template with the
 * template's own converter (BMD-1081: "The BNG500 files are converted with
 * the plugin"), reproducibly.
 *
 * The converter is plugin/bng_template_convert/old_to_new.py in the
 * bng-metric-template sibling (or the checkout BNG_TEMPLATE_DIR names). The
 * committed bng-500/ files come from it at CONVERTER_COMMIT. CI clones that
 * commit and requires the rebuilt files to match the committed ones byte for
 * byte, so CI is what guarantees the pin: a local run converts with whatever
 * checkout it finds, and says which commit that is. scripts/bng500/
 * convert.py runs it with seeded uuids; here its file's timestamps are fixed
 * and the file rewritten with VACUUM, so SQLite lays it out as it does every
 * other fixture, whatever SQLite Python has.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { HARNESS_ROOT, repoPath } from "../_lib.mjs";

export const TEMPLATE_REPO = "bng-metric-template";
export const TEMPLATE_DIR_ENV = "BNG_TEMPLATE_DIR";
/** The bng-metric-template commit the committed bng-500/ files come from. */
export const CONVERTER_COMMIT = "073550c7833d836937939a9d70980f0598201300";

const CONVERTER_PATH = path.join("plugin", "bng_template_convert");
const WRAPPER = path.join(HARNESS_ROOT, "scripts", "bng500", "convert.py");
const PYTHON = process.platform === "win32" ? "python" : "python3";
// The metadata timestamp bng-library's seeded generator writes.
const FIXED_TIMESTAMP = "2020-01-01T00:00:00.000Z";
const SHORT_COMMIT = 7;

export function templateDir() {
  return process.env[TEMPLATE_DIR_ENV] || repoPath(TEMPLATE_REPO);
}

function readText(file) {
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return null;
  }
}

/**
 * The commit the template checkout is at, read from its .git folder; null
 * if it cannot be read (not a git checkout, or a worktree).
 */
export function templateCommit(dir = templateDir()) {
  const gitDir = path.join(dir, ".git");
  const head = readText(path.join(gitDir, "HEAD"));
  if (!head?.startsWith("ref: ")) {
    return head;
  }
  const ref = head.slice("ref: ".length);
  const loose = readText(path.join(gitDir, ref));
  if (loose) {
    return loose;
  }
  const packed = readText(path.join(gitDir, "packed-refs")) ?? "";
  const line = packed.split("\n").find((l) => l.endsWith(` ${ref}`));
  return line ? line.split(" ")[0] : null;
}

/** How the template checkout's commit compares with CONVERTER_COMMIT. */
export function describeTemplateCommit(commit = templateCommit()) {
  const pinned = CONVERTER_COMMIT.slice(0, SHORT_COMMIT);
  if (commit === CONVERTER_COMMIT) {
    return {
      pinned: true,
      text: `${TEMPLATE_REPO} ${pinned}, the pinned commit`,
    };
  }
  const found = commit ? commit.slice(0, SHORT_COMMIT) : "an unknown commit";
  return {
    pinned: false,
    text: `${TEMPLATE_REPO} at ${found}, not the pinned ${pinned}: CI rebuilds the files at ${pinned} and fails if they differ, unless CONVERTER_COMMIT is updated too`,
  };
}

function hasPython() {
  return spawnSync(PYTHON, ["--version"], { encoding: "utf8" }).status === 0;
}

/**
 * Why the converter cannot run here, or null if it can: the template
 * checkout is missing, or there is no Python.
 */
export function converterProblem() {
  const dir = templateDir();
  if (!existsSync(path.join(dir, CONVERTER_PATH, "old_to_new.py"))) {
    return `the ${TEMPLATE_REPO} checkout is missing at ${dir}: run \`npm run bootstrap\`, or set ${TEMPLATE_DIR_ENV}`;
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
      `converting ${baseline} failed: ${result.stderr?.trim() || result.error?.message}`,
    );
  }
  settle(file);
}
