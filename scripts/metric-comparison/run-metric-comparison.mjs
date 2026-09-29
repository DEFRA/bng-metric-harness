/**
 * Run the metric comparison (BMD-1036): import every scenario in a folder
 * through the service's own upload pipeline and compare what it computes with
 * the Statutory Biodiversity Metric's answers for the same site.
 *
 * A scenario is a baseline and post-intervention GeoPackage beside the metric
 * workbook describing the same site; the metric's answers are read from the
 * workbook. The committed scenarios are this repo's example-files/permutations;
 * the comparison itself lives in bng-library (`bng-library/metric-compare`);
 * the import is the backend's (import-geopackage-pair.mjs). So a change to
 * either side — the engine in the library, or the backend's extraction and
 * enrichment around it — is measured against the metric by the same run.
 */

import path from "node:path";
import {
  compareScenario,
  figuresFromProject,
  figuresFromWorkbook,
  findScenarios,
  readWorkbookAnswers,
} from "#metric-compare";
import { HARNESS_ROOT } from "../_lib.mjs";
import { importGeoPackagePair } from "./import-geopackage-pair.mjs";

/** The committed scenarios, each GeoPackage pair beside its workbook. */
export const DEFAULT_CORPUS_DIR = path.join(
  HARNESS_ROOT,
  "example-files",
  "permutations",
);

/**
 * A scenario is selected by its id ("net-gain/met"), its name ("met") or its
 * purpose — the folder it is in ("net-gain"); no filter selects all.
 *
 * @param {{ id: string, name: string, purpose: string }} scenario
 * @param {string[]} only
 */
function isSelected(scenario, only) {
  return (
    only.length === 0 ||
    [scenario.id, scenario.name, scenario.purpose].some((key) =>
      only.includes(key),
    )
  );
}

/**
 * @param {import('bng-library/metric-compare').CorpusScenario} scenario
 * @param {{ results?: object, error?: string }} answers the metric workbook's
 *   answers, from readWorkbookAnswers
 */
export async function compareCorpusScenario(scenario, answers) {
  if (answers.error) {
    return compareScenario({ scenario, workbookError: answers.error });
  }
  const imported = await importGeoPackagePair(scenario.files);
  const service = imported.accepted
    ? { accepted: true, figures: figuresFromProject(imported.project) }
    : imported;
  return compareScenario({
    scenario,
    expected: figuresFromWorkbook(answers.results),
    service,
  });
}

/**
 * @param {object} [options]
 * @param {string} [options.corpusDir] a folder of scenarios; by default the
 *   committed ones
 * @param {string[]} [options.only] scenario ids, names or purposes to run
 * @param {(result: object) => void} [options.onResult]
 * @returns {Promise<{ corpusDir: string, unmatched: string[], results: object[] }>}
 *   `unmatched` lists workbooks found without both GeoPackages beside them
 */
export async function runMetricComparison(options = {}) {
  const { corpusDir = DEFAULT_CORPUS_DIR, only = [], onResult } = options;
  const { scenarios, unmatched } = findScenarios(corpusDir);
  const selected = scenarios.filter((s) => isSelected(s, only));
  const answers = await readWorkbookAnswers(
    selected.map((s) => s.files.workbook),
  );
  const results = [];
  for (const [i, scenario] of selected.entries()) {
    const result = await compareCorpusScenario(scenario, answers[i]);
    onResult?.(result);
    results.push(result);
  }
  return { corpusDir, unmatched, results };
}
