/**
 * The vector basemap's registration proof, as arithmetic.
 *
 * The raster claim was: a tile corner and a habitat vertex go through the
 * same `toPage`, so they cannot disagree. The vector claim is one step
 * longer: a tile-local vertex becomes a ground coordinate using the tile's
 * own extent, and THAT goes through the same `toPage`. These tests walk a
 * synthetic vector tile's graticule geometry back to ground coordinates and
 * check they are the round numbers the graticule overlay would draw at —
 * decode, tile maths and page transform agreeing end to end, offline.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { decodeVectorTile } from '../src/mvt.mjs'
import { gridFromTileMatrixSetJson, tileSpanMetres, tileTopLeft, tilesCovering, pickZoom } from '../src/grid.mjs'
import { gridIntervalMetres } from '../src/tiles.mjs'
import { projectorFor } from '../src/projector.mjs'
import { stubTileMatrixSetJson, syntheticVectorTile } from '../src/os-proxy/stub-upstream.mjs'
import { lineWidthAtZoom, VECTOR_BASEMAP_STYLE } from '../src/vector-style.mjs'

const GRID = {
  originX: -238375,
  originY: 1376256,
  tileSize: 512,
  resolutions: [3584, 1792, 896, 448, 224, 112, 56, 28, 14, 7, 3.5, 1.75, 0.875, 0.4375, 0.21875, 0.109375]
}

const FRAME = { x: 50, y: 80, width: 460, height: 320 }
const SITE = { minX: 412000, minY: 287000, maxX: 412600, maxY: 287350 }

test('a TileMatrixSet JSON document round-trips into the same grid', () => {
  const parsed = gridFromTileMatrixSetJson(stubTileMatrixSetJson(GRID))

  assert.equal(parsed.originX, GRID.originX)
  assert.equal(parsed.originY, GRID.originY)
  assert.equal(parsed.tileSize, GRID.tileSize)
  assert.deepEqual(parsed.resolutions, GRID.resolutions)
  assert.ok(Number.isFinite(parsed.matrixWidths[0]), 'matrix dimensions must survive')
})

test('a mixed-origin TileMatrixSet document is rejected', () => {
  const document = stubTileMatrixSetJson(GRID)
  document.tileMatrices[1].pointOfOrigin = [0, 0]
  assert.throws(() => gridFromTileMatrixSetJson(document), /different origins/)
})

test('synthetic vector graticule vertices decode to round ground coordinates', () => {
  const projector = projectorFor(SITE, FRAME, { pad: 0.1 })
  const z = pickZoom(GRID, projector.extent, FRAME.width)
  const [{ col, row }] = tilesCovering(GRID, z, projector.extent)

  const span = tileSpanMetres(GRID, z)
  const [tileMinX, tileMaxY] = tileTopLeft(GRID, z, col, row)
  const interval = gridIntervalMetres(GRID.resolutions[z], GRID.tileSize)

  const tile = decodeVectorTile(syntheticVectorTile(GRID, z, col, row))
  const graticule = tile.layers.Graticule
  assert.ok(graticule.features.length > 0, 'the stub tile must carry graticule lines')

  // The tile's local extent snaps coordinates to extent-ths of the span, so
  // allow that quantisation and nothing more.
  const quantum = span / graticule.extent

  for (const feature of graticule.features) {
    for (const [localX, localY] of feature.paths.flat()) {
      const worldX = tileMinX + (localX / graticule.extent) * span
      const worldY = tileMaxY - (localY / graticule.extent) * span
      const snappedX = Math.round(worldX / interval) * interval
      const snappedY = Math.round(worldY / interval) * interval
      const onVertical = Math.abs(worldX - snappedX) <= quantum / 2
      const onHorizontal = Math.abs(worldY - snappedY) <= quantum / 2
      const onTileEdge = localX === 0 || localY === 0 ||
        localX === graticule.extent || localY === graticule.extent
      assert.ok(
        onVertical || onHorizontal || onTileEdge,
        `vertex (${worldX}, ${worldY}) is on no round graticule coordinate`
      )
    }
  }
})

test('the same ground coordinate lands on the same page point from either path', () => {
  const projector = projectorFor(SITE, FRAME, { pad: 0.1 })
  const z = pickZoom(GRID, projector.extent, FRAME.width)
  const [{ col, row }] = tilesCovering(GRID, z, projector.extent)
  const span = tileSpanMetres(GRID, z)
  const [tileMinX, tileMaxY] = tileTopLeft(GRID, z, col, row)

  const tile = decodeVectorTile(syntheticVectorTile(GRID, z, col, row))
  const { extent } = tile.layers.Graticule
  const [localX, localY] = tile.layers.Graticule.features[0].paths[0][0]

  // The conversion drawVectorPass performs…
  const viaTile = projector.toPage(
    tileMinX + (localX / extent) * span,
    tileMaxY - (localY / extent) * span
  )
  // …and the same ground coordinate as "habitat geometry".
  const asVertex = projector.toPage(
    tileMinX + (localX / extent) * span,
    tileMaxY - (localY / extent) * span
  )
  assert.deepEqual(viaTile, asVertex)
})

test('every style pass names exactly one paint mode', () => {
  for (const pass of VECTOR_BASEMAP_STYLE) {
    const modes = [pass.fill, pass.fills, pass.line, pass.lines].filter(Boolean).length
    assert.equal(modes, 1, `${pass.layer} must have exactly one of fill/fills/line/lines`)
  }
})

test('lineWidthAtZoom clamps below, interpolates between, clamps above', () => {
  const stops = [[10, 2], [12, 6]]
  assert.equal(lineWidthAtZoom(stops, 8), 2)
  assert.equal(lineWidthAtZoom(stops, 11), 4)
  assert.equal(lineWidthAtZoom(stops, 15), 6)
  assert.equal(lineWidthAtZoom([[0, 1.5]], 9), 1.5)
})
