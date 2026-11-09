/**
 * Run the metric comparison (BMD-1036): import every scenario in a folder
 * through the service's own upload pipeline and compare what it computes with
 * the Statutory Biodiversity Metric's answers for the same site.
 *
 * A scenario is a baseline and post-intervention GeoPackage beside the metric
 * workbook describing the same site; the metric's answers are read from the
 * workbook. The committed scenarios are this repo's example-files/permutations
 * and, in the BNG Service template, example-files/service-template/permutations;
 * the comparison itself lives in bng-library (`bng-library/metric-compare`);
 * the import is the backend's (import-geopackage-pair.mjs). So a change to
 * either side — the engine in the library, or the backend's extraction and
 * enrichment around it — is measured against the metric by the same run.
 */

import path from "node:path";
import { realpathSync } from "node:fs";
import {
  compareScenario,
  figuresFromProject,
  figuresFromWorkbook,
  findScenarios,
  readWorkbookAnswers,
  SCENARIO_FORMAT,
} from "#metric-compare";
import { HARNESS_ROOT, mapInSequence } from "../_lib.mjs";
import { importGeoPackagePair } from "./import-geopackage-pair.mjs";
import { metricTotalsOf } from "./unexplained.mjs";
import {
  readImportExpectations,
  assertExpectedImport,
  assertCalculatedHabitatUnits,
} from "./import-expectations.mjs";

/** The committed scenarios, each GeoPackage pair beside its workbook. */
export const DEFAULT_CORPUS_DIR = path.join(
  HARNESS_ROOT,
  "example-files",
  "permutations",
);

/**
 * The committed scenarios in the BNG Service template, each one GeoPackage
 * holding both stages and its baseline-stage file, beside its workbook. The
 * service reads them only with the service-template flag on.
 */
export const SERVICE_TEMPLATE_CORPUS_DIR = path.join(
  HARNESS_ROOT,
  "example-files",
  "service-template",
  "permutations",
);

/**
 * The scenarios the service would refuse at its format gate: with the
 * service-template flag on it reads only the BNG Service template, and with
 * it off only the legacy one. Comparing them would report the refusal, not
 * the figures.
 *
 * @param {import('bng-library/metric-compare').CorpusScenario[]} scenarios
 * @param {boolean} serviceTemplate whether the flag is on
 */
export function scenariosInOtherTemplate(scenarios, serviceTemplate) {
  const format = serviceTemplate
    ? SCENARIO_FORMAT.bngService
    : SCENARIO_FORMAT.legacy;
  return scenarios.filter((scenario) => scenario.format !== format);
}

/**
 * A scenario is named by its id ("net-gain/met"), its name ("met") or its
 * purpose — the folder it is in ("net-gain"). It is selected when `only`
 * names it, or `only` is empty, and `exclude` does not: so a run can take
 * every scenario but a few, and a scenario added later is compared without
 * anyone adding it to a list.
 *
 * @param {{ id: string, name: string, purpose: string }} scenario
 * @param {string[]} only
 * @param {string[]} exclude
 */
function isSelected(scenario, only, exclude) {
  const keys = [scenario.id, scenario.name, scenario.purpose];
  return (
    (only.length === 0 || keys.some((key) => only.includes(key))) &&
    !keys.some((key) => exclude.includes(key))
  );
}

/**
 * The service's side of one scenario: its figures, or its refusal. A scenario
 * whose import throws is reported rather than stopping the run: a crash in
 * the service is a finding in its own right, and the other scenarios still
 * need their report.
 *
 * @returns {Promise<{ service?: object, serviceError?: string }>}
 */
async function importScenario(scenario, importPair, expectedImport) {
  try {
    const imported = await importPair(scenario.files);
    assertCalculatedHabitatUnits(imported);
    assertExpectedImport(imported, expectedImport);
    return {
      service: imported.accepted
        ? { accepted: true, figures: figuresFromProject(imported.project) }
        : imported,
    };
  } catch (error) {
    return { serviceError: error?.message || String(error) };
  }
}

/**
 * @param {import('bng-library/metric-compare').CorpusScenario} scenario
 * @param {{ results?: object, error?: string }} answers the metric workbook's
 *   answers, from readWorkbookAnswers
 * @param {object} [expectedImport] the manifest's import contract, from
 *   readImportExpectations
 * @param {typeof importGeoPackagePair} [importPair] the service's import; the
 *   backend's upload pipeline unless a test stands in for it
 */
export async function compareCorpusScenario(
  scenario,
  answers,
  expectedImport,
  importPair = importGeoPackagePair,
) {
  if (answers.error) {
    return compareScenario({ scenario, workbookError: answers.error });
  }
  const { service, serviceError } = await importScenario(
    scenario,
    importPair,
    expectedImport,
  );
  // Raw-invalid imports with explicit acceptance/attribute assertions are
  // compared numerically against the cleansed workbook, in full.
  const comparedScenario = expectedImport
    ? { ...scenario, invalidData: false }
    : scenario;
  const expected = figuresFromWorkbook(answers.results);
  return {
    ...compareScenario({
      scenario: comparedScenario,
      expected,
      service,
      serviceError,
    }),
    ...(expectedImport
      ? { expectedImport, rawInvalidData: scenario.invalidData }
      : {}),
    metricTotals: metricTotalsOf(expected),
  };
}

/** Every scenario must be in the template the service is reading. */
function assertOneTemplate(scenarios, serviceTemplate) {
  const others = scenariosInOtherTemplate(scenarios, serviceTemplate);
  if (others.length === 0) {
    return;
  }
  const flag = serviceTemplate
    ? "with the service-template flag on, the service reads only the BNG Service template, so compare them without --service-template"
    : "the service reads them only with the service-template flag on, so compare them with --service-template";
  throw new Error(
    `${others.length} scenario(s) are in the other template (${others.map((s) => s.id).join(", ")}): ${flag}`,
  );
}

/** Full runs must not silently drop a manifest contract during discovery. */
function assertAllExpectationsDiscovered(expectations, scenarios) {
  const discovered = new Set(
    scenarios.map((s) => realpathSync(s.files.postIntervention)),
  );
  const unmatched = [...expectations.keys()].filter(
    (file) => !discovered.has(file),
  );
  if (unmatched.length) {
    throw new Error(
      `Import expectations have no matching scenario: ${unmatched.join(", ")}`,
    );
  }
}

/**
 * @param {object} [options]
 * @param {string} [options.corpusDir] a folder of scenarios; by default the
 *   committed ones
 * @param {string[]} [options.only] scenario ids, names or purposes to run
 * @param {string[]} [options.exclude] scenario ids, names or purposes to
 *   leave out, from those `only` selects
 * @param {boolean} [options.serviceTemplate] whether the backend runs with the
 *   service-template flag on; every scenario selected must be in the template
 *   that flag reads
 * @param {(result: object) => void} [options.onResult]
 * @param {typeof importGeoPackagePair} [options.importPair] the service's
 *   import; the backend's upload pipeline unless a test stands in for it
 * @returns {Promise<{ corpusDir: string, unmatched: string[], results: object[] }>}
 *   `unmatched` lists workbooks found without both GeoPackages beside them
 */
export async function runMetricComparison(options = {}) {
  const {
    corpusDir = DEFAULT_CORPUS_DIR,
    only = [],
    exclude = [],
    serviceTemplate = false,
    onResult,
    importPair = importGeoPackagePair,
  } = options;
  const { scenarios, unmatched } = findScenarios(corpusDir);
  const selected = scenarios.filter((s) => isSelected(s, only, exclude));
  assertOneTemplate(selected, serviceTemplate);
  const expectations = readImportExpectations(corpusDir);
  if (only.length === 0 && exclude.length === 0) {
    assertAllExpectationsDiscovered(expectations, selected);
  }
  const answers = await readWorkbookAnswers(
    selected.map((s) => s.files.workbook),
  );
  // One scenario at a time: every import runs the backend's pipeline in this
  // process, on one shared GEOS runtime, and results are reported in order.
  const results = await mapInSequence(selected, async (scenario, i) => {
    const result = await compareCorpusScenario(
      scenario,
      answers[i],
      expectations.get(realpathSync(scenario.files.postIntervention)),
      importPair,
    );
    onResult?.(result);
    return result;
  });
  return { corpusDir, unmatched, results };
}
