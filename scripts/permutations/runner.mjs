/**
 * Drive the permutations catalogue: for each scenario, generate a
 * post-intervention GeoPackage, derive its baseline half, verify the pair,
 * price any net-gain expectation through the engine, and record a manifest
 * entry. Output is organised one sub-folder per purpose.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { deriveBaselineFromSynthetic, generateOne, setMode } from "#bng-lib";
import { openGeoPackageReadonly } from "#gpkg-io";
import { header, info, warn } from "../_lib.mjs";
import { DEFAULT_SIZE, PURPOSES, SCENARIOS } from "./catalogue.mjs";
import { loadEngine } from "./engine.mjs";
import { meetsNetGain, priceHabitats } from "./engine-units.mjs";

// BNG/EPSG:27700 coords of Maidenhead — the same default centre gen-gpkg uses.
// Geometry layout is irrelevant to these attribute-driven scenarios, so every
// fixture shares one centre.
const DEFAULT_CENTRE = [530000, 180000];

function scenarioFilenames(scenario) {
  return {
    baseline: `${scenario.id}-baseline.gpkg`,
    postIntervention: `${scenario.id}-post-intervention.gpkg`,
  };
}

/**
 * Light pair check: the derived baseline must have cleared the area layer's
 * proposed state, and both halves must share a redline. The deep guarantees are
 * covered by bng-library's own tests; this catches a broken run early.
 */
function verifyPair(baselineFile, piFile) {
  const baseDb = openGeoPackageReadonly(baselineFile);
  const piDb = openGeoPackageReadonly(piFile);
  try {
    const leftoverProposed = baseDb
      .prepare(
        `SELECT count(*) AS n FROM "Habitats"
           WHERE "Proposed Condition" IS NOT NULL
              OR "Retention Category" IS NOT NULL`,
      )
      .get().n;
    if (leftoverProposed > 0) {
      throw new Error(
        `baseline half still carries proposed data on ${leftoverProposed} habitat row(s)`,
      );
    }
    const redlineSql = `SELECT hex(geometry) AS g FROM "Red Line Boundary"`;
    const baseRlb = baseDb.prepare(redlineSql).get()?.g;
    const piRlb = piDb.prepare(redlineSql).get()?.g;
    if (!baseRlb || baseRlb !== piRlb) {
      throw new Error("baseline and post-intervention redlines differ");
    }
  } finally {
    baseDb.close();
    piDb.close();
  }
}

function assertGain(scenario, gain) {
  const met = meetsNetGain(gain.percentage);
  const expectedMet = scenario.expectGain === "met";
  if (met !== expectedMet) {
    const shown =
      gain.percentage === null ? "n/a" : `${gain.percentage.toFixed(1)}%`;
    throw new Error(
      `${scenario.id}: expected net gain "${scenario.expectGain}" but engine computed ${shown}`,
    );
  }
}

function priceGain(engine, scenario, piFile) {
  if (!scenario.expectGain) {
    return null;
  }
  const priced = priceHabitats(engine, piFile);
  const gain = {
    expected: scenario.expectGain,
    percentage: priced.netGainPercentage,
    netUnitChange: priced.netUnitChange,
    baselineUnits: priced.baselineTotal,
    postInterventionUnits: priced.postInterventionTotal,
    met: meetsNetGain(priced.netGainPercentage),
    priced: priced.priced,
    skipped: priced.skipped,
  };
  assertGain(scenario, gain);
  return gain;
}

function runScenario(engine, scenario, outRoot) {
  const size = scenario.size ?? DEFAULT_SIZE;
  const purposeDir = path.join(outRoot, scenario.purpose);
  mkdirSync(purposeDir, { recursive: true });

  const names = scenarioFilenames(scenario);
  const piFile = path.join(purposeDir, names.postIntervention);
  const baselineFile = path.join(purposeDir, names.baseline);

  generateOne(piFile, DEFAULT_CENTRE, {
    numParcels: size,
    attributeOverrides: scenario.overrides ?? {},
  });
  deriveBaselineFromSynthetic(piFile, baselineFile);
  verifyPair(baselineFile, piFile);
  const gain = priceGain(engine, scenario, piFile);

  info(
    `  ✓ ${scenario.purpose}/${scenario.id}${
      gain
        ? ` — net gain ${gain.percentage === null ? "n/a" : `${gain.percentage.toFixed(1)}%`} (${gain.expected})`
        : ""
    }`,
  );

  return {
    id: scenario.id,
    purpose: scenario.purpose,
    title: scenario.title,
    description: scenario.description,
    size,
    subject: scenario.subject,
    files: {
      baseline: path.join(scenario.purpose, names.baseline),
      postIntervention: path.join(scenario.purpose, names.postIntervention),
    },
    gain,
  };
}

/**
 * Run the whole catalogue (or a single purpose) and return manifest entries.
 *
 * @param {object} opts
 * @param {string} opts.outRoot output root directory
 * @param {string} [opts.only] restrict to a single purpose
 * @returns {Promise<object[]>}
 */
export async function runPermutations({ outRoot, only }) {
  const scenarios = only
    ? SCENARIOS.filter((s) => s.purpose === only)
    : SCENARIOS;
  if (scenarios.length === 0) {
    warn(`No scenarios match purpose "${only}". Known: ${PURPOSES.join(", ")}`);
    return [];
  }

  // Clear only the purpose folders we are about to regenerate, so a stale
  // scenario can't linger — without touching anything else under --outdir.
  mkdirSync(outRoot, { recursive: true });
  for (const purpose of new Set(scenarios.map((s) => s.purpose))) {
    const purposeDir = path.join(outRoot, purpose);
    if (existsSync(purposeDir)) {
      rmSync(purposeDir, { recursive: true, force: true });
    }
  }

  const engine = await loadEngine();
  // bng-library logs a banner per file; silence it and print our own progress.
  setMode("silent");
  header("Generating BNG permutations test data", "cyan");
  info(`  ${scenarios.length} scenario(s) → ${outRoot}`);

  const entries = [];
  for (const scenario of scenarios) {
    entries.push(runScenario(engine, scenario, outRoot));
  }
  setMode("cli");
  return entries;
}
