// Which differences from the metric are unexplained, and so fail
// `compare:metric --fail-on-unexplained`. Built from hand-made comparison
// results, so these need no backend.

import { describe, expect, it } from "vitest";
import { CAUSES, OUTCOME } from "#metric-compare";
import {
  VALIDATION_GAPS,
  findUnexplained,
  hasUnexplained,
  metricTotalsOf,
  renderUnexplained,
} from "../../../scripts/metric-comparison/unexplained.mjs";

const featureUnits = (module, ref, causes = [], stage = "baseline") => ({
  key: `feature-units|${module}|${stage}|${ref}`,
  category: "feature-units",
  module,
  label: `${ref} ${stage} units`,
  expected: 1.15,
  actual: 1,
  ...(causes.length > 0 ? { causes } : {}),
});

const total = (module, part = "baseline", expected = 2.15, actual = 2) => ({
  key: `totals|${module}|${part}`,
  category: "totals",
  module,
  label: `${part} units`,
  expected,
  actual,
});

// The metric's area: 2.15 baseline units, a net change of 0.2 (9.30%, short
// of the 10% target). Pricing H1's baseline 0.15 lower takes the service to
// 2 baseline units and a net change of 0.35: 17.5%, which meets it.
const METRIC_TOTALS = {
  area: { baseline: 2.15, "post-intervention": 2.35, "net-change": 0.2 },
};

const netChange = (module, actual = 0.35) =>
  total(module, "net-change", 0.2, actual);

const percentage = (module, actual = 17.5) => ({
  key: `net-gain|${module}|percentage`,
  category: "net-gain",
  module,
  label: "Net change (%)",
  expected: (100 * 0.2) / 2.15,
  actual,
});

const verdict = (module) => ({
  key: `net-gain|${module}|verdict`,
  category: "net-gain",
  module,
  label: "Net gain target (10%)",
  expected: "Not met",
  actual: "Met",
});

const tradingFigure = (module) => ({
  key: `trading-figures|${module}|habitat|grassland`,
  category: "trading-figures",
  module,
  label: "Grassland net unit change",
  expected: 0.2,
  actual: 0.35,
});

const result = (discrepancies, extra = {}) => ({
  id: "purpose/site",
  outcome: discrepancies.length > 0 ? OUTCOME.discrepancies : OUTCOME.matched,
  discrepancies,
  metricTotals: METRIC_TOTALS,
  ...extra,
});

const unexplainedKeys = (discrepancies, extra) =>
  findUnexplained([result(discrepancies, extra)]).discrepancies.map(
    (d) => d.key,
  );

const NOT_IMPLEMENTED = CAUSES.strategicSignificance.id;
const FIXED = CAUSES.sizeDiffers.id;

describe("findUnexplained", () => {
  it("finds nothing in a scenario that matches", () => {
    const found = findUnexplained([result([])]);
    expect(hasUnexplained(found)).toBe(false);
  });

  it("explains a feature that differs for a cause the service does not implement yet", () => {
    const found = findUnexplained([
      result([featureUnits("area", "H1", [NOT_IMPLEMENTED])]),
    ]);
    expect(hasUnexplained(found)).toBe(false);
  });

  it("does not explain a feature that differs for a cause the service has fixed", () => {
    const found = findUnexplained([
      result([featureUnits("area", "H1", [FIXED, NOT_IMPLEMENTED])]),
    ]);
    expect(found.discrepancies).toEqual([
      expect.objectContaining({
        id: "purpose/site",
        label: "H1 baseline units",
      }),
    ]);
  });

  it("does not explain a feature that differs for no known cause", () => {
    const found = findUnexplained([result([featureUnits("area", "H1")])]);
    expect(found.discrepancies).toHaveLength(1);
  });

  it("explains a total that differs by what its features account for", () => {
    expect(
      unexplainedKeys([
        featureUnits("area", "H1", [NOT_IMPLEMENTED]),
        total("area"),
        netChange("area"),
      ]),
    ).toEqual([]);
  });

  it("does not explain a total that differs by more than its features account for", () => {
    // H1 accounts for 0.15 of the baseline total's 0.35.
    expect(
      unexplainedKeys([
        featureUnits("area", "H1", [NOT_IMPLEMENTED]),
        total("area", "baseline", 2.35, 2),
        netChange("area"),
      ]),
    ).toEqual(["totals|area|baseline"]);
  });

  it("sums a module's feature differences into the total for their stage", () => {
    const created = {
      ...featureUnits("area", "H2", [NOT_IMPLEMENTED], "created"),
      expected: 0.5,
      actual: 0.4,
    };
    expect(
      unexplainedKeys([
        featureUnits("area", "H1", [NOT_IMPLEMENTED]),
        created,
        total("area"),
        total("area", "post-intervention", 2.35, 2.25),
        // -0.1 post-intervention less -0.15 baseline
        total("area", "net-change", 0.2, 0.25),
      ]),
    ).toEqual([]);
  });

  it("does not explain a net change that does not follow from the feature differences", () => {
    expect(
      unexplainedKeys([
        featureUnits("area", "H1", [NOT_IMPLEMENTED]),
        total("area"),
        netChange("area", 0.5),
      ]),
    ).toEqual(["totals|area|net-change"]);
  });

  it("explains a net gain percentage and verdict that follow from the reconciled totals", () => {
    expect(
      unexplainedKeys([
        featureUnits("area", "H1", [NOT_IMPLEMENTED]),
        total("area"),
        netChange("area"),
        percentage("area"),
        verdict("area"),
      ]),
    ).toEqual([]);
  });

  it("does not explain a net gain percentage, or its verdict, that does not follow from the totals", () => {
    expect(
      unexplainedKeys([
        featureUnits("area", "H1", [NOT_IMPLEMENTED]),
        total("area"),
        netChange("area"),
        percentage("area", 20),
        verdict("area"),
      ]),
    ).toEqual(["net-gain|area|percentage", "net-gain|area|verdict"]);
  });

  it("does not explain a verdict whose percentage does not differ", () => {
    expect(
      unexplainedKeys([
        featureUnits("area", "H1", [NOT_IMPLEMENTED]),
        total("area"),
        netChange("area"),
        verdict("area"),
      ]),
    ).toEqual(["net-gain|area|verdict"]);
  });

  it("does not explain a net gain percentage without the metric's totals", () => {
    expect(
      unexplainedKeys(
        [
          featureUnits("area", "H1", [NOT_IMPLEMENTED]),
          total("area"),
          netChange("area"),
          percentage("area"),
        ],
        { metricTotals: undefined },
      ),
    ).toEqual(["net-gain|area|percentage"]);
  });

  it("explains a trading rules figure in a module whose totals all reconcile", () => {
    expect(
      unexplainedKeys([
        featureUnits("area", "H1", [NOT_IMPLEMENTED]),
        total("area"),
        netChange("area"),
        tradingFigure("area"),
      ]),
    ).toEqual([]);
  });

  it("does not explain a trading rules figure in a module whose totals do not reconcile", () => {
    // H1 moves the net change, but the service's matches the metric's.
    expect(
      unexplainedKeys([
        featureUnits("area", "H1", [NOT_IMPLEMENTED]),
        total("area"),
        tradingFigure("area"),
      ]),
    ).toEqual(["trading-figures|area|habitat|grassland"]);
  });

  it("does not explain a total in a module whose features all match", () => {
    const found = findUnexplained([
      result([
        featureUnits("area", "H1", [NOT_IMPLEMENTED]),
        total("hedgerow"),
      ]),
    ]);
    expect(found.discrepancies).toEqual([
      expect.objectContaining({ key: "totals|hedgerow|baseline" }),
    ]);
  });

  it("does not explain a total in a module that also has an unexplained feature", () => {
    const found = findUnexplained([
      result([
        featureUnits("area", "H1", [NOT_IMPLEMENTED]),
        featureUnits("area", "H2"),
        total("area"),
      ]),
    ]);
    expect(found.discrepancies.map((d) => d.key)).toEqual([
      "feature-units|area|baseline|H2",
      "totals|area|baseline",
    ]);
  });

  it.each([
    [OUTCOME.rejected, "refused a scenario whose data is valid"],
    [OUTCOME.importFailed, "failed to import"],
    [OUTCOME.workbookUnreadable, "could not be read"],
  ])("fails a scenario whose outcome is %s", (outcome, problem) => {
    const found = findUnexplained([{ id: "purpose/site", outcome }]);
    expect(found.scenarios).toEqual([
      { id: "purpose/site", problem: expect.stringContaining(problem) },
    ]);
  });

  it("explains an invalid scenario the service accepts when a validation gap names it", () => {
    const found = findUnexplained(
      [
        result([featureUnits("area", "H1"), total("area")], {
          outcome: OUTCOME.acceptedInvalid,
        }),
      ],
      { "purpose/site": "The service does not check this yet." },
    );
    expect(hasUnexplained(found)).toBe(false);
  });

  it("fails an invalid scenario the service accepts when no validation gap names it", () => {
    const found = findUnexplained(
      [result([], { outcome: OUTCOME.acceptedInvalid })],
      {},
    );
    expect(found.scenarios).toEqual([
      expect.objectContaining({ id: "purpose/site" }),
    ]);
  });

  it("reports a validation gap the service no longer needs as stale, without failing", () => {
    const found = findUnexplained(
      [{ id: "purpose/site", outcome: OUTCOME.rejectedAsExpected }],
      { "purpose/site": "The service does not check this yet." },
    );
    expect(found.stale).toEqual(["purpose/site"]);
    expect(hasUnexplained(found)).toBe(false);
  });

  it("names only invalid scenarios in its validation gaps", () => {
    for (const id of Object.keys(VALIDATION_GAPS)) {
      expect(id.split("/").at(-1)).toMatch(/^invalid-/);
    }
  });
});

describe("metricTotalsOf", () => {
  it("keeps the metric's unit totals per module", () => {
    expect(
      metricTotalsOf([
        { key: "totals|area|baseline", category: "totals", value: 2 },
        { key: "totals|area|net-change", category: "totals", value: 0.3 },
        { key: "net-gain|area|percentage", category: "net-gain", value: 15 },
      ]),
    ).toEqual({ area: { baseline: 2, "net-change": 0.3 } });
  });
});

describe("renderUnexplained", () => {
  it("is empty when everything is explained", () => {
    expect(
      renderUnexplained({ scenarios: [], discrepancies: [], stale: [] }),
    ).toBe("");
  });

  it("lists each unexplained figure with both values", () => {
    const markdown = renderUnexplained(
      findUnexplained([result([featureUnits("area", "H1")])]),
    );
    expect(markdown).toContain("Unexplained differences");
    expect(markdown).toContain(
      "| purpose/site | H1 baseline units | 1.15 | 1 | — |",
    );
  });
});
