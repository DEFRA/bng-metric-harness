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
 *   frontend  whether the user sees bespoke copy, the backend's own message,
 *             a placeholder (in a frontend older than the `wording` field),
 *             or a catch-all
 *   library   whether a fixture exists that is meant to trigger the code
 *
 * A code that no fixture exercises, or that reaches the user as a generic
 * message, is exactly what the document must not quietly imply is well covered.
 *
 * Usage:
 *   node validation-facts.mjs --out facts.json [--compare facts.json]
 */
import { writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { load as loadYaml } from 'js-yaml'
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
  argValue,
  isMain
} from './_lib.mjs'
import {
  DESCRIPTIONS_FILE,
  EDIT_GROUP,
  loadDescriptions
} from './build-document.mjs'

const ERRORS_FILE = path.join('src', 'validation', 'geopackage', 'errors.js')
/**
 * The frontend's error text: every customer-facing error message, the drop-out
 * page's under `upload`, in a frontend that has it.
 */
export const ERROR_TEXT_FILE = path.join(
  'src',
  'server',
  'common',
  'error-text',
  'error-text.yaml'
)
/** The drop-out page's copy alone, at the root, in a frontend before the error text. */
export const DROPOUT_COPY_FILE = path.join(
  'src',
  'server',
  'error-file',
  'dropout-copy.yaml'
)

// A header line documenting the `wording` field's "none", as error-text.yaml
// keeps one while no entry needs it.
const DOCUMENTED_WORDING_NONE = /^#.*\bwording: none\b/m

function hasWordingKey(node) {
  if (Array.isArray(node)) {
    return node.some(hasWordingKey)
  }
  if (node !== null && typeof node === 'object') {
    return (
      Object.hasOwn(node, 'wording') || Object.values(node).some(hasWordingKey)
    )
  }
  return false
}

/**
 * Whether the frontend's copy file marks unfinished wording with a `wording`
 * field, as `wording: none` for an entry with no words yet; an older one
 * wrote `placeholder` in the entry's place, which a newer one refuses. Read
 * from the file itself, whose schema decides it: an entry with the field, or
 * a header that documents it.
 *
 * @param {string} source - the copy file's YAML text
 */
export function hasWordingField(source) {
  return (
    DOCUMENTED_WORDING_NONE.test(source) ||
    hasWordingKey(loadYaml(source) ?? {})
  )
}

/** Where the frontend keeps the drop-out page's copy, or null for one that predates both files. */
export function copyFileIn(frontendDir) {
  return (
    [ERROR_TEXT_FILE, DROPOUT_COPY_FILE].find((file) =>
      existsSync(path.join(frontendDir, file))
    ) ?? null
  )
}
const COPY_FILE = path.join('src', 'server', 'error-file', 'single-error-copy.js')
const CONTROLLER_FILE = path.join('src', 'server', 'error-file', 'controller.js')
/**
 * The library's flaw registries, legacy and BNG Service template, each by the
 * export that holds it. REMAPPED_LEGACY_FLAWS gives the code the BNG Service
 * template refuses a legacy flaw with, where it is a different one.
 */
const FLAW_REGISTRIES = [
  { file: path.join('src', 'synthetic', 'flaws.mjs'), exportName: 'FLAWS' },
  {
    file: path.join('src', 'bng-service', 'flaws.mjs'),
    exportName: 'BNG_SERVICE_FLAWS'
  },
  {
    file: path.join('src', 'bng-service', 'flaws.mjs'),
    exportName: 'REMAPPED_LEGACY_FLAWS'
  }
]
/** Codes are raised from the validation pipeline and from the routes, so scan all of src. */
const BACKEND_SOURCE_DIR = 'src'

/** How far after an `ERROR_CODES.X` reference to look for its message literal. */
const MESSAGE_LOOKAHEAD_CHARS = 400
/** How far before it to look for the `makeError(` that owns it. */
const MAKE_ERROR_LOOKBEHIND_CHARS = 80
const MAX_MESSAGE_CHARS = 200

/**
 * The singleProblemPage values (whenAlone in an older frontend) that show a
 * generic message shared by several codes, rather than copy of the code's
 * own: about layer and column names, about the file, or about the service.
 */
const SHARED_FALLBACKS = new Set(['catch-all', 'file-problem', 'service-problem'])

/** What an upload error shows when it is a file's only problem. */
export const ALONE = Object.freeze({
  /** A page of its own wording. */
  OWN: 'own',
  /** Its entry in the problems list, as when the file has other problems. */
  LIST: 'list',
  /** A shared fallback page: the catch-all, file-problem or service-problem. */
  FALLBACK: 'fallback',
  /** The placeholder, in an older frontend's file. */
  PLACEHOLDER: 'placeholder',
  /** None of these: a blank or a typo, which the page shows as the catch-all. */
  UNRECOGNISED: 'unrecognised'
})

/**
 * An upload entry's wording, however the frontend names it. The current
 * frontend names the page an error shows alone `singleProblemPage`, and its
 * entry in the problems list `problemsList`, and leaves `singleProblemPage`
 * out for an error shown in the list even alone. An older one names them
 * `whenAlone` and `inList`, and says `whenAlone: list` for the last.
 *
 * @param {Record<string, unknown> | null | undefined} entry
 * @returns {{ alone: string, single: unknown, list: unknown }}
 */
export function uploadEntryCopy(entry) {
  const current =
    entry != null &&
    (Object.hasOwn(entry, 'singleProblemPage') || Object.hasOwn(entry, 'problemsList'))
  const single = current ? entry.singleProblemPage : entry?.whenAlone
  const list = current ? entry.problemsList : entry?.inList
  return { alone: aloneKind(single, current), single, list }
}

function aloneKind(single, current) {
  if (single !== null && typeof single === 'object') {
    return ALONE.OWN
  }
  if (current ? single === undefined : single === 'list') {
    return ALONE.LIST
  }
  if (SHARED_FALLBACKS.has(single)) {
    return ALONE.FALLBACK
  }
  return !current && single === 'placeholder' ? ALONE.PLACEHOLDER : ALONE.UNRECOGNISED
}

/** True for a frontend whose upload entries use singleProblemPage and problemsList. */
export function hasProblemsListKeys(source) {
  return /^\s+(?:problemsList|singleProblemPage):/m.test(source)
}

const CODE_KEY_PATTERN = /^ {2}([A-Z][A-Z0-9_]*):/gm
const COPY_STATUS = Object.freeze({
  DEDICATED: 'dedicated',
  LIST_COPY: 'list-copy',
  BACKEND_MESSAGE: 'backend-message',
  PLACEHOLDER: 'placeholder',
  CATCH_ALL: 'catch-all'
})

// ---------------------------------------------------------------- extraction

/** Every code in the backend's ERROR_CODES registry, with its doc comment. */
export function extractRegistry(backendDir) {
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
export function extractRaiseSites(backendDir, codes) {
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
export function extractCopyStatus(frontendDir) {
  const copyFile = copyFileIn(frontendDir)
  return copyFile
    ? copyStatusFromCopyFile(readTextFile(path.join(frontendDir, copyFile)))
    : copyStatusFromCode(frontendDir)
}

/**
 * From the copy file (error-text.yaml, or an older frontend's
 * dropout-copy.yaml), read through uploadEntryCopy: a code whose
 * singleProblemPage (whenAlone) is copy has its own message; one with no
 * singleProblemPage (whenAlone: "list") is shown as its list, under its own
 * heading, under the catch-all title for problemsList (inList) "catch-all",
 * which counts as the catch-all, or else, in an older frontend, the
 * backend's message; and "placeholder" shows the
 * placeholder, a value only an older frontend's file has. One that names a
 * shared fallback (catch-all, file-problem or service-problem) shows that
 * generic message, and is counted as the catch-all.
 * `inCopyFile` is every code the file names, so a backend code missing from
 * it can be reported.
 */
export function copyStatusFromCopyFile(source) {
  const document = loadYaml(source) ?? {}
  // error-text.yaml holds the drop-out page's copy under upload; the older
  // dropout-copy.yaml at its root.
  const errors = (document.upload ?? document).errors ?? {}
  const dedicated = new Set()
  const placeholder = new Set()
  const shownAsList = new Set()
  const listCopy = new Set()
  // A singleProblemPage, or whenAlone, that is none of these (a typo such as
  // "catchall") falls to the catch-all on the page, so it is named rather
  // than counted quietly.
  const unrecognised = []
  for (const [code, entry] of Object.entries(errors)) {
    const { alone, list } = uploadEntryCopy(entry)
    if (alone === ALONE.OWN) {
      dedicated.add(code)
    } else if (alone === ALONE.PLACEHOLDER) {
      placeholder.add(code)
    } else if (alone === ALONE.LIST && list !== 'catch-all') {
      shownAsList.add(code)
      if (list?.heading) {
        listCopy.add(code)
      }
    } else if (alone === ALONE.UNRECOGNISED) {
      unrecognised.push(code)
    }
  }
  return {
    dedicated,
    placeholder,
    shownAsList,
    listCopy,
    unrecognised,
    inCopyFile: new Set(Object.keys(errors)),
    // Each upload code's entry, for the check of what its wording names.
    uploadEntries: errors,
    // The codes worded for an edit refused on screen; null in a file with no
    // edit section, which predates it.
    inEditSection: document.edit ? new Set(Object.keys(document.edit)) : null
  }
}

/** For a frontend that predates dropout-copy.yaml, from the copy's code. */
function copyStatusFromCode(frontendDir) {
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

  return {
    dedicated,
    placeholder,
    shownAsList: extractShownAsList(frontendDir),
    listCopy: new Set(),
    inCopyFile: null
  }
}

/**
 * The codes the error page always shows as the backend's message, listing the
 * habitats it names, and never through single-error copy: the lineage codes
 * (the keys of LINEAGE_DESCRIBERS) and TEMPLATE_FILE_ERROR_CODES, in the
 * controller's `isShownAsList`. Missing from a frontend that predates them.
 */
function extractShownAsList(frontendDir) {
  const file = path.join(frontendDir, CONTROLLER_FILE)
  if (!existsSync(file)) {
    return new Set()
  }
  const text = readTextFile(file)
  const codes = new Set()
  const describers = text.indexOf('const LINEAGE_DESCRIBERS')
  const describersBlock =
    describers === -1 ? null : balancedBraceBlock(text, describers)
  for (const [, code] of describersBlock?.matchAll(CODE_KEY_PATTERN) ?? []) {
    codes.add(code)
  }
  const templateBlock =
    /TEMPLATE_FILE_ERROR_CODES\s*=\s*new Set\(\[(.*?)\]\)/s.exec(text)
  for (const [, code] of templateBlock?.[1].matchAll(/'([A-Z][A-Z0-9_]*)'/g) ??
    []) {
    codes.add(code)
  }
  return codes
}

/**
 * Which fixtures in the library are built to trigger which code, from every
 * registry in FLAW_REGISTRIES.
 *
 * Flaw keys are usually quoted but not always (`sliver` is bare), so both forms
 * have to match — miss one and every later flaw is attributed to the last key
 * that did match. An entry may be wrapped in `Object.freeze(`. The entry object
 * is pushed by reference so `description` lands whether it is declared before
 * or after `errorCode`, and on its own line or the next. An `errorCode` that is
 * a constant rather than a quoted code (an outcome such as "accepted") is not
 * a rule, and is skipped.
 */
export function extractFixtures(libraryDir) {
  const byCode = {}
  for (const { file, exportName } of FLAW_REGISTRIES) {
    addRegistryFixtures(byCode, libraryDir, file, exportName)
  }
  return byCode
}

function registryBlock(libraryDir, file, exportName) {
  const text = readTextFile(path.join(libraryDir, file))
  const at = text.indexOf(`export const ${exportName} `)
  const block = at === -1 ? null : balancedBraceBlock(text, at)
  if (!block) {
    console.error(`Could not parse the ${exportName} registry in ${file}.`)
    process.exit(1)
  }
  return block
}

function addRegistryFixtures(byCode, libraryDir, file, exportName) {
  let current = null
  let descriptionNext = false
  for (const line of registryBlock(libraryDir, file, exportName).split('\n')) {
    const flawMatch =
      /^ {2}'?([a-z][\w-]*)'?:\s*(?:Object\.freeze\()?\{/.exec(line)
    if (flawMatch) {
      current = { name: flawMatch[1], description: null }
      descriptionNext = false
      continue
    }
    if (!current) {
      continue
    }
    const quoted = /^\s*['"`](.*)['"`],?$/.exec(line)
    if (descriptionNext && quoted) {
      current.description = quoted[1]
    }
    descriptionNext = /^\s*description:\s*$/.test(line)
    const descMatch = /^\s*description:\s*['"`](.*)['"`]/.exec(line)
    if (descMatch) {
      current.description = descMatch[1]
    }
    const codeMatch = /errorCode:\s*'([A-Z][A-Z0-9_]*)'/.exec(line)
    if (codeMatch) {
      byCode[codeMatch[1]] ??= []
      byCode[codeMatch[1]].push(current)
    }
  }
}

// ------------------------------------------------------------------ tolerances

/**
 * Where the spatial checks' thresholds are declared, newest layout first. The
 * GEOS migration moved them out of postgis/index.js, which no longer exists,
 * into geometry-constants.js as exports; the old path is kept so a checkout
 * from before then still extracts.
 */
const TOLERANCE_FILES = [
  path.join('src', 'validation', 'geopackage', 'geometry-constants.js'),
  path.join('src', 'validation', 'geopackage', 'postgis', 'index.js')
]

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
export function extractTolerances(backendDir) {
  const file = TOLERANCE_FILES.map((name) => path.join(backendDir, name)).find(
    (candidate) => existsSync(candidate)
  )
  if (!file) {
    return {}
  }
  const tolerances = {}
  const pattern =
    /^(?:export )?const ([A-Z][A-Z0-9_]*)\s*=\s*([\d.\s*]+?)\s*$/gm
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

/**
 * The READMEs that say which code each example file is refused with: where,
 * the folder its paths are under, and which column, counting from the end of
 * the row, holds the code. The legacy README's is its last column and quotes
 * the code; the BNG Service template's is `Expected`, third from the end, and
 * does not. A cell that is not a bare code ("accepted", "refused: …") claims
 * nothing.
 */
export const EXAMPLE_READMES = [
  { readme: path.join(EXAMPLE_FILES_DIR, 'README.md'), prefix: '', codeCell: -2 },
  {
    readme: path.join(EXAMPLE_FILES_DIR, 'service-template', 'README.md'),
    prefix: 'service-template/',
    codeCell: -3
  }
]

/** The error-code column of the tables in every README in `readmes`. */
export function readmeClaims(readmes = EXAMPLE_READMES) {
  return Object.assign({}, ...readmes.map(oneReadmeClaims))
}

function oneReadmeClaims({ readme, prefix, codeCell }) {
  if (!existsSync(readme)) {
    return {}
  }
  const claims = {}
  let dir = null
  for (const line of readTextFile(readme).split('\n')) {
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
    const code = /^`?([A-Z][A-Z0-9_]+)`?$/.exec(cells.at(codeCell) ?? '')
    if (fileCell && code) {
      claims[`${prefix}${dir}/${fileCell[1]}`] = code[1]
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
 *  - **Claimed** (the error-code columns of the READMEs in EXAMPLE_READMES) — used only
 *    for files the gate passes. Those files are structurally fine and fail later,
 *    at a stage needing PostGIS that cannot be run here, so the README is the
 *    only available source.
 *
 * Where the README claims a code for a file the gate actually rejects with
 * something else, the observation wins and the disagreement is reported: it means
 * the fixture no longer demonstrates what it was built for.
 */
export function extractExampleFixtures(
  observedByCode,
  observedByFile,
  {
    readmes = EXAMPLE_READMES,
    examplesDir = EXAMPLE_FILES_DIR,
    registryCodes = null
  } = {}
) {
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
  const withoutCode = []
  for (const [file, claimedCode] of Object.entries(readmeClaims(readmes))) {
    // A claim for a code the backend no longer defines would never become a
    // row, yet would hide the file from the unclaimed list.
    if (registryCodes && !registryCodes.has(claimedCode)) {
      withoutCode.push(`${file} — README says ${claimedCode}`)
      continue
    }
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
  const onDisk = existsSync(examplesDir)
    ? walkSourceFiles(examplesDir, ['.gpkg']).map((file) =>
        path.relative(examplesDir, file)
      )
    : []

  return {
    byCode,
    contradicted,
    withoutCode,
    unclaimed: onDisk.filter((file) => !claimed.has(file)).sort()
  }
}

// ------------------------------------------------------------------ assembly

/** What the user is shown for `code`, from the sets extractCopyStatus gives. */
export function copyStatus(
  code,
  { dedicated, placeholder, shownAsList, listCopy = new Set() }
) {
  // Never reaches single-error copy, so neither of the others applies.
  if (shownAsList.has(code)) {
    return listCopy.has(code)
      ? COPY_STATUS.LIST_COPY
      : COPY_STATUS.BACKEND_MESSAGE
  }
  if (dedicated.has(code)) {
    return COPY_STATUS.DEDICATED
  }
  if (placeholder.has(code)) {
    return COPY_STATUS.PLACEHOLDER
  }
  return COPY_STATUS.CATCH_ALL
}

/**
 * The upload codes the copy file has no entry for. An edit rule refuses a
 * change made on screen, never an upload, so the drop-out page never shows
 * it and the file owes it nothing.
 *
 * @param {string[]} codes
 * @param {Set<string>} inCopyFile
 * @param {Set<string>} edits
 */
export function missingFromCopyFile(codes, inCopyFile, edits = new Set()) {
  return codes.filter((code) => !inCopyFile.has(code) && !edits.has(code))
}

/**
 * Where a customer can meet each backend code ("upload", "edit"), as the
 * backend declares it in ERROR_CODE_SURFACES; null for a backend that
 * predates it. errors.js imports nothing today, so it is loaded as it is,
 * with no install. A file that will not load is an error, not an older
 * backend: falling back then would quietly drop the edit check.
 */
export function backendSurfaces(backendDir) {
  let errors
  try {
    errors = createRequire(import.meta.url)(path.join(backendDir, ERRORS_FILE))
  } catch (error) {
    throw new Error(
      `Could not load the backend's ${ERRORS_FILE}, which says where a customer meets each error code: ${error.message}`,
      { cause: error }
    )
  }
  return errors.ERROR_CODE_SURFACES ?? null
}

/**
 * The values and variants each code's details carry for the frontend to word
 * it, as the backend declares them in ERROR_CODE_DETAILS; null for a backend
 * that predates it. Loaded as backendSurfaces loads errors.js.
 */
export function backendDetails(backendDir) {
  const errors = createRequire(import.meta.url)(
    path.join(backendDir, ERRORS_FILE)
  )
  return errors.ERROR_CODE_DETAILS ?? null
}

/**
 * The codes that never reach the drop-out page: those the backend declares
 * are met only on an edit, or, for a backend that predates that, the edit
 * rules by their group in the descriptions (none before they exist).
 */
export function editCodes(backendDir) {
  const surfaces = backendDir ? backendSurfaces(backendDir) : null
  if (surfaces) {
    return new Set(
      Object.entries(surfaces)
        .filter(([, where]) => !where.includes('upload'))
        .map(([code]) => code)
    )
  }
  if (!existsSync(DESCRIPTIONS_FILE)) {
    return new Set()
  }
  return new Set(
    Object.entries(loadDescriptions())
      .filter(([, entry]) => entry.group === EDIT_GROUP)
      .map(([code]) => code)
  )
}

function buildFacts() {
  const dirs = Object.fromEntries(
    Object.keys(SOURCES).map((key) => [key, locateSource(key)])
  )

  const registry = extractRegistry(dirs.backend)
  const raiseSites = extractRaiseSites(dirs.backend, registry)
  const copySets = extractCopyStatus(dirs.frontend)
  const fixtures = extractFixtures(dirs.library)
  const observedPath = argValue('--observed')
  const observed =
    observedPath && existsSync(observedPath)
      ? JSON.parse(readTextFile(observedPath))
      : { byCode: {}, observed: {} }
  const examples = extractExampleFixtures(observed.byCode, observed.observed, {
    registryCodes: new Set(Object.keys(registry))
  })
  const tolerances = extractTolerances(dirs.backend)

  const codes = {}
  for (const [code, meta] of Object.entries(registry)) {
    codes[code] = {
      description: meta.description,
      copy: copyStatus(code, copySets),
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
      listCopy: values.filter((c) => c.copy === COPY_STATUS.LIST_COPY).length,
      backendMessageCopy: values.filter(
        (c) => c.copy === COPY_STATUS.BACKEND_MESSAGE
      ).length,
      placeholderCopy: values.filter((c) => c.copy === COPY_STATUS.PLACEHOLDER)
        .length,
      catchAllCopy: values.filter((c) => c.copy === COPY_STATUS.CATCH_ALL).length,
      withFixture: values.filter((c) => c.fixtures.length > 0).length,
      withExampleFile: values.filter((c) => c.exampleFiles.length > 0).length,
      neverRaised: values.filter((c) => c.raisedAt.length === 0).length
    },
    codes,
    // Where the frontend keeps the drop-out page's copy, and the codes it has
    // no entry for; null for a frontend with no copy file.
    copyFile: copySets.inCopyFile ? copyFileIn(dirs.frontend) : null,
    missingFromCopyFile: copySets.inCopyFile
      ? missingFromCopyFile(
          Object.keys(codes),
          copySets.inCopyFile,
          editCodes(dirs.backend)
        )
      : null,
    unrecognisedWhenAlone: copySets.unrecognised ?? [],
    tolerances,
    fixturesWithoutCode: Object.keys(fixtures).filter((code) => !codes[code]),
    exampleFilesContradictingReadme: examples.contradicted,
    readmeClaimsWithoutCode: examples.withoutCode,
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

/**
 * Facts about the run as a whole rather than one rule. A change to any of
 * these is drift too. The document renders copyFile, so without it check
 * mode would report NO CHANGE over a document that would rebuild differently:
 * the link to a copy file the frontend has just added, say. The document does
 * not render missingFromCopyFile; the run's summary reports it, and a code
 * gaining or losing its entry is drift worth seeing even when the rebuilt
 * document would be the same.
 */
const DOCUMENT_FACTS = ['copyFile', 'missingFromCopyFile']

export function diffFacts(previous, next) {
  const before = new Set(Object.keys(previous.codes ?? {}))
  const after = new Set(Object.keys(next.codes))

  const added = [...after].filter((code) => !before.has(code))
  const removed = [...before].filter((code) => !after.has(code))
  const changed = [...after]
    .filter((code) => before.has(code))
    .filter(
      (code) => fingerprint(previous.codes[code]) !== fingerprint(next.codes[code])
    )

  const documentChanged = DOCUMENT_FACTS.filter(
    (key) =>
      JSON.stringify(previous[key] ?? null) !==
      JSON.stringify(next[key] ?? null)
  )

  return { added, removed, changed, documentChanged }
}

function reportDiff(diff) {
  const codeTotal =
    diff.added.length + diff.removed.length + diff.changed.length
  const documentChanged = diff.documentChanged ?? []
  if (codeTotal === 0 && documentChanged.length === 0) {
    console.log('\nNO CHANGE — the validation rules match the previous run.')
    return
  }
  console.log(`\nDRIFT — ${codeTotal} code(s) differ from the previous run:`)
  if (documentChanged.length > 0) {
    console.log(`  document: ${documentChanged.join(', ')}`)
  }
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
  console.log(
    `Codes in registry:        ${s.total} (upload and edit rules alike; the document counts upload rules only)`
  )
  console.log(`  bespoke user copy:      ${s.dedicatedCopy}`)
  console.log(`  own copy, as a list:    ${s.listCopy}`)
  console.log(`  the backend's message:  ${s.backendMessageCopy}`)
  console.log(`  placeholder copy:       ${s.placeholderCopy}`)
  console.log(`  generic catch-all:      ${s.catchAllCopy}`)
  console.log(`  exercised by a fixture: ${s.withFixture}`)
  console.log(`  has an example .gpkg:   ${s.withExampleFile}`)
  if (facts.unrecognisedWhenAlone?.length > 0) {
    console.log(
      `\nEntries in the frontend's ${facts.copyFile} whose singleProblemPage (whenAlone in an older frontend) is none of its own page, the problems list, placeholder or a shared fallback (shown as the catch-all): ${facts.unrecognisedWhenAlone.join(', ')}`
    )
  }
  if (facts.missingFromCopyFile?.length > 0) {
    console.log(
      `\nCodes with no entry in the frontend's ${facts.copyFile} (shown as the catch-all): ${facts.missingFromCopyFile.join(', ')}`
    )
  }
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
  if (facts.readmeClaimsWithoutCode.length > 0) {
    console.log(`\nREADME entries naming an unknown code:`)
    for (const entry of facts.readmeClaimsWithoutCode) {
      console.log(`  ${entry}`)
    }
  }
}

// ---------------------------------------------------------------------- main

function main() {
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
}

if (isMain(import.meta.url)) {
  main()
}
