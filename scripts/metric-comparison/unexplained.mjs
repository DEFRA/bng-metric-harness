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
 * - it is a figure derived from the feature units, in a module whose feature
 *   units differ only for such causes, and it differs by exactly what those
 *   feature differences account for (see derivedExplanations). Sitting in the
 *   same module is not enough: a total that moves further than its features
 *   do is unexplained. A module whose features all match has no excuse for a
 *   total that does not;
 * - the scenario holds invalid data the service does not refuse yet, and
 *   VALIDATION_GAPS says which check the service lacks. The metric computes
 *   nothing meaningful for invalid rows, so none of that scenario's figures
 *   can fail it;
 * - it is a feature's units in a scenario INCOMPLETE_FEATURES names, the
 *   metric has none and the service has zero: a feature the service saves
 *   Incomplete. Only those features are excused; every other figure in the
 *   scenario is held to the rules above.
 *
 * Anything else fails: a figure that differs for no known reason, a figure
 * one side has and the other does not, a valid scenario the service refuses,
 * an import that crashes, and a workbook that cannot be read.
 */

import {
  CATEGORY,
  CAUSES_BY_ID,
  KEY_SEPARATOR,
  OUTCOME,
} from "#metric-compare";

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
});

/**
 * Scenarios with features the service accepts by design but saves Incomplete,
 * with zero units, where the metric prices nothing: why. The service does not
 * mean to refuse these, so unlike a validation gap the scenario is still
 * compared; only a feature the metric has no units for and the service prices
 * at zero is excused (isIncompleteFeature). An entry is reported as stale
 * once the service refuses the scenario.
 */
export const INCOMPLETE_FEATURES = Object.freeze({
  "data-completeness/invalid-data-incomplete":
    "The service accepts an enhancement with no proposed condition or strategic significance and saves it Incomplete, with the strategic significance nulled and zero units, where the metric prices nothing (BMD-1051).",
});

/** Outcomes that fail a scenario whatever its figures. */
const FAILED_OUTCOMES = Object.freeze({
  [OUTCOME.rejected]: "The service refused a scenario whose data is valid.",
  [OUTCOME.importFailed]: "The service failed to import the scenario.",
  [OUTCOME.workbookUnreadable]: "The metric workbook could not be read.",
});

/**
 * A feature the metric has no units for and the service prices at zero: what
 * the service does with a feature it saves Incomplete.
 */
export function isIncompleteFeature(discrepancy) {
  return (
    discrepancy.category === CATEGORY.featureUnits &&
    discrepancy.expected === null &&
    discrepancy.actual === 0
  );
}

function isNotImplementedYet(discrepancy) {
  return (
    discrepancy.causes?.length > 0 &&
    discrepancy.causes.every((id) => CAUSES_BY_ID[id]?.notImplemented)
  );
}

/** A module's unit totals, as their figure keys end. */
const TOTAL = Object.freeze({
  baseline: "baseline",
  postIntervention: "post-intervention",
  netChange: "net-change",
});

/** The total each feature stage adds up into. */
const TOTAL_OF_STAGE = Object.freeze({
  baseline: TOTAL.baseline,
  retained: TOTAL.postIntervention,
  enhanced: TOTAL.postIntervention,
  created: TOTAL.postIntervention,
});

/**
 * How closely a derived figure must move by what its features account for.
 * Both are sums of figures already rounded to 15 significant figures, and a
 * feature that matches within the comparison's tolerance still moves its
 * total by up to that tolerance, so the two agree only to about this.
 * Anything a pricing difference could do is far larger.
 */
const RECONCILE_TOLERANCE = Object.freeze({ relative: 1e-9, absolute: 1e-9 });
const PERCENT = 100;

function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function agrees(a, b) {
  const scale = Math.max(Math.abs(a), Math.abs(b));
  return (
    Math.abs(a - b) <=
    Math.max(RECONCILE_TOLERANCE.absolute, RECONCILE_TOLERANCE.relative * scale)
  );
}

/** How far the service moved a figure from the metric's; null if either has none. */
function shiftOf(discrepancy) {
  return isNumber(discrepancy.expected) && isNumber(discrepancy.actual)
    ? discrepancy.actual - discrepancy.expected
    : null;
}

/** A figure's key without its category and module: ["baseline"], say. */
function pathOf(discrepancy) {
  return discrepancy.key.split(KEY_SEPARATOR).slice(2);
}

/**
 * Per module whose feature units differ only for causes not implemented yet,
 * how far those differences move its baseline and post-intervention totals.
 * A module with any other feature difference is left out: nothing derived
 * from it can be explained.
 */
function featureShifts(discrepancies) {
  const shifts = new Map();
  const tainted = new Set();
  const features = discrepancies.filter(
    (d) => d.category === CATEGORY.featureUnits,
  );
  for (const d of features) {
    const total = TOTAL_OF_STAGE[pathOf(d)[0]];
    const shift = shiftOf(d);
    if (!isNotImplementedYet(d) || !total || shift === null) {
      tainted.add(d.module);
      continue;
    }
    const module = shifts.get(d.module) ?? {
      [TOTAL.baseline]: 0,
      [TOTAL.postIntervention]: 0,
    };
    module[total] += shift;
    shifts.set(d.module, module);
  }
  for (const module of tainted) {
    shifts.delete(module);
  }
  return shifts;
}

/** What the features move each of a module's totals by. */
function expectedTotalShifts(shift) {
  return {
    ...shift,
    [TOTAL.netChange]: shift[TOTAL.postIntervention] - shift[TOTAL.baseline],
  };
}

/**
 * Whether every total in the module moved by what its features account for:
 * a total that differs by that much, or one that matches where they account
 * for nothing.
 */
function totalsReconcile(expected, totals) {
  return Object.entries(expected).every(([part, shift]) => {
    const total = totals.get(part);
    const observed = total ? shiftOf(total) : 0;
    return observed !== null && agrees(observed, shift);
  });
}

/**
 * The net change percentage the service should show: the metric's, with the
 * totals moved by what the features account for.
 */
function expectedPercentage(metric, expected) {
  const baseline = metric?.[TOTAL.baseline];
  const netChange = metric?.[TOTAL.netChange];
  if (!isNumber(baseline) || !isNumber(netChange)) {
    return null;
  }
  const shiftedBaseline = baseline + expected[TOTAL.baseline];
  return shiftedBaseline === 0
    ? null
    : (PERCENT * (netChange + expected[TOTAL.netChange])) / shiftedBaseline;
}

/**
 * The derived figures (totals, net gain, trading rules) the feature
 * differences explain, as a set of keys. Each must follow from those
 * differences, not merely share their module:
 *
 * - a total must differ by the sum of its stages' feature differences
 *   (baseline; retained, enhanced and created for post-intervention), and the
 *   net change by the post-intervention sum less the baseline's;
 * - the net change percentage must be the metric's recomputed on the totals
 *   so moved, which needs the metric's own totals (`metricTotals`);
 * - the net gain verdict must differ only where that percentage does, for
 *   the service's verdict is reproduced from its percentage;
 * - a trading rules figure or status only in a module whose totals all
 *   reconcile. The feature figures do not say which habitat or band a feature
 *   is in, so the trading figures cannot be summed feature by feature yet.
 */
function derivedExplanations(discrepancies, metricTotals) {
  const explained = new Set();
  const byModule = Map.groupBy(
    discrepancies.filter((d) => d.category !== CATEGORY.featureUnits),
    (d) => d.module,
  );
  for (const [module, shift] of featureShifts(discrepancies)) {
    explainModule(explained, {
      derived: byModule.get(module) ?? [],
      expected: expectedTotalShifts(shift),
      metric: metricTotals?.[module],
    });
  }
  return explained;
}

/** One module's share of derivedExplanations. */
function explainModule(explained, { derived, expected, metric }) {
  const totals = new Map(
    derived
      .filter((d) => d.category === CATEGORY.totals)
      .map((d) => [pathOf(d)[0], d]),
  );
  for (const [part, total] of totals) {
    const observed = shiftOf(total);
    if (
      observed !== null &&
      part in expected &&
      agrees(observed, expected[part])
    ) {
      explained.add(total.key);
    }
  }
  if (!totalsReconcile(expected, totals)) {
    return;
  }
  explainNetGain(explained, derived, expectedPercentage(metric, expected));
  for (const d of derived) {
    if (
      d.category === CATEGORY.tradingFigures ||
      d.category === CATEGORY.tradingStatus
    ) {
      explained.add(d.key);
    }
  }
}

function explainNetGain(explained, derived, percentage) {
  const netGain = derived.filter((d) => d.category === CATEGORY.netGain);
  const figure = netGain.find((d) => pathOf(d)[0] === "percentage");
  if (
    !figure ||
    percentage === null ||
    !isNumber(figure.actual) ||
    !agrees(figure.actual, percentage)
  ) {
    return;
  }
  for (const d of netGain) {
    explained.add(d.key);
  }
}

function unexplainedDiscrepancies(result, incomplete) {
  const discrepancies = (result.discrepancies ?? []).filter(
    (d) => !(incomplete && isIncompleteFeature(d)),
  );
  const derived = derivedExplanations(discrepancies, result.metricTotals);
  return discrepancies.filter((d) =>
    d.category === CATEGORY.featureUnits
      ? !isNotImplementedYet(d)
      : !derived.has(d.key),
  );
}

/**
 * The metric's unit totals per module, which a comparison result does not
 * keep for the totals that match, but the net change percentage is
 * reconciled against: `{ area: { baseline, "post-intervention",
 * "net-change" } }`.
 *
 * @param {object[]} figures the workbook's figures, from figuresFromWorkbook
 */
export function metricTotalsOf(figures) {
  const totals = {};
  for (const f of figures ?? []) {
    if (f.category === CATEGORY.totals) {
      const [, module, part] = f.key.split(KEY_SEPARATOR);
      totals[module] = { ...totals[module], [part]: f.value };
    }
  }
  return totals;
}

function addResult(found, result, { gap, incomplete }) {
  if (FAILED_OUTCOMES[result.outcome]) {
    found.scenarios.push({
      id: result.id,
      problem: FAILED_OUTCOMES[result.outcome],
    });
    return;
  }
  const acceptedInvalid = result.outcome === OUTCOME.acceptedInvalid;
  if (acceptedInvalid && gap) {
    return;
  }
  if (acceptedInvalid && !incomplete) {
    found.scenarios.push({
      id: result.id,
      problem:
        "The service accepted a scenario built on invalid data, and no validation gap explains it.",
    });
    return;
  }
  if (!acceptedInvalid && (gap || incomplete)) {
    found.stale.push(result.id);
  }
  for (const d of unexplainedDiscrepancies(result, incomplete)) {
    found.discrepancies.push({ id: result.id, ...d });
  }
}

/**
 * @param {object[]} results compareScenario results
 * @param {Record<string, string>} [validationGaps]
 * @param {Record<string, string>} [incompleteFeatures]
 * @returns {{
 *   scenarios: Array<{ id: string, problem: string }>,
 *   discrepancies: Array<{ id: string } & object>,
 *   stale: string[]
 * }} `scenarios` fail outright; `discrepancies` are the figures nothing
 *   explains; `stale` names validation gaps and incomplete-feature entries
 *   the run did not need
 */
export function findUnexplained(
  results,
  validationGaps = VALIDATION_GAPS,
  incompleteFeatures = INCOMPLETE_FEATURES,
) {
  const found = { scenarios: [], discrepancies: [], stale: [] };
  for (const result of results) {
    addResult(found, result, {
      gap: validationGaps[result.id],
      incomplete: incompleteFeatures[result.id],
    });
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
      "The service now refuses these scenarios, so their entries in `VALIDATION_GAPS` or `INCOMPLETE_FEATURES` can go:",
      "",
      ...stale.map((id) => `- ${id}`),
      "",
    );
  }
  return lines.join("\n");
}
