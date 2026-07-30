#!/usr/bin/env node
/**
 * Work out which example .gpkg demonstrates which rule by running the real
 * validation gate over every fixture and recording what it reports.
 *
 * This replaces a hand-written mapping file. That file had to be remembered
 * whenever a fixture was added or renamed, and nothing forced the update — a
 * renamed fixture silently became "no geopackage fixture" in the document, which
 * is a wrong claim rather than a missing one.
 *
 * The gate (`validateGpkg`) is pure JavaScript over SQLite and needs no
 * database, so it can be run here directly. It covers the file-format, layer,
 * column, coordinate-system and shape-presence rules. It does NOT cover the
 * spatial rules, which need PostGIS, or the habitat-data rules, which run later
 * in the pipeline; for those, validation-facts.mjs reads the error-code columns
 * in example-files/README.md instead. Between the two, nothing is hand-authored.
 *
 * Requires the backend's dependencies to be installed, because it loads the
 * native SQLite binding. Exits 1 with guidance if they are not — better than
 * silently producing an empty mapping that would strip every fixture from the
 * document.
 *
 * Usage:
 *   LOG_LEVEL=silent node observe-fixtures.mjs --out fixture-map.json
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import {
  HARNESS_ROOT,
  locateSource,
  walkSourceFiles,
  argValue
} from './_lib.mjs'

const EXAMPLE_FILES_DIR = path.join(HARNESS_ROOT, 'example-files')
const GATE_MODULE = path.join('src', 'validation', 'baseline', 'geopackage.js')

async function loadGate(backendDir) {
  try {
    const module = await import(`file://${path.join(backendDir, GATE_MODULE)}`)
    return module.validateGpkg
  } catch (error) {
    console.error(
      `Could not load the validation gate from ${backendDir}.\n` +
        `This step loads the backend's native SQLite binding, so its dependencies must be installed:\n` +
        `  npm run install:be\n` +
        `It also needs Node 24 — run 'nvm use' first, since a different version breaks the binary.\n\n` +
        `Underlying error: ${error.message}`
    )
    process.exit(1)
  }
}

/** Codes the gate reports for one fixture, or null when it could not be read. */
function observe(validateGpkg, absolutePath) {
  let result
  try {
    result = validateGpkg(readFileSync(absolutePath))
  } catch (error) {
    return { codes: [], failed: error.message }
  }
  const codes = [...new Set((result.errors ?? []).map((error) => error.code))]
  return { codes: codes.sort(), valid: result.valid === true }
}

const outPath = argValue('--out')
if (!outPath) {
  console.error('Usage: observe-fixtures.mjs --out <fixture-map.json>')
  process.exit(1)
}
if (!existsSync(EXAMPLE_FILES_DIR)) {
  console.error(`No example-files directory at ${EXAMPLE_FILES_DIR}.`)
  process.exit(1)
}

const validateGpkg = await loadGate(locateSource('backend'))
const fixtures = walkSourceFiles(EXAMPLE_FILES_DIR, ['.gpkg'])

const byCode = {}
const observed = {}
const unreadable = []
let rejected = 0

for (const absolutePath of fixtures) {
  const relative = path.relative(EXAMPLE_FILES_DIR, absolutePath)
  const { codes, failed } = observe(validateGpkg, absolutePath)
  if (failed) {
    unreadable.push(`${relative} — ${failed}`)
    continue
  }
  observed[relative] = codes
  if (codes.length > 0) {
    rejected += 1
  }
  for (const code of codes) {
    byCode[code] ??= []
    byCode[code].push(relative)
  }
}

for (const code of Object.keys(byCode)) {
  byCode[code].sort()
}

console.log(`Ran the validation gate over ${fixtures.length} example file(s)`)
console.log(`  rejected by the gate: ${rejected}`)
console.log(`  passed the gate:      ${fixtures.length - rejected - unreadable.length}`)
console.log(`  rules demonstrated:   ${Object.keys(byCode).length}`)
if (unreadable.length > 0) {
  console.log(`\nCould not be read:`)
  for (const entry of unreadable) {
    console.log(`  ${entry}`)
  }
}

mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true })
writeFileSync(outPath, `${JSON.stringify({ byCode, observed }, null, 2)}\n`)
console.log(`\nWrote ${outPath}`)
