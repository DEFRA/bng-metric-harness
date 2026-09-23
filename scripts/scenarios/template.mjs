/**
 * Find the metric workbook to write scenarios into.
 *
 * A template named on the command line or in METRIC_TEMPLATE wins. Otherwise
 * the calculation tool Defra publishes on GOV.UK is used — downloaded once,
 * checked against the release the corpus was validated with, and kept in the
 * harness's gitignored .cache/ — so nobody has to fetch a workbook by hand.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  PUBLISHED_METRIC_TEMPLATE,
  downloadPublishedTemplate,
  isPublishedTemplate,
} from "#workbook-writer";
import { HARNESS_ROOT, info } from "../_lib.mjs";

export const TEMPLATE_CACHE_DIR = path.join(
  HARNESS_ROOT,
  ".cache",
  "metric-template",
);

export function cachedTemplatePath() {
  return path.join(TEMPLATE_CACHE_DIR, PUBLISHED_METRIC_TEMPLATE.fileName);
}

/**
 * The published template's path, downloading it first if the cache does not
 * hold a good copy.
 */
export async function ensurePublishedTemplate() {
  const cached = cachedTemplatePath();
  if (existsSync(cached) && isPublishedTemplate(readFileSync(cached))) {
    return cached;
  }
  info(
    `  downloading the Statutory Biodiversity Metric ${PUBLISHED_METRIC_TEMPLATE.version} from GOV.UK…`,
  );
  const buffer = await downloadPublishedTemplate();
  mkdirSync(TEMPLATE_CACHE_DIR, { recursive: true });
  writeFileSync(cached, buffer);
  info(`  cached → ${cached}`);
  return cached;
}

/**
 * @param {string} [explicit] a path from --template or METRIC_TEMPLATE
 * @returns {Promise<{ path: string, source: string }>}
 */
export async function resolveTemplate(explicit) {
  if (explicit) {
    return { path: path.resolve(explicit), source: "given" };
  }
  return {
    path: await ensurePublishedTemplate(),
    source: `published ${PUBLISHED_METRIC_TEMPLATE.version}`,
  };
}
