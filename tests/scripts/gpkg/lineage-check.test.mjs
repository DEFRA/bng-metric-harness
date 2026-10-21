import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
// Inside the harness, as check:lineage only reads paths there; test-data/ is
// gitignored.
beforeAll(() => {
  const testData = path.join(ROOT, "test-data");
  mkdirSync(testData, { recursive: true });
  dir = mkdtempSync(path.join(testData, "lineage-check-"));
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

  it("reads the flaw from the file's own name, not its folder's", () => {
    const valid = generate(
      path.join("lineage-parent-wrong", "valid"),
      "--format",
      "bng-service",
    );
    expect(checkFile(valid)).toMatchObject({ status: "pass", expected: null });
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

describe("the paths check:lineage reads", () => {
  it("refuses a folder outside the harness", () => {
    const result = checkLineage("--dir", path.dirname(ROOT));
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toMatch(/must be inside the harness/);
  });
});

describe("a file check:lineage cannot read", () => {
  it("fails it with the reason, and still checks the other files", () => {
    const folder = path.join(dir, "with-a-bad-file");
    generate(path.join("with-a-bad-file", "good"), "--format", "bng-service");
    writeFileSync(path.join(folder, "broken.gpkg"), "not a GeoPackage");
    const result = checkLineage("--dir", folder);
    expect(result.status).toBe(1);
    const output = result.stdout + result.stderr;
    expect(output).toMatch(/broken\.gpkg/);
    expect(output).toMatch(/unreadable-file/);
    expect(output).toMatch(/1 passed, 1 failed/);
  });

  it("reports a folder that does not exist without a stack trace", () => {
    const result = checkLineage("--dir", path.join(dir, "no-such-folder"));
    expect(result.status).toBe(1);
    expect(result.stderr + result.stdout).not.toMatch(/\n\s+at /);
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

  // The two legacy pairs the check fails, as the legacy corpus stays as it
  // is until BMD-1097. Every other pair in it must pass.
  const KNOWN_FAILURES = [
    // Two single-file HABITAT_REF_MISSING fixtures that share a name, not a
    // pair: different sites, and the "baseline" one carries proposed data.
    "attribute-problems/Baseline - missing habitat ref.gpkg ↔ Post-intervention - missing habitat ref.gpkg",
    // A hand-built pair: its baseline carries proposed values on habitats
    // and the river, and the post-intervention parcels H2-1…H2-10 and
    // hedgerow HR3 name no baseline ref.
    "valid/Baseline - retained hedgerow.gpkg ↔ Post-intervention - retained hedgerow.gpkg",
  ];

  /** The pairs a --dir run counted, from its "N/M pair(s) passed" line. */
  function pairTotal(stdout) {
    return Number(/\d+\/(\d+) pair\(s\) passed/.exec(stdout)?.[1]);
  }

  /** Each pair's result from a --dir run: label → failure lines. */
  function pairResults(stdout) {
    const results = {};
    let current = null;
    for (const line of stdout.split("\n")) {
      const pair = /^([✔✘]) (.+)$/.exec(line);
      if (pair) {
        current = pair[2];
        results[current] = pair[1] === "✔" ? null : [];
      } else if (current && line.startsWith("    ")) {
        results[current].push(line.trim());
      }
    }
    return results;
  }

  it("passes every pair in the legacy corpus, but the two known ones", () => {
    const result = spawnSync(
      process.execPath,
      [CHECK_PAIR, "--dir", path.join(ROOT, "example-files")],
      { encoding: "utf8" },
    );
    expect(result.stderr).toBe("");
    const results = pairResults(result.stdout);
    // One label per pair counted, so no two pairs share a label.
    expect(Object.keys(results)).toHaveLength(pairTotal(result.stdout));
    const failed = Object.keys(results).filter((pair) => results[pair]);
    expect(failed.sort()).toEqual([...KNOWN_FAILURES].sort());
    // The curated, permutation and BNG500 pairs are all found.
    expect(Object.keys(results).length).toBeGreaterThan(70);
  });

  it("finds a pair by each of the names the harness gives one", () => {
    const name = "retained watercourse";
    const valid = path.join(ROOT, "example-files/valid");
    const files = {
      "curated/Baseline - site.gpkg": `Baseline - ${name}.gpkg`,
      "curated/Post-intervention - site.gpkg": `Post-intervention - ${name}.gpkg`,
      "corpus/site-baseline.gpkg": `Baseline - ${name}.gpkg`,
      "corpus/site-post-intervention.gpkg": `Post-intervention - ${name}.gpkg`,
      "generated/site-baseline-20260101-1200-00.gpkg": `Baseline - ${name}.gpkg`,
      "generated/site-post-intervention-20260101-1200-00.gpkg": `Post-intervention - ${name}.gpkg`,
    };
    const scan = path.join(dir, "pair-names");
    for (const [target, source] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(scan, target)), { recursive: true });
      copyFileSync(path.join(valid, source), path.join(scan, target));
    }
    const result = spawnSync(process.execPath, [CHECK_PAIR, "--dir", scan], {
      encoding: "utf8",
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("3/3 pair(s) passed");
  });

  it("tells same-named pairs apart, and reports an unreadable one as failing", () => {
    const name = "retained watercourse";
    const valid = path.join(ROOT, "example-files/valid");
    const scan = path.join(dir, "pair-folders");
    for (const folder of ["one", "two", "broken"]) {
      mkdirSync(path.join(scan, folder), { recursive: true });
      for (const stage of ["Baseline", "Post-intervention"]) {
        copyFileSync(
          path.join(valid, `${stage} - ${name}.gpkg`),
          path.join(scan, folder, `${stage} - ${name}.gpkg`),
        );
      }
    }
    writeFileSync(
      path.join(scan, "broken", `Baseline - ${name}.gpkg`),
      "not a GeoPackage",
    );
    const result = spawnSync(process.execPath, [CHECK_PAIR, "--dir", scan], {
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    const results = pairResults(result.stdout);
    expect(Object.keys(results).sort()).toEqual(
      ["broken", "one", "two"].map(
        (folder) =>
          `${folder}/Baseline - ${name}.gpkg ↔ Post-intervention - ${name}.gpkg`,
      ),
    );
    const broken =
      results[
        `broken/Baseline - ${name}.gpkg ↔ Post-intervention - ${name}.gpkg`
      ];
    expect(broken[0]).toMatch(/^cannot check this pair: /);
    expect(result.stdout).toContain("2/3 pair(s) passed");
  });
});
