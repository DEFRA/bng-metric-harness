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
  placeholder: 'a placeholder',
  'catch-all': 'a generic message'
}

/** Group order in the document. Any group not listed is appended alphabetically. */
const GROUP_ORDER = [
  'File format',
  'Layers',
  'Coordinate reference system',
  'Geometry registration and declared type',
  'Columns',
  'Shapes present and of the right kind',
  'Unreadable shape data',
  'Valid shapes',
  'How the shapes fit together',
  'Habitat data',
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
  const unknown = [...present].filter((g) => !GROUP_ORDER.includes(g)).sort()
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

function buildTable(codes, descriptions, tolerances) {
  // Row order follows rule-descriptions.json, not the registry. The registry is
  // ordered by how the code grew, which puts "the same rule, for this layer"
  // rows ahead of the general rule they refer back to.
  const byGroup = new Map()
  for (const code of Object.keys(descriptions)) {
    const group = descriptions[code].group
    byGroup.set(group, [...(byGroup.get(group) ?? []), [code, codes[code]]])
  }

  const lines = []
  for (const group of groupsInOrder(new Set(byGroup.keys()))) {
    lines.push(`### ${group}`, '')
    lines.push('| Rule and example file | What it checks |')
    lines.push('| --- | --- |')
    for (const [code, entry] of byGroup.get(group)) {
      const description = descriptions[code]
      const threshold = toleranceSentence(entry, description, tolerances)
      const seen = SEEN[entry.copy]
      lines.push(
        `| ${ruleCell(code, entry)} | ${cell(description.checks)}${threshold} The user sees ${seen}. |`
      )
    }
    lines.push('')
  }
  return lines.join('\n')
}

function buildDocument(facts, descriptions) {
  const codes = Object.keys(facts.codes)
  const s = facts.summary
  const p = facts.provenance
  const short = (commit) => commit?.slice(0, 7) ?? 'unknown'
  const date = facts.generatedAt.slice(0, 10)
  const noFixture = codes.filter((c) => facts.codes[c].exampleFiles.length === 0)

  return `# GeoPackage validation explained

Every rule the BNG Metric service applies to an uploaded GeoPackage: what each one checks, and which example file demonstrates it.

**This document is generated.** Editing it directly will be undone by the next run — change the generator instead, by running \`/geopackage-validation-explainer\` in \`bng-metric-harness\`. It reflects backend \`${short(p.backend?.commit)}\`, frontend \`${short(p.frontend?.commit)}\` and bng-library \`${short(p.library?.commit)}\`, all on \`main\`, and was generated on ${date}.

For how biodiversity units are calculated once a file is accepted, see [rules-engine-explained.md](rules-engine-explained.md).

## How to read this

Every rule below **rejects the upload**: nothing is saved and the file must be corrected and uploaded again. Separately, an accepted file can still contain features that score zero and show as **Incomplete**, when a habitat or condition is not recognised. Those are not upload rules and are not listed here, so a clean upload is not confirmation that every feature was understood.

Two things worth knowing before using the table:

- **The structural rules run first and stop the upload.** Nothing in the geometry or habitat-data groups is reached until the file format, layer, column and coordinate-system rules all pass. Expect to fix a file in two rounds rather than one.
- **What you see on screen often does not identify the rule.** Of ${s.total} rules, ${s.dedicatedCopy} have a message of their own, ${s.placeholderCopy} show a placeholder, and ${s.catchAllCopy} fall back to a generic message about layer and column names. Each row records which applies.

Example files are paths under \`example-files/\` in this repository, worked out by running the real validation gate over every fixture and recording which rule it reports. That directory is a reference corpus for people, not something the service reads, and \`journey-tests\` and \`backend\` keep their own separate copies — so a rule with an example file here is not necessarily covered by an automated test.

## The rules

${buildTable(facts.codes, descriptions, facts.tolerances ?? {})}## Coverage

| Measure | Count |
| --- | --- |
| Rules that can reject an upload | ${s.total} |
| With a message written for them | ${s.dedicatedCopy} |
| Showing a placeholder message | ${s.placeholderCopy} |
| Falling back to a generic message | ${s.catchAllCopy} |
| With an example .gpkg in this repository | ${s.withExampleFile} |
| With a generator flaw that reproduces them | ${s.withFixture} |

**${noFixture.length} of ${s.total} rules have no example file.** Almost all are structural — the file format, layer, column and coordinate-system rules — which is also the group the user is told least about. The generator has no schema flaw family, so those fixtures cannot be produced with \`npm run generate:gpkg\` and would have to be built by hand.

${facts.exampleFilesClaimedByNoRule.length} \`.gpkg\` files in \`example-files/\` are not mapped to any rule. Most are valid fixtures or real survey data rather than rule demonstrations, so that is expected rather than a gap.

## Known gaps recorded by this run

- The green infrastructure containment rule cannot fire. Running the real gate over the fixture built to exercise it shows the file rejected as an unexpected layer instead, because that layer is not in the template — so the containment check is never reached. One layer-type rule also cannot fail, because only layers already of the required type are examined.
- \`example-files/README.md\` states that the green infrastructure fixture demonstrates the containment rule. It does not, per the above, and the entry is stale.
- One fixture filed under \`invalid-schema/\` passes validation entirely: the one named for a wrong geometry column name. Column names are not compared against the template, only their syntactic validity, so there is nothing for it to trip.
- The \`Water course enhancement through meanders\` layer is permitted by the template but never read, so no spatial rule is applied to anything in it.
- Advance and delay values on the Urban Trees layer are silently discarded rather than merely unvalidated, because the column names on that layer differ from the ones the service reads. A five-year head start recorded there earns no credit and produces no warning.
- The message shown for a gap between parcels tells the reader to redraw the parcel. There is no such parcel — the fault is a gap between two of them.
- A file with exactly one fault gets the least informative message, because the specific technical detail is only listed when there is more than one error.

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
  console.error('Usage: build-document.mjs --facts <facts.json> --out <document.md>')
  process.exit(1)
}
if (!existsSync(factsPath)) {
  console.error(`No facts file at ${factsPath}. Run validation-facts.mjs first.`)
  process.exit(1)
}

const facts = JSON.parse(readTextFile(factsPath))
const descriptions = loadDescriptions()

const undescribed = Object.keys(facts.codes).filter((code) => !descriptions[code])
const orphaned = Object.keys(descriptions).filter((code) => !facts.codes[code])

if (undescribed.length > 0) {
  console.error(
    `\n${undescribed.length} rule(s) in the registry have no description in references/rule-descriptions.json:\n` +
      undescribed.map((code) => `  - ${code}`).join('\n') +
      `\n\nWrite a description for each, then re-run. Do not remove the check.`
  )
  process.exit(1)
}
if (orphaned.length > 0) {
  console.error(
    `\n${orphaned.length} description(s) name a rule that no longer exists:\n` +
      orphaned.map((code) => `  - ${code}`).join('\n') +
      `\n\nDelete them from references/rule-descriptions.json.`
  )
  process.exit(1)
}

mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true })
writeFileSync(outPath, buildDocument(facts, descriptions))

const withFile = Object.values(facts.codes).filter(
  (entry) => entry.exampleFiles.length > 0
).length
console.log(`Wrote ${outPath}`)
console.log(`  ${Object.keys(facts.codes).length} rules, all described`)
console.log(`  ${withFile} with an example .gpkg`)
