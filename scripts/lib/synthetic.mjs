/**
 * Synthetic-mode GeoPackage generators. Used by `gen-gpkg.mjs` when run
 * without `--from` to produce randomised fixtures, and also for the `--bad`
 * intentionally-invalid fixture that exercises validator error codes.
 */

import Database from "better-sqlite3";
import { color, header, info } from "../_lib.mjs";
import { conditionScores as metricConditionScores } from "../data/metric-values-habitat-condition.mjs";
import { distinctivenessCategories as metricDistinctiveness } from "../data/metric-values-habitat-distinctiveness.mjs";
import {
  HABITATS_INSERT_COLUMNS,
  HEDGEROWS_INSERT_COLUMNS,
  RIVERS_INSERT_COLUMNS,
  SRS_ID,
  URBAN_TREES_INSERT_COLUMNS,
  createAllTables,
  createLayerStyles,
  gpkgLineString,
  gpkgPoint,
  gpkgPolygon,
  initGeoPackage,
  registerLayer,
} from "./gpkg-core.mjs";
import {
  bowtieRing,
  envelopeFromCoords,
  expandEnvelope,
  generateIrregularPolygon,
  generateLinestring,
  lineInsideRing,
  linestringLength,
  partitionPolygon,
  pick,
  pickInteriorPoint,
  polygonArea,
  randInt,
  rectRing,
} from "./geometry.mjs";
import { FEATURE_REF_PAD, FEATURE_REF_PAD_CHAR } from "./workbook-rows.mjs";

// ---------------------------------------------------------------------------
// Site metadata & pick lists for the synthetic-mode generators.
// ---------------------------------------------------------------------------

const SITE_NAME = "Oakwood Regional Development";
const SURVEY_DATE = "2025-06-15";
const MAPPED_BY = "J. Smith";
const SURVEY_COMPANY = "Ecological Consultants Ltd";
const BASE_MAP = "OS MasterMap";
const BAD_FIXTURE_SURVEY_DETAILS = "Bad-mode fixture";
const TREE_TYPE_STREET = "Street tree";

// Restrict to inland broad types — fixture site is land-based, so coastal,
// intertidal, rocky-shore etc. are out of scope. Also skips any habitat the
// metric defines as non-area (e.g. "Individual trees", "Watercourse footprint",
// "Infrastructure (IGGI)"), which belong on other layers or aren't applicable.
const INLAND_BROAD_TYPES = new Set([
  "Cropland",
  "Grassland",
  "Heathland and shrub",
  "Lakes",
  "Sparsely vegetated land",
  "Urban",
  "Wetland",
  "Woodland and forest",
]);

/** @type {{ fullName: string, broad: string, type: string, validConditions: string[], distinctiveness: string }[]} */
const HABITATS = [];
const HABITATS_BY_BROAD = {};

for (const fullName of Object.keys(metricDistinctiveness)) {
  const sepIdx = fullName.indexOf(" - ");
  if (sepIdx < 0) {
    continue;
  }
  const broad = fullName.slice(0, sepIdx);
  const type = fullName.slice(sepIdx + 3);
  if (!INLAND_BROAD_TYPES.has(broad)) {
    continue;
  }

  const conds = metricConditionScores[fullName];
  if (!conds) {
    continue;
  }
  const validConditions = Object.entries(conds)
    .filter(([, v]) => typeof v === "number")
    .map(([k]) => k);
  if (validConditions.length === 0) {
    continue;
  }

  const habitat = {
    fullName,
    broad,
    type,
    validConditions,
    distinctiveness: metricDistinctiveness[fullName],
  };
  HABITATS.push(habitat);
  (HABITATS_BY_BROAD[broad] = HABITATS_BY_BROAD[broad] || []).push(habitat);
}

const BROAD_HABITAT_TYPES = Object.keys(HABITATS_BY_BROAD);

// Hedgerows / Rivers / Urban Trees use their own metric tables; the prototype
// validates them separately. Until the same wiring is added for those layers,
// keep the generic enum lists used previously.
const CONDITIONS = ["Good", "Fairly Good", "Moderate", "Fairly Poor", "Poor"];
const DISTINCTIVENESS = ["V.High", "High", "Medium", "Low", "V.Low"];

const STRATEGIC_SIGNIFICANCE = [
  "Formally identified in local strategy",
  "Location ecologically desirable but not in local strategy",
  "Area/compensation not in local strategy/ no local strategy",
];

const RETENTION_CATEGORIES = ["Retained", "Enhanced", "Lost", "Created"];

const LOCATIONS = ["On-site", "Off-site"];

const SPATIAL_RISK_HABITAT = [
  "Compensation inside LPA boundary or NCA of impact site",
  "Compensation outside LPA or NCA of impact site, but in neighbouring LPA or NCA",
];

const HEDGE_TYPES = [
  "Species-rich native hedgerow with trees",
  "Species-rich native hedgerow",
  "Native hedgerow with trees",
  "Native hedgerow",
  "Native hedgerow - associated with bank or ditch",
  "Line of trees",
  "Non-native and ornamental hedgerow",
];

const HEDGE_CONDITIONS = ["Good", "Moderate", "Poor"];

const RIVER_TYPES = [
  "Priority habitat",
  "Other rivers and streams",
  "Ditches",
  "Canals",
  "Culvert",
];

const ENCROACHMENT_WATERCOURSE = ["No Encroachment", "Minor", "Major"];

const ENCROACHMENT_RIPARIAN = [
  "Major/Major",
  "Major/Moderate",
  "Moderate/Moderate",
  "Minor/Minor",
  "Minor/No Encroachment",
  "No Encroachment/No Encroachment",
];

const SPATIAL_RISK_RIVER = [
  "Within waterbody catchment",
  "Outside waterbody catchment, but within operational catchment",
];

// ---------------------------------------------------------------------------
// Synthetic generators (--size mode)
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
    ) VALUES (${Array(HABITATS_INSERT_COLUMNS).fill("?").join(", ")})
  `);

  const allEnvelope = [Infinity, -Infinity, Infinity, -Infinity];

  for (let i = 0; i < parcels.length; i++) {
    const ring = parcels[i];
    const geom = gpkgPolygon(SRS_ID, ring);
    const env = envelopeFromCoords(ring);
    expandEnvelope(allEnvelope, env);

    const baseline = pick(HABITATS);
    const retention = pick(RETENTION_CATEGORIES);
    const proposedBroad =
      retention === "Lost" ? pick(BROAD_HABITAT_TYPES) : baseline.broad;
    const proposed =
      retention === "Retained"
        ? baseline
        : pick(HABITATS_BY_BROAD[proposedBroad]);
    const area = Math.round(polygonArea(ring));

    stmt.run(
      geom,
      `H${String(i + 1).padStart(FEATURE_REF_PAD, FEATURE_REF_PAD_CHAR)}`,
      baseline.broad,
      baseline.type,
      area,
      pick(baseline.validConditions),
      pick(STRATEGIC_SIGNIFICANCE),
      retention,
      proposed.broad,
      proposed.type,
      pick(proposed.validConditions),
      pick(STRATEGIC_SIGNIFICANCE),
      retention === "Created" ? String(randInt(0, 5)) : "0",
      retention === "Created" ? String(randInt(0, 3)) : "0",
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

  registerLayer(
    db,
    "Habitats",
    "POLYGON",
    parcels.length > 0 ? allEnvelope : null,
  );
}

/**
 * Shared rejection-sampling driver for linestring layers (Hedgerows, Rivers).
 *
 * Picks linestrings via `generateLinestring`, rejects any whose vertices fall
 * outside the boundary, and inserts up to `count` accepted features.
 */
function generateLineFeatures(db, boundaryRing, count, { tableName, sql, buildRow }) {
  const stmt = db.prepare(sql);
  const allEnvelope = [Infinity, -Infinity, Infinity, -Infinity];

  let produced = 0;
  let attempts = 0;
  const maxAttempts = count * 20;
  while (produced < count && attempts < maxAttempts) {
    attempts++;
    const coords = generateLinestring(boundaryRing);
    if (!coords || !lineInsideRing(coords, boundaryRing)) {
      continue;
    }
    expandEnvelope(allEnvelope, envelopeFromCoords(coords));
    stmt.run(...buildRow(coords, produced));
    produced++;
  }

  registerLayer(db, tableName, "LINESTRING", produced > 0 ? allEnvelope : null);
}

function generateHedgerows(db, boundaryRing, count) {
  generateLineFeatures(db, boundaryRing, count, {
    tableName: "Hedgerows",
    sql: `
      INSERT INTO "Hedgerows" (
        geometry, "Parcel Ref", "Baseline Hedge Type", "Baseline Condition",
        "Baseline Strategic Significance", "Retention Category",
        "Proposed Hedge Type", "Proposed Condition", "Proposed Strategic Significance",
        "Length", "Habitat created in advance/years",
        "Delay in starting habitat creation/years", "Spatial risk category",
        "Location", "Site Name", "Survey Date", "Survey Details", "Comments",
        "Mapped by", "Company", "Base Map",
        "Baseline Distinctiveness", "Proposed Distinctiveness"
      ) VALUES (${Array(HEDGEROWS_INSERT_COLUMNS).fill("?").join(", ")})
    `,
    buildRow: (coords, i) => {
      const hedgeType = pick(HEDGE_TYPES);
      const retention = pick(RETENTION_CATEGORIES);
      return [
        gpkgLineString(SRS_ID, coords),
        `HG${String(i + 1).padStart(FEATURE_REF_PAD, FEATURE_REF_PAD_CHAR)}`,
        hedgeType,
        pick(HEDGE_CONDITIONS),
        pick(STRATEGIC_SIGNIFICANCE),
        retention,
        retention === "Lost" ? pick(HEDGE_TYPES) : hedgeType,
        pick(HEDGE_CONDITIONS),
        pick(STRATEGIC_SIGNIFICANCE),
        linestringLength(coords),
        retention === "Created" ? String(randInt(0, 3)) : "0",
        retention === "Created" ? String(randInt(0, 2)) : "0",
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

function generateRivers(db, boundaryRing, count) {
  generateLineFeatures(db, boundaryRing, count, {
    tableName: "Rivers",
    sql: `
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
      ) VALUES (${Array(RIVERS_INSERT_COLUMNS).fill("?").join(", ")})
    `,
    buildRow: (coords, i) => {
      const riverType = pick(RIVER_TYPES);
      const retention = pick(["Retained", "Enhanced"]);
      return [
        gpkgLineString(SRS_ID, coords),
        `R${String(i + 1).padStart(FEATURE_REF_PAD, FEATURE_REF_PAD_CHAR)}`,
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
        "0",
        "0",
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

function generateUrbanTrees(db, boundaryRing, count) {
  const treeSizes = ["Small", "Medium", "Large"];
  const treeTypes = [
    TREE_TYPE_STREET,
    "Park/garden tree",
    "Woodland tree",
    "Hedgerow tree",
  ];

  const stmt = db.prepare(`
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
    ) VALUES (${Array(URBAN_TREES_INSERT_COLUMNS).fill("?").join(", ")})
  `);

  const allEnvelope = [Infinity, -Infinity, Infinity, -Infinity];

  let produced = 0;
  while (produced < count) {
    const point = pickInteriorPoint(boundaryRing);
    if (!point) {
      break;
    }
    const [x, y] = point;
    expandEnvelope(allEnvelope, [x, x, y, y]);

    const size = pick(treeSizes);
    const type = pick(treeTypes);
    const retention = pick(["Retained", "Enhanced", "Lost"]);

    stmt.run(
      gpkgPoint(SRS_ID, x, y),
      `T${String(produced + 1).padStart(FEATURE_REF_PAD, FEATURE_REF_PAD_CHAR)}`,
      size,
      pick(CONDITIONS),
      pick(STRATEGIC_SIGNIFICANCE),
      type,
      retention,
      retention === "Lost" ? "Lost" : "Retained",
      retention === "Lost" ? pick(treeSizes) : size,
      pick(CONDITIONS),
      pick(STRATEGIC_SIGNIFICANCE),
      retention === "Lost" ? pick(treeTypes) : type,
      pick(LOCATIONS),
      "0",
      "0",
      pick(SPATIAL_RISK_HABITAT),
      SITE_NAME,
      SURVEY_DATE,
      "Tree survey",
      null,
      MAPPED_BY,
      SURVEY_COMPANY,
      BASE_MAP,
      1,
      "Urban",
      "Urban",
    );
    produced++;
  }

  registerLayer(db, "Urban Trees", "POINT", produced > 0 ? allEnvelope : null);
}

// ---------------------------------------------------------------------------
// --bad fixture — intentionally invalid GeoPackage exercising validator errors
// ---------------------------------------------------------------------------

/**
 * Layout for the --bad fixture. All distances in BNG metres. Each local is
 * named so the bad-fixture geometry has no bare numeric literals.
 */
function buildBadFixtureGeometry(cx, cy) {
  const REDLINE_HALF = 200;
  const PARCEL_HALF = 50;
  const VALID_PARCEL_OFFSET_X = -100;
  const VALID_PARCEL_OFFSET_Y = -100;
  const OVERLAP_A_OFFSET_X = 80;
  const OVERLAP_A_OFFSET_Y = -100;
  const OVERLAP_B_OFFSET_X = 130;
  const OVERLAP_B_OFFSET_Y = -80;
  const BOWTIE_PARCEL_HALF = 30;
  const BOWTIE_PARCEL_OFFSET_Y = 60;
  const OUTSIDE_PARCEL_OFFSET = 450;
  const HEDGEROW_INSIDE_OFFSET = 100;
  const HEDGEROW_OUTSIDE_OFFSET = 600;
  const TREE_INSIDE_OFFSET_Y = -80;
  const TREE_OUTSIDE_OFFSET = 700;

  const square = (offsetX, offsetY) =>
    rectRing(
      cx + offsetX - PARCEL_HALF,
      cy + offsetY - PARCEL_HALF,
      cx + offsetX + PARCEL_HALF,
      cy + offsetY + PARCEL_HALF,
    );

  return {
    redline: bowtieRing(cx, cy, REDLINE_HALF),
    parcels: [
      square(VALID_PARCEL_OFFSET_X, VALID_PARCEL_OFFSET_Y), // valid
      square(OVERLAP_A_OFFSET_X, OVERLAP_A_OFFSET_Y), // overlaps next
      square(OVERLAP_B_OFFSET_X, OVERLAP_B_OFFSET_Y), // overlaps prev
      bowtieRing(cx, cy + BOWTIE_PARCEL_OFFSET_Y, BOWTIE_PARCEL_HALF),
      square(OUTSIDE_PARCEL_OFFSET, OUTSIDE_PARCEL_OFFSET), // outside redline
    ],
    hedgerow: [
      [cx - HEDGEROW_INSIDE_OFFSET, cy + HEDGEROW_INSIDE_OFFSET],
      [cx + HEDGEROW_OUTSIDE_OFFSET, cy + HEDGEROW_OUTSIDE_OFFSET],
    ],
    trees: [
      [cx, cy + TREE_INSIDE_OFFSET_Y],
      [cx + TREE_OUTSIDE_OFFSET, cy + TREE_OUTSIDE_OFFSET],
    ],
  };
}

function logBadFixtureBanner(cx, cy, outPath) {
  header(`Generating BAD BNG test GeoPackage`, "cyan");
  info(
    `  ⚠ Bad mode: deliberately invalid geometry to exercise validation checks`,
  );
  info(`  Expected validation errors:`);
  info(`    REDLINE_SELF_INTERSECTING       (bowtie redline polygon)`);
  info(`    AREA_PARCELS_SELF_INTERSECTING  (one bowtie habitat parcel)`);
  info(`    PARCEL_OVERLAPS                 (two habitat parcels overlap)`);
  info(`    AREA_PARCELS_OUTSIDE_REDLINE    (parcel placed outside redline)`);
  info(`    HEDGEROWS_OUTSIDE_REDLINE       (hedgerow runs outside redline)`);
  info(`    TREES_OUTSIDE_REDLINE           (tree placed outside redline)`);
  info(`    AREA_SUM_MISMATCH               (parcels do not tile redline)`);
  info(`  centre: ${cx},${cy} (BNG)`);
  info(`  → ${outPath}`);
}

function insertBadRedline(db, ring) {
  db.prepare(
    `INSERT INTO "Red Line Boundary" (geometry, "Area", "Site Name") VALUES (?, ?, ?)`,
  ).run(
    gpkgPolygon(SRS_ID, ring),
    Math.round(polygonArea(ring)),
    `${SITE_NAME} (BAD)`,
  );
  registerLayer(db, "Red Line Boundary", "POLYGON", envelopeFromCoords(ring));
}

function insertBadHabitats(db, parcels) {
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
    ) VALUES (${Array.from({ length: HABITATS_INSERT_COLUMNS }, () => "?").join(", ")})
  `);
  const env = [Infinity, -Infinity, Infinity, -Infinity];
  parcels.forEach((ring, i) => {
    expandEnvelope(env, envelopeFromCoords(ring));
    const baseline = HABITATS[0];
    stmt.run(
      gpkgPolygon(SRS_ID, ring),
      `H${String(i + 1).padStart(FEATURE_REF_PAD, FEATURE_REF_PAD_CHAR)}`,
      baseline.broad,
      baseline.type,
      Math.round(Math.abs(polygonArea(ring))),
      baseline.validConditions[0],
      STRATEGIC_SIGNIFICANCE[0],
      "Retained",
      baseline.broad,
      baseline.type,
      baseline.validConditions[0],
      STRATEGIC_SIGNIFICANCE[0],
      "0",
      "0",
      SPATIAL_RISK_HABITAT[0],
      "On-site",
      `${SITE_NAME} (BAD)`,
      SURVEY_DATE,
      BAD_FIXTURE_SURVEY_DETAILS,
      null,
      MAPPED_BY,
      SURVEY_COMPANY,
      BASE_MAP,
      baseline.distinctiveness,
      baseline.distinctiveness,
    );
  });
  registerLayer(db, "Habitats", "POLYGON", env);
}

function insertBadHedgerow(db, coords) {
  db.prepare(
    `
    INSERT INTO "Hedgerows" (
      geometry, "Parcel Ref", "Baseline Hedge Type", "Baseline Condition",
      "Baseline Strategic Significance", "Retention Category",
      "Proposed Hedge Type", "Proposed Condition", "Proposed Strategic Significance",
      "Length", "Habitat created in advance/years",
      "Delay in starting habitat creation/years", "Spatial risk category",
      "Location", "Site Name", "Survey Date", "Survey Details", "Comments",
      "Mapped by", "Company", "Base Map",
      "Baseline Distinctiveness", "Proposed Distinctiveness"
    ) VALUES (${Array.from({ length: HEDGEROWS_INSERT_COLUMNS }, () => "?").join(", ")})
  `,
  ).run(
    gpkgLineString(SRS_ID, coords),
    "HG001",
    HEDGE_TYPES[0],
    HEDGE_CONDITIONS[0],
    STRATEGIC_SIGNIFICANCE[0],
    "Retained",
    HEDGE_TYPES[0],
    HEDGE_CONDITIONS[0],
    STRATEGIC_SIGNIFICANCE[0],
    Math.round(linestringLength(coords)),
    "0",
    "0",
    SPATIAL_RISK_HABITAT[0],
    "On-site",
    `${SITE_NAME} (BAD)`,
    SURVEY_DATE,
    BAD_FIXTURE_SURVEY_DETAILS,
    null,
    MAPPED_BY,
    SURVEY_COMPANY,
    BASE_MAP,
    DISTINCTIVENESS[0],
    DISTINCTIVENESS[0],
  );
  registerLayer(db, "Hedgerows", "LINESTRING", envelopeFromCoords(coords));
}

function insertBadTrees(db, points) {
  const stmt = db.prepare(`
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
    ) VALUES (${Array.from({ length: URBAN_TREES_INSERT_COLUMNS }, () => "?").join(", ")})
  `);
  const env = [Infinity, -Infinity, Infinity, -Infinity];
  points.forEach(([x, y], i) => {
    expandEnvelope(env, [x, x, y, y]);
    stmt.run(
      gpkgPoint(SRS_ID, x, y),
      `T${String(i + 1).padStart(FEATURE_REF_PAD, FEATURE_REF_PAD_CHAR)}`,
      "Medium",
      CONDITIONS[0],
      STRATEGIC_SIGNIFICANCE[0],
      TREE_TYPE_STREET,
      "Retained",
      "Retained",
      "Medium",
      CONDITIONS[0],
      STRATEGIC_SIGNIFICANCE[0],
      TREE_TYPE_STREET,
      "On-site",
      "0",
      "0",
      SPATIAL_RISK_HABITAT[0],
      `${SITE_NAME} (BAD)`,
      SURVEY_DATE,
      BAD_FIXTURE_SURVEY_DETAILS,
      null,
      MAPPED_BY,
      SURVEY_COMPANY,
      BASE_MAP,
      1,
      "Urban",
      "Urban",
    );
  });
  registerLayer(db, "Urban Trees", "POINT", env);
}

function reportContents(outPath) {
  const verify = new Database(outPath, { readonly: true });
  const layers = verify
    .prepare(
      "SELECT table_name FROM gpkg_contents WHERE data_type = 'features'",
    )
    .all();
  for (const layer of layers) {
    const count = verify
      .prepare(`SELECT COUNT(*) as n FROM "${layer.table_name}"`)
      .get();
    info(`  ${layer.table_name}: ${count.n} feature(s)`);
  }
  verify.close();
}

// ---------------------------------------------------------------------------
// Top-level entry points
// ---------------------------------------------------------------------------

function generateOneBad(outPath, centre) {
  const [cx, cy] = centre;
  logBadFixtureBanner(cx, cy, outPath);

  const db = new Database(outPath);
  initGeoPackage(db);
  createAllTables(db);

  const fixture = buildBadFixtureGeometry(cx, cy);
  insertBadRedline(db, fixture.redline);
  insertBadHabitats(db, fixture.parcels);
  insertBadHedgerow(db, fixture.hedgerow);
  insertBadTrees(db, fixture.trees);

  createLayerStyles(db);
  db.close();

  reportContents(outPath);
  console.log(color("green", `✔ Done (bad fixture). ${outPath}`));
}

/**
 * Generate one synthetic GeoPackage (default mode). Pass `bad=true` to emit
 * the intentionally-invalid fixture instead.
 */
export function generateOne(outPath, bad, numParcels, centre) {
  if (bad) {
    generateOneBad(outPath, centre);
    return;
  }

  const numHedgerows = Math.max(3, Math.floor(numParcels / 3));
  const numRivers = Math.max(1, Math.floor(numParcels / 15));
  const numTrees = Math.max(5, Math.floor(numParcels / 2));

  header(`Generating BNG test GeoPackage`, "cyan");
  info(`  ${SITE_NAME}`);
  info(
    `  ${numParcels} habitat parcels, ${numHedgerows} hedgerows, ${numRivers} rivers, ${numTrees} urban trees`,
  );
  info(`  centre: ${centre[0]},${centre[1]} (BNG)`);
  info(`  → ${outPath}`);

  const [cx, cy] = centre;
  const radius = 400;

  const db = new Database(outPath);
  initGeoPackage(db);
  createAllTables(db);

  const ring = generateRedLineBoundary(db, cx, cy, radius);
  generateHabitats(db, ring, numParcels);
  generateHedgerows(db, ring, numHedgerows);
  generateRivers(db, ring, numRivers);
  generateUrbanTrees(db, ring, numTrees);
  createLayerStyles(db);

  db.close();

  reportContents(outPath);
  console.log(color("green", `✔ Done. ${outPath}`));
}
