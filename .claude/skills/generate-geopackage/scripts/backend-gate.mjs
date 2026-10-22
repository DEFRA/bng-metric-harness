#!/usr/bin/env node
/**
 * Run the backend's BNG Service template gate on GeoPackages: the check an
 * upload gets with the service-template flag on (schema, template version).
 * Needs the backend sibling installed (`npm run install:be`; if npm refuses
 * its git-pinned bng-library, `npm run lib:link` in the backend instead).
 *
 * A file that passes is one the backend recognises as the BNG Service
 * template. The baseline + post-intervention upload still refuses it as "not
 * yet read" (SERVICE_TEMPLATE_NOT_YET_READ); the baseline upload does too
 * until bng-metric-backend#530 is merged, and reads its Baseline tables after.
 *
 *   node .claude/skills/generate-geopackage/scripts/backend-gate.mjs <file.gpkg> [...]
 *
 * Exits 1 if any file fails.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const HARNESS = path.resolve(import.meta.dirname, "../../../..");
const BACKEND = process.env.BNG_BACKEND_DIR
  ? path.resolve(process.env.BNG_BACKEND_DIR)
  : path.resolve(HARNESS, "..", "bng-metric-backend");
const GATE = path.join(
  BACKEND,
  "src/validation/geopackage/service-template/service-template-gate.js",
);

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("Usage: backend-gate.mjs <file.gpkg> [more.gpkg ...]");
  process.exit(1);
}
if (!existsSync(GATE) || !existsSync(path.join(BACKEND, "node_modules"))) {
  console.error(
    `No installed backend with the template gate at ${BACKEND}: run npm run bootstrap and npm run install:be (or set BNG_BACKEND_DIR)`,
  );
  process.exit(1);
}

// Before the backend's config is first imported, so its logger is quiet.
process.env.LOG_LEVEL ??= "silent";
const { validateServiceTemplateGpkgFile } = await import(
  pathToFileURL(GATE).href
);

let failed = 0;
for (const file of files) {
  const result = validateServiceTemplateGpkgFile(path.resolve(file));
  const codes = (result.errors ?? []).map((e) => e.code).join(", ");
  const template = result.template
    ? ` (${result.template.name} ${result.template.version})`
    : "";
  console.log(
    `${result.valid ? "PASS" : "FAIL"}${template} ${file}${codes ? `: ${codes}` : ""}`,
  );
  if (!result.valid) {
    failed += 1;
  }
}
process.exit(failed === 0 ? 0 : 1);
