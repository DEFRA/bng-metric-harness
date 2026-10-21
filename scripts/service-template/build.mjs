/**
 * Build the curated BNG Service template corpus from its recipes
 * (recipes.mjs): each fixture written at its fixed path, to the same bytes
 * on every run.
 */

import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { FORMAT_BNG_SERVICE, generateSyntheticGpkg } from "#bng-lib";
import { HARNESS_ROOT } from "../_lib.mjs";
import { DEFAULT_CENTRE } from "../centre.mjs";
import {
  FAMILIES,
  KIND_COPIED,
  KIND_DERIVED,
  KIND_GENERATED,
  RECIPES,
  recipeFor,
} from "./recipes.mjs";

/** The bytes a generated recipe's options draw. */
function generatedBuffer(recipe) {
  if (recipe.kind !== KIND_GENERATED) {
    throw new Error(`${recipe.path} is not generated, so cannot be a base`);
  }
  return generateSyntheticGpkg({
    ...recipe.options,
    centre: DEFAULT_CENTRE,
    format: FORMAT_BNG_SERVICE,
  }).buffer;
}

/** Apply a derived recipe's edits to the file at `file`, then compact it. */
function applyEdits(file, edits) {
  if (edits.length === 0) {
    return;
  }
  const db = new Database(file);
  try {
    db.transaction(() => {
      for (const edit of edits) {
        edit(db);
      }
    })();
    db.exec("VACUUM");
  } finally {
    db.close();
  }
}

/** Write one recipe's fixture under `outDir`; returns the file written. */
export function buildRecipe(recipe, outDir) {
  const file = path.join(outDir, recipe.path);
  mkdirSync(path.dirname(file), { recursive: true });
  rmSync(file, { force: true });
  if (recipe.kind === KIND_GENERATED) {
    writeFileSync(file, generatedBuffer(recipe));
  } else if (recipe.kind === KIND_DERIVED) {
    writeFileSync(file, generatedBuffer(recipeFor(recipe.from)));
    applyEdits(file, recipe.edits);
  } else if (recipe.kind === KIND_COPIED) {
    copyFileSync(path.join(HARNESS_ROOT, recipe.source), file);
  } else {
    throw new Error(`${recipe.path}: unknown recipe kind "${recipe.kind}"`);
  }
  return file;
}

/** Every .gpkg in the families' folders, relative to `outDir`. */
export function familyFiles(outDir) {
  return FAMILIES.flatMap(({ dir }) => {
    let names = [];
    try {
      names = readdirSync(path.join(outDir, dir));
    } catch {
      return [];
    }
    return names
      .filter((name) => name.endsWith(".gpkg"))
      .map((name) => `${dir}/${name}`);
  });
}

/**
 * Remove the files in the families' folders that no recipe builds any more,
 * so a renamed or dropped fixture does not linger. Returns their paths.
 */
export function removeStaleFiles(outDir) {
  const built = new Set(RECIPES.map((r) => r.path));
  const stale = familyFiles(outDir).filter((file) => !built.has(file));
  for (const file of stale) {
    rmSync(path.join(outDir, file));
  }
  return stale;
}

const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "latin1");
// Bytes 92-99 of a SQLite file header record the SQLite version that last
// wrote it (version-valid-for and SQLITE_VERSION_NUMBER), not its content.
const VERSION_BYTES_START = 92;
const VERSION_BYTES_END = 100;

function withoutSqliteVersion(buffer) {
  if (
    buffer.length < VERSION_BYTES_END ||
    !buffer.subarray(0, SQLITE_HEADER.length).equals(SQLITE_HEADER)
  ) {
    return buffer;
  }
  const copy = Buffer.from(buffer);
  copy.fill(0, VERSION_BYTES_START, VERSION_BYTES_END);
  return copy;
}

/**
 * Whether two builds of a fixture are the same file: byte for byte, but for
 * the SQLite version a GeoPackage's header records, so a better-sqlite3
 * upgrade alone does not make the committed corpus differ. One that changes
 * how SQLite lays out a file does, and the corpus is then regenerated.
 */
export function sameFixture(a, b) {
  return withoutSqliteVersion(a).equals(withoutSqliteVersion(b));
}
