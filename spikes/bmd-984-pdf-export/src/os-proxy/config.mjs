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

/**
 * The zoom ceiling imposed by the OS *plan*, as distinct from the product.
 *
 * Verified against a live OpenData-plan key on 2026-08-26, not read off a
 * doc page: EPSG:27700 serves z0-9 and returns
 *
 *   403 <ExceptionText>A Premium Plan is required to access Premium Data</…>
 *
 * from z10 up. (EPSG:3857 behaves the same way with its own ceiling at z16;
 * z9 in 27700 is 1.75 m/px and z16 in 3857 is ~1.5 m/px at GB latitudes, so
 * reprojecting buys no detail and costs exact registration.)
 *
 * A PSGA / Premium key lifts this to the product maximum. It is therefore a
 * deployment property, not a product one — hence an env var, and hence NOT
 * defaulted to 9: defaulting to the free ceiling would silently throw away
 * half the resolution a Premium key has paid for.
 */
export const OPEN_DATA_MAX_ZOOM = {
  'EPSG:27700': 9,
  'EPSG:3857': 16
}

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
    // Unset means "whatever the product allows" — correct for a Premium/PSGA
    // key. An OpenData key must set OS_MAPS_MAX_ZOOM=9 or every tile above
    // that zoom 403s. `keyWarning` says so at startup.
    maxZoom: numberOrNull(process.env.OS_MAPS_MAX_ZOOM),
    ...overrides
  }

  if (!OS_LAYERS[config.layer]) {
    throw new Error(
      `Unknown OS layer "${config.layer}". Expected one of: ${Object.keys(OS_LAYERS).join(', ')}`
    )
  }

  // The effective ceiling is the stricter of the product's and the plan's.
  const productMaxZoom = OS_LAYERS[config.layer].maxZoom
  config.maxZoom =
    config.maxZoom === null ? productMaxZoom : Math.min(config.maxZoom, productMaxZoom)

  return config
}

function numberOrNull(value) {
  if (value === undefined || value === '') {
    return null
  }
  const parsed = Number(value)
  return Number.isInteger(parsed) ? parsed : null
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
