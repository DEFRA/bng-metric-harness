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

function buildTable(codes, descriptions) {
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
      const checks = descriptions[code].checks
      const seen = SEEN[entry.copy]
      lines.push(
        `| ${ruleCell(code, entry)} | ${cell(checks)} The user sees ${seen}. |`
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

Example files are paths under \`example-files/\` in this repository. That directory is a reference corpus for people, not something the service reads, and \`journey-tests\` and \`backend\` keep their own separate copies.

## The rules

${buildTable(facts.codes, descriptions)}## Coverage

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

- Two rules appear unreachable. The green infrastructure containment rule cannot fire, because that layer is not in the template and a file carrying it is rejected as an unexpected layer first. One layer-type rule cannot fail, because only layers already of the required type are examined.
- The \`Water course enhancement through meanders\` layer is permitted by the template but never read, so no spatial rule is applied to anything in it.
- Advance and delay values on the Urban Trees layer are silently discarded rather than merely unvalidated, because the column names on that layer differ from the ones the service reads. A five-year head start recorded there earns no credit and produces no warning.
- The message shown for a gap between parcels tells the reader to redraw the parcel. There is no such parcel — the fault is a gap between two of them.
- A file with exactly one fault gets the least informative message, because the specific technical detail is only listed when there is more than one error.
- \`example-files/README.md\` records no error code for \`empty-layer/Baseline - no rlb polygons.gpkg\`, but a Red Line Boundary layer with zero rows does raise the no-boundary rule. The mapping in this document reflects the code.

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
