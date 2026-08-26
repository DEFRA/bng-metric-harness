import test from 'node:test'
import assert from 'node:assert/strict'

import {
  fitEnvelopeToFrame,
  makeProjector,
  projectorFor
} from '../src/projector.mjs'

const FRAME = { x: 40, y: 60, width: 400, height: 300 }

// A square-ish site somewhere in the Midlands, in EPSG:27700 metres.
const SITE = { minX: 412000, minY: 287000, maxX: 412400, maxY: 287300 }

test('extent corners map to frame corners', () => {
  const projector = makeProjector(SITE, FRAME)

  assert.deepEqual(projector.toPage(SITE.minX, SITE.maxY), [FRAME.x, FRAME.y])
  assert.deepEqual(projector.toPage(SITE.maxX, SITE.minY), [
    FRAME.x + FRAME.width,
    FRAME.y + FRAME.height
  ])
})

test('northing increases upward while page y increases downward', () => {
  const projector = makeProjector(SITE, FRAME)
  const [, highY] = projector.toPage(SITE.minX, SITE.maxY)
  const [, lowY] = projector.toPage(SITE.minX, SITE.minY)

  assert.ok(
    highY < lowY,
    'a higher northing must produce a smaller page y in pdfkit user space'
  )
})

test('x and y share one scale, so nothing is stretched', () => {
  const projector = makeProjector(SITE, FRAME)

  const eastwards = projector.toPage(SITE.minX + 100, SITE.maxY)[0] - FRAME.x
  const northwards = FRAME.y + FRAME.height - projector.toPage(SITE.minX, SITE.minY + 100)[1]

  assert.ok(Math.abs(eastwards - northwards) < 1e-9)
  assert.equal(projector.metresToPoints(100), eastwards)
})

test('fitEnvelopeToFrame matches the frame aspect exactly', () => {
  const wide = { minX: 0, minY: 0, maxX: 1000, maxY: 100 }
  const fitted = fitEnvelopeToFrame(wide, FRAME)

  const fittedAspect = (fitted.maxX - fitted.minX) / (fitted.maxY - fitted.minY)
  assert.ok(Math.abs(fittedAspect - FRAME.width / FRAME.height) < 1e-9)
})

test('fitEnvelopeToFrame grows, never crops', () => {
  for (const envelope of [
    { minX: 0, minY: 0, maxX: 1000, maxY: 100 },
    { minX: 0, minY: 0, maxX: 100, maxY: 1000 }
  ]) {
    const fitted = fitEnvelopeToFrame(envelope, FRAME)
    assert.ok(fitted.minX <= envelope.minX)
    assert.ok(fitted.minY <= envelope.minY)
    assert.ok(fitted.maxX >= envelope.maxX)
    assert.ok(fitted.maxY >= envelope.maxY)
  }
})

test('fitEnvelopeToFrame keeps the site centred', () => {
  const tall = { minX: 0, minY: 0, maxX: 100, maxY: 1000 }
  const fitted = fitEnvelopeToFrame(tall, FRAME)

  assert.ok(
    Math.abs((fitted.minX + fitted.maxX) / 2 - (tall.minX + tall.maxX) / 2) < 1e-9
  )
})

test('a mismatched aspect is rejected rather than silently squashed', () => {
  // This is the failure this module exists to prevent: unequal x/y scales are
  // what make geometry drift against the basemap.
  assert.throws(
    () => makeProjector({ minX: 0, minY: 0, maxX: 1000, maxY: 100 }, FRAME),
    /does not match frame aspect/
  )
})

test('projectorFor pads, squares and builds in one step', () => {
  const projector = projectorFor(SITE, FRAME, { pad: 0.1 })

  assert.ok(projector.extent.minX < SITE.minX)
  assert.ok(projector.extent.maxY > SITE.maxY)
  assert.deepEqual(projector.toPage(projector.extent.minX, projector.extent.maxY), [
    FRAME.x,
    FRAME.y
  ])
})

test('a degenerate envelope is rejected with a useful message', () => {
  assert.throws(
    () => fitEnvelopeToFrame({ minX: 5, minY: 5, maxX: 5, maxY: 5 }, FRAME),
    /degenerate/
  )
})
