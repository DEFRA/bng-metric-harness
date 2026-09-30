/**
 * Import a baseline / post-intervention GeoPackage pair the way the backend's
 * upload route does, without the route: no S3, no worker pool, no database.
 *
 * Built for the metric comparison (BMD-1036), which checks the service's
 * figures against the Statutory Biodiversity Metric's own for the same site.
 * Every step is the backend's production code, loaded from the backend
 * checkout beside this repo (see backend.mjs), and called in the order the
 * validate route calls it: the format gate, the GEOS geometry checks, the
 * data-quality checks, then the save pipeline's feature-ID, sizing,
 * extraction, enrichment and schema stages. The only difference is that the
 * geometry checks run on this thread rather than in a worker, which the GEOS
 * entry point is built to allow.
 *
 * The result is the project response `GET /projects/{id}` would return for
 * the same pair, trading-rule statuses included, or the reason the service
 * would have refused one of the files.
 */

import { loadBackendPipeline } from "./backend.mjs";

const BASELINE = "baseline";
const POST_INTERVENTION = "postIntervention";

/** A logger that says nothing; enrichment only logs engine surprises. */
const SILENT_LOGGER = Object.freeze({
  info() {},
  warn() {},
  error() {},
  debug() {},
});

/**
 * The format gate, then the geometry and data-quality checks, as the validate
 * route runs them. The data-quality errors come first, as they do there.
 *
 * @param {object} backend the backend pipeline, from loadBackendPipeline
 * @param {string} filePath
 * @param {string} projectDocumentKey 'baseline' or 'postIntervention'
 * @returns {Promise<{ errors: Array<{ code: string, message: string }>, sizes?: object }>}
 */
async function validateFile(backend, filePath, projectDocumentKey) {
  const gate = backend.validateGpkgFile(filePath);
  if (!gate.valid) {
    return { errors: gate.errors };
  }
  const geometry = await backend.validateGeoPackageLayersGeos(
    backend.readGeoPackage(filePath),
    { includeSizes: true },
  );
  const dataQualityErrors = backend.runDataQualityChecks(
    backend.readGeoPackage(filePath, backend.FEATURE_READ_MODE.properties),
    projectDocumentKey,
  );
  return {
    errors: [...dataQualityErrors, ...geometry.errors],
    sizes: geometry.sizes,
  };
}

/**
 * Build the project document the save pipeline would persist for one file.
 *
 * @param {object} backend
 * @param {string} filePath
 * @param {string} projectDocumentKey
 * @param {object} storedProject the project as stored before this upload
 * @param {object} logger
 * @returns {Promise<{ document?: object, errors?: Array<{ code: string, message: string }> }>}
 */
async function importFile(
  backend,
  filePath,
  projectDocumentKey,
  storedProject,
  logger,
) {
  const validation = await validateFile(backend, filePath, projectDocumentKey);
  if (validation.errors.length > 0) {
    return { errors: validation.errors };
  }

  // The route re-reads the accepted file in `serialised` mode for the save.
  const { layersWithIds, layersForSizing } = backend.layersForUpload(
    backend.readGeoPackage(filePath, backend.FEATURE_READ_MODE.serialised),
    storedProject,
    projectDocumentKey,
    validation.sizes,
  );
  const config = { projectDocumentKey };
  const { document, schemaError } = backend.extractAndValidateDocument({
    handlers: backend.saveHandlersForConfig(config),
    layersWithIds,
    storedProject,
    context: { uploadId: null, filename: null, fileSize: null },
    logger,
    config,
    habitatSizes: backend.calculateHabitatSizes(layersForSizing),
  });
  if (schemaError) {
    return {
      errors: [{ code: "DOCUMENT_SCHEMA", message: schemaError.message }],
    };
  }
  return { document };
}

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
  const logger = options.logger ?? SILENT_LOGGER;
  const project = {};

  for (const key of [BASELINE, POST_INTERVENTION]) {
    const result = await importFile(backend, files[key], key, project, logger);
    if (result.errors) {
      return { accepted: false, rejectedFile: key, errors: result.errors };
    }
    project[key] = result.document;
  }

  return { accepted: true, project: backend.toProjectResponse({ project }) };
}
