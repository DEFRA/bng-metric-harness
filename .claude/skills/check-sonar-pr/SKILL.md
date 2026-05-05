---
description: Query SonarCloud for open issues on the current PR (PR-scoped new-code issues), then offer to fix them. Project-agnostic — reads project key from sonar-project.properties.
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
  | python3 -c "import json,sys; d=json.load(sys.stdin); [print(pr['key'], pr['branch'], pr['status']['qualityGateStatus'], pr['status']['codeSmells'], pr['status'].get('bugs',0), pr['status'].get('vulnerabilities',0)) for pr in d['pullRequests']]"
```

Match the `branch` field to the resolved branch name. If no matching PR exists, tell the user:
- The branch may not be associated with a GitHub PR yet (open one)
- SonarCloud may not have analyzed the PR yet (push a commit; analysis usually fires from CI)
- The project key may be wrong

If a PR is found, capture its `key` (the SonarCloud PR ID — usually matches the GitHub PR number).

## Step 3 — List PR-scoped issues

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

## Step 4 — Offer to fix

After listing, ask the user whether to:
- **Fix all** — apply mechanical fixes for the trivial rules (S7723 `new Error()`, S7764 `globalThis`, S7773 `Number.parseInt`, S7748 zero fractions, S121 missing braces, S2138 `null`-vs-`undefined`), then more substantial refactors (S1192 string extraction, S109 magic numbers, S138 function length, S134 nesting, S7721 hoist function, S1117 shadowing, S7776 array-to-Set).
- **Fix selected severities only** (e.g. just CRITICAL/MAJOR).
- **Fix one specific issue** (give the rule + file:line).
- **Just report**, don't fix.

For each fix:
1. Read the affected file
2. Apply the edit (Edit/Write tool)
3. After all edits in a batch, run `npm run format` and `npm run lint` from the affected sibling repo
4. Run the relevant test suite (`npm test` for unit, `npm run test:integration:full` for backend integration)
5. **Push & wait for the next SonarCloud scan** before claiming the issues are gone — SonarCloud only re-evaluates on push.

## Step 5 (optional) — Show the main-branch backlog

If the user wants the broader picture (issues already on `main`, not just new-code on this PR), drop the `pullRequest=` filter:

```sh
curl -s -u "$SONAR_TOKEN:" \
  "https://sonarcloud.io/api/issues/search?componentKeys=<project-key>&resolved=false&ps=500"
```

Make this an explicit follow-up — don't bundle it with the PR view by default, since it's a much longer list and a different concern.

## Common gotchas

- **`SONAR_TOKEN` not visible to Bash tool**: Claude Code's shell process inherits env vars from when it was launched. Exporting after launch won't help — restart Claude Code.
- **PR-scoped scan hasn't run yet**: a fresh push triggers SonarCloud analysis via the project's webhook/CI; can take a minute or two.
- **Self-hosted SonarQube** (not SonarCloud): replace `https://sonarcloud.io` with the user's `SONAR_HOST_URL` env var. Same API surface.
- **403 on every call**: token doesn't have `Browse` permission on the project. User needs to regenerate with the right scope, or ask the project admin.
- **Issues list is paginated**: `ps=500` is the API max. If a project has more than 500 open issues, paginate with `&p=2`, `&p=3`, etc., and merge.
