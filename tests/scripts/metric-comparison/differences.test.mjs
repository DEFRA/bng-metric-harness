// Every difference from the metric as console lines, for the CI log. Built
// from hand-made comparison results, so these need no backend.

import { describe, expect, it } from "vitest";
import { CAUSES, OUTCOME } from "#metric-compare";
import { renderDifferences } from "../../../scripts/metric-comparison/differences.mjs";
import { findUnexplained } from "../../../scripts/metric-comparison/unexplained.mjs";

const GAPS = { "invalid/accepted": "The service does not refuse this yet." };

const featureUnits = (ref, causes = []) => ({
  key: `feature-units|area|baseline|${ref}`,
  category: "feature-units",
  module: "area",
  label: `${ref} baseline units`,
  unit: "habitat units",
  differenceUnit: "habitat units",
  expected: 1.15,
  actual: 1,
  difference: -0.15,
  ...(causes.length > 0 ? { causes } : {}),
});

const percentage = {
  key: "net-gain|area|percentage",
  category: "net-gain",
  module: "area",
  label: "Net change (%)",
  unit: "% of baseline units",
  differenceUnit: "percentage points",
  expected: 9.3,
  actual: 17.5,
  difference: 8.2,
};

const verdict = {
  key: "trading-status|area|overall",
  category: "trading-status",
  module: "area",
  label: "Trading rules",
  unit: "Met / Not met",
  expected: "Met",
  actual: "Not met",
  difference: null,
};

const result = (id, outcome, discrepancies = []) => ({
  id,
  outcome,
  discrepancies,
});

const render = (results) =>
  renderDifferences(results, findUnexplained(results, GAPS), GAPS);

/** A table row's cells, trimmed, so a test need not care about the padding. */
const cells = (line) =>
  line
    .trim()
    .slice(1, -1)
    .split("|")
    .map((c) => c.trim());

describe("renderDifferences", () => {
  it("renders nothing when every scenario matches", () => {
    expect(render([result("a/matched", OUTCOME.matched)])).toBe("");
  });

  it("tables each figure that differs: both values, the difference, the unit and the cause", () => {
    const lines = render([
      result("a/differs", OUTCOME.discrepancies, [
        featureUnits("H1", [CAUSES.strategicSignificance.id]),
        percentage,
      ]),
    ]).split("\n");

    expect(lines[0]).toMatch(/^Differences from the metric/);
    expect(lines[2]).toBe("  a/differs (discrepancies)");
    expect(cells(lines[3])).toEqual([
      "Figure",
      "Module",
      "Metric",
      "Service",
      "Difference",
      "Unit",
      "Explained by",
    ]);
    expect(lines[4]).toMatch(
      /^ {6}\| -+ \| -+ \| -+ \| -+ \| -+ \| -+ \| -+ \|$/,
    );
    expect(cells(lines[5])).toEqual([
      "H1 baseline units",
      "area",
      "1.1500",
      "1.0000",
      "-0.1500",
      "habitat units",
      "Strategic significance not applied",
    ]);
    expect(cells(lines[6])).toEqual([
      "Net change (%)",
      "area",
      "9.3000",
      "17.5000",
      "+8.2000 percentage points",
      "% of baseline units",
      // Without the metric's totals, nothing explains a percentage.
      "✗ no known explanation",
    ]);
  });

  it("pads every table to the same widths, with numbers aligned on the right", () => {
    const lines = render([
      result("a/short", OUTCOME.discrepancies, [featureUnits("H1")]),
      result("a/long", OUTCOME.discrepancies, [
        { ...featureUnits("H1"), label: "A much longer figure label" },
      ]),
    ]).split("\n");
    const [, , , shortHeader, , shortRow, , , longHeader, , longRow] = lines;

    expect(shortHeader).toBe(longHeader);
    expect(shortRow.length).toBe(longRow.length);
    expect(shortRow).toContain("| H1 baseline units          |");
    expect(shortRow).toContain("| 1.1500 |");
  });

  it("says a derived figure follows from the feature differences", () => {
    const h1 = featureUnits("H1", [CAUSES.strategicSignificance.id]);
    const baselineTotal = {
      key: "totals|area|baseline",
      category: "totals",
      module: "area",
      label: "Baseline units",
      unit: "habitat units",
      expected: 2.15,
      actual: 2,
      difference: -0.15,
    };
    const lines = render([
      result("a/derived", OUTCOME.discrepancies, [h1, baselineTotal]),
    ]).split("\n");

    expect(cells(lines[5]).at(-1)).toBe("Strategic significance not applied");
    expect(cells(lines[6]).at(-1)).toBe("From the features above");
  });

  it("keys each explanation the tables use, with a sentence, and no other", () => {
    const text = render([
      result("a/derived", OUTCOME.discrepancies, [
        featureUnits("H1", [CAUSES.strategicSignificance.id]),
      ]),
    ]);
    const key = text.slice(text.indexOf("\nExplained by:\n"));

    expect(key).toBe(
      "\nExplained by:\n  Strategic significance not applied: The service priced the feature at a strategic significance multiplier of 1 where the metric applied 1.1 (location ecologically desirable) or 1.15 (formally identified in a local strategy).",
    );
  });

  it("marks a figure nothing explains, and a scenario the comparison fails", () => {
    const text = render([
      result("a/unexplained", OUTCOME.discrepancies, [featureUnits("H1")]),
      result("a/refused", OUTCOME.rejected),
    ]);

    expect(text).toContain("| ✗ no known explanation |");
    expect(text).toContain(
      "  ✗ a/refused (rejected): The service refused a scenario whose data is valid.",
    );
  });

  it("frames an accepted invalid scenario with the gap that explains it", () => {
    const lines = render([
      result("invalid/accepted", OUTCOME.acceptedInvalid, [verdict]),
    ]).split("\n");

    expect(lines[2]).toBe(
      "  invalid/accepted (accepted-invalid): The service does not refuse this yet.",
    );
    expect(cells(lines[5])).toEqual([
      "Trading rules",
      "area",
      "Met",
      "Not met",
      "",
      "Met / Not met",
      "Invalid data",
    ]);
    expect(lines.slice(1).some((line) => line.includes("✗"))).toBe(false);
  });

  it("shows a value one side lacks as —", () => {
    const lines = render([
      result("a/missing", OUTCOME.discrepancies, [
        { ...featureUnits("H1"), expected: null, difference: null },
      ]),
    ]).split("\n");

    expect(cells(lines[5]).slice(2, 5)).toEqual(["—", "1.0000", ""]);
  });
});
