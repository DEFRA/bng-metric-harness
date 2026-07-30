---
name: geopackage-validation-explainer
description: >-
  Generate (or refresh) a plain-English table of the validation rules the BNG
  Metric service enforces when checking an uploaded GeoPackage — what each rule
  checks, and which example .gpkg demonstrates it. The rule list, the message the
  user sees and the fixture mapping are all extracted from the code on every run,
  so the document cannot drift out of step with it. Use when asked to explain or
  document GeoPackage validation, upload errors, why a file was rejected, the
  baseline file checks, or which fixtures cover which rules; or to re-run it
  periodically to check the published documentation still matches the code.
  Delivers BMD-887.
userInvocable: true
arguments: "[generate|check] [output-path]  — mode defaults to check when a document already exists, generate otherwise"
---

# Plain-English GeoPackage validation explainer

Produce the document that answers **BMD-887**: which rules cause an uploaded GeoPackage to be rejected, what each one checks, and which example file demonstrates it.

**The scripts do the work. The model only writes descriptions for rules that do not have one.**

The document is a table, assembled deterministically from three inputs:

| Input | Supplies |
| --- | --- |
| `bng-metric-backend` | Which rules exist, where each is enforced, the message it raises |
| `bng-metric-frontend` | Whether the user sees a bespoke message, a placeholder, or a generic catch-all |
| `bng-library` + `example-files/` | Which generator flaw exercises each rule, and — by running the real gate over every fixture — which `.gpkg` demonstrates it |
| `references/rule-descriptions.json` | What each rule checks, in plain English. Created and topped up by the skill; names the constant for any threshold rather than stating the number |

The gap between them is the point. A rule with no example file, that reaches the user as a generic message, is exactly what the document must not imply is well covered.

## Runtime — read before changing anything

A full run is **under a second** and spawns no agents. That is deliberate and was expensive to achieve.

The first version had the model trace all 50 rules with four parallel agents, write ~4,700 words of prose, and verify it with two more agents: 20–40 minutes per run, and a document that reworded itself even when the code had not changed. Descriptions are now cached in `references/rule-descriptions.json`, which the skill creates and tops up itself, so:

- **Nothing changed** → facts diff reports `NO CHANGE`, stop. No document rebuild, no model work.
- **Codes changed but all still described** → rebuild, no model work.
- **A genuinely new code** → the draft step writes an entry for it from the code and flags it; the model rewrites *that one entry* for a non-technical reader.
- **The descriptions file is missing entirely** → recreated in full as drafts, and the run rewrites them.

Settled entries are never regenerated. That is what keeps a no-change run free of model work, and it keeps the published document's diffs readable — only the rules that actually moved change wording.

If you find yourself adding a narrative section, a remedy column or an adversarial verification sweep, you are rebuilding the slow version. The prose that was cut is in git history if it is ever wanted.

**Descriptions state no numbers.** Every threshold is named by its constant and extracted at build time, so tolerances cannot drift and a tolerance change needs no model attention at all. This replaced a proposal to hash the upstream facts and track per-description staleness — extracting the volatile values was simpler and covered the same ground.

## Modes

- **generate** — extract facts, build the document, verify.
- **check** — extract facts, diff against the last run, stop early if nothing changed.

Resolve from the first argument. With none, use **check** if a document already exists at the output path, otherwise **generate**.

## Prerequisites

Run from the harness root with Node 24 (`nvm use` first). No database is needed and nothing is installed. Most steps read source only; the one exception is the fixture-observation step, which loads the backend's validation gate and therefore needs the backend's dependencies present (`npm run install:be`).

**Check the siblings are on the branch you mean to describe.** They are frequently left on feature branches, and the document will faithfully describe whatever is checked out. `npm run branch` shows all four at once. To describe what is deployed, put all three siblings on `main` and pull first — note `npm run pull` fast-forwards the *current* branch rather than switching, so an explicit checkout is needed.

---

## Step 0 — Scaffold the working directory (idempotent)

`build-docs.mjs` sweeps every `.md` under `docs/` into the published site, so intermediates must live elsewhere and stay gitignored:

```bash
mkdir -p .geopackage-validation-explainer
grep -qxF '/.geopackage-validation-explainer/' .gitignore 2>/dev/null || \
  printf '\n# GeoPackage validation explainer working state — intermediates, not deliverables\n/.geopackage-validation-explainer/\n' >> .gitignore
```

Only the finished document goes into `docs/`.

## Step 1 — Observe which fixture demonstrates which rule

```bash
LOG_LEVEL=silent node .claude/skills/geopackage-validation-explainer/scripts/observe-fixtures.mjs \
  --out .geopackage-validation-explainer/fixture-map.json
```

Runs the real validation gate over every `.gpkg` in `example-files/` and records what it reports. `LOG_LEVEL=silent` suppresses the backend's own logging, which would otherwise drown the output.

This is measured rather than authored, so it needs no upkeep when fixtures are added or renamed — and it catches fixtures that have quietly stopped demonstrating what they were built for.

The gate covers the file-format, layer, column, coordinate-system and shape-presence rules. It cannot reach the spatial rules, which need PostGIS, or the habitat-data rules, which run later; for those the next step falls back to the error-code columns in `example-files/README.md`.

## Step 2 — Extract and diff the facts

```bash
node .claude/skills/geopackage-validation-explainer/scripts/validation-facts.mjs \
  --out .geopackage-validation-explainer/facts.json \
  --observed .geopackage-validation-explainer/fixture-map.json \
  --compare .geopackage-validation-explainer/facts.json
```

Writes every rule with its raise sites and message, the copy status the user experiences, the generator flaw and example `.gpkg` that exercise it, and the commit of each repository. Passing the same path to `--compare` diffs against the previous run before overwriting.

**Read the summary.** The counts are content — the document's coverage section is built from them.

**In check mode, act on the diff:**

- *NO CHANGE* — the document is still accurate. Say so, name the commits, stop. This is the expected outcome of most runs.
- *Codes added* — new rules the document does not describe. This is the case the skill exists to catch. Step 3 will draft entries for them.
- *Codes removed* — delete their entries from `rule-descriptions.json`; the build fails until you do.
- *Codes changed* — the message, copy status or fixture coverage moved. Rebuild; usually no description needs touching. A code graduating from placeholder to bespoke copy changes what the table claims even though the rule itself has not moved.

Also act on these, which are reported separately:

- *Fixtures that no longer demonstrate what the README claims* — the gate rejects that file for a different rule than `example-files/README.md` says. The observation is right; the README entry is stale and worth correcting there.
- *Codes defined but never raised* — expected for the route-level ones; investigate any others.

## Step 3 — Create or top up the descriptions

```bash
node .claude/skills/geopackage-validation-explainer/scripts/draft-descriptions.mjs \
  --facts .geopackage-validation-explainer/facts.json
```

Guarantees an entry for every rule, so the file never has to be maintained by hand. It creates the file if absent, drafts an entry for any rule that lacks one — from the registry's doc comment, else the literal message the rule raises, else the rule name — infers its group, and prunes entries for rules that no longer exist. Existing settled entries are left untouched.

**A draft is not publishable.** It is developer-facing text lifted from the code: "Layer … baseline mismatch: missing column …", or "Hedgerows unreadable geometry". Each is marked `"drafted": true` and listed in the output.

**Rewriting those drafts is the model's only job in this run.** For each one, read its check site from the facts file, rewrite `checks` for a non-technical reader per `references/output-spec.md` — one or two sentences on the condition, no remedies, no code identifiers, no numbers — then delete its `drafted` flag. Correct the inferred `group` if it landed wrong, and if any rule fell into `Other rules`, decide where it really belongs.

If nothing was drafted, there is nothing to do here and the run carries straight on.

## Step 4 — Build the document

```bash
node .claude/skills/geopackage-validation-explainer/scripts/build-document.mjs \
  --facts .geopackage-validation-explainer/facts.json \
  --out docs/geopackage-validation-explained.md
```

Deterministic: same inputs, byte-identical output. It builds even with drafts outstanding — a run has to be able to finish — but says `NOT READY TO PUBLISH` and names them. Do not publish or commit in that state; go back to Step 3.

## Step 5 — Verify

```bash
node .claude/skills/geopackage-validation-explainer/scripts/doc-coverage.mjs \
  --facts .geopackage-validation-explainer/facts.json \
  --doc docs/geopackage-validation-explained.md
```

Fails when a rule has no row, when a row names a rule that no longer exists, or when a referenced example file is not on disk.

Then read the rows you added or changed, as the audience would. Any sentence needing programming knowledge gets rewritten. Check the tolerance against the facts file and confirm the description says what passes as well as what fails.

**Do not restate what the user is shown** in a description — the script generates that sentence from the facts file, and a hand-written version will contradict it as soon as the copy changes.

## Step 6 — Publish to Confluence

Confluence is where this document lives, so the run is not finished when the markdown is written. Paste it and check the tables kept their columns and that no raw HTML shows as literal text. There is no Mermaid and no images, so nothing else needs attention.

This step is manual. The skill has no Confluence credentials and must not attempt to publish on its own.

## Step 7 — Report

Say what changed: the output path, the three commits it reflects, how many rules are documented, how many have an example file, and how many reach the user as a generic message. In check mode, lead with whether the document was still accurate.

Offer to raise tickets for gaps the run exposed — a rule with no example file, a placeholder pending long enough to look permanent, or a fixture mapping that has rotted.

---

## Cadence

Monthly in check mode, plus an ad-hoc run after any change to the validation pipeline, the error copy or the example corpus. A no-op run is now cheap enough that there is no reason to skip it. To automate, use the `schedule` skill and report only when the diff is non-empty.

The drift this catches is quiet: a rule added without documentation, a placeholder graduating to real copy, or a fixture renamed so a rule silently stops being demonstrated.

## Files in this skill

- `scripts/_lib.mjs` — locates the three repositories by probing for the file each must supply, plus git provenance and shared parsing helpers.
- `scripts/observe-fixtures.mjs` — runs the real validation gate over every `.gpkg` in `example-files/` and records which rule each one trips. Nothing about the fixture mapping is hand-authored.
- `scripts/validation-facts.mjs` — extracts the rule list, reconciles it across the repositories and the example corpus, diffs runs.
- `scripts/draft-descriptions.mjs` — creates or tops up the descriptions file so no rule is ever undescribed, and prunes rules that have gone.
- `scripts/build-document.mjs` — assembles the document; reports any description still an unrewritten draft.
- `scripts/doc-coverage.mjs` — verifies the document on disk against the facts.
- `references/rule-descriptions.json` — what each rule checks. The only authored prose.
- `references/output-spec.md` — document shape and the house style for descriptions.

## Gotchas

- **Node 24.** `nvm use` first.
- **The document is generated, never hand-edited.** A fix applied to the output is overwritten on the next run; change the generator, the descriptions or the spec.
- **`docs/` is published.** Intermediates stay in `.geopackage-validation-explainer/`.
- **Fixture mapping is observed, not authored, and observation wins.** `observe-fixtures.mjs` runs the real gate over every fixture; whatever it reports is authoritative. The error-code columns in `example-files/README.md` are used only for files the gate *passes*, since those fail later at a stage needing PostGIS that cannot be run here. Where the README claims a code for a file the gate rejects with something else, the run reports the disagreement — that means the fixture has stopped demonstrating what it was built for. This replaced a hand-written mapping file, which had to be remembered and which silently degraded a renamed fixture into a false "no geopackage fixture" claim.
- **The observe step needs the backend's dependencies installed**, because it loads the native SQLite binding. It exits with guidance if they are missing rather than producing an empty mapping that would strip every fixture from the document.
- **The example corpus is nobody's dependency.** `example-files/` is a reference corpus for people; `journey-tests` and `backend` keep their own copies, already differing byte-for-byte in places. A rule with an example file here is not necessarily covered by an automated test.
- **Flaw keys in the library are inconsistently quoted.** Most are quoted, `sliver` is not. The extractor handles both; if fixture attribution ever looks wrong, suspect that pattern first — a missed key silently attributes every later fixture to the previous one.
- **Some codes are raised indirectly**, passed as configuration rather than to `makeError` at the call site, and some messages are composed at runtime. Both show a `null` message in the facts file. That is correct extraction, not a failure.
- **Codes are raised outside `src/validation`.** The route and persistence codes live under `src/services` and `src/routes`, which is why the scan covers all of `src`.
- **Two extraction traps, both fixed, both easy to reintroduce.** Doc comments must be matched to the *last* comment adjacent to a code, not the first one an anchored lazy match finds, or every code inherits every comment above it. And a message literal counts only when the code is the first argument to `makeError`, or builder-map keys pick up the previous entry's call and grab the next entry's message.
