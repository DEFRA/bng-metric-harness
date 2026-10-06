/**
 * Every difference from the metric, as lines for the console (BMD-1036), so
 * a CI log shows what differed without opening the report.
 *
 * One block per scenario that differs, or that the comparison fails whatever
 * its figures (refused, crashed, or accepted invalid data no gap names), and
 * one line per figure: the metric's value, the service's, the difference
 * where both are numbers, and what explains it. A figure nothing explains is
 * marked ✗, as is a scenario; these are what --fail-on-unexplained fails on.
 */

import { CAUSES_BY_ID, OUTCOME } from "#metric-compare";
import { VALIDATION_GAPS } from "./unexplained.mjs";

const DECIMAL_PLACES = 4;
const UNEXPLAINED_MARK = "✗";
const NO_VALUE = "—";
const SCENARIO_INDENT = "  ";
const FIGURE_INDENT = "      ";

/** A value to 4 decimal places with its unit; a verdict or marker as is. */
function value(v, unit) {
  if (typeof v === "number") {
    return `${v.toFixed(DECIMAL_PLACES)} ${unit}`;
  }
  return v ?? NO_VALUE;
}

/** The service's value less the metric's, signed, when both are numbers. */
function difference(d) {
  if (typeof d.difference !== "number") {
    return "";
  }
  const sign = d.difference > 0 ? "+" : "";
  const unit = d.differenceUnit ?? d.unit;
  return ` (${sign}${d.difference.toFixed(DECIMAL_PLACES)} ${unit})`;
}

/** What explains a figure: ✗ when nothing does, else its causes if any. */
function explanation(d, unexplained) {
  if (unexplained) {
    return ` ${UNEXPLAINED_MARK} no known explanation`;
  }
  const titles = (d.causes ?? []).map((id) => CAUSES_BY_ID[id]?.title ?? id);
  return titles.length > 0 ? ` — ${titles.join("; ")}` : "";
}

function figureLine(d, unexplained) {
  const values = `metric ${value(d.expected, d.unit)} → service ${value(d.actual, d.unit)}`;
  return `${FIGURE_INDENT}${d.label} [${d.module}]: ${values}${difference(d)}${explanation(d, unexplained)}`;
}

/** The scenario's heading: its outcome, and the gap or problem that frames it. */
function scenarioLine(result, problem, gap) {
  if (problem) {
    return `${SCENARIO_INDENT}${UNEXPLAINED_MARK} ${result.id} (${result.outcome}): ${problem}`;
  }
  const suffix =
    result.outcome === OUTCOME.acceptedInvalid && gap ? `: ${gap}` : "";
  return `${SCENARIO_INDENT}${result.id} (${result.outcome})${suffix}`;
}

/**
 * @param {object[]} results compareScenario results, in corpus order
 * @param {{ scenarios: object[], discrepancies: object[] }} unexplained
 *   findUnexplained's answer for the same results
 * @param {Record<string, string>} [validationGaps]
 * @returns {string} the lines, or "" when nothing differs
 */
export function renderDifferences(
  results,
  unexplained,
  validationGaps = VALIDATION_GAPS,
) {
  const problems = new Map(unexplained.scenarios.map((s) => [s.id, s.problem]));
  const unexplainedKeys = new Set(
    unexplained.discrepancies.map((d) => `${d.id}\n${d.key}`),
  );
  const lines = [];
  for (const result of results) {
    const discrepancies = result.discrepancies ?? [];
    const problem = problems.get(result.id);
    if (discrepancies.length === 0 && !problem) {
      continue;
    }
    lines.push(scenarioLine(result, problem, validationGaps[result.id]));
    for (const d of discrepancies) {
      lines.push(figureLine(d, unexplainedKeys.has(`${result.id}\n${d.key}`)));
    }
  }
  if (lines.length === 0) {
    return "";
  }
  return [
    `Differences from the metric (${UNEXPLAINED_MARK} = no known explanation):`,
    ...lines,
  ].join("\n");
}
