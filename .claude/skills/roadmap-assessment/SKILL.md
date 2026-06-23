---
name: roadmap-assessment
description: >-
  Assess how far the BNG service (frontend, backend, library) delivers against the
  Mural "BNG Backlog" story-map roadmap, using the Playwright journey-tests as the
  coverage oracle. Produces a single strictly-tabular assessment.md (RAG-coded
  coverage, phase-relative). Use when asked to assess roadmap alignment or progress, gauge how
  much of the roadmap the code covers, refresh / re-run the roadmap assessment, or
  analyse a Mural backlog CSV export. The ONLY input needed is a single Mural
  sticky-note CSV placed in roadmap-assessment/source/.
---

# Roadmap ↔ Code Assessment

Turn the Mural **"BNG Backlog"** story-map into a structured roadmap, then assess
how far the implemented service delivers against it — judged **phase-relative**
(NOW / NEXT / LATER / EVEN LATER), with the **journey-test suite as the coverage
oracle**. Output: a **single strictly-tabular `assessment.md`** (RAG-coded coverage),
driven by an intermediate `roadmap.json`. No separate `roadmap.md` is produced.

## Input — only the CSV

The **single required input is one Mural sticky-note CSV** exported from the board.
Nothing else is needed: the CSV carries each sticky's `Text`, `BG Color`,
`Position X/Y` and `Area`, which is enough to reconstruct the whole board
deterministically (no PDF/PNG required). Assume exactly **one** CSV lives in
`roadmap-assessment/source/`; the parser uses the first `*.csv` it finds there.

To produce it in Mural: select the roadmap, right-click → **Export** → scope
**Selection** → Format **CSV spreadsheet**.

## Prerequisites

- Run from the **harness root** (`bng-metric-harness/`), with the sibling repos
  checked out and reachable via the symlinks: `journey-tests/`, `frontend/`,
  `backend/`, `library/`. (If `journey-tests/` is missing, run `npm run bootstrap`.)
- Node 24 (`nvm use`) for the parser.

---

## Procedure — follow in order

### Step 1 — Scaffold the working directory (idempotent)

Create the structure if missing, copy in the bundled parser if absent, and keep the
internal roadmap + analysis **off the public GitHub Pages site** (`scripts/build-docs.mjs`
publishes `docs/`, so the working dir must stay gitignored):

```bash
mkdir -p roadmap-assessment/source
[ -f roadmap-assessment/parse-roadmap.mjs ] || cp .claude/skills/roadmap-assessment/scripts/parse-roadmap.mjs roadmap-assessment/parse-roadmap.mjs
grep -qxF '/roadmap-assessment/' .gitignore 2>/dev/null || printf '\n# Internal roadmap assessment working dir — kept off the public GitHub Pages site\n# (leading slash anchors to repo root so it does NOT ignore .claude/skills/roadmap-assessment/)\n/roadmap-assessment/\n' >> .gitignore
```

### Step 2 — Ask the user for the CSV, then WAIT for confirmation (mandatory gate)

Print these instructions to the user verbatim-in-spirit:

> 📁 Created `roadmap-assessment/source/`.
> Export the roadmap from Mural as a **sticky-note CSV** (Export → CSV spreadsheet,
> scoped to a **Selection** of the roadmap) and drop the **single CSV file** into
> `roadmap-assessment/source/`. That is the only file needed — no PDF/PNG.

Then **call `AskUserQuestion`** and do **not** proceed until the user confirms:

- question: `Is the Mural roadmap CSV now saved in roadmap-assessment/source/ and ready to analyse?`
- header: `CSV ready?`
- options: `Yes — analyse it` / `Not yet — still exporting`

**Hard rule:** if the user does not confirm "Yes — analyse it", STOP here and wait.
Do not parse or assess. After a "Yes", verify a CSV is actually present before
continuing:

```bash
ls -1 roadmap-assessment/source/*.csv
```

If that lists no file, tell the user the folder is still empty and re-ask — do not
proceed.

### Step 3 — Parse the CSV → `roadmap.json` (intermediate; not a deliverable)

```bash
node roadmap-assessment/parse-roadmap.mjs
```

Sanity-check the output line `Phases: {...}`:
- If **`UNKNOWN` > 0**, the board's sticky colours have drifted from the legend.
  Inspect the CSV's `BG Color` values and update `PHASE_BY_COLOUR` (and, if needed,
  `BACKBONE_COLOUR` / `USER_NEED_COLOUR`) in `roadmap-assessment/parse-roadmap.mjs`,
  then re-run. Do not assess with unmapped colours.
- Briefly show the user the totals (themes / stories / user needs / phase split) so
  they can spot anything wrong before the assessment spends tokens.

### Step 4 — Run the assessment workflow → `assessment.md`

Launch the bundled, **data-driven** workflow with the **Workflow** tool (this skill's
instructions are the explicit opt-in to use it):

```
Workflow({ scriptPath: ".claude/skills/roadmap-assessment/scripts/assessment-workflow.mjs" })
```

It runs in the background (~10 min, dozens of agents) and notifies on completion.
It reads `roadmap.json` and discovers the journey-test folders itself, so it needs
no edits for a new export. Phases: **Load → Inventory → Assess → Verify → Synthesize**.
The Synthesize agent writes `roadmap-assessment/assessment.md`.

### Step 5 — Linkify tickets, review, verify, present

When the workflow completes:

1. **Linkify the Jira tickets** — deterministic, idempotent post-process that turns every
   `BMD-*` ref in the report into a clickable link (base
   `https://eaflood.atlassian.net/browse/`, override via `JIRA_BROWSE_URL`):
   ```bash
   node .claude/skills/roadmap-assessment/scripts/linkify-tickets.mjs roadmap-assessment/assessment.md
   ```
2. **Read `roadmap-assessment/assessment.md`.**
3. **Reconcile the counts:** the NOW sub-counts (on-track + test-gap + delivery-gap
   + placeholder) must equal the NOW total from `roadmap.json`'s `phaseCounts`. Fix
   any slips (the synthesis can mis-tally placeholders / "all expected-absent" lines).
4. **Spot-check** the 2-3 highest-stakes "delivery gap (not built)" claims against the
   code with a quick `grep` before endorsing — the workflow self-verifies, but a sanity
   check protects against a false "not built".
5. **Present** the headline dashboard + top findings, and offer next steps: generate a
   backlog of tickets from the gaps, publish a sanitised summary into `docs/`
   (deliberately, never the raw internal export), or set a re-run cadence.

---

## Methodology & assumptions (what makes the findings reproducible)

**The board is a user STORY MAP, not a timeline.** `parse-roadmap.mjs` encodes:
- **Horizontal position → theme.** Grey `#EDEDED` 3x5 stickies are the backbone
  activities ("themes"), ordered left→right. Each other sticky is assigned to the
  nearest backbone by X; within a theme, stories are ordered top→down by Y.
- **No synthetic IDs.** Items are keyed by their semantic **theme name** and **story
  text** — no `T01` / `R-Txx-yy` labels. Use domain knowledge of the names to discuss them.
- **Colour → release phase**, from the board's own legend: NOW `#FCF281`,
  NEXT `#D8C7FF`, LATER `#FEBBBE`, EVEN LATER `#D8D8B1`. There is **no "done" colour** —
  "shipped" is inferred from code during assessment.
- **Green `#AAED92` (Area = USER NEEDS)** = the EPIC USER NEEDS band (overarching needs).
- **Legend/label stickies** (`NOW`/`NEXT`/`LATER`/`EVEN LATER`/`USER NEEDS`, and the
  `#F6A324` label) are excluded from stories.

**Assessment is phase-relative**, with **journey-tests as the coverage oracle**
(coverage = end-to-end TESTED, a deliberately conservative proxy for *delivered*):
- `covered` = a journey test exercises the story end-to-end; `partial` = a test only
  touches an adjacent capability; `none` = no test.
- **NOW + covered → on-track.** **NOW + none/partial → gap**, then a *narrow* code
  check in `frontend/`/`backend/`/`library/` splits it: code found = **test gap**
  (built but untested, `builtButUntested=yes`); no code = **delivery gap** (not built).
- **NEXT/LATER/EVEN LATER + covered/partial → ahead** (built ahead of plan);
  **+ none → expected-absent** (on track for its phase).
- Vague/placeholder story text (`TBC`, `????`, `More stuff`, bare `?`) → **placeholder**
  (unassessable; needs acceptance criteria).
- Every `covered`/`partial` verdict is **adversarially re-verified** (a skeptic re-opens
  the cited spec) to kill over-claims.

**Output format — `assessment.md` is strictly tabular** (no prose paragraphs, no bullet
lists): a phase **summary** table, **top findings** table, **theme status** table, the full
**coverage matrix**, a **journey tests needed** table, and a **recommendations** table.
- Coverage uses a **RAG emoji**: 🟢 Covered · 🟠 Partial · 🔴 None.
- Judgement carries its own emoji: ✅ on-track · 🛠️ test gap · ❌ delivery gap · 🚀 ahead ·
  ⏳ expected-absent · ❓ placeholder.
- A **Tickets** column lists best-effort `BMD-*` refs mined from the commit history of the
  implementing files (`git log --format=%s -- <file> | grep -oiE 'BMD-[0-9]+'`). Heuristic —
  often blank, especially for journey-tests where tickets live in branch/PR names. They are
  rendered as clickable Jira links by `scripts/linkify-tickets.mjs` in Step 5.
- **No raw file:line evidence** is shown — a short "related test/code" summary instead.

See `references/methodology.md` for the full detail (classification rules, output format,
BMD extraction, known gotchas).

## Re-running (drift detection)

Each sprint: re-export the CSV into `roadmap-assessment/source/` (replace the old one),
then repeat Steps 3–5. Because the workflow is data-driven, new themes/stories and new
journey-test folders are picked up automatically. Compare the new `assessment.md`
against the previous to see drift (gaps closed, new NOW work, newly-tested stories).

## Files in this skill

- `scripts/parse-roadmap.mjs` — canonical deterministic CSV → `roadmap.json` parser
  (copied into the working dir in Step 1; emits only the intermediate JSON, no IDs).
- `scripts/assessment-workflow.mjs` — the data-driven assessment Workflow.
- `scripts/linkify-tickets.mjs` — idempotent post-process that turns `BMD-*` refs in
  `assessment.md` into clickable Jira links (Step 5).
- `references/methodology.md` — detailed, reproducible methodology and gotchas.
