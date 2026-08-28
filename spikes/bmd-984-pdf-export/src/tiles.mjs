/**
 * Basemap tile sources.
 *
 * Two implementations behind one interface — `(grid, z, col, row) => Buffer`
 * of PNG:
 *
 *  - `syntheticTileSource`  draws each tile's own ground coordinates into the
 *    tile. Needs no network and no API key, and makes registration *provable*
 *    rather than merely plausible: the overlay draws the same round-numbered
 *    grid as vectors, and the two must coincide exactly.
 *
 *  - `proxyTileSource`  fetches tiles from our own /os-tiles route, which is
 *    the only thing that holds an OS API key. See src/os-proxy/ and PLAN.md.
 */

import { Raster } from './png.mjs'
import { tileSpanMetres, tileTopLeft } from './grid.mjs'
import { decodeVectorTile } from './mvt.mjs'

/**
 * Ground interval between the grid lines drawn into a synthetic tile.
 *
 * Exported because the vector overlay must derive the SAME interval, from the
 * same grid and zoom, rather than being told it by a tile. A real OS tile
 * carries no such metadata, so anything that reads the interval off the tile
 * object works with the synthetic basemap and silently does nothing with a
 * real one — which is exactly the bug this export exists to prevent.
 */
export function gridIntervalMetres(resolution, tileSize) {
  // Aim for roughly 4-8 lines across a tile, snapped to a 1/2/5 series so the
  // interval is always a round number a human can verify by eye.
  const target = (resolution * tileSize) / 6
  const magnitude = 10 ** Math.floor(Math.log10(target))
  for (const step of [1, 2, 5, 10]) {
    if (step * magnitude >= target) {
      return step * magnitude
    }
  }
  return 10 * magnitude
}

const TILE_SHADE_A = [236, 240, 233]
const TILE_SHADE_B = [228, 234, 226]
const GRID_LINE = [176, 190, 176]
const MAJOR_LINE = [120, 140, 122]
const TILE_EDGE = [205, 214, 204]

/**
 * A basemap whose tiles state where they are.
 *
 * Every line drawn is at a round EPSG:27700 coordinate, computed from the
 * tile's own world extent. If the page transform is right, a vector line drawn
 * at that same coordinate lands exactly on it.
 */
export function syntheticTileSource() {
  return function synthetic(grid, z, col, row) {
    const span = tileSpanMetres(grid, z)
    const resolution = grid.resolutions[z]
    const [tileMinX, tileMaxY] = tileTopLeft(grid, z, col, row)
    const tileMaxX = tileMinX + span
    const tileMinY = tileMaxY - span

    // Alternate shading so tile seams are visible: a gap or an overlap between
    // neighbouring tiles shows up immediately as a light or dark line.
    const shade = (col + row) % 2 === 0 ? TILE_SHADE_A : TILE_SHADE_B
    const raster = new Raster(grid.tileSize, grid.tileSize, shade)

    const interval = gridIntervalMetres(resolution, grid.tileSize)
    const major = interval * 5

    for (
      let x = Math.ceil(tileMinX / interval) * interval;
      x <= tileMaxX;
      x += interval
    ) {
      const px = Math.round((x - tileMinX) / resolution)
      const isMajor = Math.abs(x / major - Math.round(x / major)) < 1e-9
      raster.verticalLine(px, isMajor ? MAJOR_LINE : GRID_LINE, isMajor ? 2 : 1)
    }

    for (
      let y = Math.ceil(tileMinY / interval) * interval;
      y <= tileMaxY;
      y += interval
    ) {
      // Northing increases upward; tile pixel rows increase downward.
      const py = Math.round((tileMaxY - y) / resolution)
      const isMajor = Math.abs(y / major - Math.round(y / major)) < 1e-9
      raster.horizontalLine(py, isMajor ? MAJOR_LINE : GRID_LINE, isMajor ? 2 : 1)
    }

    // Mark the tile's own edges, so a misplaced tile is obvious.
    raster.verticalLine(0, TILE_EDGE)
    raster.horizontalLine(0, TILE_EDGE)

    return { png: raster.toPng(), interval }
  }
}

/**
 * Tiles fetched through OUR OWN proxy, not from api.os.uk.
 *
 * This is the production shape, and it is why the proxy exists: the PDF
 * builder holds no API key, only a URL. It also gets the shared cache for
 * free, and its requests traverse the CDP egress proxy because the tile route
 * — not this code — is what talks to the internet.
 *
 * The grid comes from the same proxy's /capabilities, so the exact EPSG:27700
 * origin and resolutions reach the PDF maths without anything here parsing
 * WMTS XML or hard-coding a constant.
 *
 * @param {object} options
 * @param {string} options.baseUrl  e.g. 'http://localhost:3000/os-tiles'
 */
export function proxyTileSource({ baseUrl, fetchImpl = fetch }) {
  const cache = new Map()

  return async function proxyTile(grid, z, col, row) {
    const key = `${z}/${col}/${row}`
    if (cache.has(key)) {
      return cache.get(key)
    }

    const response = await fetchImpl(`${baseUrl}/${z}/${col}/${row}.png`)
    if (!response.ok) {
      throw new Error(
        `Tile ${key} failed: ${response.status} ${response.statusText}`
      )
    }

    const tile = { png: Buffer.from(await response.arrayBuffer()) }
    cache.set(key, tile)
    return tile
  }
}

/**
 * Vector tiles fetched through the same proxy's /vector route and decoded
 * here, so downstream code holds geometry, not bytes.
 *
 * Returns `{ layers }` (see decodeVectorTile) where the raster sources
 * return `{ png }` — that shape difference is how drawBasemap knows which
 * kind of tile it was handed.
 */
export function vectorProxyTileSource({ baseUrl, fetchImpl = fetch }) {
  const cache = new Map()

  return async function vectorProxyTile(grid, z, col, row) {
    const key = `${z}/${col}/${row}`
    if (cache.has(key)) {
      return cache.get(key)
    }

    const response = await fetchImpl(`${baseUrl}/vector/${z}/${col}/${row}.pbf`)
    if (!response.ok) {
      throw new Error(
        `Vector tile ${key} failed: ${response.status} ${response.statusText}`
      )
    }

    const tile = decodeVectorTile(Buffer.from(await response.arrayBuffer()))
    cache.set(key, tile)
    return tile
  }
}

/**
 * Fetch the tile grid from the proxy's capabilities route.
 *
 * @param {string} baseUrl  e.g. 'http://localhost:3000/os-tiles'
 */
export async function fetchGridFromProxy(baseUrl, fetchImpl = fetch) {
  const response = await fetchImpl(`${baseUrl}/capabilities`)
  if (!response.ok) {
    throw new Error(
      `Could not read tile grid from ${baseUrl}/capabilities: ` +
        `${response.status} ${response.statusText}`
    )
  }
  const { grid } = await response.json()
  return grid
}

/** The same, for the vector flavour's grid. */
export function fetchVectorGridFromProxy(baseUrl, fetchImpl = fetch) {
  return fetchGridFromProxy(`${baseUrl}/vector`, fetchImpl)
}
