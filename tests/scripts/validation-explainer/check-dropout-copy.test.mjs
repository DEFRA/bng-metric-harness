import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  compareCodes,
  compareDetails,
  compareEditCodes,
  editOnlyUploadEntries,
} from "../../../.claude/skills/geopackage-validation-explainer/scripts/check-dropout-copy.mjs";
import { renderSummary } from "../../../.claude/skills/geopackage-validation-explainer/scripts/dropout-copy-summary.mjs";
import { scratchDir } from "./_fixtures.mjs";

const CHECK = path.resolve(
  import.meta.dirname,
  "../../../.claude/skills/geopackage-validation-explainer/scripts/check-dropout-copy.mjs",
);

const ERRORS = `export const ERROR_CODES = Object.freeze({
  /** One. */
  FIRST: 'FIRST',
  SECOND: 'SECOND'
})
`;

// A backend that says where each code is met, as ERROR_CODE_SURFACES does.
const ERRORS_WITH_SURFACES = `export const ERROR_CODES = Object.freeze({
  FIRST: 'FIRST',
  EDITED: 'EDITED',
  BOTH: 'BOTH'
})
export const ERROR_CODE_SURFACES = Object.freeze({
  FIRST: ['upload'],
  EDITED: ['edit'],
  BOTH: ['upload', 'edit']
})
`;

// A backend that also says what each code's details carry, as
// ERROR_CODE_DETAILS does.
const ERRORS_WITH_DETAILS = `export const ERROR_CODES = Object.freeze({
  FIRST: 'FIRST',
  LAYER: 'LAYER'
})
export const ERROR_CODE_SURFACES = Object.freeze({
  FIRST: ['upload'],
  LAYER: ['upload']
})
export const ERROR_CODE_DETAILS = Object.freeze({
  LAYER: { values: ['layer'], variants: ['bng-service'] }
})
`;

/** error-text.yaml whose LAYER entry is worded as given. */
function detailedErrorText(layerInList) {
  return `upload:
  errors:
    FIRST:
      whenAlone: catch-all
      inList: catch-all
    LAYER:
      whenAlone: catch-all
      inList:
${layerInList}
edit: {}
forms: {}
`;
}

/** error-text.yaml: the drop-out page's copy under upload, and an edit section. */
function errorTextFile(uploadCodes, editCodes) {
  const upload = copyFile(uploadCodes).replace(/^/gm, "  ").trimEnd();
  const edit = editCodes.map((code) => `  ${code}: placeholder`).join("\n");
  return `upload:\n${upload}\nedit:\n${edit}\nforms: {}\n`;
}

function copyFile(codes) {
  const entries = codes
    .map(
      (code) => `  ${code}:
    whenAlone: catch-all
    inList: service-message
`,
    )
    .join("");
  return `errors:\n${entries}`;
}

describe("compareCodes", () => {
  it("names backend codes the copy file lacks, and entries for codes the backend lacks", () => {
    expect(compareCodes(["B", "A", "C"], new Set(["C", "OLD", "A"]))).toEqual({
      missing: ["B"],
      stale: ["OLD"],
    });
  });

  it("finds nothing when the two agree", () => {
    expect(compareCodes(["A"], new Set(["A"]))).toEqual({
      missing: [],
      stale: [],
    });
  });

  it("owes an edit rule no entry, and does not call one it has stale", () => {
    expect(
      compareCodes(
        ["UPLOAD", "NEW_EDIT", "OLD_EDIT"],
        new Set(["UPLOAD", "OLD_EDIT"]),
        new Set(["NEW_EDIT", "OLD_EDIT"]),
      ),
    ).toEqual({ missing: [], stale: [] });
  });
});

describe("compareEditCodes", () => {
  const surfaces = { UP: ["upload"], ED: ["edit"], BOTH: ["upload", "edit"] };

  it("names edit codes the edit section lacks, and its entries for codes that refuse no edit", () => {
    expect(compareEditCodes(surfaces, new Set(["ED", "UP"]))).toEqual({
      missing: ["BOTH"],
      stale: ["UP"],
    });
  });

  it("compares nothing when either side predates the split", () => {
    expect(compareEditCodes(null, new Set(["ED"]))).toBeNull();
    expect(compareEditCodes(surfaces, null)).toBeNull();
  });
});

describe("compareDetails", () => {
  const details = {
    LAYER_MISSING: { values: ["layer"], variants: ["bng-service"] },
    AREA_TOO_LARGE: { values: ["areaSqM"] },
    OUT_OF_SCOPE: { values: ["allowedBands"] },
  };

  it("finds nothing when the wording names only what the backend sends, and words each variant", () => {
    const entries = {
      LAYER_MISSING: {
        inList: {
          heading: "Missing layer",
          detail: "{layer}",
          variants: { "bng-service": { heading: "Missing table" } },
        },
      },
      AREA_TOO_LARGE: {
        inList: { heading: "Area ({areaSqM} sq m) too large" },
      },
      LISTED: { inList: { heading: "Habitats", item: "{feature}" } },
      // A code that sends a value of its own, for its note, as well as the
      // habitats its items name.
      OUT_OF_SCOPE: {
        inList: {
          heading: "Out of scope",
          item: "{feature} ({distinctiveness})",
          note: "Allowed: {bands}.",
        },
      },
      NEVER_LISTED: { inList: "catch-all" },
    };
    expect(compareDetails(details, entries)).toEqual({
      serviceMessage: [],
      unknownValues: [],
      unknownVariants: [],
      unwordedVariants: [],
    });
  });

  it("names entries that show the service's message, values it does not send, and variants only one side has", () => {
    const entries = {
      LAYER_MISSING: {
        inList: {
          heading: "Missing {table}",
          detail: "{layer}",
          variants: { renamed: { heading: "Gone" } },
        },
      },
      AREA_TOO_LARGE: "unused",
      SHOWN_RAW: { inList: "service-message" },
      LISTED: { inList: { heading: "{count} habitats", item: "{feature}" } },
      DETAILED: {
        inList: {
          heading: "Layer",
          detail: "{layer}",
          variants: { "bng-service": { detail: "{table}" } },
        },
      },
    };
    expect(compareDetails(details, entries)).toEqual({
      serviceMessage: ["SHOWN_RAW"],
      unknownValues: [
        { code: "LAYER_MISSING", name: "table" },
        { code: "LISTED", name: "count" },
        { code: "DETAILED", name: "layer" },
        { code: "DETAILED", name: "table" },
      ],
      unknownVariants: [
        { code: "LAYER_MISSING", variant: "renamed" },
        { code: "DETAILED", variant: "bng-service" },
      ],
      unwordedVariants: [{ code: "LAYER_MISSING", variant: "bng-service" }],
    });
  });

  it("asks no variants of an entry the list heads with the catch-all title", () => {
    const entries = {
      LAYER_MISSING: { inList: "catch-all" },
      AREA_TOO_LARGE: { inList: "catch-all" },
    };
    expect(compareDetails(details, entries)).toEqual({
      serviceMessage: [],
      unknownValues: [],
      unknownVariants: [],
      unwordedVariants: [],
    });
  });

  it("compares nothing for a backend that predates ERROR_CODE_DETAILS", () => {
    expect(compareDetails(null, { A: { inList: "service-message" } })).toBe(
      null,
    );
  });
});

describe("editOnlyUploadEntries", () => {
  const surfaces = { UP: ["upload"], ED: ["edit"], BOTH: ["upload", "edit"] };

  it("names upload entries for codes met only on an edit", () => {
    expect(
      editOnlyUploadEntries(surfaces, new Set(["UP", "ED", "BOTH"])),
    ).toEqual(["ED"]);
  });

  it("names none without the backend's surfaces", () => {
    expect(editOnlyUploadEntries(null, new Set(["ED"]))).toEqual([]);
  });
});

describe("check-dropout-copy.mjs", () => {
  let dir;

  beforeAll(() => {
    dir = scratchDir();
    dir.write("backend/src/validation/geopackage/errors.js", ERRORS);
    dir.write(
      "surfaces-backend/src/validation/geopackage/errors.js",
      ERRORS_WITH_SURFACES,
    );
    // An error text file: the upload codes under upload, the edit codes
    // under edit; and one missing an edit code and keeping an upload-only one.
    const ERROR_TEXT = "src/server/common/error-text/error-text.yaml";
    // Found by error-text.yaml alone: no single-error-copy.js, as in a
    // frontend that drops the copy's code once the copy is in YAML.
    for (const [name, upload, edit] of [
      ["error-text-agrees", ["FIRST", "BOTH"], ["EDITED", "BOTH"]],
      ["error-text-differs", ["FIRST", "BOTH"], ["EDITED", "FIRST"]],
      ["error-text-misplaced", ["FIRST", "BOTH", "EDITED"], ["EDITED", "BOTH"]],
    ]) {
      dir.write(`${name}/${ERROR_TEXT}`, errorTextFile(upload, edit));
    }
    dir.write(
      "details-backend/src/validation/geopackage/errors.js",
      ERRORS_WITH_DETAILS,
    );
    dir.write(
      `details-agree/${ERROR_TEXT}`,
      detailedErrorText(`        heading: 'Layer {layer} is missing'
        detail: 'add the {layer} table'
        variants:
          bng-service:
            heading: 'Table {layer} is missing'`),
    );
    // Only the details disagree: a value the service does not send, and no
    // wording for a variant it does.
    dir.write(
      `details-differ/${ERROR_TEXT}`,
      detailedErrorText(`        heading: 'Layer {layer} is missing'
        detail: 'add the {table} table'`),
    );
    // A backend whose errors.js will not load: it imports a package the
    // check does not install.
    dir.write(
      "broken-backend/src/validation/geopackage/errors.js",
      `import "a-package-not-installed";\n${ERRORS_WITH_SURFACES}`,
    );
    // The frontend is found by the copy code the explainer has always read.
    for (const name of ["agrees", "differs", "no-copy-file"]) {
      dir.write(
        `${name}/src/server/error-file/single-error-copy.js`,
        "export {}\n",
      );
    }
    dir.write(
      "agrees/src/server/error-file/dropout-copy.yaml",
      copyFile(["FIRST", "SECOND"]),
    );
    dir.write(
      "differs/src/server/error-file/dropout-copy.yaml",
      copyFile(["FIRST", "GONE"]),
    );
  });

  afterAll(() => dir.remove());

  // Always a scratch file: in GitHub Actions the variable is set, and these
  // runs must not write their results into the real job summary.
  const summaryFile = () => path.join(dir.root, "summary.md");
  const run = (frontend, backend = "backend") => {
    rmSync(summaryFile(), { force: true });
    return spawnSync(process.execPath, [CHECK], {
      encoding: "utf8",
      env: {
        ...process.env,
        BNG_BACKEND_DIR: path.join(dir.root, backend),
        BNG_FRONTEND_DIR: path.join(dir.root, frontend),
        GITHUB_STEP_SUMMARY: summaryFile(),
      },
    });
  };
  const summary = () => readFileSync(summaryFile(), "utf8");

  it("passes when every backend code has an entry and no entry is left over", () => {
    const result = run("agrees");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "All 2 backend upload error codes have an entry",
    );
  });

  it("fails, naming each code, when they differ", () => {
    const result = run("differs");
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/no entry[\s\S]*- SECOND/);
    expect(result.stderr).toMatch(/no longer defines[\s\S]*- GONE/);
  });

  it("reads error-text.yaml, and checks its edit section against the backend's surfaces", () => {
    const result = run("error-text-agrees", "surfaces-backend");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "All 2 backend upload error codes have an entry in src/server/common/error-text/error-text.yaml",
    );
    expect(result.stdout).toContain("Every one of the backend's edit codes");
    expect(summary()).toContain(
      "| Errors for changes made on screen, checked against the edit section | 2 |",
    );
  });

  it("fails, naming each code, when the edit section lacks an edit code or keeps an upload-only one", () => {
    const result = run("error-text-differs", "surfaces-backend");
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/refuses an edit[\s\S]*- BOTH/);
    expect(result.stderr).toMatch(/refuse no edit[\s\S]*- FIRST/);
    const text = summary();
    expect(text).toContain("on-screen error with no entry in the edit section");
    expect(text).toContain("| `BOTH` |");
    expect(text).toContain("  BOTH: placeholder");
    // The backend classifies every code, so nothing is new to the explainer.
    expect(text).not.toContain("🆕");
  });

  it("finds a frontend by its error-text.yaml alone", () => {
    expect(run("error-text-agrees", "surfaces-backend").stdout).not.toContain(
      "Could not find bng-metric-frontend",
    );
  });

  it("fails on an upload entry for a code met only on an edit", () => {
    const result = run("error-text-misplaced", "surfaces-backend");
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/met only on an edit[\s\S]*- EDITED/);
    expect(summary()).toContain(
      "drop-out page entry for errors met only on screen",
    );
  });

  it("passes when the wording names only what the backend sends, and words each variant", () => {
    const result = run("details-agree", "details-backend");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "The wording names only values the backend sends, words every variant it can name, and shows none of its messages.",
    );
  });

  it("fails, naming each problem, when only the details disagree", () => {
    const result = run("details-differ", "details-backend");
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/does not send[\s\S]*- LAYER: \{table\}/);
    expect(result.stderr).toMatch(/no variant for[\s\S]*- LAYER: bng-service/);
    const text = summary();
    expect(text).toContain(
      "### Wording that does not match what the service sends",
    );
    expect(text).toContain(
      "| `LAYER` | Names `{table}`, which the service does not send with this error. |",
    );
    expect(text).toContain(
      "| `LAYER` | The service words it a `bng-service` way that the file has no wording for. |",
    );
  });

  it("fails loudly, with a summary, when the backend's errors.js will not load", () => {
    const result = run("error-text-agrees", "broken-backend");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Could not load the backend's");
    expect(summary()).toContain(
      "## ❌ Drop-out page wording: the backend's error codes could not be read",
    );
  });

  it("writes the job summary, with a verdict, each problem and what to do", () => {
    run("agrees");
    expect(summary()).toContain("## ✅ Drop-out page wording: nothing to fix");
    run("differs");
    const text = summary();
    expect(text).toContain("## ⚠️ Drop-out page wording needs attention");
    // SECOND is in no description, so the explainer has yet to classify it.
    expect(text).toContain("| `SECOND` 🆕 |");
    expect(text).toContain("new to the validation explainer");
    expect(text).toContain("| `GONE` |");
    expect(text).toContain("**What to do**");
  });

  it("fails when the frontend has no copy file", () => {
    const result = run("no-copy-file");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "has no src/server/common/error-text/error-text.yaml",
    );
  });
});

describe("renderSummary", () => {
  const context = {
    copyFile: "src/server/error-file/dropout-copy.yaml",
    backend: { commit: "a".repeat(40), branch: "main" },
    frontend: { commit: "b".repeat(40), branch: "main" },
  };
  const counts = { uploadCount: 80, editCount: 2 };

  it("says there is nothing to fix, and what was checked", () => {
    const text = renderSummary({ missing: [], stale: [], ...counts }, context);
    expect(text).toContain("## ✅ Drop-out page wording: nothing to fix");
    expect(text).toContain("| Upload errors checked | 80 |");
    expect(text).toContain(
      "[`aaaaaaa`](https://github.com/DEFRA/bng-metric-backend/commit/" +
        "a".repeat(40) +
        ")",
    );
  });

  it("lists each missing error with what it checks, where it is raised, and an entry to start from", () => {
    const text = renderSummary(
      { missing: ["NEW_CODE"], stale: [], ...counts },
      {
        ...context,
        rules: {
          NEW_CODE: {
            plain: "A habitat's comment is too long | really.",
            raisedAt: [{ file: "src/check.js", line: 12 }],
          },
        },
      },
    );
    expect(text).toContain("## ⚠️ Drop-out page wording needs attention");
    expect(text).toContain("- **1 upload error with no wording**");
    // A | in the text would break the table.
    expect(text).toContain("A habitat's comment is too long \\| really.");
    expect(text).toContain(
      "[`src/check.js:12`](https://github.com/DEFRA/bng-metric-backend/blob/" +
        "a".repeat(40) +
        "/src/check.js#L12)",
    );
    expect(text).toContain("  NEW_CODE:\n    whenAlone:\n      title:");
    expect(text).toContain("  NEW_CODE:\n    whenAlone: catch-all");
    expect(text).not.toContain("errors the service no longer has");
  });

  it("falls back to the opening of the backend's description for a code the explainer has not described", () => {
    const text = renderSummary(
      { missing: ["NEW_CODE"], stale: [], ...counts },
      {
        ...context,
        rules: {
          NEW_CODE: {
            description:
              "First sentence. Second sentence. `details.sample` lists rows.",
          },
        },
      },
    );
    expect(text).toContain("| First sentence. Second sentence. |");
    expect(text).toContain("Not raised anywhere yet");
  });

  it("marks a missing error the explainer has not classified, as it may be an edit rule", () => {
    const text = renderSummary(
      { missing: ["KNOWN", "BRAND_NEW"], stale: [], ...counts },
      {
        ...context,
        rules: {
          KNOWN: { plain: "Known." },
          BRAND_NEW: { description: "New.", unclassified: true },
        },
      },
    );
    expect(text).toContain("| `BRAND_NEW` 🆕 |");
    expect(text).toContain("| `KNOWN` |");
    expect(text).toContain(
      "> **Check first:** **One of these errors is new to the validation explainer**",
    );
    expect(text).toContain("/geopackage-validation-explainer");
    expect(text).toContain("For an error marked 🆕, classify it first");
  });

  it("says nothing of classifying when every missing error is known to the explainer", () => {
    const text = renderSummary(
      { missing: ["KNOWN"], stale: [], ...counts },
      { ...context, rules: { KNOWN: { plain: "Known." } } },
    );
    expect(text).not.toContain("new to the validation explainer");
    expect(text).not.toContain("🆕");
  });

  it("lists each entry for an error the service no longer has, and what to do", () => {
    const text = renderSummary(
      { missing: [], stale: ["OLD", "OLDER"], ...counts },
      context,
    );
    expect(text).toContain(
      "- **2 entries for errors the service no longer has**",
    );
    expect(text).toContain("| `OLD` |");
    expect(text).toContain("delete the entry");
    expect(text).not.toContain("with no wording");
  });

  it("lists wording that does not match what the service sends, and what to do", () => {
    const summary = renderSummary(
      {
        missing: [],
        stale: [],
        misplaced: [],
        edit: null,
        details: {
          serviceMessage: ["SHOWN_RAW"],
          unknownValues: [{ code: "LAYER_MISSING", name: "table" }],
          unknownVariants: [],
          unwordedVariants: [{ code: "LAYER_MISSING", variant: "bng-service" }],
        },
        uploadCount: 2,
        editCount: 0,
      },
      context,
    );
    expect(summary).toContain("## ⚠️ Drop-out page wording needs attention");
    expect(summary).toContain("3 mismatches between the wording");
    expect(summary).toContain("| `SHOWN_RAW` |");
    expect(summary).toContain("Names `{table}`");
    expect(summary).toContain("Add a `bng-service` variant");
  });

  it("says when the frontend has no copy file", () => {
    expect(renderSummary({ noCopyFile: true }, context)).toContain(
      "## ❌ Drop-out page wording: the wording file is missing",
    );
  });

  it("names a commit it could not read as unknown, and links nothing", () => {
    const text = renderSummary(
      { missing: [], stale: [], ...counts },
      { copyFile: context.copyFile },
    );
    expect(text).toContain("backend: unknown commit");
    expect(text).toContain("`src/server/error-file/dropout-copy.yaml`");
    expect(text).not.toContain("/blob/");
  });
});
