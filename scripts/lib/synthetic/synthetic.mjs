/**
 * Synthetic-mode GeoPackage generator. Produces a single file with all 5
 * feature layers, geometry sampled randomly inside a generated RLB. The
 * --bad fixture lives in `synthetic-bad.mjs`; pick-list constants and the
 * precomputed HABITATS table live in `synthetic-constants.mjs`.
 */

import { color, header, info } from "../../_lib.mjs";
import {
  envelopeFromCoords,
  expandEnvelope,
  gpkgLineString,
  gpkgPoint,
  gpkgPolygon,
  openGeoPackageReadonly,
  placeholders,
} from "#gpkg-io";
import {
  HABITATS_INSERT_COLUMNS,
  HEDGEROWS_INSERT_COLUMNS,
  RIVERS_INSERT_COLUMNS,
  SRS_ID,
  URBAN_TREES_INSERT_COLUMNS,
  createAllTables,
  createLayerStyles,
  openGeoPackage,
  registerLayer,
} from "../bng-schema.mjs";
import {
  generateIrregularPolygon,
  generateLinestring,
  lineInsideRing,
  linestringLength,
  partitionPolygon,
  pick,
  pickInteriorPoint,
  polygonArea,
  randInt,
} from "../geometry.mjs";
import {
  FEATURE_REF_PAD,
  FEATURE_REF_PAD_CHAR,
} from "../workbook/workbook-rows.mjs";
import { generateOneBad } from "./synthetic-bad.mjs";
import { EMPTYABLE_LAYERS } from "./flaws.mjs";
import {
  BASE_MAP,
  BROAD_HABITAT_TYPES,
  CONDITIONS,
  DISTINCTIVENESS,
  ENCROACHMENT_RIPARIAN,
  ENCROACHMENT_WATERCOURSE,
  HABITATS,
  HABITATS_BY_BROAD,
  HEDGE_CONDITIONS,
  HEDGEROW_PER_PARCEL_RATIO,
  HEDGE_TYPES,
  LINE_FEATURE_REJECTION_BUDGET_FACTOR,
  LOCATIONS,
  MAPPED_BY,
  MIN_HEDGEROW_COUNT,
  MIN_RIVER_COUNT,
  MIN_TREE_COUNT,
  RETENTION_CATEGORIES,
  RIVER_PER_PARCEL_RATIO,
  RIVER_TYPES,
  SITE_NAME,
  SPATIAL_RISK_HABITAT,
  SPATIAL_RISK_RIVER,
  STRATEGIC_SIGNIFICANCE,
  SURVEY_COMPANY,
  SURVEY_DATE,
  SYNTHETIC_RLB_RADIUS_M,
  TREE_PER_PARCEL_RATIO,
  TREE_TYPE_STREET,
} from "./synthetic-constants.mjs";

// ---------------------------------------------------------------------------
// Tunables specific to synthetic-mode emission.
// ---------------------------------------------------------------------------

const MAX_CREATED_ADVANCE_YEARS = 5;
const MAX_CREATED_DELAY_YEARS = 3;
const MAX_HEDGE_ADVANCE_YEARS = 3;
const MAX_HEDGE_DELAY_YEARS = 2;
const TREE_COUNT_DEFAULT = 1;
const ZERO_YEARS = "0";

// ---------------------------------------------------------------------------
// Synthetic generators
// ---------------------------------------------------------------------------

function generateRedLineBoundary(db, cx, cy, radius) {
  const ring = generateIrregularPolygon(cx, cy, radius);
  const geom = gpkgPolygon(SRS_ID, ring);
  const area = polygonArea(ring);

  db.prepare(
    `INSERT INTO "Red Line Boundary" (geometry, "Area", "Site Name") VALUES (?, ?, ?)`,
  ).run(geom, Math.round(area), SITE_NAME);

  registerLayer(db, "Red Line Boundary", "POLYGON", envelopeFromCoords(ring));
  return ring;
}

function syntheticRef(prefix, i) {
  return `${prefix}${String(i + 1).padStart(FEATURE_REF_PAD, FEATURE_REF_PAD_CHAR)}`;
}

function pickProposedHabitat(baseline, retention) {
  if (retention === "Retained") {
    return baseline;
  }
  const proposedBroad = retention === "Lost" ? pick(BROAD_HABITAT_TYPES) : baseline.broad;
  return pick(HABITATS_BY_BROAD[proposedBroad]);
}

function generateHabitats(db, boundaryRing, numParcels) {
  const parcels = partitionPolygon(boundaryRing, numParcels);
  const stmt = db.prepare(`
    INSERT INTO "Habitats" (
      geometry, "Parcel Ref", "Baseline Broad Habitat Type", "Baseline Habitat Type",
      "Area", "Baseline Condition", "Baseline Strategic Significance",
      "Retention Category", "Proposed Broad Habitat Type", "Proposed Habitat Type",
      "Proposed Condition", "Proposed Strategic Significance",
      "Habitat created in advance/years", "Delay in starting habitat creation/years",
      "Spatial risk category", "Location", "Site Name", "Survey Date",
      "Survey Details", "Comment", "Mapped by", "Company", "Base Map",
      "Baseline Distinctiveness", "Proposed Distinctiveness"
    ) VALUES (${placeholders(HABITATS_INSERT_COLUMNS)})
  `);

  const allEnvelope = [Infinity, -Infinity, Infinity, -Infinity];
  for (let i = 0; i < parcels.length; i += 1) {
    const ring = parcels[i];
    expandEnvelope(allEnvelope, envelopeFromCoords(ring));
    const baseline = pick(HABITATS);
    const retention = pick(RETENTION_CATEGORIES);
    const proposed = pickProposedHabitat(baseline, retention);
    stmt.run(
      gpkgPolygon(SRS_ID, ring),
      syntheticRef("H", i),
      baseline.broad,
      baseline.type,
      Math.round(polygonArea(ring)),
      pick(baseline.validConditions),
      pick(STRATEGIC_SIGNIFICANCE),
      retention,
      proposed.broad,
      proposed.type,
      pick(proposed.validConditions),
      pick(STRATEGIC_SIGNIFICANCE),
      retention === "Created" ? String(randInt(0, MAX_CREATED_ADVANCE_YEARS)) : ZERO_YEARS,
      retention === "Created" ? String(randInt(0, MAX_CREATED_DELAY_YEARS)) : ZERO_YEARS,
      pick(SPATIAL_RISK_HABITAT),
      pick(LOCATIONS),
      SITE_NAME,
      SURVEY_DATE,
      "Phase 1 habitat survey",
      null,
      MAPPED_BY,
      SURVEY_COMPANY,
      BASE_MAP,
      baseline.distinctiveness,
      proposed.distinctiveness,
    );
  }
  registerLayer(db, "Habitats", "POLYGON", parcels.length > 0 ? allEnvelope : null);
}

/**
 * Shared rejection-sampling driver for the synthetic line-feature layers.
 * Picks linestrings via `generateLinestring`, rejects any whose vertices
 * fall outside the boundary, and inserts up to `count` accepted features.
 */
function generateLineFeatures(db, boundaryRing, count, { tableName, sql, buildRow }) {
  const stmt = db.prepare(sql);
  const allEnvelope = [Infinity, -Infinity, Infinity, -Infinity];
  let produced = 0;
  let attempts = 0;
  const maxAttempts = count * LINE_FEATURE_REJECTION_BUDGET_FACTOR;
  while (produced < count && attempts < maxAttempts) {
    attempts += 1;
    const coords = generateLinestring(boundaryRing);
    if (coords && lineInsideRing(coords, boundaryRing)) {
      expandEnvelope(allEnvelope, envelopeFromCoords(coords));
      stmt.run(...buildRow(coords, produced));
      produced += 1;
    }
  }
  registerLayer(db, tableName, "LINESTRING", produced > 0 ? allEnvelope : null);
}

const HEDGEROWS_SQL_SYNTH = `
  INSERT INTO "Hedgerows" (
    geometry, "Parcel Ref", "Baseline Hedge Type", "Baseline Condition",
    "Baseline Strategic Significance", "Retention Category",
    "Proposed Hedge Type", "Proposed Condition", "Proposed Strategic Significance",
    "Length", "Habitat created in advance/years",
    "Delay in starting habitat creation/years", "Spatial risk category",
    "Location", "Site Name", "Survey Date", "Survey Details", "Comments",
    "Mapped by", "Company", "Base Map",
    "Baseline Distinctiveness", "Proposed Distinctiveness"
  ) VALUES (${placeholders(HEDGEROWS_INSERT_COLUMNS)})
`;

function generateHedgerows(db, boundaryRing, count) {
  generateLineFeatures(db, boundaryRing, count, {
    tableName: "Hedgerows",
    sql: HEDGEROWS_SQL_SYNTH,
    buildRow: (coords, i) => {
      const hedgeType = pick(HEDGE_TYPES);
      const retention = pick(RETENTION_CATEGORIES);
      return [
        gpkgLineString(SRS_ID, coords),
        syntheticRef("HG", i),
        hedgeType,
        pick(HEDGE_CONDITIONS),
        pick(STRATEGIC_SIGNIFICANCE),
        retention,
        retention === "Lost" ? pick(HEDGE_TYPES) : hedgeType,
        pick(HEDGE_CONDITIONS),
        pick(STRATEGIC_SIGNIFICANCE),
        linestringLength(coords),
        retention === "Created" ? String(randInt(0, MAX_HEDGE_ADVANCE_YEARS)) : ZERO_YEARS,
        retention === "Created" ? String(randInt(0, MAX_HEDGE_DELAY_YEARS)) : ZERO_YEARS,
        pick(SPATIAL_RISK_HABITAT),
        pick(LOCATIONS),
        SITE_NAME,
        SURVEY_DATE,
        "Hedgerow survey",
        null,
        MAPPED_BY,
        SURVEY_COMPANY,
        BASE_MAP,
        pick(DISTINCTIVENESS),
        pick(DISTINCTIVENESS),
      ];
    },
  });
}

const RIVERS_SQL_SYNTH = `
  INSERT INTO "Rivers" (
    geometry, "Parcel Ref", "Baseline River Type", "Baseline Condition",
    "Baseline Strategic Significance",
    "Baseline Encroachment into Watercourse",
    "Baseline Encroachment into riparian zone",
    "Retention Category", "Proposed River Type", "Proposed Condition",
    "Proposed Strategic Significance", "Length",
    "Habitat created in advance/years",
    "Delay in starting habitat creation/years",
    "Spatial risk category", "Location",
    "Proposed Encroachment into Watercourse",
    "Proposed Encroachment into riparian zone",
    "Site Name", "Survey Date", "Survey Details", "Comments",
    "Mapped by", "Company", "Base Map",
    "Enhancement Type", "Baseline Distinctiveness", "Proposed Distinctiveness"
  ) VALUES (${placeholders(RIVERS_INSERT_COLUMNS)})
`;

function generateRivers(db, boundaryRing, count) {
  generateLineFeatures(db, boundaryRing, count, {
    tableName: "Rivers",
    sql: RIVERS_SQL_SYNTH,
    buildRow: (coords, i) => {
      const riverType = pick(RIVER_TYPES);
      const retention = pick(["Retained", "Enhanced"]);
      return [
        gpkgLineString(SRS_ID, coords),
        syntheticRef("R", i),
        riverType,
        pick(CONDITIONS),
        pick(STRATEGIC_SIGNIFICANCE),
        pick(ENCROACHMENT_WATERCOURSE),
        pick(ENCROACHMENT_RIPARIAN),
        retention,
        riverType,
        pick(CONDITIONS),
        pick(STRATEGIC_SIGNIFICANCE),
        linestringLength(coords),
        ZERO_YEARS,
        ZERO_YEARS,
        pick(SPATIAL_RISK_RIVER),
        pick(LOCATIONS),
        pick(ENCROACHMENT_WATERCOURSE),
        pick(ENCROACHMENT_RIPARIAN),
        SITE_NAME,
        SURVEY_DATE,
        "River corridor survey",
        null,
        MAPPED_BY,
        SURVEY_COMPANY,
        BASE_MAP,
        null,
        pick(DISTINCTIVENESS),
        pick(DISTINCTIVENESS),
      ];
    },
  });
}

const URBAN_TREES_SQL_SYNTH = `
  INSERT INTO "Urban Trees" (
    geometry, "Tree Ref", "Baseline Tree Size", "Baseline Condition",
    "Baseline Strategic Significance", "Baseline Tree Type",
    "Retention Category", "Category",
    "Proposed Tree Size", "Proposed Condition",
    "Proposed Strategic Significance", "Proposed Tree Type",
    "Location", "Habitat Created/Enhanced in advance/years",
    "Delay in starting habitat creation/enhancement in years",
    "Spatial risk category", "Site Name", "Survey Date",
    "Survey Details", "Comment", "Mapped by", "Company", "Base Map",
    "Count", "Baseline Rural or Urban Tree", "Proposed Rural or Urban Tree"
  ) VALUES (${placeholders(URBAN_TREES_INSERT_COLUMNS)})
`;

const TREE_SIZES = ["Small", "Medium", "Large"];
const TREE_TYPES = [TREE_TYPE_STREET, "Park/garden tree", "Woodland tree", "Hedgerow tree"];

function generateUrbanTrees(db, boundaryRing, count) {
  const stmt = db.prepare(URBAN_TREES_SQL_SYNTH);
  const allEnvelope = [Infinity, -Infinity, Infinity, -Infinity];
  let produced = 0;
  while (produced < count) {
    const point = pickInteriorPoint(boundaryRing);
    if (!point) {
      break;
    }
    const [x, y] = point;
    expandEnvelope(allEnvelope, [x, x, y, y]);
    const size = pick(TREE_SIZES);
    const type = pick(TREE_TYPES);
    const retention = pick(["Retained", "Enhanced", "Lost"]);
    stmt.run(
      gpkgPoint(SRS_ID, x, y),
      syntheticRef("T", produced),
      size,
      pick(CONDITIONS),
      pick(STRATEGIC_SIGNIFICANCE),
      type,
      retention,
      retention === "Lost" ? "Lost" : "Retained",
      retention === "Lost" ? pick(TREE_SIZES) : size,
      pick(CONDITIONS),
      pick(STRATEGIC_SIGNIFICANCE),
      retention === "Lost" ? pick(TREE_TYPES) : type,
      pick(LOCATIONS),
      ZERO_YEARS,
      ZERO_YEARS,
      pick(SPATIAL_RISK_HABITAT),
      SITE_NAME,
      SURVEY_DATE,
      "Tree survey",
      null,
      MAPPED_BY,
      SURVEY_COMPANY,
      BASE_MAP,
      TREE_COUNT_DEFAULT,
      "Urban",
      "Urban",
    );
    produced += 1;
  }
  registerLayer(db, "Urban Trees", "POINT", produced > 0 ? allEnvelope : null);
}

function reportContents(outPath) {
  const verify = openGeoPackageReadonly(outPath);
  const layers = verify
    .prepare("SELECT table_name FROM gpkg_contents WHERE data_type = 'features'")
    .all();
  for (const layer of layers) {
    const count = verify.prepare(`SELECT COUNT(*) as n FROM "${layer.table_name}"`).get();
    info(`  ${layer.table_name}: ${count.n} feature(s)`);
  }
  verify.close();
}

/**
 * Generate one synthetic GeoPackage (default mode). Pass `bad=true` to emit
 * the intentionally-invalid fixture instead.
 */
function computeLayerCounts(numParcels, emptyLayers) {
  const ifEmpty = (key, value) => (emptyLayers.has(key) ? 0 : value);
  return {
    numHabitats: ifEmpty("habitats", numParcels),
    numHedgerows: ifEmpty(
      "hedgerows",
      Math.max(MIN_HEDGEROW_COUNT, Math.floor(numParcels / HEDGEROW_PER_PARCEL_RATIO)),
    ),
    numRivers: ifEmpty(
      "rivers",
      Math.max(MIN_RIVER_COUNT, Math.floor(numParcels / RIVER_PER_PARCEL_RATIO)),
    ),
    numTrees: ifEmpty(
      "trees",
      Math.max(MIN_TREE_COUNT, Math.floor(numParcels / TREE_PER_PARCEL_RATIO)),
    ),
  };
}

function logSyntheticBanner(outPath, centre, counts, emptyLayers) {
  const { numHabitats, numHedgerows, numRivers, numTrees } = counts;
  header(`Generating BNG test GeoPackage`, "cyan");
  info(`  ${SITE_NAME}`);
  info(
    `  ${numHabitats} habitat parcels, ${numHedgerows} hedgerows, ${numRivers} rivers, ${numTrees} urban trees`,
  );
  if (emptyLayers.size > 0) {
    info(
      `  empty layers: ${[...emptyLayers].sort((a, b) => a.localeCompare(b)).join(", ")}`,
    );
  }
  info(`  centre: ${centre[0]},${centre[1]} (BNG)`);
  info(`  → ${outPath}`);
}

// For an "empty" layer we want the table to exist with zero rows. We can't
// just call generateHabitats(0) — it would still emit one parcel covering the
// whole boundary. Instead, register the layer here with a null envelope and
// skip the matching generator in runLayerGenerators.
function registerEmptyLayers(db, emptyLayers) {
  for (const [key, { table, geom }] of Object.entries(EMPTYABLE_LAYERS)) {
    if (emptyLayers.has(key)) {
      registerLayer(db, table, geom, null);
    }
  }
}

function runLayerGenerators(db, ring, counts, emptyLayers) {
  const generators = {
    habitats: () => generateHabitats(db, ring, counts.numHabitats),
    hedgerows: () => generateHedgerows(db, ring, counts.numHedgerows),
    rivers: () => generateRivers(db, ring, counts.numRivers),
    trees: () => generateUrbanTrees(db, ring, counts.numTrees),
  };
  for (const [key, generate] of Object.entries(generators)) {
    if (!emptyLayers.has(key)) {
      generate();
    }
  }
}

export function generateOne(outPath, badFlawNames, numParcels, centre, emptyLayers = new Set()) {
  if (badFlawNames && badFlawNames.length > 0) {
    generateOneBad(outPath, centre, badFlawNames);
    return;
  }

  const counts = computeLayerCounts(numParcels, emptyLayers);
  logSyntheticBanner(outPath, centre, counts, emptyLayers);

  const [cx, cy] = centre;
  const db = openGeoPackage(outPath);
  createAllTables(db);

  const ring = generateRedLineBoundary(db, cx, cy, SYNTHETIC_RLB_RADIUS_M);
  registerEmptyLayers(db, emptyLayers);
  runLayerGenerators(db, ring, counts, emptyLayers);
  createLayerStyles(db);

  db.close();

  reportContents(outPath);
  console.log(color("green", `✔ Done. ${outPath}`));
}
