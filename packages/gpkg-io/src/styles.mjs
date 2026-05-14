/**
 * Generic SLD and QML style builders, plus generic CRUD for the QGIS
 * `layer_styles` table convention. Schema-agnostic — callers compose
 * styles for whatever layer names they care about and write them via
 * `createLayerStylesTable` / `insertLayerStyle`.
 */

// ---------------------------------------------------------------------------
// SLD (Styled Layer Descriptor) — portable XML used by many GIS tools.
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

export function polygonSld(name, fill, stroke, fillOpacity = 0.5, strokeWidth = 1.5) {
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

export function lineSld(name, stroke, strokeWidth = 2) {
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

export function pointSld(name, fill, stroke, size = 8) {
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

// ---------------------------------------------------------------------------
// QML (QGIS-native XML). Stored alongside SLD so QGIS picks it up
// automatically; SLD is the fallback for other tools.
// ---------------------------------------------------------------------------

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

export function polygonQml(fill, stroke, fillOpacity = 0.5, strokeWidth = 1.5) {
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

export function lineQml(stroke, strokeWidth = 2) {
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

export function pointQml(fill, stroke, size = 4) {
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

// ---------------------------------------------------------------------------
// layer_styles table — QGIS's auto-loading convention. Each row carries both
// a QML (for QGIS itself) and an SLD (for portability to other GIS tools).
// ---------------------------------------------------------------------------

export function createLayerStylesTable(db) {
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
}

/**
 * Insert one row into the layer_styles table for a feature layer.
 *
 * @param {object} db      better-sqlite3 Database handle
 * @param {string} table   feature-layer table name
 * @param {string} qml     QML XML
 * @param {string} sld     SLD XML
 */
export function insertLayerStyle(db, table, qml, sld) {
  db.prepare(
    `INSERT INTO layer_styles (f_table_name, f_geometry_column, styleName, styleQML, styleSLD, useAsDefault)
     VALUES (?, 'geometry', ?, ?, ?, 1)`,
  ).run(table, table, qml, sld);
}
