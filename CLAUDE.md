# bng-metric-harness

This repo is a **meta-repo / harness** that orchestrates two sibling repos checked out beside it:

```
<workspace>/
├── bng-metric-harness/             ← you are here
│   ├── frontend       →  ../bng-metric-frontend         (symlink)
│   ├── backend        →  ../bng-metric-backend          (symlink)
│   └── journey-tests  →  ../bng-metric-journey-tests    (symlink)
├── bng-metric-frontend/            ← Hapi + Nunjucks + GOV.UK, port 3000
├── bng-metric-backend/             ← Hapi API, port 3001
└── bng-metric-journey-tests/       ← Playwright suite, triggered from Tilt
```

The harness owns no application code. Its only job is to give a developer a single place to run `npm install`, `npm run dev`, `npm run test`, `npm run status`, etc. across the pair.

## Sibling access from inside the harness

Symlinks live in the harness root so the siblings are reachable from a Claude Code session started here:

- `./frontend` → `../bng-metric-frontend`
- `./backend` → `../bng-metric-backend`
- `./journey-tests` → `../bng-metric-journey-tests`

Read and edit sibling files through those symlinks — e.g. `frontend/src/server/index.js`, `backend/src/api/routes.js`, `journey-tests/test/...`. The `.claude/settings.json` also lists each sibling under `permissions.additionalDirectories`, so tool permissions resolve correctly against the real paths (symlinks alone wouldn't be enough because the trust boundary checks canonical paths).

The orchestration scripts (`scripts/*.mjs`) resolve sibling paths by name (`bng-metric-frontend`, `bng-metric-backend`), not through the symlinks — so the symlinks are purely for interactive access, not for the build/dev pipeline.

## Running the apps

This project pins Node to **24** (see `.nvmrc` and `package.json` `engines`). Run `nvm use` (or your equivalent) before invoking any script — using a different Node version will break the better-sqlite3 native binary.

Everything here is pure npm + Node — no submodules, no workspaces, no shared lockfiles.

| Command                             | What it does                                                                                         |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `npm run bootstrap`                 | Clones any missing sibling repo from its GitHub remote                                               |
| `npm run install:all`               | `npm install` in harness + both siblings                                                             |
| `npm run install:fe` / `install:be` | `npm install` in one sibling                                                                         |
| `npm run dev`                       | Starts both apps in parallel via `concurrently` (`[fe]` cyan, `[be]` magenta) — any crash kills both |
| `npm run dev:fe` / `dev:be`         | Starts a single app                                                                                  |
| `npm run status`                    | `git status --short` in all three repos, with headers                                                |
| `npm run pull`                      | `git pull --ff-only` in all three; warns (never errors) on ff failure                                |
| `npm run branch`                    | Current branch of each repo, side-by-side                                                            |
| `npm run fe -- <script>`            | Runs an arbitrary npm script in frontend (e.g. `npm run fe -- test`)                                 |
| `npm run be -- <script>`            | Same for backend                                                                                     |
| `npm run lint`                      | Runs lint in both repos (sequential)                                                                 |
| `npm run test`                      | Runs tests in both repos (sequential)                                                                |
| `npm run test:fe` / `test:be`       | Individual test run                                                                                  |

### Supporting services (Docker Compose)

Only the **backend** repo carries a `compose.yml` — it bundles the infrastructure both apps rely on (PostgreSQL, Redis, LocalStack, CDP Defra ID stub). The frontend runs purely in Node against those services; it does not have its own compose file. The harness does **not** duplicate the backend's compose:

```sh
(cd ../bng-metric-backend && docker compose up -d)
```

Then `npm run dev` in this harness starts the two Node apps against those services.

## Structure

- `scripts/*.mjs` — ESM Node scripts, dependency-light (`node:child_process`, `node:fs`, `node:path`). One per command, plus `_lib.mjs` with shared helpers.
- `.claude/` — shared Claude Code config for the harness:
  - `settings.json` — tool allowlist
  - `commands/` — workspace-wide slash commands (`/dev`, `/status`, `/sync`, `/check`)

## Code style / conventions

- All scripts are ESM `.mjs`.
- Resolve sibling paths with `path.resolve(import.meta.dirname, '..', '..', repoName)` — never `process.cwd()`.
- Spawn child processes with `{ stdio: 'inherit', cwd: targetDir }` so output streams naturally.
- Windows compat: use `process.platform === 'win32' ? 'npm.cmd' : 'npm'`, and prefer the `concurrently` JS API over `node_modules/.bin/*` shims.
- Propagate exit codes. Use `process.exit(1)` for expected-failure paths, not thrown errors.
- If a sibling repo is missing, print a message pointing the user at `npm run bootstrap` and exit 1.
- Log what the script is doing as it does it.
- Code is scanned by SonarCloud (project key in `sonar-project.properties`). After pushing, run `/check-sonar-pr` to see PR-scoped issues. First-draft rules most likely to be flagged: brace every single-line `if` body (S121), extract magic numbers to constants (S109), keep nesting ≤ 3 levels (S134), prefer `replaceAll` and template literals over `replace`/concat.

## Not in scope for this repo

- ❌ Docker/compose files (siblings own theirs)
- ❌ Shared source code, types, or application logic
- ❌ CI/CD for the sibling apps (each sibling owns its own pipeline; the harness's only workflow is `pages.yml`, which builds the docs site)
- ❌ git hooks / husky that reach into siblings
- ❌ npm workspaces, submodules, subtrees
- ❌ `CLAUDE.md` files in the sibling repos — they are responsible for their own
