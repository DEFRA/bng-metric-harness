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

Produce documentation that answers **BMD-876**: a plain-English description of how
the BNG rules engine decides which multiplier to use when calculating units for a
habitat, including the effect of advance and delay on time and difficulty.

The design principle throughout: **the model writes the prose, the engine supplies
the numbers.** Every multiplier and unit figure in the output is produced by
executing the real engine, so the document cannot drift into plausible fiction. The
model's job is explanation and structure, never arithmetic.

## Modes

- **generate** — full run: extract facts, trace the logic, run the examples, write
  the document.
- **check** — the periodic re-run: fingerprint the engine, diff against the last
  run, and only regenerate what actually changed. If nothing changed, say so and
  stop; do not burn tokens rewriting an accurate document.

Resolve the mode from the first argument. With no argument, use **check** if a
generated document already exists at the output path, otherwise **generate**.

## Prerequisites

Run from the harness root with Node 24 (`nvm use` first — a different Node version
breaks the native modules in the sibling repos). The scripts locate the engine
package themselves; they do not assume it stays where it is today.

---

## Step 0 — Scaffold the working directory (idempotent)

Intermediates live outside `docs/`, because `scripts/build-docs.mjs` sweeps every
`.md` file under `docs/` into the published site — an intermediate left there would
appear as an orphan page. Keep the working directory gitignored:

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

This locates the `bng-metric-engine` package, then writes a JSON file describing
its version, git provenance, public API, source-file inventory, and all reference
lookup tables — small tables verbatim, large ones hashed and summarised. Passing
the same path to `--compare` diffs the new facts against the previous run before
overwriting.

**The engine moves.** It currently lives inside `bng-metric-backend` as a workspace
package, but is slated to move into `bng-library` (see
`docs/move-engine-into-bng-lib.md`). The script searches known candidate locations
and honours `BNG_ENGINE_DIR`. If it cannot find the engine, add the new location to
`CANDIDATE_DIRS` in the script rather than working around it — that keeps the next
run working.

**In check mode, act on the diff:**

- *No changes reported* — the published document is still accurate. Tell the user
  the engine is unchanged since the last run, name the commit it was checked
  against, and stop. This is the expected outcome of most periodic runs.
- *Only reference-table hashes changed* — the statutory numbers moved but the logic
  did not. Re-run the worked examples (Step 3) and update the affected tables and
  figures. The explanatory prose usually survives untouched.
- *Source files or the public API changed* — the logic itself may have moved.
  Continue to Step 2 and re-trace, but scope the tracing to the changed files.

## Step 2 — Trace the decision logic

Spawn `Explore` agents **in parallel** (one message, multiple tool calls) over the
engine source. In generate mode run all four; in check mode run only those whose
files the diff flagged.

1. **Area habitats — multiplier selection.** How distinctiveness, condition, time
   and difficulty multipliers are each resolved: which lookup table, keyed on what,
   with what validation and what happens when a combination is not possible.
2. **Time and difficulty under advance/delay.** The exact arithmetic turning
   reference years into a multiplier: how delay and advance are applied, the
   clamping at zero and at the 30-year ceiling, the bucket keys, the advance
   override on difficulty, and the creation-scored-as-enhancement rule. **This is
   the story's core question — trace it precisely, including which value each
   comparison is made against.**
3. **Baseline vs retained vs created vs enhanced.** How the four paths differ, and
   specifically how enhancement applies risk multipliers to the uplift only rather
   than the whole parcel.
4. **Hedgerows and watercourses.** Where the linear path diverges from the area
   path, plus watercourse encroachment.

Tell each agent to return the **rule in plain English with a file:line citation for
every claim**, and to flag anything that would surprise someone assuming the obvious
reading of the statutory guidance. Those surprises become section 8 of the document.

## Step 3 — Run the worked examples

```bash
node .claude/skills/rules-engine-explainer/scripts/run-worked-examples.mjs \
  .claude/skills/rules-engine-explainer/references/worked-examples.json \
  --out .rules-engine-explainer/examples.md
```

Each example names an exported engine function and its arguments; the runner calls
the real engine and renders the results as markdown tables. Examples carry `expect`
blocks that act as regression assertions.

**A non-zero exit is a signal, not an obstacle.** It means the engine now returns
something different from the last run. Do not edit the `expect` values to make it
pass — first work out *why* the behaviour changed, fix the prose to match, and only
then update the expectations. A silently-updated expectation republishes new
behaviour under old explanations, which is the exact failure this gate exists to
prevent.

If the trace in Step 2 surfaced a rule with no example demonstrating it, add one to
`references/worked-examples.json` and re-run. A rule the reader cannot see happening
in a table is a rule they will not believe.

## Step 3a — Render the charts

```bash
node .claude/skills/rules-engine-explainer/scripts/render-charts.mjs \
  --out docs/charts/rules-engine
```

Three static SVGs, every plotted value read from the engine's reference tables or
returned by calling it:

| Chart | What it makes obvious |
| --- | --- |
| `time-multiplier-decay.svg` | The multiplier decays by a flat percentage each year, compounding — one curve replaces a 32-row table. |
| `advance-sensitivity.svg` | Advance creation does not pay off smoothly; there is a step where the difficulty rule switches. Bars are coloured by which rule fired. |
| `enhancement-uplift.svg` | Only the uplift is discounted; the value the habitat already had is protected. |

Add `--png` to also emit PNGs. That path needs a Playwright browser and skips
itself with a message when none is installed — SVG is always the primary artefact.

**Look at the charts before publishing them.** The palette validator checks colour,
not layout; label collisions and text overflowing the card are invisible until
rendered. On macOS, `qlmanage -t -s 1440 -o . chart.svg` produces a PNG you can
open. Charts that have never been looked at routinely have overlapping labels.

If you add a chart, load the `dataviz` skill first and run its
`validate_palette.js` — do not choose colours by eye.

## Step 4 — Write the document

Read `references/output-spec.md` and follow it exactly — it defines the audience,
the required sections in order, and the plain-English rules.

Write to the output path (default `docs/rules-engine-explained.md`; the harness
`docs/` directory is published to the GitHub Pages site by `scripts/build-docs.mjs`).
Insert the generated example tables verbatim between the
`<!-- worked-examples:start -->` and `<!-- worked-examples:end -->` markers so the
next run can replace them mechanically.

The absolute rule: **no figure enters the prose unless it came from the facts file
or the example run.** If you want to state a multiplier, quote the one the engine
produced. If you cannot source a number, describe the behaviour qualitatively
instead.

## Step 5 — Enable Mermaid on the docs site (first run only)

The site uses `pymdownx.superfences` but does not yet configure the Mermaid custom
fence, so a ` ```mermaid ` block renders as a plain code block. Check `mkdocs.yml`
and, if the custom fence is absent, add it:

```yaml
  - pymdownx.superfences:
      custom_fences:
        - name: mermaid
          class: mermaid
          format: !!python/name:pymdownx.superfences.fence_code_format
```

Material for MkDocs loads Mermaid itself once the fence is registered. The diagram
renders on GitHub regardless, so this only affects the published site. Skip if
already present.

## Step 6 — Verify before publishing

Do not skip this. A confidently-worded wrong explanation of a statutory calculation
is worse than no explanation.

1. **Check every number against its source.** Each figure in the prose must appear
   in `.rules-engine-explainer/facts.json` or the example results. Grep for the ones
   you are least sure of.
2. **Adversarially re-check the surprises.** For each entry in "Things that surprise
   people", spawn an agent to *refute* it by reading the code. A surprise that
   cannot be defended comes out of the document.
3. **Confirm the diagram matches the prose.** The Mermaid flowchart and section 5
   must describe the same branches. They drift easily because they are written
   separately.
4. **Read the whole document as the audience.** Any sentence needing programming
   knowledge to parse gets rewritten.

## Step 7 — Publish to Confluence

**Confluence is where this document actually lives**, so the run is not finished when
the Markdown is written.

Confluence renders Markdown tables well, but it does **not** render Mermaid, and it
cannot resolve relative image paths. So:

1. **Charts become attachments.** Upload the SVGs from `docs/charts/rules-engine/`
   to the Confluence page, then insert them where the Markdown references them. Keep
   the filenames stable between runs so a re-publish replaces the attachment in place
   rather than orphaning it. If SVGs display poorly on the target instance, re-run
   Step 3a with `--png` and upload those instead.
2. **The Mermaid flowcharts will not render.** This is why the output spec requires a
   decision table carrying the same logic — that table is what most Confluence
   readers will actually rely on. If the instance has a Mermaid macro installed, the
   fenced blocks can be pasted into it, but do not assume that.
3. **Check the paste.** After publishing, confirm the tables kept their columns, no
   raw `<br>` or HTML appears as literal text, and every chart resolved to an image
   rather than a broken reference.

Tell the user these steps are manual — this skill does not have Confluence
credentials and must not attempt to publish on its own. If they want it automated,
that is a separate conversation about API tokens, not something to improvise here.

## Step 8 — Report

Tell the user what was produced or what changed: the output path, the engine commit
and version it reflects, how many worked examples ran, whether the charts changed,
and anything the trace found that is worth their attention. In check mode, lead with
whether the published document was still accurate.

Offer to rebuild the docs site (`npm run docs:build` if defined) so the page appears
on GitHub Pages, and to raise tickets for anything the trace exposed as genuinely
confusing behaviour rather than merely undocumented.

---

## Suggested cadence

The engine changes rarely, so a **monthly** run in check mode is enough, plus an
ad-hoc run after any statutory metric version bump — that is when the reference
tables move wholesale and the published numbers go stale silently. The check-mode
early exit makes a no-op run cheap, so erring on the side of running more often
costs little.

To automate it, use the `schedule` skill to create a routine that invokes this skill
in check mode, and have it report only when the diff is non-empty.

## Files in this skill

- `scripts/engine-facts.mjs` — locates the engine, extracts version, provenance,
  public API and reference tables to JSON, and diffs against a previous run.
- `scripts/run-worked-examples.mjs` — executes worked examples against the real
  engine, renders markdown tables, and fails on drift from recorded expectations.
- `scripts/render-charts.mjs` — renders the three explanatory charts as static SVG
  from live engine data, with optional PNG export.
- `scripts/svg-kit.mjs` — dependency-free SVG primitives and the validated palette
  used by the charts.
- `references/worked-examples.json` — the example set. Extend it as the engine
  grows; it is the document's guarantee of accuracy, not merely illustration.
- `references/output-spec.md` — audience, required sections, and style contract for
  the generated document.

## Gotchas

- **Node 24.** `nvm use` first, or the sibling native modules fail to load.
- **Numbers are long.** The engine rounds to 15 significant figures, so multipliers
  like `0.5860163055` are correct as shown. Do not tidy them in the prose — quote
  them as produced, or describe them qualitatively instead.
- **The generated document is not hand-editable.** Anyone correcting the output
  instead of the generator will have their fix overwritten on the next run. The
  provenance block at the top of the document exists to warn them; keep it there.
- **`docs/` is published.** Everything written there goes to the public GitHub Pages
  site, and `build-docs.mjs` sweeps up *every* `.md` file it finds — so intermediates
  must stay in `.rules-engine-explainer/` (Step 0), never in `docs/`.
- **Charts are generated, never hand-edited.** Editing an SVG makes it disagree with
  the engine at the next run, which is the one failure the whole design exists to
  prevent. Change `render-charts.mjs` instead.
- **Chart filenames are load-bearing.** They are referenced from the Markdown and
  become Confluence attachment names; renaming one breaks the published page.
- **Statutory language is precise.** Terms like *distinctiveness*, *condition*,
  *strategic significance* and *time to target* come from the Natural England
  metric. Explain them in plain words but keep the terms themselves intact; readers
  need to match this document against the statutory guidance.
