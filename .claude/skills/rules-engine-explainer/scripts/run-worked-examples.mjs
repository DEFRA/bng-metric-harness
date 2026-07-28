#!/usr/bin/env node
/**
 * Execute worked examples against the real rules engine and render the results
 * as a markdown table.
 *
 * Every multiplier and unit figure in the generated documentation comes from
 * here, so the doc can never claim a number the engine does not actually
 * produce. Each example names an exported engine function and its arguments;
 * the runner calls it and reports what came back.
 *
 * Examples may carry an `expect` object. On a re-run those act as regression
 * assertions: if the engine's answer has moved, the run fails loudly rather
 * than quietly republishing new numbers under old prose.
 *
 * Usage:
 *   node run-worked-examples.mjs <examples.json> [--out <table.md>] [--json <results.json>]
 *
 * Env:
 *   BNG_ENGINE_DIR  Explicit path to the engine package, overriding discovery.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { importEngine, locateEngine } from './_lib.mjs'

/** Multipliers are compared at this tolerance; the engine rounds to 15 sig figs. */
const FLOAT_TOLERANCE = 1e-9

function matches(actual, expected) {
  if (typeof actual === 'number' && typeof expected === 'number') {
    return Math.abs(actual - expected) < FLOAT_TOLERANCE
  }
  return actual === expected
}

function formatValue(value) {
  if (typeof value === 'number') {
    return String(value)
  }
  if (typeof value === 'string') {
    return value
  }
  return JSON.stringify(value)
}

function formatArgs(args) {
  return args
    .map((a) => (a === null || a === undefined ? '—' : formatValue(a)))
    .join(', ')
}

function runExample(engine, example) {
  const fn = engine[example.fn]
  if (typeof fn !== 'function') {
    return {
      ...example,
      status: 'error',
      error: `'${example.fn}' is not an exported engine function`
    }
  }

  let result
  try {
    result = fn(...example.args)
  } catch (error) {
    // A throw can be the documented behaviour (e.g. an impossible habitat/condition
    // pairing), so record it as an outcome rather than aborting the run.
    return { ...example, status: 'threw', error: error.message }
  }

  const failures = []
  for (const [key, expected] of Object.entries(example.expect ?? {})) {
    if (!matches(result[key], expected)) {
      failures.push(`${key}: expected ${formatValue(expected)}, got ${formatValue(result[key])}`)
    }
  }

  return {
    ...example,
    status: failures.length > 0 ? 'drifted' : 'ok',
    result,
    failures
  }
}

function renderTable(results, columns) {
  const header = ['Scenario', 'Inputs', ...columns.map((c) => c.label)]
  const rows = results.map((r) => {
    if (r.status === 'error' || r.status === 'threw') {
      // The rejection message goes in the first data column; the rest have nothing
      // meaningful to show because the calculation never produced a result.
      return [
        r.name,
        `\`${formatArgs(r.args)}\``,
        ...columns.map((_, i) => (i === 0 ? `Rejected — ${r.error}` : '—'))
      ]
    }
    return [
      r.name,
      `\`${formatArgs(r.args)}\``,
      ...columns.map((c) =>
        r.result[c.key] === undefined ? '—' : formatValue(r.result[c.key])
      )
    ]
  })

  const lines = [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map((cells) => `| ${cells.join(' | ')} |`)
  ]
  return lines.join('\n')
}

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string' },
    json: { type: 'string' }
  }
})
const [examplesPath] = positionals
if (!examplesPath) {
  console.error('Usage: node run-worked-examples.mjs <examples.json> [--out <table.md>] [--json <results.json>]')
  process.exit(1)
}
const outPath = flags.out ?? null
const jsonPath = flags.json ?? null

const engineDir = locateEngine()
const engine = await importEngine(engineDir)
console.log(`Engine located at: ${engineDir}`)

const spec = JSON.parse(readFileSync(examplesPath, 'utf8'))
const sections = Array.isArray(spec) ? [{ title: null, examples: spec }] : spec.sections

const rendered = []
const allResults = []

for (const section of sections) {
  const results = section.examples.map((example) => runExample(engine, example))
  allResults.push(...results)
  if (section.title) {
    rendered.push(`### ${section.title}\n`)
  }
  if (section.intro) {
    rendered.push(`${section.intro}\n`)
  }
  rendered.push(renderTable(results, section.columns ?? spec.columns))
  rendered.push('')
}

const drifted = allResults.filter((r) => r.status === 'drifted')
const errored = allResults.filter((r) => r.status === 'error')
const threw = allResults.filter((r) => r.status === 'threw' && !r.expectThrow)

console.log(`Ran ${allResults.length} worked examples.`)

if (outPath) {
  writeFileSync(outPath, `${rendered.join('\n')}\n`)
  console.log(`  Table written to: ${outPath}`)
}
if (jsonPath) {
  writeFileSync(jsonPath, `${JSON.stringify(allResults, null, 2)}\n`)
  console.log(`  Results written to: ${jsonPath}`)
} else if (!outPath) {
  console.log(`\n${rendered.join('\n')}`)
}

for (const r of errored) {
  console.error(`  ERROR   ${r.name}: ${r.error}`)
}
for (const r of threw) {
  console.error(`  THREW   ${r.name}: ${r.error}`)
}
for (const r of drifted) {
  console.error(`  DRIFTED ${r.name}: ${r.failures.join('; ')}`)
}

if (drifted.length > 0 || errored.length > 0) {
  console.error(
    `\n${drifted.length} example(s) drifted and ${errored.length} could not run. ` +
      `The engine's behaviour has changed — update the prose to match before republishing, ` +
      `then refresh the 'expect' blocks in the examples file.`
  )
  process.exit(1)
}
