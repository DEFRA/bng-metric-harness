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

describe("renderDifferences", () => {
  it("renders nothing when every scenario matches", () => {
    expect(render([result("a/matched", OUTCOME.matched)])).toBe("");
  });

  it("lists each figure that differs, with both values and the difference", () => {
    const lines = render([
      result("a/differs", OUTCOME.discrepancies, [
        featureUnits("H1", [CAUSES.strategicSignificance.id]),
      ]),
    ]).split("\n");

    expect(lines[0]).toMatch(/^Differences from the metric/);
    expect(lines[1]).toBe("  a/differs (discrepancies)");
    expect(lines[2]).toBe(
      "      H1 baseline units [area]: metric 1.1500 habitat units → service 1.0000 habitat units (-0.1500 habitat units) — Strategic significance not applied",
    );
  });

  it("marks a figure nothing explains, and a scenario the comparison fails", () => {
    const text = render([
      result("a/unexplained", OUTCOME.discrepancies, [featureUnits("H1")]),
      result("a/refused", OUTCOME.rejected),
    ]);

    expect(text).toContain(
      "      H1 baseline units [area]: metric 1.1500 habitat units → service 1.0000 habitat units (-0.1500 habitat units) ✗ no known explanation",
    );
    expect(text).toContain(
      "  ✗ a/refused (rejected): The service refused a scenario whose data is valid.",
    );
  });

  it("frames an accepted invalid scenario with the gap that explains it", () => {
    const text = render([
      result("invalid/accepted", OUTCOME.acceptedInvalid, [verdict]),
    ]);

    expect(text).toContain(
      "  invalid/accepted (accepted-invalid): The service does not refuse this yet.",
    );
    expect(text).toContain(
      "      Trading rules [area]: metric Met → service Not met",
    );
    const [, ...lines] = text.split("\n");
    expect(lines.some((line) => line.includes("✗"))).toBe(false);
  });

  it("shows a value one side lacks as —", () => {
    const text = render([
      result("a/missing", OUTCOME.discrepancies, [
        { ...featureUnits("H1"), expected: null, difference: null },
      ]),
    ]);

    expect(text).toContain("metric — → service 1.0000 habitat units ✗");
  });
});
