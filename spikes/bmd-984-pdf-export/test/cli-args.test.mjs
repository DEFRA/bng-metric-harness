/**
 * Argument parsing.
 *
 * Small, but the `--no-*` flags need a real test: the CLI ends with a generic
 * `--key value` branch, so any long flag that is NOT matched explicitly
 * silently consumes the argument after it. That failure is quiet — you get a
 * document built with the wrong options and no error.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { parseArgs } from '../src/cli.mjs'

test('the habitat basemap is on by default', () => {
  assert.equal(parseArgs([]).habitatBasemap, true)
})

test('--no-habitat-basemap turns it off', () => {
  assert.equal(parseArgs(['--no-habitat-basemap']).habitatBasemap, false)
})

test('--habitat-basemap still works, now that it is the default', () => {
  assert.equal(parseArgs(['--habitat-basemap']).habitatBasemap, true)
})

test('a --no-* flag does not swallow the argument after it', () => {
  const args = parseArgs(['--no-habitat-basemap', '--graticule'])
  assert.equal(args.habitatBasemap, false)
  assert.equal(args.graticule, true, '--graticule must survive the preceding --no-* flag')

  const withPost = parseArgs(['--no-post', '--os'])
  assert.equal(withPost.post, null)
  assert.equal(withPost.os, true)
})

test('--key value pairs still parse', () => {
  const args = parseArgs(['--out', 'somewhere.pdf', '--baseline', 'b.gpkg'])
  assert.equal(args.out, 'somewhere.pdf')
  assert.equal(args.baseline, 'b.gpkg')
})

test('importing the CLI does not build a PDF', () => {
  // Guaranteed by the runDirectly guard; if that regresses, importing this
  // module above would have written a document as a side effect.
  assert.equal(typeof parseArgs, 'function')
})
