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

import { gridFromWmtsCapabilities } from '../grid.mjs'
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
    return (
      `Ordnance Survey rejected the request for ${what} (401). Either OS_MAPS_API_KEY ` +
      'is unset or wrong, or its OS Data Hub project does not have the "OS Maps API" ' +
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

const HTTP_UNAUTHORIZED = 401
const HTTP_FORBIDDEN = 403
