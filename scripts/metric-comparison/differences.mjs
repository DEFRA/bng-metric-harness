/**
 * Every difference from the metric, as lines for the console (BMD-1036), so
 * a CI log shows what differed without opening the report.
 *
 * One block per scenario that differs, or that the comparison fails whatever
 * its figures (refused, crashed, or accepted invalid data no gap names): a
 * heading, then a padded, pipe-separated table with a row per figure, giving
 * the metric's value, the service's, the difference where both are numbers,
 * the unit, and what explains it. The columns are sized across every
 * scenario, so the tables line up with each other. A figure nothing explains
 * is marked ✗, as is a scenario; these are what --fail-on-unexplained fails
 * on.
 */

import { CAUSES_BY_ID, OUTCOME } from "#metric-compare";
import { VALIDATION_GAPS } from "./unexplained.mjs";

const DECIMAL_PLACES = 4;
const UNEXPLAINED_MARK = "✗";
const NO_VALUE = "—";
const NO_EXPLANATION = `${UNEXPLAINED_MARK} no known explanation`;
/** The scenario holds invalid data the service accepts; the heading says why. */
const INVALID_DATA = "Invalid data; see the scenario's gap";
/** A derived figure that moves by what its features' differences account for. */
const FOLLOWS_FROM_FEATURES = "Follows from the feature differences";
const SCENARIO_INDENT = "  ";
const TABLE_INDENT = "      ";

const HEADER = [
  "Figure",
  "Module",
  "Metric",
  "Service",
  "Difference",
  "Unit",
  "Explained by",
];
/** The columns padded on the left, so their numbers line up at the point. */
const NUMERIC_COLUMNS = new Set([2, 3, 4]);

/** A value to 4 decimal places; a verdict or marker as is. */
function value(v) {
  if (typeof v === "number") {
    return v.toFixed(DECIMAL_PLACES);
  }
  return v ?? NO_VALUE;
}

/**
 * The service's value less the metric's, signed, when both are numbers, with
 * its unit when that differs from the figure's (percentage points, say).
 */
function difference(d) {
  if (typeof d.difference !== "number") {
    return "";
  }
  const sign = d.difference > 0 ? "+" : "";
  const unit =
    d.differenceUnit && d.differenceUnit !== d.unit
      ? ` ${d.differenceUnit}`
      : "";
  return `${sign}${d.difference.toFixed(DECIMAL_PLACES)}${unit}`;
}

/**
 * What explains a figure: ✗ when nothing does; the scenario's validation gap
 * when its data is invalid; a feature's causes; else, for a figure derived
 * from the features, the feature differences it follows from (see
 * unexplained.mjs for what that means).
 */
function explanation(d, { unexplained, invalidData }) {
  if (unexplained) {
    return NO_EXPLANATION;
  }
  if (invalidData) {
    return INVALID_DATA;
  }
  const titles = (d.causes ?? []).map((id) => CAUSES_BY_ID[id]?.title ?? id);
  return titles.length > 0 ? titles.join("; ") : FOLLOWS_FROM_FEATURES;
}

function row(d, status) {
  return [
    d.label,
    d.module,
    value(d.expected),
    value(d.actual),
    difference(d),
    d.unit ?? "",
    explanation(d, status),
  ];
}

/** The scenario's heading: its outcome, and the gap or problem that frames it. */
function heading(result, problem, gap) {
  if (problem) {
    return `${SCENARIO_INDENT}${UNEXPLAINED_MARK} ${result.id} (${result.outcome}): ${problem}`;
  }
  const suffix =
    result.outcome === OUTCOME.acceptedInvalid && gap ? `: ${gap}` : "";
  return `${SCENARIO_INDENT}${result.id} (${result.outcome})${suffix}`;
}

/** Column widths that fit the header and every row of every table. */
function columnWidths(tables) {
  const rows = [HEADER, ...tables.flatMap((t) => t.rows)];
  return HEADER.map((_, i) => Math.max(...rows.map((r) => r[i].length)));
}

function renderRow(cells, widths) {
  const padded = cells.map((cell, i) =>
    NUMERIC_COLUMNS.has(i) ? cell.padStart(widths[i]) : cell.padEnd(widths[i]),
  );
  return `${TABLE_INDENT}| ${padded.join(" | ")} |`;
}

function renderTable(rows, widths) {
  return [
    renderRow(HEADER, widths),
    renderRow(
      widths.map((w) => "-".repeat(w)),
      widths,
    ),
    ...rows.map((r) => renderRow(r, widths)),
  ];
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
  const tables = [];
  for (const result of results) {
    const discrepancies = result.discrepancies ?? [];
    const problem = problems.get(result.id);
    if (discrepancies.length === 0 && !problem) {
      continue;
    }
    tables.push({
      heading: heading(result, problem, validationGaps[result.id]),
      rows: discrepancies.map((d) =>
        row(d, {
          unexplained: unexplainedKeys.has(`${result.id}\n${d.key}`),
          invalidData: result.outcome === OUTCOME.acceptedInvalid,
        }),
      ),
    });
  }
  if (tables.length === 0) {
    return "";
  }
  const widths = columnWidths(tables);
  return [
    `Differences from the metric (${UNEXPLAINED_MARK} = no known explanation):`,
    ...tables.flatMap((t) => [
      t.heading,
      ...(t.rows.length > 0 ? renderTable(t.rows, widths) : []),
    ]),
  ].join("\n");
}
