/**
 * Reads the harness's real example GeoPackages — no fixtures of our own, so a
 * decode bug cannot hide behind data written by the same code that reads it.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

import { readSite, assertBngSrs } from '../src/gpkg.mjs'
import { envelopeOf, polygonAreaSqm, lineLengthMetres } from '../src/geometry.mjs'

const EXAMPLES = path.resolve(import.meta.dirname, '../../../example-files/valid')
const BASELINE = path.join(EXAMPLES, 'Baseline - retained watercourse.gpkg')

test('reads a real baseline GeoPackage', () => {
  const site = readSite(BASELINE)

  assert.ok(site.redLine, 'expected a red line boundary')
  assert.equal(site.layers.habitats.features.length, 20)
  assert.equal(site.layers.hedgerows.features.length, 6)
  assert.equal(site.layers.watercourses.features.length, 1)
})

test('every layer declares British National Grid', () => {
  const site = readSite(BASELINE)
  for (const layer of Object.values(site.layers)) {
    assert.equal(layer.srsId, 27700, `${layer.name} should be EPSG:27700`)
  }
})

test('habitat geometry decodes to plausible BNG coordinates', () => {
  const site = readSite(BASELINE)
  const envelope = envelopeOf(site.redLine.geometry)

  // Great Britain's national grid spans roughly 0..700000 E and 0..1300000 N.
  assert.ok(envelope.minX > 0 && envelope.maxX < 700000)
  assert.ok(envelope.minY > 0 && envelope.maxY < 1300000)
})

test('habitat parcels sit inside the red line boundary', () => {
  const site = readSite(BASELINE)
  const redLine = envelopeOf(site.redLine.geometry)

  for (const habitat of site.layers.habitats.features) {
    const envelope = envelopeOf(habitat.geometry)
    assert.ok(envelope.minX >= redLine.minX - 1)
    assert.ok(envelope.maxX <= redLine.maxX + 1)
    assert.ok(envelope.minY >= redLine.minY - 1)
    assert.ok(envelope.maxY <= redLine.maxY + 1)
  }
})

test('computed areas agree with the areas recorded in the file', () => {
  const site = readSite(BASELINE)

  for (const habitat of site.layers.habitats.features) {
    const recorded = Number(habitat.properties.Area)
    if (!Number.isFinite(recorded) || recorded <= 0) {
      continue
    }
    // The `Area` column is whole square metres (MEDIUMINT), and the shoelace
    // area is in square metres because EPSG:27700 coordinates are metres. They
    // should agree to within the rounding of the stored integer — which is a
    // strong independent check on the hand-rolled WKB decoder.
    const computed = polygonAreaSqm(habitat.geometry)
    assert.ok(
      Math.abs(computed - recorded) <= 1,
      `parcel ${habitat.properties['Parcel Ref']}: computed ${computed.toFixed(1)} m² ` +
        `vs recorded ${recorded} m²`
    )
  }
})

test('hedgerow lengths decode to a sensible magnitude', () => {
  const site = readSite(BASELINE)
  for (const hedgerow of site.layers.hedgerows.features) {
    assert.ok(lineLengthMetres(hedgerow.geometry) > 0)
  }
})

test('a non-BNG SRS is rejected loudly', () => {
  assert.throws(() => assertBngSrs(4326, 'test layer'), /expected EPSG:27700/)
})

test('reads a post-intervention GeoPackage too', () => {
  const site = readSite(path.join(EXAMPLES, 'Post-intervention - retained watercourse.gpkg'))
  assert.equal(site.layers.habitats.features.length, 20)
  assert.ok(site.layers.habitats.features[0].properties['Proposed Habitat Type'])
})
