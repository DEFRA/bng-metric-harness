/**
 * The backend's upload pipeline, loaded from the backend checkout beside this
 * repo, for the metric comparison (BMD-1036).
 *
 * The comparison measures the service, so it runs the backend's own code
 * rather than a copy of it: each module is imported by path from the
 * checkout, and resolves its own dependencies (the engine in bng-library
 * included) from the backend's node_modules, at the version the backend pins.
 * The backend needs `npm install` first.
 *
 * BNG_BACKEND_DIR names another checkout — a worktree of a backend branch,
 * say — in place of the sibling.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { repoPath } from "../_lib.mjs";

export const BACKEND_REPO = "bng-metric-backend";
export const BACKEND_DIR_ENV = "BNG_BACKEND_DIR";

/** Each module the import uses, by its path in the backend repo. */
const PIPELINE_MODULES = [
  "src/validation/geopackage/geos/index.js",
  "src/validation/geopackage/geopackage.js",
  "src/validation/geopackage/index.js",
  "src/validation/geopackage/read-feature-tables.js",
  "src/services/upload/calculate-habitat-sizes.js",
  "src/services/upload/save-upload-for-project.js",
  "src/utilities/project/to-project-response.js",
];

/** What the import calls; a backend without them predates the comparison. */
const PIPELINE_EXPORTS = [
  "validateGeoPackageLayersGeos",
  "readGeoPackage",
  "validateGpkgFile",
  "runDataQualityChecks",
  "FEATURE_READ_MODE",
  "calculateHabitatSizes",
  "extractAndValidateDocument",
  "layersForUpload",
  "saveHandlersForConfig",
  "toProjectResponse",
];

/** The backend checkout the comparison runs. */
export function backendDir(env = process.env) {
  return env[BACKEND_DIR_ENV]
    ? path.resolve(env[BACKEND_DIR_ENV])
    : repoPath(BACKEND_REPO);
}

/** Whether there is an installed backend to run, for tests to skip on. */
export function isBackendInstalled(dir = backendDir()) {
  return existsSync(path.join(dir, "node_modules"));
}

let pipeline;

/**
 * Import the backend's upload pipeline, once.
 *
 * @returns {Promise<object>} every export in PIPELINE_EXPORTS
 */
export async function loadBackendPipeline() {
  pipeline ??= importPipeline(backendDir());
  return pipeline;
}

async function importPipeline(dir) {
  // Before the backend's config is first imported: the importer's perf
  // evidence is noise here.
  process.env.LOG_LEVEL ??= "silent";

  const modules = await Promise.all(
    PIPELINE_MODULES.map(
      (file) => import(pathToFileURL(path.join(dir, file)).href),
    ),
  );
  const loaded = Object.assign({}, ...modules);
  const missing = PIPELINE_EXPORTS.filter((name) => !(name in loaded));
  if (missing.length > 0) {
    throw new Error(
      `The backend at ${dir} does not export ${missing.join(", ")}: it predates the metric comparison (DEFRA/bng-metric-backend#417). Pull its main branch.`,
    );
  }
  return loaded;
}
