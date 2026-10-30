/**
 * Import a baseline / post-intervention GeoPackage pair the way a user
 * uploads it, without the route: no S3, no worker pool, no database.
 *
 * Built for the metric comparison (BMD-1036), which checks the service's
 * figures against the Statutory Biodiversity Metric's own for the same site.
 * Each file goes through the backend's `importUploadFile`, loaded from the
 * backend checkout beside this repo (see backend.mjs): the format gate, the
 * geometry and data-quality checks, then the documents the save pipeline
 * builds and the project the write leaves stored. The upload route builds its
 * documents with the same code, so nothing here re-creates its steps; this
 * file only pairs the two uploads.
 *
 * A legacy post-intervention upload replaces the project's baseline with one
 * rebuilt from the file's own Baseline columns (BMD-1056), so that is the
 * baseline the result holds, not the baseline file's.
 *
 * The result is the project response `GET /projects/{id}` would return for
 * the same pair, trading-rule statuses included, or the reason the service
 * would have refused one of the files.
 */

import { loadBackendPipeline } from "./backend.mjs";

const BASELINE = "baseline";
const POST_INTERVENTION = "postIntervention";

/**
 * Import a GeoPackage pair into a new, unsaved project: the baseline first,
 * then the post-intervention file against it, as a user uploads them.
 *
 * @param {{ baseline: string, postIntervention: string }} files paths on disk
 * @param {{ logger?: object }} [options]
 * @returns {Promise<
 *   { accepted: true, project: object } |
 *   { accepted: false, rejectedFile: string, errors: Array<{ code: string, message: string }> }
 * >} `project` is the `GET /projects/{id}` response body for the pair
 */
export async function importGeoPackagePair(files, options = {}) {
  const backend = await loadBackendPipeline();
  let project = {};

  for (const key of [BASELINE, POST_INTERVENTION]) {
    const result = await backend.importUploadFile(files[key], project, {
      projectDocumentKey: key,
      logger: options.logger,
    });
    if (!result.accepted) {
      return { accepted: false, rejectedFile: key, errors: result.errors };
    }
    project = result.project;
  }

  return { accepted: true, project: backend.toProjectResponse({ project }) };
}
