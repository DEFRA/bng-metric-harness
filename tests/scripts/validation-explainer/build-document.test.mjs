import { describe, expect, it } from "vitest";
import {
  EDIT_GROUP,
  buildDocument,
  buildEditSection,
  noExampleSentence,
  uploadSummary,
} from "../../../.claude/skills/geopackage-validation-explainer/scripts/build-document.mjs";

function entry(copy, { exampleFiles = [], fixtures = [] } = {}) {
  return { copy, exampleFiles, fixtures, raisedAt: [] };
}

function factsFor(codes) {
  return {
    generatedAt: "2026-11-03T00:00:00.000Z",
    provenance: {},
    codes,
    tolerances: {},
    exampleFilesClaimedByNoRule: [],
  };
}

const UPLOAD_ONLY = {
  UPLOAD_A: { group: "Layers", checks: "Checks layer A." },
  UPLOAD_B: { group: "Columns", checks: "Checks column B." },
  // A group name holding a comma, as "Service faults, not your file" does.
  UPLOAD_C: { group: "Links, lineage", checks: "Checks link C." },
};
const WITH_EDITS = {
  ...UPLOAD_ONLY,
  EDIT_A: { group: EDIT_GROUP, checks: "Refuses edit A." },
};

const CODES = {
  UPLOAD_A: entry("dedicated", {
    exampleFiles: ["layers/a.gpkg"],
    fixtures: [{ name: "a" }],
  }),
  UPLOAD_B: entry("catch-all"),
  UPLOAD_C: entry("backend-message"),
  EDIT_A: entry("catch-all"),
};

/** The table row for `code` in a rendered document. */
function rowFor(document, code) {
  return document.split("\n").find((line) => line.startsWith(`| \`${code}\``));
}

describe("uploadSummary", () => {
  it("counts the upload rules only", () => {
    expect(uploadSummary(factsFor(CODES), WITH_EDITS)).toEqual({
      total: 3,
      dedicatedCopy: 1,
      backendMessageCopy: 1,
      placeholderCopy: 0,
      catchAllCopy: 1,
      withExampleFile: 1,
      withFixture: 1,
    });
  });
});

describe("noExampleSentence", () => {
  it("leaves the edit rules out of the rules with no example file", () => {
    expect(noExampleSentence(factsFor(CODES), WITH_EDITS, 3)).toBe(
      "**2 of 3 upload rules have no example file.** By group: Columns 1; Links, lineage 1.",
    );
  });

  it("says so when every upload rule has an example file", () => {
    const codes = {
      ...CODES,
      UPLOAD_B: entry("catch-all", { exampleFiles: ["b.gpkg"] }),
      UPLOAD_C: entry("backend-message", { exampleFiles: ["c.gpkg"] }),
    };
    expect(noExampleSentence(factsFor(codes), WITH_EDITS, 3)).toBe(
      "**Every one of the 3 upload rules has an example file.**",
    );
  });
});

describe("buildDocument", () => {
  const document = buildDocument(factsFor(CODES), WITH_EDITS);

  it("gives the edit rules their own section, after the upload rules and before Coverage", () => {
    const rules = document.indexOf("## The rules");
    const edits = document.indexOf(`## ${EDIT_GROUP}`);
    const coverage = document.indexOf("## Coverage");
    expect(rules).toBeLessThan(edits);
    expect(edits).toBeLessThan(coverage);
    expect(document.slice(rules, edits)).not.toContain("EDIT_A");
  });

  it("says what the user sees for an upload rule, and nothing for an edit rule", () => {
    expect(rowFor(document, "UPLOAD_A")).toContain("The user sees its own message.");
    expect(rowFor(document, "UPLOAD_B")).toContain("The user sees a generic message.");
    expect(rowFor(document, "UPLOAD_C")).toContain(
      "The user sees the service's own message, listing what it names.",
    );
    expect(rowFor(document, "EDIT_A")).not.toContain("The user sees");
  });

  it("counts the upload rules only in the prose and the coverage table", () => {
    expect(document).toContain(
      "Of 3 rules, 1 have a message of their own, 1 show the service's own message as a list",
    );
    expect(document).toContain("| Rules that can reject an upload | 3 |");
    expect(document).toContain("| Showing the service's own message, as a list | 1 |");
    expect(document).toContain("| Falling back to a generic message | 1 |");
  });

  it("renders an extracted threshold in the reader's units in the rule's row", () => {
    const descriptions = {
      ...WITH_EDITS,
      UPLOAD_A: { ...WITH_EDITS.UPLOAD_A, tolerance: "MIN_PARCEL_AREA_SQ_M", toleranceIs: "Smallest area" },
      UPLOAD_B: { ...WITH_EDITS.UPLOAD_B, tolerance: "REDLINE_MAX_AREA_SQ_M" },
    };
    const facts = {
      ...factsFor(CODES),
      tolerances: { MIN_PARCEL_AREA_SQ_M: 0.5, REDLINE_MAX_AREA_SQ_M: 100_000_000 },
    };
    const withThresholds = buildDocument(facts, descriptions);
    expect(rowFor(withThresholds, "UPLOAD_A")).toContain("Checks layer A. Smallest area 0.5 m².");
    expect(rowFor(withThresholds, "UPLOAD_B")).toContain("Checks column B. Tolerance 100 km².");
  });

  it("leaves the edit section out when there are no edit rules", () => {
    const codes = {
      UPLOAD_A: CODES.UPLOAD_A,
      UPLOAD_B: CODES.UPLOAD_B,
      UPLOAD_C: CODES.UPLOAD_C,
    };
    expect(buildEditSection(codes, UPLOAD_ONLY, {})).toBe("");
    const uploadOnly = buildDocument(factsFor(codes), UPLOAD_ONLY);
    expect(uploadOnly).not.toContain(`## ${EDIT_GROUP}`);
    expect(uploadOnly).toContain("## Coverage");
  });
});
