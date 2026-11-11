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
import {
  detailProblems,
  renderSummary,
  unwordedEntry
} from './dropout-copy-summary.mjs'
import {
  backendDetails,
  backendSurfaces,
  ERROR_TEXT_FILE,
  copyFileIn,
  copyStatusFromCopyFile,
  editCodes,
  extractRaiseSites,
  extractRegistry,
  hasProblemsListKeys,
  hasWordingField,
  missingFromCopyFile,
  uploadEntryCopy
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

const PLACEHOLDER = /\{(\w+)\}/g

function placeholdersIn(...texts) {
  return texts
    .flat(Infinity)
    .filter((text) => typeof text === 'string')
    .flatMap((text) => [...text.matchAll(PLACEHOLDER)].map(([, name]) => name))
}

/**
 * The {values} an entry's heading and detail name, in any of its variants.
 * Its items are left out: an item is a bullet for each habitat the error
 * lists, filled from that habitat, not from the values the backend lists.
 */
function namedValues(inList) {
  const wording = [inList, ...Object.values(inList.variants ?? {})]
  return new Set(
    placeholdersIn(wording.map(({ heading, detail }) => [heading, detail]))
  )
}

/**
 * What the drop-out page wording names that the backend does not send, and
 * the ways the backend words a problem that the wording does not: the
 * frontend shows only its own wording, filled from each error's details.
 *
 * - serviceMessage: entries that show the service's own message
 *   (inList: service-message), which an older frontend still has.
 * - unknownValues: a {value} a heading or detail names that the backend's
 *   ERROR_CODE_DETAILS does not list for the code. An item names a habitat's
 *   values, which the backend does not list, so it is not checked.
 * - unknownVariants / unwordedVariants: a variant only the wording, or only
 *   the backend, has.
 *
 * Null for a backend that predates ERROR_CODE_DETAILS.
 *
 * @param {Record<string, { values?: string[], variants?: string[] }> | null} details
 * @param {Record<string, { inList?: unknown }>} entries the upload section's
 */
export function compareDetails(details, entries) {
  if (!details) {
    return null
  }
  const result = {
    serviceMessage: [],
    unknownValues: [],
    unknownVariants: [],
    unwordedVariants: []
  }
  for (const [code, entry] of Object.entries(entries)) {
    const inList = uploadEntryCopy(entry).list
    if (inList === 'service-message') {
      result.serviceMessage.push(code)
      continue
    }
    // inList: catch-all shows the catch-all title however the service words
    // the problem: it names no values, and needs no variants.
    if (inList === null || typeof inList !== 'object') {
      continue
    }
    const copy = inList
    const { values = [], variants: sent = [] } = details[code] ?? {}
    for (const name of namedValues(copy)) {
      if (!values.includes(name)) {
        result.unknownValues.push({ code, name })
      }
    }
    const worded = Object.keys(copy.variants ?? {})
    for (const variant of worded.filter((v) => !sent.includes(v))) {
      result.unknownVariants.push({ code, variant })
    }
    for (const variant of sent.filter((v) => !worded.includes(v))) {
      result.unwordedVariants.push({ code, variant })
    }
  }
  result.serviceMessage.sort()
  return result
}

function reportList(heading, lines) {
  if (lines.length > 0) {
    console.error(`\n${heading}`)
    for (const line of lines) {
      console.error(`  - ${line}`)
    }
  }
}

function reportDetails(details, copyFile) {
  reportList(
    `${copyFile} shows the service's own technical message for these codes (inList: service-message). Word each in the file, filling any value from the error's details:`,
    details.serviceMessage
  )
  reportList(
    `The wording in ${copyFile} names values the backend does not send with the error (ERROR_CODE_DETAILS in its errors.js), so the page cannot fill them in:`,
    details.unknownValues.map(({ code, name }) => `${code}: {${name}}`)
  )
  reportList(
    `The wording in ${copyFile} has variants the backend never names, so no user sees them:`,
    details.unknownVariants.map(({ code, variant }) => `${code}: ${variant}`)
  )
  reportList(
    `The backend words these errors another way that ${copyFile} has no variant for, so the page shows the error's usual wording instead:`,
    details.unwordedVariants.map(({ code, variant }) => `${code}: ${variant}`)
  )
}

function report(
  { missing, stale, misplaced, edit, details },
  copyFile,
  rules = {},
  wordingField = false
) {
  if (details) {
    reportDetails(details, copyFile)
  }
  const unclassified = missing.filter((code) => rules[code]?.unclassified)
  if (missing.length > 0) {
    console.error(
      `\n${missing.length} backend upload error code${missing.length === 1 ? ' has' : 's have'} no entry in the frontend's ${copyFile}, so a user who meets one sees the catch-all or the service's technical message. Add an entry for each to that file:`
    )
    for (const code of missing) {
      const isNew = unclassified.includes(code) ? ' (new to the explainer)' : ''
      console.error(`  - ${code}${isNew}`)
    }
  }
  if (misplaced?.length > 0) {
    console.error(
      `\nThe upload section of ${copyFile} has entries for codes the backend says are met only on an edit, so the drop-out page never shows them. Move the wording under edit:`
    )
    for (const code of misplaced) {
      console.error(`  - ${code}`)
    }
  }
  if (edit?.missing.length > 0) {
    console.error(
      `\n${edit.missing.length} backend code${edit.missing.length === 1 ? ' refuses' : 's refuse'} an edit made on screen but ${edit.missing.length === 1 ? 'has' : 'have'} no entry in the edit section of ${copyFile}. Add an entry for each: its wording, or ${unwordedEntry(wordingField)} until it has some:`
    )
    for (const code of edit.missing) {
      console.error(`  - ${code}`)
    }
  }
  if (edit?.stale.length > 0) {
    console.error(
      `\nThe edit section of ${copyFile} has entries for codes that refuse no edit. Delete them, or move the wording:`
    )
    for (const code of edit.stale) {
      console.error(`  - ${code}`)
    }
  }
  if (unclassified.length > 0) {
    console.error(
      `\n${unclassified.length} of them ${unclassified.length === 1 ? 'is' : 'are'} new to the validation explainer, so this check cannot tell whether ${unclassified.length === 1 ? 'it refuses' : 'each refuses'} an upload or a change made on screen, which needs no entry. Run /geopackage-validation-explainer to classify ${unclassified.length === 1 ? 'it' : 'them'} before adding copy.`
    )
  }
  if (stale.length > 0) {
    console.error(
      `\n${stale.length === 1 ? '1 entry' : `${stale.length} entries`} in ${copyFile} ${stale.length === 1 ? 'is' : 'are'} for codes the backend no longer defines, so no user sees them. Move the wording to the code's new name, or delete the entry:`
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
 * Each backend code that can refuse an edit, and the edit section's codes:
 * the edit codes it has no entry for, and its entries for codes that refuse
 * no edit. Null when either side predates the split: a backend with no
 * ERROR_CODE_SURFACES, or an error text file with no edit section.
 *
 * @param {Record<string, string[]> | null} surfaces
 * @param {Set<string> | null} inEditSection
 */
export function compareEditCodes(surfaces, inEditSection) {
  if (!surfaces || !inEditSection) {
    return null
  }
  const editable = Object.entries(surfaces)
    .filter(([, where]) => where.includes('edit'))
    .map(([code]) => code)
  return compareCodes(editable, inEditSection)
}

/**
 * Entries in error-text.yaml's upload section for codes the backend says are
 * met only on an edit: wording the drop-out page never shows. Its mirror is
 * compareEditCodes' stale list. Only for error-text.yaml, with the backend's
 * surfaces: the older dropout-copy.yaml predates the split, and keeps an
 * entry for every code.
 *
 * @param {Record<string, string[]> | null} surfaces
 * @param {Set<string>} inUploadSection
 */
export function editOnlyUploadEntries(surfaces, inUploadSection) {
  if (!surfaces) {
    return []
  }
  return [...inUploadSection]
    .filter((code) => surfaces[code] && !surfaces[code].includes('upload'))
    .sort()
}

/**
 * For each code in `codes`: the explainer's plain-English description, unless
 * it is still an unrewritten draft, and the backend's description and raise
 * sites. A code new to the backend has only the backend's, and is
 * `unclassified`: the explainer's descriptions say which codes are edit rules,
 * so this check cannot tell whether a new one is an edit rule, which owes the
 * copy file nothing.
 */
function rulesFor(codes, registry, backendDir, surfaces) {
  if (codes.length === 0) {
    return {}
  }
  // A backend that declares its surfaces has classified every code.
  const classified = surfaces !== null
  const sites = extractRaiseSites(backendDir, registry)
  const plain = existsSync(DESCRIPTIONS_FILE) ? loadDescriptions() : {}
  return Object.fromEntries(
    codes.map((code) => [
      code,
      {
        plain: plain[code]?.drafted ? undefined : plain[code]?.checks,
        unclassified: !classified && !plain[code],
        description: registry[code]?.description,
        raisedAt: sites[code]
      }
    ])
  )
}

function main() {
  const backendDir = locateSource('backend')
  const frontendDir = locateSource('frontend')
  console.log(`Backend:  ${backendDir}`)
  console.log(`Frontend: ${frontendDir}`)
  const copyFile = copyFileIn(frontendDir)
  const copySource = copyFile
    ? readTextFile(path.join(frontendDir, copyFile))
    : null
  const context = {
    copyFile: copyFile ?? ERROR_TEXT_FILE,
    wordingField: copySource !== null && hasWordingField(copySource),
    problemsListKeys: copySource !== null && hasProblemsListKeys(copySource),
    backend: gitProvenance(backendDir),
    frontend: gitProvenance(frontendDir)
  }

  if (!copyFile) {
    console.error(
      `The frontend has no ${ERROR_TEXT_FILE}, so there is nothing to compare. Check whether it was moved or renamed.`
    )
    writeSummary({ noCopyFile: true }, context)
    process.exit(1)
  }

  let surfaces
  try {
    surfaces = backendSurfaces(backendDir)
  } catch (error) {
    console.error(error.message)
    writeSummary({ backendUnreadable: error.message }, context)
    process.exit(1)
  }

  const registry = extractRegistry(backendDir)
  const backendCodes = Object.keys(registry)
  const { inCopyFile, inEditSection, uploadEntries } =
    copyStatusFromCopyFile(copySource)
  const edits = editCodes(backendDir)
  const result = {
    ...compareCodes(backendCodes, inCopyFile, edits),
    misplaced:
      copyFile === ERROR_TEXT_FILE
        ? editOnlyUploadEntries(surfaces, inCopyFile)
        : [],
    edit: compareEditCodes(surfaces, inEditSection),
    details: compareDetails(backendDetails(backendDir), uploadEntries)
  }
  const editCount = backendCodes.filter((code) => edits.has(code)).length
  const counts = {
    uploadCount: backendCodes.length - editCount,
    editCount,
    editChecked: result.edit
      ? Object.values(surfaces).filter((where) => where.includes('edit'))
          .length
      : 0
  }
  const rules = rulesFor(result.missing, registry, backendDir, surfaces)
  writeSummary({ ...result, ...counts }, { ...context, rules })

  const problems =
    result.missing.length +
    result.stale.length +
    result.misplaced.length +
    (result.edit?.missing.length ?? 0) +
    (result.edit?.stale.length ?? 0) +
    detailProblems(result.details)
  if (problems === 0) {
    const editPart = result.edit
      ? ` Every one of the backend's edit codes has an entry in its edit section.`
      : ` The ${editCount} edit rule(s), which the frontend words itself, need none.`
    const detailsPart = result.details
      ? ' The wording names only values the backend sends, words every variant it can name, and shows none of its messages.'
      : ''
    console.log(
      `All ${counts.uploadCount} backend upload error codes have an entry in ${copyFile}, and it has none for any code the backend does not define.${editPart}${detailsPart}`
    )
    return
  }
  report(result, copyFile, rules, context.wordingField)
  process.exit(1)
}

if (isMain(import.meta.url)) {
  main()
}
