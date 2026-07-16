# bng-metric-harness

A meta-repo that orchestrates the two BNG Metric services so a developer can run them both with one command.

```
<workspace>/
├── bng-metric-harness/      ← this repo
├── bng-metric-frontend/     ← Hapi + Nunjucks + GOV.UK, port 3000
└── bng-metric-backend/      ← Hapi API, port 3001
```

This repo contains no application code — just scripts and Claude Code config. No git submodules, no npm workspaces, no shared lockfiles. The sibling repos remain fully independent.

## Requirements

- **Node.js ≥ 24** (matches both siblings' engines)
- **npm** (lockfiles in both siblings are npm)
- **git** (with SSH access to `github.com:DEFRA/*`)
- **Docker** (optional, but needed for supporting services — see below)

## Get started

```sh
# 1. Clone the harness
git clone git@github.com:DEFRA/bng-metric-harness.git
cd bng-metric-harness

# 2. Install harness deps
npm install

# 3. Clone the two sibling repos beside this one
npm run bootstrap

# 4. Install deps in all three repos
npm run install:all

# 5. Start supporting services (postgres, redis, localstack, defra-id-stub)
(cd ../bng-metric-backend && docker compose up -d)

# 6. Run both apps together
npm run dev
```

Frontend on <http://localhost:3000>, backend on <http://localhost:3001>.

If you have [Tilt](https://tilt.dev/) installed, you can replace steps 5–6 with `tilt up` — see the [Tilt](#tilt) section below.

## Running the apps

| Command              | What it does                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------- |
| `npm run dev`        | Both apps in parallel with prefixed output (`[fe]` cyan, `[be]` magenta). Any crash kills both.               |
| `npm run dev:fe`     | Frontend only                                                                                                 |
| `npm run dev:be`     | Backend only                                                                                                  |
| `npm run dev:b2c`    | Both apps, but the frontend runs against **real** Defra ID (B2C) instead of the stub (`OIDC_USE_STUB=false`). |
| `npm run dev:fe:b2c` | Frontend only, against real Defra ID (B2C).                                                                   |

### Stub vs. real Defra ID (B2C) login

`npm run dev` runs the frontend against the local **cdp-defra-id-stub** — its `dev`
script pins `OIDC_USE_STUB=true` (via `cross-env`, which overrides any value you
export), so setting `OIDC_USE_STUB=false` yourself has no effect on `npm run dev`.

Use the `:b2c` variants to test against **real** Defra ID locally. They run the
frontend with `OIDC_USE_STUB=false`, which makes it append the client id to the
OIDC scopes (so B2C returns an access token) **and** validate the id_token nonce.

The `:b2c` flag only affects the **frontend** — the backend has no stub switch. It
verifies the forwarded id_token from whatever its environment points at, so to
check real B2C tokens end to end, export the backend's OIDC vars before running
(otherwise it defaults to the stub's discovery URL and rejects B2C tokens):

```sh
export OIDC_DISCOVERY_URL=https://<tenant>.b2clogin.com/.../v2.0/.well-known/openid-configuration
export OIDC_AUDIENCE=<your B2C client id>   # enables audience checking
export OIDC_ISSUER=<expected issuer>        # optional issuer pin
npm run dev:b2c
```

The frontend's own OIDC vars (`OIDC_DISCOVERY_URL`, `OIDC_CLIENT_ID`,
`OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI`) are likewise read from the environment;
see the frontend's `.env.example`.

## Dependency management

| Command               | What it does                                     |
| --------------------- | ------------------------------------------------ |
| `npm run bootstrap`   | Clone any missing sibling repo from GitHub (SSH) |
| `npm run install:all` | `npm install` in harness + both siblings         |
| `npm run install:fe`  | `npm install` in frontend only                   |
| `npm run install:be`  | `npm install` in backend only                    |

## Git operations across repos

| Command          | What it does                                                           |
| ---------------- | ---------------------------------------------------------------------- |
| `npm run status` | `git status --short` in harness + both siblings, with per-repo headers |
| `npm run pull`   | `git pull --ff-only` in all three — warns (never errors) on ff failure |
| `npm run branch` | Current branch of each repo, side-by-side                              |

## Dependabot merge-queue sweep

GitHub ignores merge-queue auto-merge that was armed by a workflow's
`GITHUB_TOKEN` (recursive-trigger protection), so the per-repo Dependabot
auto-merge workflows approve and arm PRs that then never reach the queue.
Until a PAT / GitHub App identity is provisioned, a developer runs the sweep
once a day — it enqueues as *you*, which is what makes it work:

```sh
npm run queue-deps                  # sweep all six BNG repos (incl. this one)
npm run queue-deps -- backend       # one repo (name substring)
npm run queue-deps -- --dry-run     # preview without enqueueing
```

It only enqueues Dependabot PRs the repo's own workflow already vetted —
auto-merge armed (patch/minor policy passed), approved, and all checks green.
Majors and anything red are skipped with the reason printed. Safe to re-run:
already-queued PRs are skipped.

## Proxy commands

Run an arbitrary npm script in one of the siblings without `cd`-ing:

```sh
npm run fe -- test          # runs `npm run test` in bng-metric-frontend
npm run fe -- lint
npm run be -- test:watch
npm run be -- db:migrate
```

## Quality

| Command           | What it does                                 |
| ----------------- | -------------------------------------------- |
| `npm run lint`    | Lint both repos (sequential, summary at end) |
| `npm run test`    | Test both repos (sequential, summary at end) |
| `npm run test:fe` | Test frontend only                           |
| `npm run test:be` | Test backend only                            |

## Test Data Generation
This repo contains a script to generate example GeoPackage files for testing. See [docs/generate-test-data.md](docs/generate-test-data.md) for details.

## Tilt

[Tilt](https://tilt.dev/) is a local development orchestrator. Instead of manually running `docker compose up` and `npm run dev` separately, Tilt starts the full stack — Docker services **and** both Node apps — in one command, with dependency ordering (apps wait for their backing services to be healthy) and a web dashboard for logs and restarts.

```sh
tilt up        # starts everything, opens dashboard at http://localhost:10350
tilt down      # tears it all down
```

In VS Code, you can also use the **Run and Debug** panel (green play button) to launch "Tilt Up", which streams all logs into the integrated terminal.

The `Tiltfile` in this repo references the backend's `compose.yml` for infrastructure and runs `npm run dev` in each sibling. It can be customised to change how services are started or to add additional commands as needed.

If you prefer not to install Tilt, the manual approach below works identically.

## Supporting services (Docker Compose)

The apps themselves run in Node, but the backend talks to a handful of infrastructure services. Only the **backend** repo ships a `compose.yml` — the harness does not duplicate it, and the frontend does not need its own stack.

Backend (`../bng-metric-backend/compose.yml`):

- PostgreSQL (postgis) on `5432`
- Redis on `6379`
- LocalStack on `4566`
- CDP Defra ID stub on `3200`

Start the stack from the backend repo:

```sh
(cd ../bng-metric-backend && docker compose up -d)

# Later
(cd ../bng-metric-backend && docker compose down)
```

Once services are up, `npm run dev` in the harness starts the two Node apps against them.

## Claude Code

The harness ships shared slash commands under `.claude/commands/`:

- `/dev` — `npm run dev`
- `/status` — git status + current branch across all repos
- `/sync` — `git pull --ff-only` + `npm install` across all repos
- `/check` — `npm run lint` + `npm run test` across both siblings

`.claude/settings.json` defines a narrow tool allowlist for a Node.js / DEFRA project — explicit rather than permissive. Destructive git operations are denied by default.

The sibling repos own their own `.claude/` configuration; the harness does not reach into them.

### `@`-mention file picker and the sibling symlinks

The `frontend` and `backend` symlinks at the harness root let you `Read`/`Edit` sibling files from a session started here, and `permissions.additionalDirectories` in `.claude/settings.json` authorises tool access to the real paths. **However, the `@`-mention picker does not follow symlinks** — it indexes only the real file tree under the launch directory, and `additionalDirectories` grants access but does not extend discovery.

To make sibling files appear in the `@` picker, launch Claude Code with `--add-dir`:

```sh
claude --add-dir ../bng-metric-frontend --add-dir ../bng-metric-backend
```

The symlinks remain useful for typing paths and for tool calls; `--add-dir` is what makes the picker see across repos. See the [Claude Code permissions docs](https://code.claude.com/docs/en/permissions#additional-directories-grant-file-access-not-configuration) for details.

## Security: Secret scanning

All three repos (harness + both siblings) scan for secrets at three independent layers. A real credential has to slip past all three to reach `main`:

| Layer        | When           | What runs                                                  |
| ------------ | -------------- | ---------------------------------------------------------- |
| pre-commit   | `git commit`   | `gitleaks protect --staged` on the staged diff (< 200ms)   |
| pre-push     | `git push`     | `gitleaks detect` on `@{u}..HEAD` (catches `--no-verify`)  |
| CI (PR-gate) | every PR       | `trufflehog --only-verified`                               |

> `gitleaks` only runs locally (pre-commit and pre-push). It is intentionally **not** part of the CI workflow — `gitleaks-action` is published under a license that prohibits use by for-profit organisations without a commercial subscription, so CI relies on `trufflehog --only-verified` as the gate-of-record. The local hooks remain the first line of defence; `trufflehog` is the backstop on every PR.

### Setup

`npm install` installs everything:

1. `husky` is configured via `postinstall`.
2. `scripts/install-gitleaks.mjs` downloads a pinned gitleaks binary into `node_modules/.gitleaks/bin/`, verifies its SHA-256, and reuses any system `gitleaks` already on `PATH`.

No manual `brew install` needed. Repeat in each sibling — `npm run install:all` covers all three.

If the download fails (firewall/offline), the hook falls back to a system `gitleaks` on `PATH`. Manual install:

```sh
brew install gitleaks            # macOS
sudo apt install gitleaks        # Debian/Ubuntu
choco install gitleaks           # Windows
```

### Bypass (emergency only)

```sh
SKIP_GITLEAKS_INSTALL=1 npm install   # skip binary download
git commit --no-verify                # skip local pre-commit
git push --no-verify                  # skip local pre-push
```

CI still runs the same scans on the PR and **will block the merge**. Don't rely on `--no-verify` to land a real secret.

### Allowlisting a false positive

Edit `.gitleaks.toml` in the repo that flagged — add a `regexes` or `paths` entry — and open a PR. Reviewers must approve the widening. See per-repo `.gitleaks.toml` for current entries.

### If a secret reaches `main`

1. **Rotate the credential immediately** — assume compromised.
2. `git filter-repo` to scrub history.
3. Force-push and notify clones to re-clone.
4. Add a regression regex to `.gitleaks.toml` so the exact pattern is blocked next time.
5. Enable GitHub Push Protection (Settings → Code security and analysis) if not already on.

## Troubleshooting

- **`Sibling "X" not found`** — run `npm run bootstrap`.
- **`git pull --ff-only` refuses** — you have local commits or a diverged branch. Resolve manually in the affected repo; the harness will keep going.
- **`npm run dev` exits immediately** — one of the apps crashed on startup. Check both logs; `--kill-others-on-fail` is intentional. Run `npm run dev:fe` or `npm run dev:be` alone to isolate.
- **Port conflicts** — 3000/3001 (apps), 5432/6379/4566/3200 (backend services) must all be free.
