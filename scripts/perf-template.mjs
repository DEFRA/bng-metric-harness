// Which upload template a perf run asks the container to upload.
// Unset means the legacy template and sets no UPLOAD_TEMPLATE. "legacy" and
// "service" are the only names passed through. Anything else is rejected
// before the image is built, so the banner and the container env cannot disagree.

export const PERF_TEMPLATE_LEGACY = "legacy";
export const PERF_TEMPLATE_SERVICE = "service";

const ACCEPTED_PERF_TEMPLATES = Object.freeze([
  PERF_TEMPLATE_LEGACY,
  PERF_TEMPLATE_SERVICE,
]);

/**
 * Normalise a PERF_TEMPLATE value.
 * @param {string | undefined} value
 * @returns {string} "" (legacy, env left unset), "legacy", or "service"
 * @throws {Error} when the value is anything else
 */
export function parsePerfTemplate(value) {
  const template = (value ?? "").trim().toLowerCase();
  if (template && !ACCEPTED_PERF_TEMPLATES.includes(template)) {
    throw new Error(
      `PERF_TEMPLATE must be "legacy" or "service", not "${template}".`,
    );
  }
  return template;
}

/**
 * The UPLOAD_TEMPLATE entry containerEnv adds. Only an explicit legacy or
 * service value is forwarded; an empty template leaves the container on its
 * own legacy default.
 * @param {string} template
 * @returns {Record<string, string>}
 */
export function uploadTemplateEnv(template) {
  if (
    template !== PERF_TEMPLATE_LEGACY &&
    template !== PERF_TEMPLATE_SERVICE
  ) {
    return {};
  }
  return { UPLOAD_TEMPLATE: template };
}
