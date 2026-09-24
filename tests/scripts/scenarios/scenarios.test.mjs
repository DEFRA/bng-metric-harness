import { createHash } from "node:crypto";
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
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  PERMUTATION_DEFAULT_SIZE as DEFAULT_SIZE,
  PERMUTATION_PURPOSES as PURPOSES,
  PERMUTATION_SCENARIOS as SCENARIOS,
  generateOne,
  setMode,
} from "#bng-lib";
import { HARNESS_ROOT } from "../../../scripts/_lib.mjs";
import { DEFAULT_CENTRE } from "../../../scripts/centre.mjs";
import {
  meetsNetGain,
  priceHabitats,
} from "../../../scripts/scenarios/engine-units.mjs";
import { loadEngine } from "../../../scripts/scenarios/engine.mjs";
import { writeScenarioManifest } from "../../../scripts/scenarios/manifest.mjs";
import {
  buildScenarioCorpus,
  scenarioFiles,
} from "../../../scripts/scenarios/runner.mjs";
import {
  cachedTemplatePath,
  resolveTemplate,
} from "../../../scripts/scenarios/template.mjs";

const KNOWN_LAYERS = new Set(["habitats", "hedgerows", "rivers"]);
const TEMPLATE = process.env.METRIC_TEMPLATE;
const hasTemplate = Boolean(TEMPLATE) && existsSync(TEMPLATE);
// A full catalogue of GeoPackages takes a few seconds.
const CATALOGUE_TIMEOUT_MS = 60_000;

const pick = (...ids) => SCENARIOS.filter((s) => ids.includes(s.id));

function tempDir(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

describe("scenario catalogue integrity", () => {
  it("gives every scenario a unique id", () => {
    const ids = SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("only uses declared purposes", () => {
    for (const scenario of SCENARIOS) {
      expect(PURPOSES).toContain(scenario.purpose);
    }
  });

  it("fully describes every scenario", () => {
    for (const scenario of SCENARIOS) {
      expect(scenario.title, scenario.id).toBeTruthy();
      expect(scenario.description, scenario.id).toBeTruthy();
      expect(scenario.subject?.ref, scenario.id).toBeTruthy();
      expect(scenario.subject?.layer, scenario.id).toBeTruthy();
    }
  });

  it("only overrides known layers", () => {
    for (const scenario of SCENARIOS) {
      for (const layer of Object.keys(scenario.overrides ?? {})) {
        expect(KNOWN_LAYERS, `${scenario.id}:${layer}`).toContain(layer);
      }
    }
  });

  it("only tags gain expectations as met or unmet", () => {
    for (const scenario of SCENARIOS) {
      if (scenario.expectGain !== undefined) {
        expect(["met", "unmet"]).toContain(scenario.expectGain);
      }
    }
  });
});

describe("scenarioFiles", () => {
  it("files a scenario in its purpose folder, without repeating the purpose", () => {
    expect(
      scenarioFiles({ id: "intervention-area-created", purpose: "intervention" }),
    ).toEqual({
      baseline: path.join("intervention", "area-created-baseline.gpkg"),
      postIntervention: path.join(
        "intervention",
        "area-created-post-intervention.gpkg",
      ),
      workbook: path.join("intervention", "area-created.xlsx"),
    });
  });
});

// The engine is a dependency of this harness, so these arithmetic checks
// always run.
describe("engine-accurate net gain", () => {
  let engine;
  let outDir;

  beforeAll(async () => {
    engine = await loadEngine();
    setMode("silent");
    outDir = tempDir("scn-engine-");
  });

  afterAll(() => {
    setMode("cli");
    rmSync(outDir, { recursive: true, force: true });
  });

  const generate = (id, habitats) => {
    const file = path.join(outDir, `${id}.gpkg`);
    generateOne(file, DEFAULT_CENTRE, {
      numParcels: DEFAULT_SIZE,
      attributeOverrides: { habitats },
    });
    return file;
  };

  it("prices an all-retained fixture at ~0% (unmet)", () => {
    const file = generate(
      "retained",
      Array.from({ length: DEFAULT_SIZE }, () => ({
        habitatFullName: "Grassland - Other neutral grassland",
        retention: "Retained",
        baselineCondition: "Moderate",
      })),
    );
    const priced = priceHabitats(engine, file);
    expect(priced.skipped).toBe(0);
    expect(priced.netGainPercentage).toBeCloseTo(0, 5);
    expect(meetsNetGain(priced.netGainPercentage)).toBe(false);
  });

  it("prices an enhanced Low→Medium fixture well over 10% (met)", () => {
    const file = generate(
      "enhanced",
      Array.from({ length: DEFAULT_SIZE }, () => ({
        habitatFullName: "Grassland - Modified grassland",
        proposedHabitatFullName: "Grassland - Other neutral grassland",
        retention: "Enhanced",
        baselineCondition: "Poor",
        proposedCondition: "Good",
      })),
    );
    const priced = priceHabitats(engine, file);
    expect(priced.skipped).toBe(0);
    expect(priced.netGainPercentage).toBeGreaterThan(10);
    expect(meetsNetGain(priced.netGainPercentage)).toBe(true);
  });
});

describe("buildScenarioCorpus — GeoPackages only", () => {
  let outDir;

  beforeEach(() => {
    outDir = tempDir("scn-gpkg-");
  });

  afterEach(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  const build = (scenarios, seed = 1) =>
    buildScenarioCorpus({ scenarios, outDir, centre: DEFAULT_CENTRE, seed });

  it(
    "generates every scenario, subject present, engine expectations met",
    async () => {
      // A missing subject throws; an engine net-gain miss is a failed check.
      const entries = await build(SCENARIOS);
      expect(entries.map((e) => e.id)).toEqual(SCENARIOS.map((s) => s.id));
      const failed = entries.flatMap((e) => e.checks.filter((c) => !c.passed));
      expect(failed).toEqual([]);
      for (const entry of entries) {
        expect(entry.files.workbook).toBeUndefined();
        expect(existsSync(path.join(outDir, entry.files.baseline))).toBe(true);
      }
    },
    CATALOGUE_TIMEOUT_MS,
  );

  it("replaces a purpose folder it regenerates, and nothing else", async () => {
    await build(pick("conditions-area-spread"));
    const stale = path.join(outDir, "conditions", "stale.gpkg");
    const keep = path.join(outDir, "notes.txt");
    writeFileSync(stale, "old");
    writeFileSync(keep, "ours");
    await build(pick("conditions-area-spread"));
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(keep)).toBe(true);
  });

  const hashRun = async (seed) => {
    const dir = tempDir("scn-seed-");
    try {
      await buildScenarioCorpus({
        scenarios: pick("conditions-area-spread"),
        outDir: dir,
        centre: DEFAULT_CENTRE,
        seed,
      });
      const file = path.join(
        dir,
        "conditions",
        "area-spread-post-intervention.gpkg",
      );
      return createHash("sha256").update(readFileSync(file)).digest("hex");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("produces byte-identical fixtures for the same seed", async () => {
    expect(await hashRun(7)).toBe(await hashRun(7));
  });

  it("produces different fixtures for a different seed", async () => {
    expect(await hashRun(7)).not.toBe(await hashRun(8));
  });
});

describe("writeScenarioManifest", () => {
  let dir;
  beforeEach(() => {
    dir = tempDir("scn-manifest-");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const entry = {
    id: "trading-too-few-units",
    purpose: "trading-rules",
    title: "Trading rules — right habitat, too few units",
    description: "One-for-one replacement.",
    subject: { ref: "H001", note: "the first area parcel" },
    files: scenarioFiles({
      id: "trading-too-few-units",
      purpose: "trading-rules",
    }),
    gain: null,
    rejectedInputs: [],
    checks: [{ check: "area trading rule, Medium", passed: true }],
    metric: {
      headline: {
        netUnitChange: { area: -18.1232, hedgerow: 0, watercourse: "Error ▲" },
        netPercentChange: {
          area: -0.074,
          hedgerow: 0,
          watercourse: "Check Data ⚠",
        },
      },
      trading: {
        area: [
          { distinctiveness: "Medium", satisfied: "No ▲" },
          { distinctiveness: "Low", satisfied: "Yes ✓" },
        ],
      },
      rowWarnings: [],
    },
  };

  it("tabulates the metric's figures, breaches and checks per purpose", () => {
    const { indexPath, manifestPath } = writeScenarioManifest(dir, {
      entries: [entry],
      seed: 7,
      templatePath: "/somewhere/metric.xlsx",
    });
    const index = readFileSync(indexPath, "utf8");
    expect(index).toContain("## trading-rules");
    expect(index).toContain("Seed **7**");
    expect(index).toContain("-18.1232 (-7.4%)");
    expect(index).toContain("Error ▲ (Check Data ⚠)");
    expect(index).toContain("area Medium");
    expect(index).toContain("✓ 1");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(manifest.recalculated).toBe(true);
    expect(manifest.template).toBe("metric.xlsx");
  });

  it("drops the metric columns for GeoPackages only", () => {
    const { metric, ...gpkgOnly } = entry;
    const { indexPath, manifestPath } = writeScenarioManifest(dir, {
      entries: [gpkgOnly],
      seed: 7,
    });
    const index = readFileSync(indexPath, "utf8");
    expect(index).toContain("GeoPackages only");
    expect(index).not.toContain("Trading rules not met");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(manifest.template).toBeNull();
    expect(manifest.recalculated).toBe(false);
  });
});

describe("resolveTemplate", () => {
  it("uses a template it is given, as an absolute path", async () => {
    const template = await resolveTemplate("some/metric.xlsx");
    expect(template).toEqual({
      path: path.resolve("some/metric.xlsx"),
      source: "given",
    });
  });

  it("caches the published template inside the gitignored .cache", () => {
    expect(path.relative(HARNESS_ROOT, cachedTemplatePath())).toMatch(
      /^\.cache[\\/]metric-template[\\/].+\.xlsx$/,
    );
  });
});

describe.skipIf(!hasTemplate)("buildScenarioCorpus — with workbooks", () => {
  let outDir;
  beforeEach(() => {
    outDir = tempDir("scn-workbooks-");
  });
  afterEach(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  it("writes each scenario's workbook beside its pair", async () => {
    const scenarios = pick("net-gain-unmet", "invalid-area-trading-down");
    const entries = await buildScenarioCorpus({
      scenarios,
      outDir,
      centre: DEFAULT_CENTRE,
      seed: 1,
      templatePath: TEMPLATE,
    });
    for (const entry of entries) {
      const folder = readdirSync(path.join(outDir, entry.purpose));
      expect(folder).toContain(path.basename(entry.files.workbook));
      expect(folder).toContain(path.basename(entry.files.baseline));
    }
    expect(entries[1].inputRows.habitatEnhancement).toBe(1);
  });

  it("lints each workbook, and records the lint as a passing check", async () => {
    const entries = await buildScenarioCorpus({
      scenarios: pick("invalid-area-trading-down"),
      outDir,
      centre: DEFAULT_CENTRE,
      seed: 1,
      templatePath: TEMPLATE,
    });
    const [lint] = entries[0].checks.filter((c) => c.check.includes("lint"));
    expect(lint).toMatchObject({ actual: "no issues", passed: true });
    expect(entries[0].lintIssues).toBeUndefined();
  });
});
