import { describe, expect, it, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertExpectedImport,
  readImportExpectations,
} from "../../../scripts/metric-comparison/import-expectations.mjs";

import { runMetricComparison } from "../../../scripts/metric-comparison/run-metric-comparison.mjs";

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
    path.join(directory, entry.files.postIntervention),
    "fixture placeholder",
  );
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
  it.each(["missing.gpkg", undefined, ""])(
    "refuses a missing or invalid PI filename: %s",
    (piFile) => {
      const directory = manifestDirectory(expected);
      const file = path.join(directory, "manifest.json");
      const manifest = JSON.parse(readFileSync(file, "utf8"));
      manifest.scenarios[0].files.postIntervention = piFile;
      writeFileSync(file, JSON.stringify(manifest));
      expect(() => readImportExpectations(directory)).toThrow(/file|path/);
    },
  );
  it("refuses a directory in place of a PI file", () => {
    const directory = manifestDirectory(expected);
    const piFile = path.join(
      directory,
      "invalid-timing-post-intervention.gpkg",
    );
    rmSync(piFile);
    mkdirSync(piFile);
    expect(() => readImportExpectations(directory)).toThrow(
      "not a regular file",
    );
  });
  it.each([undefined, []])(
    "fails a full run with an undiscovered contract (%j)",
    async (only) => {
      const directory = manifestDirectory(expected);
      await expect(
        runMetricComparison({ corpusDir: directory, only }),
      ).rejects.toThrow("no matching scenario");
    },
  );
  it("allows a filtered run to leave unselected contracts unconsumed", async () => {
    const directory = manifestDirectory(expected);
    const result = await runMetricComparison({
      corpusDir: directory,
      only: ["another-scenario"],
    });
    expect(result.results).toEqual([]);
  });
  it("refuses duplicate contracts", () => {
    expect(() =>
      readImportExpectations(manifestDirectory(expected, true)),
    ).toThrow("Duplicate");
  });
});

describe("expectation files stay inside the selected corpus", () => {
  it.each(["../escape.gpkg", path.resolve(tmpdir(), "absolute.gpkg")])(
    "refuses an escaped expectation path: %s",
    (piFile) => {
      const directory = manifestDirectory(expected);
      const file = path.join(directory, "manifest.json");
      const manifest = JSON.parse(readFileSync(file, "utf8"));
      manifest.scenarios[0].files.postIntervention = piFile;
      writeFileSync(file, JSON.stringify(manifest));
      expect(() => readImportExpectations(directory)).toThrow(
        /escapes|relative/,
      );
    },
  );
  it("refuses a directory link whose target escapes the selected corpus", () => {
    const directory = manifestDirectory(expected);
    const outside = mkdtempSync(path.join(tmpdir(), "timing-outside-"));
    scratch.push(outside);
    writeFileSync(path.join(outside, "external.gpkg"), "fixture placeholder");
    symlinkSync(outside, path.join(directory, "escape"), "junction");
    const file = path.join(directory, "manifest.json");
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    manifest.scenarios[0].files.postIntervention = "escape/external.gpkg";
    writeFileSync(file, JSON.stringify(manifest));
    expect(() => readImportExpectations(directory)).toThrow(
      "escapes the corpus",
    );
  });
});
