import { spawnSync } from "node:child_process";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compareCodes } from "../../../.claude/skills/geopackage-validation-explainer/scripts/check-dropout-copy.mjs";
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

function copyFile(codes) {
  const entries = codes
    .map(
      (code) => `  ${code}:
    copyFrom: none
    whenAlone: catch-all
    inList: service-message
`,
    )
    .join("");
  return `errors:\n${entries}`;
}

describe("compareCodes", () => {
  it("names backend codes the copy file lacks, and entries for codes the backend lacks", () => {
    expect(
      compareCodes(["B", "A", "C"], new Set(["C", "OLD", "A"])),
    ).toEqual({ missing: ["B"], stale: ["OLD"] });
  });

  it("finds nothing when the two agree", () => {
    expect(compareCodes(["A"], new Set(["A"]))).toEqual({
      missing: [],
      stale: [],
    });
  });
});

describe("check-dropout-copy.mjs", () => {
  let dir;

  beforeAll(() => {
    dir = scratchDir();
    dir.write("backend/src/validation/geopackage/errors.js", ERRORS);
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

  const run = (frontend) =>
    spawnSync(process.execPath, [CHECK], {
      encoding: "utf8",
      env: {
        ...process.env,
        BNG_BACKEND_DIR: path.join(dir.root, "backend"),
        BNG_FRONTEND_DIR: path.join(dir.root, frontend),
      },
    });

  it("passes when every backend code has an entry and no entry is left over", () => {
    const result = run("agrees");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("All 2 backend error codes have an entry");
  });

  it("fails, naming each code, when they differ", () => {
    const result = run("differs");
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/no entry[\s\S]*- SECOND/);
    expect(result.stderr).toMatch(/no longer defines[\s\S]*- GONE/);
  });

  it("fails when the frontend has no copy file", () => {
    const result = run("no-copy-file");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("has no src/server/error-file/dropout-copy.yaml");
  });
});
