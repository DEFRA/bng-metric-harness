# Implementing in-process geometry validation (GEOS-WASM + worker threads)

Plan for moving baseline and post-intervention GeoPackage geometry validation out of
PostGIS and into the backend process, using GEOS compiled to WebAssembly running in worker
threads.

**Status: built, on `bmd-geos-wasm-validation` in `bng-metric-backend`.** PRs 1, 2, 3 and 5
are implemented and merged into one branch; PR 4 is a per-environment configuration change
and PR 6 is a decision. The spike behind it is in `geos-wasm-spike/` with results in
`evidence/geos-wasm-spike.txt`. Companion documents: `report.md` (the measurements),
`implementation-guide.md` (the SQL-side improvements, which remain valid whichever engine
wins).

## The fallback was removed, and PostGIS validation with it

After the plan's PRs landed, the decision was taken to make this a clean switch
rather than a hedged one: `VALIDATION_ENGINE`, shadow mode, the PostGIS statement
and every fallback path are gone. Validation runs only on the workers.

That contradicts PR 6's recommendation to **retain** the SQL path, so the
reasoning is worth recording. A fallback means the same file can get a different
answer depending on how busy the instance is; and a queue-full fallback pushes
load back onto the database at exactly the moment capacity is tight, which is the
problem the whole exercise set out to remove. A saturated pool now answers **503
`VALIDATION_BUSY`** with a `Retry-After`, and the frontend tells the user to try
again — the file was never looked at, so it is not a validation failure.

Two consequences the plan did not anticipate:

- **The shadow soak is no longer possible.** PRs 3 and 4 assumed a two-to-four
  week comparison against the SQL engine on real traffic. There is nothing left
  to compare against, so that evidence has to come from the recorded corpus
  instead (below) rather than from production.
- **The oracle had to be captured before it was deleted.**
  `integration-tests/fixtures/postgis-geometry-verdicts.json` records what the
  PostGIS engine said about all 98 readable GeoPackages in `example-files/`, and
  the GEOS engine is asserted against it on every run. The rule-by-rule spec that
  was written for the SQL engine was likewise retargeted rather than rewritten.

Open question 3 below is therefore closed: the SQL improvements in
`implementation-guide.md` are now **wasted effort**, because the path they would
optimise no longer exists.

## What landed

`src/validation/geopackage/geos/` with the fifteen checks, full payload parity, a fixed
worker pool, shadow mode and sizing off the back of validation. `VALIDATION_ENGINE`
(`postgis` | `geos` | `shadow`) defaults to `postgis`, so nothing changes in production
until it is set. The developer-facing write-up is
`bng-metric-backend/docs/geometry-validation-engines.md`.

Three things came out different from the plan, all deliberate:

| | Plan | Built | Why |
| --- | --- | --- | --- |
| Tolerances | `postgis/index.js` unchanged | tolerances moved to a shared `geometry-constants.js` that both engines read | Two copies of a threshold agree until someone tunes one. This is what makes the parity claim structural rather than a promise. |
| Parity harness | parameterise `postgis-validate-baseline-layers.test.js` over both engines | a separate `validation-engine-parity.test.js` | That file cannot be wholly parameterised — its last block asserts EXPLAIN plans and temp-table lifetimes, which have no counterpart in an engine with no database. The new suite covers two dozen hand-built scenarios **plus every GeoPackage in `example-files/`**, which is broader than the original file and needed no 900-line whitespace diff. |
| England polygon | generated at build time via PostGIS | generated once via PostGIS and **committed**, with a proj4-based CI check | Committing PostGIS's own output makes the containment check bit-comparable rather than merely close; the CI check catches drift without needing a database. |

## Results against the plan's own risk table

| | Risk | Plan's status | Now |
| --- | --- | --- | --- |
| R1 | WASM slower than native | Retired | Confirmed. 20–50× faster than the SQL on the real `example-files/` submissions, where the round trip dominates. |
| R2 | EPSG:4326 reprojection diverges | Largely retired | Reproduced independently: re-deriving `england-27700.json` with proj4 agrees with the PostGIS-generated file to **7.49e-4 m**, matching the spike's measurement exactly. The pinned definition is asserted in a unit test. **The production OSTN15 question is still open** — see below. |
| R3 | Numerical divergence | Partly retired | 124/124 comparisons identical across the hand-built scenarios and all 100 example GeoPackages, payloads and messages included. One cosmetic ring-rotation difference in WKT text, classified separately. Shadow mode is what finishes this off on real traffic. |
| R4 | GEOS version skew | Open | WASM pinned at `geos-wasm@3.1.1` (GEOS 3.13.0-CAPI-1.19.0), and the version is reported on every divergence line so a disagreement can be tied to a build. Still needs the production PostGIS version establishing. |
| R5 | Blocks the event loop | Retired | Worker threads are mandatory in the implementation; there is no inline production path. |
| R6 | Memory leak | Retired | Unchanged. |
| R7 | Memory per worker | Open — likely blocker | **Still open, and still the first thing to check.** Default worker count is 2 and it is documented as a memory budget. Needs measuring on a real ECS task. |
| R8 | WASM binary unavailable at runtime | Needs verification | **Retired.** `geos-wasm` ships no `.wasm` file at all — the module is base64-embedded in a single 2.5 MB JS bundle — and neither it nor `proj4` runs an install script. Both install and run under `ignore-scripts`, which is how this repo already installs. |

## Still open, and still needing an answer from outside the code

1. **What is the ECS task memory limit for the backend?** Two workers at a few hundred MB
   each is the most likely blocker (R7).
2. **Does production PostGIS have the OSTN15 grid installed?** If it does, it was
   more accurate than the JS path and 4326 verdicts may shift by up to ~2 m; the
   fix would be to supply proj4js with the same grid. Still worth settling, but it
   no longer blocks anything — there is no second engine left to disagree with.
3. ~~**Do we want the SQL improvements in `implementation-guide.md` as well?**~~
   **Closed — no.** The PostGIS validation path has been deleted, so there is
   nothing left for those improvements to improve.

---

## Why

Measured on a 5,000-parcel baseline file, native execution:

| | Current (PostGIS) | GEOS-WASM in Node |
| --- | ---: | ---: |
| Validation time | 1,129 ms | **575 ms** |
| Database connections held | 1, for the full ~1.1 s | **0** |
| Verdicts across 13 fixtures | — | **identical, codes and counts** |

And the reason it matters operationally — a light project-list probe running while
validations are in flight:

| | Requests served in 12 s | Connection acquire p50 |
| --- | ---: | ---: |
| Idle | 60,574 | 0 ms |
| 12 concurrent validations, PostGIS | **5** | 1,091 ms |
| 2 workers validating continuously, GEOS-WASM | **71,651** | 0 ms |

Validation stops competing with logins and page loads for a scarce, shared, hard-to-scale
resource, and starts scaling with the backend instances CDP can already add. The SQL-side
improvements in `implementation-guide.md` raise capacity ~2–3×; this removes the constraint
instead of raising it.

**This is a multi-week programme. Do the connection-pool split (S1) first** — twenty lines,
fixes the live symptom now, and buys the time to do this properly.

---

## Scope

**Moves to Node:** every geometric check in
`src/validation/geopackage/postgis/index.js` — all fifteen error codes, the tolerances, the
`gridSize` overlays, the England containment test.

**Stays in PostGIS:** persistence, the project document, project lists, everything
non-geometric. PostGIS also stays as a fallback path (see rollout).

**Comes along for free:** habitat sizing. `calculateHabitatSizes` is a fourth parse of the
same geometry; the worker already holds the repaired geometry and can return
`ST_Area`/`ST_Length` equivalents in the same message. This is C4 from the guide, without
the transaction-boundary problem that made it awkward in SQL.

---

## Where it goes

The existing seam is already in the right place. `validation/geopackage/index.js` calls
`validateGeoPackageLayersPostgis(pool, layers)` and nothing else knows how the geometry work
is done — so a second engine behind the same signature is a drop-in.

```
src/validation/geopackage/
  postgis/                    (unchanged, becomes the fallback)
  geos/
    index.js                  validateGeoPackageLayersGeos(layers) → { valid, errors }
    checks.js                 the fifteen rules
    geometry.js               GEOS lifecycle: load, MakeValid, free; bbox; candidate pairs
    payloads.js               builds the sample payloads ERROR_BUILDERS consumes
    reproject.js              proj4 for EPSG:4326 inputs (see risk R2)
    england-27700.json        reference polygon, pre-projected at build time
    worker.js                 worker entry point
    worker-pool.js            fixed pool, queue, per-job timeout, restart on crash
```

`postgis/error-builders.js` is **reused unchanged**. That is deliberate and is the parity
guarantee: if the GEOS path produces the same payloads, it produces the same user-facing
messages by construction.

---

## Key design decisions

### D1 — The worker receives a file path, not parsed layers

Sending the parsed `layers` object across the worker boundary means a structured clone of a
~17 MB object graph per upload. Instead the worker takes the temp file path
(`downloadFileToTemp` has already put it on local disk), reads the GeoPackage itself, and
returns only a verdict plus habitat sizes.

Consequences, all favourable:

- the synchronous `better-sqlite3` parse (57 ms at 5,000 parcels, 127 ms at 10,000) also
  leaves the main thread — this is evidence Item 2 in the perf-evidence comments;
- on a **rejected** file the main thread never parses at all, and rejected files are
  disproportionately the slow ones;
- on an accepted file the main thread still parses once for extract/enrich/persist — a
  57 ms double-parse against 575 ms saved.

The alternative — parse on the main thread, ship GeoJSON strings to the worker — is simpler
but pays the clone cost and keeps the parse on the event loop. Recommend the file path.

### D2 — A small fixed worker pool, with a queue

Two workers (or `min(2, cpus - 1)`), a bounded queue, a per-job timeout, and automatic
restart on crash or OOM. The pool cap *is* admission control: the same protective bounding
that the connection-pool split gives you, except the resource being rationed is CPU on an
instance CDP can scale horizontally, not connections on a database it can't.

### D3 — Full payload parity, not just codes

The spike returns codes and counts. Production must build every field
`postgis/error-builders.js` reads, or user-facing messages change:

| Error code | Payload fields required |
| --- | --- |
| `REDLINE_INVALID_GEOMETRY` | `reason`, `location_wkt` — `GEOSisValidDetail` + `GEOSGeomToWKT` |
| `AREA_PARCELS_INVALID_GEOMETRY` | `count`, `sample[{idx, fid, feature_ref, reason}]` |
| `PARCEL_OVERLAPS` | `count`, `sample[{idx_a, fid_a, feature_ref_a, idx_b, fid_b, feature_ref_b}]` |
| `AREA_PARCELS_TOO_SMALL` | `count`, `sample[{idx, fid, feature_ref, area_sqm}]` |
| `SLIVERS_OUTSIDE_REDLINE` | `count`, `sample[{area_sqm, location_wkt}]` |
| `AREA_PARCELS_OUTSIDE_REDLINE` | `count`, `sample[{idx, fid, feature_ref, escape_area_sqm, escape_location_wkt}]` |
| `HEDGEROWS` / `WATERCOURSES` / `IGGIS` / `TREES_OUTSIDE_REDLINE` | `count`, `sample[{idx, fid, feature_ref}]` |
| `REDLINE_AREA_TOO_LARGE` | `total` |
| `AREA_SUM_MISMATCH` | `redline_total`, `habitats_total` |

Also reproduce the SQL's ordering and the 50-row `ERROR_LIST_SAMPLE_CAP`: samples ordered by
`idx` (or `idx_a, idx_b` for overlaps; `area_sqm DESC` for slivers), capped at 50, with
`count` always truthful.

### D4 — The England polygon ships pre-projected

`england.geojson` is EPSG:4326; every check is in EPSG:27700. Rather than reproject 
per request, generate `england-27700.json` once as a build step
(`geos-wasm-spike/england-27700.mjs` does exactly this via PostGIS) and commit it, with a CI
check that it still matches the source. Removes reprojection from the hot path entirely for
BNG files.

---

## Risks, and how each is retired

| | Risk | Status | How it is retired |
| --- | --- | --- | --- |
| **R1** | WASM GEOS materially slower than native | **Retired** | Measured faster than the current SQL at every size (0.40–0.70×), and a dead heat with the optimised SQL prototype (575 ms vs 587 ms at 5,000) |
| **R2** | EPSG:4326 reprojection diverges from PostGIS | **Largely retired** | Measured: proj4js and PostGIS agree to **0.00075 m** across England. See below |
| **R3** | Numerical divergence from PostGIS | Partly retired | 13/13 fixtures identical. Must be re-run against the full integration suite before this is trusted |
| **R4** | GEOS version skew (WASM 3.13 vs container 3.9 vs RDS ?) | Open | Pin the WASM version; establish what production PostGIS runs; the shadow phase surfaces any divergence in real traffic |
| **R5** | Blocks the event loop | **Retired** | 2,344 ms lag on the main thread → **0 ms p50, 38 ms max** in workers. Worker threads are mandatory, not optional |
| **R6** | Memory leak | **Retired** | RSS plateaus at ~375 MB and is flat from run 20 to run 100; timings stable at ~580 ms throughout |
| **R7** | Memory footprint per worker | **Open — likely blocker if unaddressed** | ~300–400 MB steady state per worker (WASM linear memory never shrinks). Two workers ≈ 800 MB. **Check the ECS task memory limit before anything else** |
| **R8** | WASM binary unavailable at runtime | Needs verification | Confirm the `.wasm` ships inside the npm tarball and is not fetched — CDP restricts egress. `.npmrc` sets `ignore-scripts=true` and the Dockerfile installs with `--ignore-scripts`, so there must be no build step |

### R2 in detail — measured, and much smaller than first thought

`SUPPORTED_SRIDS` is `{4326, 27700}`, so some files arrive in WGS84 and PostGIS reprojects
them with `ST_Transform`. The question was whether doing that in JS with `proj4js` gives the
same answer.

**It does.** Compared against PostGIS across eight sites spanning England, worst-case
disagreement was **0.00075 m** — about 130× inside the tightest tolerance in the validator
(0.1 m for boundary grazing) and irrelevant against the 0.5 m² area tolerances. Evidence:
`evidence/proj4-vs-postgis.txt`, script `geos-wasm-spike/proj-compare.mjs`.

| Site | proj4js vs PostGIS |
| --- | ---: |
| Maidenhead, Newcastle, Penzance, Norwich, Carlisle, London, Birmingham, Skegness | 0.00071 – 0.00075 m |

**Why it was a concern.** The accurate WGS84→BNG transformation uses the **OSTN15 grid
shift**; the fallback is a 7-parameter Helmert approximation, and the two differ by up to
~2 m. That gap only matters if PostGIS and JS pick *different* methods. They don't here: the
tested PostGIS has no OSTN15 grid installed (`/usr/share/proj` holds no `.tif` files,
`NETWORK_ENABLED=OFF`), so PROJ uses Helmert — the same thing proj4js does.

**What still needs checking, and it is one command:** whether *production* PostGIS has the
OSTN15 grid. If it does, production is currently more accurate than a Helmert-based JS path,
and 4326 verdicts would shift by up to ~2 m. The fix in that case is to supply proj4js with
the same grid, not to abandon the approach.

**One code-review gotcha:** several published EPSG:27700 definitions omit the `+towgs84`
parameters, and using one of those is wrong by hundreds of metres. Pin the definition
explicitly, as `proj-compare.mjs` does, and assert it in a unit test.

**Note also** that none of this touches stored data: `persist-upload.js` transforms geometry
with PostGIS when writing rows, and this plan does not change that. Only validation verdicts
were ever in scope. PR 5 (sizing from the worker) is the one step that would move a
*persisted* number onto the JS transform, so re-check this before shipping it.

---

## Delivery

### PR 1 — The engine, not wired in *(3–5 days)*

`src/validation/geopackage/geos/` implementing all fifteen checks with **full payload
parity** (D3). Exported but called by nothing. Unit tests per check.

Ship alongside it a parity harness in `integration-tests/`: parameterise the existing
`postgis-validate-baseline-layers.test.js` over both engines. That file already contains
roughly a hundred assertions covering boundary tolerance, invalid-parcel overlaps,
coordinate-system handling and the details payloads — turning it into a parity suite is the
single highest-value test move available, and far better than writing new tests.

**Exit criteria:** the whole existing integration suite passes against both engines.

### PR 2 — Worker pool and wiring *(2–3 days)*

`worker-pool.js` and `worker.js`, plus a convict setting:

```js
validation: {
  engine: {
    doc: 'Geometry validation engine: postgis (default), geos (in-process GEOS-WASM), or shadow (run both, return postgis, log divergence)',
    format: ['postgis', 'geos', 'shadow'],
    default: 'postgis',
    env: 'VALIDATION_ENGINE'
  }
}
```

`validation/geopackage/index.js` dispatches on it. Default stays `postgis`, so this PR
changes nothing in production. Worker failure or timeout falls back to PostGIS and logs.

**Do the memory check here, not later** (R7): measure a real ECS task with two workers under
load before going further.

### PR 3 — Shadow mode *(1–2 days, then a soak)*

`engine: 'shadow'` runs both, returns the PostGIS answer, and emits a structured divergence
line plus a counter metric when the two disagree — same shape as the existing
`perf-evidence` instrumentation. Run in dev and test for **two weeks minimum**, ideally with
a production shadow if the CPU headroom allows.

This is what actually retires R3 and R4: real files, real coordinate systems, real edge
cases, with zero user-facing risk.

### PR 4 — Flip the default *(1 day + soak per environment)*

Dev → test → production, one environment at a time, watching the divergence counter and
`postgisValidateMs` / `totalMs`. `VALIDATION_ENGINE=postgis` is the instant rollback and
needs no deploy.

### PR 5 — Habitat sizing from the worker *(2 days)*

The worker returns per-feature areas and lengths alongside the verdict;
`calculateHabitatSizes` becomes a pure function that maps them onto `featureId`. Removes the
fourth parse pass and one more database round trip. Note the post-intervention path filters
`Lost` features *after* validation — since sizes are a pure function of geometry and the
filter only removes features, computing them for all and selecting in JS is correct.

### PR 6 — Retire or retain the SQL path *(decision, not work)*

Once shadow has been clean for a quarter, either delete `postgis/index.js` or keep it as the
EPSG:4326 route and the emergency fallback. Recommend **retain** until R2 is fully resolved.

**Rough total: 2–3 weeks of development, plus a 2–4 week shadow soak before production.**

---

## Testing

- **Parity over the existing integration suite** — the primary instrument (PR 1).
- **The 13 spike fixtures** — `compare.mjs equiv` already automates this; move it into
  `integration-tests/`.
- **The permutations catalogue** — `npm run generate:gpkg:all` produces the BMD-934 scenario
  library; run both engines across all of it.
- **Property testing** — generate random fixtures with `gen-gpkg.mjs --size N --seed S` over
  many seeds, assert byte-identical verdicts. Cheap, and it explores shapes nobody wrote a
  test for.
- **Load** — the JMeter `Upload journey` and `Validation cost vs concurrency` ladders, with
  the background probe. Expect the probe to stay flat where it currently collapses.
- **Memory** — sustained upload load against a real ECS task, watching RSS plateau.

---

## Decisions needed before starting

1. **What is the ECS task memory limit for the backend?** Two workers at ~375 MB each is the
   most likely blocker, and it is knowable today (R7).
2. **Does production PostGIS have the OSTN15 grid installed?** One command. If not (as in
   the tested image), R2 is closed. If so, supply proj4js with the same grid.
3. **Do we want the SQL improvements in `implementation-guide.md` as well?** C1–C5 make the
   PostGIS path ~2× faster and are worth doing regardless if it survives as the 4326 route
   and the fallback — but they are wasted effort if it is deleted outright.
