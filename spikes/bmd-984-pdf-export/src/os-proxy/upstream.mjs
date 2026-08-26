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

function upstreamError(status, what) {
  const error = new Error(
    status === 401
      ? `Ordnance Survey rejected the request for ${what} (401). Either OS_MAPS_API_KEY ` +
        'is unset or wrong, or its OS Data Hub project does not have the "OS Maps API" ' +
        'product added — both fail this way.'
      : `Ordnance Survey returned ${status} for ${what}`
  )
  error.status = status
  return error
}
