/**
 * Drive the permutations catalogue: for each scenario, generate a
 * post-intervention GeoPackage, derive its baseline half, verify the pair,
 * price any net-gain expectation through the engine, and record a manifest
 * entry. Output is organised one sub-folder per purpose.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import {
  deriveBaselineFromSynthetic,
  derivePermutationSeed,
  generateOne,
  PERMUTATION_DEFAULT_SIZE,
  PERMUTATION_PURPOSES,
  PERMUTATION_SCENARIOS,
  setMode,
} from "#bng-lib";
import { openGeoPackageReadonly } from "#gpkg-io";
import { header, info, warn } from "../_lib.mjs";
import { loadEngine } from "./engine.mjs";
import { meetsNetGain, priceHabitats } from "./engine-units.mjs";

// The catalogue is defined once, in bng-library, so the CLI and the prototype
// share it. This runner adds the engine-accurate net-gain check and the
// purpose-organised, manifest-backed file layout on top of it.
const DEFAULT_SIZE = PERMUTATION_DEFAULT_SIZE;
const PURPOSES = PERMUTATION_PURPOSES;
const SCENARIOS = PERMUTATION_SCENARIOS;

// BNG/EPSG:27700 coords of Maidenhead — the same default centre gen-gpkg uses.
// Geometry layout is irrelevant to these attribute-driven scenarios, so every
// fixture shares one centre.
const MAIDENHEAD_EASTING = 530000;
const MAIDENHEAD_NORTHING = 180000;
const DEFAULT_CENTRE = [MAIDENHEAD_EASTING, MAIDENHEAD_NORTHING];

// Files live inside a folder named after the purpose, so when a scenario id
// leads with its purpose, drop it from the filename rather than repeat it:
// intervention/area-created-baseline.gpkg, not
// intervention/intervention-area-created-baseline.gpkg.
function scenarioFilenames(scenario) {
  const prefix = `${scenario.purpose}-`;
  const base = scenario.id.startsWith(prefix)
    ? scenario.id.slice(prefix.length)
    : scenario.id;
  return {
    baseline: `${base}-baseline.gpkg`,
    postIntervention: `${base}-post-intervention.gpkg`,
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

/**
 * Assert the scenario's subject feature actually landed in the fixture. Area
 * habitats always do (the parcel count equals the requested size), but a
 * hedgerow/watercourse subject depends on the rejection sampler producing at
 * least one linear feature — so fail the run loudly if geometry starved the
 * layer, rather than shipping a fixture that silently misses its category.
 */
function verifySubject(piFile, subject) {
  const db = openGeoPackageReadonly(piFile);
  try {
    const found = db
      .prepare(
        `SELECT count(*) AS n FROM "${subject.layer}" WHERE "Parcel Ref" = ?`,
      )
      .get(subject.ref).n;
    if (found === 0) {
      throw new Error(
        `subject ${subject.layer} "${subject.ref}" is missing — the layer generated too few features`,
      );
    }
  } finally {
    db.close();
  }
}

function formatPercentage(percentage) {
  // Number.isFinite guards null as well as NaN/Infinity (e.g. an all-skipped
  // scenario dividing 0 by 0), so those never reach toFixed.
  return Number.isFinite(percentage) ? `${percentage.toFixed(1)}%` : "n/a";
}

function assertGain(scenario, gain) {
  const met = meetsNetGain(gain.percentage);
  const expectedMet = scenario.expectGain === "met";
  if (met !== expectedMet) {
    const shown = formatPercentage(gain.percentage);
    throw new Error(
      `${scenario.id}: expected net gain "${scenario.expectGain}" but engine computed ${shown}`,
    );
  }
}

function formatGainSuffix(gain) {
  if (!gain) {
    return "";
  }
  return ` — net gain ${formatPercentage(gain.percentage)} (${gain.expected})`;
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

function runScenario(engine, scenario, outRoot, centre, seed) {
  const size = scenario.size ?? DEFAULT_SIZE;
  const purposeDir = path.join(outRoot, scenario.purpose);
  mkdirSync(purposeDir, { recursive: true });

  const names = scenarioFilenames(scenario);
  const piFile = path.join(purposeDir, names.postIntervention);
  const baselineFile = path.join(purposeDir, names.baseline);

  const plan = {
    numParcels: size,
    attributeOverrides: scenario.overrides ?? {},
  };
  if (seed !== null && seed !== undefined) {
    plan.seed = derivePermutationSeed(seed, scenario.id);
  }
  generateOne(piFile, centre, plan);
  deriveBaselineFromSynthetic(piFile, baselineFile);
  verifyPair(baselineFile, piFile);
  verifySubject(piFile, scenario.subject);
  const gain = priceGain(engine, scenario, piFile);

  info(`  ✓ ${scenario.purpose}/${scenario.id}${formatGainSuffix(gain)}`);

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
 * @param {[number, number]} [opts.centre] RLB centre (BNG easting,northing)
 * @param {number} [opts.seed] run seed; each scenario derives a stable seed
 *   from it, making every fixture byte-reproducible
 * @returns {Promise<object[]>}
 */
export async function runPermutations({
  outRoot,
  only,
  centre = DEFAULT_CENTRE,
  seed,
}) {
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

  // Only the net-gain scenarios price habitats through the engine, so only load
  // it (and require the backend sibling) when the selected set contains one.
  // This keeps `--only intervention` and friends working without the backend.
  const needsEngine = scenarios.some((s) => s.expectGain);
  const engine = needsEngine ? await loadEngine() : null;
  // bng-library logs a banner per file; silence it and print our own progress.
  setMode("silent");
  header("Generating BNG permutations test data", "cyan");
  info(`  ${scenarios.length} scenario(s) → ${outRoot}`);

  const entries = [];
  for (const scenario of scenarios) {
    entries.push(runScenario(engine, scenario, outRoot, centre, seed));
  }
  setMode("cli");
  return entries;
}
