## Test data generation

The harness ships a script for producing realistic BNG GeoPackages — `.gpkg` files matching the Natural England statutory metric template — for testing uploads against the prototype and the production frontend.

On a fresh clone, install dependencies first:

```sh
nvm use         # picks up the appropriate NodeJS version from the .nvmrc file
npm install     # installs dependencies required by the script.
```

Then:

```sh
npm run generate:gpkg                       # synthetic, ~50 habitats, default site
npm run generate:gpkg -- --size 100         # bigger fixture
npm run generate:gpkg -- --count 10         # ten different files in one run
```

Output goes to `test-data/` by default; override with `--outdir <dir>`. All files include the five layers the prototype expects (Red Line Boundary, Habitats, Hedgerows, Rivers, Urban Trees) and are pre-validated against the prototype's `(habitat, condition)` lookup table so they upload cleanly.

### Running in Docker

For convenience and to avoid having to set up the NodeJS environment on your host machine the same script can be run inside a docker container as shown below. Note this approach requires Docker (Desktop or Engine).

```sh
npm run generate:gpkg:docker                       # synthetic, default site
npm run generate:gpkg:docker -- --size 100         # bigger fixture
npm run generate:gpkg:docker -- --count 10 --bad   # ten invalid files
```

The script builds the image on first run (cached after that) and writes output to `./test-data/` on the host, same as the non-Docker path. Two host folders are bind-mounted into the container:

- `./test-data/` — output (read/write)
- `./workbooks/` — input for `--from` / `--from-list` modes (read-only)

To run in workbook-driven mode, drop the `.xlsx` / `.xlsm` into `./workbooks/` and reference its container path:

```sh
cp ~/Downloads/MyMetric.xlsx workbooks/
npm run generate:gpkg:docker -- --from /app/workbooks/MyMetric.xlsx
# → test-data/MyMetric-baseline-<YYYYMMDD-HHMM-SS>.gpkg
# → test-data/MyMetric-post-intervention-<YYYYMMDD-HHMM-SS>.gpkg
```

**Known limits of the Docker approach.**

- **`--outdir` is ignored.** Only the default `test-data/` directory is bind-mounted into the container, so passing a different `--outdir` writes the file inside the container and it's lost when the container exits.
- **Workbook downloads aren't cached.** When using `--from <url>`, the workbook is re-downloaded on every run because the `.cache/` directory isn't bind-mounted. Repeated runs over the same URL will be slow.

### Generating from a real BNG metric workbook

Another way to generate the geopackage is to feed in a real **Defra Statutory Biodiversity Metric** workbook file (`.xlsx` / `.xlsm`) — for example one of the FOI submissions in the public [`abitatdotdev/bng-metrics`](https://github.com/abitatdotdev/bng-metrics) corpus.

The script reads the workbook's habitat / hedgerow / watercourse / tree data and synthesises matching geometry.

**From a local file:**

```sh
npm run generate:gpkg -- --from path/to/MyMetric.xlsx
# → test-data/MyMetric-baseline-<YYYYMMDD-HHMM-SS>.gpkg
# → test-data/MyMetric-post-intervention-<YYYYMMDD-HHMM-SS>.gpkg
```

**From a GitHub URL** (auto-handles Git LFS — the BNG500 corpus uses LFS):

```sh
npm run generate:gpkg -- --from "https://github.com/abitatdotdev/bng-metrics/blob/main/metrics/CAMBRIDGE_24_02948_FUL.xlsx"
# → test-data/CAMBRIDGE_24_02948_FUL-baseline-<YYYYMMDD-HHMM-SS>.gpkg
# → test-data/CAMBRIDGE_24_02948_FUL-post-intervention-<YYYYMMDD-HHMM-SS>.gpkg
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

npm run generate:gpkg -- --from-list /tmp/wbs.txt
```

Each workbook produces a baseline / post-intervention pair (see below) named after the input file. Failures on individual entries are logged but don't stop the batch.

### Baseline and post-intervention pair

Each workbook run emits two GeoPackages by default, modelling the two-stage BNG service workflow:

- **`<name>-baseline-<timestamp>.gpkg`** — pre-development state. Habitats / hedgerows / rivers / trees use the A-1 / B-1 / C-1 sheets only; no proposed columns.
- **`<name>-post-intervention-<timestamp>.gpkg`** — proposed end-state. Retained / Enhanced / Created rows are derived from the A-1 / B-1 / C-1 per-fate columns together with the A-2 / A-3 / B-2 / B-3 / C-2 / C-3 sheets.

The two files share an identical Red Line Boundary, so they can be uploaded sequentially against the same site. Use `--mode` to emit only one half of the pair:

```sh
npm run generate:gpkg -- --from path/to/MyMetric.xlsx --mode baseline
npm run generate:gpkg -- --from path/to/MyMetric.xlsx --mode post-intervention
```

**Just inspect a workbook** without writing anything:

```sh
npm run generate:gpkg -- --from path/to/MyMetric.xlsx --inspect
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
  npm run generate:gpkg -- --from path/to/MyMetric.xlsx --centre 545000,258000   # central Cambridge
  npm run generate:gpkg -- --from path/to/MyMetric.xlsx --centre 393000,93000    # central Bournemouth
  ```

- The RLB outline, parcel partition, hedgerow/river routes, and tree positions are randomised — the same workbook gives a different geometry layout each run, with identical attribute content. Run with `--count` to produce multiple variants.

### Realistic invalid scenarios

By default, the generator emits the workbook's data as-is — including any real-world inconsistencies (null condition values, deprecated habitat names, mismatched broad/type pairs). This is deliberately useful for testing the prototype's error handling against the kinds of data ecologists actually submit.

If you want only validator-clean rows, pass `--strict-habitats`:

```sh
npm run generate:gpkg -- --from <workbook> --strict-habitats
```

This drops any `(habitat, condition)` pair the prototype's metric tables would reject (e.g. `Cropland — Non-cereal crops` with condition `Fairly Good`, which the metric scores as `Not Possible`).

### Intentionally invalid output (`--bad`)

To produce a structurally invalid GeoPackage for testing upload validation (currently: omits the Red Line Boundary layer):

```sh
npm run generate:gpkg -- --bad
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
| `--mode <m>`        | `both`             | Workbook mode: `baseline`, `post-intervention`, or `both`          |
| `--bad`             | off                | Emit an intentionally invalid GeoPackage                           |
