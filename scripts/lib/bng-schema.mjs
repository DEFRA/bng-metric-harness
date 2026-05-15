/**
 * BNG metric domain layer atop the generic GeoPackage I/O package.
 *
 * Owns the BNG-specific bits that the generic package can't carry:
 *   - the BNG (OSGB 1936) SRS definition
 *   - the 5 feature-table DDLs that match the Natural England QGIS template
 *   - the QGIS layer styles chosen for those 5 layers
 *
 * Re-exports the small subset of `#gpkg-io` that the generators use, with
 * the BNG SRS pre-bound on `initGeoPackage` and `registerLayer` so callers
 * don't need to repeat the SRS constant at every call site.
 */

import {
  createLayerStylesTable,
  initGeoPackage as initGeoPackageGeneric,
  insertLayerStyle,
  lineQml,
  lineSld,
  openGeoPackage as openGeoPackageGeneric,
  openGeoPackageReadonly,
  pointQml,
  pointSld,
  polygonQml,
  polygonSld,
  registerLayer as registerLayerGeneric,
} from "#gpkg-io";

export { openGeoPackageReadonly };

// SRS — British National Grid (OSGB 1936).
export const SRS_ID = 27700;

const BNG_SRS_DEFINITION = `PROJCS["OSGB 1936 / British National Grid",GEOGCS["OSGB 1936",DATUM["OSGB_1936",SPHEROID["Airy 1830",6377563.396,299.3249646]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",49],PARAMETER["central_meridian",-2],PARAMETER["scale_factor",0.9996012717],PARAMETER["false_easting",400000],PARAMETER["false_northing",-100000],UNIT["metre",1]]`;

const BNG_SRS = {
  srsId: SRS_ID,
  name: "OSGB 1936 / British National Grid",
  organization: "EPSG",
  organizationCoordsysId: SRS_ID,
  definition: BNG_SRS_DEFINITION,
  description: "British National Grid",
};

// Column counts — single source of truth, used by INSERT-statement builders
// across the writer modules.
export const HABITATS_INSERT_COLUMNS = 25;
export const HEDGEROWS_INSERT_COLUMNS = 23;
export const RIVERS_INSERT_COLUMNS = 28;
export const URBAN_TREES_INSERT_COLUMNS = 26;

/**
 * Initialise an existing better-sqlite3 handle as a BNG-flavoured
 * GeoPackage: standard gpkg_* tables, mandatory OGC SRSes, and the BNG
 * SRS pre-inserted.
 *
 * Prefer `openGeoPackage(filename)` below for the common write path —
 * this is for cases where the caller already holds a db handle.
 */
export function initGeoPackage(db) {
  initGeoPackageGeneric(db, [BNG_SRS]);
}

/**
 * Open (or create) `filename` as a BNG-flavoured GeoPackage. Returns the
 * better-sqlite3 db handle; the caller is responsible for `db.close()`.
 */
export function openGeoPackage(filename) {
  return openGeoPackageGeneric(filename, { srs: [BNG_SRS] });
}

/**
 * Register a feature layer in the GeoPackage metadata, tagging it with the
 * BNG SRS.
 */
export function registerLayer(db, tableName, geomType, envelope) {
  registerLayerGeneric(db, tableName, geomType, envelope, SRS_ID);
}

/**
 * Create the five feature tables that match the NE QGIS template exactly.
 * Used identically for both baseline and post-intervention files — only the
 * row content differs.
 */
export function createAllTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS "Red Line Boundary" (
      fid INTEGER PRIMARY KEY AUTOINCREMENT, geometry POLYGON,
      "Area" REAL, "Site Name" TEXT(99)
    );

    CREATE TABLE IF NOT EXISTS "Habitats" (
      fid INTEGER PRIMARY KEY AUTOINCREMENT, geometry POLYGON,
      "Parcel Ref" TEXT(99), "Baseline Broad Habitat Type" TEXT(99),
      "Baseline Habitat Type" TEXT(99), "Area" MEDIUMINT,
      "Baseline Condition" TEXT(99), "Baseline Strategic Significance" TEXT(99),
      "Retention Category" TEXT(99), "Proposed Broad Habitat Type" TEXT(99),
      "Proposed Habitat Type" TEXT(99), "Proposed Condition" TEXT(99),
      "Proposed Strategic Significance" TEXT(99),
      "Habitat created in advance/years" TEXT(99),
      "Delay in starting habitat creation/years" TEXT(99),
      "Spatial risk category" TEXT(99), "Location" TEXT(99),
      "Site Name" TEXT(999), "Survey Date" DATE, "Survey Details" TEXT(999),
      "Comment" TEXT(999), "Mapped by" TEXT(999), "Company" TEXT(999),
      "Base Map" TEXT(999), "Baseline Distinctiveness" TEXT(999),
      "Proposed Distinctiveness" TEXT(999)
    );

    CREATE TABLE IF NOT EXISTS "Hedgerows" (
      fid INTEGER PRIMARY KEY AUTOINCREMENT, geometry LINESTRING,
      "Parcel Ref" TEXT(99), "Baseline Hedge Type" TEXT(99),
      "Baseline Condition" TEXT(99), "Baseline Strategic Significance" TEXT(99),
      "Retention Category" TEXT(99), "Proposed Hedge Type" TEXT(99),
      "Proposed Condition" TEXT(99), "Proposed Strategic Significance" TEXT(99),
      "Length" MEDIUMINT, "Habitat created in advance/years" TEXT(99),
      "Delay in starting habitat creation/years" TEXT(99),
      "Spatial risk category" TEXT(99), "Location" TEXT(99),
      "Site Name" TEXT(999), "Survey Date" DATE, "Survey Details" TEXT(999),
      "Comments" TEXT(999), "Mapped by" TEXT(999), "Company" TEXT(999),
      "Base Map" TEXT(999), "Baseline Distinctiveness" TEXT(999),
      "Proposed Distinctiveness" TEXT(999)
    );

    CREATE TABLE IF NOT EXISTS "Rivers" (
      fid INTEGER PRIMARY KEY AUTOINCREMENT, geometry LINESTRING,
      "Parcel Ref" TEXT(99), "Baseline River Type" TEXT(99),
      "Baseline Condition" TEXT(99), "Baseline Strategic Significance" TEXT(99),
      "Baseline Encroachment into Watercourse" TEXT(99),
      "Baseline Encroachment into riparian zone" TEXT(99),
      "Retention Category" TEXT(99), "Proposed River Type" TEXT(99),
      "Proposed Condition" TEXT(99), "Proposed Strategic Significance" TEXT(99),
      "Length" MEDIUMINT, "Habitat created in advance/years" TEXT(99),
      "Delay in starting habitat creation/years" TEXT(99),
      "Spatial risk category" TEXT(99), "Location" TEXT(99),
      "Proposed Encroachment into Watercourse" TEXT(99),
      "Proposed Encroachment into riparian zone" TEXT(99),
      "Site Name" TEXT(999), "Survey Date" DATE, "Survey Details" TEXT(999),
      "Comments" TEXT(999), "Mapped by" TEXT(999), "Company" TEXT(999),
      "Base Map" TEXT(999), "Enhancement Type" TEXT(999),
      "Baseline Distinctiveness" TEXT(999), "Proposed Distinctiveness" TEXT(999)
    );

    CREATE TABLE IF NOT EXISTS "Urban Trees" (
      fid INTEGER PRIMARY KEY AUTOINCREMENT, geometry POINT,
      "Tree Ref" TEXT(99), "Baseline Tree Size" TEXT(99),
      "Baseline Condition" TEXT(99), "Baseline Strategic Significance" TEXT(99),
      "Baseline Tree Type" TEXT(99), "Retention Category" TEXT(99),
      "Category" TEXT(99), "Proposed Tree Size" TEXT(99),
      "Proposed Condition" TEXT(99), "Proposed Strategic Significance" TEXT(99),
      "Proposed Tree Type" TEXT(99), "Location" TEXT(99),
      "Habitat Created/Enhanced in advance/years" TEXT(99),
      "Delay in starting habitat creation/enhancement in years" TEXT(99),
      "Spatial risk category" TEXT(99), "Site Name" TEXT(999),
      "Survey Date" DATE, "Survey Details" TEXT(999), "Comment" TEXT(999),
      "Mapped by" TEXT(999), "Company" TEXT(999), "Base Map" TEXT(999),
      "Count" MEDIUMINT, "Baseline Rural or Urban Tree" TEXT(999),
      "Proposed Rural or Urban Tree" TEXT(999)
    );
  `);
}

// ---------------------------------------------------------------------------
// Style choices for the 5 BNG layers. The QGIS-friendly QML form is stored
// alongside an SLD fallback that other GIS tools can render.
// ---------------------------------------------------------------------------

const REDLINE_FILL_OPACITY = 0.2; // see-through, so habitats remain visible
const REDLINE_STROKE_WIDTH = 2.5;
const HEDGEROW_STROKE_WIDTH = 3;
const RIVER_STROKE_WIDTH = 2.5;
const URBAN_TREE_SLD_SIZE = 8;
const URBAN_TREE_QML_SIZE = 4;

const BNG_LAYER_STYLES = [
  {
    table: "Red Line Boundary",
    sld: polygonSld("Red Line Boundary", "#FF0000", "#CC0000", REDLINE_FILL_OPACITY, REDLINE_STROKE_WIDTH),
    qml: polygonQml("#FF0000", "#CC0000", REDLINE_FILL_OPACITY, REDLINE_STROKE_WIDTH),
  },
  {
    table: "Habitats",
    sld: polygonSld("Habitats", "#FFB74D", "#F57C00"),
    qml: polygonQml("#FFB74D", "#F57C00"),
  },
  {
    table: "Hedgerows",
    sld: lineSld("Hedgerows", "#2E7D32", HEDGEROW_STROKE_WIDTH),
    qml: lineQml("#2E7D32", HEDGEROW_STROKE_WIDTH),
  },
  {
    table: "Rivers",
    sld: lineSld("Rivers", "#1565C0", RIVER_STROKE_WIDTH),
    qml: lineQml("#1565C0", RIVER_STROKE_WIDTH),
  },
  {
    table: "Urban Trees",
    sld: pointSld("Urban Trees", "#8D6E63", "#4E342E", URBAN_TREE_SLD_SIZE),
    qml: pointQml("#8D6E63", "#4E342E", URBAN_TREE_QML_SIZE),
  },
];

/** Create the QGIS `layer_styles` table and insert the BNG default styles. */
export function createLayerStyles(db) {
  createLayerStylesTable(db);
  for (const style of BNG_LAYER_STYLES) {
    insertLayerStyle(db, style.table, style.qml, style.sld);
  }
}
