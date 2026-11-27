/**
 * What the service should do with each example GeoPackage in example-files/:
 * accept it, or refuse it.
 *
 * The answer comes from the folder a file is in. A file in `valid/` should be
 * accepted, and a file in a folder of problems (`spatial-problems/`,
 * `invalid-schema/` and the rest) should be refused. Each corpus, the legacy
 * template's and the BNG Service template's (`service-template/`), has its own
 * folders, named the same way. A folder this module does not name stops the
 * test, so a new folder cannot be left out of it unnoticed.
 *
 * There are no exceptions. A file the service accepts, however unusual, such
 * as a baseline with no hedgerows, belongs in `valid/` (or, for the BNG
 * Service template, `incomplete/`). A flaw the service does not refuse yet has
 * no file until it does: the BNG Service template's README lists it under
 * Gaps instead.
 *
 * Paths are relative to example-files/, with forward slashes.
 */

import { readdirSync } from "node:fs";
import path from "node:path";
import { HARNESS_ROOT } from "../_lib.mjs";

export const EXAMPLE_FILES_DIR = path.join(HARNESS_ROOT, "example-files");

export const LEGACY = "legacy";
export const SERVICE_TEMPLATE = "service-template";

export const ACCEPTED = "accepted";
export const REFUSED = "refused";

/** The route's project document keys, one per upload endpoint. */
export const BASELINE = "baseline";
export const POST_INTERVENTION = "postIntervention";

/** Where each corpus lives, under example-files/. */
const CORPUS_PREFIX = {
  [LEGACY]: "",
  [SERVICE_TEMPLATE]: `${SERVICE_TEMPLATE}/`,
};

/** Folders whose files should all be accepted. */
const ACCEPTED_FOLDERS = new Set([
  "valid",
  // BNG Service template files the service accepts and saves Incomplete.
  "incomplete",
]);

/** Folders whose files should all be refused. */
const REFUSED_FOLDERS = new Set([
  "attribute-problems",
  "empty-layer",
  "filename-problems",
  "invalid-schema",
  "lineage-problems",
  "malformed",
  "spatial-problems",
  "version-problems",
]);

/** Folders the test leaves out, and why. */
export const FOLDERS_NOT_UPLOADED = new Map([
  [
    "bng-500",
    "real survey data, refused or accepted as the site happens to be: not built to be accepted or refused",
  ],
  [
    "permutations",
    "the scenario corpus, which npm run compare:metric uploads and compares with the metric",
  ],
]);

/** Which corpus a path under example-files/ belongs to. */
export function templateOf(file) {
  return file.startsWith(CORPUS_PREFIX[SERVICE_TEMPLATE])
    ? SERVICE_TEMPLATE
    : LEGACY;
}

/** The folder a file is in, within its corpus. */
export function folderOf(file) {
  return file.slice(CORPUS_PREFIX[templateOf(file)].length).split("/")[0];
}

/**
 * Every .gpkg in one corpus, relative to example-files/, sorted. The legacy
 * corpus leaves out the BNG Service template's, which is a folder inside it.
 *
 * @param {string} template LEGACY or SERVICE_TEMPLATE
 * @param {string} [root] example-files/, or a stand-in for a test
 */
export function corpusFiles(template, root = EXAMPLE_FILES_DIR) {
  const prefix = CORPUS_PREFIX[template];
  return readdirSync(path.join(root, prefix), { recursive: true })
    .map((file) => `${prefix}${file.split(path.sep).join("/")}`)
    .filter((file) => file.endsWith(".gpkg") && templateOf(file) === template)
    .sort((a, b) => a.localeCompare(b));
}

/** The folders of a corpus that no list here names. */
export function unclassifiedFolders(files) {
  const folders = new Set(files.map(folderOf));
  return [...folders].filter(
    (folder) =>
      !ACCEPTED_FOLDERS.has(folder) &&
      !REFUSED_FOLDERS.has(folder) &&
      !FOLDERS_NOT_UPLOADED.has(folder),
  );
}

/** Whether the test uploads a file at all. */
export function isUploaded(file) {
  return !FOLDERS_NOT_UPLOADED.has(folderOf(file));
}

/**
 * What the service should do with a file: what its folder says, with no
 * exceptions. A file the service accepts belongs in valid/ or incomplete/,
 * and a flaw the service does not refuse yet has no file until it does.
 *
 * @returns {{ expected: string }}
 */
export function expectationFor(file) {
  const folder = folderOf(file);
  if (ACCEPTED_FOLDERS.has(folder)) {
    return { expected: ACCEPTED };
  }
  if (REFUSED_FOLDERS.has(folder)) {
    return { expected: REFUSED };
  }
  throw new Error(
    `${file} is in ${folder}/, which scripts/example-uploads/expectations.mjs does not say the service should accept or refuse`,
  );
}

const LEGACY_POST_INTERVENTION =
  /(^Post-intervention\b|-post-intervention\.gpkg$)/;
const SERVICE_BASELINE_STAGE_SUFFIX = "-baseline.gpkg";

/**
 * The uploads a user makes with a file, in order, by the route's project
 * document key.
 *
 * - A legacy file holds one stage, named by its filename: a baseline file
 *   goes to the baseline upload, a post-intervention file to the
 *   post-intervention upload, which rebuilds the baseline from the file's own
 *   Baseline columns.
 * - A BNG Service template file holds both stages, so it is uploaded as the
 *   baseline and then as the post-intervention file. A baseline-stage file
 *   (`-baseline.gpkg`), whose post-intervention tables are empty, goes to the
 *   baseline upload only.
 */
export function uploadsFor(file) {
  const name = path.posix.basename(file);
  if (templateOf(file) === SERVICE_TEMPLATE) {
    return name.endsWith(SERVICE_BASELINE_STAGE_SUFFIX)
      ? [BASELINE]
      : [BASELINE, POST_INTERVENTION];
  }
  return LEGACY_POST_INTERVENTION.test(name) ? [POST_INTERVENTION] : [BASELINE];
}
