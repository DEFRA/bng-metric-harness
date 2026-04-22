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

| Command          | What it does                                                                                    |
| ---------------- | ----------------------------------------------------------------------------------------------- |
| `npm run dev`    | Both apps in parallel with prefixed output (`[fe]` cyan, `[be]` magenta). Any crash kills both. |
| `npm run dev:fe` | Frontend only                                                                                   |
| `npm run dev:be` | Backend only                                                                                    |

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

## Troubleshooting

- **`Sibling "X" not found`** — run `npm run bootstrap`.
- **`git pull --ff-only` refuses** — you have local commits or a diverged branch. Resolve manually in the affected repo; the harness will keep going.
- **`npm run dev` exits immediately** — one of the apps crashed on startup. Check both logs; `--kill-others-on-fail` is intentional. Run `npm run dev:fe` or `npm run dev:be` alone to isolate.
- **Port conflicts** — 3000/3001 (apps), 5432/6379/4566/3200 (backend services) must all be free.
