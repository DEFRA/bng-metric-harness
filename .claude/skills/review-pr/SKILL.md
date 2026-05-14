---
description: Review a GitHub pull request efficiently using minimal API calls
userInvocable: true
arguments: PR URL or owner/repo#number
---

# Review a GitHub Pull Request

You are reviewing a GitHub pull request. Extract the owner, repo, and PR number from the user's input.

## Step 1: Fetch PR metadata, patches, and existing review comments

Prefer `gh` CLI over WebFetch — it returns full data without truncation and authenticates against private repos. Run these in parallel:

1. **PR metadata** — `gh api repos/{owner}/{repo}/pulls/{number}`
   - Capture: title, body, base branch, head ref + sha, changed files count, additions/deletions, head repo `clone_url` (needed for cross-fork worktrees).
2. **File patches** — `gh api repos/{owner}/{repo}/pulls/{number}/files --paginate`
   - Pipe through `jq` to drop lockfiles and keep only `filename` + `patch`:
     ```
     jq -r '.[] | select(.filename | test("package-lock.json|yarn.lock|pnpm-lock.yaml") | not) | "=== \(.filename) ===\n\(.patch // "[binary]")\n"'
     ```
   - Also extract the file list (`filename`, `status`, additions, deletions) — you need it for the Step 2 gate.
3. **Existing review comments** — `gh api repos/{owner}/{repo}/pulls/{number}/comments`
   - Read these BEFORE writing your review. Skip findings other reviewers already raised; note which ones the author has already addressed.

### Files to always skip in review

- package-lock.json
- yarn.lock
- pnpm-lock.yaml
- Any auto-generated lockfiles

## Step 2: Decide review mode — patches-only or worktree

Choose **worktree mode** if any of these hold; otherwise stay in **patches-only mode**:

- ≥ 20 changed files in the PR, OR
- a whole module is deleted, renamed, or replaced (`status` of `removed`/`renamed`, or a new file that obviously supersedes a deleted one), OR
- a new JSON-schema / type-definition / allowlist / enum / dispatcher-style "contract" file is added, OR
- a new top-level directory or package is added, OR
- changed files reference identifiers (imports, function calls, route paths, error codes) that don't appear in the diff and would need grepping to verify, OR
- the user explicitly asks for a deep / thorough review.

State the chosen mode in one sentence before proceeding (e.g. "Worktree mode — 35 changed files plus a deleted module").

### Patches-only mode

Use the patches from Step 1 directly. If a specific finding needs more context than the diff shows, fetch the single file at the PR head sha:

```
gh api repos/{owner}/{repo}/contents/{path}?ref={head_sha} \
  --jq '.content' | base64 -d
```

Do **not** clone the repo in this mode.

### Worktree mode

Check the PR branch out into an isolated worktree using the `EnterWorktree` tool. The worktree gives you:

- direct `Read` access to every file at the PR's head sha,
- `grep -r` / `Grep` across the whole tree,
- `git log -- <path>` for history of files the diff touches,
- ability to run `npm install` / `npm test` / `npm run lint` / type checks if doing so would resolve a specific question.

For cross-fork PRs, use the head repo's `clone_url` and the head `ref` (both captured in Step 1). Always pair `EnterWorktree` with `ExitWorktree` at the end of the review so no orphan checkouts are left behind.

Keep worktree work scoped to questions the patches alone can't answer — don't re-read everything just because you can.

### When you need more than patches (either mode)

The patch is sufficient for **local** findings — bugs, naming, style, missing null checks inside the changed code.

The patch is **not** sufficient when the diff introduces or changes a *contract* — anything that defines "what's valid" for the rest of the codebase. Diff hunks elide exactly the entries you need to compare (an alias map drifting from a new schema looks fine in isolation — the bug is what's *not* in the diff).

Contract-shaped changes include:

- New or modified JSON schemas, type definitions, enums, allowlists.
- New or modified validators, guards, route allow-sets.
- New or modified alias maps, lookup tables, dispatcher switches.
- Deleted or renamed modules (other importers may now disagree with the replacement's contract).

For each contract change, before commenting:

- Search for the symbol names, table/layer/role names, error codes, etc. defined in the new contract. In worktree mode use `Grep` / `rg`; in patches-only mode use `gh api .../contents/...` for the specific files you suspect.
- Read every parallel definition in full.
- Read every downstream consumer in full.

If you find yourself wanting to grep but you're in patches-only mode and the gate criteria above clearly apply, escalate to worktree mode mid-review rather than guessing.

## Step 3: Analyse and report

Review the diff holistically. Organise findings into the categories below, and within each category order findings by severity (highest first) and tag each with an explicit severity label.

### Severity scale

Use exactly these labels:

- **Blocker** — must fix before merge. Data loss, security hole, broken contract, regression of a shipped feature, or anything that would page someone if merged today.
- **Major** — should fix before merge. Wrong behaviour in a non-edge case, missing test on a new code path that can fail in production, contract drift that silently drops data, missing validation on a user-facing input.
- **Minor** — fix soon but not blocking. Edge-case correctness, awkward API, structural duplication, stale comments, dead code, brittle test setup.
- **Nit** — opinion-level. Naming, formatting, ordering, wording.

Apply severity *within* a category — a "Minor" security finding is still less urgent than a "Blocker" correctness one. The overall assessment at the end should reflect the highest severity present.

Organise findings into these categories:

### Security

- Input validation gaps (client-side only, missing server-side checks)
- Authentication/authorisation issues
- Injection risks (SQL, XSS, command injection)
- Secrets or credentials in code
- CSRF considerations for state-changing endpoints

### Correctness

- Logic errors, off-by-one, null/undefined handling
- Missing error handling for external calls
- Race conditions or state management issues
- In worktree mode, you may run the test suite or type checker to verify a suspected regression rather than reasoning alone.

### Contract & consistency

When the PR defines or changes what's valid (schemas, allowlists, alias maps, enums, validators, route allow-sets), specifically check:

- **Entries in the new contract but absent from a downstream consumer** → data silently dropped, no error, no log. (e.g. schema declares layer X, but the reader's alias map has no entry mapping to X.)
- **Entries in a downstream consumer but absent from the new contract** → rejected upstream before the consumer ever runs. (e.g. reader accepts layer Y, but the new validator rejects it as unexpected.)
- **Multiple downstream "accept" forms but only one canonical form in the contract** → most of the downstream accept-list becomes dead code.
- **Deleted/replaced module**: list every importer of the old path (in worktree mode use `Grep "old/path"`; in patches-only mode fetch suspected importers individually) and verify each still aligns with the replacement's contract.
- **Parallel definitions** of the same domain concept (e.g. layer names, role lists, error codes) defined in more than one file — flag any drift, even if the diff only touches one side.

### Code quality

- Naming, readability, duplication
- Consistency with surrounding codebase patterns
- Test coverage gaps (are new paths tested?)

### GDS/GOV.UK compliance (if frontend changes)

- Accessibility (ARIA, labels, error summaries)
- Design system component usage
- Back links, breadcrumbs, page titles

### Nits (keep brief)

- Minor style or formatting issues

## Step 4: Output

Start with a one-line summary of what the PR does, then state which review mode was used (patches-only or worktree, with a one-line reason).

Then a table showing the highest-severity finding per area:

| Area                    | Highest severity | Count |
| ----------------------- | ---------------- | ----- |
| Security                | Blocker / Major / Minor / Nit / —  | n  |
| Correctness             | ...              | ...   |
| Contract & consistency  | ...              | ...   |
| Code quality            | ...              | ...   |
| Tests                   | ...              | ...   |

Use "—" if a category has no findings, and skip listing it in the body. Do not say "looks good".

Then list findings grouped by category, ordered by severity (Blocker → Major → Minor → Nit) within each category. Prefix each finding with its severity in bold, e.g.:

> - **Blocker** — `src/foo.js:42` SQL identifier from user input flows unescaped into `db.prepare(...)`. …
> - **Minor** — `src/bar.js:88` stale MERGE NOTE comment now contradicts the surrounding code.

Reference the file and line for each finding.

End with an overall assessment that names the highest severity present and gives a clear merge recommendation (block / request changes / approve with nits / approve).

Do not repeat findings that already appear in the existing review comments fetched in Step 1 — note briefly that prior comments were considered.

## Step 5: Clean up

If you entered worktree mode, call `ExitWorktree` before finishing. Leave the user's main checkout untouched.
