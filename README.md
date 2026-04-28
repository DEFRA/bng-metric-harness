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

## Test data generation

The harness ships a script for producing realistic BNG GeoPackages — `.gpkg` files matching the Natural England statutory metric template — for testing uploads against the prototype and the production frontend.

```sh
node scripts/gen-gpkg.mjs                # synthetic, ~50 habitats, default site
node scripts/gen-gpkg.mjs --size 100     # bigger fixture
node scripts/gen-gpkg.mjs --count 10     # ten different files in one run
```

Output goes to `test-data/` by default; override with `--outdir <dir>`. All files include the five layers the prototype expects (Red Line Boundary, Habitats, Hedgerows, Rivers, Urban Trees) and are pre-validated against the prototype's `(habitat, condition)` lookup table so they upload cleanly.

### Generating from a real BNG metric workbook

Another way to generate the geopackage is to feed in a real **Defra Statutory Biodiversity Metric** workbook file (`.xlsx` / `.xlsm`) — for example one of the FOI submissions in the public [`abitatdotdev/bng-metrics`](https://github.com/abitatdotdev/bng-metrics) corpus.

The script reads the workbook's habitat / hedgerow / watercourse / tree data and synthesises matching geometry.

**From a local file:**

```sh
node scripts/gen-gpkg.mjs --from path/to/MyMetric.xlsx
# → test-data/MyMetric.gpkg
```

**From a GitHub URL** (auto-handles Git LFS — the BNG500 corpus uses LFS):

```sh
node scripts/gen-gpkg.mjs --from "https://github.com/abitatdotdev/bng-metrics/blob/main/metrics/CAMBRIDGE_24_02948_FUL.xlsx"
# → test-data/CAMBRIDGE_24_02948_FUL.gpkg
```

The blob URL is rewritten to the LFS-aware media URL automatically. Downloaded workbooks are cached in `.cache/bng500/` (gitignored) so re-runs are instant and offline-friendly.

**In bulk** — process many workbooks by listing them in a file (one path or URL per line, `#` comments allowed):

```sh
cat > /tmp/wbs.txt <<'EOF'
# A few from the BNG500 corpus
https://github.com/abitatdotdev/bng-metrics/blob/main/metrics/CAMBRIDGE_24_02948_FUL.xlsx
https://github.com/abitatdotdev/bng-metrics/blob/main/metrics/AshfieldV20240166.xlsm
# A local one
./scripts/data/sample-workbooks/BCP_APP_24_00318_F.xlsx
EOF

node scripts/gen-gpkg.mjs --from-list /tmp/wbs.txt
```

Each workbook produces one `.gpkg` named after the input file. Failures on individual entries are logged but don't stop the batch.

**Just inspect a workbook** without writing anything:

```sh
node scripts/gen-gpkg.mjs --from path/to/MyMetric.xlsx --inspect
```

Prints a JSON summary of the parsed site info, layer row counts, and any rows the parser had to skip. Useful for debugging an unfamiliar workbook before generating from it.

### What the workbook drives, and what it doesn't

The Excel data sets:

- **Counts** — number of habitat parcels (baseline + created), hedgerows, rivers, trees.
- **Per-feature attributes** — habitat broad/type, condition, distinctiveness, strategic significance, retention category (Retained / Enhanced / Created), and lengths/areas.
- **Total site area** — drives the size of the synthesised Red Line Boundary.

The Excel does **not** contain coordinates or geometry, so:

- The RLB centre defaults to Maidenhead (`530000, 180000`) — pass `--centre <e,n>` to position the fixture wherever you want (in BNG eastings/northings):

  ```sh
  node scripts/gen-gpkg.mjs --from path/to/MyMetric.xlsx --centre 545000,258000   # central Cambridge
  node scripts/gen-gpkg.mjs --from path/to/MyMetric.xlsx --centre 393000,93000    # central Bournemouth
  ```

- The RLB outline, parcel partition, hedgerow/river routes, and tree positions are randomised — the same workbook gives a different geometry layout each run, with identical attribute content. Run with `--count` to produce multiple variants.

### Realistic invalid scenarios

By default, the generator emits the workbook's data as-is — including any real-world inconsistencies (null condition values, deprecated habitat names, mismatched broad/type pairs). This is deliberately useful for testing the prototype's error handling against the kinds of data ecologists actually submit.

If you want only validator-clean rows, pass `--strict-habitats`:

```sh
node scripts/gen-gpkg.mjs --from <workbook> --strict-habitats
```

This drops any `(habitat, condition)` pair the prototype's metric tables would reject (e.g. `Cropland — Non-cereal crops` with condition `Fairly Good`, which the metric scores as `Not Possible`).

### Intentionally invalid output (`--bad`)

To produce a structurally invalid GeoPackage for testing upload validation (currently: omits the Red Line Boundary layer):

```sh
node scripts/gen-gpkg.mjs --bad
# → test-data/bng-test-data-bad.gpkg
```

Combines with `--count` for multiple bad files at once.

### Full option reference

| Option              | Default            | Notes                                                              |
| ------------------- | ------------------ | ------------------------------------------------------------------ |
| `--size <n>`        | 50                 | Synthetic mode only — habitat parcel count; scales other layers    |
| `--count <n>`       | 1                  | Generate n files in one run; each has different randomised layout  |
| `--outdir <dir>`    | `test-data/`       | Output directory                                                   |
| `--centre <e,n>`    | 530000,180000      | RLB centre in BNG eastings/northings; must be inside England       |
| `--from <ref>`      | —                  | Local path or HTTPS URL of a Defra metric workbook                 |
| `--from-list <f>`   | —                  | Newline-delimited list of paths/URLs (one per line, `#` comments)  |
| `--inspect`         | off                | With `--from`, print parsed workbook summary instead of generating |
| `--strict-habitats` | off                | Drop workbook rows the prototype's validator would reject          |
| `--bad`             | off                | Emit an intentionally invalid GeoPackage                           |

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


# Test line depends on feature