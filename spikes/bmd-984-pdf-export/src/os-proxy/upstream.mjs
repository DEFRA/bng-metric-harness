/**
 * Talking to api.os.uk.
 *
 * The only module that knows the API key exists. Everything downstream — the
 * browser, the PDF builder — sees an internal URL and nothing else.
 *
 * `fetch` is used deliberately rather than a bespoke HTTP client: on CDP it is
 * backed by undici, and `setup-proxy.js` installs the platform egress proxy
 * with `setGlobalDispatcher`, so plain `fetch` traverses it with no extra
 * wiring. This is the same reasoning NRF records in its own proxy.
 */

import { gridFromTileMatrixSetJson, gridFromWmtsCapabilities } from '../grid.mjs'
import { TILE_MATRIX_SET } from './config.mjs'

/**
 * Fetch one raster tile.
 *
 * @returns {{ png: Buffer, contentType: string }}
 */
export async function fetchTile(
  { baseUrl, layer, apiKey },
  { z, col, row },
  fetchImpl = fetch
) {
  // OS raster ZXY orders the path z/x/y, i.e. column then row.
  const url = `${baseUrl}/${layer}/${z}/${col}/${row}.png?key=${encodeURIComponent(apiKey)}`
  const response = await fetchImpl(url, { redirect: 'follow' })

  if (!response.ok) {
    throw upstreamError(response.status, `tile ${layer}/${z}/${col}/${row}`)
  }
  return {
    png: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get('content-type') || 'image/png'
  }
}

/**
 * Fetch and parse the WMTS capabilities into a tile grid.
 *
 * This is the authoritative source for the EPSG:27700 origin and per-level
 * resolutions. Hard-coding them is the one thing guaranteed to produce a
 * basemap that looks plausible and is wrong, so the proxy fetches them and
 * serves them onward — which also means the PDF builder gets the real grid
 * without ever holding a key.
 */
export async function fetchGrid(
  { wmtsUrl, apiKey },
  fetchImpl = fetch,
  tileMatrixSet = TILE_MATRIX_SET
) {
  const url =
    `${wmtsUrl}?service=WMTS&request=GetCapabilities&version=2.0.0` +
    `&key=${encodeURIComponent(apiKey)}`
  const response = await fetchImpl(url, { redirect: 'follow' })

  if (!response.ok) {
    throw upstreamError(response.status, 'WMTS GetCapabilities')
  }
  return gridFromWmtsCapabilities(await response.text(), tileMatrixSet)
}

/**
 * Fetch one vector tile from the OS NGD API – Tiles ngd-base tileset.
 *
 * NOTE the path order: OGC API Tiles is {tileMatrix}/{tileRow}/{tileCol} —
 * ROW before COLUMN — where the raster ZXY is z/x/y. Getting this wrong does
 * not error; it returns a plausible tile of somewhere else in Britain, which
 * is exactly the class of bug the registration proof exists to catch.
 *
 * @returns {{ pbf: Buffer, contentType: string }}
 */
export async function fetchVectorTile(
  { vectorTilesUrl, apiKey },
  { z, col, row },
  fetchImpl = fetch
) {
  const url = `${vectorTilesUrl}/${z}/${row}/${col}?key=${encodeURIComponent(apiKey)}`
  const response = await fetchImpl(url, { redirect: 'follow' })

  if (!response.ok) {
    throw upstreamError(response.status, `vector tile ${z}/${col}/${row}`)
  }
  return {
    pbf: Buffer.from(await response.arrayBuffer()),
    contentType: 'application/vnd.mapbox-vector-tile'
  }
}

/**
 * Fetch the EPSG:27700 tiling-scheme definition and parse it into a grid.
 *
 * Same policy as fetchGrid: the origin and resolutions come from OS's own
 * published document, never from a constant in this repo.
 */
export async function fetchVectorGrid({ vectorTileMatrixSetUrl, apiKey }, fetchImpl = fetch) {
  const url = `${vectorTileMatrixSetUrl}?key=${encodeURIComponent(apiKey)}`
  const response = await fetchImpl(url, { redirect: 'follow' })

  if (!response.ok) {
    throw upstreamError(response.status, 'the 27700 tile matrix set')
  }
  return gridFromTileMatrixSetJson(await response.json())
}

/**
 * Turn OS's two authentication-shaped failures into messages that say what to
 * do about them. They are NOT the same problem and were both observed live:
 *
 *   401  the key is unset/wrong, or its Data Hub project lacks "OS Maps API".
 *   403  the key is fine and the project is fine, but the *plan* does not
 *        cover this data. OS returns an OWS ExceptionReport reading
 *        "A Premium Plan is required to access Premium Data". On an OpenData
 *        plan this is what every EPSG:27700 tile above zoom 9 returns, so the
 *        fix is usually OS_MAPS_MAX_ZOOM, not a new key.
 */
function upstreamError(status, what) {
  const error = new Error(messageFor(status, what))
  error.status = status
  return error
}

function messageFor(status, what) {
  if (status === HTTP_UNAUTHORIZED) {
    // Products are granted per-API in the OS Data Hub, so say which one THIS
    // request needed — a key can hold the vector product and not the raster
    // one (the situation that motivated the vector path), or vice versa.
    const product = productFor(what)
    return (
      `Ordnance Survey rejected the request for ${what} (401). Either OS_MAPS_API_KEY ` +
      `is unset or wrong, or its OS Data Hub project does not have the ${product} ` +
      'product added — both fail this way.'
    )
  }
  if (status === HTTP_FORBIDDEN) {
    return (
      `Ordnance Survey returned 403 for ${what}: the key is valid but its plan does ` +
      'not cover this data ("A Premium Plan is required to access Premium Data"). ' +
      'An OpenData plan stops at zoom 9 in EPSG:27700 — set OS_MAPS_MAX_ZOOM=9 to ' +
      'stay inside it, or use a PSGA/Premium key for zooms 10-13.'
    )
  }
  return `Ordnance Survey returned ${status} for ${what}`
}

function productFor(what) {
  // Both vector requests — tiles and the tiling-scheme document — are the
  // same NGD product; only the raster route needs OS Maps API.
  if (what.startsWith('vector') || what.includes('tile matrix')) {
    return '"OS NGD API – Tiles"'
  }
  return '"OS Maps API"'
}

const HTTP_UNAUTHORIZED = 401
const HTTP_FORBIDDEN = 403
