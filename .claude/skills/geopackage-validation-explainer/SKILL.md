---
name: geopackage-validation-explainer
description: >-
  Generate (or refresh) a plain-English explanation of the validation rules the
  BNG Metric service enforces when checking an uploaded GeoPackage — what makes a
  file be rejected, and what to change to make it pass. Produces a documentation
  page whose rule list is reconciled against the backend error registry, the
  frontend error copy and the library's test fixtures, so it cannot drift out of
  step with the code. Use when asked to explain or document GeoPackage validation,
  upload errors, why a file was rejected, or the baseline file checks; or to re-run
  it periodically to check the published documentation still matches the code.
  Delivers BMD-887.
userInvocable: true
arguments: "[generate|check] [output-path]  — mode defaults to check when a document already exists, generate otherwise"
---

# Plain-English GeoPackage validation explainer

Produce documentation that answers **BMD-887**: which rules cause an uploaded
GeoPackage to be rejected, and what a non-technical reader would change in their
file to make it pass.

**The model writes the prose, the code supplies the rule list.** Every rule in the
document is reconciled against the backend's error registry, so the document cannot
quietly omit a rule or describe one that no longer exists. The model's job is
explanation and grouping, never deciding what the rules are.

This is the sibling of `rules-engine-explainer`, which explains how units are
*calculated*. That skill proves itself by executing the engine. There is nothing
equivalent to execute here — the spatial checks need a live PostGIS — so this skill
proves itself by **reconciliation across three repos** instead:

| Repo | Supplies |
| --- | --- |
| `bng-metric-backend` | Which rules exist, where each is enforced, the literal message it raises |
| `bng-metric-frontend` | Whether the user sees a bespoke message, a placeholder, or a generic catch-all |
| `bng-library` | Which rules a test fixture actually exercises |

The gap between those three is the story. A rule that no fixture tests and that
reaches the user as a generic message is exactly what the document must not imply
is well covered.

## Modes

- **generate** — full run: extract facts, trace the rules, write the document.
- **check** — the periodic re-run: extract facts, diff against the last run,
  regenerate only what changed. If nothing changed, say so and stop.

Resolve from the first argument. With none, use **check** if a document already
exists at the output path, otherwise **generate**.

## Prerequisites

Run from the harness root with Node 24 (`nvm use` first). The scripts locate the
three repos themselves and read source only — nothing is installed, no database is
needed, and nothing is executed from the repos under inspection.

---

## Step 0 — Scaffold the working directory (idempotent)

`build-docs.mjs` sweeps every `.md` under `docs/` into the published site, so
intermediates must live elsewhere and stay gitignored:

```bash
mkdir -p .geopackage-validation-explainer
grep -qxF '/.geopackage-validation-explainer/' .gitignore 2>/dev/null || \
  printf '\n# GeoPackage validation explainer working state — intermediates, not deliverables\n/.geopackage-validation-explainer/\n' >> .gitignore
```

Only the finished document goes into `docs/`.

## Step 1 — Extract and diff the facts

```bash
node .claude/skills/geopackage-validation-explainer/scripts/validation-facts.mjs \
  --out .geopackage-validation-explainer/facts.json \
  --compare .geopackage-validation-explainer/facts.json
```

Writes every code in the registry with its raise sites and literal message, the
copy status the user experiences, the fixtures that exercise it, and the commit of
each repo. Passing the same path to `--compare` diffs against the previous run
before overwriting.

**Read the summary before going further.** It reports how many rules reach the user
as a generic message and how many no fixture covers. Those counts are content, not
diagnostics — section 4 and section 10 of the document depend on them.

**In check mode, act on the diff:**

- *NO CHANGE* — the document is still accurate. Say so, name the commits checked
  against, stop. This is the expected outcome of most runs.
- *Codes added* — new rules exist that the document does not describe. This is the
  case the skill exists to catch. Trace the new ones and write them up.
- *Codes removed* — the document describes a rule the service no longer enforces.
  Remove it; do not leave it in as history.
- *Codes changed* — the message, the copy status or the fixture coverage moved. A
  code graduating from placeholder to bespoke copy changes what section 4 and the
  rule index claim, even though the rule itself is unchanged.

## Step 2 — Trace the rules

Spawn `Explore` agents **in parallel** (one message, multiple tool calls). In
generate mode run all four; in check mode only those the diff touches.

1. **File and schema checks.** What the upload is compared against, and what makes
   a layer, column or coordinate reference system fail. The largest group by count
   and the least visible to users — establish what a reader could actually do about
   each one.
2. **Geometry checks.** Red line boundary count, polygon and linestring
   expectations per layer, and what "invalid geometry" means concretely. Note which
   layers are optional and what an empty optional layer does.
3. **Spatial relationship checks.** Containment, overlaps, slivers, area
   reconciliation — and **every tolerance, with its units**. Tolerances are the
   detail readers most need and the one most often lost in translation.
4. **Attribute checks.** Distinctiveness scope, duplicate parcel references,
   advance and delay both set. Include why each rule exists where the code says so.

Require **a file:line citation for every claim**, in plain English, and ask each
agent to flag anything that would surprise someone assuming the obvious reading.
Those surprises inform section 8.

**Do not ask an agent what the rules are.** The rule list comes from the facts file.
Agents explain rules that are already enumerated; anything an agent reports that is
not in the facts file is a finding to investigate, not a row to add.

## Step 3 — Write the document

Follow `references/output-spec.md` exactly; it defines the audience, the required
sections in order, and the style contract. Write to the output path (default
`docs/geopackage-validation-explained.md`).

Two constraints that fight each other, and how they resolve:

- The body must contain **no error codes** — a reader never sees one, so a document
  organised around them answers a question nobody asked.
- Coverage must be **mechanically checkable** — otherwise "every rule is
  documented" is an opinion.

The rule index in section 10 resolves both. It is the only place codes appear, it
is what Step 4 checks, and it is explicitly labelled as being for maintainers.

## Step 4 — Verify coverage

```bash
node .claude/skills/geopackage-validation-explainer/scripts/doc-coverage.mjs \
  --facts .geopackage-validation-explainer/facts.json \
  --doc docs/geopackage-validation-explained.md
```

Fails when a rule in the registry has no index entry, when an index entry names a
code that no longer exists, or when an index entry points at a section heading that
is not in the document.

**A non-zero exit is a signal, not an obstacle.** Do not delete an index row to make
it pass — that is precisely the failure this gate exists to prevent. Write the
missing rule up.

## Step 5 — Verify the prose

The coverage check proves *every*. It cannot prove *understandable*. Do not skip
this.

1. **Read the whole document as the audience** — someone who works in QGIS and has
   never opened the codebase. Any sentence needing programming knowledge gets
   rewritten.
2. **Check every rule ends with a remedy.** The user story is about knowing what to
   change. A rule with no fix has been transcribed, not explained.
3. **Check every tolerance against the facts file**, with its units, and confirm the
   document says what passes as well as what fails.
4. **Adversarially re-check the surprises.** Spawn an agent to *refute* each one by
   reading the code. A surprise that cannot be defended comes out.
5. **Confirm the coverage claims match the facts file.** If the document implies a
   rejection is clearly explained on screen, the facts file must show bespoke copy
   for it.

## Step 6 — Publish to Confluence

Confluence is where this document lives, so the run is not finished when the
markdown is written. It renders tables well but does **not** render Mermaid and
cannot resolve relative image paths.

1. **Check the paste.** Tables kept their columns, no raw HTML showing as literal
   text, no nested bullets collapsed.
2. **Any Mermaid diagram will not render.** Whatever it carried must also exist as
   prose or a table.

These steps are manual. This skill has no Confluence credentials and must not
attempt to publish on its own.

## Step 7 — Report

Say what was produced or what changed: output path, the three commits it reflects,
how many rules are documented, and how many of those reach the user as a generic
message. In check mode, lead with whether the document was still accurate.

Offer to raise tickets for gaps the run exposed — a rule with no fixture, a
placeholder that has been pending long enough to look permanent, or a rule whose
remedy nobody could state.

---

## Cadence

Monthly in check mode, plus an ad-hoc run after any change to the validation
pipeline or the error copy. The check-mode early exit makes a no-op run cheap. To
automate, use the `schedule` skill and report only when the diff is non-empty.

The drift this catches is specific and quiet: a rule added without documentation, a
placeholder message graduating to real copy, or a fixture removed so a rule silently
stops being tested. None of those announce themselves.

## Files in this skill

- `scripts/_lib.mjs` — locates the three repos by probing for the file each one
  must supply, plus git provenance and shared parsing helpers.
- `scripts/validation-facts.mjs` — extracts the rule list and reconciles it across
  the three repos; diffs runs.
- `scripts/doc-coverage.mjs` — reconciles the published document's rule index
  against the facts; exits non-zero on a gap.
- `references/output-spec.md` — audience, required sections, style contract.

## Gotchas

- **Node 24.** `nvm use` first.
- **The document is generated, never hand-edited.** A fix applied to the output is
  overwritten on the next run; change the generator or the spec. The provenance
  block at the top says so — keep it.
- **`docs/` is published.** Intermediates stay in
  `.geopackage-validation-explainer/`.
- **Flaw keys in the library are inconsistently quoted.** Most are quoted, `sliver`
  is not. The extractor handles both; if fixture attribution ever looks wrong,
  suspect that pattern first — a missed key silently attributes every later fixture
  to the previous one.
- **Some codes are raised indirectly**, passed as configuration rather than to
  `makeError` at the call site. Those show a `null` message in the facts file. That
  is correct extraction, not a failure — describe the condition instead of quoting a
  message.
- **Codes are raised outside `src/validation`.** The route and persistence codes
  live under `src/services` and `src/routes`, which is why the scan covers all of
  `src`.
- **Statutory language is precise.** *Distinctiveness*, *condition* and *red line
  boundary* come from the Natural England metric and the template. Explain them in
  plain words but keep the terms intact, so readers can match this document against
  the guidance and the template.
