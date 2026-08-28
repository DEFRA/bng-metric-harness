/**
 * The vector basemap's cartographic style.
 *
 * The substance lives in src/ngd-light-style.mjs — machine-extracted from
 * Ordnance Survey's own published "light-27700" style for the ngd-base
 * tileset (see tools/extract-ngd-style.mjs), so the basemap prints in OS's
 * palette and draw order, not ours. Only the text/label rules are dropped: a
 * static print basemap under habitat overlays reads better without them, and
 * every fact a label would carry is in the PDF's tables anyway.
 *
 * Machine-extracting a distilled style is this service's existing pattern in
 * spirit: the frontend deliberately hard-codes UKHab symbology rather than
 * interpreting style documents at runtime. Interpreting the full GL style
 * spec (filters, expressions, sprites, fonts) would be a rendering-engine
 * project; the generated tables are the 5% of it a basemap needs.
 *
 * This module adds the one thing OS's style cannot know about: the stub
 * upstream's synthetic Graticule layer, which only ever appears in stub
 * tiles and exists so `--proxy-vector --graticule` can prove registration
 * offline (see stub-upstream.mjs). It draws last, on top, like the raster
 * synthetic tiles' grid lines.
 */

import { NGD_LIGHT_BASEMAP_PASSES } from './ngd-light-style.mjs'

/**
 * Lines at round EPSG:27700 coordinates, minor (_symbol 0) and major
 * (_symbol 1), in the same colours the synthetic RASTER tiles use. A real OS
 * tile never contains this layer, so it is inert in production.
 */
const GRATICULE_LINES = {
  0: { stroke: '#B0BEB0', widthStops: [[0, 1]] },
  1: { stroke: '#788C7A', widthStops: [[0, 2]] }
}

export const VECTOR_BASEMAP_STYLE = [
  ...NGD_LIGHT_BASEMAP_PASSES,
  { layer: 'Graticule', lines: GRATICULE_LINES }
]

/**
 * Interpolate a GL-style width ramp at a zoom.
 *
 * Linear between stops, clamped at the ends. Clamping above the last stop is
 * deliberately safe: where the style stops widening a line class it is
 * because the feature class hands over to polygons at deeper zooms, so the
 * clamped value is what OS itself renders.
 */
export function lineWidthAtZoom(widthStops, z) {
  const first = widthStops[0]
  if (z <= first[0]) {
    return first[1]
  }
  for (let i = 1; i < widthStops.length; i++) {
    const [stopZ, stopW] = widthStops[i]
    if (z <= stopZ) {
      const [previousZ, previousW] = widthStops[i - 1]
      const t = (z - previousZ) / (stopZ - previousZ)
      return previousW + t * (stopW - previousW)
    }
  }
  return widthStops[widthStops.length - 1][1]
}
