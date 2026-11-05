#!/usr/bin/env node
/**
 * Check that the frontend's drop-out page copy (dropout-copy.yaml) and the
 * backend's error codes agree, and exit 1 when they do not.
 *
 * Neither repository's CI can see the other, so a refusal added to the
 * backend with no copy reaches users as the catch-all ("The layer names and
 * column names do not match…") or the backend's technical message, and an
 * entry left behind for a code the backend no longer raises is copy nobody
 * sees. This is the one place both are compared; the harness runs it nightly
 * (.github/workflows/dropout-copy-check.yml).
 *
 * Reads only the backend and the frontend, and needs no installs in either.
 * In GitHub Actions it also writes what it found, for someone who is not a
 * developer, to the job summary (dropout-copy-summary.mjs).
 *
 * Usage:
 *   node check-dropout-copy.mjs
 */
import { appendFileSync, existsSync } from 'node:fs'
import path from 'node:path'

import { gitProvenance, isMain, locateSource, readTextFile } from './_lib.mjs'
import { DESCRIPTIONS_FILE, loadDescriptions } from './build-document.mjs'
import { renderSummary } from './dropout-copy-summary.mjs'
import {
  DROPOUT_COPY_FILE,
  copyStatusFromCopyFile,
  editCodes,
  extractRaiseSites,
  extractRegistry,
  missingFromCopyFile
} from './validation-facts.mjs'

/**
 * The backend codes the copy file has no entry for, and the entries it has for
 * codes the backend does not define. An edit rule refuses a change made on
 * screen, which the frontend words itself, never an upload, so the file owes
 * it no entry; the explainer's missingFromCopyFile leaves it out the same way.
 * An entry the file has for one is not stale, as the backend defines it.
 *
 * @param {Iterable<string>} backendCodes
 * @param {Set<string>} copyCodes
 * @param {Set<string>} [edits] the edit rules' codes
 */
export function compareCodes(backendCodes, copyCodes, edits = new Set()) {
  const backend = new Set(backendCodes)
  return {
    missing: missingFromCopyFile([...backend], copyCodes, edits).sort(),
    stale: [...copyCodes].filter((code) => !backend.has(code)).sort()
  }
}

function report({ missing, stale }, rules = {}) {
  const unclassified = missing.filter((code) => rules[code]?.unclassified)
  if (missing.length > 0) {
    console.error(
      `\n${missing.length} backend upload error code${missing.length === 1 ? ' has' : 's have'} no entry in the frontend's ${DROPOUT_COPY_FILE}, so a user who meets one sees the catch-all or the service's technical message. Add an entry for each to that file:`
    )
    for (const code of missing) {
      const isNew = unclassified.includes(code) ? ' (new to the explainer)' : ''
      console.error(`  - ${code}${isNew}`)
    }
  }
  if (unclassified.length > 0) {
    console.error(
      `\n${unclassified.length} of them ${unclassified.length === 1 ? 'is' : 'are'} new to the validation explainer, so this check cannot tell whether ${unclassified.length === 1 ? 'it refuses' : 'each refuses'} an upload or a change made on screen, which needs no entry. Run /geopackage-validation-explainer to classify ${unclassified.length === 1 ? 'it' : 'them'} before adding copy.`
    )
  }
  if (stale.length > 0) {
    console.error(
      `\n${stale.length === 1 ? '1 entry' : `${stale.length} entries`} in ${DROPOUT_COPY_FILE} ${stale.length === 1 ? 'is' : 'are'} for codes the backend no longer defines, so no user sees them. Move the wording to the code's new name, or delete the entry:`
    )
    for (const code of stale) {
      console.error(`  - ${code}`)
    }
  }
}

/** Write the job summary when running in GitHub Actions. */
function writeSummary(result, context) {
  const file = process.env.GITHUB_STEP_SUMMARY
  if (file) {
    appendFileSync(file, `${renderSummary(result, context)}\n`)
  }
}

/**
 * For each code in `codes`: the explainer's plain-English description, unless
 * it is still an unrewritten draft, and the backend's description and raise
 * sites. A code new to the backend has only the backend's, and is
 * `unclassified`: the explainer's descriptions say which codes are edit rules,
 * so this check cannot tell whether a new one is an edit rule, which owes the
 * copy file nothing.
 */
function rulesFor(codes, registry, backendDir) {
  if (codes.length === 0) {
    return {}
  }
  const sites = extractRaiseSites(backendDir, registry)
  const plain = existsSync(DESCRIPTIONS_FILE) ? loadDescriptions() : {}
  return Object.fromEntries(
    codes.map((code) => [
      code,
      {
        plain: plain[code]?.drafted ? undefined : plain[code]?.checks,
        unclassified: !plain[code],
        description: registry[code]?.description,
        raisedAt: sites[code]
      }
    ])
  )
}

function main() {
  const backendDir = locateSource('backend')
  const frontendDir = locateSource('frontend')
  const copyFile = path.join(frontendDir, DROPOUT_COPY_FILE)
  console.log(`Backend:  ${backendDir}`)
  console.log(`Frontend: ${frontendDir}`)
  const context = {
    copyFile: DROPOUT_COPY_FILE,
    backend: gitProvenance(backendDir),
    frontend: gitProvenance(frontendDir)
  }

  if (!existsSync(copyFile)) {
    console.error(
      `The frontend has no ${DROPOUT_COPY_FILE}, so there is nothing to compare. Check whether it was moved or renamed.`
    )
    writeSummary({ noCopyFile: true }, context)
    process.exit(1)
  }

  const registry = extractRegistry(backendDir)
  const backendCodes = Object.keys(registry)
  const { inCopyFile } = copyStatusFromCopyFile(readTextFile(copyFile))
  const edits = editCodes()
  const result = compareCodes(backendCodes, inCopyFile, edits)
  const editCount = backendCodes.filter((code) => edits.has(code)).length
  const counts = { uploadCount: backendCodes.length - editCount, editCount }
  const rules = rulesFor(result.missing, registry, backendDir)
  writeSummary({ ...result, ...counts }, { ...context, rules })

  if (result.missing.length === 0 && result.stale.length === 0) {
    console.log(
      `All ${counts.uploadCount} backend upload error codes have an entry in ${DROPOUT_COPY_FILE}, and it has none for any code the backend does not define. The ${editCount} edit rule(s), which the frontend words itself, need none.`
    )
    return
  }
  report(result, rules)
  process.exit(1)
}

if (isMain(import.meta.url)) {
  main()
}
