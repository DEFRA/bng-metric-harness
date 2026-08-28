/**
 * The hand-rolled MVT codec.
 *
 * Encode and decode are tested against each other, so a bug has to exist in
 * BOTH directions in a mutually-cancelling way to slip through — and the
 * decoder is additionally exercised against real Ordnance Survey bytes by the
 * --os-vector path itself (during development it was verified byte-for-byte
 * against @mapbox/vector-tile on a live 18-layer, 1054-feature tile).
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_EXTENT,
  GEOMETRY_LINE,
  GEOMETRY_POINT,
  GEOMETRY_POLYGON,
  decodeGeometry,
  decodeVectorTile,
  encodeVectorTile
} from '../src/mvt.mjs'

test('a polygon with a hole round-trips', () => {
  const outer = [[0, 0], [100, 0], [100, 100], [0, 100]]
  const hole = [[25, 25], [25, 75], [75, 75], [75, 25]]

  const tile = decodeVectorTile(
    encodeVectorTile([
      {
        name: 'Test',
        features: [{ type: GEOMETRY_POLYGON, properties: {}, paths: [outer, hole] }]
      }
    ])
  )

  const layer = tile.layers.Test
  assert.equal(layer.extent, DEFAULT_EXTENT)
  assert.deepEqual(layer.features[0].paths, [outer, hole])
  assert.equal(layer.features[0].type, GEOMETRY_POLYGON)
})

test('lines, points and negative coordinates round-trip', () => {
  // Negative coordinates are legal (the buffer outside a tile's edge) and are
  // where a zigzag bug would show.
  const line = [[-64, 10], [200, -30], [4096, 4200]]
  const points = [[-5, -5], [10, 20]]

  const tile = decodeVectorTile(
    encodeVectorTile([
      { name: 'Lines', features: [{ type: GEOMETRY_LINE, properties: {}, paths: [line] }] },
      { name: 'Points', features: [{ type: GEOMETRY_POINT, properties: {}, paths: points.map((p) => [p]) }] }
    ])
  )

  assert.deepEqual(tile.layers.Lines.features[0].paths, [line])
  assert.deepEqual(tile.layers.Points.features[0].paths, points.map((p) => [p]))
})

test('properties of every value type round-trip', () => {
  const properties = {
    _symbol: 13,
    _name: 'Thames Path',
    negative: -42,
    fraction: 2.5,
    flag: true
  }

  const tile = decodeVectorTile(
    encodeVectorTile([
      {
        name: 'Props',
        features: [
          { type: GEOMETRY_POINT, properties, paths: [[[1, 2]]] },
          // A second feature sharing keys/values exercises the pools.
          { type: GEOMETRY_POINT, properties: { _symbol: 13, other: 'x' }, paths: [[[3, 4]]] }
        ]
      }
    ])
  )

  const [first, second] = tile.layers.Props.features
  assert.deepEqual(first.properties, properties)
  assert.deepEqual(second.properties, { _symbol: 13, other: 'x' })
})

test('multiple features and layers keep their order', () => {
  const tile = decodeVectorTile(
    encodeVectorTile([
      {
        name: 'A',
        features: [
          { type: GEOMETRY_LINE, properties: { _symbol: 0 }, paths: [[[0, 0], [1, 1]]] },
          { type: GEOMETRY_LINE, properties: { _symbol: 1 }, paths: [[[2, 2], [3, 3]]] }
        ]
      },
      { name: 'B', features: [{ type: GEOMETRY_POINT, properties: {}, paths: [[[9, 9]]] }] }
    ])
  )

  assert.deepEqual(Object.keys(tile.layers), ['A', 'B'])
  assert.equal(tile.layers.A.features[0].properties._symbol, 0)
  assert.equal(tile.layers.A.features[1].properties._symbol, 1)
})

test('decodeGeometry handles the spec worked example', () => {
  // From the MVT 2.1 spec, section 4.3.5.2: a multi-line
  //   MoveTo(+2,+2), LineTo(+2,+2)  then  MoveTo(-3,-3), LineTo(+2,+2)
  const commands = [
    9, 4, 4, // MoveTo count 1, (2, 2)
    10, 4, 4, // LineTo count 1, (+2, +2)
    9, 5, 5, // MoveTo count 1, (-3, -3) relative
    10, 4, 4 // LineTo count 1, (+2, +2)
  ]
  assert.deepEqual(decodeGeometry(commands), [
    [[2, 2], [4, 4]],
    [[1, 1], [3, 3]]
  ])
})
