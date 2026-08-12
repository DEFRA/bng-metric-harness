/**
 * Engine-accurate area-habitat unit accounting for a generated GeoPackage.
 *
 * The permutations runner constructs each "net gain" scenario to be clearly
 * Met (>= 10%) or Unmet (< 10%); this module then reads the habitats back and
 * runs each through the real `bng-metric-engine` calculators, so the manifest
 * records the actual net-gain percentage and the runner can assert it landed on
 * the expected side of the 10% threshold. The net-gain rule is an area-habitat
 * concept, so only the Habitats layer is priced here.
 *
 * The retention→calculator dispatch mirrors the backend's own enrichment: an
 * area habitat is Retained, Enhanced, or Created, and a "Lost" area is recorded
 * as Created (the statutory metric replaces lost area with a new land use
 * rather than removing area from the tessellated site).
 */

import { openGeoPackageReadonly } from "#gpkg-io";

// PostGIS/synthetic areas are square metres; the engine expects hectares.
const SQ_METRES_PER_HECTARE = 10000;
// The +10% biodiversity net gain threshold, as a percentage.
export const NET_GAIN_THRESHOLD_PERCENT = 10;

const RETAINED = "Retained";
const ENHANCED = "Enhanced";
// A "Lost" area habitat is accounted as Created (see module comment).
const LOST = "Lost";

function fullName(broad, type) {
  return `${broad} - ${type}`;
}

function toYears(value) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Post-intervention units for a single area-habitat row, dispatched on its
 * gpkg retention category. Returns null if the engine cannot price the row
 * (e.g. an intentionally incomplete row with a blank proposed condition).
 */
function postInterventionUnits(engine, row) {
  const sizeHa = row.Area / SQ_METRES_PER_HECTARE;
  const baseline = fullName(
    row["Baseline Broad Habitat Type"],
    row["Baseline Habitat Type"],
  );
  const proposed = fullName(
    row["Proposed Broad Habitat Type"],
    row["Proposed Habitat Type"],
  );
  const baselineCondition = row["Baseline Condition"];
  const proposedCondition = row["Proposed Condition"];
  const advance = toYears(row["Habitat created in advance/years"]);
  const delay = toYears(row["Delay in starting habitat creation/years"]);
  const retention = row["Retention Category"];

  if (retention === RETAINED) {
    return engine.calculateRetainedAreaHabitatPostIntervention(
      sizeHa,
      baseline,
      baselineCondition,
    ).units;
  }
  if (retention === ENHANCED) {
    return engine.calculateEnhancedAreaHabitatPostIntervention(
      sizeHa,
      baseline,
      proposed,
      baselineCondition,
      proposedCondition,
      advance,
      delay,
    ).units;
  }
  if (retention === LOST) {
    return engine.calculateCreatedAreaHabitatPostIntervention(
      sizeHa,
      proposed,
      proposedCondition,
      advance,
      delay,
    ).units;
  }
  return null;
}

function baselineUnits(engine, row) {
  const sizeHa = row.Area / SQ_METRES_PER_HECTARE;
  const baseline = fullName(
    row["Baseline Broad Habitat Type"],
    row["Baseline Habitat Type"],
  );
  return engine.calculateAreaHabitatBaseline(
    sizeHa,
    baseline,
    row["Baseline Condition"],
  ).units;
}

function readHabitats(file) {
  const db = openGeoPackageReadonly(file);
  try {
    return db.prepare(`SELECT * FROM "Habitats"`).all();
  } finally {
    db.close();
  }
}

/**
 * Price a fixture's habitats and return the baseline / post-intervention unit
 * totals plus the engine's own net-gain percentage. Rows the engine cannot
 * price (skipped) are counted so the caller can distinguish "no gain" from
 * "incomplete data".
 *
 * @param {object} engine loaded bng-metric-engine namespace
 * @param {string} file path to the post-intervention gpkg (carries both sides)
 */
export function priceHabitats(engine, file) {
  const rows = readHabitats(file);
  let baselineTotal = 0;
  let postInterventionTotal = 0;
  let priced = 0;
  let skipped = 0;

  for (const row of rows) {
    const pi = safePrice(() => postInterventionUnits(engine, row));
    const base = safePrice(() => baselineUnits(engine, row));
    if (pi === null || base === null) {
      skipped += 1;
      continue;
    }
    baselineTotal += base;
    postInterventionTotal += pi;
    priced += 1;
  }

  const { habitatsNetUnitChange, habitatsNetUnitChangePercentage } =
    engine.calculatePostInterventionNetUnitChanges(
      { habitatsTotal: baselineTotal },
      { habitatsTotal: postInterventionTotal },
    );

  return {
    baselineTotal,
    postInterventionTotal,
    netUnitChange: habitatsNetUnitChange,
    netGainPercentage: habitatsNetUnitChangePercentage,
    priced,
    skipped,
  };
}

function safePrice(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
}

/** Whether a priced result clears the statutory +10% net-gain threshold. */
export function meetsNetGain(netGainPercentage) {
  return (
    typeof netGainPercentage === "number" &&
    netGainPercentage >= NET_GAIN_THRESHOLD_PERCENT
  );
}
