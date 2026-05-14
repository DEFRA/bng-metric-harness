/**
 * GeoPackage protocol layer: WKB encoders, GeoPackage Binary wrapper,
 * metadata table init, feature-layer registration, the NE QGIS template
 * DDL, and SLD/QML default styles.
 *
 * No domain logic. Anything that knows what a "habitat" is lives elsewhere.
 */

import { envelopeFromCoords } from "./geometry.mjs";

// ---------------------------------------------------------------------------
// SRS constants
// ---------------------------------------------------------------------------

export const SRS_ID = 27700;

const SRS_27700_DEF = `PROJCS["OSGB 1936 / British National Grid",GEOGCS["OSGB 1936",DATUM["OSGB_1936",SPHEROID["Airy 1830",6377563.396,299.3249646]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",49],PARAMETER["central_meridian",-2],PARAMETER["scale_factor",0.9996012717],PARAMETER["false_easting",400000],PARAMETER["false_northing",-100000],UNIT["metre",1]]`;

// ---------------------------------------------------------------------------
// Column counts — single source of truth, used by INSERT-statement builders
// across the writer modules.
// ---------------------------------------------------------------------------

export const HABITATS_INSERT_COLUMNS = 25;
export const HEDGEROWS_INSERT_COLUMNS = 23;
export const RIVERS_INSERT_COLUMNS = 28;
export const URBAN_TREES_INSERT_COLUMNS = 26;

/**
 * Build a `(?, ?, ?, …)` placeholder fragment with `n` slots. Avoids the
 * `Array(n).fill(...)` constructor pattern in favour of Array.from per
 * SonarCloud's S1528 / S7723 rules.
 */
export function placeholders(n) {
  return Array.from({ length: n }, () => "?").join(", ");
}

/** Allocate a `length`-sized array pre-filled with `value` (default null). */
export function filledArray(length, value = null) {
  return Array.from({ length }, () => value);
}

// WKB geometry type tags (OGC Simple Features).
const WKB_TYPE_POINT = 1;
const WKB_TYPE_LINESTRING = 2;
const WKB_TYPE_POLYGON = 3;

// Envelope array layout: [minX, maxX, minY, maxY].
const ENV_MIN_X = 0;
const ENV_MAX_X = 1;
const ENV_MIN_Y = 2;
const ENV_MAX_Y = 3;

// ---------------------------------------------------------------------------
// WKB encoding (little-endian)
// ---------------------------------------------------------------------------

function writeDouble(buf, offset, val) {
  buf.writeDoubleLE(val, offset);
  return offset + 8;
}

function writeUInt32(buf, offset, val) {
  buf.writeUInt32LE(val, offset);
  return offset + 4;
}

/**
 * Encode a point as WKB (Well-Known Binary), little-endian.
 *
 * Layout: byteOrder (1) | wkbType (uint32 = 1) | x (float64) | y (float64)
 *
 * @see https://www.ogc.org/standard/sfa/
 */
export function encodeWkbPoint(x, y) {
  const buf = Buffer.alloc(1 + 4 + 16);
  let off = 0;
  buf[off] = 1;
  off += 1;
  off = writeUInt32(buf, off, WKB_TYPE_POINT);
  off = writeDouble(buf, off, x);
  writeDouble(buf, off, y);
  return buf;
}

/**
 * Encode a linestring as WKB (Well-Known Binary), little-endian.
 *
 * Layout: byteOrder (1) | wkbType (uint32 = 2) | numPoints (uint32) | points
 */
export function encodeWkbLineString(coords) {
  const buf = Buffer.alloc(1 + 4 + 4 + coords.length * 16);
  let off = 0;
  buf[off] = 1;
  off += 1;
  off = writeUInt32(buf, off, WKB_TYPE_LINESTRING);
  off = writeUInt32(buf, off, coords.length);
  for (const [x, y] of coords) {
    off = writeDouble(buf, off, x);
    off = writeDouble(buf, off, y);
  }
  return buf;
}

/**
 * Encode a polygon as WKB (Well-Known Binary), little-endian.
 *
 * The first ring is the exterior boundary; any subsequent rings are interior
 * holes (not currently used by this script).
 */
export function encodeWkbPolygon(rings) {
  let size = 1 + 4 + 4;
  for (const ring of rings) {
    size += 4 + ring.length * 16;
  }
  const buf = Buffer.alloc(size);
  let off = 0;
  buf[off] = 1;
  off += 1;
  off = writeUInt32(buf, off, WKB_TYPE_POLYGON);
  off = writeUInt32(buf, off, rings.length);
  for (const ring of rings) {
    off = writeUInt32(buf, off, ring.length);
    for (const [x, y] of ring) {
      off = writeDouble(buf, off, x);
      off = writeDouble(buf, off, y);
    }
  }
  return buf;
}

// ---------------------------------------------------------------------------
// GeoPackage Binary encoding (header + WKB)
// ---------------------------------------------------------------------------

/**
 * Wraps a WKB geometry in a GeoPackage Binary header.
 *
 * Layout: magic ("GP") | version (0) | flags | srsId (uint32) | [envelope] | wkb
 *
 * The flags byte encodes byte order (bit 0, always 1 = little-endian) and
 * envelope type (bits 1-3). When an envelope is provided, type 1 stores
 * [minX, maxX, minY, maxY] as four doubles (32 bytes).
 *
 * @see https://www.geopackage.org/spec/#gpb_format
 */
export function encodeGpkgBinary(srsId, wkb, envelope) {
  const envType = envelope ? 1 : 0;
  const flags = 0x01 | (envType << 1);
  const envSize = envelope ? 32 : 0;
  const headerSize = 2 + 1 + 1 + 4 + envSize;
  const buf = Buffer.alloc(headerSize + wkb.length);
  let off = 0;
  buf[off] = 0x47; // 'G'
  off += 1;
  buf[off] = 0x50; // 'P'
  off += 1;
  buf[off] = 0;
  off += 1;
  buf[off] = flags;
  off += 1;
  off = writeUInt32(buf, off, srsId);
  if (envelope) {
    off = writeDouble(buf, off, envelope[ENV_MIN_X]);
    off = writeDouble(buf, off, envelope[ENV_MAX_X]);
    off = writeDouble(buf, off, envelope[ENV_MIN_Y]);
    off = writeDouble(buf, off, envelope[ENV_MAX_Y]);
  }
  wkb.copy(buf, off);
  return buf;
}

export function gpkgPolygon(srsId, ring) {
  return encodeGpkgBinary(
    srsId,
    encodeWkbPolygon([ring]),
    envelopeFromCoords(ring),
  );
}

export function gpkgLineString(srsId, coords) {
  return encodeGpkgBinary(
    srsId,
    encodeWkbLineString(coords),
    envelopeFromCoords(coords),
  );
}

export function gpkgPoint(srsId, x, y) {
  return encodeGpkgBinary(srsId, encodeWkbPoint(x, y), [x, x, y, y]);
}

// ---------------------------------------------------------------------------
// Database init + layer registration + table DDL
// ---------------------------------------------------------------------------

/**
 * Initialise a SQLite database as a valid GeoPackage by setting the required
 * pragmas and creating the three mandatory metadata tables. Pre-populates
 * the SRS table with WGS 84 (4326) and British National Grid (27700).
 *
 * @see https://www.geopackage.org/spec/#_requirement-1
 */
export function initGeoPackage(db) {
  db.pragma("journal_mode = WAL");
  db.pragma("application_id = 0x47504B47");
  db.pragma("user_version = 10301");

  db.exec(`
    CREATE TABLE IF NOT EXISTS gpkg_spatial_ref_sys (
      srs_name TEXT NOT NULL, srs_id INTEGER NOT NULL PRIMARY KEY,
      organization TEXT NOT NULL, organization_coordsys_id INTEGER NOT NULL,
      definition TEXT NOT NULL, description TEXT
    );
    INSERT OR IGNORE INTO gpkg_spatial_ref_sys VALUES
      ('Undefined cartesian SRS', -1, 'NONE', -1, 'undefined', 'undefined cartesian coordinate reference system'),
      ('Undefined geographic SRS', 0, 'NONE', 0, 'undefined', 'undefined geographic coordinate reference system'),
      ('WGS 84 geodetic', 4326, 'EPSG', 4326,
        'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]',
        'longitude/latitude coordinates in decimal degrees on the WGS 84 spheroid'),
      ('OSGB 1936 / British National Grid', ${SRS_ID}, 'EPSG', ${SRS_ID},
        '${SRS_27700_DEF}', 'British National Grid');

    CREATE TABLE IF NOT EXISTS gpkg_contents (
      table_name TEXT NOT NULL PRIMARY KEY, data_type TEXT NOT NULL DEFAULT 'features',
      identifier TEXT UNIQUE, description TEXT DEFAULT '',
      last_change DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      min_x DOUBLE, min_y DOUBLE, max_x DOUBLE, max_y DOUBLE,
      srs_id INTEGER REFERENCES gpkg_spatial_ref_sys(srs_id)
    );

    CREATE TABLE IF NOT EXISTS gpkg_geometry_columns (
      table_name TEXT NOT NULL, column_name TEXT NOT NULL DEFAULT 'geometry',
      geometry_type_name TEXT NOT NULL, srs_id INTEGER NOT NULL,
      z TINYINT NOT NULL DEFAULT 0, m TINYINT NOT NULL DEFAULT 0,
      CONSTRAINT pk_geom_cols PRIMARY KEY (table_name, column_name),
      CONSTRAINT fk_gc_tn FOREIGN KEY (table_name) REFERENCES gpkg_contents(table_name)
    );
  `);
}

/**
 * Register a feature layer in the GeoPackage metadata tables.
 *
 * Inserts (or replaces) rows in `gpkg_contents` and `gpkg_geometry_columns`
 * so that GIS tools recognise the table as a spatial layer.
 *
 * @param {number[]|null} envelope - [minX, maxX, minY, maxY], or null
 */
export function registerLayer(db, tableName, geomType, envelope) {
  const [minX = null, maxX = null, minY = null, maxY = null] = envelope ?? [];

  db.prepare(
    `
    INSERT OR REPLACE INTO gpkg_contents
      (table_name, data_type, identifier, description, min_x, min_y, max_x, max_y, srs_id)
    VALUES (?, 'features', ?, '', ?, ?, ?, ?, ?)
  `,
  ).run(tableName, tableName, minX, minY, maxX, maxY, SRS_ID);

  db.prepare(
    `
    INSERT OR REPLACE INTO gpkg_geometry_columns
      (table_name, column_name, geometry_type_name, srs_id, z, m)
    VALUES (?, 'geometry', ?, ?, 0, 0)
  `,
  ).run(tableName, geomType, SRS_ID);
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
// SLD/QML styles. The layer_styles table is QGIS's auto-loading convention.
// ---------------------------------------------------------------------------

function sld(layerName, symbolizerXml) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<StyledLayerDescriptor version="1.0.0"
  xmlns="http://www.opengis.net/sld"
  xmlns:ogc="http://www.opengis.net/ogc">
  <NamedLayer>
    <Name>${layerName}</Name>
    <UserStyle>
      <Name>${layerName}</Name>
      <FeatureTypeStyle>
        <Rule>
          ${symbolizerXml}
        </Rule>
      </FeatureTypeStyle>
    </UserStyle>
  </NamedLayer>
</StyledLayerDescriptor>`;
}

function polygonSld(name, fill, stroke, fillOpacity = 0.5, strokeWidth = 1.5) {
  return sld(
    name,
    `<PolygonSymbolizer>
            <Fill>
              <CssParameter name="fill">${fill}</CssParameter>
              <CssParameter name="fill-opacity">${fillOpacity}</CssParameter>
            </Fill>
            <Stroke>
              <CssParameter name="stroke">${stroke}</CssParameter>
              <CssParameter name="stroke-width">${strokeWidth}</CssParameter>
            </Stroke>
          </PolygonSymbolizer>`,
  );
}

function lineSld(name, stroke, strokeWidth = 2) {
  return sld(
    name,
    `<LineSymbolizer>
            <Stroke>
              <CssParameter name="stroke">${stroke}</CssParameter>
              <CssParameter name="stroke-width">${strokeWidth}</CssParameter>
            </Stroke>
          </LineSymbolizer>`,
  );
}

function pointSld(name, fill, stroke, size = 8) {
  return sld(
    name,
    `<PointSymbolizer>
            <Graphic>
              <Mark>
                <WellKnownName>circle</WellKnownName>
                <Fill>
                  <CssParameter name="fill">${fill}</CssParameter>
                </Fill>
                <Stroke>
                  <CssParameter name="stroke">${stroke}</CssParameter>
                  <CssParameter name="stroke-width">1</CssParameter>
                </Stroke>
              </Mark>
              <Size>${size}</Size>
            </Graphic>
          </PointSymbolizer>`,
  );
}

const HEX_RADIX = 16;
const HEX_BYTE_LEN = 2;
const HEX_R_START = 1;
const HEX_G_START = HEX_R_START + HEX_BYTE_LEN;
const HEX_B_START = HEX_G_START + HEX_BYTE_LEN;
const HEX_END = HEX_B_START + HEX_BYTE_LEN;
const ALPHA_OPAQUE = 255;

function hexToRgba(hex, alpha = ALPHA_OPAQUE) {
  const r = Number.parseInt(hex.slice(HEX_R_START, HEX_G_START), HEX_RADIX);
  const g = Number.parseInt(hex.slice(HEX_G_START, HEX_B_START), HEX_RADIX);
  const b = Number.parseInt(hex.slice(HEX_B_START, HEX_END), HEX_RADIX);
  return `${r},${g},${b},${alpha}`;
}

function polygonQml(fill, stroke, fillOpacity = 0.5, strokeWidth = 1.5) {
  const fillAlpha = Math.round(fillOpacity * ALPHA_OPAQUE);
  return `<!DOCTYPE qgis PUBLIC 'http://mrcc.com/qgis.dtd' 'SYSTEM'>
<qgis version="3.34" styleCategories="Symbology">
  <renderer-v2 type="singleSymbol" symbollevels="0">
    <symbols>
      <symbol type="fill" name="0" alpha="1">
        <layer class="SimpleFill">
          <Option type="Map">
            <Option type="QString" name="color" value="${hexToRgba(fill, fillAlpha)}"/>
            <Option type="QString" name="outline_color" value="${hexToRgba(stroke)}"/>
            <Option type="QString" name="outline_width" value="${strokeWidth}"/>
            <Option type="QString" name="outline_width_unit" value="MM"/>
            <Option type="QString" name="style" value="solid"/>
            <Option type="QString" name="outline_style" value="solid"/>
          </Option>
        </layer>
      </symbol>
    </symbols>
  </renderer-v2>
</qgis>`;
}

function lineQml(stroke, strokeWidth = 2) {
  return `<!DOCTYPE qgis PUBLIC 'http://mrcc.com/qgis.dtd' 'SYSTEM'>
<qgis version="3.34" styleCategories="Symbology">
  <renderer-v2 type="singleSymbol" symbollevels="0">
    <symbols>
      <symbol type="line" name="0" alpha="1">
        <layer class="SimpleLine">
          <Option type="Map">
            <Option type="QString" name="line_color" value="${hexToRgba(stroke)}"/>
            <Option type="QString" name="line_width" value="${strokeWidth}"/>
            <Option type="QString" name="line_width_unit" value="MM"/>
            <Option type="QString" name="line_style" value="solid"/>
            <Option type="QString" name="capstyle" value="round"/>
            <Option type="QString" name="joinstyle" value="round"/>
          </Option>
        </layer>
      </symbol>
    </symbols>
  </renderer-v2>
</qgis>`;
}

function pointQml(fill, stroke, size = 4) {
  return `<!DOCTYPE qgis PUBLIC 'http://mrcc.com/qgis.dtd' 'SYSTEM'>
<qgis version="3.34" styleCategories="Symbology">
  <renderer-v2 type="singleSymbol" symbollevels="0">
    <symbols>
      <symbol type="marker" name="0" alpha="1">
        <layer class="SimpleMarker">
          <Option type="Map">
            <Option type="QString" name="color" value="${hexToRgba(fill)}"/>
            <Option type="QString" name="outline_color" value="${hexToRgba(stroke)}"/>
            <Option type="QString" name="outline_width" value="0.4"/>
            <Option type="QString" name="size" value="${size}"/>
            <Option type="QString" name="size_unit" value="MM"/>
            <Option type="QString" name="name" value="circle"/>
          </Option>
        </layer>
      </symbol>
    </symbols>
  </renderer-v2>
</qgis>`;
}

// Style tunables — bundled here so the LAYER_STYLES table reads as
// configuration rather than a soup of bare literals.
const REDLINE_FILL_OPACITY = 0.2; // see-through, so habitats remain visible
const REDLINE_STROKE_WIDTH = 2.5;
const HEDGEROW_STROKE_WIDTH = 3;
const RIVER_STROKE_WIDTH = 2.5;
const URBAN_TREE_SLD_SIZE = 8;
const URBAN_TREE_QML_SIZE = 4;

const LAYER_STYLES = [
  {
    table: "Red Line Boundary",
    sld: polygonSld(
      "Red Line Boundary",
      "#FF0000",
      "#CC0000",
      REDLINE_FILL_OPACITY,
      REDLINE_STROKE_WIDTH,
    ),
    qml: polygonQml(
      "#FF0000",
      "#CC0000",
      REDLINE_FILL_OPACITY,
      REDLINE_STROKE_WIDTH,
    ),
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

/**
 * Create the `layer_styles` table and insert default styles for all layers.
 * Stores both QML (for QGIS auto-loading) and SLD (for portability to other
 * GIS tools) in each row.
 */
export function createLayerStyles(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS layer_styles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      f_table_catalog TEXT DEFAULT '',
      f_table_schema TEXT DEFAULT '',
      f_table_name TEXT NOT NULL,
      f_geometry_column TEXT,
      styleName TEXT,
      styleQML TEXT,
      styleSLD TEXT,
      useAsDefault BOOLEAN DEFAULT 1,
      description TEXT DEFAULT '',
      owner TEXT DEFAULT '',
      ui TEXT,
      update_time DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);

  const stmt = db.prepare(`
    INSERT INTO layer_styles (f_table_name, f_geometry_column, styleName, styleQML, styleSLD, useAsDefault)
    VALUES (?, 'geometry', ?, ?, ?, 1)
  `);

  for (const style of LAYER_STYLES) {
    stmt.run(style.table, style.table, style.qml, style.sld);
  }
}
