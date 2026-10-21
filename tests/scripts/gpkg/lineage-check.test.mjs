import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BNG_SERVICE_FLAWS, CATEGORY_LINEAGE } from "#bng-lib";
import { checkFile, expectedFlaw } from "../../../scripts/lineage-check.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const GEN_GPKG = path.join(ROOT, "scripts/gen-gpkg.mjs");
const CHECK_LINEAGE = path.join(ROOT, "scripts/check-gpkg-lineage.mjs");
const CHECK_PAIR = path.join(ROOT, "scripts/check-gpkg-pair.mjs");
const LINEAGE_FLAWS = Object.entries(BNG_SERVICE_FLAWS)
  .filter(([, flaw]) => flaw.category === CATEGORY_LINEAGE)
  .map(([name]) => name);

let dir;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "lineage-check-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Generate one file into its own folder and return its path. */
function generate(name, ...args) {
  const out = path.join(dir, name);
  const result = spawnSync(
    process.execPath,
    [GEN_GPKG, "--outdir", out, "--size", "8", "--seed", "3", ...args],
    { encoding: "utf8" },
  );
  expect(result.status, result.stderr).toBe(0);
  const [file] = readdirSync(out);
  return path.join(out, file);
}

const checkLineage = (...args) =>
  spawnSync(process.execPath, [CHECK_LINEAGE, ...args], { encoding: "utf8" });

describe("expectedFlaw", () => {
  it.each(LINEAGE_FLAWS)("reads %s from a file name", (flaw) => {
    expect(expectedFlaw(`bng-service-test-data-${flaw}-20261021.gpkg`)).toBe(
      flaw,
    );
  });

  it("finds no flaw in an ordinary name", () => {
    expect(expectedFlaw("Valid site.gpkg")).toBeNull();
  });
});

describe("the single-file lineage check", () => {
  it("passes a valid BNG Service file", () => {
    const result = checkFile(generate("valid", "--format", "bng-service"));
    expect(result).toMatchObject({ status: "pass", problems: [] });
  });

  it.each(LINEAGE_FLAWS)(
    "reports %s, named, in a file made with it",
    (flaw) => {
      const file = generate(flaw, "--format", "bng-service", "--flaw", flaw);
      const result = checkFile(file, path.basename(file));
      expect(result.status).toBe("pass");
      expect(result.problems.map((p) => p.flaw)).toEqual([flaw]);
    },
  );

  it("fails a flaw file whose name does not say so, and a valid file named for a flaw", () => {
    const flawed = generate(
      "unnamed-flaw",
      "--format",
      "bng-service",
      "--flaw",
      "lineage-parent-unknown",
    );
    const renamed = path.join(dir, "unnamed-flaw", "valid-looking.gpkg");
    copyFileSync(flawed, renamed);
    expect(checkFile(renamed, path.basename(renamed)).status).toBe("fail");

    const valid = generate("misnamed", "--format", "bng-service");
    expect(checkFile(valid, "site-lineage-parent-missing.gpkg").status).toBe(
      "fail",
    );
  });

  it("skips a legacy file", () => {
    expect(checkFile(generate("legacy")).status).toBe("skip");
  });

  it("checks a folder and exits 1 only when a file fails", () => {
    const folder = path.join(dir, "folder");
    generate(path.join("folder", "a"), "--format", "bng-service");
    generate(
      path.join("folder", "b"),
      "--format",
      "bng-service",
      "--flaw",
      "lineage-parent-wrong",
    );
    const passing = checkLineage("--dir", folder);
    expect(passing.status, passing.stdout + passing.stderr).toBe(0);
    expect(passing.stdout).toMatch(/2 passed, 0 failed/);

    const flawed = readdirSync(path.join(folder, "b"))[0];
    copyFileSync(
      path.join(folder, "b", flawed),
      path.join(folder, "b", "renamed.gpkg"),
    );
    const failing = checkLineage("--dir", folder);
    expect(failing.status).toBe(1);
    expect(failing.stdout + failing.stderr).toMatch(/lineage-parent-wrong/);
  });
});

describe("the legacy pair check still works on the legacy corpus", () => {
  it.each([
    "retained watercourse",
    "all unit and intervention types",
    "created linear features",
    "IGGI habitat",
    "long and padded habitat refs",
    "retained areas hedgerows and watercourses",
  ])("passes the %s pair", (name) => {
    const result = spawnSync(
      process.execPath,
      [
        CHECK_PAIR,
        path.join(ROOT, "example-files/valid", `Baseline - ${name}.gpkg`),
        path.join(
          ROOT,
          "example-files/valid",
          `Post-intervention - ${name}.gpkg`,
        ),
      ],
      { encoding: "utf8" },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });
});
