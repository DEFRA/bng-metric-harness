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
- **Docker** (needed for supporting services)

## Local development (Dev Container)

This repository includes a [Dev Container](https://containers.dev/) under `.devcontainer/` for a consistent environment (Node 24, Tilt, MkDocs Material, LikeC4).

**Requirements:**

- [Docker](https://www.docker.com/) running on the **host** (the container uses your host engine via the Docker socket)
- Microsoft [Dev Containers](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers) (`ms-vscode-remote.remote-containers`)
- Sibling repos cloned **beside** this one on the host (see layout below) — the container bind-mounts each repo into `/workspaces/`

**Use VS Code for dev containers.** Cursor does not support the official Microsoft extension—it installs Anysphere’s fork (`anysphere.remote-containers`) instead, even if you request the Microsoft ID.

Install the Microsoft extension (from the repo root):

```bash
bash .devcontainer/install-host-extension.sh
```

Or in VS Code: **Extensions** → search **Dev Containers** → install the one published by **Microsoft**.

**Host layout** (your `~/code/defra` directory is the intended setup):

```
~/code/defra/
├── bng-metric-harness/    ← open this folder in VS Code
├── bng-metric-frontend/
└── bng-metric-backend/
```

**Before reopening in container** (on the host, with SSH to `github.com:DEFRA/*`):

```bash
cd ~/code/defra/bng-metric-harness
npm run bootstrap      # clone siblings if missing
npm run install:all    # npm install in harness + siblings
```

1. Open this repository in **VS Code** (not Cursor).
2. Run **Dev Containers: Reopen in Container** from the Command Palette (`Ctrl+Shift+P`).
3. Wait for the container to build (installs `npm ci`, MkDocs Material, Tilt, Graphviz, Java 17, and `ripgrep`).
4. If siblings and Docker are available, the **Tilt: up** task starts on folder open — frontend **http://localhost:3000**, backend **http://localhost:3001**, dashboard **http://localhost:10350**. If prerequisites are missing, the task prints a short skip message instead of failing.
5. In a second terminal, run **`npm run docs:serve`** for the aggregated docs site at **http://localhost:8000/bng-metric-harness/** (live reload). Or use **Terminal → Run Task → MkDocs: serve**.

The devcontainer also adds `host.docker.internal` via:

```json
"runArgs": ["--add-host=host.docker.internal:host-gateway"]
```

This avoids local Docker networking issues when services inside the container need to reach host-bound ports.

**Run commands** (use separate terminals):

```bash
tilt up              # Docker services + frontend + backend
npm run docs:serve   # Aggregate docs + serve MkDocs (live reload)
```

Or via tasks: **Terminal → Run Task → Tilt: up** or **MkDocs: serve**.

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

# 5. Start the full stack with Tilt
tilt up

# 6. In another terminal — aggregated docs site (live reload)
npm run docs:serve
```

Frontend on <http://localhost:3000>, backend on <http://localhost:3001>, docs on <http://localhost:8000/bng-metric-harness/>.

## Running the apps

| Command              | What it does                                                                                    |
| -------------------- | ----------------------------------------------------------------------------------------------- |
| `tilt up`            | Full stack: Docker services + frontend + backend (see [Tilt](#tilt))                            |
| `npm run docs:serve` | Aggregate docs from all three repos and serve MkDocs with live reload                           |
| `npm run dev`        | Both apps in parallel with prefixed output (`[fe]` cyan, `[be]` magenta). Any crash kills both. |
| `npm run dev:fe`     | Frontend only                                                                                   |
| `npm run dev:be`     | Backend only                                                                                    |

## Documentation

The harness aggregates markdown from all three repos into a single MkDocs site. See [docs/documentation-site.md](docs/documentation-site.md) for how publishing works.

| Command                  | What it does                                                                 |
| ------------------------ | ---------------------------------------------------------------------------- |
| `npm run docs:serve`     | Aggregate + build LikeC4 + serve at <http://localhost:8000/bng-metric-harness/> |
| `npm run docs:build`     | Same as above but static output in `_site/`                                  |
| `npm run docs:aggregate` | Copy markdown from sibling repos and emit `mkdocs.generated.yml`             |
| `npm run docs:likec4`    | Build the LikeC4 architecture SPA into `site_src/docs/architecture/app/`     |

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
tilt up              # starts everything, opens dashboard at http://localhost:10350
tilt down            # tears it all down
npm run docs:serve   # docs site (separate terminal) at http://localhost:8000/bng-metric-harness/
```

In VS Code, you can also use the **Run and Debug** panel (green play button) to launch "Tilt Up", which streams all logs into the integrated terminal.

The `Tiltfile` in this repo references the backend's `compose.yml` for infrastructure and runs `npm run dev` in each sibling. It can be customised to change how services are started or to add additional commands as needed.

## Supporting services (Docker Compose)

Tilt orchestrates backend `docker compose` services for you. Only the **backend** repo ships a `compose.yml` — the harness does not duplicate it, and the frontend does not need its own stack.

Backend (`../bng-metric-backend/compose.yml`):

- PostgreSQL (postgis) on `5432`
- Redis on `6379`
- LocalStack on `4566`
- CDP Defra ID stub on `3200`

Tilt handles starting/stopping this stack alongside frontend/backend app processes.

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
- **Port conflicts** — 3000/3001 (apps), 5432/6379/4566/3200 (backend services), 8000 (MkDocs) must all be free.
- **`npm run docs:serve` fails with `not found: dot`** — Graphviz is required for LikeC4 diagram export. The devcontainer installs it automatically; on a bare host run `sudo apt install graphviz` (or equivalent).
- **`db-migrate` fails in Tilt with little/no output** — `scripts/liquibase.sh` now runs a local Liquibase CLI (Java required) to avoid bind-mount issues in some Docker/devcontainer setups.
