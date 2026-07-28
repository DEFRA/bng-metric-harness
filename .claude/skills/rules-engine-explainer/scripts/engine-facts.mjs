#!/usr/bin/env node
/**
 * Deterministic fact extraction for the BNG rules engine.
 *
 * Locates the engine package wherever it currently lives, then emits a JSON
 * "facts" file describing it: package identity, git provenance, public exports,
 * source-file inventory, and every reference lookup table (small tables verbatim,
 * large ones summarised + hashed).
 *
 * The generated documentation must quote numbers from this file only — never from
 * the model's own reading of the tables. Re-running against a previous facts file
 * (`--compare`) is the drift gate for periodic regeneration.
 *
 * Usage:
 *   node engine-facts.mjs [--out <path>] [--compare <previous-facts.json>]
 *
 * Env:
 *   BNG_ENGINE_DIR  Explicit path to the engine package, overriding discovery.
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { importEngine, locateEngine, WORKSPACE_ROOT } from './_lib.mjs'

const HASH_LENGTH = 12
/** Abbreviated git sha length used in console output. */
const SHORT_SHA_DISPLAY = 8
/** A table with no more than this many leaf values is inlined verbatim. */
const SMALL_TABLE_MAX_LEAVES = 60
/** Number of sample keys shown for a table too large to inline. */
const SAMPLE_KEY_COUNT = 5

function hash(content) {
  return createHash('sha256').update(content).digest('hex').slice(0, HASH_LENGTH)
}

function gitProvenance(engineDir) {
  const repoDir = path.dirname(engineDir)
  try {
    const format = '%H%n%cI%n%s'
    const out = execFileSync(
      'git',
      ['log', '-1', `--format=${format}`, '--', engineDir],
      { cwd: repoDir, encoding: 'utf8' }
    ).trim()
    const [sha, committedAt, subject] = out.split('\n')
    return { repo: path.basename(repoDir), sha, committedAt, subject }
  } catch {
    return { repo: path.basename(repoDir), sha: null }
  }
}

/** Count leaf (non-object) values so we know whether a table can be inlined. */
function countLeaves(value) {
  if (value === null || typeof value !== 'object') {
    return 1
  }
  return Object.values(value).reduce((sum, v) => sum + countLeaves(v), 0)
}

function describeShape(value, depth = 0) {
  if (value === null || typeof value !== 'object') {
    return depth
  }
  const child = Object.values(value)[0]
  return describeShape(child, depth + 1)
}

function collectTables(engineDir) {
  const referenceDir = path.join(engineDir, 'src', 'reference')
  if (!existsSync(referenceDir)) {
    return {}
  }
  const tables = {}
  for (const file of readdirSync(referenceDir).filter((f) =>
    f.endsWith('.json')
  )) {
    const raw = readFileSync(path.join(referenceDir, file), 'utf8')
    const parsed = JSON.parse(raw)
    const leaves = countLeaves(parsed)
    const keys = Object.keys(parsed)
    tables[file] = {
      hash: hash(raw),
      nestingDepth: describeShape(parsed),
      topLevelKeyCount: keys.length,
      leafValueCount: leaves,
      inlined: leaves <= SMALL_TABLE_MAX_LEAVES,
      values: leaves <= SMALL_TABLE_MAX_LEAVES ? parsed : undefined,
      sampleKeys: leaves > SMALL_TABLE_MAX_LEAVES ? keys.slice(0, SAMPLE_KEY_COUNT) : undefined
    }
  }
  return tables
}

function collectSourceFiles(engineDir) {
  const srcDir = path.join(engineDir, 'src')
  const files = {}
  for (const file of readdirSync(srcDir).filter(
    (f) => f.endsWith('.js') && !f.endsWith('.test.js')
  )) {
    const raw = readFileSync(path.join(srcDir, file), 'utf8')
    files[file] = { hash: hash(raw), lines: raw.split('\n').length }
  }
  return files
}

async function collectExports(engineDir) {
  const mod = await importEngine(engineDir)
  const functions = []
  const tables = []
  const constants = {}
  for (const [name, value] of Object.entries(mod)) {
    if (typeof value === 'function') {
      functions.push({ name, arity: value.length })
    } else if (value !== null && typeof value === 'object') {
      tables.push(name)
    } else {
      constants[name] = value
    }
  }
  return {
    functions: functions.sort((a, b) => a.name.localeCompare(b.name)),
    tables: tables.sort(),
    constants
  }
}

function summariseDiff(current, previous) {
  const changes = { tables: [], sourceFiles: [], exports: [] }

  for (const [file, table] of Object.entries(current.referenceTables)) {
    const before = previous.referenceTables?.[file]
    if (!before) {
      changes.tables.push(`ADDED    ${file}`)
    } else if (before.hash !== table.hash) {
      changes.tables.push(
        `CHANGED  ${file} (${before.hash} -> ${table.hash}, ` +
          `${before.leafValueCount} -> ${table.leafValueCount} values)`
      )
    }
  }
  for (const file of Object.keys(previous.referenceTables ?? {})) {
    if (!current.referenceTables[file]) {
      changes.tables.push(`REMOVED  ${file}`)
    }
  }

  for (const [file, meta] of Object.entries(current.sourceFiles)) {
    const before = previous.sourceFiles?.[file]
    if (!before) {
      changes.sourceFiles.push(`ADDED    ${file}`)
    } else if (before.hash !== meta.hash) {
      changes.sourceFiles.push(
        `CHANGED  ${file} (${before.lines} -> ${meta.lines} lines)`
      )
    }
  }
  for (const file of Object.keys(previous.sourceFiles ?? {})) {
    if (!current.sourceFiles[file]) {
      changes.sourceFiles.push(`REMOVED  ${file}`)
    }
  }

  const currentNames = new Set(current.publicApi.functions.map((f) => f.name))
  const previousNames = new Set(
    (previous.publicApi?.functions ?? []).map((f) => f.name)
  )
  for (const name of currentNames) {
    if (!previousNames.has(name)) {
      changes.exports.push(`ADDED    ${name}()`)
    }
  }
  for (const name of previousNames) {
    if (!currentNames.has(name)) {
      changes.exports.push(`REMOVED  ${name}()`)
    }
  }

  return changes
}

function printDiff(changes) {
  const total =
    changes.tables.length + changes.sourceFiles.length + changes.exports.length
  if (total === 0) {
    console.log(
      '\nDrift check: no change to reference tables, engine source, or public API since the previous run.'
    )
    console.log('The existing documentation is still current.')
    return
  }
  console.log(`\nDrift check: ${total} change(s) since the previous run.`)
  const sections = [
    ['Reference tables', changes.tables],
    ['Engine source', changes.sourceFiles],
    ['Public API', changes.exports]
  ]
  for (const [title, entries] of sections) {
    if (entries.length > 0) {
      console.log(`\n  ${title}:`)
      for (const entry of entries) {
        console.log(`    ${entry}`)
      }
    }
  }
}

const { values: args } = parseArgs({
  options: {
    out: { type: 'string' },
    compare: { type: 'string' }
  }
})

// Load the previous facts BEFORE writing the new ones. The intended usage passes
// the same path to --out and --compare (each run becomes the next run's baseline),
// so reading afterwards would always compare the file against itself.
const previousFacts =
  args.compare && existsSync(args.compare)
    ? JSON.parse(readFileSync(args.compare, 'utf8'))
    : null

const engineDir = locateEngine()
const manifest = JSON.parse(
  readFileSync(path.join(engineDir, 'package.json'), 'utf8')
)

console.log(`Engine located at: ${engineDir}`)

const facts = {
  package: {
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    path: path.relative(WORKSPACE_ROOT, engineDir)
  },
  git: gitProvenance(engineDir),
  publicApi: await collectExports(engineDir),
  sourceFiles: collectSourceFiles(engineDir),
  referenceTables: collectTables(engineDir),
  referenceDataProvenance: existsSync(
    path.join(engineDir, 'src', 'reference', 'README.md')
  )
    ? readFileSync(path.join(engineDir, 'src', 'reference', 'README.md'), 'utf8')
    : null
}

console.log(
  `  ${facts.publicApi.functions.length} exported functions, ` +
    `${Object.keys(facts.sourceFiles).length} source files, ` +
    `${Object.keys(facts.referenceTables).length} reference tables`
)

const outPath = args.out ?? path.join(process.cwd(), 'engine-facts.json')
writeFileSync(outPath, `${JSON.stringify(facts, null, 2)}\n`)
console.log(`  Facts written to: ${outPath}`)

if (args.compare) {
  if (previousFacts) {
    console.log(
      `\nComparing against the previous run (engine commit ` +
        `${previousFacts.git?.sha?.slice(0, SHORT_SHA_DISPLAY) ?? 'unknown'}).`
    )
    printDiff(summariseDiff(facts, previousFacts))
  } else {
    console.log(
      `\nNo previous facts file at ${args.compare} — this is a first run, so there is ` +
        `nothing to compare against. Generate the document in full.`
    )
  }
}
