/**
 * The per-parcel mini-map, shared by both habitat layouts.
 *
 * Sized by its caller — 52 pt in a table row, 96 pt on a card — because the
 * frame is the only thing the two layouts disagree about. Everything else
 * (which tiles, what is drawn underneath, in what order) is identical, and
 * duplicating it would be two chances to get the marked-content order wrong
 * instead of one.
 */

import {
  drawBasemap, drawGeometry, withFrameClip, HABITAT_STYLES, fetchTiles
} from './map.mjs'
import { envelopeOf } from './geometry.mjs'
import { pickZoom } from './grid.mjs'
import { fitEnvelopeToFrame, makeProjector } from './projector.mjs'
import {
  BORDER, CONTEXT_FILL, CONTEXT_STROKE, MAP_GROUND, MINI_MAP_PAD, MINI_MAP_SIZE
} from './layout.mjs'

/** Thumbnails are small, so they are fetched at print resolution, not screen. */
const THUMBNAIL_TARGET_DPI = 150

/**
 * Work out each thumbnail's extent and fetch its tiles, before any drawing.
 *
 * All tile I/O finishes here. pdfkit is sequential and stateful: an `await`
 * between marking a structure sequence and closing it lets other work
 * interleave, which silently corrupts both the layout and the reading order.
 */
export async function prepareThumbnails({
  features, grid, tileSource, withBasemap, size = MINI_MAP_SIZE
}) {
  const square = { x: 0, y: 0, width: size, height: size }
  const thumbnails = new Map()

  for (const feature of features) {
    const padded = padEnvelopeBy(envelopeOf(feature.geometry), MINI_MAP_PAD)
    const extent = fitEnvelopeToFrame(padded, square)

    if (!withBasemap) {
      thumbnails.set(feature, { extent, z: null, tiles: null })
      continue
    }
    const z = pickZoom(grid, extent, square.width, THUMBNAIL_TARGET_DPI)
    const { tiles } = await fetchTiles(grid, z, extent, tileSource)
    thumbnails.set(feature, { extent, z, tiles })
  }
  return thumbnails
}

export function padEnvelopeBy(envelope, fraction) {
  const padX = (envelope.maxX - envelope.minX) * fraction
  const padY = (envelope.maxY - envelope.minY) * fraction
  return {
    minX: envelope.minX - padX,
    minY: envelope.minY - padY,
    maxX: envelope.maxX + padX,
    maxY: envelope.maxY + padY
  }
}

/**
 * A parcel thumbnail, zoomed to the parcel itself so its shape is legible.
 *
 * Neighbouring parcels and the site boundary are drawn faintly underneath for
 * orientation — without them a lone polygon on a blank square tells you the
 * shape but not where it sits.
 *
 * The basemap is ON by default, decided by looking at real OS output rather
 * than by argument: at 18 mm the raster reads as useful context, not noise.
 *
 * It is not free. On the 120-parcel example against real OS it takes the
 * document from 851 kB / 12 tiles to 4.6 MB / 262 tiles. Wall-clock barely
 * moves (+0.4 s) because neighbouring parcels overlap and the proxy cache
 * absorbs the repeats, so SIZE is the cost to watch, not time. If that becomes
 * the constraint, halve the thumbnails' target DPI before dropping the basemap
 * — at 60 pt square the difference is invisible.
 *
 * `--no-habitat-basemap` turns it off.
 */
export function drawMiniMap({ doc, frame, feature, style, site, grid, thumbnail }) {
  // The extent was computed against an identically sized frame, so rebuilding
  // the projector here only moves the origin — the scale is unchanged.
  const projector = makeProjector(thumbnail.extent, frame)

  doc.save()
  doc.rect(frame.x, frame.y, frame.width, frame.height).fillColor(MAP_GROUND).fill()
  doc.restore()

  let tileCount = 0
  withFrameClip(doc, frame, () => {
    if (thumbnail.tiles) {
      tileCount = drawBasemap(doc, {
        grid, z: thumbnail.z, projector, tiles: thumbnail.tiles
      }).tileCount
    }

    // Context first, so the subject parcel draws over it.
    for (const other of site.layers.habitats?.features ?? []) {
      if (other !== feature) {
        drawGeometry(doc, other.geometry, projector, {
          fill: CONTEXT_FILL,
          stroke: CONTEXT_STROKE,
          fillOpacity: 0.45,
          lineWidth: 0.3
        })
      }
    }
    if (site.redLine) {
      drawGeometry(doc, site.redLine.geometry, projector, {
        stroke: HABITAT_STYLES.redLine.stroke,
        lineWidth: 0.8
      })
    }
    drawGeometry(doc, feature.geometry, projector, { ...style, lineWidth: 0.8 })
  })

  doc.save().lineWidth(0.5).strokeColor(BORDER)
  doc.rect(frame.x, frame.y, frame.width, frame.height).stroke()
  doc.restore()

  return { tileCount, projector }
}
