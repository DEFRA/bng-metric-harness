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
 *  - `osTileSource`  fetches real OS Maps API raster tiles. Untested in this
 *    spike — no API key was available — so it is written to the documented
 *    URL shape and left for whoever has a key. Swapping it in changes nothing
 *    else, which is the point of the interface.
 */

import { Raster } from './png.mjs'
import { tileSpanMetres, tileTopLeft } from './grid.mjs'

/** Ground interval between the light grid lines drawn into a synthetic tile. */
function gridIntervalMetres(resolution, tileSize) {
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
 * Real OS Maps API raster tiles (EPSG:27700).
 *
 * NOT EXERCISED — no API key was available in the spike environment. Treat the
 * URL shape as needing confirmation against OS's own docs before trusting it,
 * and note the grid must come from `gridFromWmtsCapabilities`, never from a
 * hard-coded origin.
 *
 * On CDP this must go through the platform proxy; the frontend already wires
 * that up globally in src/server/common/helpers/proxy/setup-proxy.js.
 */
const OS_RASTER_ZXY = 'https://api.os.uk/maps/raster/v1/zxy'

export function osTileSource({ apiKey, style = 'Light_27700', fetchImpl = fetch }) {
  if (!apiKey) {
    throw new Error('An OS Data Hub API key is required for the OS tile source')
  }
  const cache = new Map()

  return async function osTile(grid, z, col, row) {
    const key = `${z}/${col}/${row}`
    if (cache.has(key)) {
      return cache.get(key)
    }
    // ZXY order is z/x/y, i.e. column then row.
    const url = `${OS_RASTER_ZXY}/${style}/${z}/${col}/${row}.png?key=${apiKey}`
    const response = await fetchImpl(url)
    if (!response.ok) {
      throw new Error(`OS tile ${key} failed: ${response.status} ${response.statusText}`)
    }
    const tile = { png: Buffer.from(await response.arrayBuffer()) }
    cache.set(key, tile)
    return tile
  }
}
