/**
 * --bad fixture builder: composes a deliberately invalid GeoPackage from a
 * list of named flaws (see ./flaws.mjs). Each flaw mutates a small base state
 * (one valid redline, no other content); `generateOneBad` then materialises
 * the state into the file.
 */

import Database from "better-sqlite3";
import { color, header, info } from "../../_lib.mjs";
import { gpkgLineString, gpkgPoint, gpkgPolygon, placeholders } from "#gpkg-io";
import {
  HABITATS_INSERT_COLUMNS,
  HEDGEROWS_INSERT_COLUMNS,
  SRS_ID,
  URBAN_TREES_INSERT_COLUMNS,
  createAllTables,
  createLayerStyles,
  openGeoPackage,
  registerLayer,
} from "../bng-schema.mjs";
import {
  envelopeFromCoords,
  expandEnvelope,
  linestringLength,
  polygonArea,
} from "../geometry.mjs";
import {
  FEATURE_REF_PAD,
  FEATURE_REF_PAD_CHAR,
} from "../workbook/workbook-rows.mjs";
import {
  BAD_FIXTURE_SURVEY_DETAILS,
  BAD_REDLINE_HALF,
  BASE_MAP,
  CONDITIONS,
  DISTINCTIVENESS,
  ENCROACHMENT_RIPARIAN,
  ENCROACHMENT_WATERCOURSE,
  FLAW_BANNER_ERRCODE_WIDTH,
  HABITATS,
  HEDGE_CONDITIONS,
  HEDGE_TYPES,
  MAPPED_BY,
  RIVERS_COLUMN_COUNT,
  RIVER_TYPES,
  SITE_NAME,
  SPATIAL_RISK_HABITAT,
  SPATIAL_RISK_RIVER,
  STRATEGIC_SIGNIFICANCE,
  SURVEY_COMPANY,
  SURVEY_DATE,
  TREE_TYPE_STREET,
} from "./synthetic-constants.mjs";
import { FLAWS, badSquareRing } from "./flaws.mjs";

const LOCATION_ON_SITE = "On-site";
const TREE_SIZE_DEFAULT = "Medium";
const ZERO_YEARS = "0";
const TREE_COUNT_DEFAULT = 1;

function badRef(prefix, i) {
  return `${prefix}${String(i + 1).padStart(FEATURE_REF_PAD, FEATURE_REF_PAD_CHAR)}`;
}

function createBadFixtureState(centre) {
  const [cx, cy] = centre;
  return {
    cx,
    cy,
    centre,
    redline: badSquareRing(cx, cy, BAD_REDLINE_HALF),
    parcels: [],
    hedgerows: [],
    rivers: [],
    trees: [],
    iggis: [],
  };
}

function logBadFixtureBanner(state, outPath, flawNames) {
  header(`Generating BAD BNG test GeoPackage`, "cyan");
  info(`  ⚠ Bad mode: deliberately invalid geometry`);
  info(`  Applied flaws (${flawNames.length}):`);
  for (const name of flawNames) {
    const flaw = FLAWS[name];
    info(`    ${flaw.errorCode.padEnd(FLAW_BANNER_ERRCODE_WIDTH)} ${name} — ${flaw.description}`);
  }
  info(`  centre: ${state.cx},${state.cy} (BNG)`);
  info(`  → ${outPath}`);
}

function insertBadRedline(db, ring) {
  db.prepare(`INSERT INTO "Red Line Boundary" (geometry, "Area", "Site Name") VALUES (?, ?, ?)`)
    .run(gpkgPolygon(SRS_ID, ring), Math.round(Math.abs(polygonArea(ring))), `${SITE_NAME} (BAD)`);
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

function insertBadHedgerows(db, hedgerows) {
  const stmt = db.prepare(BAD_HEDGEROW_SQL);
  const env = [Infinity, -Infinity, Infinity, -Infinity];
  hedgerows.forEach((coords, i) => {
    expandEnvelope(env, envelopeFromCoords(coords));
    stmt.run(
      gpkgLineString(SRS_ID, coords),
      badRef("HG", i),
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
  });
  registerLayer(db, "Hedgerows", "LINESTRING", env);
}

const BAD_RIVERS_SQL = `
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
  ) VALUES (${placeholders(RIVERS_COLUMN_COUNT)})
`;

function insertBadRivers(db, rivers) {
  const stmt = db.prepare(BAD_RIVERS_SQL);
  const env = [Infinity, -Infinity, Infinity, -Infinity];
  rivers.forEach((coords, i) => {
    expandEnvelope(env, envelopeFromCoords(coords));
    stmt.run(
      gpkgLineString(SRS_ID, coords),
      badRef("R", i),
      RIVER_TYPES[0],
      CONDITIONS[0],
      STRATEGIC_SIGNIFICANCE[0],
      ENCROACHMENT_WATERCOURSE[0],
      ENCROACHMENT_RIPARIAN[0],
      "Retained",
      RIVER_TYPES[0],
      CONDITIONS[0],
      STRATEGIC_SIGNIFICANCE[0],
      Math.round(linestringLength(coords)),
      ZERO_YEARS,
      ZERO_YEARS,
      SPATIAL_RISK_RIVER[0],
      LOCATION_ON_SITE,
      ENCROACHMENT_WATERCOURSE[0],
      ENCROACHMENT_RIPARIAN[0],
      `${SITE_NAME} (BAD)`,
      SURVEY_DATE,
      BAD_FIXTURE_SURVEY_DETAILS,
      null,
      MAPPED_BY,
      SURVEY_COMPANY,
      BASE_MAP,
      null,
      DISTINCTIVENESS[0],
      DISTINCTIVENESS[0],
    );
  });
  registerLayer(db, "Rivers", "LINESTRING", env);
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
      TREE_COUNT_DEFAULT,
      "Urban",
      "Urban",
    );
  });
  registerLayer(db, "Urban Trees", "POINT", env);
}

function createIggisTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS "iggis" (
      fid INTEGER PRIMARY KEY AUTOINCREMENT, geometry POLYGON,
      "IGGI Ref" TEXT(99), "Area" MEDIUMINT, "Site Name" TEXT(999)
    );
  `);
}

function insertBadIggis(db, iggis) {
  const stmt = db.prepare(
    `INSERT INTO "iggis" (geometry, "IGGI Ref", "Area", "Site Name") VALUES (?, ?, ?, ?)`,
  );
  const env = [Infinity, -Infinity, Infinity, -Infinity];
  iggis.forEach((ring, i) => {
    expandEnvelope(env, envelopeFromCoords(ring));
    stmt.run(
      gpkgPolygon(SRS_ID, ring),
      badRef("I", i),
      Math.round(Math.abs(polygonArea(ring))),
      `${SITE_NAME} (BAD)`,
    );
  });
  registerLayer(db, "iggis", "POLYGON", env);
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

export function generateOneBad(outPath, centre, flawNames) {
  const state = createBadFixtureState(centre);
  for (const name of flawNames) {
    FLAWS[name].apply(state);
  }
  logBadFixtureBanner(state, outPath, flawNames);

  const db = openGeoPackage(outPath);
  createAllTables(db);
  if (state.iggis.length) {
    createIggisTable(db);
  }

  insertBadRedline(db, state.redline);
  if (state.parcels.length) {
    insertBadHabitats(db, state.parcels);
  }
  if (state.hedgerows.length) {
    insertBadHedgerows(db, state.hedgerows);
  }
  if (state.rivers.length) {
    insertBadRivers(db, state.rivers);
  }
  if (state.trees.length) {
    insertBadTrees(db, state.trees);
  }
  if (state.iggis.length) {
    insertBadIggis(db, state.iggis);
  }

  createLayerStyles(db);
  db.close();

  reportContents(outPath);
  console.log(color("green", `✔ Done (bad fixture). ${outPath}`));
}
