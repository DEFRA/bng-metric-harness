/**
 * Which differences from the metric nothing known explains (BMD-1036). The
 * comparison reports every difference; these are the ones that fail it with
 * --fail-on-unexplained, because no one has said why the service and the
 * metric disagree.
 *
 * A difference is explained when:
 *
 * - it is a feature's units, and every cause bng-library finds for it is one
 *   the service does not implement yet (strategic significance, say). A cause
 *   the service has fixed — sizes rounded before pricing — explains nothing:
 *   it is only still recognised so a regression can be named;
 * - it is a total, a net gain figure or verdict, or a trading rules figure or
 *   status, in a module whose feature units differ only for such causes.
 *   Those figures are sums of the feature units, and the verdicts follow from
 *   the sums, so they inherit the difference. A module whose features all
 *   match has no excuse for a total that does not;
 * - the scenario holds invalid data the service does not refuse yet, and
 *   VALIDATION_GAPS says which check the service lacks. The metric computes
 *   nothing meaningful for invalid rows, so none of that scenario's figures
 *   can fail it.
 *
 * Anything else fails: a figure that differs for no known reason, a figure
 * one side has and the other does not, a valid scenario the service refuses,
 * an import that crashes, and a workbook that cannot be read.
 */

import { CATEGORY, CAUSES_BY_ID, OUTCOME } from "#metric-compare";

/**
 * Scenarios built on invalid data that the service accepts, because it does
 * not make the check yet: what the check is. Remove an entry once the service
 * refuses the scenario; an entry it no longer needs is reported as stale.
 */
export const VALIDATION_GAPS = Object.freeze({
  "invalid-interventions/invalid-area-condition-reduced":
    "The service does not refuse a habitat enhancement that reduces condition.",
  "invalid-interventions/invalid-area-no-enhancement":
    "The service does not refuse a habitat enhancement with the same habitat and condition as the baseline.",
  "invalid-interventions/invalid-area-trading-down":
    "The service does not refuse a habitat enhancement to a lower distinctiveness.",
  "invalid-interventions/invalid-hedgerow-condition-reduced":
    "The service does not refuse a hedgerow enhancement that reduces condition.",
  "invalid-interventions/invalid-watercourse-culvert-enhanced":
    "The service does not refuse a culvert enhanced in place, which the metric does not offer.",
  "invalid-interventions/invalid-watercourse-encroachment-worsened":
    "The service does not refuse a watercourse enhancement that delivers fewer units than the baseline.",
  "data-completeness/invalid-data-incomplete":
    "The service does not refuse an enhancement with no proposed condition or strategic significance.",
});

/** Outcomes that fail a scenario whatever its figures. */
const FAILED_OUTCOMES = Object.freeze({
  [OUTCOME.rejected]: "The service refused a scenario whose data is valid.",
  [OUTCOME.importFailed]: "The service failed to import the scenario.",
  [OUTCOME.workbookUnreadable]: "The metric workbook could not be read.",
});

function isNotImplementedYet(discrepancy) {
  return (
    discrepancy.causes?.length > 0 &&
    discrepancy.causes.every((id) => CAUSES_BY_ID[id]?.notImplemented)
  );
}

/**
 * The modules whose differences are all explained: at least one feature
 * differs for a cause the service does not implement yet, and none for any
 * other reason.
 */
function modulesExplainedByFeatures(discrepancies) {
  const explained = new Set();
  const unexplained = new Set();
  for (const d of discrepancies) {
    if (d.category !== CATEGORY.featureUnits) {
      continue;
    }
    (isNotImplementedYet(d) ? explained : unexplained).add(d.module);
  }
  return new Set([...explained].filter((m) => !unexplained.has(m)));
}

function unexplainedDiscrepancies(result) {
  const discrepancies = result.discrepancies ?? [];
  const modules = modulesExplainedByFeatures(discrepancies);
  return discrepancies.filter((d) =>
    d.category === CATEGORY.featureUnits
      ? !isNotImplementedYet(d)
      : !modules.has(d.module),
  );
}

function addResult(found, result, gap) {
  if (FAILED_OUTCOMES[result.outcome]) {
    found.scenarios.push({
      id: result.id,
      problem: FAILED_OUTCOMES[result.outcome],
    });
    return;
  }
  if (result.outcome === OUTCOME.acceptedInvalid) {
    if (!gap) {
      found.scenarios.push({
        id: result.id,
        problem:
          "The service accepted a scenario built on invalid data, and no validation gap explains it.",
      });
    }
    return;
  }
  if (gap) {
    found.stale.push(result.id);
  }
  for (const d of unexplainedDiscrepancies(result)) {
    found.discrepancies.push({ id: result.id, ...d });
  }
}

/**
 * @param {object[]} results compareScenario results
 * @param {Record<string, string>} [validationGaps]
 * @returns {{
 *   scenarios: Array<{ id: string, problem: string }>,
 *   discrepancies: Array<{ id: string } & object>,
 *   stale: string[]
 * }} `scenarios` fail outright; `discrepancies` are the figures nothing
 *   explains; `stale` names validation gaps the run did not need
 */
export function findUnexplained(results, validationGaps = VALIDATION_GAPS) {
  const found = { scenarios: [], discrepancies: [], stale: [] };
  for (const result of results) {
    addResult(found, result, validationGaps[result.id]);
  }
  return found;
}

export function hasUnexplained({ scenarios, discrepancies }) {
  return scenarios.length > 0 || discrepancies.length > 0;
}

const cell = (value) =>
  String(value ?? "—")
    .replaceAll("|", String.raw`\|`)
    .replaceAll("\n", " ");

/**
 * The unexplained differences as Markdown, for the job summary and the
 * console. Empty when there are none.
 */
export function renderUnexplained({ scenarios, discrepancies, stale }) {
  const lines = [];
  if (scenarios.length > 0 || discrepancies.length > 0) {
    lines.push(
      "## ❌ Unexplained differences",
      "",
      "Nothing known explains these, so `npm run compare:metric -- --fail-on-unexplained` fails on them. Fix the service, or, if the difference is expected, say why in `scripts/metric-comparison/unexplained.mjs`.",
      "",
    );
  }
  if (scenarios.length > 0) {
    lines.push(
      "| Scenario | Problem |",
      "| --- | --- |",
      ...scenarios.map((s) => `| ${cell(s.id)} | ${cell(s.problem)} |`),
      "",
    );
  }
  if (discrepancies.length > 0) {
    lines.push(
      "| Scenario | Figure | Metric | Service | Unit |",
      "| --- | --- | --- | --- | --- |",
      ...discrepancies.map(
        (d) =>
          `| ${cell(d.id)} | ${cell(d.label)} | ${cell(d.expected)} | ${cell(d.actual)} | ${cell(d.unit)} |`,
      ),
      "",
    );
  }
  if (stale.length > 0) {
    lines.push(
      "## Stale validation gaps",
      "",
      "The service now refuses these scenarios, so their entries in `VALIDATION_GAPS` can go:",
      "",
      ...stale.map((id) => `- ${id}`),
      "",
    );
  }
  return lines.join("\n");
}
