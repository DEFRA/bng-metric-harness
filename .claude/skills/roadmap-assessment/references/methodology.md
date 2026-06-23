# Roadmap-assessment — detailed methodology

Everything needed to reproduce the findings from a Mural CSV export. Read alongside
`../SKILL.md`.

## 1. The board: a user story map

The Mural "BNG Backlog" is a **user story map**, not a left-to-right timeline. Two
independent axes plus colour:

| Encoding | Meaning |
| --- | --- |
| **Horizontal (X)** | Which backbone **activity / theme** (the service journey, left→right) |
| **Vertical (Y), below the backbone** | Priority/order of stories within a theme (top = higher) |
| **Colour** | **Release phase** (NOW / NEXT / LATER / EVEN LATER) — the now/next/later axis |
| **Top green band** | EPIC USER NEEDS (persona statements), `Area = USER NEEDS` |

There is **no "done"/"shipped" state on the board**. Delivery status is established
from the code during assessment and compared against the board phase.

## 2. CSV columns used

Mural's sticky-note CSV header (only the starred columns are consumed):

`ID*, Text*, BG Color*, Sticky type, Border line, Position X*, Position Y*, Area*, Link to, Last Updated By, Last Updated, Last Content Edited By, Last Content Edited, Tags, Integration Labels`

(See `COL` in `scripts/parse-roadmap.mjs`. Text is HTML-entity-decoded: `&amp; &gt; &lt; &#39; &quot;`.)

## 3. Colour legend (decoded from the board's own legend stickies)

| Hex | Role |
| --- | --- |
| `#FCF281` | Phase **NOW** |
| `#D8C7FF` | Phase **NEXT** |
| `#FEBBBE` | Phase **LATER** |
| `#D8D8B1` | Phase **EVEN LATER** |
| `#EDEDED` | Backbone **activity/theme** (grey 3x5) |
| `#AAED92` | **USER NEED** (green band) |
| `#F6A324` | Section **label** sticky — excluded |

The legend lives **in the data** as stickies literally titled `NOW` / `NEXT` /
`LATER` / `EVEN LATER` (and `USER NEEDS`); those texts are excluded from stories.

> **Drift guard:** if Mural's colours change, `parse-roadmap.mjs` emits stories with
> phase `UNKNOWN` and prints a non-zero `UNKNOWN` count. Update `PHASE_BY_COLOUR`
> (and `BACKBONE_COLOUR` / `USER_NEED_COLOUR` if the structural colours moved) and
> re-run before assessing.

## 4. Parser logic (`parse-roadmap.mjs`, deterministic)

1. **Classify** each sticky: backbone (`#EDEDED`) → theme; green / `Area=USER NEEDS`
   → user need; legend/label texts and `#F6A324` → excluded; everything else → story.
2. **Order themes** left→right by X (the theme's `name` is its key — no ID).
3. **Assign each story to the nearest backbone by |ΔX|** (story columns sit a fixed
   small offset from their activity, so nearest-X is unambiguous — gaps between
   activities are far larger than the story offset).
4. **Order stories within a theme** top→down by Y.
5. **Phase** = colour → legend.
6. Emit **`roadmap.json` only** — the intermediate machine structure that drives the
   workflow: `{ totals, phaseCounts, legend, userNeeds:[text], themes:[{ name, stories:[{ text, phase }] }] }`.

**No synthetic IDs.** Items are keyed by their semantic **theme name** + **story text**,
so the report reads in domain language (no `T01` / `R-Txx-yy`). The single human
deliverable, `assessment.md`, is produced later by the workflow — `roadmap.json` is not
a deliverable.

## 5. Assessment (the workflow)

Oracle = the Playwright **journey-tests** (`journey-tests/test/specs/`). Coverage =
**end-to-end TESTED**, a deliberately conservative proxy for *delivered*.

Pipeline (`scripts/assessment-workflow.mjs`): **Load → Inventory → Assess → Verify → Synthesize**.

- **Load** — one agent reads `roadmap.json` (themes + stories + phaseCounts) and
  discovers the journey-test folders. Data-driven, so a new export needs no edits.
- **Inventory** — one agent per test folder builds an evidence base of what each spec
  *proves* end-to-end (strictly evidence-based; skipped specs flagged).
- **Assess** — one agent per theme assigns each story a `coverage` + phase-relative
  `judgment`, a one-line `relatedSummary`, and best-effort `tickets` (see §5b).
- **Verify** — adversarial skeptic re-opens every cited spec to downgrade over-claims.
- **Synthesize** — writes the single **strictly-tabular** `assessment.md` (see §5a).

### Phase-relative judgment rules (exact)

| Phase | Coverage | Judgment | Extra |
| --- | --- | --- | --- |
| NOW | covered | `on-track` | — |
| NOW | none / partial | `gap` | **code-corroborate**: code found → `builtButUntested=yes` (TEST gap); none → `builtButUntested=no` (DELIVERY gap) |
| NEXT/LATER/EVEN LATER | covered / partial | `ahead` | built ahead of plan |
| NEXT/LATER/EVEN LATER | none | `expected-absent` | on track for its phase |
| any | (vague text) | `placeholder` | `TBC` / `????` / `More stuff` / bare `?` — needs acceptance criteria |

The **narrow code corroboration runs only for NOW gaps** (frontend/backend/library),
to split *built-but-untested* from *not-built*. All other phases are judged on
journey-test coverage alone (not-built is expected and not flagged).

### 5a. Output format (`assessment.md`)

Strictly tabular — no prose paragraphs, no bullet lists; each section is a heading +
one table:

1. **Summary** — phases × outcome tallies (on-track / test gap / delivery gap / ahead /
   expected-absent / placeholder / total), plus NOW end-to-end coverage %.
2. **Top findings** — material items, most important first.
3. **Theme status** — one row per theme.
4. **Coverage matrix** — every story: Theme · Roadmap item · Related test/code · Phase ·
   Coverage · Judgement · Confidence · Tickets.
5. **Journey tests needed** — the NOW test-gaps and partials (built / likely-built but
   unproven end-to-end) — the explicit journey-test coverage to add.
6. **Recommendations** — prioritised actions, typed Build / Add journey test / Define.

Encodings: **Coverage = RAG emoji** (🟢 Covered / 🟠 Partial / 🔴 None). **Judgement
emoji** (✅ on-track / 🛠️ test gap / ❌ delivery gap / 🚀 ahead / ⏳ expected-absent /
❓ placeholder). No raw file:line evidence — a one-line "related test/code" summary instead.

### 5b. BMD ticket extraction (best-effort, heuristic)

Each Assess agent mines Jira refs from the **commit history of the files it relied on**:

```
git -C <repo> log -n 15 --format='%s' -- <path-relative-to-repo> | grep -oiE 'BMD-[0-9]+' | sort -u
```

(repos: `frontend` `backend` `library` `journey-tests`), taking up to ~4 recent distinct
refs per story. **Caveats:** a file's history spans many tickets, so these are *related*,
not authoritative; coverage is uneven (backend ~60% of commits carry BMD-, frontend ~13%,
journey-tests sparse — tickets there often live only in branch/PR names). A blank cell is
normal and acceptable. Agents must never fabricate refs.

After the workflow, `scripts/linkify-tickets.mjs` (Step 5) rewrites every `BMD-NNN` in
`assessment.md` as a clickable Jira link — `https://eaflood.atlassian.net/browse/BMD-NNN`
(override via `JIRA_BROWSE_URL`). It is idempotent (skips refs already inside a link).

## 6. Human review (Step 5 — do not skip)

The synthesis is strong but not infallible. Before presenting:
- **Reconcile counts**: NOW sub-counts must sum to the NOW total; "all expected-absent"
  lines must not silently include a placeholder. (In the 2026-06-22 baseline the first
  synthesis mis-stated the placeholder total — 6 vs the correct 8 — and called a LATER
  phase "all expected-absent" when one was a placeholder.)
- **Spot-check** 2-3 top *delivery gaps* against code via `grep` (e.g. "no map library",
  "no GA tag") so an endorsed "not built" is actually true.

## 7. Known gotchas

- **Run from the harness root** so `journey-tests/` / `frontend/` / `backend/` /
  `library/` symlinks and `roadmap-assessment/` resolve.
- **Do not pass roadmap data via Workflow `args`** — it can arrive JSON-encoded as a
  string (breaking `args.themes`). The workflow reads `roadmap.json` via the Load agent
  instead; keep it that way.
- **Keep the working dir gitignored — but ANCHOR the pattern.** Use `/roadmap-assessment/`
  (leading slash) in `.gitignore`, NOT `roadmap-assessment/`: an unanchored pattern also
  ignores the checked-in skill at `.claude/skills/roadmap-assessment/`. `scripts/build-docs.mjs`
  publishes the harness `docs/` folder to the public Pages site, so the internal export +
  analysis must stay out of `docs/`; publish only a deliberately sanitised summary.
- **One markdown deliverable.** The parser emits only `roadmap.json` (intermediate); the
  workflow emits only `assessment.md`. There is no `roadmap.md`.
- **Single CSV** in `source/`; the parser takes the first `*.csv`.

## 8. 2026-06-22 baseline (BNG Backlog)

112 stickies → 20 themes · 77 stories · 10 user needs. Phase split:
NOW 35 · NEXT 7 · LATER 28 · EVEN LATER 7. NOW outcome: 12 on-track (34% e2e) /
8 test-gap / 10 delivery-gap / 5 placeholder; nothing built ahead of plan.
