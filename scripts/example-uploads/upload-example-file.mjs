/**
 * Upload one example GeoPackage through the backend's own code, as a user
 * does, and say whether the service accepted it.
 *
 * Each upload runs the checks the validate route runs, in its order:
 *
 * 1. the upload's metadata, its filename included: the route's own schema
 *    (`habitatDataSchema`) and the error it makes of a refusal
 *    (`makeMetadataError`), before a byte of the file is read;
 * 2. `importUploadFile`, the rest of the pipeline the metric comparison runs
 *    (see ../metric-comparison/backend.mjs): the format gate, the geometry
 *    and data-quality checks, then the documents the save would write.
 *
 * Everything is loaded from the backend checkout beside the harness, or the
 * one BNG_BACKEND_DIR names, so the result is that backend's.
 */

import { statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SERVICE_TEMPLATE_FLAG } from "../dev-env.mjs";
import {
  backendDir,
  loadBackendPipeline,
} from "../metric-comparison/backend.mjs";
import {
  ACCEPTED,
  REFUSED,
  SERVICE_TEMPLATE,
  uploadsFor,
} from "./expectations.mjs";

/** What happened, beside ACCEPTED and REFUSED: the service threw. */
export const FAILED = "failed";

const CHECK_MODULES = {
  config: "src/config.js",
  metadata: "src/validation/project.js",
  errors: "src/validation/geopackage/errors.js",
};

const SERVICE_TEMPLATE_SETTING = "serviceTemplate.enabled";

let checks;

async function loadChecks(dir) {
  const [config, metadata, errors] = await Promise.all(
    Object.values(CHECK_MODULES).map(
      (file) => import(pathToFileURL(path.join(dir, file)).href),
    ),
  );
  if (!metadata.habitatDataSchema || !errors.makeMetadataError) {
    throw new Error(
      `The backend at ${dir} does not export habitatDataSchema from ${CHECK_MODULES.metadata} and makeMetadataError from ${CHECK_MODULES.errors}, which the upload checks call. Pull its main branch.`,
    );
  }
  return {
    config: config.config,
    habitatDataSchema: metadata.habitatDataSchema,
    makeMetadataError: errors.makeMetadataError,
    pipeline: await loadBackendPipeline(),
  };
}

/**
 * Load the backend, once, with its service-template flag set for the corpus
 * under test: on for the BNG Service template's, off for the legacy one's.
 * The format gate reads the flag on each upload.
 *
 * @param {string} template LEGACY or SERVICE_TEMPLATE
 */
export async function loadUploadChecks(template) {
  const on = template === SERVICE_TEMPLATE;
  // Before the backend's config is first imported, which reads it then.
  process.env[SERVICE_TEMPLATE_FLAG] = String(on);
  process.env.LOG_LEVEL ??= "silent";
  checks ??= loadChecks(backendDir()).catch((error) => {
    checks = null;
    throw error;
  });
  const loaded = await checks;
  loaded.config.set(SERVICE_TEMPLATE_SETTING, on);
  return loaded;
}

const codesOf = (errors) => [...new Set(errors.map((error) => error.code))];

/**
 * Upload a file as a user does: each upload `uploadsFor` names, in turn,
 * each onto the project the one before it left.
 *
 * @param {string} file the path under example-files/, which names its uploads
 * @param {string} filePath the file on disk
 * @param {string} template LEGACY or SERVICE_TEMPLATE
 * @returns {Promise<{ outcome: string, uploads: string[], refusedAt?: string, codes?: string[], errors?: object[], message?: string }>}
 *   `uploads` are the uploads made; `refusedAt` is the one refused or that
 *   failed, with its error codes, or the error message for a failure
 */
export async function uploadExampleFile(file, filePath, template) {
  const { habitatDataSchema, makeMetadataError, pipeline } =
    await loadUploadChecks(template);
  const filename = path.basename(filePath);
  const fileSize = statSync(filePath).size;
  const uploads = [];
  let project = {};

  for (const key of uploadsFor(file)) {
    uploads.push(key);
    const { error: metadataError } = habitatDataSchema.validate(
      { uploadId: null, filename, fileSize },
      { allowUnknown: true },
    );
    if (metadataError) {
      const errors = [makeMetadataError(metadataError)];
      return {
        outcome: REFUSED,
        uploads,
        refusedAt: key,
        codes: codesOf(errors),
        errors,
      };
    }
    let result;
    try {
      result = await pipeline.importUploadFile(filePath, project, {
        projectDocumentKey: key,
      });
    } catch (error) {
      return {
        outcome: FAILED,
        uploads,
        refusedAt: key,
        message: error.message,
      };
    }
    if (!result.accepted) {
      return {
        outcome: REFUSED,
        uploads,
        refusedAt: key,
        codes: codesOf(result.errors),
        errors: result.errors,
      };
    }
    project = result.project;
  }
  return { outcome: ACCEPTED, uploads };
}
