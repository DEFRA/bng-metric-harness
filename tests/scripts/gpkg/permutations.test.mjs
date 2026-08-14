import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateOne, setMode } from "#bng-lib";
import {
  PERMUTATION_DEFAULT_SIZE as DEFAULT_SIZE,
  PERMUTATION_PURPOSES as PURPOSES,
  PERMUTATION_SCENARIOS as SCENARIOS,
} from "#bng-lib";
import { repoPath } from "../../../scripts/_lib.mjs";
import {
  meetsNetGain,
  priceHabitats,
} from "../../../scripts/permutations/engine-units.mjs";
import { loadEngine } from "../../../scripts/permutations/engine.mjs";
import { runPermutations } from "../../../scripts/permutations/runner.mjs";

const KNOWN_LAYERS = new Set(["habitats", "hedgerows", "rivers"]);
const CENTRE = [530000, 180000];

describe("permutations catalogue integrity", () => {
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

// The engine lives in the backend sibling; skip the arithmetic checks when it
// is not checked out (e.g. a library-only CI job).
const engineEntry = path.join(
  repoPath("bng-metric-backend"),
  "bng-metric-engine",
  "src",
  "index.js",
);
const describeEngine = existsSync(engineEntry) ? describe : describe.skip;

describeEngine("engine-accurate net gain", () => {
  let engine;
  let outDir;

  beforeAll(async () => {
    engine = await loadEngine();
    setMode("silent");
    outDir = mkdtempSync(path.join(tmpdir(), "perm-engine-"));
  });

  afterAll(() => {
    setMode("cli");
    rmSync(outDir, { recursive: true, force: true });
  });

  const generate = (id, habitats) => {
    const file = path.join(outDir, `${id}.gpkg`);
    generateOne(file, CENTRE, {
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

describeEngine("full-catalogue coverage", () => {
  let outRoot;

  beforeAll(() => {
    setMode("silent");
    outRoot = mkdtempSync(path.join(tmpdir(), "perm-cover-"));
  });

  afterAll(() => {
    setMode("cli");
    rmSync(outRoot, { recursive: true, force: true });
  });

  it("generates every scenario with its subject present", async () => {
    // runScenario throws if a subject is missing or a gain expectation is not
    // met, so a full run returning every entry is the coverage guarantee — the
    // randomised geometry cannot silently drop a scenario's category.
    const entries = await runPermutations({ outRoot });
    expect(entries.length).toBe(SCENARIOS.length);
    expect(new Set(entries.map((e) => e.id))).toEqual(
      new Set(SCENARIOS.map((s) => s.id)),
    );
  });
});

describeEngine("seeded reproducibility", () => {
  let root;

  beforeAll(() => {
    setMode("silent");
    root = mkdtempSync(path.join(tmpdir(), "perm-seed-"));
  });

  afterAll(() => {
    setMode("cli");
    rmSync(root, { recursive: true, force: true });
  });

  const hashRun = async (dir, seed) => {
    const outRoot = path.join(root, dir);
    await runPermutations({ outRoot, only: "conditions", seed });
    const file = path.join(
      outRoot,
      "conditions",
      "area-spread-post-intervention.gpkg",
    );
    return createHash("sha256").update(readFileSync(file)).digest("hex");
  };

  it("produces byte-identical fixtures for the same seed", async () => {
    expect(await hashRun("a", 7)).toBe(await hashRun("b", 7));
  });

  it("produces different fixtures for a different seed", async () => {
    expect(await hashRun("c", 7)).not.toBe(await hashRun("d", 8));
  });
});
