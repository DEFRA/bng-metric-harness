/**
 * Read a BNG GeoPackage with Node's built-in `node:sqlite` — no better-sqlite3,
 * no native modules at all.
 *
 * In the real service this is the wrong source: the backend already holds the
 * same geometry in PostGIS as `geometry(..., 27700)`, and that is the copy the
 * user has since edited (`PUT /projects/{id}/habitats/{featureId}`), so an
 * uploaded file can be stale. Reading the file keeps the spike standalone.
 * Swapping in `ST_AsGeoJSON` changes only this module.
 */

import { DatabaseSync } from 'node:sqlite'

import { gpkgBlobToGeometry } from './wkb.mjs'

export const BNG_SRS_ID = 27700

/**
 * Layer names carry meaning in the BNG template, so map them onto the roles
 * the report cares about rather than guessing from geometry type.
 */
const LAYER_ROLES = {
  'Red Line Boundary': 'redLine',
  Habitats: 'habitats',
  Hedgerows: 'hedgerows',
  Rivers: 'watercourses',
  'Urban Trees': 'trees'
}

/**
 * List the feature layers, with the SRS id declared for each geometry column.
 *
 * The srsId is read rather than inferred. The digital prototype sniffs
 * projection from coordinate magnitude instead
 * (`isLikelyBNG` in app/assets/javascripts/map-habitats-summary.js), which is
 * a heuristic that eventually guesses wrong — the file states the answer.
 */
export function readLayers(db) {
  const contents = db
    .prepare(
      `SELECT table_name, identifier FROM gpkg_contents WHERE data_type = 'features'`
    )
    .all()

  const geometryColumns = new Map(
    db
      .prepare(
        `SELECT table_name, column_name, geometry_type_name, srs_id
           FROM gpkg_geometry_columns`
      )
      .all()
      .map((row) => [row.table_name, row])
  )

  const layers = []
  for (const row of contents) {
    const geometry = geometryColumns.get(row.table_name)
    if (!geometry) {
      continue
    }
    layers.push({
      name: row.table_name,
      role: LAYER_ROLES[row.table_name] ?? null,
      geometryColumn: geometry.column_name,
      geometryType: geometry.geometry_type_name,
      srsId: geometry.srs_id
    })
  }
  return layers
}

/**
 * Read every feature of one layer: all attribute columns, plus the decoded
 * geometry.
 *
 * @returns {Array<{ properties: object, geometry: object }>}
 */
export function readFeatures(db, layer) {
  const columns = db
    .prepare(`PRAGMA table_info("${layer.name}")`)
    .all()
    .map((column) => column.name)

  const rows = db
    .prepare(
      `SELECT ${columns.map((c) => `"${c}"`).join(', ')}
         FROM "${layer.name}"
        WHERE "${layer.geometryColumn}" IS NOT NULL`
    )
    .all()

  return rows.map((row) => {
    const { geometry, srsId } = gpkgBlobToGeometry(row[layer.geometryColumn])
    assertBngSrs(srsId, `${layer.name} feature ${row.fid}`)

    const properties = {}
    for (const column of columns) {
      if (column !== layer.geometryColumn) {
        properties[column] = row[column]
      }
    }
    return { properties, geometry }
  })
}

/**
 * Fail loudly on anything that is not British National Grid.
 *
 * Every downstream calculation — the tile grid, the page transform, the areas —
 * assumes metres on EPSG:27700. Silently accepting degrees would put the
 * geometry somewhere off the coast of Africa rather than produce a visible
 * error, so this is checked at both the layer and the feature level.
 */
export function assertBngSrs(srsId, what) {
  if (srsId !== BNG_SRS_ID) {
    throw new Error(
      `${what}: expected EPSG:${BNG_SRS_ID} (British National Grid), got EPSG:${srsId}. ` +
        'This spike does no reprojection by design.'
    )
  }
}

/**
 * Read a whole site: the red line, and the habitat layers keyed by role.
 *
 * @param {string} filename path to a .gpkg
 * @returns {{ layers: object, redLine: object|null, siteName: string|null }}
 */
export function readSite(filename) {
  const db = new DatabaseSync(filename, { readOnly: true })
  try {
    const layers = {}
    for (const layer of readLayers(db)) {
      assertBngSrs(layer.srsId, `layer "${layer.name}"`)
      if (layer.role) {
        layers[layer.role] = { ...layer, features: readFeatures(db, layer) }
      }
    }

    const redLine = layers.redLine?.features?.[0] ?? null
    return {
      layers,
      redLine,
      siteName:
        redLine?.properties?.['Site Name'] ??
        layers.habitats?.features?.[0]?.properties?.['Site Name'] ??
        null
    }
  } finally {
    db.close()
  }
}
