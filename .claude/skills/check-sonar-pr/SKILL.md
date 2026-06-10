---
description: Query SonarCloud for everything failing the current PR's quality gate — the gate conditions, PR-scoped issues, AND Security Hotspots (which ride on a separate API) — then offer to fix them. Project-agnostic — reads project key from sonar-project.properties.
userInvocable: true
arguments: [project-key] [branch-name]   — both optional; defaults to sonar-project.properties + current git branch
---

# Check SonarCloud for the current PR's open issues

This skill lists the issues SonarCloud has flagged on the **PR for the current branch** (not the issues on `main`). It hits the SonarCloud REST API directly — no MCP server, no `sonar` CLI required.

## Step 0 — Verify the SonarCloud token is available

Run `printf '%s' "${SONAR_TOKEN:-}" | wc -c` via the Bash tool. If the result is `0`, the token is not in the shell. **Stop and show the user the setup instructions below — do not proceed.**

> **You need a SonarCloud user token for this skill to work.**
>
> 1. Sign in at https://sonarcloud.io
> 2. Click your avatar (top right) → **My Account** → **Security**
> 3. Under **Generate Tokens**, enter a name (e.g. `claude-code-local`) and click **Generate**
> 4. Copy the token value **immediately** — SonarCloud does not show it again
> 5. Make it available to Claude Code in **one** of these ways:
>
>    **Option A — environment variable (most common):**
>    ```sh
>    export SONAR_TOKEN='<paste-token-here>'
>    ```
>    Add this to your `~/.zshrc` (or `~/.bashrc`) so it persists, then **restart Claude Code** so the new shell process picks it up. The Bash tool only sees env vars present when Claude Code was launched.
>
>    **Option B — keychain-style file:**
>    ```sh
>    mkdir -p ~/.config && printf '%s' '<paste-token-here>' > ~/.config/sonar-token && chmod 600 ~/.config/sonar-token
>    ```
>    Then ask the user to update this skill (or pass `SONAR_TOKEN="$(cat ~/.config/sonar-token)"` on the command line) — the file is read-protected to your user.
>
> 6. Once set, verify with:
>    ```sh
>    curl -s -u "$SONAR_TOKEN:" https://sonarcloud.io/api/authentication/validate
>    ```
>    Expected output: `{"valid":true}`

If the token is set, validate it before any other API call. If the validate endpoint returns `{"valid":false}` or an HTTP error, stop and tell the user the token is invalid/expired and they need to regenerate it.

## Step 1 — Resolve project key and branch

If the user passed a project key as the first argument, use it. Otherwise read it from `sonar-project.properties` in the working directory (look for `sonar.projectKey=...`). If neither is available, ask the user for the project key.

If the user passed a branch as the second argument, use it. Otherwise run `git rev-parse --abbrev-ref HEAD` to get the current branch.

Surface what you resolved before continuing — e.g. "Checking project `DEFRA_bng-metric-backend` on branch `feature/abc`."

## Step 2 — Find the open PR for this branch

```sh
curl -s -u "$SONAR_TOKEN:" \
  "https://sonarcloud.io/api/project_pull_requests/list?project=<project-key>" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); [print(pr['key'], pr['branch'], pr['status']['qualityGateStatus'], 'smells='+str(pr['status'].get('codeSmells',0)), 'bugs='+str(pr['status'].get('bugs',0)), 'vulns='+str(pr['status'].get('vulnerabilities',0)), 'hotspots='+str(pr['status'].get('securityHotspots',0))) for pr in d['pullRequests']]"
```

Note the `hotspots=` count: Security Hotspots are tracked separately from issues (see Steps 3 and 5) and a non-zero count is a frequent cause of a red gate.

Match the `branch` field to the resolved branch name. If no matching PR exists, tell the user:
- The branch may not be associated with a GitHub PR yet (open one)
- SonarCloud may not have analyzed the PR yet (push a commit; analysis usually fires from CI)
- The project key may be wrong

If a PR is found, capture its `key` (the SonarCloud PR ID — usually matches the GitHub PR number).

> **A green issue list does not mean a green gate.** The gate can be `ERROR` with **zero issues** — most often because of unreviewed **Security Hotspots** (a separate API; see Step 5) or a ratings / coverage / duplication threshold. Always check the gate *conditions* (Step 3), not just the issue count.

## Step 3 — Check the failing quality-gate conditions

This is the authoritative answer to "why is the gate red?". It lists every gate condition with its status, so you see immediately whether the failure is issues, hotspots, ratings, coverage or duplication:

```sh
curl -s -u "$SONAR_TOKEN:" \
  "https://sonarcloud.io/api/qualitygates/project_status?projectKey=<project-key>&pullRequest=<pr-key>" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); [print(c['status'], c['metricKey'], 'actual='+c.get('actualValue','?'), c.get('comparator',''), 'threshold='+c.get('errorThreshold','?')) for c in d['projectStatus']['conditions']]"
```

Report the `ERROR` conditions first, then map each to where you'll look next:
- `new_*_violations`, `new_reliability_rating`, `new_security_rating`, `new_maintainability_rating` → **issues** (Step 4). Note the **security rating** is driven by Vulnerability-type issues, so an `ERROR` there usually pairs with a Step 4 vulnerability.
- `new_security_hotspots_reviewed` (< 100%) → **Security Hotspots** (Step 5). **This condition is invisible to the issues API** — it is the classic reason a PR with 0 issues still fails.
- `new_coverage`, `new_duplicated_lines_density` → not code issues; tell the user it's a coverage/duplication threshold, not something to "fix" by editing flagged lines.

## Step 4 — List PR-scoped issues

```sh
curl -s -u "$SONAR_TOKEN:" \
  "https://sonarcloud.io/api/issues/search?componentKeys=<project-key>&pullRequest=<pr-key>&resolved=false&ps=500&s=SEVERITY&asc=false"
```

Parse the JSON response and present a grouped table:
- Group by severity (BLOCKER / CRITICAL / MAJOR / MINOR / INFO)
- Within each group, list: rule key, file:line, one-line message
- Show total count + breakdown at top

Strip the project-key prefix from `component` (everything before `:`) so paths are repo-relative.

**Important — PR scope vs main scope:** the `pullRequest=` parameter limits results to issues that SonarCloud considers "new code" on this PR. Pre-existing issues on `main` are **not** returned. If the user asks "why didn't this issue show up before?", that's why — they live on `main` and would be queried separately by omitting `pullRequest=` (or replacing it with `branch=main`).

## Step 5 — List Security Hotspots (a SEPARATE endpoint!)

**Security Hotspots are NOT issues and do NOT appear in `api/issues/search`.** They are security-sensitive code SonarCloud wants a human to review (rate Safe / Fixed / at-risk). They have their own endpoint and their own gate condition (`new_security_hotspots_reviewed`), so every step above is blind to them — a PR can show **0 issues and still fail the gate** purely on hotspots. Always run this step when the gate is red.

```sh
curl -s -u "$SONAR_TOKEN:" \
  "https://sonarcloud.io/api/hotspots/search?projectKey=<project-key>&pullRequest=<pr-key>&ps=500" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); hs=d.get('hotspots',[]); print('hotspots:', len(hs)); [print(' ', h.get('vulnerabilityProbability'), h.get('ruleKey'), h['component'].split(':',1)[-1]+':'+str(h.get('line','?')), '| status='+h.get('status','?'), '|', h.get('message','')) for h in hs]"
```

List each hotspot's rule, file:line, probability (HIGH/MEDIUM/LOW), status (`TO_REVIEW` / `REVIEWED`) and message. Any hotspot left `TO_REVIEW` drags `new_security_hotspots_reviewed` below 100% and fails the gate. (For full detail on one hotspot use `api/hotspots/show?hotspot=<key>`.)

Clear hotspots by **editing the code** wherever you reasonably can — the hotspot then disappears on the next scan, no permissions needed. Common JS/TS hotspot rules:
- **S5852** (ReDoS / super-linear regex backtracking) — remove the overlap between adjacent quantifiers, e.g. `\s+(.*)` → `\s+(\S.*)`; or replace a `…+$`-style strip such as `str.replace(/\/+$/, '')` with a regex-free loop.
- **S2068 / S6418** (hardcoded credentials/secrets) — move the value to an env var / secret store.
- **S5144** (SSRF) / **S5145** (log-injection) — validate, allowlist, or drop the untrusted value (request/response data and `process.env` are all treated as untrusted).
- **S2245** (`Math.random` used for something security-sensitive) — use `crypto`.

If a hotspot is a genuine false positive that can't reasonably be refactored away, it must be **reviewed** (not fixed in code). That needs the `Administer Security Hotspots` permission and a status change — it cannot be cleared via the issue endpoints:

```sh
curl -s -u "$SONAR_TOKEN:" -X POST "https://sonarcloud.io/api/hotspots/change_status" \
  --data-urlencode "hotspot=<hotspot-key>" --data-urlencode "status=REVIEWED" \
  --data-urlencode "resolution=SAFE" --data-urlencode "comment=<why it is safe>"
```

Prefer the code fix; only mark Safe when refactoring genuinely isn't warranted, and tell the user you did so and why.

## Step 6 — Offer to fix

After listing **both** issues (Step 4) and hotspots (Step 5), ask the user whether to:
- **Fix all** — apply mechanical fixes for the trivial rules (S7723 `new Error()`, S7764 `globalThis`, S7773 `Number.parseInt`, S7748 zero fractions, S121 missing braces, S2138 `null`-vs-`undefined`), the more substantial refactors (S1192 string extraction, S109 magic numbers, S138/S3776 function length & cognitive complexity, S134 nesting, S126 missing-else, S4624 nested template literals, S7785 top-level await, S7721 hoist function, S1117 shadowing, S7776 array-to-Set), **and the Security Hotspots from Step 5** (e.g. S5852 ReDoS, S5145 log-injection). Don't stop at issues.
- **Fix selected severities only** (e.g. just CRITICAL/MAJOR), **or just what's blocking the gate** (cross-reference the failing conditions from Step 3 — sometimes only the hotspots, or only a single vulnerability, are red).
- **Fix one specific issue or hotspot** (give the rule + file:line).
- **Just report**, don't fix.

For each fix:
1. Read the affected file
2. Apply the edit (Edit/Write tool)
3. After all edits in a batch, run `npm run format` and `npm run lint` from the affected sibling repo
4. Run the relevant test suite (`npm test` for unit, `npm run test:integration:full` for backend integration)
5. **Push & wait for the next SonarCloud scan, then re-run Steps 3 + 5** before claiming success — SonarCloud only re-evaluates on push, and the gate can stay red on a hotspot or a condition you didn't look at.

**Watch for fixes that trade one rule for another.** A "fix" can introduce a new finding the first scan didn't show: e.g. adding an `else` to satisfy **S126** can push a function past the **S3776** cognitive-complexity limit; extracting a string can create a duplicate (**S1192**); wrapping `main().catch()` reintroduces a promise chain (**S7785**). Re-check the gate after every push rather than assuming a one-shot fix cleared everything.

## Step 7 (optional) — Show the main-branch backlog

If the user wants the broader picture (issues already on `main`, not just new-code on this PR), drop the `pullRequest=` filter:

```sh
curl -s -u "$SONAR_TOKEN:" \
  "https://sonarcloud.io/api/issues/search?componentKeys=<project-key>&resolved=false&ps=500"
```

Make this an explicit follow-up — don't bundle it with the PR view by default, since it's a much longer list and a different concern.

## Common gotchas

- **Gate is `ERROR` but the issue list is empty**: the failure is a condition the issues API can't see — almost always **Security Hotspots** (Step 5, `new_security_hotspots_reviewed`), or a ratings/coverage/duplication threshold. Read the gate conditions (Step 3) first; never conclude "nothing to fix" from the issue list alone.
- **Security Hotspots vs issues are different APIs**: `api/issues/search` returns issues (bugs/smells/vulnerabilities); `api/hotspots/search` returns hotspots. They have separate counts (`vulnerabilities` ≠ `securityHotspots`), separate gate conditions, and separate resolution flows. A hotspot is cleared by editing the code (best) or `api/hotspots/change_status` — never by anything the issue endpoints do.
- **Marking a hotspot Safe needs permission**: `api/hotspots/change_status` requires `Administer Security Hotspots` on the project; a plain Browse token gets 403. Prefer refactoring the code so the hotspot disappears on the next scan.
- **`SONAR_TOKEN` not visible to Bash tool**: Claude Code's shell process inherits env vars from when it was launched. Exporting after launch won't help — restart Claude Code.
- **PR-scoped scan hasn't run yet**: a fresh push triggers SonarCloud analysis via the project's webhook/CI; can take a minute or two.
- **Self-hosted SonarQube** (not SonarCloud): replace `https://sonarcloud.io` with the user's `SONAR_HOST_URL` env var. Same API surface.
- **403 on every call**: token doesn't have `Browse` permission on the project. User needs to regenerate with the right scope, or ask the project admin.
- **Issues list is paginated**: `ps=500` is the API max. If a project has more than 500 open issues, paginate with `&p=2`, `&p=3`, etc., and merge.
