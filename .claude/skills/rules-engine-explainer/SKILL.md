---
name: rules-engine-explainer
description: >-
  Generate (or refresh) a plain-English explanation of how the BNG rules engine
  calculates biodiversity units — in particular how it chooses the time and
  difficulty multipliers, and how advance and delay years affect them. Produces a
  documentation page with decision diagrams and worked examples whose numbers are
  executed against the real engine rather than written by hand. Use when asked to
  explain or document the rules engine, the metric calculation, multipliers,
  time-to-target, or difficulty bands; or to re-run the explainer periodically to
  check the published documentation still matches the code. Delivers BMD-876.
userInvocable: true
arguments: "[generate|check] [output-path]  — mode defaults to check when a document already exists, generate otherwise"
---

# Plain-English rules engine explainer

Produce documentation that answers **BMD-876**: how the BNG rules engine decides
which multiplier to use when calculating units for a habitat, including the effect
of advance and delay on time and difficulty.

**The model writes the prose, the engine supplies the numbers.** Every multiplier
and unit figure is produced by executing the real engine, so the document cannot
drift into plausible fiction. The model's job is explanation and structure, never
arithmetic.

## Modes

- **generate** — full run: extract facts, trace the logic, run the examples, write
  the document.
- **check** — the periodic re-run: fingerprint the engine, diff against the last
  run, regenerate only what changed. If nothing changed, say so and stop.

Resolve from the first argument. With none, use **check** if a document already
exists at the output path, otherwise **generate**.

## Prerequisites

Run from the harness root with Node 24 (`nvm use` first, or the sibling native
modules fail to load). The scripts locate the engine package themselves.

---

## Step 0 — Scaffold the working directory (idempotent)

`build-docs.mjs` sweeps every `.md` under `docs/` into the published site, so
intermediates must live elsewhere and stay gitignored:

```bash
mkdir -p .rules-engine-explainer
grep -qxF '/.rules-engine-explainer/' .gitignore 2>/dev/null || \
  printf '\n# Rules-engine explainer working state — intermediates, not deliverables\n/.rules-engine-explainer/\n' >> .gitignore
```

Only the finished document goes into `docs/`.

## Step 1 — Extract the facts

```bash
node .claude/skills/rules-engine-explainer/scripts/engine-facts.mjs \
  --out .rules-engine-explainer/facts.json \
  --compare .rules-engine-explainer/facts.json
```

Writes the engine's version, git provenance, public API, source inventory and
reference tables (small ones verbatim, large ones hashed). Passing the same path to
`--compare` diffs against the previous run before overwriting.

**The engine moves.** It lives in `bng-metric-backend` today but is slated for
`bng-library` (see `docs/move-engine-into-bng-lib.md`). The script searches known
locations and honours `BNG_ENGINE_DIR`. If it cannot find the engine, add the new
location to `CANDIDATE_DIRS` rather than working around it.

**In check mode, act on the diff:**

- *No changes* — the document is still accurate. Say so, name the commit checked
  against, stop. This is the expected outcome of most runs.
- *Only table hashes changed* — statutory numbers moved, logic did not. Re-run
  Steps 3 and 3a and update the affected figures; the prose usually survives.
- *Source or public API changed* — re-trace, scoped to the changed files.

## Step 2 — Trace the decision logic

Spawn `Explore` agents **in parallel** (one message, multiple tool calls). In
generate mode run all four; in check mode only those the diff flagged.

1. **Area habitats — multiplier selection.** How distinctiveness, condition, time
   and difficulty are each resolved: which table, keyed on what, with what
   validation, and what happens when a combination is not possible.
2. **Time and difficulty under advance/delay.** The exact arithmetic turning
   reference years into a multiplier: how delay and advance are applied, the clamps
   at zero and at 30 years, the bucket keys, the advance override on difficulty, and
   the creation-scored-as-enhancement rule. **This is the story's core question —
   trace it precisely, including which value each comparison is made against.**
3. **Baseline vs retained vs created vs enhanced.** How the four paths differ, how
   enhancement applies risk to the uplift only, and **what each path returns** —
   enhancement reports a difficulty band label and a standard time-to-target the
   others do not, and that asymmetry needs explaining.
4. **Hedgerows and watercourses.** Where the linear path diverges from the area
   path, plus watercourse encroachment.

Require **a file:line citation for every claim**, in plain English, and ask each
agent to flag anything that would surprise someone assuming the obvious reading of
the statutory guidance. Those surprises become section 8 of the document.

## Step 3 — Run the worked examples

```bash
node .claude/skills/rules-engine-explainer/scripts/run-worked-examples.mjs \
  .claude/skills/rules-engine-explainer/references/worked-examples.json \
  --out .rules-engine-explainer/examples.md
```

Each example names an exported engine function and its arguments; the runner calls
the engine and renders markdown tables. `expect` blocks act as regression
assertions.

**A non-zero exit is a signal, not an obstacle.** Do not edit `expect` values to
make it pass. Work out why the behaviour changed, fix the prose, then update the
expectations — otherwise you republish new behaviour under old explanations, the
exact failure this gate exists to prevent.

If Step 2 surfaced a rule with no example demonstrating it, add one and re-run. A
rule the reader cannot see happening in a table is a rule they will not believe.

## Step 3a — Render the charts

```bash
node .claude/skills/rules-engine-explainer/scripts/render-charts.mjs \
  --out docs/charts/rules-engine
```

Three static SVGs, every plotted value read from the engine:

| Chart | What it makes obvious |
| --- | --- |
| `time-multiplier-decay.svg` | The multiplier decays a flat percentage each year, compounding — one curve replaces a 32-row table. |
| `advance-sensitivity.svg` | Advance creation does not pay off smoothly; there is a step where the difficulty rule switches. Bars are coloured by which rule fired. |
| `enhancement-uplift.svg` | Only the uplift is discounted; existing value is protected. |

`--png` also emits PNGs, needing a Playwright browser; it skips with a message when
none is installed. SVG is always the primary artefact.

**Look at the charts before publishing.** The palette validator checks colour, not
layout — label collisions and text overflowing the card are invisible until
rendered. On macOS, `qlmanage -t -s 1440 -o . chart.svg` gives you a PNG to open.
Charts nobody has looked at routinely have overlapping labels.

Adding a chart? Load the `dataviz` skill and run its `validate_palette.js` — do not
choose colours by eye.

## Step 4 — Write the document

Follow `references/output-spec.md` exactly; it defines the audience, the required
sections in order, and the style rules.

Write to the output path (default `docs/rules-engine-explained.md`). Insert the
generated tables verbatim between the `<!-- worked-examples:start -->` and
`<!-- worked-examples:end -->` markers so the next run can replace them
mechanically.

**No figure enters the prose unless it came from the facts file or the example
run.** If you cannot source a number, describe the behaviour qualitatively instead.

## Step 5 — Check Mermaid is still wired up

`mkdocs.yml` registers the Mermaid custom fence under `pymdownx.superfences`.
Confirm it is still there; without it the diagrams render as plain code blocks.

## Step 6 — Verify before publishing

Do not skip this. A confidently-worded wrong explanation of a statutory calculation
is worse than no explanation.

1. **Check every number against its source** — the facts file or the example
   results. Grep the ones you are least sure of.
2. **Adversarially re-check the surprises.** Spawn an agent to *refute* each one by
   reading the code. A surprise that cannot be defended comes out.
3. **Confirm the diagrams match the prose.** They are written separately and drift.
4. **Read the whole document as the audience.** Any sentence needing programming
   knowledge gets rewritten.

## Step 7 — Publish to Confluence

Confluence is where this document lives, so the run is not finished when the
markdown is written. It renders tables well but does **not** render Mermaid and
cannot resolve relative image paths.

1. **Charts become attachments.** Upload the SVGs from `docs/charts/rules-engine/`
   and insert them where the markdown references them. Keep filenames stable so a
   re-publish replaces the attachment rather than orphaning it. If SVGs display
   poorly, re-run Step 3a with `--png`.
2. **The Mermaid flowcharts will not render.** This is why the output spec requires
   a decision table carrying the same logic — that table is what Confluence readers
   actually rely on.
3. **Check the paste.** Tables kept their columns, no raw HTML showing as literal
   text, every chart resolved to an image.

These steps are manual. This skill has no Confluence credentials and must not
attempt to publish on its own.

## Step 8 — Report

Say what was produced or what changed: output path, the engine commit and version it
reflects, how many examples ran, whether the charts changed, and anything the trace
found worth attention. In check mode, lead with whether the document was still
accurate.

Offer to rebuild the docs site and to raise tickets for behaviour the trace exposed
as genuinely confusing rather than merely undocumented.

---

## Cadence

Monthly in check mode, plus an ad-hoc run after any statutory metric version bump —
that is when reference tables move wholesale and published numbers go stale
silently. The check-mode early exit makes a no-op run cheap. To automate, use the
`schedule` skill and report only when the diff is non-empty.

## Files in this skill

- `scripts/engine-facts.mjs` — locates the engine, extracts facts, diffs runs.
- `scripts/run-worked-examples.mjs` — executes the examples, renders tables, fails
  on drift.
- `scripts/render-charts.mjs` / `scripts/svg-kit.mjs` — the three charts as static
  SVG from live engine data, plus dependency-free drawing primitives.
- `references/worked-examples.json` — the example set, and the document's guarantee
  of accuracy. Extend it as the engine grows.
- `references/output-spec.md` — audience, required sections, style contract.

## Gotchas

- **Node 24.** `nvm use` first.
- **Numbers are long.** The engine rounds to 15 significant figures, so
  `0.5860163055` is correct as shown. Quote them as produced or describe them
  qualitatively; never tidy them.
- **The document and charts are generated, never hand-edited.** A fix applied to the
  output is overwritten on the next run; change the generator. The provenance block
  at the top of the document says so — keep it.
- **`docs/` is published.** Intermediates stay in `.rules-engine-explainer/`.
- **Chart filenames are load-bearing.** They are referenced from the markdown and
  become Confluence attachment names.
- **Statutory language is precise.** *Distinctiveness*, *condition*, *strategic
  significance* and *time to target* come from the Natural England metric. Explain
  them in plain words but keep the terms intact, so readers can match this document
  against the statutory guidance.
