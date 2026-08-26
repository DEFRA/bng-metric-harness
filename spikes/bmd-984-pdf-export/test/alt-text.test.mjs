/**
 * Alt text is not decoration — it is what a screen-reader user hears instead
 * of the map. veraPDF confirms alt text EXISTS; only a test (or a human) can
 * check that it reads correctly.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { plural } from '../src/document.mjs'

test('a count of one is not pluralised', () => {
  assert.equal(plural(1, 'watercourse'), '1 watercourse')
  assert.equal(plural(1, 'habitat parcel'), '1 habitat parcel')
})

test('every other count is', () => {
  assert.equal(plural(0, 'watercourse'), '0 watercourses')
  assert.equal(plural(2, 'hedgerow'), '2 hedgerows')
  assert.equal(plural(20, 'habitat parcel'), '20 habitat parcels')
})
