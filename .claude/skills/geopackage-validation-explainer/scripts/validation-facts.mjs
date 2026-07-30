#!/usr/bin/env node
/**
 * Extract every fact the GeoPackage validation document depends on, and diff
 * against the previous run.
 *
 * The engine explainer proves itself by executing the engine. Validation rules
 * have nothing to execute cheaply — the spatial checks need a live PostGIS —
 * so this skill's equivalent guarantee is a reconciliation across three repos:
 *
 *   backend   which codes exist, where each is raised, the literal message
 *   frontend  whether the user sees bespoke copy, a placeholder, or a catch-all
 *   library   whether a fixture exists that is meant to trigger the code
 *
 * A code that no fixture exercises, or that reaches the user as a generic
 * message, is exactly what the document must not quietly imply is well covered.
 *
 * Usage:
 *   node validation-facts.mjs --out facts.json [--compare facts.json]
 */
import { writeFileSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import {
  HARNESS_ROOT,
  SOURCES,
  locateSource,
  sourceFile,
  readTextFile,
  gitProvenance,
  walkSourceFiles,
  balancedBraceBlock,
  lineOf,
  argValue
} from './_lib.mjs'

const ERRORS_FILE = path.join('src', 'validation', 'baseline', 'errors.js')
const COPY_FILE = path.join('src', 'server', 'error-file', 'single-error-copy.js')
const FLAWS_FILE = path.join('src', 'synthetic', 'flaws.mjs')
/** Codes are raised from the validation pipeline and from the routes, so scan all of src. */
const BACKEND_SOURCE_DIR = 'src'

/** How far after an `ERROR_CODES.X` reference to look for its message literal. */
const MESSAGE_LOOKAHEAD_CHARS = 400
/** How far before it to look for the `makeError(` that owns it. */
const MAKE_ERROR_LOOKBEHIND_CHARS = 80
const MAX_MESSAGE_CHARS = 200

const CODE_KEY_PATTERN = /^ {2}([A-Z][A-Z0-9_]*):/gm
const COPY_STATUS = Object.freeze({
  DEDICATED: 'dedicated',
  PLACEHOLDER: 'placeholder',
  CATCH_ALL: 'catch-all'
})

// ---------------------------------------------------------------- extraction

/** Every code in the backend's ERROR_CODES registry, with its doc comment. */
function extractRegistry(backendDir) {
  const text = readTextFile(path.join(backendDir, ERRORS_FILE))
  const block = balancedBraceBlock(text, text.indexOf('Object.freeze'))
  if (!block) {
    console.error(`Could not parse the ERROR_CODES object in ${ERRORS_FILE}.`)
    process.exit(1)
  }

  const codes = {}
  for (const match of block.matchAll(CODE_KEY_PATTERN)) {
    const [, code] = match
    codes[code] = { description: adjacentDocComment(block.slice(0, match.index)) }
  }
  return codes
}

/**
 * The doc comment immediately above a code, or null.
 *
 * Anchoring a lazy `/** ... *\/` match to the end of the preceding text does
 * NOT work: the scan starts at the FIRST comment in the file, so every code
 * inherits every comment above it glued together. Take the last comment and
 * accept it only when nothing but whitespace separates it from the code.
 */
function adjacentDocComment(preceding) {
  const comments = [...preceding.matchAll(/\/\*\*([\s\S]*?)\*\//g)]
  const last = comments.at(-1)
  if (!last) {
    return null
  }
  const between = preceding.slice(last.index + last[0].length)
  return between.trim() === '' ? collapse(last[1]) : null
}

function collapse(value) {
  return value
    .replaceAll(/\s*\*\s*/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim()
}

const MAKE_ERROR_CALL = 'makeError('

/**
 * The message literal a `makeError(ERROR_CODES.X, '…')` call carries, or null.
 *
 * Two traps, both of which produced wrong messages before they were closed:
 *
 *  - Builder maps are keyed `[ERROR_CODES.X]: () => makeError(ERROR_CODES.X,…)`.
 *    A bare "is there a makeError above me" test matches the *previous* entry's
 *    call from the map key, so require the reference to be the call's FIRST
 *    argument — nothing but whitespace between them.
 *  - Some builders pass a composed message (`redlineInvalidGeometryMessage(p)`)
 *    rather than a literal. Searching far enough ahead then finds the NEXT
 *    entry's literal, so stop the search at the next code or call. No literal
 *    means the message is composed at runtime; null is the honest answer.
 */
function messageAfter(text, referenceIndex, referenceLength) {
  const before = text.slice(
    Math.max(0, referenceIndex - MAKE_ERROR_LOOKBEHIND_CHARS),
    referenceIndex
  )
  const callIndex = before.lastIndexOf(MAKE_ERROR_CALL)
  const NOT_FOUND = -1
  if (callIndex === NOT_FOUND) {
    return null
  }
  if (before.slice(callIndex + MAKE_ERROR_CALL.length).trim() !== '') {
    return null
  }

  const from = referenceIndex + referenceLength
  let window = text.slice(from, from + MESSAGE_LOOKAHEAD_CHARS)
  for (const boundary of ['ERROR_CODES.', MAKE_ERROR_CALL]) {
    const at = window.indexOf(boundary)
    if (at !== NOT_FOUND) {
      window = window.slice(0, at)
    }
  }

  const literal = /'([^']*)'|`([^`]*)`/s.exec(window)
  if (!literal) {
    return null
  }
  const raw = literal[1] ?? literal[2]
  return collapse(raw.replaceAll(/\$\{[^}]*\}/g, '…')).slice(0, MAX_MESSAGE_CHARS)
}

/** Where each code is raised in the backend, and what it says when it is. */
function extractRaiseSites(backendDir, codes) {
  const sites = Object.fromEntries(Object.keys(codes).map((code) => [code, []]))
  const files = walkSourceFiles(path.join(backendDir, BACKEND_SOURCE_DIR), [
    '.js',
    '.mjs',
    '.sql'
  ])

  for (const file of files) {
    const text = readTextFile(file)
    const relative = path.relative(backendDir, file)
    for (const match of text.matchAll(/ERROR_CODES\.([A-Z][A-Z0-9_]*)/g)) {
      const [, code] = match
      if (!sites[code]) {
        continue
      }
      sites[code].push({
        file: relative,
        line: lineOf(text, match.index),
        message: messageAfter(text, match.index, match[0].length)
      })
    }
  }
  return sites
}

/** What the user is actually shown for each code. */
function extractCopyStatus(frontendDir) {
  const text = readTextFile(path.join(frontendDir, COPY_FILE))

  const entriesBlock = balancedBraceBlock(text, text.indexOf('CODE_ENTRIES'))
  const dedicated = new Set(
    entriesBlock
      ? [...entriesBlock.matchAll(CODE_KEY_PATTERN)].map(([, code]) => code)
      : []
  )

  const placeholderBlock = /PLACEHOLDER_ERROR_CODES\s*=\s*new Set\(\[(.*?)\]\)/s.exec(
    text
  )
  const placeholder = new Set(
    placeholderBlock
      ? [...placeholderBlock[1].matchAll(/'([A-Z][A-Z0-9_]*)'/g)].map(
          ([, code]) => code
        )
      : []
  )

  return { dedicated, placeholder }
}

/**
 * Which fixtures in the library are built to trigger which code.
 *
 * Flaw keys are usually quoted but not always (`sliver` is bare), so both forms
 * have to match — miss one and every later flaw is attributed to the last key
 * that did match. The entry object is pushed by reference so `description`
 * lands whether it is declared before or after `errorCode`.
 */
function extractFixtures(libraryDir) {
  const text = readTextFile(path.join(libraryDir, FLAWS_FILE))
  const block = balancedBraceBlock(text, text.indexOf('export const FLAWS'))
  if (!block) {
    console.error(`Could not parse the FLAWS registry in ${FLAWS_FILE}.`)
    process.exit(1)
  }

  const byCode = {}
  let current = null

  for (const line of block.split('\n')) {
    const flawMatch = /^ {2}'?([a-z][\w-]*)'?:\s*\{/.exec(line)
    if (flawMatch) {
      current = { name: flawMatch[1], description: null }
      continue
    }
    if (!current) {
      continue
    }
    const descMatch = /^\s*description:\s*'(.*)'/.exec(line)
    if (descMatch) {
      current.description = descMatch[1]
    }
    const codeMatch = /errorCode:\s*'([A-Z][A-Z0-9_]*)'/.exec(line)
    if (codeMatch) {
      byCode[codeMatch[1]] ??= []
      byCode[codeMatch[1]].push(current)
    }
  }
  return byCode
}

// ------------------------------------------------------------------ tolerances

const POSTGIS_INDEX = path.join(
  'src',
  'validation',
  'baseline',
  'postgis',
  'index.js'
)

/**
 * The numeric thresholds the spatial checks compare against.
 *
 * Extracted rather than written down, because a tolerance is the single most
 * rot-prone thing a description can state: the value lives in a constant, not in
 * any error message, so nothing else in this skill would notice it moving. The
 * document renders these, so no sentence has to assert a number.
 *
 * Only plain numeric declarations are read, including simple products such as
 * `100 * 1000 * 1000`. Anything else is left out rather than guessed at.
 */
function extractTolerances(backendDir) {
  const file = path.join(backendDir, POSTGIS_INDEX)
  if (!existsSync(file)) {
    return {}
  }
  const tolerances = {}
  const pattern = /^const ([A-Z][A-Z0-9_]*)\s*=\s*([\d.\s*]+?)\s*$/gm
  for (const [, name, expression] of readTextFile(file).matchAll(pattern)) {
    const factors = expression.split('*').map((part) => Number(part.trim()))
    if (factors.some(Number.isNaN)) {
      continue
    }
    tolerances[name] = factors.reduce((a, b) => a * b, 1)
  }
  return tolerances
}

// ------------------------------------------------------- example-file fixtures

const EXAMPLE_FILES_DIR = path.join(HARNESS_ROOT, 'example-files')
const EXAMPLE_README = path.join(EXAMPLE_FILES_DIR, 'README.md')

/** The error-code column of the tables in example-files/README.md. */
function readmeClaims() {
  if (!existsSync(EXAMPLE_README)) {
    return {}
  }
  const claims = {}
  let dir = null
  for (const line of readTextFile(EXAMPLE_README).split('\n')) {
    const heading = /^##\s+([\w-]+)\/\s*$/.exec(line)
    if (heading) {
      dir = heading[1]
      continue
    }
    if (!dir || !line.startsWith('|')) {
      continue
    }
    const cells = line.split('|').map((cell) => cell.trim())
    const fileCell = /^`([^`]+\.gpkg)`$/.exec(cells[1] ?? '')
    const codeCell = /^`([A-Z][A-Z0-9_]+)`$/.exec(cells.at(-2) ?? '')
    if (fileCell && codeCell) {
      claims[`${dir}/${fileCell[1]}`] = codeCell[1]
    }
  }
  return claims
}

/**
 * Which .gpkg in example-files/ demonstrates each rule. Nothing here is
 * hand-authored — an earlier version kept a mapping file that had to be
 * remembered whenever a fixture was added or renamed.
 *
 * Two complementary sources, and the precedence between them matters:
 *
 *  - **Observed** (`fixture-map.json`, from observe-fixtures.mjs) — what the real
 *    validation gate reports for each file. Authoritative wherever it has an
 *    opinion, because it is measured rather than claimed.
 *  - **Claimed** (the error-code columns in example-files/README.md) — used only
 *    for files the gate passes. Those files are structurally fine and fail later,
 *    at a stage needing PostGIS that cannot be run here, so the README is the
 *    only available source.
 *
 * Where the README claims a code for a file the gate actually rejects with
 * something else, the observation wins and the disagreement is reported: it means
 * the fixture no longer demonstrates what it was built for.
 */
function extractExampleFixtures(observedByCode, observedByFile) {
  const byCode = {}
  const add = (code, file) => {
    byCode[code] ??= []
    if (!byCode[code].includes(file)) {
      byCode[code].push(file)
    }
  }

  for (const [code, files] of Object.entries(observedByCode)) {
    for (const file of files) {
      add(code, file)
    }
  }

  const contradicted = []
  for (const [file, claimedCode] of Object.entries(readmeClaims())) {
    const observed = observedByFile[file]
    if (observed === undefined) {
      add(claimedCode, file)
      continue
    }
    if (observed.length === 0) {
      add(claimedCode, file)
      continue
    }
    if (!observed.includes(claimedCode)) {
      contradicted.push(
        `${file} — README says ${claimedCode}, the gate reports ${observed.join(', ')}`
      )
    }
  }

  for (const code of Object.keys(byCode)) {
    byCode[code].sort()
  }

  const claimed = new Set(Object.values(byCode).flat())
  const onDisk = existsSync(EXAMPLE_FILES_DIR)
    ? walkSourceFiles(EXAMPLE_FILES_DIR, ['.gpkg']).map((file) =>
        path.relative(EXAMPLE_FILES_DIR, file)
      )
    : []

  return {
    byCode,
    contradicted,
    unclaimed: onDisk.filter((file) => !claimed.has(file)).sort()
  }
}

// ------------------------------------------------------------------ assembly

function buildFacts() {
  const dirs = Object.fromEntries(
    Object.keys(SOURCES).map((key) => [key, locateSource(key)])
  )

  const registry = extractRegistry(dirs.backend)
  const raiseSites = extractRaiseSites(dirs.backend, registry)
  const { dedicated, placeholder } = extractCopyStatus(dirs.frontend)
  const fixtures = extractFixtures(dirs.library)
  const observedPath = argValue('--observed')
  const observed =
    observedPath && existsSync(observedPath)
      ? JSON.parse(readTextFile(observedPath))
      : { byCode: {}, observed: {} }
  const examples = extractExampleFixtures(observed.byCode, observed.observed)
  const tolerances = extractTolerances(dirs.backend)

  const codes = {}
  for (const [code, meta] of Object.entries(registry)) {
    let copy = COPY_STATUS.CATCH_ALL
    if (dedicated.has(code)) {
      copy = COPY_STATUS.DEDICATED
    }
    if (placeholder.has(code) && !dedicated.has(code)) {
      copy = COPY_STATUS.PLACEHOLDER
    }
    codes[code] = {
      description: meta.description,
      copy,
      raisedAt: raiseSites[code] ?? [],
      fixtures: fixtures[code] ?? [],
      exampleFiles: examples.byCode[code] ?? []
    }
  }

  const values = Object.values(codes)
  return {
    generatedAt: new Date().toISOString(),
    provenance: Object.fromEntries(
      Object.entries(dirs).map(([key, dir]) => [key, gitProvenance(dir)])
    ),
    summary: {
      total: values.length,
      dedicatedCopy: values.filter((c) => c.copy === COPY_STATUS.DEDICATED).length,
      placeholderCopy: values.filter((c) => c.copy === COPY_STATUS.PLACEHOLDER)
        .length,
      catchAllCopy: values.filter((c) => c.copy === COPY_STATUS.CATCH_ALL).length,
      withFixture: values.filter((c) => c.fixtures.length > 0).length,
      withExampleFile: values.filter((c) => c.exampleFiles.length > 0).length,
      neverRaised: values.filter((c) => c.raisedAt.length === 0).length
    },
    codes,
    tolerances,
    fixturesWithoutCode: Object.keys(fixtures).filter((code) => !codes[code]),
    exampleFilesContradictingReadme: examples.contradicted,
    exampleFilesClaimedByNoRule: examples.unclaimed
  }
}

// ---------------------------------------------------------------------- diff

/**
 * Everything about a rule that the document renders. If it appears in the
 * document it has to appear here, or check mode reports NO CHANGE and stops
 * without rebuilding, leaving the published document stale.
 */
function fingerprint(entry) {
  const messages = entry.raisedAt
    .map((site) => site.message)
    .filter(Boolean)
    .sort()
  const fixtureNames = entry.fixtures.map((fixture) => fixture.name).sort()
  return JSON.stringify([
    entry.copy,
    messages,
    fixtureNames,
    [...entry.exampleFiles].sort()
  ])
}

function diffFacts(previous, next) {
  const before = new Set(Object.keys(previous.codes ?? {}))
  const after = new Set(Object.keys(next.codes))

  const added = [...after].filter((code) => !before.has(code))
  const removed = [...before].filter((code) => !after.has(code))
  const changed = [...after]
    .filter((code) => before.has(code))
    .filter(
      (code) => fingerprint(previous.codes[code]) !== fingerprint(next.codes[code])
    )

  return { added, removed, changed }
}

function reportDiff(diff) {
  const total = diff.added.length + diff.removed.length + diff.changed.length
  if (total === 0) {
    console.log('\nNO CHANGE — the validation rules match the previous run.')
    return
  }
  console.log(`\nDRIFT — ${total} code(s) differ from the previous run:`)
  const lines = [
    ['added', diff.added],
    ['removed', diff.removed],
    ['changed', diff.changed]
  ]
  for (const [label, codes] of lines) {
    if (codes.length > 0) {
      console.log(`  ${label}: ${codes.join(', ')}`)
    }
  }
}

function reportSummary(facts) {
  const s = facts.summary
  console.log(`Codes in registry:        ${s.total}`)
  console.log(`  bespoke user copy:      ${s.dedicatedCopy}`)
  console.log(`  placeholder copy:       ${s.placeholderCopy}`)
  console.log(`  generic catch-all:      ${s.catchAllCopy}`)
  console.log(`  exercised by a fixture: ${s.withFixture}`)
  console.log(`  has an example .gpkg:   ${s.withExampleFile}`)
  if (facts.exampleFilesContradictingReadme.length > 0) {
    console.log(`\nFixtures that no longer demonstrate what the README claims:`)
    for (const entry of facts.exampleFilesContradictingReadme) {
      console.log(`  ${entry}`)
    }
  }
  if (s.neverRaised > 0) {
    const orphans = Object.entries(facts.codes)
      .filter(([, entry]) => entry.raisedAt.length === 0)
      .map(([code]) => code)
    console.log(`\nDefined but never raised anywhere in src: ${orphans.join(', ')}`)
  }
  if (facts.fixturesWithoutCode.length > 0) {
    console.log(
      `\nFixtures naming an unknown code: ${facts.fixturesWithoutCode.join(', ')}`
    )
  }
}

// ---------------------------------------------------------------------- main

const outPath = argValue('--out')
if (!outPath) {
  console.error('Usage: validation-facts.mjs --out <facts.json> [--compare <facts.json>]')
  process.exit(1)
}

const facts = buildFacts()
reportSummary(facts)

const comparePath = argValue('--compare')
if (comparePath && existsSync(comparePath)) {
  reportDiff(diffFacts(JSON.parse(readTextFile(comparePath)), facts))
} else if (comparePath) {
  console.log('\nNo previous run to compare against — treating this as the baseline.')
}

mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true })
writeFileSync(outPath, `${JSON.stringify(facts, null, 2)}\n`)
console.log(`\nWrote ${outPath}`)
