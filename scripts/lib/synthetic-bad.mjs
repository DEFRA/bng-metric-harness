/**
 * --bad fixture: intentionally invalid GeoPackage exercising validator errors.
 * Every flaw maps to a specific error code so the dropout page can render
 * every category.
 */

import Database from "better-sqlite3";
import { color, header, info } from "../_lib.mjs";
import {
  HABITATS_INSERT_COLUMNS,
  HEDGEROWS_INSERT_COLUMNS,
  SRS_ID,
  URBAN_TREES_INSERT_COLUMNS,
  createAllTables,
  createLayerStyles,
  gpkgLineString,
  gpkgPoint,
  gpkgPolygon,
  initGeoPackage,
  placeholders,
  registerLayer,
} from "./gpkg-core.mjs";
import {
  bowtieRing,
  envelopeFromCoords,
  expandEnvelope,
  linestringLength,
  polygonArea,
  rectRing,
} from "./geometry.mjs";
import {
  FEATURE_REF_PAD,
  FEATURE_REF_PAD_CHAR,
} from "./workbook-rows.mjs";
import {
  BAD_FIXTURE_SURVEY_DETAILS,
  BASE_MAP,
  CONDITIONS,
  DISTINCTIVENESS,
  HABITATS,
  HEDGE_CONDITIONS,
  HEDGE_TYPES,
  MAPPED_BY,
  SITE_NAME,
  SPATIAL_RISK_HABITAT,
  STRATEGIC_SIGNIFICANCE,
  SURVEY_COMPANY,
  SURVEY_DATE,
  TREE_TYPE_STREET,
} from "./synthetic-constants.mjs";

// ---------------------------------------------------------------------------
// Bad-fixture geometry tunables (BNG metres). Named so the fixture has no
// bare numeric literals.
// ---------------------------------------------------------------------------

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
const TREE_COUNT = 1;
const LOCATION_ON_SITE = "On-site";
const TREE_SIZE_DEFAULT = "Medium";
const ZERO_YEARS = "0";

function buildBadFixtureGeometry(cx, cy) {
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
      square(VALID_PARCEL_OFFSET_X, VALID_PARCEL_OFFSET_Y),
      square(OVERLAP_A_OFFSET_X, OVERLAP_A_OFFSET_Y),
      square(OVERLAP_B_OFFSET_X, OVERLAP_B_OFFSET_Y),
      bowtieRing(cx, cy + BOWTIE_PARCEL_OFFSET_Y, BOWTIE_PARCEL_HALF),
      square(OUTSIDE_PARCEL_OFFSET, OUTSIDE_PARCEL_OFFSET),
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
  info(`  ⚠ Bad mode: deliberately invalid geometry to exercise validation checks`);
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

function badRef(prefix, i) {
  return `${prefix}${String(i + 1).padStart(FEATURE_REF_PAD, FEATURE_REF_PAD_CHAR)}`;
}

function insertBadRedline(db, ring) {
  db.prepare(`INSERT INTO "Red Line Boundary" (geometry, "Area", "Site Name") VALUES (?, ?, ?)`)
    .run(gpkgPolygon(SRS_ID, ring), Math.round(polygonArea(ring)), `${SITE_NAME} (BAD)`);
  registerLayer(db, "Red Line Boundary", "POLYGON", envelopeFromCoords(ring));
}

const BAD_HABITAT_SQL = `
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
`;

function insertBadHabitats(db, parcels) {
  const stmt = db.prepare(BAD_HABITAT_SQL);
  const env = [Infinity, -Infinity, Infinity, -Infinity];
  parcels.forEach((ring, i) => {
    expandEnvelope(env, envelopeFromCoords(ring));
    const baseline = HABITATS[0];
    stmt.run(
      gpkgPolygon(SRS_ID, ring),
      badRef("H", i),
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
      ZERO_YEARS,
      ZERO_YEARS,
      SPATIAL_RISK_HABITAT[0],
      LOCATION_ON_SITE,
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

const BAD_HEDGEROW_SQL = `
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

function insertBadHedgerow(db, coords) {
  db.prepare(BAD_HEDGEROW_SQL).run(
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
    ZERO_YEARS,
    ZERO_YEARS,
    SPATIAL_RISK_HABITAT[0],
    LOCATION_ON_SITE,
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

const BAD_TREES_SQL = `
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

function insertBadTrees(db, points) {
  const stmt = db.prepare(BAD_TREES_SQL);
  const env = [Infinity, -Infinity, Infinity, -Infinity];
  points.forEach(([x, y], i) => {
    expandEnvelope(env, [x, x, y, y]);
    stmt.run(
      gpkgPoint(SRS_ID, x, y),
      badRef("T", i),
      TREE_SIZE_DEFAULT,
      CONDITIONS[0],
      STRATEGIC_SIGNIFICANCE[0],
      TREE_TYPE_STREET,
      "Retained",
      "Retained",
      TREE_SIZE_DEFAULT,
      CONDITIONS[0],
      STRATEGIC_SIGNIFICANCE[0],
      TREE_TYPE_STREET,
      LOCATION_ON_SITE,
      ZERO_YEARS,
      ZERO_YEARS,
      SPATIAL_RISK_HABITAT[0],
      `${SITE_NAME} (BAD)`,
      SURVEY_DATE,
      BAD_FIXTURE_SURVEY_DETAILS,
      null,
      MAPPED_BY,
      SURVEY_COMPANY,
      BASE_MAP,
      TREE_COUNT,
      "Urban",
      "Urban",
    );
  });
  registerLayer(db, "Urban Trees", "POINT", env);
}

function reportContents(outPath) {
  const verify = new Database(outPath, { readonly: true });
  const layers = verify
    .prepare("SELECT table_name FROM gpkg_contents WHERE data_type = 'features'")
    .all();
  for (const layer of layers) {
    const count = verify.prepare(`SELECT COUNT(*) as n FROM "${layer.table_name}"`).get();
    info(`  ${layer.table_name}: ${count.n} feature(s)`);
  }
  verify.close();
}

export function generateOneBad(outPath, centre) {
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
