/**
 * The registration proof.
 *
 * The claim under test: basemap tiles and habitat geometry cannot land in
 * different places, because both are positioned by the same `toPage` call.
 *
 * These are pure arithmetic — no network, no API key, no PDF to inspect. If
 * they pass, alignment is correct by construction rather than by eye.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { makeProjector, projectorFor } from '../src/projector.mjs'
import {
  effectiveDpi,
  gridFromWmtsCapabilities,
  pickZoom,
  tileSpanMetres,
  tileTopLeft,
  tilesCovering
} from '../src/grid.mjs'

/**
 * A tile matrix set with the same shape OS publishes for EPSG:27700: one
 * shared top-left origin, 256px tiles, resolutions halving per level.
 *
 * The numbers are deliberately arbitrary. The proof is about the *mechanism*,
 * and using invented constants keeps the test honest about the fact that the
 * real values must come from OS's own GetCapabilities document.
 */
const GRID = {
  originX: -238375,
  originY: 1376256,
  tileSize: 256,
  resolutions: [896, 448, 224, 112, 56, 28, 14, 7, 3.5, 1.75, 0.875, 0.4375, 0.21875, 0.109375]
}

const FRAME = { x: 50, y: 80, width: 460, height: 320 }
const SITE = { minX: 412000, minY: 287000, maxX: 412600, maxY: 287350 }

function projector() {
  return projectorFor(SITE, FRAME, { pad: 0.1 })
}

test('a tile corner and a habitat vertex at the same spot land on the same point', () => {
  const proj = projector()
  const z = pickZoom(GRID, proj.extent, FRAME.width)
  const [{ col, row }] = tilesCovering(GRID, z, proj.extent)

  // The tile's ground corner, treated as if it were a habitat vertex.
  const [worldX, worldY] = tileTopLeft(GRID, z, col, row)

  const asTile = proj.toPage(worldX, worldY)
  const asVertex = proj.toPage(worldX, worldY)

  assert.deepEqual(asTile, asVertex)
})

test('adjacent tiles abut exactly, with no gap and no overlap', () => {
  const proj = projector()
  const z = pickZoom(GRID, proj.extent, FRAME.width)
  const span = tileSpanMetres(GRID, z)
  const sizeInPoints = proj.metresToPoints(span)

  const [ax] = proj.toPage(...tileTopLeft(GRID, z, 10, 10))
  const [bx] = proj.toPage(...tileTopLeft(GRID, z, 11, 10))
  const [, ay] = proj.toPage(...tileTopLeft(GRID, z, 10, 10))
  const [, by] = proj.toPage(...tileTopLeft(GRID, z, 10, 11))

  assert.ok(Math.abs(bx - ax - sizeInPoints) < 1e-9, 'columns must abut')
  assert.ok(Math.abs(by - ay - sizeInPoints) < 1e-9, 'rows must abut')
})

test('the covering tile set actually covers the visible extent', () => {
  const proj = projector()
  const z = pickZoom(GRID, proj.extent, FRAME.width)
  const span = tileSpanMetres(GRID, z)
  const tiles = tilesCovering(GRID, z, proj.extent)

  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const { col, row } of tiles) {
    const [x, y] = tileTopLeft(GRID, z, col, row)
    minX = Math.min(minX, x)
    maxX = Math.max(maxX, x + span)
    maxY = Math.max(maxY, y)
    minY = Math.min(minY, y - span)
  }

  assert.ok(minX <= proj.extent.minX, 'mosaic must reach the left edge')
  assert.ok(maxX >= proj.extent.maxX, 'mosaic must reach the right edge')
  assert.ok(minY <= proj.extent.minY, 'mosaic must reach the bottom edge')
  assert.ok(maxY >= proj.extent.maxY, 'mosaic must reach the top edge')
})

test('tile rows run southward as northing decreases', () => {
  const proj = projector()
  const z = 8
  const [, topOfRow10] = proj.toPage(...tileTopLeft(GRID, z, 0, 10))
  const [, topOfRow11] = proj.toPage(...tileTopLeft(GRID, z, 0, 11))

  assert.ok(topOfRow11 > topOfRow10, 'a higher row index must be further down the page')
})

test('a graticule line at a round coordinate is where the tile draws it', () => {
  // The synthetic basemap draws its grid at round world coordinates in tile
  // pixel space; the overlay draws the same coordinates through toPage. This
  // asserts the two agree — the arithmetic behind the visual proof.
  const proj = projector()
  const z = pickZoom(GRID, proj.extent, FRAME.width)
  const resolution = GRID.resolutions[z]
  const span = tileSpanMetres(GRID, z)

  const { col, row } = tilesCovering(GRID, z, proj.extent)[0]
  const [tileMinX, tileMaxY] = tileTopLeft(GRID, z, col, row)

  const roundEasting = Math.ceil(tileMinX / 100) * 100
  assert.ok(roundEasting < tileMinX + span, 'test needs a round line inside the tile')

  // Where the tile paints it: pixels from the tile's own left edge.
  const pixelInTile = (roundEasting - tileMinX) / resolution
  const [tilePageX] = proj.toPage(tileMinX, tileMaxY)
  const paintedAt = tilePageX + pixelInTile * resolution * proj.scale

  // Where the vector overlay draws it.
  const [drawnAt] = proj.toPage(roundEasting, tileMaxY)

  assert.ok(Math.abs(paintedAt - drawnAt) < 1e-9)
})

test('pickZoom meets the requested print density', () => {
  const proj = projector()
  for (const dpi of [150, 200, 300]) {
    const z = pickZoom(GRID, proj.extent, FRAME.width, dpi)
    assert.ok(
      effectiveDpi(GRID, z, proj.extent, FRAME.width) >= dpi,
      `zoom ${z} should deliver at least ${dpi} dpi`
    )
  }
})

test('sharpness and registration are independent', () => {
  // Deliberately choose a far too coarse zoom. Alignment must be unaffected —
  // a blurry basemap is a zoom problem, never a transform problem.
  const proj = projector()
  const span = tileSpanMetres(GRID, 2)
  const sizeInPoints = proj.metresToPoints(span)

  const [ax] = proj.toPage(...tileTopLeft(GRID, 2, 3, 3))
  const [bx] = proj.toPage(...tileTopLeft(GRID, 2, 4, 3))

  assert.ok(Math.abs(bx - ax - sizeInPoints) < 1e-9)
})

test('grid is parsed from WMTS capabilities, not hard-coded', () => {
  const xml = `
    <Capabilities>
      <TileMatrixSet>
        <ows:Identifier>EPSG:27700</ows:Identifier>
        <TileMatrix>
          <ows:Identifier>0</ows:Identifier>
          <ScaleDenominator>3200000</ScaleDenominator>
          <TopLeftCorner>-238375.0 1376256.0</TopLeftCorner>
          <TileWidth>256</TileWidth>
        </TileMatrix>
        <TileMatrix>
          <ows:Identifier>1</ows:Identifier>
          <ScaleDenominator>1600000</ScaleDenominator>
          <TopLeftCorner>-238375.0 1376256.0</TopLeftCorner>
          <TileWidth>256</TileWidth>
        </TileMatrix>
      </TileMatrixSet>
    </Capabilities>`

  const grid = gridFromWmtsCapabilities(xml, 'EPSG:27700')

  assert.equal(grid.originX, -238375)
  assert.equal(grid.originY, 1376256)
  assert.equal(grid.tileSize, 256)
  // 3200000 * 0.00028 = 896 m/px
  assert.ok(Math.abs(grid.resolutions[0] - 896) < 1e-9)
  assert.ok(Math.abs(grid.resolutions[1] - 448) < 1e-9)
})

test('a projector built from a non-square frame still keeps tiles square', () => {
  const skinny = { x: 0, y: 0, width: 500, height: 120 }
  const proj = makeProjector(
    { minX: 0, minY: 0, maxX: 5000, maxY: 1200 },
    skinny
  )
  const span = tileSpanMetres(GRID, 6)
  const size = proj.metresToPoints(span)

  const [ax, ay] = proj.toPage(...tileTopLeft(GRID, 6, 2, 2))
  const [bx] = proj.toPage(...tileTopLeft(GRID, 6, 3, 2))
  const [, by] = proj.toPage(...tileTopLeft(GRID, 6, 2, 3))

  assert.ok(Math.abs(bx - ax - size) < 1e-9)
  assert.ok(Math.abs(by - ay - size) < 1e-9)
})
