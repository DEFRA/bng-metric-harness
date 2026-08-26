/**
 * Configuration for the OS tiles proxy.
 *
 * Shaped so it maps cleanly onto the siblings' `convict` schemas — every field
 * here becomes one convict entry with the same env var. The API key is marked
 * so that nothing logs it by accident.
 *
 * In a sibling this becomes:
 *
 *   osMaps: {
 *     apiKey: { format: String, default: '', sensitive: true, env: 'OS_MAPS_API_KEY' },
 *     ...
 *   }
 */

export const OS_MAPS_RASTER_ZXY = 'https://api.os.uk/maps/raster/v1/zxy'
export const OS_MAPS_WMTS = 'https://api.os.uk/maps/raster/v1/wmts'

/**
 * EPSG:27700 raster styles, and the zoom range OS publishes for each.
 *
 * Pinned in code rather than configured: these are properties of the OS
 * product, not deployment choices. `Leisure_27700` stops at 9, the rest at 13.
 */
export const OS_LAYERS = {
  Light_27700: { maxZoom: 13 },
  Road_27700: { maxZoom: 13 },
  Outdoor_27700: { maxZoom: 13 },
  Leisure_27700: { maxZoom: 9 }
}

export const DEFAULT_LAYER = 'Light_27700'
export const TILE_MATRIX_SET = 'EPSG:27700'

const DEFAULT_CACHE_TTL_SECONDS = 60 * 60 * 24 * 7
const DEFAULT_CACHE_MAX_ENTRIES = 2000

export function resolveConfig(overrides = {}) {
  const config = {
    apiKey: process.env.OS_MAPS_API_KEY ?? '',
    baseUrl: process.env.OS_MAPS_BASE_URL ?? OS_MAPS_RASTER_ZXY,
    wmtsUrl: process.env.OS_MAPS_WMTS_URL ?? OS_MAPS_WMTS,
    layer: process.env.OS_MAPS_LAYER ?? DEFAULT_LAYER,
    cacheTtlSeconds: Number(
      process.env.OS_MAPS_CACHE_TTL_SECONDS ?? DEFAULT_CACHE_TTL_SECONDS
    ),
    cacheMaxEntries: DEFAULT_CACHE_MAX_ENTRIES,
    routePrefix: '/os-tiles',
    ...overrides
  }

  if (!OS_LAYERS[config.layer]) {
    throw new Error(
      `Unknown OS layer "${config.layer}". Expected one of: ${Object.keys(OS_LAYERS).join(', ')}`
    )
  }
  return config
}

/**
 * The diagnostic grants-ui found necessary.
 *
 * A key that is unset — or set but whose OS Data Hub project does not have the
 * "OS Maps API" product added — produces a bare 401 from OS with nothing to
 * explain it. Say so once, loudly, at startup.
 */
export function keyWarning(config) {
  if (config.apiKey) {
    return null
  }
  return (
    'OS_MAPS_API_KEY is not set: every tile request will fail as a 401 from ' +
    'Ordnance Survey with no diagnostic. Note the key must belong to an OS Data ' +
    'Hub project with the "OS Maps API" product added — a key without it 401s ' +
    'the same way.'
  )
}
