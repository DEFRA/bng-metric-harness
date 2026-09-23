import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PERMUTATION_SCENARIOS as SCENARIOS } from "#bng-lib";
import { writeWorkbookManifest } from "../../../scripts/workbooks/manifest.mjs";
import {
  buildWorkbookCorpus,
  scenarioFiles,
} from "../../../scripts/workbooks/runner.mjs";

const TEMPLATE = process.env.METRIC_TEMPLATE;
const hasTemplate = Boolean(TEMPLATE) && existsSync(TEMPLATE);

const recalculated = {
  id: "trading-area-medium-breach",
  title: "Trading rules breached",
  files: scenarioFiles({ id: "trading-area-medium-breach" }),
  rejectedInputs: [],
  metric: {
    headline: {
      netUnitChange: { area: -102.53, hedgerow: 0, watercourse: "Error ▲" },
      netPercentChange: { area: -0.229, hedgerow: 0, watercourse: "Check Data ⚠" },
    },
    trading: {
      area: [
        { distinctiveness: "Medium", satisfied: "No ▲" },
        { distinctiveness: "Low", satisfied: "Yes ✓" },
      ],
    },
    rowWarnings: [],
  },
  checks: [{ check: "area trading rule, Medium", passed: true }],
};

describe("writeWorkbookManifest", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "bng-wb-manifest-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("tabulates the metric's figures, breaches and checks", () => {
    const { indexPath, manifestPath } = writeWorkbookManifest(dir, {
      entries: [recalculated],
      seed: 7,
      templatePath: "/somewhere/metric.xlsx",
    });
    const index = readFileSync(indexPath, "utf8");
    expect(index).toContain("Seed **7**");
    expect(index).toContain("-102.5300 (-22.9%)");
    expect(index).toContain("Error ▲ (Check Data ⚠)");
    expect(index).toContain("area Medium");
    expect(index).toContain("✓ 1");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(manifest.recalculated).toBe(true);
    expect(manifest.template).toBe("metric.xlsx");
  });

  it("says when the workbooks were not recalculated", () => {
    const { metric, checks, ...unrecalculated } = recalculated;
    const { indexPath, manifestPath } = writeWorkbookManifest(dir, {
      entries: [unrecalculated],
      seed: 7,
      templatePath: "metric.xlsx",
    });
    expect(readFileSync(indexPath, "utf8")).toContain("not recalculated");
    expect(JSON.parse(readFileSync(manifestPath, "utf8")).recalculated).toBe(
      false,
    );
  });
});

describe.skipIf(!hasTemplate)("buildWorkbookCorpus", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "bng-wb-corpus-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const pick = (...ids) => SCENARIOS.filter((s) => ids.includes(s.id));

  it("writes each scenario's three files into one flat folder", async () => {
    const scenarios = pick("net-gain-unmet", "invalid-area-trading-down");
    const entries = await buildWorkbookCorpus({
      scenarios,
      outDir: dir,
      templatePath: TEMPLATE,
      seed: 1,
      recalculate: false,
    });
    const files = readdirSync(dir).sort();
    expect(files).toEqual(
      scenarios.flatMap((s) => Object.values(scenarioFiles(s))).sort(),
    );
    expect(entries.map((e) => e.id)).toEqual(scenarios.map((s) => s.id));
    expect(entries[1].inputRows.habitatEnhancement).toBe(1);
  });

  it("removes the files of scenarios a previous run wrote", async () => {
    const stale = pick("net-gain-unmet");
    const entries = await buildWorkbookCorpus({
      scenarios: stale,
      outDir: dir,
      templatePath: TEMPLATE,
      seed: 1,
      recalculate: false,
    });
    writeWorkbookManifest(dir, { entries, seed: 1, templatePath: TEMPLATE });
    writeFileSync(path.join(dir, "notes.txt"), "not ours");

    await buildWorkbookCorpus({
      scenarios: pick("invalid-area-trading-down"),
      outDir: dir,
      templatePath: TEMPLATE,
      seed: 1,
      recalculate: false,
    });
    const files = readdirSync(dir);
    expect(files).not.toContain("net-gain-unmet.xlsx");
    expect(files).toContain("invalid-area-trading-down.xlsx");
    expect(files).toContain("notes.txt");
  });
});
