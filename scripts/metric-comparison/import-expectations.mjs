import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
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
  validateUnitExpectations(expected);
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
function validateUnitExpectations(expected) {
  if (
    expected.status !== undefined &&
    !["Complete", "Incomplete"].includes(expected.status)
  ) {
    throw new Error("Import expectations require a known habitat status");
  }
  if (
    Object.hasOwn(expected, "units") &&
    (expected.status !== "Incomplete" || expected.units !== null)
  ) {
    throw new Error(
      "Import unit expectations require null units and Incomplete status",
    );
  }
}

function insideCorpus(root, file) {
  const relative = path.relative(root, file);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Import expectation path escapes the corpus: ${file}`);
  }
  return file;
}

function corpusFile(root, relative) {
  if (typeof relative !== "string" || !relative.trim()) {
    throw new Error("Import expectations require a non-empty file path");
  }
  if (path.isAbsolute(relative)) {
    throw new Error("Import expectation paths must be relative to the corpus");
  }
  const target = insideCorpus(root, path.resolve(root, relative));
  if (!existsSync(target) || !statSync(target).isFile()) {
    throw new Error(
      `Import expectation file is missing or not a regular file: ${relative}`,
    );
  }
  return insideCorpus(root, realpathSync(target));
}
/** Optional manifest assertions are additional checks, never numerical exemptions. */
export function readImportExpectations(corpusDir) {
  // --corpus may intentionally name any local directory. Confine every file
  // to that canonical, explicitly selected root, including symlink targets.
  const root = realpathSync(path.resolve(corpusDir));
  if (!existsSync(path.join(root, "manifest.json"))) {
    return new Map();
  }
  const file = corpusFile(root, "manifest.json");
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
    const piFile = corpusFile(root, entry.files?.postIntervention);
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
  assertUnitsAndStatus(matches[0], expected);
}

function assertUnitsAndStatus(feature, expected) {
  if (expected.status !== undefined && feature.status !== expected.status) {
    throw new Error(
      `${expected.layer}/${expected.ref}.status: expected ${expected.status}, got ${feature.status}`,
    );
  }
  if (Object.hasOwn(expected, "units") && feature.units !== expected.units) {
    throw new Error(
      `${expected.layer}/${expected.ref}.units: expected null, got ${JSON.stringify(feature.units)}`,
    );
  }
  if (expected.status === "Complete" && !Number.isFinite(feature.units)) {
    throw new Error(
      `${expected.layer}/${expected.ref}.units: Complete requires calculated units`,
    );
  }
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

/** BMD-1070 invariant, independent of workbook figures and scenario exceptions. */
export function assertCalculatedHabitatUnits(imported) {
  if (!imported.accepted) {
    return;
  }
  const project = imported.project.project;
  for (const documentKey of ["baseline", "postIntervention"]) {
    for (const layer of DOCUMENT_LAYERS) {
      for (const feature of project[documentKey]?.[layer] ?? []) {
        assertHabitatUnits(feature, `${documentKey}.${layer}/${feature.ref}`);
      }
    }
  }
}
function assertHabitatUnits(feature, context) {
  if (feature.units === null && feature.status === "Incomplete") {
    return;
  }
  if (Number.isFinite(feature.units) && feature.status === "Complete") {
    return;
  }
  throw new Error(
    `${context}: expected null units with Incomplete or calculated units with Complete, got ${JSON.stringify(feature.units)}/${feature.status}`,
  );
}
