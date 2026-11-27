// What each example file should do on upload, and how a wrong result is
// reported. Needs no backend, so it runs with every harness pull request; the
// uploads themselves are in legacy-uploads.test.mjs and
// service-template-uploads.test.mjs.

import { describe, expect, it } from "vitest";
import {
  ACCEPTED,
  BASELINE,
  LEGACY,
  POST_INTERVENTION,
  REFUSED,
  SERVICE_TEMPLATE,
  corpusFiles,
  expectationFor,
  folderOf,
  isUploaded,
  templateOf,
  unclassifiedFolders,
  uploadsFor,
} from "../../../scripts/example-uploads/expectations.mjs";
import {
  describeOutcome,
  summaryMarkdown,
  verdict,
} from "../../../scripts/example-uploads/report.mjs";
import { FAILED } from "../../../scripts/example-uploads/upload-example-file.mjs";
import { readmeRows } from "../../../scripts/service-template/readme-rows.mjs";

const TEMPLATES = [LEGACY, SERVICE_TEMPLATE];
const ALL_FILES = TEMPLATES.flatMap((template) => corpusFiles(template));

describe("the example files' expectations", () => {
  it.each(TEMPLATES)(
    "say what to do with every folder of the %s corpus",
    (template) => {
      expect(unclassifiedFolders(corpusFiles(template))).toEqual([]);
    },
  );

  it("keep the two corpora apart", () => {
    expect(
      corpusFiles(LEGACY).some((file) => file.startsWith("service-template/")),
    ).toBe(false);
    expect(
      corpusFiles(SERVICE_TEMPLATE).every((file) =>
        file.startsWith("service-template/"),
      ),
    ).toBe(true);
  });

  it.each(TEMPLATES)(
    "upload valid files and files with problems from the %s corpus",
    (template) => {
      const uploaded = corpusFiles(template).filter(isUploaded);
      const expected = uploaded.map((file) => expectationFor(file).expected);
      expect(expected).toContain(ACCEPTED);
      expect(expected).toContain(REFUSED);
    },
  );

  it("expect every file in a valid/ folder to be accepted", () => {
    const valid = ALL_FILES.filter((file) => folderOf(file) === "valid");
    expect(valid.length).toBeGreaterThan(0);
    for (const file of valid) {
      expect(expectationFor(file), file).toEqual({ expected: ACCEPTED });
    }
  });

  it("leave out bng-500/ and the scenario corpus", () => {
    expect(isUploaded("bng-500/BROADLAND_2024_3282-baseline.gpkg")).toBe(false);
    expect(isUploaded("service-template/permutations/net-gain/x.gpkg")).toBe(
      false,
    );
    expect(isUploaded("valid/Baseline - complete with area refs.gpkg")).toBe(
      true,
    );
  });

  it("expect every file in a folder of problems to be refused", () => {
    const problems = ALL_FILES.filter(isUploaded).filter(
      (file) => !["valid", "incomplete"].includes(folderOf(file)),
    );
    expect(problems.length).toBeGreaterThan(0);
    for (const file of problems) {
      expect(expectationFor(file), file).toEqual({ expected: REFUSED });
    }
  });

  it("refuse a file with its folder's problem, and accept a valid one", () => {
    expect(expectationFor("malformed/Not a valid geopackage.gpkg")).toEqual({
      expected: REFUSED,
    });
    expect(expectationFor("valid/Baseline - no hedgerows.gpkg")).toEqual({
      expected: ACCEPTED,
    });
  });

  it("stop on a folder it does not know", () => {
    expect(() => expectationFor("new-folder/a.gpkg")).toThrow(
      /in new-folder\/, which .* does not say/,
    );
  });
});

// The BNG Service template README's Expected column, which readme.mjs writes
// from the recipes, read the way its rows are worded: "accepted …" or "saved as
// Incomplete …" is accepted; anything else, a code or "refused: …", is
// refused.
const ACCEPTED_CELL = /^\(?(accepted|saved as Incomplete)\b/i;
function readmeSays(expected) {
  return ACCEPTED_CELL.test(expected) ? ACCEPTED : REFUSED;
}

function expectationsSay(file) {
  return expectationFor(file).expected;
}

describe("the BNG Service template's folders", () => {
  it("agree with its README's Expected column for every file uploaded", () => {
    const disagree = [...readmeRows()]
      .map(([row, { expected }]) => ({
        file: `${SERVICE_TEMPLATE}/${row}`,
        expected,
      }))
      .filter(({ file }) => isUploaded(file))
      .filter(
        ({ file, expected }) => readmeSays(expected) !== expectationsSay(file),
      )
      .map(
        ({ file, expected }) =>
          `${file}: the README says "${expected}", expectations.mjs says ${expectationsSay(file)}`,
      );
    expect(disagree).toEqual([]);
  });

  it("read the README's wording as meant", () => {
    expect(readmeSays("accepted since BMD-1058")).toBe(ACCEPTED);
    expect(readmeSays("(accepted; saved Incomplete with both cleared)")).toBe(
      ACCEPTED,
    );
    expect(readmeSays("saved as Incomplete, for want of years")).toBe(ACCEPTED);
    expect(readmeSays("accepted: a site need not have hedgerows")).toBe(
      ACCEPTED,
    );
    expect(readmeSays("IRREPLACEABLE_TREE")).toBe(REFUSED);
    expect(readmeSays("refused: the file cannot be read as a GeoPackage")).toBe(
      REFUSED,
    );
  });
});

describe("the uploads a user makes with an example file", () => {
  it.each([
    ["valid/Baseline - complete with area refs.gpkg", [BASELINE]],
    ["valid/Post-intervention - complete.gpkg", [POST_INTERVENTION]],
    [
      "bng-500/CAMBRIDGE_24_03964_FUL-post-intervention.gpkg",
      [POST_INTERVENTION],
    ],
    ["bng-500/CAMBRIDGE_24_03964_FUL-baseline.gpkg", [BASELINE]],
    ["service-template/valid/default-site.gpkg", [BASELINE, POST_INTERVENTION]],
    ["service-template/valid/default-site-baseline.gpkg", [BASELINE]],
  ])("%s: %j", (file, uploads) => {
    expect(uploadsFor(file)).toEqual(uploads);
  });

  it("tell the corpora apart by path", () => {
    expect(templateOf("service-template/valid/default-site.gpkg")).toBe(
      SERVICE_TEMPLATE,
    );
    expect(templateOf("valid/Post-intervention - complete.gpkg")).toBe(LEGACY);
    expect(folderOf("service-template/valid/default-site.gpkg")).toBe("valid");
  });
});

describe("the report of an upload", () => {
  const FILE = "valid/a.gpkg";
  const accepted = {
    outcome: ACCEPTED,
    uploads: [BASELINE, POST_INTERVENTION],
  };
  const refused = {
    outcome: REFUSED,
    uploads: [BASELINE, POST_INTERVENTION],
    refusedAt: POST_INTERVENTION,
    codes: ["PARCEL_OVERLAPS", "AREA_SUM_MISMATCH"],
  };
  const failed = {
    outcome: FAILED,
    uploads: [BASELINE],
    refusedAt: BASELINE,
    message: "boom",
  };

  it("says what happened, with the upload and any error codes", () => {
    expect(describeOutcome(accepted)).toBe(
      "accepted (baseline then post-intervention upload)",
    );
    expect(describeOutcome(refused)).toBe(
      "refused at the post-intervention upload with PARCEL_OVERLAPS, AREA_SUM_MISMATCH",
    );
    expect(describeOutcome(failed)).toBe(
      "the service threw at the baseline upload: boom",
    );
  });

  it("passes the expected result, and names the file, the expectation and the result otherwise", () => {
    expect(verdict(FILE, { expected: ACCEPTED }, accepted).pass).toBe(true);
    expect(verdict(FILE, { expected: REFUSED }, refused).pass).toBe(true);

    const wrong = verdict(FILE, { expected: ACCEPTED }, refused);
    expect(wrong.pass).toBe(false);
    expect(wrong.message).toBe(
      "valid/a.gpkg should have been accepted, and was refused at the post-intervention upload with PARCEL_OVERLAPS, AREA_SUM_MISMATCH",
    );
    expect(verdict(FILE, { expected: REFUSED }, accepted).message).toMatch(
      /should have been refused, and was accepted/,
    );
  });

  it("never counts a throw as a refusal", () => {
    expect(verdict(FILE, { expected: REFUSED }, failed).pass).toBe(false);
  });

  it("summarises every wrong result in a table", () => {
    const summary = summaryMarkdown("Legacy", [
      verdict(FILE, { expected: ACCEPTED }, refused),
      verdict("valid/b.gpkg", { expected: ACCEPTED }, accepted),
      verdict("x/c|d.gpkg", { expected: REFUSED }, accepted),
    ]);
    expect(summary).toContain(
      "**2 of 3 example files gave the wrong result.**",
    );
    expect(summary).toContain(
      "| `valid/a.gpkg` | accepted | refused at the post-intervention upload with PARCEL_OVERLAPS, AREA_SUM_MISMATCH |",
    );
    expect(summary).toContain(
      "| `x/c\\|d.gpkg` | refused | accepted (baseline then post-intervention upload) |",
    );
  });

  it("says when every file gave the expected result", () => {
    expect(
      summaryMarkdown("Legacy", [
        verdict(FILE, { expected: ACCEPTED }, accepted),
      ]),
    ).toContain("All 1 example files gave the expected result.");
  });
});
