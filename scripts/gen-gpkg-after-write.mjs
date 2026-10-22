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

/**
 * The files that failed this run, and why: a check they should pass, a
 * check that could not run, or packaging.
 *
 * @returns {{ file: string, reason: string }[]}
 */
export function failures() {
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

/** Record a file that failed, once, with why. */
function fail(file, reason) {
  if (!failed.some((f) => f.file === file)) {
    failed.push({ file, reason });
  }
}

function check(file, strictness) {
  try {
    const { ok, findings } = checkGenerated(file, strictness);
    info(`  checks: ${path.basename(file)}`);
    for (const { level, text } of findings) {
      LOG[level](`    ${level === "info" ? "✔" : "✖"} ${text}`);
    }
    if (!ok) {
      fail(file, "a check it should pass");
    }
  } catch (err) {
    error(
      `  checks: ${path.basename(file)} could not be checked: ${err.message}`,
    );
    fail(file, `could not be checked: ${err.message}`);
  }
}

function packageFile(file) {
  try {
    const { folder, zip } = packageForQgis(file, {
      outDir: path.dirname(file),
      name: packageName(file),
    });
    info(`  packaged for QGIS: open ${path.join(folder, PROJECT_FILE)}`);
    info(`    zipped: ${zip}`);
  } catch (err) {
    error(
      `  packaging: ${path.basename(file)} was written, but not packaged: ${err.message}`,
    );
    fail(file, `not packaged: ${err.message}`);
  }
}

/**
 * Check a BNG Service file just written, and package it if asked. A failed
 * check or packaging is logged and remembered, and the run carries on, so
 * the rest of a batch is still written and every failure is listed at the
 * end. A file that fails a check is still packaged, so it can be opened and
 * looked at.
 *
 * @param {string} file
 * @param {{ strictness: { strictLineage: boolean, strictValues: boolean },
 *   packageTemplate: boolean }} options
 */
export function afterBngServiceWrite(file, { strictness, packageTemplate }) {
  check(file, strictness);
  if (packageTemplate) {
    packageFile(file);
  }
}
