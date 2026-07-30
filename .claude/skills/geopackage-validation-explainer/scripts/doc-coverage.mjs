#!/usr/bin/env node
/**
 * Reconcile the published document against the extracted facts.
 *
 * This is the mechanical half of the story's acceptance criterion — "every rule
 * that would cause an upload to be rejected". A human still has to judge whether
 * the descriptions are understandable; this judges whether they are all there.
 *
 * build-document.mjs already refuses to emit a document with a rule missing, so
 * in a normal run this is a belt-and-braces check on the file that actually
 * landed on disk. It earns its place when someone edits the document by hand, or
 * when the registry gains a code after the document was last built.
 *
 * Also verifies every example-file path in the document exists, so a fixture
 * that is renamed or deleted is caught rather than left as a dead reference.
 *
 * Usage:
 *   node doc-coverage.mjs --facts facts.json --doc docs/geopackage-validation-explained.md
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { HARNESS_ROOT, readTextFile, argValue } from './_lib.mjs'

const RULE_CELL_PATTERN = /^\|\s*`([A-Z][A-Z0-9_]+)`\s*—\s*\*(.+?)\*\s*\|/gm
const NO_FIXTURE = 'no geopackage fixture'
const EXAMPLE_FILES_DIR = path.join(HARNESS_ROOT, 'example-files')

function report(label, items) {
  if (items.length === 0) {
    return 0
  }
  console.error(`\n${label} (${items.length}):`)
  for (const item of items) {
    console.error(`  - ${item}`)
  }
  return items.length
}

const factsPath = argValue('--facts')
const docPath = argValue('--doc')

if (!factsPath || !docPath) {
  console.error('Usage: doc-coverage.mjs --facts <facts.json> --doc <document.md>')
  process.exit(1)
}
if (!existsSync(docPath)) {
  console.error(`No document at ${docPath}. Build it first.`)
  process.exit(1)
}

const facts = JSON.parse(readTextFile(factsPath))
const markdown = readTextFile(docPath)

const documented = new Map()
for (const [, code, fixtures] of markdown.matchAll(RULE_CELL_PATTERN)) {
  documented.set(code, fixtures)
}

const registryCodes = Object.keys(facts.codes)
const missing = registryCodes.filter((code) => !documented.has(code))
const unknown = [...documented.keys()].filter((code) => !facts.codes[code])

const deadPaths = []
for (const [code, fixtures] of documented) {
  if (fixtures === NO_FIXTURE) {
    continue
  }
  for (const fixture of fixtures.split(';').map((f) => f.trim())) {
    if (!existsSync(path.join(EXAMPLE_FILES_DIR, fixture.replaceAll('\\|', '|')))) {
      deadPaths.push(`${code} → ${fixture}`)
    }
  }
}

console.log(`Document: ${docPath}`)
console.log(`Registry: ${registryCodes.length} rules`)
console.log(`Described: ${documented.size} rules`)

let failures = 0
failures += report(
  'Rules in the code with no row in the document',
  missing.map(
    (code) =>
      `${code} — ${facts.codes[code].copy} copy, ${facts.codes[code].raisedAt.length} raise site(s)`
  )
)
failures += report('Rows naming a rule that no longer exists', unknown)
failures += report('Example files referenced but not on disk', deadPaths)

if (failures > 0) {
  console.error(
    `\n${failures} problem(s). The document does not correctly describe every rule that can reject an upload.`
  )
  process.exit(1)
}

console.log('\nEvery rule is described and every example file referenced exists.')
