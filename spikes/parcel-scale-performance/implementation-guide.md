# Implementing the parcel-scale performance improvements

Companion to `report.md`. That document is the evidence — what was measured and why.
This one is the implementation plan: what to change, where, in what order, what will break,
and how to prove each step worked.

The working prototype these changes were measured against is `scripts/opt-query.mjs`,
driven by `scripts/runopt.mjs`. Treat it as a **reference for the SQL shape, not a patch to
apply** — it has no tests, no explanatory comments, and it takes a shortcut on the overlap
index that needs undoing (see C2).

All gains are measured at 5,000 parcels on a natively executing PostGIS. Total available
from C1–C5 is **~580 ms of a 1,174 ms baseline (1.98×)**, and ~625 ms once the overlap
regression in C2 is avoided.

---

## Files in scope

| File | What changes |
| --- | --- |
| `backend/src/validation/geopackage/postgis/index.js` | Most of it. `buildArrays`, `MATERIALISE_AREAS_QUERY`, `FEATURES_IN_CTE`, `CHECK_QUERY`, `materialiseIndexedAreas`, `validateGeoPackageLayersPostgis` |
| `backend/src/services/upload/calculate-habitat-sizes.js` | C4 — becomes a consumer of validation's output rather than its own query |
| `backend/src/services/upload/save-upload-for-project.js` | C4 — the sizing call site moves |
| `backend/src/validation/geopackage/index.js` | C4 only, if validation's return shape grows a `sizes` field |
| `backend/compose.yml` | P0 — one line |

Test files that will need attention are listed per change.

---

## P0 — Pin a multi-arch PostGIS image

**Do this first, and separately from everything else.** It is not a production change and
it does not belong in the same PR as the query work, but without it nobody can measure
whether the query work helped.

`backend/compose.yml` currently pins `postgis/postgis:16-3.5`, which publishes **no arm64
manifest**. On Apple Silicon and other arm64 hosts Docker falls back to the amd64 image and
runs it under QEMU — 10–20× slower than native, verified on workloads with no geometry in
them at all (see `report.md` §3).

```yaml
postgres:
-   image: postgis/postgis:16-3.5
+   # Multi-arch: the postgis/postgis tags have no arm64 manifest, so on Apple
+   # Silicon Docker silently falls back to the amd64 image under QEMU emulation,
+   # which is 10-20x slower and makes local performance numbers meaningless.
+   image: imresamu/postgis:16-3.5
```

`imresamu/postgis:16-3.5` and `ghcr.io/baosystems/postgis:16-3.5` were both verified working
against this codebase during the investigation. Both carry PostGIS 3.5.3 with GEOS 3.11 and
PROJ 9 (the pinned image has GEOS 3.9 / PROJ 7).

**Verify:** `docker exec <container> uname -m` reports the host architecture, and
`select postgis_full_version()` reports GEOS 3.11 or later.

**Watch for:** the volume `pgdata` holds a data directory initialised by the old image. Same
PostgreSQL major version, so it should attach cleanly, but a `docker compose down -v` is the
clean path if it complains.

---

## The five changes

### C1 — Send identifiers, not the whole properties blob

**Gain:** −9.2 MB of the 10.9 MB parameter payload at 5,000 parcels; roughly **110–160 ms**,
most of it wire transfer and array decoding, ~50 ms of it the `props::jsonb` cast.

**Why.** `buildArrays` sends `JSON.stringify(feature.properties ?? {})` for every feature —
about 1.85 KB each — and `FEATURES_IN_CTE` casts all of it with `props::jsonb`. The only
consumers are two SQL fragments that read at most three keys, used purely to name offending
features in error messages:

```js
// postgis/index.js — the entire use of a 9.2 MB payload
function featureRefSql (propsExpr = 'props') {
  return `COALESCE(${propsExpr}->>'Parcel Ref', ${propsExpr}->>'Tree Ref', ${propsExpr}->>'Baseline Parcel Ref')`
}
function fidColumnSql (propsExpr = 'props') {
  return `${propsExpr}->>'fid'`
}
```

**What to do.** Resolve both values in `buildArrays` and pass them as two `text[]` parameters.
`fid` and `feature_ref` become plain columns; `featureRefSql` and `fidColumnSql` disappear
along with every `props` reference in the query.

```js
// buildArrays — add two arrays, drop one
const fids = []
const refs = []
// …
fids.push(props.fid == null ? null : String(props.fid))
refs.push(props['Parcel Ref'] ?? props['Tree Ref'] ?? props['Baseline Parcel Ref'] ?? null)
```

**Decision to make.** The SQL is an **exact-key** lookup. The codebase already has a
case-insensitive equivalent — `pickProp(properties, candidates)` in
`validation/geopackage/properties.js`, used with `REF_PROP_KEYS_BY_LAYER` from
`carry-forward-feature-ids.js`. Using `pickProp` would make ref resolution *more* tolerant
than it is today, which is probably desirable but **is a behaviour change**. Default to
exact-key lookup to keep this PR purely a performance change; raise the tolerance question
separately.

**Tests.** `postgis/index.test.js` asserts on the arrays `materialiseIndexedAreas` returns —
those assertions change shape. The integration suite's "details payload (Path B)" block
(`integration-tests/postgis-validate-baseline-layers.test.js:661`) covers `fid` and
`feature_ref` appearing in error samples and should pass unchanged; if it does not, the
JS-side resolution does not match the SQL it replaced.

**Independent of C2–C5.** Can ship on its own.

---

### C2 — Load every layer once, into one table

**Gain:** the foundation for C3–C5, and on its own removes a duplicate parameter transfer
and a duplicate parse of the area layer. Combined with C1 the "get geometry ready" stage
falls from **435 ms to 77 ms**.

**Why.** Today two consecutive statements each receive the full `$1..$5` parameter set and
each parse it:

```
MATERIALISE_AREAS_QUERY   →  parses all params, keeps the 'areas' rows in areas_g
CHECK_QUERY               →  receives the same params again, re-parses ALL six layers
```

The temp table exists only to give the GiST index a home for the overlap self-join; nothing
else reads it. Meanwhile `features_in` re-derives the area geometries the table already holds.

**What to do.** Replace `MATERIALISE_AREAS_QUERY` + `FEATURES_IN_CTE` with a single load
statement covering every layer, holding both the raw and the repaired geometry:

```sql
CREATE TEMP TABLE feat_all ON COMMIT DROP AS
SELECT layer, idx, fid, feature_ref, geom, ST_MakeValid(geom) AS geom_valid
FROM (
  SELECT layer, idx, fid, feature_ref,
         ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(g), srid), 27700) AS geom
  FROM unnest($1::text[], $2::int[], $3::text[], $4::text[], $5::text[], $6::int[])
    AS t(layer, idx, fid, feature_ref, g, srid)
) s
```

Then `CHECK_QUERY` opens with per-layer views over `feat_all` and takes only the England
polygon as a parameter — no geometry parameters at all.

**Both geometry columns are needed.** `AREA_PARCELS_INVALID_GEOMETRY` and
`REDLINE_INVALID_GEOMETRY` test `ST_IsValid` on the geometry **as supplied**; everything else
works on the repaired version. Keeping `geom` and `geom_valid` side by side preserves that
distinction and computes `ST_MakeValid` exactly once — today it is applied in
`parcels_union`, `c_areas_outside`, `c_areas_too_small` and inside `areas_g` separately, and
`c_areas_too_small` evaluates `ST_Area(ST_MakeValid(geom))` **twice per row**, once in the
`SELECT` list and once in the `WHERE`.

That last point is C1-independent and worth ~**31 ms** on its own
(experiment E2: 31.8 → 1.3 ms).

**Do not copy the prototype's index.** `opt-query.mjs` builds a partial index
`ON feat_all USING gist (geom_valid) WHERE layer = 'areas'`, and that costs the overlap join
**+46 ms** against the current dedicated table (246 → 292 ms). Keep a separate, dedicated
area table for the join — populated from `feat_all`, so the geometry is still parsed once:

```sql
CREATE TEMP TABLE areas_g ON COMMIT DROP AS
SELECT idx, fid, feature_ref, geom_valid AS geom FROM feat_all WHERE layer = 'areas';
CREATE INDEX ON areas_g USING gist (geom);
ANALYZE areas_g;
```

**Tests.** `materialiseIndexedAreas` is exported and used directly by
`postgis/index.test.js:99` and `integration-tests/postgis-validate-baseline-layers.test.js:791`.
Renaming or changing its return shape touches both. The integration suite's
"parcel-overlap spatial index" block (line 804) asserts the temp table is dropped and that a
pooled connection can be reused and used concurrently — that behaviour must survive, since
`ON COMMIT DROP` is what keeps a pooled client clean.

**Depends on C1** for the `fid` / `feature_ref` columns, though it could be done first with
`props` still on the table.

---

### C3 — One escape rowset for both outside-the-red-line errors

**Gain:** **−185 to −199 ms** for the sliver check (experiment E5: 227.9 → 28.5 ms) and
**−71 ms** for the per-parcel check (E4: 95.4 → 24.8 ms). The single largest algorithmic win.

**Why.** `c_slivers_outside` computes `ST_Union(ST_MakeValid(geom))` over every parcel and
subtracts the red line. In the 5,000-parcel plan that one `Aggregate` node is the second most
expensive in the statement. But:

> `ST_Difference(⋃Pᵢ, R)` ≡ `⋃ ST_Difference(Pᵢ, R)`

and `c_areas_outside` already computes `ST_Difference(Pᵢ, R)` per parcel, one CTE later. On a
valid file both are empty — so the union of 5,000 polygons is being built to derive something
that could be assembled from an empty rowset.

**What to do.** Compute the escapes once, gated so parcels the red line already covers never
reach the overlay, and derive both errors from that rowset:

```sql
c_escapes AS (
  SELECT feat.idx, feat.fid, feat.feature_ref,
         ST_Difference(feat.geom_valid, redl.geom, 0.001) AS escape
  FROM areas feat CROSS JOIN redline_union redl
  WHERE redl.geom IS NOT NULL
    AND NOT ST_CoveredBy(feat.geom_valid, redl.geom)   -- the gate
),
c_areas_outside   AS (SELECT … FROM c_escapes WHERE ST_Area(escape) > 0.5),
c_slivers_outside AS (
  SELECT ST_Area(g) AS area_sqm, ST_AsText(g) AS location_wkt
  FROM (SELECT (ST_Dump(ST_Union(escape))).geom AS g
        FROM c_escapes WHERE escape IS NOT NULL) leftover
  WHERE ST_Area(g) > 0.5
)
```

Apply the same `NOT ST_CoveredBy(...)` gate to `c_hedgerows_outside`,
`c_watercourses_outside` and `c_iggis_outside` — worth a further **−48 ms** across the three.

**The one semantic difference, and why it is acceptable.** The tolerances are unchanged, but
the *order* of union and threshold matters in one edge case: five parcels each escaping
0.4 m² into one contiguous 2 m² piece is flagged by the current dissolved form and by the new
form too (both union before thresholding), so this is preserved. What is not preserved is
nothing — the rewrite is set-theoretically identical. The risk is not in the maths but in the
gate.

**Risk: the `ST_CoveredBy` gate.** `ST_CoveredBy` is a strict predicate; the escape overlay
it skips is a tolerant one. A parcel sitting one ULP outside a shared boundary edge is
**not** covered, so it passes the gate, reaches the overlay, and gets suppressed there by the
0.5 m² tolerance — correct. The failure mode would be the reverse (covered but should escape),
which cannot happen. Even so, this is the change that most needs its own tests.

**Tests to add.** The integration suite already has a "boundary-tolerance behaviour" block
(`postgis-validate-baseline-layers.test.js:592`). Extend it with parcels that:

- share an exact edge with the red line (must not be flagged, must be gated out cheaply);
- sit one floating-point epsilon outside a shared edge (must not be flagged — gate passes,
  tolerance suppresses);
- escape by just under and just over 0.5 m² (must flag only the latter, in both error codes);
- escape in several sub-tolerance pieces that union to over tolerance (must flag the sliver
  error, not the per-parcel one).

The harness fixtures `--flaw parcel-outside-redline` and `--flaw tiny-gap` cover the coarse
versions of the first and third.

**Depends on C2.**

---

### C4 — Get habitat sizes from the validation pass

**Gain:** **−44 ms** (49.9 → 5.6 ms) and one fewer round trip. This is the change with the
most call-chain consequences, so read the constraints before starting.

**Why.** `CALCULATE_HABITAT_SIZES_QUERY` is a third `ST_GeomFromGeoJSON` + `ST_Transform` +
`ST_MakeValid` pass over the area, hedgerow and watercourse layers, computing
`ST_Area` / `ST_Length` that the validation statement has already had the geometry to
compute. Its own comment says so.

**Three constraints that make this not a straight swap.**

1. **Different client, different transaction.** `validateGeoPackageLayersPostgis` takes its
   own client, wraps everything in `BEGIN … COMMIT`, and releases — so the `ON COMMIT DROP`
   temp table is gone before `calculateHabitatSizes(pgPool, …)` is called from
   `save-upload-for-project.js:163`. Sizing cannot simply query `feat_all`.
2. **Different feature set.** For post-intervention, sizing runs on
   `filterLostPostInterventionLayers(layersWithIds)` — hedgerows, watercourses and trees with
   `Lost` retention removed. Validation sees the unfiltered set.
3. **Different key.** Validation keys features by `idx`; sizing returns results keyed by
   `featureId`, which `assignFeatureIds` attaches *after* validation has run.

**What to do.** Have validation return per-feature sizes keyed by `(layer, idx)`, and keep
the mapping in JavaScript:

- add a second result set to the validation transaction — a cheap
  `SELECT layer, idx, CASE WHEN layer = 'areas' THEN ST_Area(geom_valid) ELSE ST_Length(geom_valid) END FROM feat_all WHERE layer IN ('areas','hedgerows','watercourses')`
  — and return it alongside `{ valid, errors }`;
- `calculateHabitatSizes` becomes a pure function: take those rows, the `layersWithIds`, and
  the filtered layer set, and assemble the same `{ areaHabitats, hedgerows, watercourses }`
  shape it returns today.

Constraint 2 is safe because `filterLostPostInterventionLayers` only **removes** features and
never alters geometry, so sizes computed over the unfiltered set are a superset — the filter
becomes a JS-side selection over rows already computed. Constraint 3 is a lookup by array
index.

**Signature changes to expect.** `validateGeoPackageLayersPostgis(pool, layers)` and
`validateGeoPackageLayers(layers, pool, variant)` both grow a field in their return value.
`index.wire.test.js:55` and `:96` assert on the arguments those receive, and
`baseline.test.js`, `post-intervention.test.js`, `baseline.persistence-errors.test.js` and
`save-upload-for-project.test.js` all mock `calculateHabitatSizes` — their mocks change from
`mockResolvedValue` to a synchronous return.

**Keep the failure path.** `sizeUploadedHabitats` turns a sizing failure into a 500 with
`SIZING_FAILED`, covered by `baseline.persistence-errors.test.js:555`. If sizing becomes part
of the validation transaction, decide deliberately whether a sizing failure now fails
validation instead — and if it does, that test and its error code need revisiting.

**Depends on C2.** Lowest gain of the five and the highest blast radius: consider shipping it
last, or deferring it.

---

### C5 — Prepare the statement

**Gain:** **~170 ms per upload, independent of file size.** Measured by `EXPLAIN` on the
5,000-parcel parameter set; PostgreSQL's own reported planning time ranged 85–366 ms.

**Why.** `client.query(text, values)` uses the extended protocol with an unnamed portal, so
PostgreSQL parses and plans the ~200-line, 15-branch statement on **every upload**. At 50
parcels the planning cost exceeds the execution cost.

**What to do.** Give the statement a name so the plan is cached per connection:

```js
await client.query({ name: 'bng-baseline-check', text: CHECK_QUERY, values: [...] })
```

**Watch for.** Named statements are per-connection and live for the life of the pooled
client. Parameter types must be stable across calls — they are, since every parameter is a
fixed array type. And once C2 lands, `CHECK_QUERY` takes only the England polygon as a
parameter, which makes the plan even more cacheable. Verify that the plan chosen for a
5,000-parcel file is still chosen for a 50-parcel one — a generic plan that stops using the
GiST index would be a regression, so check `EXPLAIN` output at both ends of the range.

**Independent of everything else.**

---

## Also worth doing, larger

### C6 — Send WKB instead of GeoJSON

**Gain:** **3.5×** on geometry parsing (experiment E1: 32.9 → 9.5 ms for 5,000 parcels), plus
it deletes a JS-side decode and re-serialise per feature.

The reader already holds the original GPKG WKB blob. `decodeFeature` in
`read-feature-tables.js` decodes it to GeoJSON via `wkbToGeoJSON`, and `geometry-json.js`
caches the `JSON.stringify` of that — so a geometry is converted WKB → GeoJSON object →
GeoJSON string in Node, then parsed back from GeoJSON text in PostgreSQL. Passing the blob
through as `bytea` (with the GPKG header stripped) and using `ST_GeomFromWKB` skips all of it.

This is a bigger change than C1–C5 because the GeoJSON form is also consumed by
`persist-upload.js` and the extract functions, so it needs its own PR and its own thinking
about which consumers keep needing GeoJSON. Sequence it after C1–C5 have landed.

---

## Suggested sequence

| PR | Contains | Cumulative gain @5,000 | Blast radius |
| --- | --- | --- | --- |
| 1 | P0 — compose image | none in prod; 10–20× locally | `compose.yml` only |
| 2 | C5 — prepared statement | ~170 ms | one call site |
| 3 | C1 — identifiers not properties | ~300 ms | `buildArrays` + 2 test files |
| 4 | C2 — one load table, repair once, dedicated area table | ~450 ms | most of `postgis/index.js`, 2 test files |
| 5 | C3 — escape rowset + `ST_CoveredBy` gates | ~750 ms | `CHECK_QUERY` + new boundary tests |
| 6 | C4 — sizing from validation | ~795 ms | 6 test files, one error path |
| 7 | C6 — WKB input | ~900 ms | reader, persist, extract |

PRs 2 and 3 are independent of each other and of everything after; PRs 4–6 are a chain.
Stopping after PR 5 captures **the large majority of the available gain** for a fraction of
the risk in PR 6 — C4 has the smallest gain and the widest reach, so treat it as optional.

---

## Proving each step

The spike harness is set up to measure a change without rewriting anything. `runopt.mjs`
compares two implementations over the same parsed layers in the same session; point its
"optimised" side at the modified backend module instead of `opt-query.mjs` and both modes
work unchanged:

```sh
# regenerate fixtures (once)
for n in 250 1000 2000 5000 10000; do
  node scripts/gen-gpkg.mjs --size $n --seed 42 --outdir gpkg/n$n
done
for f in overlapping-parcels parcel-outside-redline parcel-too-small bowtie-parcel \
         area-sum-mismatch tiny-gap self-intersecting-redline hedgerow-outside \
         watercourse-outside tree-outside; do
  node scripts/gen-gpkg.mjs --flaw $f --size 80 --seed 7 --outdir gpkg-bad/$f
done

PGPORT=5433 node scripts/runopt.mjs equiv                       # 13 fixtures must all MATCH
PGPORT=5433 node scripts/runopt.mjs perf 250,1000,2000,5000,10000
PGPORT=5433 node scripts/profile.mjs 5000                       # per-check attribution
PGPORT=5433 REPEATS=3 node --expose-gc scripts/bench.mjs 250,1000,5000
```

**The bar for each PR:** `runopt.mjs equiv` reports MATCH on all thirteen fixtures — error
codes *and* counts — and `npm run test:integration` passes. Record the `perf` numbers in the
PR description so the cumulative table above can be kept honest.

One gap worth closing: the equivalence check compares codes and counts, not the WKT strings
and areas inside the error `sample` arrays. C3 changes how escape geometry is produced, so
extend `runopt.mjs` to diff the full payloads before relying on it for that PR.

---
## Concurrent uploads and connection starvation

The changes above reduce the work per upload. They do **not** address the separate problem
of several large uploads landing at once and slowing the whole service — that has its own
mechanism and its own fix, and the two should not be conflated.

### Why concurrency behaves the way it does

Under saturation, throughput is not about latency:

> sustainable uploads/sec ≈ database vCPUs ÷ CPU-seconds consumed per upload

The model is validated: 2 vCPUs ÷ 0.184 CPU-s per 1,000-parcel validation = 10.9/s
theoretical, 8.2–8.8/s measured. Past concurrency 2 on a 2-vCPU host, throughput is flat and
every additional request appears purely as latency (202 ms → 975 ms at concurrency 8).

So **every CPU-second removed converts directly into concurrent capacity** — C1–C5 give ~2×,
with C6 ~3×. The C-list is worth *more* under load than the single-user numbers suggest.

### The C-list, re-ranked for the concurrent case

Ordering by CPU and memory removed rather than by latency:

| Rank | Change | Why it moves |
| --- | --- | --- |
| 1 | **C5** prepared statement | Planning cost is **size-independent** (~170 ms of pure CPU per upload). With many concurrent medium uploads it can be the largest single CPU line. Cheapest change on the list. |
| 2 | **C1** drop the properties payload | Under concurrency this is a **memory** fix: ~11 MB buffered twice per upload today, so ten concurrent 5,000-parcel uploads is ~220 MB of transient buffers squeezing `shared_buffers`. |
| 3 | **C2** one load pass | Removes a whole parse+reproject pass — pure CPU, scales with concurrency. |
| 4 | **C3** escape rowset | Largest algorithmic CPU saving, and removes the biggest transient allocation in the statement (`ST_Union` over every parcel). |
| 5 | **C6** WKB input | 11 MB → ~1.3 MB per upload on the wire and in buffers. |
| 6 | **C4** sizing from validation | Still last, but frees an extra round trip and connection acquisition per upload. |

### Three mechanisms the C-list does not fix

1. **Connection starvation.** `validateGeoPackageLayersPostgis` holds a dedicated client
   across `BEGIN → materialise → index → check → COMMIT` — it must, because the temp table is
   `ON COMMIT DROP`. That is ~1.1 s at 5,000 parcels, out of a pool of **`max: 10`
   (`src/plugins/postgres.js:53`) shared with every other query in the service**. Concurrent
   large uploads leave login, project-list and project-summary queuing behind geometry work.
   This is the mechanism that turns "uploads are slow" into "the service is slow", and it is
   almost certainly what the perf suite's background probe detects.
2. **Node event-loop blocking.** ~155 ms of synchronous JS per 5,000-parcel upload (parse 57
   + extract 48 + enrich 50; ~250 ms at 10,000). `better-sqlite3` has no async mode, so
   nothing else on that instance progresses. Untouched by C1–C6; already flagged by the
   `perfEvidence` comments (Items 2 and 8).
3. **Retry amplification.** Under saturation, validate latency crosses the frontend's 10 s
   `BACKEND_TIMEOUT_MS`; the user retries; the abandoned request is still burning database
   CPU. Classic metastable failure — the system does not recover when offered load drops.

### The fixes, in order

**S1 — Give validation its own small connection pool.** ~20 lines in
`src/plugins/postgres.js`: a second pool with `max: 2–3` used only by the geometry
validation, leaving the main `max: 10` for ordinary traffic. Geometry work can then never
starve the rest of the service of connections; concurrency is capped below the database's
knee; excess uploads queue on connection acquisition rather than all running slowly at once.
Total throughput is unchanged — you were CPU-bound anyway — but latency becomes bounded and
the blast radius disappears. **Cheapest change available and the highest value for this
symptom.**

**S2 — `SET LOCAL statement_timeout` on the validation transaction.** A safety valve worth
having regardless: today a pathological file can hold a pooled connection indefinitely.

**S3 — Asynchronous validation.** Queueing is only acceptable if waiting is. Return a job id
and let the frontend's existing 120 s poll loop
(`habitat-upload-received-controller.js`, `REFRESH_INTERVAL_SECONDS = 5`,
`MAX_WAIT_SECONDS = 120`) wait on it — the loop it already uses for the CDP uploader. Removes
mechanism 3 and makes S1 safe under bursts.

**S4 — Replace the temp table with an unlogged, upload-scoped table** (see below). Breaks the
coupling between the work and a single session entirely.

**S5 — Move the synchronous JS stages to a worker thread.** Only worth it once the database
has stopped being the bottleneck.

### S4 in detail — the unlogged upload-scoped table

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;   -- available in the image, not yet installed
CREATE UNLOGGED TABLE validation_areas (
  upload_id uuid, idx int, fid text, feature_ref text, geom geometry(Geometry,27700));
CREATE INDEX ON validation_areas USING gist (upload_id, geom);
CREATE INDEX ON validation_areas (upload_id);   -- see "plan stability" below
```

Insert, check and delete become independent statements: each borrows a connection, runs, and
returns it. Nothing is held across statements, so starvation becomes impossible by
construction rather than merely bounded. It is also what a background worker needs, since the
rows outlive the request.

**What it does *not* buy.** The index *definition* is created once; the index *entries* are
still built per row on every upload. The DDL avoided is small — measured at 5,000 parcels,
native:

| | Today (temp table) | S4 (shared, pre-indexed) |
| --- | ---: | ---: |
| Get rows in | 76 ms (`CREATE TABLE AS`) | 50 ms (`INSERT`) |
| Build index | 6.3 ms | — |
| `ANALYZE` | 7.8 ms | — |
| Overlap join | 105 ms | 93 ms |
| Clean up | free (`ON COMMIT DROP`) | 1.3 ms (`DELETE`) |

~14 ms of a ~1,124 ms validation — about 1%. **The case for S4 is connection decoupling, not
index savings.**

**Shared-index contention: measured, not a problem.** With nine uploads and 45,000 rows
resident, the join stays flat regardless of whether the sites coincide in space:

```
alone in the table                        95 ms
8 others, same site (worst case)          93 ms
8 others, different sites 5 km apart     102 ms
8 others, different sites 100 km apart    99 ms
```

**Plan stability: the real risk.** Today `ANALYZE areas_g` gives the planner exact knowledge
of this upload's data. On a shared table, statistics are global and cannot be gathered per
upload. A 4× swing (93 ms → 373 ms) was observed purely from changing the key type from
`uuid` to `bigint`, with the planner switching scan strategy. Adding a plain btree on
`upload_id` alongside the `btree_gist` index produced the fastest and most stable plan (index
scans on both sides). **Create both indexes, and assert the plan shape in an integration
test rather than assuming it.**

**The other costs, unchanged:** it gives up the "nothing is persisted" property documented at
the top of `postgis/index.js`; it needs a janitor for rows orphaned by a request that dies
mid-flight; and insert/delete churn creates autovacuum work and index bloat.

---

## Explicitly not doing

Measured, no gain, documented so nobody re-tries them:

| Idea | Result |
| --- | --- |
| `ST_Relate(a, b, 'T********')` as an overlap pre-filter | 302 → 294 ms — relate costs what the overlay costs |
| `NOT ST_Touches(a, b)` as an overlap pre-filter | 302 → 304 ms — no gain |
| Drop the `gridSize` argument from `ST_Intersection` | 302 → 259 ms, but reintroduces the floating-point ghost slivers `gridSize` was added to eliminate |
| Pre-shrink parcels by 5 cm and join the shrunk geometries | 302 → 239 ms including build, but changes semantics on thin parcels |
| Force parallel workers on the overlap join | no gain on a 2-vCPU database |
| Move geometry work to Turf / Node | the JS side is 155 ms of a 1,600 ms request; PostGIS is the right place |
| **Generate the overlap candidate pairs in Node and drop the temp table** | see below — works at 5,000 parcels, collapses to 18 s at 10,000 |

### The rejected option worth documenting: candidate pairs from Node

Proposed as a way to remove the temp table (and therefore the held connection) altogether:
the table exists only to give the overlap self-join a GiST index for bounding-box pruning,
and bbox pruning is the one step here with no numerical-robustness risk — it is rectangle
intersection, not geometry. So do the sweep in Node, pass PostGIS the candidate pairs, and
neither the table nor the index is needed.

**The Node half works.** A sort-and-sweep over the parcel envelopes, cross-checked against a
brute-force O(N²) bbox comparison:

| Parcels | bbox extract | sweep | candidate pairs | matches brute force |
| ---: | ---: | ---: | ---: | --- |
| 1,000 | 1.6 ms | 2.6 ms | 4,108 | yes |
| 5,000 | 4.5 ms | 7.6 ms | 21,568 | yes |
| 10,000 | 6.9 ms | 29.9 ms | 43,357 | yes |

Exact pair set, ~12 ms at 5,000 parcels, and the confirmed overlap count matched the GiST
path at every size.

**The SQL half collapses.**

| Parcels | Today (temp table + GiST) | Candidate pairs from Node |
| ---: | ---: | ---: |
| 1,000 | 117 ms | 159 ms |
| 5,000 | 563 ms | 331 ms |
| 10,000 | 1,254 ms | **17,820 ms** |

**Diagnosis, and it is not memory.** Joining the pairs back to the geometries needs an access
path on `idx`, and a CTE has none. Worse, PostgreSQL cannot estimate `unnest()` cardinality —
it assumes 100 rows. On that estimate a nested loop over a 10,000-row CTE looks cheap, so the
planner picks one and re-scans the CTE for each of 43,357 pairs. Tested at `work_mem` 4 MB,
64 MB and 256 MB: the plan is `Nested Loop + Nested Loop` in all three, ~44 s each time.

That is the same pathology BMD-911's temp table was introduced to cure. Removing the table
removes not just the spatial index but the statistics and the access path the join needs.

**Also note** the gain was never as large as it looked: a single statement still occupies a
connection for its duration, so even the working 5,000-parcel case only took connection
occupancy from 563 ms to 331 ms — a 2× reduction, not elimination. What it removed was the
multi-statement transaction, not the occupancy.

**What survives.** The JS bbox sweep gives the candidate-pair count in ~12 ms *before*
touching the database — a cheap, accurate predictor of how expensive an upload will be, which
is exactly what admission control (S1) wants: cheap uploads straight through, expensive ones
queued behind a lower concurrency limit.

Evidence: `evidence/connection-model-experiments.txt`, produced by `scripts/optb.mjs` and
`scripts/optb2.mjs`.

**The parcel-overlap check is the irreducible core.** After C1–C5 it is ~74% of the remaining
query time, and the current formulation —
`ST_Area(ST_Intersection(a, b, gridSize)) > tolerance` over GiST-pruned candidate pairs — is
both correct and close to the cheapest correct form. The comments in `postgis/index.js`
explaining why a Boolean predicate was rejected still hold. Leave it alone.

---

## Out of scope here, but queued behind it

Two findings from the investigation that these changes do not address:

- **The JSONB project document reaches 17.3 MB at 5,000 parcels** — 178 ms to insert, 357 ms
  to `jsonb_set`, 229 ms to read back, and it is read by the project list and project summary
  pages on every visit. At 10,000 parcels it would be ~35 MB. This is likely to become the
  binding constraint on large sites before validation does.
- **Validation runs synchronously inside a page request** behind a 10 s
  `BACKEND_TIMEOUT_MS`, while `habitat-upload-received-controller.js` already has a 120 s
  polling loop it uses for the CDP uploader. Moving validation into that loop removes the
  hard timeout cliff for large files and costs no extra compute.
