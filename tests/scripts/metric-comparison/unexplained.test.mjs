// Which differences from the metric are unexplained, and so fail
// `compare:metric --fail-on-unexplained`. Built from hand-made comparison
// results, so these need no backend.

import { describe, expect, it } from "vitest";
import { CAUSES, OUTCOME } from "#metric-compare";
import {
  VALIDATION_GAPS,
  findUnexplained,
  hasUnexplained,
  renderUnexplained,
} from "../../../scripts/metric-comparison/unexplained.mjs";

const featureUnits = (module, ref, causes = []) => ({
  key: `feature-units|${module}|baseline|${ref}`,
  category: "feature-units",
  module,
  label: `${ref} baseline units`,
  expected: 1.15,
  actual: 1,
  ...(causes.length > 0 ? { causes } : {}),
});

const total = (module) => ({
  key: `totals|${module}|baseline`,
  category: "totals",
  module,
  label: "Baseline units",
  expected: 2.15,
  actual: 2,
});

const verdict = (module) => ({
  key: `net-gain|${module}|verdict`,
  category: "net-gain",
  module,
  label: "Net gain target (10%)",
  expected: "Met",
  actual: "Not met",
});

const result = (discrepancies, extra = {}) => ({
  id: "purpose/site",
  outcome: discrepancies.length > 0 ? OUTCOME.discrepancies : OUTCOME.matched,
  discrepancies,
  ...extra,
});

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

  it("explains totals and verdicts in a module whose features differ for a cause not implemented yet", () => {
    const found = findUnexplained([
      result([
        featureUnits("area", "H1", [NOT_IMPLEMENTED]),
        total("area"),
        verdict("area"),
      ]),
    ]);
    expect(hasUnexplained(found)).toBe(false);
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
