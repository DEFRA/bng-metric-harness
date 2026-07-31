# Secret scanning and credential hygiene

The BNG Metric repositories are **public**, so a committed secret is exposed the
moment it is pushed. To make that outcome as unlikely as possible, every repo in
the estate is protected by three independent layers of secret scanning. This page
documents that posture — it is the standing evidence for NFR **BMD-811**
(_"Secrets, credentials, and sensitive data must never be committed to source
control"_).

## The three layers

Defence is deliberately layered so that no single failure — a developer skipping
a hook, a scanner missing a pattern — lets a secret reach `main`.

| Layer | Where it runs | What it catches | Can it be bypassed? |
| --- | --- | --- | --- |
| **GitHub push protection** | GitHub, server-side, on every push | Known provider secret formats (AWS keys, tokens, etc.), plus non-provider patterns | Only by an explicit, audited allow decision in the GitHub UI |
| **CI secret scan** (`secret-scan.yml`) | GitHub Actions, on PR, `push` to `main`, and the merge queue | TruffleHog **verified** secrets across the diff | No — a required status check; the merge queue will not merge past a failure |
| **Local git hooks** (gitleaks via husky) | The developer's machine, pre-commit and pre-push | Secrets in staged changes (pre-commit) and the outgoing commit range (pre-push) | Yes, with `--no-verify` — but the two server-side layers still block |

The local layer is the fast feedback loop (a secret never even leaves the laptop);
the two server-side layers are the guarantees (they cannot be skipped).

## Coverage

All five repositories carry all three layers:

| Repository | GitHub push protection | CI `secret-scan.yml` | Local gitleaks hooks |
| --- | --- | --- | --- |
| `bng-metric-harness` | ✅ | ✅ | ✅ |
| `bng-metric-frontend` | ✅ | ✅ | ✅ |
| `bng-metric-backend` | ✅ | ✅ | ✅ |
| `bng-metric-journey-tests` | ✅ | ✅ | ✅ |
| `bng-library` | ✅ | ✅ | ✅ |

GitHub secret scanning, push protection, and non-provider pattern detection are
enabled on each repo under **Settings → Code security**. The state can be
confirmed with the API:

```sh
gh api repos/DEFRA/<repo> --jq '.security_and_analysis'
```

## The CI scan (`secret-scan.yml`)

Each repo runs [TruffleHog](https://github.com/trufflesecurity/trufflehog) in
`--only-verified` mode: it reports a finding only when it can actively confirm the
credential is live, which keeps false positives near zero. The workflow triggers
on:

- **`pull_request`** — scans the PR diff,
- **`push` to `main`** — scans the pushed range,
- **`merge_group`** — scans the merge queue's temporary branch, so the scan is a
  status the queue can gate on (without this, a queued PR could merge without the
  scan ever running against the commit that actually lands).

Both the action and its scanner image are pinned by commit SHA / digest, so the
scanner itself can't be swapped out from under us by an upstream tag move.

## The local hooks (gitleaks)

On `npm install`, each repo's `postinstall` sets up husky and downloads a pinned
[gitleaks](https://github.com/gitleaks/gitleaks) binary into
`node_modules/.gitleaks/bin` (checksum-verified; falls back to a system gitleaks
on `PATH`). Two hooks then run it:

- **`pre-commit`** — `gitleaks protect --staged`, scanning what you're about to
  commit.
- **`pre-push`** — `gitleaks detect` over the range you're about to push (the
  `--range` mode of `scripts/run-gitleaks.mjs`).

Each repo has a `.gitleaks.toml` that extends the default ruleset and allowlists
known non-secret noise — build output, lockfiles, and documented local
development placeholders (e.g. the backend's LocalStack `test`/`test` credentials
and Postgres `dev`/`dev` login). If a real secret ever takes the same shape as an
allowlisted placeholder, **change the secret's value — never widen the
allowlist.**

### Emergency bypass

`git commit --no-verify` skips the local hooks. This exists for genuine
emergencies only; the CI scan and GitHub push protection will still block a real
secret, so a bypass buys you nothing against an actual credential — it only skips
the early warning.

## If a secret is detected

1. **Treat it as compromised.** Anything pushed to a public repo must be assumed
   captured. **Rotate/revoke the credential first** — removing it from git does
   not un-expose it.
2. **Remove it from the codebase** and replace it with a reference to a secret
   store or environment variable.
3. **Purge it from history** if it was ever committed (e.g. `git filter-repo`),
   and force-update the affected branches.
4. **Record the remediation** against the NFR so the compliance trail is complete.

## Assessment history

- **2026-07-31 (BMD-811):** Full-history TruffleHog scan (`--only-verified`) run
  across all five repositories — **zero verified and zero unverified secrets** in
  any repo's history. The three defence layers were confirmed present on every
  repo; the harness CI scan gained its missing `merge_group` trigger, and local
  gitleaks hooks were added to `bng-metric-journey-tests` and `bng-library` to
  bring them to parity with the frontend/backend/harness.

### Re-running the history scan

To reproduce the assessment for any repo:

```sh
# from a full clone (all history)
trufflehog git file://"$(pwd)" --only-verified
```
