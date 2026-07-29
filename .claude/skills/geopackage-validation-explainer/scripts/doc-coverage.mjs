#!/usr/bin/env node
/**
 * Reconcile the published document against the extracted facts.
 *
 * This is the mechanical half of the story's acceptance criterion — "they can
 * understand every rule that would cause an upload to be rejected". A human
 * still has to judge *understandable*; this script judges *every*.
 *
 * The document body is deliberately free of error codes, because a reader never
 * sees one. The link between the two therefore lives in the rule index at the
 * end of the document: one row per code, naming the section that explains it.
 * That keeps the prose jargon-free while leaving something a machine can check.
 *
 * Usage:
 *   node doc-coverage.mjs --facts facts.json --doc docs/geopackage-validation-explained.md
 */
import { existsSync } from 'node:fs'
import { readTextFile, argValue } from './_lib.mjs'

const HEADING_PATTERN = /^#{2,6}\s+(.+?)\s*$/gm
const INDEX_ROW_PATTERN = /^\|\s*`?([A-Z][A-Z0-9_]+)`?\s*\|\s*([^|]+?)\s*\|/gm

function normalise(heading) {
  return heading
    .replaceAll(/[`*_]/g, '')
    .replace(/^\d+[a-z]?\.\s*/i, '')
    .trim()
    .toLowerCase()
}

function parseDocument(markdown) {
  const headings = new Set(
    [...markdown.matchAll(HEADING_PATTERN)].map(([, text]) => normalise(text))
  )
  const index = new Map()
  for (const [, code, section] of markdown.matchAll(INDEX_ROW_PATTERN)) {
    index.set(code, section)
  }
  return { headings, index }
}

function report(label, items, detail) {
  if (items.length === 0) {
    return 0
  }
  console.error(`\n${label} (${items.length}):`)
  for (const item of items) {
    console.error(`  - ${detail(item)}`)
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
  console.error(
    `No document at ${docPath}. Generate it first — there is nothing to check yet.`
  )
  process.exit(1)
}

const facts = JSON.parse(readTextFile(factsPath))
const { headings, index } = parseDocument(readTextFile(docPath))
const registryCodes = Object.keys(facts.codes)

const missingFromIndex = registryCodes.filter((code) => !index.has(code))
const unknownInIndex = [...index.keys()].filter((code) => !facts.codes[code])
const danglingSections = [...index.entries()].filter(
  ([, section]) => !headings.has(normalise(section))
)

console.log(`Document:  ${docPath}`)
console.log(`Registry:  ${registryCodes.length} codes`)
console.log(`Indexed:   ${index.size} codes`)

let failures = 0
failures += report(
  'Rules in the code with no entry in the document index',
  missingFromIndex,
  (code) => `${code} — ${facts.codes[code].copy} copy, ${facts.codes[code].raisedAt.length} raise site(s)`
)
failures += report(
  'Index entries naming a code that no longer exists',
  unknownInIndex,
  (code) => code
)
failures += report(
  'Index entries pointing at a section that is not in the document',
  danglingSections,
  ([code, section]) => `${code} → "${section}"`
)

if (failures > 0) {
  console.error(
    `\n${failures} coverage problem(s). The document does not yet describe every rule that can reject an upload.`
  )
  process.exit(1)
}

console.log('\nEvery rule in the registry is indexed to a section that exists.')
