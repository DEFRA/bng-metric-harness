/**
 * What generate:gpkg does with each BNG Service file once it is written:
 * check it (see service-template/check-generated.mjs) and, with
 * --package-template, package it as a copy of the QGIS template folder (see
 * service-template/package-template.mjs).
 *
 * Split out of `gen-gpkg.mjs` to keep that file within its size budget; it is
 * the CLI's only consumer.
 */

import path from "node:path";
import { error, info, warn } from "./_lib.mjs";
import { checkGenerated } from "./service-template/check-generated.mjs";
import {
  PROJECT_FILE,
  packageForQgis,
  templateFolder,
} from "./service-template/package-template.mjs";

const failed = [];
const LOG = { info, warn, error };

/** The files that failed a check they should pass, this run. */
export function failedChecks() {
  return [...failed];
}

/** Exit 1, saying how to get the template, if it is not there to package. */
export function assertTemplateAvailable() {
  try {
    templateFolder();
  } catch (err) {
    error(err.message);
    process.exit(1);
  }
}

/** The folder a packaged file is written to: the file's name, for QGIS. */
export function packageName(file) {
  return `${path.basename(file, ".gpkg")}-qgis`;
}

/**
 * Check a BNG Service file just written, and package it if asked. A failed
 * check is logged and remembered, and the file is still packaged, so it can
 * be opened and looked at.
 *
 * @param {string} file
 * @param {{ strictness: { strictLineage: boolean, strictValues: boolean },
 *   packageTemplate: boolean }} options
 */
export function afterBngServiceWrite(file, { strictness, packageTemplate }) {
  const { ok, findings } = checkGenerated(file, strictness);
  info(`  checks: ${path.basename(file)}`);
  for (const { level, text } of findings) {
    LOG[level](`    ${level === "info" ? "✔" : "✖"} ${text}`);
  }
  if (!ok) {
    failed.push(file);
  }
  if (packageTemplate) {
    const { folder, zip } = packageForQgis(file, {
      outDir: path.dirname(file),
      name: packageName(file),
    });
    info(`  packaged for QGIS: open ${path.join(folder, PROJECT_FILE)}`);
    info(`    zipped: ${zip}`);
  }
}
