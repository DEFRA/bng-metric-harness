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
 * INVALID_FILENAME sits outside the gate entirely — it is a Joi check on the
 * upload's own filename, not on anything inside the file — so the gate never
 * reports it no matter what a fixture is named. This script checks each
 * fixture's basename against the backend's own SAFE_FILENAME_RE /
 * MAX_FILENAME_LENGTH directly, for the same reason the gate is run rather
 * than hand-described: measured, not authored.
 *
 * When a fixture's name fails that check, INVALID_FILENAME REPLACES whatever
 * the gate reports rather than joining it: the real route rejects the
 * filename before the upload is even downloaded (see
 * `validate-geopackage-route.js`), so the gate genuinely never runs against
 * that file's content. Reporting both would claim a fixture demonstrates a
 * rule it can never actually reach.
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
  argValue,
  runGit
} from './_lib.mjs'

const EXAMPLE_FILES_DIR = path.join(HARNESS_ROOT, 'example-files')
const GATE_MODULE = path.join(
  'src',
  'validation',
  'geopackage',
  'geopackage.js'
)
const FILENAME_RULES_MODULE = path.join(
  'src',
  'validation',
  'project-shared-schemas.js'
)
const INVALID_FILENAME_CODE = 'INVALID_FILENAME'
const JSON_INDENT = 2

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

/** The backend's own filename rule, loaded rather than copied so it cannot drift. */
async function loadFilenameRule(backendDir) {
  try {
    const module = await import(
      `file://${path.join(backendDir, FILENAME_RULES_MODULE)}`
    )
    return {
      safeFilenameRe: module.SAFE_FILENAME_RE,
      maxFilenameLength: module.MAX_FILENAME_LENGTH
    }
  } catch (error) {
    console.error(
      `Could not load the filename rule from ${backendDir}.\n\n` +
        `Underlying error: ${error.message}`
    )
    process.exit(1)
  }
}

/**
 * Whether the fixture's own filename would be rejected on upload — the same
 * test the backend applies to the upload metadata, applied here to the
 * fixture's basename (the directory path is a harness organisation detail,
 * not part of the name a real upload would carry).
 */
function isInvalidFilename(relative, { safeFilenameRe, maxFilenameLength }) {
  const name = path.basename(relative)
  return !safeFilenameRe.test(name) || name.length > maxFilenameLength
}

/**
 * The fixture paths git knows about, or null when git cannot answer.
 *
 * A stray .gpkg in a working copy — real survey data, a file being triaged — is
 * observed like any other and would be cited in the published document as the
 * example for a rule, where nobody else can find it and the coverage check fails
 * for them. The document has to describe the committed corpus, so untracked
 * files are skipped and reported rather than silently used.
 *
 * -z is required: fixture names contain spaces, which git otherwise quotes.
 *
 * null disables that guard entirely — every file on disk is then treated as
 * tracked, which is exactly the silent failure mode this function exists to
 * prevent — so a git failure here is reported loudly, not swallowed. It can
 * happen on a machine `runGit`'s fixed PATH does not cover (see its doc
 * comment in _lib.mjs).
 */
function trackedFixtures() {
  try {
    const listed = runGit(['ls-files', '-z', '--', '*.gpkg'], EXAMPLE_FILES_DIR)
    return new Set(listed.split('\0').filter(Boolean))
  } catch (error) {
    console.warn(
      `Could not ask git which fixtures are tracked — every file on disk under ` +
        `${EXAMPLE_FILES_DIR} will be treated as tracked, disabling the guard ` +
        `against citing an untracked fixture in the document.\n` +
        `Underlying error: ${error.message}`
    )
    return null
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
  return {
    codes: codes.toSorted((left, right) => left.localeCompare(right)),
    valid: result.valid === true
  }
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

const backendDir = locateSource('backend')
const validateGpkg = await loadGate(backendDir)
const filenameRule = await loadFilenameRule(backendDir)
const tracked = trackedFixtures()
const onDisk = walkSourceFiles(EXAMPLE_FILES_DIR, ['.gpkg']).map(
  (absolutePath) => ({
    absolutePath,
    relative: path.relative(EXAMPLE_FILES_DIR, absolutePath)
  })
)
const isTracked = ({ relative }) => tracked === null || tracked.has(relative)
const isUntracked = ({ relative }) =>
  tracked !== null && tracked.has(relative) === false
const fixtures = onDisk.filter(isTracked)
const untracked = onDisk.filter(isUntracked).map(({ relative }) => relative)

const byCode = {}
const observed = {}
const unreadable = []
let rejected = 0

for (const { absolutePath, relative } of fixtures) {
  const { codes: gateCodes, failed } = observe(validateGpkg, absolutePath)
  if (failed) {
    unreadable.push(`${relative} — ${failed}`)
    continue
  }
  // A rejected filename stops the real route before the gate ever sees the
  // file's content, so it takes priority over whatever the gate reports.
  const codes = isInvalidFilename(relative, filenameRule)
    ? [INVALID_FILENAME_CODE]
    : gateCodes
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
  byCode[code] = byCode[code].toSorted((left, right) =>
    left.localeCompare(right)
  )
}

console.log(`Ran the validation gate over ${fixtures.length} example file(s)`)
console.log(`  rejected (gate or filename): ${rejected}`)
console.log(
  `  passed both:                ${fixtures.length - rejected - unreadable.length}`
)
console.log(`  rules demonstrated:   ${Object.keys(byCode).length}`)
if (untracked.length > 0) {
  console.log(
    `\nSkipped ${untracked.length} untracked file(s) — not in the repository, so the document cannot cite them:`
  )
  for (const relative of untracked) {
    console.log(`  ${relative}`)
  }
}
if (unreadable.length > 0) {
  console.log(`\nCould not be read:`)
  for (const entry of unreadable) {
    console.log(`  ${entry}`)
  }
}

mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true })
writeFileSync(
  outPath,
  `${JSON.stringify({ byCode, observed }, null, JSON_INDENT)}\n`
)
console.log(`\nWrote ${outPath}`)
