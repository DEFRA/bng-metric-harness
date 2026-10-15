import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const DOCUMENT_LAYERS = new Set([
  "habitats",
  "hedgerows",
  "watercourses",
  "trees",
]);
const TIMING_FIELDS = new Set(["advanceYears", "delayYears"]);

function validateFeature(expected) {
  if (
    !DOCUMENT_LAYERS.has(expected.layer) ||
    typeof expected.ref !== "string" ||
    !expected.ref.trim()
  ) {
    throw new Error(
      "Import expectations require a known layer and non-empty feature reference",
    );
  }
  if (expected.absent === true && expected.proposed === undefined) {
    return;
  }
  const fields = Object.entries(expected.proposed ?? {});
  if (
    expected.absent ||
    fields.length !== TIMING_FIELDS.size ||
    fields.some(([key, value]) => !TIMING_FIELDS.has(key) || value !== null)
  ) {
    throw new Error(
      "Import expectations require saved null timing fields or explicit absence",
    );
  }
}
/** Optional manifest assertions are additional checks, never numerical exemptions. */
export function readImportExpectations(corpusDir) {
  const file = path.join(corpusDir, "manifest.json");
  if (!existsSync(file)) {
    return new Map();
  }
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  const expectations = new Map();
  for (const entry of manifest.scenarios ?? []) {
    if (!entry.expectedImport) {
      continue;
    }
    if (
      entry.expectedImport.accepted !== true ||
      !entry.expectedImport.features?.length
    ) {
      throw new Error(`Invalid import expectations for ${entry.id}`);
    }
    entry.expectedImport.features.forEach(validateFeature);
    const piFile = path.resolve(corpusDir, entry.files.postIntervention);
    if (expectations.has(piFile)) {
      throw new Error(`Duplicate import expectations for ${piFile}`);
    }
    expectations.set(piFile, entry.expectedImport);
  }
  return expectations;
}

function checkFeature(document, expected) {
  const matches = (document[expected.layer] ?? []).filter(
    (f) => f.ref === expected.ref,
  );
  if (expected.absent === true) {
    if (matches.length !== 0) {
      throw new Error(
        `${expected.layer}/${expected.ref} must be absent after import`,
      );
    }
    return;
  }
  if (
    matches.length !== 1 ||
    !expected.proposed ||
    !Object.keys(expected.proposed).length
  ) {
    throw new Error(
      `${expected.layer}/${expected.ref} must identify one feature with proposed attribute expectations`,
    );
  }
  assertProposedTiming(matches[0], expected);
}

function assertProposedTiming(feature, expected) {
  for (const [field, value] of Object.entries(expected.proposed)) {
    if (feature.proposed?.[field] !== value) {
      throw new Error(
        `${expected.layer}/${expected.ref}.proposed.${field}: expected ${JSON.stringify(value)}, got ${JSON.stringify(feature.proposed?.[field])}`,
      );
    }
  }
}
export function assertExpectedImport(imported, expected) {
  if (!expected) {
    return;
  }
  if (!imported.accepted) {
    throw new Error(
      "The scenario must be accepted with cleansed attributes, but the service rejected it",
    );
  }
  for (const feature of expected.features) {
    checkFeature(imported.project.project.postIntervention, feature);
  }
}
