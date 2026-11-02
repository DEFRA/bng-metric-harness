#!/usr/bin/env node
/**
 * Assemble the validation document from the facts file and the checked-in rule
 * descriptions. Deterministic: same inputs produce a byte-identical document.
 *
 * This is where the skill's runtime went. Earlier versions had the model write
 * the whole document on every run, which meant tracing 50 rules and producing
 * several thousand words each time — and rewording everything even when nothing
 * had changed. Descriptions now live in references/rule-descriptions.json, so a
 * run only needs model attention for codes that are genuinely new.
 *
 * Fails when a registry code has no description. That is the prompt to write
 * one; do not relax it, or the document silently stops covering a rule.
 *
 * Usage:
 *   node build-document.mjs --facts facts.json --out docs/geopackage-validation-explained.md
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { readTextFile, argValue } from './_lib.mjs'

const DESCRIPTIONS_FILE = path.join(
  import.meta.dirname,
  '..',
  'references',
  'rule-descriptions.json'
)

const NO_FIXTURE = 'no geopackage fixture'
const SEEN = {
  dedicated: 'its own message',
  'backend-message': "the service's own message, listing what it names",
  placeholder: 'a placeholder',
  'catch-all': 'a generic message'
}

/**
 * The group for rules raised when a habitat is edited on screen, not on
 * upload. They get a section of their own, after the upload rules, and are
 * left out of every upload count. The upload error page never shows them, so
 * their rows say nothing about what the user sees.
 */
const EDIT_GROUP = 'Edits made on screen'


/** Group order in the document. Any group not listed is appended alphabetically. */
const GROUP_ORDER = [
  'File name',
  'File format',
  'Template version',
  'Layers',
  'Coordinate reference system',
  'Geometry registration and declared type',
  'Columns',
  'Shapes present and of the right kind',
  'Unreadable shape data',
  'Valid shapes',
  'How the shapes fit together',
  'Habitat data',
  'Links to the baseline',
  'Service faults, not your file'
]

function loadDescriptions() {
  const raw = JSON.parse(readTextFile(DESCRIPTIONS_FILE))
  return Object.fromEntries(
    Object.entries(raw).filter(([key]) => !key.startsWith('_'))
  )
}

function groupsInOrder(present) {
  const known = GROUP_ORDER.filter((group) => present.has(group))
  const unknown = [...present]
    .filter((g) => GROUP_ORDER.includes(g) === false)
    .toSorted((left, right) => left.localeCompare(right))
  return [...known, ...unknown]
}

/** Escape a table cell so a path containing a pipe cannot break the row. */
function cell(value) {
  return value.replaceAll('|', '\\|')
}

function ruleCell(code, entry) {
  const fixtures = entry.exampleFiles
  const shown = fixtures.length > 0 ? fixtures.join('; ') : NO_FIXTURE
  return `\`${code}\` — *${cell(shown)}*`
}

const SQ_M_PER_SQ_KM = 1000000

/**
 * Render an extracted constant in the reader's units.
 *
 * The unit comes from the constant's own name suffix, so a renamed constant
 * fails the lookup loudly rather than being rendered with the wrong unit.
 */
function formatTolerance(name, value) {
  if (name.endsWith('_SQ_M')) {
    return value >= SQ_M_PER_SQ_KM
      ? `${value / SQ_M_PER_SQ_KM} km²`
      : `${value} m²`
  }
  if (name.endsWith('_M')) {
    return `${value} m`
  }
  return String(value)
}

/** The generated sentence carrying a rule's threshold, or '' when it has none. */
function toleranceSentence(entry, description, tolerances) {
  const name = description.tolerance
  if (!name) {
    return ''
  }
  if (!(name in tolerances)) {
    console.error(
      `\nDescription for a rule names the tolerance constant ${name}, which was not found in the code.\n` +
        `It has probably been renamed. Update the 'tolerance' field in references/rule-descriptions.json.`
    )
    process.exit(1)
  }
  const shown = formatTolerance(name, tolerances[name])
  const wording = description.toleranceIs ?? 'Tolerance'
  return ` ${wording} ${shown}.`
}

/** Each group's rules, in the order of rule-descriptions.json. */
function rulesByGroup(codes, descriptions) {
  // Row order follows rule-descriptions.json, not the registry. The registry is
  // ordered by how the code grew, which puts "the same rule, for this layer"
  // rows ahead of the general rule they refer back to.
  const byGroup = new Map()
  for (const code of Object.keys(descriptions)) {
    const group = descriptions[code].group
    byGroup.set(group, [...(byGroup.get(group) ?? []), [code, codes[code]]])
  }
  return byGroup
}

function tableRows(rules, descriptions, tolerances, { withSeen }) {
  const lines = ['| Rule and example file | What it checks |', '| --- | --- |']
  for (const [code, entry] of rules) {
    const description = descriptions[code]
    const threshold = toleranceSentence(entry, description, tolerances)
    const seen = withSeen ? ` The user sees ${SEEN[entry.copy]}.` : ''
    lines.push(
      `| ${ruleCell(code, entry)} | ${cell(description.checks)}${threshold}${seen} |`
    )
  }
  return lines
}

function buildTable(codes, descriptions, tolerances) {
  const byGroup = rulesByGroup(codes, descriptions)
  byGroup.delete(EDIT_GROUP)
  const lines = []
  for (const group of groupsInOrder(new Set(byGroup.keys()))) {
    lines.push(
      `### ${group}`,
      '',
      ...tableRows(byGroup.get(group), descriptions, tolerances, {
        withSeen: true
      }),
      ''
    )
  }
  return lines.join('\n')
}

/** The section for rules raised by edits on screen, or '' when there are none. */
function buildEditSection(codes, descriptions, tolerances) {
  const rules = rulesByGroup(codes, descriptions).get(EDIT_GROUP)
  if (!rules) {
    return ''
  }
  return [
    `## ${EDIT_GROUP}`,
    '',
    'These rules refuse a change made to a habitat on screen, after a file has been accepted. They never refuse an upload, so they are not in the counts below.',
    '',
    ...tableRows(rules, descriptions, tolerances, { withSeen: false }),
    '',
    ''
  ].join('\n')
}

/**
 * The counts the document gives, over the upload rules only: the facts
 * summary counts every code in the registry, edit rules included.
 */
function uploadSummary(facts, descriptions) {
  const entries = Object.entries(facts.codes)
    .filter(([code]) => descriptions[code].group !== EDIT_GROUP)
    .map(([, entry]) => entry)
  const withCopy = (copy) => entries.filter((e) => e.copy === copy).length
  return {
    total: entries.length,
    dedicatedCopy: withCopy('dedicated'),
    backendMessageCopy: withCopy('backend-message'),
    placeholderCopy: withCopy('placeholder'),
    catchAllCopy: withCopy('catch-all'),
    withExampleFile: entries.filter((e) => e.exampleFiles.length > 0).length,
    withFixture: entries.filter((e) => e.fixtures.length > 0).length
  }
}

/**
 * Which groups the upload rules with no example file are in, most first:
 * worked out on every run, as any claim about them goes stale as fixtures
 * are added.
 */
function noExampleSentence(facts, descriptions, total) {
  const counts = new Map()
  for (const [code, entry] of Object.entries(facts.codes)) {
    const { group } = descriptions[code]
    if (group !== EDIT_GROUP && entry.exampleFiles.length === 0) {
      counts.set(group, (counts.get(group) ?? 0) + 1)
    }
  }
  const missing = [...counts.values()].reduce((a, b) => a + b, 0)
  if (missing === 0) {
    return `**Every one of the ${total} upload rules has an example file.**`
  }
  const byGroup = [...counts]
    .toSorted(([a, x], [b, y]) => y - x || a.localeCompare(b))
    .map(([group, n]) => `${group} ${n}`)
    .join(', ')
  return `**${missing} of ${total} upload rules have no example file.** By group: ${byGroup}.`
}

/**
 * Which branch each repo was on when the facts were extracted.
 *
 * The siblings are frequently left on feature branches, so this has to report
 * what was read rather than assert `main` — a document built from unmerged work
 * that claims to describe `main` is worse than one that names the branch.
 */
function branchClause(provenance) {
  const REPO_LABELS = [
    ['backend', 'backend'],
    ['frontend', 'frontend'],
    ['library', 'bng-library']
  ]
  const byBranch = new Map()
  for (const [key, label] of REPO_LABELS) {
    const branch = provenance[key]?.branch
    if (branch) {
      byBranch.set(branch, [...(byBranch.get(branch) ?? []), label])
    }
  }

  if (byBranch.size === 0) {
    return ''
  } else if (byBranch.size === 1) {
    const [[onlyBranch]] = byBranch
    return `, all on \`${onlyBranch}\``
  } else {
    const parts = [...byBranch].map(
      ([branch, repos]) => `\`${branch}\` (${repos.join(', ')})`
    )
    return `, on ${parts.join(' and ')}`
  }
}

const SHORT_COMMIT_LENGTH = 7
const ISO_DATE_LENGTH = 10

function buildDocument(facts, descriptions) {
  const s = uploadSummary(facts, descriptions)
  const p = facts.provenance
  const short = (commit) => commit?.slice(0, SHORT_COMMIT_LENGTH) ?? 'unknown'
  const date = facts.generatedAt.slice(0, ISO_DATE_LENGTH)
  const tolerances = facts.tolerances ?? {}

  return `# GeoPackage validation explained

Every rule the BNG Metric service applies to an uploaded GeoPackage: what each one checks, and which example file demonstrates it.

**This document is generated.** Editing it directly will be undone by the next run — change the generator instead, by running \`/geopackage-validation-explainer\` in \`bng-metric-harness\`. It reflects backend \`${short(p.backend?.commit)}\`, frontend \`${short(p.frontend?.commit)}\` and bng-library \`${short(p.library?.commit)}\`${branchClause(p)}, and was generated on ${date}.

For how biodiversity units are calculated once a file is accepted, see [rules-engine-explained.md](rules-engine-explained.md).

## How to read this

Every rule under [The rules](#the-rules) **rejects the upload**: nothing is saved and the file must be corrected and uploaded again. Separately, an accepted file can still contain features that score zero and show as **Incomplete**, when a habitat or condition is not recognised. Those are not upload rules and are not listed here, so a clean upload is not confirmation that every feature was understood.

Two things worth knowing before using the table:

- **The structural rules run first and stop the upload.** Nothing in the geometry or habitat-data groups is reached until the file format, layer, column and coordinate-system rules all pass. Expect to fix a file in two rounds rather than one.
- **What you see on screen often does not identify the rule.** Of ${s.total} rules, ${s.dedicatedCopy} have a message of their own, ${s.backendMessageCopy} show the service's own message as a list of what it names, ${s.placeholderCopy} show a placeholder, and ${s.catchAllCopy} fall back to a generic message about layer and column names when they are the only fault. Each row records which applies.

Example files are paths under \`example-files/\` in this repository, worked out by running the real validation gate over every fixture and recording which rule it reports. That directory is a reference corpus for people, not something the service reads, and \`journey-tests\` and \`backend\` keep their own separate copies — so a rule with an example file here is not necessarily covered by an automated test.

## The rules

${buildTable(facts.codes, descriptions, tolerances)}${buildEditSection(facts.codes, descriptions, tolerances)}## Coverage

| Measure | Count |
| --- | --- |
| Rules that can reject an upload | ${s.total} |
| With a message written for them | ${s.dedicatedCopy} |
| Showing the service's own message, as a list | ${s.backendMessageCopy} |
| Showing a placeholder message | ${s.placeholderCopy} |
| Falling back to a generic message | ${s.catchAllCopy} |
| With an example .gpkg in this repository | ${s.withExampleFile} |
| With a generator flaw that reproduces them | ${s.withFixture} |

${noExampleSentence(facts, descriptions, s.total)}

${facts.exampleFilesClaimedByNoRule.length} \`.gpkg\` files in \`example-files/\` are not mapped to any rule. Most are valid fixtures or real survey data rather than rule demonstrations, so that is expected rather than a gap.

## Known gaps recorded by this run

- In the legacy template, the green infrastructure containment rule cannot fire. Running the real gate over the fixture built to exercise it shows the file rejected as an unexpected layer instead, because that layer is not in the template — so the containment check is never reached. One layer-type rule also cannot fail, because only layers already of the required type are examined. The BNG Service template draws an IGGI on its Vertical Area Habitats layers instead, where the vertical area habitat containment rule checks it.
- In the legacy template, one fixture filed under \`invalid-schema/\` passes validation entirely: the one named for a wrong geometry column name. The legacy gate does not compare column names with the template, only their syntactic validity, so there is nothing for it to trip. The BNG Service template gate does compare them.
- The legacy template's \`Water course enhancement through meanders\` layer is permitted but never read, so no spatial rule is applied to anything in it.
- The message shown when habitat parcels, taken together, overhang the red line boundary tells the reader to redraw "this parcel". That rule names no parcel: it reports the overhang across all of them.
- A file with exactly one fault, other than one shown as the service's own message, gets the least informative message, because the specific technical detail is only listed when there is more than one error.

## Where this comes from

| Repository | Commit | Supplies |
| --- | --- | --- |
| bng-metric-backend | \`${short(p.backend?.commit)}\` | The rules, and the message each one raises |
| bng-metric-frontend | \`${short(p.frontend?.commit)}\` | What the user is shown for each rule |
| bng-library | \`${short(p.library?.commit)}\` | The generator flaws that reproduce fixtures |

Rule descriptions are held in \`references/rule-descriptions.json\` in the skill; the rule list, message status and fixture mapping are extracted from the three repositories on every run.
`
}

// ---------------------------------------------------------------------- main

const factsPath = argValue('--facts')
const outPath = argValue('--out')

if (!factsPath || !outPath) {
  console.error(
    'Usage: build-document.mjs --facts <facts.json> --out <document.md>'
  )
  process.exit(1)
}
if (!existsSync(factsPath)) {
  console.error(
    `No facts file at ${factsPath}. Run validation-facts.mjs first.`
  )
  process.exit(1)
}

const facts = JSON.parse(readTextFile(factsPath))
const descriptions = loadDescriptions()

const undescribed = Object.keys(facts.codes).filter(
  (code) => !descriptions[code]
)
const orphaned = Object.keys(descriptions).filter((code) => !facts.codes[code])

if (undescribed.length > 0) {
  console.error(
    `\n${undescribed.length} rule(s) have no description at all:\n` +
      undescribed.map((code) => `  - ${code}`).join('\n') +
      `\n\nRun draft-descriptions.mjs first — it creates an entry for every rule.`
  )
  process.exit(1)
}
if (orphaned.length > 0) {
  console.error(
    `\n${orphaned.length} description(s) name a rule that no longer exists:\n` +
      orphaned.map((code) => `  - ${code}`).join('\n') +
      `\n\nRun draft-descriptions.mjs, which prunes them.`
  )
  process.exit(1)
}

// Drafts are machine-generated from developer-facing text. The document still
// builds — a run must be able to complete — but publishing one unrewritten
// defeats the point of the story, so say so loudly rather than in passing.
const stillDrafted = Object.keys(facts.codes).filter(
  (code) => descriptions[code].drafted
)

mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true })
writeFileSync(outPath, buildDocument(facts, descriptions))

const upload = uploadSummary(facts, descriptions)
const editRules = Object.keys(facts.codes).length - upload.total
console.log(`Wrote ${outPath}`)
console.log(
  `  ${Object.keys(facts.codes).length} rules, all described: ${upload.total} upload rules, ${editRules} edit rules`
)
console.log(`  ${upload.withExampleFile} upload rules with an example .gpkg`)

if (stillDrafted.length > 0) {
  console.log(
    `\nNOT READY TO PUBLISH — ${stillDrafted.length} description(s) are still machine drafts:\n` +
      stillDrafted.map((code) => `  ${code}`).join('\n') +
      `\n\nRewrite each for a non-technical reader per references/output-spec.md, remove its\n` +
      `"drafted" flag, and rebuild.`
  )
}
