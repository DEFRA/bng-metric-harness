#!/usr/bin/env node
/**
 * Validate a generated PDF against PDF/UA-1, using veraPDF in Docker.
 *
 *   node src/verify-pdf.mjs                    # out/site-summary.pdf
 *   node src/verify-pdf.mjs out/other.pdf
 *   node src/verify-pdf.mjs --strict           # exit non-zero when invalid
 *
 * veraPDF is the reference open-source PDF/UA validator and is the go/no-go
 * check for BMD-984. It is Java, so it runs from the `verapdf/cli` image
 * rather than being installed — no JDK, and the version is pinned by the tag.
 *
 * What this does NOT tell you: whether the document is *usable*. veraPDF
 * checks that alt text exists, not that it says anything helpful, and it has
 * no opinion on whether the reading order makes sense. Roughly a third of
 * PDF/UA's failure conditions are human judgement. A PASS here is necessary,
 * not sufficient — NVDA and PAC still have to happen.
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const IMAGE = 'verapdf/cli'
const FLAVOUR = 'ua1'
const DEFAULT_PDF = path.resolve(import.meta.dirname, '..', 'out', 'site-summary.pdf')

// One example location per rule is enough to find the problem; the count tells
// you how widespread it is.
const MAX_FAILURES_DISPLAYED = 1

const EXIT_INVALID = 1

function parseArgs(argv) {
  const strict = argv.includes('--strict')
  const target = argv.find((arg) => !arg.startsWith('--'))
  return { strict, pdf: target ? path.resolve(target) : DEFAULT_PDF }
}

function have(command, args) {
  const result = spawnSync(command, args, { stdio: 'ignore' })
  return result.status === 0
}

/**
 * Pull the image on first use, so the first run explains its own pause rather
 * than looking hung.
 */
function ensureImage() {
  if (have('docker', ['image', 'inspect', IMAGE])) {
    return true
  }
  console.log(`Pulling ${IMAGE} (first run only)…`)
  const pull = spawnSync('docker', ['pull', IMAGE], { stdio: 'inherit' })
  return pull.status === 0
}

function runVeraPdf(pdf) {
  const result = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '-v',
      `${path.dirname(pdf)}:/data`,
      IMAGE,
      '--format',
      'xml',
      '--flavour',
      FLAVOUR,
      '--maxfailuresdisplayed',
      String(MAX_FAILURES_DISPLAYED),
      `/data/${path.basename(pdf)}`
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  )
  return result.stdout ?? ''
}

function tag(xml, name) {
  return xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim()
}

/**
 * Pull the failed rules out of veraPDF's XML report.
 *
 * Regex rather than an XML parser, for the same reason `grid.mjs` parses WMTS
 * that way: the shape is known and fixed, and the spike stays dependency-free.
 */
function parseReport(xml) {
  const compliant = /<validationReport[^>]*isCompliant="true"/.test(xml)
  const rules = []

  const pattern =
    /<rule[^>]*clause="([^"]*)"[^>]*testNumber="([^"]*)"[^>]*status="failed"[^>]*failedChecks="(\d+)"[^>]*>([\s\S]*?)<\/rule>/g

  for (const match of xml.matchAll(pattern)) {
    const [, clause, testNumber, failedChecks, body] = match
    rules.push({
      id: `${clause}-${testNumber}`,
      failedChecks: Number(failedChecks),
      description: tag(body, 'description'),
      errorMessage: tag(body, 'errorMessage'),
      context: tag(body, 'context')
    })
  }

  rules.sort((a, b) => b.failedChecks - a.failedChecks)
  return { compliant, rules }
}

/** The last path segment is the useful part of veraPDF's context string. */
function shortContext(context) {
  if (!context) {
    return null
  }
  const parts = context.split('/')
  return parts.slice(-2).join('/')
}

function report({ compliant, rules }, pdf, strict) {
  const name = path.basename(pdf)
  console.log(`\nPDF/UA-1 (veraPDF) — ${name}`)

  if (compliant) {
    console.log('  PASS — no machine-checkable failures.')
    console.log(
      '  Necessary, not sufficient: veraPDF cannot judge whether alt text is\n' +
        '  meaningful or the reading order sensible. NVDA and PAC still apply.'
    )
    return true
  }

  console.log(`  FAIL — ${rules.length} rule${rules.length === 1 ? '' : 's'} not met.\n`)
  for (const rule of rules) {
    console.log(`  ${rule.id}  (${rule.failedChecks} occurrence${rule.failedChecks === 1 ? '' : 's'})`)
    if (rule.description) {
      console.log(`    requires : ${rule.description}`)
    }
    if (rule.errorMessage) {
      console.log(`    problem  : ${rule.errorMessage}`)
    }
    const where = shortContext(rule.context)
    if (where) {
      console.log(`    example  : ${where}`)
    }
    console.log()
  }

  if (!strict) {
    console.log('  (Reporting only — pass --strict to fail the build on this.)')
  }
  return false
}

function main() {
  const { strict, pdf } = parseArgs(process.argv.slice(2))

  if (!fs.existsSync(pdf)) {
    console.error(`No such PDF: ${pdf}\nBuild one first, e.g. \`npm run build\`.`)
    process.exitCode = EXIT_INVALID
    return
  }

  // A missing Docker must not break the build step that ran before this.
  if (!have('docker', ['version'])) {
    console.log('\nPDF/UA-1 (veraPDF) — SKIPPED: docker is not available.')
    console.log('  Install Docker, or run the check elsewhere:')
    console.log(
      `  docker run --rm -v "$PWD/out:/data" ${IMAGE} --format text --flavour ${FLAVOUR} -v /data/${path.basename(pdf)}`
    )
    return
  }

  if (!ensureImage()) {
    console.log(`\nPDF/UA-1 (veraPDF) — SKIPPED: could not pull ${IMAGE}.`)
    return
  }

  const xml = runVeraPdf(pdf)
  if (!xml.includes('<validationReport')) {
    console.error('\nveraPDF produced no report. Raw output:\n' + xml.slice(0, 2000))
    process.exitCode = EXIT_INVALID
    return
  }

  const valid = report(parseReport(xml), pdf, strict)
  if (!valid && strict) {
    process.exitCode = EXIT_INVALID
  }
}

main()
