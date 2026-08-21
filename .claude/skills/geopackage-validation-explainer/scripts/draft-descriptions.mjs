#!/usr/bin/env node
/**
 * Create or top up references/rule-descriptions.json so no rule is ever left
 * without a description, and so the file never has to be maintained by hand.
 *
 * A plain-English explanation cannot be derived from the code mechanically — the
 * code says `ST_Area(g) > 0 AND ST_Area(g) < 1`, not "hairline gaps between
 * unsnapped parcels fail". So this does not try to be the final word. It writes a
 * *draft* for every rule that has no entry, using the best evidence available in
 * the facts file, and marks it `"drafted": true`. The skill then has the model
 * rewrite the drafts and drop the flag, in the same run.
 *
 * That split is the point. Existing polished entries are never touched, so a run
 * where nothing changed does no model work at all. A brand-new rule — or a
 * deleted descriptions file — is recreated automatically rather than remembered.
 *
 * Also prunes entries for rules that no longer exist, so a removed rule does not
 * linger.
 *
 * Usage:
 *   node draft-descriptions.mjs --facts facts.json
 */
import { writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { readTextFile, argValue } from './_lib.mjs'

const DESCRIPTIONS_FILE = path.join(
  import.meta.dirname,
  '..',
  'references',
  'rule-descriptions.json'
)

const HEADER = [
  'What each rule checks, in plain English, one entry per code in the backend registry.',
  'Created and topped up by draft-descriptions.mjs, so this file never needs maintaining by hand:',
  'a rule with no entry gets a draft marked "drafted": true, which the skill then has the model rewrite before publishing.',
  'Entries without that flag are settled prose and are never regenerated, which is what keeps a no-change run free of model work.',
  'Keep "checks" to one or two sentences on the condition; no remedies, no code identifiers, and no numbers.',
  'State a threshold by naming its constant in "tolerance" (optionally with wording in "toleranceIs") and the build extracts the value from the code,',
  'so a tolerance can never drift and a renamed constant fails the build instead of publishing a stale figure.'
].join(' ')

/** Group a rule by what its name says about it. Order matches GROUP_ORDER. */
const GROUP_RULES = [
  [/^INVALID_FILENAME$/, 'File name'],
  [/^GPKG_(INVALID_FILE|NOT_A_GEOPACKAGE|MISSING_SYSTEM_TABLE)$/, 'File format'],
  [/^GPKG_(MISSING_LAYER|UNEXPECTED_FEATURE_LAYER)$/, 'Layers'],
  [/SRS/, 'Coordinate reference system'],
  [/GEOMETRY_COLUMN|GEOMETRY_TYPE_NAME|GEOMETRY_REGISTRATION|CONTENTS_DATA_TYPE/, 'Geometry registration and declared type'],
  [/^GPKG_BASELINE_COLUMN|^GPKG_BASELINE_MISSING_COLUMN$/, 'Columns'],
  [/UNREADABLE_GEOMETRY/, 'Unreadable shape data'],
  [/INVALID_GEOMETRY$/, 'Valid shapes'],
  [/NO_POLYGON|TOO_MANY_POLYGONS|NO_REDLINE|NO_HABITAT_AREAS|WRONG_GEOMETRY_TYPE|NO_LINESTRING_GEOMETRY/, 'Shapes present and of the right kind'],
  [/OUTSIDE_REDLINE|OVERLAPS|SLIVERS|AREA_SUM|OUTSIDE_ENGLAND|AREA_TOO_LARGE/, 'How the shapes fit together'],
  [/DISTINCTIVENESS|DUPLICATE_HABITAT_REF|ADVANCE_AND_DELAY/, 'Habitat data'],
  [/^(SIZING_FAILED|INVALID_FILE_METADATA|VALIDATION_FAILED)$/, 'Service faults, not your file']
]

const FALLBACK_GROUP = 'Other rules'

function inferGroup(code) {
  for (const [pattern, group] of GROUP_RULES) {
    if (pattern.test(code)) {
      return group
    }
  }
  return FALLBACK_GROUP
}

function sentence(text) {
  const trimmed = text.trim().replace(/\s+/g, ' ')
  const ended = /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`
  return ended.charAt(0).toUpperCase() + ended.slice(1)
}

/**
 * The best starting point the code offers, in order of usefulness: the registry's
 * own doc comment, then the literal message the rule raises, then the rule name
 * humanised. Whichever it is, it is a draft and is marked as one.
 */
function draftFor(code, entry) {
  if (entry.description) {
    return sentence(entry.description)
  }
  const message = entry.raisedAt.map((site) => site.message).find(Boolean)
  if (message) {
    return sentence(message)
  }
  const words = code
    .replace(/^GPKG_(BASELINE_)?/, '')
    .replaceAll('_', ' ')
    .toLowerCase()
  return sentence(words)
}

const factsPath = argValue('--facts')
if (!factsPath || !existsSync(factsPath)) {
  console.error('Usage: draft-descriptions.mjs --facts <facts.json>')
  process.exit(1)
}

const facts = JSON.parse(readTextFile(factsPath))
const existing = existsSync(DESCRIPTIONS_FILE)
  ? JSON.parse(readTextFile(DESCRIPTIONS_FILE))
  : {}

const next = { _comment: HEADER }
const drafted = []
const pruned = []

for (const [code, entry] of Object.entries(existing)) {
  if (code.startsWith('_')) {
    continue
  }
  if (!facts.codes[code]) {
    pruned.push(code)
    continue
  }
  next[code] = entry
}

for (const [code, entry] of Object.entries(facts.codes)) {
  if (next[code]) {
    continue
  }
  next[code] = {
    group: inferGroup(code),
    checks: draftFor(code, entry),
    drafted: true
  }
  drafted.push(code)
}

writeFileSync(DESCRIPTIONS_FILE, `${JSON.stringify(next, null, 2)}\n`)

const settled = Object.keys(next).filter(
  (code) => !code.startsWith('_') && !next[code].drafted
).length
const outstanding = Object.keys(next).filter((code) => next[code]?.drafted)

console.log(`Descriptions: ${settled} settled, ${outstanding.length} awaiting a rewrite`)
if (pruned.length > 0) {
  console.log(`\nPruned ${pruned.length} entry(ies) for rules that no longer exist:`)
  for (const code of pruned) {
    console.log(`  ${code}`)
  }
}
if (drafted.length > 0) {
  console.log(`\nDrafted ${drafted.length} new entry(ies) from the code:`)
  for (const code of drafted) {
    console.log(`  ${code} — ${next[code].group}`)
  }
}
if (outstanding.length > 0) {
  console.log(
    `\nThese entries are drafts taken from developer-facing text and are not fit to publish.\n` +
      `Rewrite each one for a non-technical reader per references/output-spec.md, then remove its\n` +
      `"drafted" flag:\n` +
      outstanding.map((code) => `  ${code}`).join('\n')
  )
}
