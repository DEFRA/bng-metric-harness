// Roadmap-coverage assessment workflow (data-driven, re-runnable).
//
// Launch with:  Workflow({ scriptPath: ".claude/skills/roadmap-assessment/scripts/assessment-workflow.mjs" })
// Run from the harness root so relative paths resolve against the sibling symlinks
// (journey-tests/, frontend/, backend/, library/) and roadmap-assessment/roadmap.json.
//
// Fully data-driven: a Load agent reads roadmap.json (themes + stories + phaseCounts)
// and discovers the journey-test spec folders, so a fresh Mural re-export with
// different themes/stories needs NO script edits. (Do NOT pass roadmap data via
// `args` — it can arrive JSON-encoded as a string and break `args.themes`.)
//
// Output: a SINGLE strictly-tabular Markdown file, roadmap-assessment/assessment.md.
// Items are keyed by semantic theme + story names (no synthetic IDs). Coverage is a
// RAG emoji. A best-effort "Tickets" column carries BMD-* refs mined from the commit
// history of the implementing files (heuristic — may be blank).

export const meta = {
  name: 'roadmap-assessment',
  description: 'Assess roadmap stories (roadmap-assessment/roadmap.json) against the Playwright journey-test suite as coverage oracle, phase-relative, and write a single tabular roadmap-assessment/assessment.md',
  phases: [
    { title: 'Load', detail: 'Read roadmap.json + discover journey-test folders' },
    { title: 'Inventory', detail: 'Inventory journey-tests by folder' },
    { title: 'Assess', detail: 'Per-theme coverage verdicts + BMD tickets (NOW-gaps code-corroborated)' },
    { title: 'Verify', detail: 'Adversarially re-check covered/partial claims (skipped when a theme has none)' },
    { title: 'Synthesize', detail: 'Write the single tabular assessment.md' },
  ],
}

// Model tiering — the workflow inherits the (often Opus) session model by default, which is
// far more than most of these agents need and was the bulk of the token cost. Pin a cheaper
// tier per phase: Haiku for the mechanical Load/Inventory passes, Sonnet for the judgement
// (Assess), the adversarial re-check (Verify) and the table formatting (Synthesize). Bump any
// of these up if assessment quality drifts. (meta.phases must stay a pure literal, so the
// model names are not referenced there — this object is the single source of truth.)
const MODEL = {
  load: 'haiku',
  inventory: 'haiku',
  assess: 'sonnet',
  verify: 'sonnet',
  synth: 'sonnet',
}

// The fields the Assess agent needs to MATCH stories to tests. The full inventory (with flows /
// keyAssertions / notes) is kept in the returned record, but only this slim projection is
// embedded into every per-theme Assess prompt — otherwise the entire inventory is duplicated
// once per theme. The agent can still open a spec itself if it needs more detail.
function slimSpec(s) {
  return { file: s.file, area: s.area, title: s.title, capabilities: s.capabilities, skipped: s.skipped ?? false }
}

const LOAD_SCHEMA = {
  type: 'object',
  properties: {
    themes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          stories: {
            type: 'array',
            items: {
              type: 'object',
              properties: { text: { type: 'string' }, phase: { type: 'string' } },
              required: ['text', 'phase'],
            },
          },
        },
        required: ['name', 'stories'],
      },
    },
    phaseCounts: { type: 'object', additionalProperties: { type: 'number' } },
    testFolders: { type: 'array', items: { type: 'string' } },
  },
  required: ['themes', 'testFolders'],
}

const INV_SCHEMA = {
  type: 'object',
  properties: {
    specs: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          area: { type: 'string' },
          title: { type: 'string' },
          flows: { type: 'array', items: { type: 'string' } },
          capabilities: { type: 'array', items: { type: 'string' } },
          keyAssertions: { type: 'array', items: { type: 'string' } },
          skipped: { type: 'boolean' },
          notes: { type: 'string' },
        },
        required: ['file', 'capabilities'],
      },
    },
  },
  required: ['specs'],
}

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    themeName: { type: 'string' },
    stories: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          phase: { type: 'string' },
          coverage: { type: 'string', enum: ['covered', 'partial', 'none'] },
          relatedSummary: { type: 'string' },
          evidence: { type: 'array', items: { type: 'string' } },
          links: {
            type: 'array',
            items: {
              type: 'object',
              properties: { label: { type: 'string' }, url: { type: 'string' } },
              required: ['label', 'url'],
            },
          },
          tickets: { type: 'array', items: { type: 'string' } },
          evidenceRefs: { type: 'array', items: { type: 'string' } },
          builtButUntested: { type: 'string', enum: ['yes', 'no', 'unknown'] },
          judgment: {
            type: 'string',
            enum: ['on-track', 'gap', 'ahead', 'expected-absent', 'placeholder'],
          },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          notes: { type: 'string' },
        },
        required: ['text', 'coverage', 'judgment', 'confidence'],
      },
    },
  },
  required: ['themeName', 'stories'],
}

const SYNTH_SCHEMA = {
  type: 'object',
  properties: {
    written: { type: 'boolean' },
    path: { type: 'string' },
    progressJsonWritten: { type: 'boolean' },
    nowOnTrack: { type: 'number' },
    nowTestGap: { type: 'number' },
    nowDeliveryGap: { type: 'number' },
    journeyTestsNeeded: { type: 'array', items: { type: 'string' } },
    placeholders: { type: 'array', items: { type: 'string' } },
    topFindings: { type: 'array', items: { type: 'string' } },
  },
  required: ['written', 'topFindings'],
}

function loadPrompt() {
  return `You are bootstrapping a roadmap-coverage assessment. Repo layout from cwd: \`roadmap-assessment/\` holds the parsed roadmap; \`journey-tests/\` is the Playwright suite; \`frontend/\`, \`backend/\`, \`library/\` are the apps + shared BNG engine.

1. Read \`roadmap-assessment/roadmap.json\`. Return its \`themes\` verbatim — each as { name, stories:[{ text, phase }] } in the SAME order — and its \`phaseCounts\` object.
2. Discover journey-test spec folders: every immediate subdirectory of \`journey-tests/test/specs/\` that contains at least one \`*.spec.js\` file (return just the folder names, e.g. "authentication"). If specs also live directly in \`journey-tests/test/specs/\`, include the literal "." too.

Return { themes, phaseCounts, testFolders }.`
}

function inventoryPrompt(folder) {
  const dir = folder === '.' ? 'journey-tests/test/specs/' : `journey-tests/test/specs/${folder}/`
  return `You are inventorying the Playwright journey-test suite to build an evidence base for a roadmap-coverage assessment. Repo layout from cwd: \`journey-tests/\` is the suite, \`frontend/\` and \`backend/\` are the apps, \`library/\` is the shared engine.

Read EVERY spec in \`${dir}\` (files end in .spec.js; do NOT descend into other folders). For each spec, also read the page objects / helpers / fixtures it imports (under \`journey-tests/test/\`) so you understand what it actually drives in the UI. Skim \`journey-tests/AGENTS.md\` and \`journey-tests/README.md\` for conventions if useful.

For EACH spec file, produce one inventory entry describing what user-facing capability it PROVES works end-to-end — concretely enough to later match against roadmap stories.

Be strictly evidence-based: do NOT credit a capability the test does not exercise. If a spec is skipped/quarantined (test.skip / test.fixme / .skip), set skipped=true and note it. Return the inventory for this folder only.`
}

function reviewPrompt(theme, inventoryText) {
  return `You are assessing how well the implemented service covers a set of roadmap stories, using the Playwright JOURNEY-TEST suite as the coverage oracle. Repo layout from cwd: \`journey-tests/\`, \`frontend/\`, \`backend/\`, \`library/\` (each is its own git repo, reachable via these symlinks).

ROADMAP THEME: ${theme.name}
STORIES (JSON):
${JSON.stringify(theme.stories)}

JOURNEY-TEST INVENTORY (the evidence base, JSON):
${inventoryText}

For EACH story:

1. Decide journey-test coverage:
   - "covered": a journey test clearly exercises THIS capability end-to-end.
   - "partial": a test touches an adjacent/parent capability but does not fully exercise this story.
   - "none": no journey test exercises it.
   Be conservative — a test that merely navigates past a screen is "partial", not "covered".

2. Assign a PHASE-RELATIVE judgment. The board has NO 'done' state; phase is NOW / NEXT / LATER / EVEN LATER:
   - placeholder: story text is a placeholder / too vague (e.g. "TBC", "More stuff", "number of users ...", mostly "????", a bare trailing "?"). judgment="placeholder"; skip further work.
   - NOW + covered -> "on-track".
   - NOW + none|partial -> "gap". Do a NARROW, time-boxed code check (Grep/Glob/Read in frontend/, backend/, and library/ for engine/rules/units/gpkg logic) to classify:
       * implementing code found -> builtButUntested="yes" (TEST gap: built but unproven by journeys).
       * none found -> builtButUntested="no" (DELIVERY gap: not built).
     IMPORTANT — also check the DATABASE layer before concluding "not built". Some capabilities (audit / change history, versioning, constraints, computed values, cascades) are delivered in the backend **Liquibase changelog** (\`backend/changelog/*.xml\`) as SQL stored procedures, trigger functions and TRIGGERs — NOT application code. Grep the changelog for the feature/table (e.g. the table name, \`TRIGGER\`, \`FUNCTION\`, \`PROCEDURE\`) and read the matching \`<changeSet>\`. DB-delivered logic COUNTS AS BUILT -> builtButUntested="yes" (a TEST gap, unless a journey/integration test already proves it), never a delivery gap.
   - NEXT/LATER/EVEN LATER + covered|partial -> "ahead". (No code check needed.)
   - NEXT/LATER/EVEN LATER + none -> "expected-absent".

3. \`relatedSummary\`: ONE short human sentence on the related test and/or code (what exists and how it relates). NOT file:line citations.

4. \`evidenceRefs\`: the file path(s) you relied on (kept for the verification step; not shown to users).

5. \`evidence\` and \`links\` — EVIDENCE: a short bulleted justification for the status, for a NON-TECHNICAL audience. Each bullet is plain English explaining what IS done and what is NOT done (e.g. "Users can upload a baseline GeoPackage and it is checked end-to-end", "There is no map on the page yet — only a placeholder image"). NO file paths or code identifiers in the bullets. 2-4 bullets.
   LINKS: for the key test/code behind the status, build GitHub links on the base branch \`main\`:
   \`{ "label": "<short name, e.g. upload-baseline.spec.js>", "url": "https://github.com/DEFRA/<repo>/blob/main/<path>#L<line>" }\`
   where <repo> is one of bng-metric-frontend | bng-metric-backend | bng-library | bng-metric-journey-tests, <path> is the repo-relative path (strip any local prefix), and <line> is the relevant line (or \`#L<start>-L<end>\` for a range). Up to ~4 links.
   SCOPE: produce \`evidence\` and \`links\` ONLY for items actually assessed against code/tests — i.e. ALL NOW-phase stories (on-track / test gap / delivery gap / placeholder) and any "ahead" item. For "expected-absent" (out-of-scope future work) leave evidence=[] and links=[]. For a delivery gap (not built), evidence states plainly what is missing (and any nearest related work); links may be [] if there is genuinely no code to point to.

6. \`tickets\` (best-effort Jira refs, prefix BMD-): for each repo file you relied on, mine ticket refs from its commit history:
   \`git -C <repo> log -n 15 --format='%s' -- <path-relative-to-repo> | grep -oiE 'BMD-[0-9]+' | sort -u\`
   where <repo> is one of frontend|backend|library|journey-tests and <path-relative-to-repo> strips the repo prefix (e.g. repo=frontend, path=src/server/projects/index.js). Include up to 4 most-recent DISTINCT refs that plausibly relate to THIS story. This is HEURISTIC (a file's history may span many tickets) — leave [] if none/unclear. NEVER fabricate refs.

Set confidence (high/medium/low) and a one-line note per story. Return all stories with verdicts (themeName="${theme.name}").`
}

function verifyPrompt(review, theme) {
  return `You are ADVERSARIALLY verifying a roadmap-coverage assessment for theme "${theme.name}". Be a skeptic; catch OVER-claims.

Prior verdicts (JSON):
${JSON.stringify(review)}

Rules:
- For every story marked "covered" or "partial": OPEN the cited spec(s) (evidenceRefs) under \`journey-tests/\` and confirm the test genuinely exercises that specific story end-to-end. If not, DOWNGRADE (covered->partial, or partial->none) and fix the judgment per the phase-relative rules.
- For every story with builtButUntested="yes": confirm the cited code really implements the capability; if not, set builtButUntested="no" and re-judge as a delivery gap.
- Sanity-check \`tickets\`: drop any BMD ref that clearly cannot relate; do not add new ones.
- Check \`evidence\` reads as plain, non-technical English and matches the FINAL verdict (rewrite it if you changed coverage/judgment). Check each \`links\` url points at a file you actually cited (correct repo + path + plausible line); drop any link you cannot stand behind. Keep evidence=[] and links=[] for expected-absent items.
- Leave well-justified verdicts unchanged. Only UPGRADE coverage if you find an obviously-missed exercising test.
- Re-apply judgment rules exactly: placeholder / on-track (NOW+covered) / gap (NOW+none|partial) / ahead (future+covered|partial) / expected-absent (future+none).

Return the corrected full story list (same schema, themeName="${theme.name}").`
}

function synthPrompt(themeResults, phaseCounts) {
  return `You are writing the deliverables for a BNG roadmap-coverage assessment. You write TWO files with the Write tool.

VERIFIED RESULTS (JSON, all themes/stories — each story has coverage, judgment, confidence, relatedSummary, evidence[] (plain-language bullets), links[] ({label,url} GitHub links), tickets[]):
${JSON.stringify(themeResults)}

ROADMAP PHASE COUNTS: ${JSON.stringify(phaseCounts)}

=== FILE 1: roadmap-assessment/assessment.md ===

FORMAT RULES:
- The report is TABULAR. Each section is a short \`##\` heading followed by ONE Markdown table. The only non-table text is a single italic methodology line under the title.
- NO HTML anywhere in the output. The report is read in Confluence (and other Markdown renderers) that do NOT render raw HTML — \`<br>\` / \`<br/>\` appear as literal text, not a line break. NEVER emit an HTML tag. Markdown table cells also cannot contain a real newline, so an in-cell list is written INLINE on one line: each item prefixed \`• \` and separated by a SINGLE SPACE, e.g. \`• item one • item two\`. Multiple links in one cell are likewise space-separated. Never put a real newline or any HTML tag inside a cell.
- Identify items by their semantic THEME name and STORY text. Do NOT invent IDs.
- Coverage column: \`🟢 Covered\` / \`🟠 Partial\` / \`🔴 None\`.
- Judgement status word: \`✅ On-track\` / \`🛠️ Test gap\` / \`❌ Delivery gap\` / \`🚀 Ahead\` / \`⏳ Expected-absent\` / \`❓ Placeholder\` (a NOW "gap" is 🛠️ Test gap when builtButUntested=yes, else ❌ Delivery gap).
- EVIDENCE = the story's plain-English \`evidence\` bullets (non-technical). Show evidence ONLY for in-scope items: every NOW story and any 🚀 Ahead item. For ⏳ Expected-absent (out-of-scope future work) show NO evidence.
- "Tickets" column = the \`tickets\` array joined by ", " (blank if empty). Heuristic.
- Escape any literal \`|\` inside cells.

Today's date is in the methodology line.

SECTIONS, in this exact order:

# BNG Roadmap Coverage Assessment

*One italic line: date; journey-tests = coverage oracle (coverage = end-to-end tested, a conservative proxy for delivered); phase-relative judgment; NOW gaps split into test vs delivery via a code check; evidence is plain-language; tickets are heuristic BMD-* refs.*

## 1. Summary
| Phase | ✅ On-track | 🛠️ Test gap | ❌ Delivery gap | 🚀 Ahead | ⏳ Expected-absent | ❓ Placeholder | Total | NOW e2e coverage |
Rows: NOW, NEXT, LATER, EVEN LATER, then a **Total** row. Verify each row's tallies sum to that phase total. NOW e2e coverage % (on-track ÷ NOW total) in the NOW row's last cell; "—" elsewhere.

## 2. Top findings
| # | Type | Theme | Roadmap item | Note |
Most important first: ❌ Delivery gaps (NOW), 🛠️ Test gaps (NOW), 🚀 Ahead (if any), ❓ Placeholders.

## 3. Theme status
| Theme | Phase focus | Status | NOW built/tested | NOW gaps |
One row per theme. The **NOW gaps** cell is an inline bulleted list (\`• … • …\`, space-separated, no HTML) spelling out, in plain English, each specific NOW gap for that theme (what is missing or unproven). If a theme has no NOW gaps, put "—".

## 4. Coverage matrix
| Theme | Roadmap item | Related test/code | Phase | Coverage | Judgement | Confidence | Tickets |
EVERY story, one row, in theme order. The **Judgement** cell = the status word, then the story's evidence bullets inline on the same line: \`<status> • evidence one • evidence two\` (space-separated, no HTML). For ⏳ Expected-absent rows, the Judgement cell is JUST the status word (no bullets).

## 5. Journey tests needed
| Roadmap item | Theme | What to add | Why |
Every NOW story that is a 🛠️ Test gap or 🟠 Partial.

## 6. Recommendations & next steps
| Priority | Action | Theme / items | Type |
Prioritised. Type ∈ Build / Add journey test / Define.

=== FILE 2: roadmap-assessment/progress-now.json (sidecar for the Progress chart) ===

A JSON array, one entry per theme that has at least one NOW story, in theme order:
\`[ { "theme": "<theme name>", "evidence": ["plain-language bullet", ...], "links": [{ "label": "...", "url": "..." }, ...] } ]\`
- \`evidence\`: 2-5 plain-language, NON-TECHNICAL bullets summarising that theme's NOW progress — what is done (its on-track / test-gap stories) and what is not (its delivery-gap / placeholder stories). Aggregate across the theme's NOW stories.
- \`links\`: the most useful GitHub links across that theme's NOW stories (dedup; up to ~5), each { label, url } with url like \`https://github.com/DEFRA/<repo>/blob/main/<path>#L<line>\`.
- A theme whose NOW work is entirely not-started still gets evidence (what's missing); its links may be [].
- Use the SAME theme names as the report so the chart generator can match them.

After writing BOTH files, return a short structured summary (counts + journeyTestsNeeded + placeholders + topFindings + progressJsonWritten:true).`
}

// ---- Phase 0: load roadmap + discover test folders (data-driven) ----
phase('Load')
const loaded = await agent(loadPrompt(), { schema: LOAD_SCHEMA, model: MODEL.load, effort: 'low', phase: 'Load', label: 'load' })
const themes = loaded.themes ?? []
const phaseCounts = loaded.phaseCounts ?? {}
const testFolders = (loaded.testFolders ?? []).filter(Boolean)
log(`Loaded ${themes.length} themes; ${testFolders.length} journey-test folders`)
if (themes.length === 0 || testFolders.length === 0) {
  throw new Error('Load failed: no themes in roadmap.json or no journey-test folders discovered')
}

// ---- Phase 1: inventory the journey-test suite (fan out by folder) ----
phase('Inventory')
const invParts = await parallel(
  testFolders.map((folder) => () =>
    agent(inventoryPrompt(folder), { schema: INV_SCHEMA, model: MODEL.inventory, effort: 'low', phase: 'Inventory', label: `inv:${folder}` }),
  ),
)
const inventory = invParts.filter(Boolean).flatMap((p) => p.specs ?? [])
log(`Inventory built: ${inventory.length} journey-test specs`)
// Embed only the slim projection in the per-theme Assess prompts (see slimSpec) so the full
// inventory isn't duplicated once per theme.
const inventoryText = JSON.stringify(inventory.map(slimSpec))

// ---- Phase 2+3: assess each theme, then adversarially verify (pipeline) ----
phase('Assess')
const perTheme = await pipeline(
  themes,
  (theme) =>
    agent(reviewPrompt(theme, inventoryText), {
      schema: REVIEW_SCHEMA,
      model: MODEL.assess,
      phase: 'Assess',
      label: `assess:${theme.name.slice(0, 28)}`,
    }),
  (review, theme) => {
    // Adversarial verify exists to catch OVER-claims, and you can only over-claim a
    // "covered" / "partial" coverage. A theme whose stories are ALL "none" (all
    // expected-absent / delivery-gap / placeholder) has nothing to re-check — skip the
    // agent entirely and pass the assessment straight through. On a future-heavy board
    // this drops a large share of the Verify agents.
    const hasClaim = (review?.stories ?? []).some(
      (s) => s.coverage === 'covered' || s.coverage === 'partial',
    )
    if (!hasClaim) {
      return review
    }
    return agent(verifyPrompt(review, theme), {
      schema: REVIEW_SCHEMA,
      model: MODEL.verify,
      phase: 'Verify',
      label: `verify:${theme.name.slice(0, 28)}`,
    })
  },
)
const themeResults = perTheme.filter(Boolean)
log(`Assessed ${themeResults.length}/${themes.length} themes (verify runs only where a covered/partial claim exists)`)

// ---- Phase 4: synthesize the single tabular report ----
phase('Synthesize')
const synth = await agent(synthPrompt(themeResults, phaseCounts), { schema: SYNTH_SCHEMA, model: MODEL.synth })
log(`Report written: ${synth.written ? synth.path ?? 'roadmap-assessment/assessment.md' : 'FAILED'}`)

return { inventoryCount: inventory.length, themeResults, synth }
