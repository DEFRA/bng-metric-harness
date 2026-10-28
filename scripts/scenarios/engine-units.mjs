/**
 * Engine-accurate area-habitat unit accounting for a generated GeoPackage.
 *
 * The permutations runner constructs each "net gain" scenario to be clearly
 * Met (>= 10%) or Unmet (< 10%); this module then reads the habitats back and
 * runs each through the real `bng-library/metric` calculators, so the manifest
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
import { metricTiming } from "./import-timing.mjs";

// PostGIS/synthetic areas are square metres; the engine expects hectares.
const SQ_METRES_PER_HECTARE = 10000;
// The +10% biodiversity net gain threshold, as a percentage.
export const NET_GAIN_THRESHOLD_PERCENT = 10;

const RETAINED = "Retained";
const ENHANCED = "Enhanced";
// A "Lost" area habitat is accounted as Created (see module comment).
const LOST = "Lost";
const CREATED = "Created";

function fullName(broad, type) {
  return `${broad} - ${type}`;
}

/**
 * Post-intervention units for a single area-habitat row, dispatched on its
 * gpkg retention category. Returns null if the engine cannot price the row
 * (e.g. an intentionally incomplete row with a blank proposed condition).
 */
function postInterventionUnits(engine, row, sizeHa) {
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
  const retention = row["Retention Category"];
  const { advanceYears: advance, delayYears: delay } = metricTiming(
    retention,
    ...row.timing,
    "Habitats",
  );

  if (retention === RETAINED) {
    return engine.calculateRetainedAreaHabitatPostIntervention(
      sizeHa,
      baseline,
      baselineCondition,
    ).units;
  }
  if (advance === null || delay === null) {
    return null;
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
  if (retention === LOST || retention === CREATED) {
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

function baselineUnits(engine, row, sizeHa) {
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

const ADVANCE = "Habitat created in advance/years";
const DELAY = "Delay in starting habitat creation/years";
const BNG_SERVICE_BASELINE = "Area Habitats Baseline";
const BNG_SERVICE_POST = "Area Habitats Post-Intervention";

const blank = (value) => value === null || value === undefined || value === "";

/**
 * A BNG Service row's advance and delay years. The template blanks one of the
 * two while the other is above 0, so a blank beside a set value is 0; two
 * blanks stay blank, as incomplete.
 */
function bngServiceTiming(row) {
  const advance = row[ADVANCE];
  const delay = row[DELAY];
  if (blank(advance) && !blank(delay)) {
    return ["0", delay];
  }
  if (blank(delay) && !blank(advance)) {
    return [advance, "0"];
  }
  return [advance, delay];
}

function tableExists(db, table) {
  return Boolean(
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table),
  );
}

/**
 * The area habitats to price, each with its size in hectares and its timing:
 * in the legacy layout one row carries both stages (Area in square metres);
 * in the BNG Service format the baseline and post-intervention rows are apart,
 * each post-intervention row carrying its parent's baseline values, and Area
 * is in hectares.
 */
function readHabitats(file) {
  const db = openGeoPackageReadonly(file);
  try {
    if (tableExists(db, BNG_SERVICE_BASELINE)) {
      return {
        baseline: db
          .prepare(`SELECT * FROM "${BNG_SERVICE_BASELINE}"`)
          .all()
          .map((row) => ({ ...row, sizeHa: row.Area })),
        postIntervention: db
          .prepare(`SELECT * FROM "${BNG_SERVICE_POST}"`)
          .all()
          .map((row) => ({
            ...row,
            sizeHa: row.Area,
            timing: bngServiceTiming(row),
          })),
      };
    }
    const rows = db
      .prepare(`SELECT * FROM "Habitats"`)
      .all()
      .map((row) => ({
        ...row,
        sizeHa: row.Area / SQ_METRES_PER_HECTARE,
        timing: [row[ADVANCE], row[DELAY]],
      }));
    return { baseline: rows, postIntervention: rows };
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
 * @param {object} engine loaded bng-library/metric namespace
 * @param {string} file path to the legacy post-intervention gpkg (carries both
 *   sides), or to a BNG Service file
 */
export function priceHabitats(engine, file) {
  const { baseline, postIntervention } = readHabitats(file);
  const total = (rows, price) => {
    let sum = 0;
    let unpriced = 0;
    for (const row of rows) {
      const units = safePrice(() => price(engine, row, row.sizeHa));
      sum += units ?? 0;
      unpriced += units === null ? 1 : 0;
    }
    return { sum, unpriced };
  };
  const base = total(baseline, baselineUnits);
  const post = total(postIntervention, postInterventionUnits);
  // A row either stage could not price is skipped; in the legacy layout one
  // row is both stages, so it is counted once.
  const rowCount = Math.max(baseline.length, postIntervention.length);
  const skipped =
    baseline === postIntervention
      ? countUnpricedRows(engine, baseline)
      : base.unpriced + post.unpriced;

  const { habitatsNetUnitChange, habitatsNetUnitChangePercentage } =
    engine.calculatePostInterventionNetUnitChanges(
      { habitatsTotal: base.sum },
      { habitatsTotal: post.sum },
    );

  return {
    baselineTotal: base.sum,
    postInterventionTotal: post.sum,
    netUnitChange: habitatsNetUnitChange,
    netGainPercentage: habitatsNetUnitChangePercentage,
    priced: rowCount - skipped,
    skipped,
  };
}

/** Legacy rows that either stage could not price, each counted once. */
function countUnpricedRows(engine, rows) {
  return rows.filter(
    (row) =>
      safePrice(() => postInterventionUnits(engine, row, row.sizeHa)) ===
        null ||
      safePrice(() => baselineUnits(engine, row, row.sizeHa)) === null,
  ).length;
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
