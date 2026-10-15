import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertExpectedImport,
  readImportExpectations,
} from "../../../scripts/metric-comparison/import-expectations.mjs";

const expected = {
  accepted: true,
  features: [
    {
      layer: "habitats",
      ref: "H001",
      proposed: { advanceYears: null, delayYears: null },
    },
  ],
};
function imported(proposed = { advanceYears: null, delayYears: null }) {
  return {
    accepted: true,
    project: {
      project: { postIntervention: { habitats: [{ ref: "H001", proposed }] } },
    },
  };
}
describe("saved timing assertions", () => {
  it("accepts exactly saved nulls", () =>
    expect(() => assertExpectedImport(imported(), expected)).not.toThrow());
  it.each([
    { advanceYears: 0, delayYears: 0 },
    { advanceYears: 2, delayYears: 3 },
    {},
  ])("fails when null timing was not saved: %j", (proposed) => {
    expect(() => assertExpectedImport(imported(proposed), expected)).toThrow(
      "expected null",
    );
  });
  it("fails rather than treating rejection as expected for a cleansing scenario", () => {
    expect(() => assertExpectedImport({ accepted: false }, expected)).toThrow(
      "must be accepted",
    );
  });
  it("fails for a missing or ambiguous feature", () => {
    const result = imported();
    result.project.project.postIntervention.habitats = [];
    expect(() => assertExpectedImport(result, expected)).toThrow("one feature");
    result.project.project.postIntervention.habitats = [
      { ref: "H001" },
      { ref: "H001" },
    ];
    expect(() => assertExpectedImport(result, expected)).toThrow("one feature");
  });
  it("checks Lost linear/tree absence explicitly", () => {
    const absence = {
      accepted: true,
      features: [{ layer: "trees", ref: "T001", absent: true }],
    };
    expect(() => assertExpectedImport(imported(), absence)).not.toThrow();
    const result = imported();
    result.project.project.postIntervention.trees = [{ ref: "T001" }];
    expect(() => assertExpectedImport(result, absence)).toThrow(
      "must be absent",
    );
  });
});

const scratch = [];
afterEach(() => {
  for (const directory of scratch.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});
function manifestDirectory(expectations, duplicate = false) {
  const directory = mkdtempSync(path.join(tmpdir(), "timing-manifest-"));
  scratch.push(directory);
  const entry = {
    id: "invalid-timing",
    files: { postIntervention: "invalid-timing-post-intervention.gpkg" },
    expectedImport: expectations,
  };
  writeFileSync(
    path.join(directory, "manifest.json"),
    JSON.stringify({ scenarios: duplicate ? [entry, entry] : [entry] }),
  );
  return directory;
}
describe("manifest acceptance contracts", () => {
  it("loads the explicit acceptance and attribute assertions by file", () => {
    const directory = manifestDirectory(expected);
    expect(
      readImportExpectations(directory).get(
        path.join(directory, "invalid-timing-post-intervention.gpkg"),
      ),
    ).toEqual(expected);
  });
  it.each([
    { accepted: false, features: expected.features },
    { accepted: true, features: [] },
    {
      accepted: true,
      features: [
        { layer: "habitats", ref: "H001", proposed: { advanceYears: null } },
      ],
    },
    {
      accepted: true,
      features: [{ layer: "typo", ref: "H001", absent: true }],
    },
    {
      accepted: true,
      features: [
        { layer: "habitats", ref: "H001", proposed: { advanceYears: 0 } },
      ],
    },
    {
      accepted: true,
      features: [{ layer: "habitats", ref: "H001", proposed: { units: null } }],
    },
  ])(
    "refuses malformed contracts rather than excusing invalid acceptance: %j",
    (contract) => {
      expect(() =>
        readImportExpectations(manifestDirectory(contract)),
      ).toThrow();
    },
  );
  it("refuses duplicate contracts", () => {
    expect(() =>
      readImportExpectations(manifestDirectory(expected, true)),
    ).toThrow("Duplicate");
  });
});
