# GeoPackage upload performance at parcel scale

**Question asked:** at what number of habitat parcels does upload processing start to
degrade noticeably, how long would a 5,000-parcel GeoPackage take, and can the PostGIS
validation be optimised or partly moved off the database?

**Date:** 2 September 2026 · **Repos at:** `main` (harness `4d5dcf2`, frontend, backend,
bng-library, journey-tests, perf-tests all pulled and up to date)

All numbers below were measured, not modelled. Raw results are in `evidence/`, and every
script that produced them is in `scripts/` (see [Reproducing](#reproducing) at the end).

---

## 1. Answers up front

**A 5,000-parcel baseline GeoPackage takes about 1.6 seconds of server-side work**, of
which **1.12 s is the PostGIS validation round trip**. Add S3 download of the ~5 MB file
and CDP-uploader wait on top. That is on a *natively executing* PostGIS.

**Cost is essentially linear in parcel count** — roughly **0.19–0.23 ms of database time
per parcel** from 250 up to 5,000 — and only becomes mildly superlinear past 5,000
(0.28 ms/parcel at 10,000). There is no cliff, no quadratic blow-up: the GiST-indexed
temp table added by BMD-911 already removed the N² behaviour.

**Where "noticeable" begins depends entirely on what you compare against:**

| Threshold | Parcels (native PostGIS) |
| --- | --- |
| Validation exceeds 100 ms | ~750 |
| Validation exceeds 500 ms | ~3,000 |
| Validation exceeds 1 s | ~4,500 |
| Validation exceeds 2 s | ~8,000 |
| **Whole validate call exceeds the frontend's 10 s `BACKEND_TIMEOUT_MS`** | **~25,000** |

**But the biggest single finding is not about parcel counts at all.** The development
PostGIS container is an **amd64 image running under QEMU emulation** on this arm64 host,
which makes it **10–20× slower than native**. On that emulated database, the same
5,000-parcel file takes **13.4 s**, and the frontend's 10 second backend timeout is
exhausted at around **3,900 parcels**. Any performance evidence gathered locally on an
Apple Silicon / arm64 machine is inflated by roughly an order of magnitude.
See [§3](#3-the-environment-caveat-that-changes-every-number).

**On optimisation:** yes, materially. A restructured prototype — measured, and verified
to return byte-identical error codes and counts across thirteen fixtures — is **1.8–2.0×
faster**, and it makes the separate habitat-sizing round trip almost free (47 ms → 6 ms
at 5,000 parcels). Combined with the input-encoding change it should be **2.5–3×**.
See [§6](#6-optimisation-experiments-measured) and [§7](#7-a-restructured-prototype-18-2-faster-same-answers).

**On moving work off the database: no — but move it off the request handler.** PostGIS is
doing the right work in the right place; the JavaScript side is not the bottleneck
(57 ms of a 1,600 ms request at 5,000 parcels). What should change is *when* the work
happens: validation currently runs synchronously inside a page request bounded by a 10 s
HTTP timeout, while the frontend already has a 120 s polling loop it could wait in.
See [§9](#9-should-any-work-move-off-the-database).

---

## 2. What was measured, and how

The real backend modules were driven directly — `validateAndReadGpkgFile`,
`validateGeoPackageLayersPostgis`, `calculateHabitatSizes`, `extractHabitatData`,
`enrichBaselineDocumentWithUnits` — against a real PostGIS container. Nothing was
re-implemented for the benchmark, so the timings are of the shipping code paths. The
`pg` pool was wrapped so that every statement the production code sends is timed and
captured individually.

Fixtures were generated with the harness generator at a fixed seed:

```sh
node scripts/gen-gpkg.mjs --size <N> --seed 42 --outdir <dir>
```

That produces a site with `N` habitat parcels exactly tiling an irregular ~400 m-radius
red line boundary, plus `N/3` hedgerows, `N/16` watercourses and `N/2` urban trees — so a
5,000-parcel file carries 9,500 features in total and is 5.2 MB on disk. Ten flawed
fixtures (`--flaw overlapping-parcels`, `parcel-outside-redline`, …) were generated for
the equivalence testing in §7.

A caveat on the model: the site *area* is held constant while the parcel count rises, so
larger fixtures mean smaller, more crowded parcels (105 m² average at 5,000, ~5 vertices
each). A real 5,000-parcel site would more likely be a larger site with similar-sized
parcels. Crowding raises the neighbour count per parcel slightly, so if anything these
numbers are mildly pessimistic for the overlap check and neutral elsewhere.

**Host:** 2 vCPU, 4 GB RAM, aarch64 Linux, Node 24.14.1. PostgreSQL 16 / PostGIS 3.5,
default `shared_buffers` (128 MB) and `work_mem` (4 MB). Two vCPUs matters: the database
saturates at concurrency 2 (see §8).

---

## 3. The environment caveat that changes every number

`bng-metric-backend/compose.yml` pins:

```yaml
postgres:
  image: postgis/postgis:16-3.5
```

That tag has **no arm64 manifest**. On an arm64 host Docker pulls the amd64 image and
runs it under QEMU emulation. Confirmed directly:

```
$ docker inspect postgis/postgis:16-3.5 --format '{{.Architecture}}'
amd64
$ docker exec bng-metric-backend-postgres-1 uname -m
x86_64          # …on an aarch64 host
```

The emulation penalty was measured on workloads with no GeoPackage involvement at all:

| Workload | Emulated (current image) | Native (arm64 image) | Factor |
| --- | --- | --- | --- |
| `count(*)` over 20 M rows | 23,062 ms | 1,321 ms | 17× |
| 2 M `md5()` calls | 9,058 ms | 1,283 ms | 7× |
| 20 k `ST_Buffer` + `ST_Area` | 37.3 ms | 1.7 ms | 21× |

So the ~10× spread between the two columns of the table in §4 is **QEMU, not PostGIS
version and not GEOS version**. The native image used for comparison
(`imresamu/postgis:16-3.5`, the multi-arch community build) happens to carry newer
GEOS (3.11.1 vs 3.9.0) and PROJ, which is worth having, but it is not what produced the
difference.

Two consequences:

1. **Every local performance observation on an arm64 dev machine is inflated ~10×.** If
   the `perfEvidence` figures behind the "System Performance Issues" spike (BMD-869) were
   gathered on such a machine, they overstate the problem by an order of magnitude and
   should be re-taken.
2. **The fix is one line** — pin a multi-arch image so arm64 developers run natively.
   `imresamu/postgis:16-3.5` and `ghcr.io/baosystems/postgis:16-3.5` both publish arm64
   and both were verified working against this codebase in this investigation.

Production on CDP runs on amd64 natively, so the **native column is the one that
represents production**.

---

## 4. The scaling curve

Median of three runs per size. All times in milliseconds. `parse` is the synchronous
better-sqlite3 read (blocks the Node event loop); `materialise` + `index` + `check` are
the three statements `validateGeoPackageLayersPostgis` issues; `sizing` is the separate
`calculateHabitatSizes` round trip.

| Parcels | Features | File KB | parse | materialise | index | **check** | **PostGIS total** | sizing | ms/parcel | *check (emulated)* |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 50 | 95 | 132 | 3.0 | 2.3 | 0.7 | 12.2 | **16.9** | 1.5 | 0.34 | *164* |
| 100 | 190 | 180 | 3.3 | 3.2 | 0.8 | 18.4 | **23.8** | 1.4 | 0.24 | *272* |
| 250 | 475 | 332 | 5.6 | 7.8 | 1.7 | 43.0 | **54.9** | 2.9 | 0.22 | *600* |
| 500 | 950 | 588 | 9.2 | 14.5 | 2.9 | 74.0 | **95.2** | 6.5 | 0.19 | *1,128* |
| 750 | 1,426 | 848 | 12.2 | 19.6 | 3.8 | 109.6 | **144.3** | 7.9 | 0.19 | *1,671* |
| 1,000 | 1,900 | 1,096 | 14.3 | 32.1 | 4.4 | 145.2 | **184.3** | 9.8 | 0.18 | *2,162* |
| 1,500 | 2,851 | 1,608 | 18.7 | 38.5 | 5.4 | 234.7 | **284.4** | 17.1 | 0.19 | *3,297* |
| 2,000 | 3,800 | 2,116 | 24.5 | 56.0 | 6.5 | 332.9 | **406.0** | 22.7 | 0.20 | *4,810* |
| 3,000 | 5,701 | 3,136 | 32.6 | 105.4 | 8.7 | 485.3 | **615.9** | 29.5 | 0.21 | *6,958* |
| **5,000** | **9,500** | **5,184** | **57.3** | **197.3** | **13.5** | **887.0** | **1,123.6** | **49.9** | **0.22** | ***11,901*** |
| 7,500 | 14,251 | 7,728 | 88.6 | 303.1 | 24.0 | 1,315.3 | **1,697.1** | 96.5 | 0.23 | *18,882* |
| 10,000 | 19,000 | 10,276 | 127.1 | 411.7 | 34.3 | 2,319.8 | **2,824.3** | 124.0 | 0.28 | *31,134* |

Reading the curve:

- **It is linear, not quadratic.** Doubling 2,500 → 5,000 costs 2.2×; 5,000 → 10,000
  costs 2.5×. The mild superlinearity at the top comes almost entirely from the parcel
  overlap self-join (see §5), which grows with both the number of parcels and the number
  of neighbours each parcel has.
- **The small-file cost is a floor, not a slope.** At 50 parcels 12 ms of the 17 ms is
  fixed overhead: the query is a 200-line, 15-branch statement that PostgreSQL re-plans
  on every call. Planning alone was measured at 172 ms (native) for the 5,000-parcel
  parameter set — see §6, experiment E6.
- **File size is not the limit.** At ~1.05 KB per parcel the 100 MB
  `UPLOAD_MAX_FILE_SIZE_BYTES` cap corresponds to about **95,000 parcels**. Nothing in
  the upload path bounds parcel count.

### Full request cost at 5,000 parcels

| Stage | Native | Emulated DB | Blocks the Node event loop? |
| --- | ---: | ---: | --- |
| GeoPackage read + format gate (better-sqlite3) | 57 ms | 57 ms | **Yes** |
| PostGIS validate (materialise + index + check) | 1,124 ms | 13,400 ms | No |
| Habitat sizing (second PostGIS round trip) | 50 ms | 815 ms | No |
| Extract document | 48 ms | 48 ms | **Yes** |
| Enrich with engine units | 50 ms | 50 ms | **Yes** |
| Persist 9,499 geometry rows (batched 500) | 94 ms | — | No |
| Persist the 17.3 MB JSONB project document | 178–357 ms | — | No |
| **Total server compute** | **≈1.6 s** | **≈14.5 s** | |

Plus the S3 download of the 5.2 MB file and the CDP-uploader readiness wait, neither of
which scale with parcel count in the same way.

**The 17.3 MB JSONB document deserves separate attention.** It is not a validation
problem, but at 5,000 parcels it is the largest single artefact the system creates:
178 ms to insert, 357 ms to `jsonb_set`, 229 ms just to read back — and it is read by the
project list and project summary pages on every visit. At 1,000 parcels it is 3.5 MB; at
10,000 it would be ~35 MB. This is likely to become the binding constraint on large
sites before validation does.

---

## 5. Where the time goes inside the check query

Each of the fifteen error checks was run in isolation against the same materialised data,
sharing the same CTE prefix. "Marginal" is the cost that check adds over the prefix.

Native PostGIS, 5,000 parcels (prefix = 238 ms; total check = 887 ms):

| Check | Isolated | **Marginal** |
| --- | ---: | ---: |
| *CTE prefix — parse + reproject all 9,500 features, cast all properties to JSONB* | 238 ms | *(baseline)* |
| `PARCEL_OVERLAPS` | 485 ms | **246 ms** |
| `SLIVERS_OUTSIDE_REDLINE` | 450 ms | **212 ms** |
| `AREA_PARCELS_OUTSIDE_REDLINE` | 339 ms | **101 ms** |
| `HEDGEROWS_OUTSIDE_REDLINE` | 274 ms | 36 ms |
| `WATERCOURSES_OUTSIDE_REDLINE` | 253 ms | 14 ms |
| `IGGIS_OUTSIDE_REDLINE` | 250 ms | 12 ms |
| `NO_HABITAT_AREAS` | 249 ms | 10 ms |
| `AREA_PARCELS_INVALID_GEOMETRY` | 247 ms | 9 ms |
| `TREES_OUTSIDE_REDLINE` | 247 ms | 9 ms |
| `AREA_PARCELS_TOO_SMALL` | 246 ms | 8 ms |
| `AREA_SUM_MISMATCH` | 245 ms | 7 ms |
| remaining redline checks | ~238 ms | ≤2 ms each |

Four things account for essentially all of it — three of them structural rather than
algorithmic.

### 5.1 Every geometry is parsed and reprojected four times per upload

`EXPLAIN (ANALYZE)` on the 5,000-parcel statement shows the `features_in` CTE
materialising at 1,486 ms emulated / ~238 ms native — that is
`ST_GeomFromGeoJSON` + `ST_SetSRID` + `ST_Transform` over all 9,500 features. But the
area parcels have *already* been parsed and reprojected by `MATERIALISE_AREAS_QUERY`, the
statement immediately before it. Counting the whole upload:

| Pass | Statement | Layers |
| --- | --- | --- |
| 1 | `MATERIALISE_AREAS_QUERY` (`postgis/index.js`) | areas |
| 2 | `CHECK_QUERY` → `features_in` (`postgis/index.js`) | all six |
| 3 | `CALCULATE_HABITAT_SIZES_QUERY` (`calculate-habitat-sizes.js`) | areas, hedgerows, watercourses |
| 4 | `transformToBngMultiGeomSql` (`persist-upload.js`) | all, batched 500 at a time |

Four `ST_GeomFromGeoJSON` + `ST_Transform` passes over the same geometry. The comment on
`materialiseIndexedAreas` explains *why* the temp table exists (a home for the GiST
index) but nothing then reuses it for anything except the overlap join.

### 5.2 Nine megabytes of feature properties are shipped to PostgreSQL to read three keys

`buildArrays` in `postgis/index.js` sends `JSON.stringify(feature.properties)` for every
feature, and `features_in` casts all of it with `props::jsonb`. At 5,000 parcels the
parameter payload is **10.9 MB, of which 9.2 MB is properties and only 1.7 MB is
geometry** — ~1.85 KB of attribute JSON per feature, fully parsed into JSONB on the
server.

Everything that payload is used for is this, in `featureRefSql` and `fidColumnSql`:

```sql
COALESCE(props->>'Parcel Ref', props->>'Tree Ref', props->>'Baseline Parcel Ref')
props->>'fid'
```

Two scalar strings per feature, needed only to name offending features in error messages
that fire on a small minority of uploads. The other ~1.8 KB per feature — survey dates,
company names, base map, comments, condition and significance columns — crosses the wire
and is parsed into a JSONB tree for nothing.

### 5.3 `SLIVERS_OUTSIDE_REDLINE` dissolves all 5,000 parcels to find something the per-parcel check already found

`c_slivers_outside` computes `ST_Union(ST_MakeValid(geom))` over every parcel, then
subtracts the red line. In the plan that single `Aggregate` node is **2,852 ms of the
emulated 11,900 ms** — the second most expensive node in the statement.

But `ST_Difference(⋃Pᵢ, R)` and `⋃ ST_Difference(Pᵢ, R)` are the same geometry, and
`c_areas_outside` already computes `ST_Difference(Pᵢ, R)` per parcel one CTE later. On a
valid file both are empty. The union of 5,000 polygons is being built to derive something
that could be assembled from a rowset that is empty in the healthy case.

### 5.4 Repeated `ST_MakeValid`, and `ST_Area(ST_MakeValid(…))` computed twice per row

`ST_MakeValid` is applied to the same `areas` geometries in `parcels_union`,
`c_areas_outside`, `c_areas_too_small` and — separately — inside `areas_g`. In
`c_areas_too_small` the whole expression `ST_Area(ST_MakeValid(geom))` appears in both the
`SELECT` list and the `WHERE` clause, so PostgreSQL evaluates it twice for every parcel.

### 5.5 The overlap self-join is the one genuinely irreducible cost

At 5,000 parcels the join finds **11,764 candidate pairs** (≈2.4 per parcel — the expected
count for a planar tiling). The GiST index does its job: candidate generation is 100 ms
native. The expense is the confirmation step —
`ST_Area(ST_Intersection(a, b, 0.001)) > 0.5` — which runs a fixed-precision overlay on
every one of those pairs, including the ~11,700 pairs that merely share an edge.

This is the check that resists optimisation; §6 records four attempts that did not work.

---

## 6. Optimisation experiments (measured)

Each candidate was measured against the current formulation on the same data in the same
session. Native PostGIS, 5,000 parcels.

| # | Experiment | Current | Candidate | Verdict |
| --- | --- | ---: | ---: | --- |
| E1 | Input encoding: GeoJSON text vs WKB hex, parse + reproject 5,000 parcels | 32.9 ms | **9.5 ms** | **3.5× faster** |
| E2 | `AREA_PARCELS_TOO_SMALL` reading the already-valid temp table instead of re-parsing | 31.8 ms | **1.3 ms** | **24× faster** |
| E4 | `AREA_PARCELS_OUTSIDE_REDLINE` reusing `areas_g` + `ST_CoveredBy` pre-filter | 95.4 ms | **24.8 ms** | **3.8× faster** |
| E5 | `SLIVERS_OUTSIDE_REDLINE` unioning per-parcel escapes instead of all parcels | 227.9 ms | **28.5 ms** | **8× faster** |
| E6 | Planning cost of the 200-line statement (`EXPLAIN`, no execution) | — | **172 ms** | worth a prepared statement |
| F2 | Overlap: drop the `gridSize` argument from `ST_Intersection` | 302 ms | 259 ms | 14%, at the cost of the robustness guarantee — **not worth it** |
| F3 | Overlap: `NOT ST_Touches(a, b)` pre-filter before the area test | 302 ms | 304 ms | **no gain** |
| E3b | Overlap: `ST_Relate(a, b, 'T********')` interior pre-filter | 302 ms | 294 ms | **no gain** — relate costs as much as the overlay |
| F4 | Overlap: pre-shrink every parcel by 5 cm, join the shrunk geometries | 302 ms | 185 ms + 54 ms build = 239 ms | 21%, but changes semantics on thin parcels — **not recommended** |
| F6 | Overlap: force parallel workers | 302 ms | 309 ms | **no gain** (2 vCPU host) |

Notes on the negative results, because they are as useful as the positive ones:

- **The overlap check cannot be pre-filtered by a topological predicate.** `ST_Relate`,
  `ST_Touches` and `ST_Overlaps` all build the same DE-9IM intersection matrix that the
  overlay itself needs; substituting one for the other buys nothing. The tolerance-based
  area test in the current code is the right design *and* close to the cheapest correct
  one — the comments in `postgis/index.js` explaining why a Boolean predicate was rejected
  are still correct.
- **Parallelism does not help** on this host, and would not help much on a
  2-vCPU database instance either. The work is one nested loop over a small table; the
  planner is right to keep it serial.
- **`gridSize` is worth its 14%.** Dropping it would reintroduce exactly the
  floating-point ghost slivers the parameter was added to eliminate.

---

## 7. A restructured prototype: 1.8–2× faster, same answers

`scripts/opt-query.mjs` implements the changes that *did* work, as a complete replacement
for the two statements plus the sizing query. Its shape:

**One load statement for every layer**, parsing and reprojecting once and repairing once,
into a temp table carrying both raw and repaired geometry plus the two identifier
strings — instead of the whole properties blob:

```sql
CREATE TEMP TABLE feat_all ON COMMIT DROP AS
SELECT layer, idx, fid, feature_ref, geom, ST_MakeValid(geom) AS geom_valid
FROM (
  SELECT layer, idx, fid, feature_ref,
         ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(g), srid), 27700) AS geom
  FROM unnest($1::text[], $2::int[], $3::text[], $4::text[], $5::text[], $6::int[])
    AS t(layer, idx, fid, feature_ref, g, srid)
) s;
CREATE INDEX ON feat_all USING gist (geom_valid) WHERE layer = 'areas';
ANALYZE feat_all;
```

**One escape rowset feeding both parcel-outside errors**, gated so that parcels the red
line already covers never reach the overlay:

```sql
c_escapes AS (
  SELECT feat.idx, feat.fid, feat.feature_ref,
         ST_Difference(feat.geom_valid, redl.geom, 0.001) AS escape
  FROM areas feat CROSS JOIN redline_union redl
  WHERE redl.geom IS NOT NULL AND NOT ST_CoveredBy(feat.geom_valid, redl.geom)
),
c_areas_outside  AS (SELECT … FROM c_escapes WHERE ST_Area(escape) > 0.5),
c_slivers_outside AS (SELECT … FROM (SELECT (ST_Dump(ST_Union(escape))).geom … FROM c_escapes) …)
```

**The same `ST_CoveredBy` gate on the linear and IGGI layers**, and **sizing read off the
loaded table** rather than issued as a fourth parse pass.

### Measured, three runs per size

| Parcels | Current (validate + sizing) | Prototype total | load | index | check | sizing | **Speed-up** |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 250 | 58.1 ms | **35.0 ms** | 4.3 | 8.0 | 20.7 | 0.6 | **1.66×** |
| 1,000 | 200.5 ms | **116.2 ms** | 16.2 | 23.9 | 65.6 | 1.2 | **1.73×** |
| 2,000 | 436.9 ms | **247.9 ms** | 33.5 | 41.5 | 165.1 | 2.0 | **1.76×** |
| 5,000 | 1,160.8 ms | **587.5 ms** | 77.3 | 105.7 | 394.4 | 5.6 | **1.98×** |
| 10,000 | 2,983.0 ms | **1,656.6 ms** | 191.8 | 209.1 | 1,238.6 | 9.2 | **1.80×** |

Sizing effectively disappears: 47 ms → 5.6 ms at 5,000 parcels, because it stops being a
separate parse of the same geometry.

### It returns the same answers

Run against ten deliberately flawed fixtures from the harness generator plus three clean
files. Error **codes** and error **counts** were compared against the current
implementation:

| Fixture | Errors returned (identical in both) |
| --- | --- |
| `area-sum-mismatch` | `AREA_SUM_MISMATCH` |
| `bowtie-parcel` | `AREA_PARCELS_INVALID_GEOMETRY` (×1), `AREA_SUM_MISMATCH` |
| `overlapping-parcels` | `PARCEL_OVERLAPS` (×1), `AREA_SUM_MISMATCH` |
| `parcel-outside-redline` | `AREA_PARCELS_OUTSIDE_REDLINE` (×1), `SLIVERS_OUTSIDE_REDLINE` (×1), `AREA_SUM_MISMATCH` |
| `parcel-too-small` | `AREA_PARCELS_TOO_SMALL` (×1), `AREA_SUM_MISMATCH` |
| `self-intersecting-redline` | `REDLINE_INVALID_GEOMETRY`, `AREA_PARCELS_OUTSIDE_REDLINE` (×1), `SLIVERS_OUTSIDE_REDLINE` (×1), `AREA_SUM_MISMATCH` |
| `hedgerow-outside` / `watercourse-outside` / `tree-outside` | respective `*_OUTSIDE_REDLINE` (×1), `AREA_SUM_MISMATCH` |
| `tiny-gap` | *(none — correctly accepted)* |
| clean 50 / 250 / 1,000 parcels | *(none)* |

**13 of 13 match.** The prototype is a spike, not production code: it has no tests of its
own, does not carry the explanatory comments the current module rightly has, and the
`ST_CoveredBy` gates would need their own regression cases for boundary-grazing features
before this could ship.

### What is left after the restructure

At 5,000 parcels the prototype's 394 ms check breaks down as: **`PARCEL_OVERLAPS`
292 ms (74%)**, `SLIVERS_OUTSIDE_REDLINE` 27 ms, `AREA_PARCELS_OUTSIDE_REDLINE` 27 ms,
`REDLINE_OUTSIDE_ENGLAND` 18 ms, everything else ≤10 ms. At 10,000 parcels the overlap
check is 716 ms of 1,239 ms.

So after the easy wins, **the parcel overlap check is the whole remaining problem**, and
§6 shows it does not yield to reformulation. It is a fair cost for the check it performs.

One honest wrinkle: the prototype's overlap check is ~46 ms *slower* in isolation than the
current one (292 ms vs 246 ms at 5,000 parcels), because a partial GiST index over a
mixed-layer table is less efficient than the current dedicated `areas_g` table. Everything
else falls by ~540 ms, so the prototype still wins by 2×, but keeping a dedicated area
table alongside the shared load table would recover that 46 ms — a refinement, not a
blocker.

---

## 8. Concurrency: the database saturates at two requests

Repeated 1,000-parcel validations, all against the same pool:

| Concurrency | Wall clock | Per-request latency | Throughput |
| ---: | ---: | --- | ---: |
| 1 | 202 ms | 202 ms | 4.95/s |
| 2 | 228 ms | 214, 228 ms | 8.77/s |
| 4 | 535 ms | 455–535 ms | 7.48/s |
| 8 | 975 ms | 733–975 ms | 8.21/s |

Throughput flattens at the host's two vCPUs; beyond that, added concurrency shows up
purely as latency. Validation is CPU-bound *inside PostgreSQL*, so the sizing of the
database instance — not the backend task — sets the ceiling. Two concurrent
5,000-parcel uploads on a 2-vCPU instance would each take about twice as long as one.

---

## 9. Should any work move off the database?

**No computation should move to Node.** PostGIS is doing geometry work in the one place
where it is fast, indexed and numerically robust; the JavaScript side accounts for
155 ms of a ~1,600 ms request at 5,000 parcels (57 ms parse + 48 ms extract + 50 ms
enrich). Reimplementing overlay or containment in Turf would be slower and would
reintroduce the robustness problems the `gridSize` and tolerance work exists to solve.

**Three things should move, but not off the database:**

1. **Off the request handler.** `handleReadyUpload` in
   `frontend/src/server/common/helpers/habitat-upload-received-controller.js` calls the
   backend's validate endpoint synchronously inside a page request, through a Wreck client
   with `BACKEND_TIMEOUT_MS` defaulting to **10,000 ms**. Meanwhile the same controller
   already has a polling loop — `REFRESH_INTERVAL_SECONDS = 5`, `MAX_WAIT_SECONDS = 120`
   — that it uses while waiting for the CDP uploader. Extending that loop to cover
   validation (validate returns a job id; the page polls until it completes) removes the
   10 s cliff entirely and costs no extra compute. This is the single highest-value
   structural change for large files.
2. **Into the statement that is already running.** Habitat sizing is a separate PostGIS
   round trip that re-parses and re-repairs geometry the validation statement has already
   parsed and repaired. §7 shows it collapsing to ~1% of its cost when read off the loaded
   table.
3. **Out of the wire.** The 9.2 MB of feature properties (§5.2) should never leave Node.

**Two things worth considering but not recommended yet:**

- **Persisting geometry first and validating from the table.** This would collapse passes
  2, 3 and 4 into one, but it means writing rows for files that are about to be rejected,
  and the current design's "nothing is persisted" property — stated explicitly at the top
  of `postgis/index.js` — is a real one worth keeping.
- **Streaming/chunked validation.** Only pays off above ~20,000 parcels and adds
  substantial complexity for a case not yet observed.

---

## 10. Recommendations

Ordered by value per unit of effort. "Gain" is measured at 5,000 parcels unless stated.

| # | Change | Gain | Effort | Risk |
| --- | --- | --- | --- | --- |
| **R1** | **Pin a multi-arch PostGIS image** in `bng-metric-backend/compose.yml` (e.g. `imresamu/postgis:16-3.5`) so arm64 developers stop running an emulated database | **10–20× locally**; makes local perf evidence trustworthy | ~1 line | Very low |
| **R2** | Stop sending feature properties to PostGIS — pass `fid` and `feature_ref` as two text arrays from `buildArrays` | −9.2 MB wire, −85% of the parameter payload | Small | Low |
| **R3** | Load every layer once into the temp table; have the check query *and* `calculateHabitatSizes` read from it | ~2 of 4 parse passes removed; sizing 47 ms → 6 ms | Medium | Low |
| **R4** | Derive `AREA_PARCELS_OUTSIDE_REDLINE` and `SLIVERS_OUTSIDE_REDLINE` from one `ST_CoveredBy`-gated escape rowset | 228 ms → 29 ms | Medium | Medium — needs boundary-grazing regression cases |
| **R5** | Store `ST_MakeValid(geom)` as a column; stop recomputing `ST_Area(ST_MakeValid(…))` twice per row | 32 ms → 1.3 ms | Small | Very low |
| **R6** | Send WKB rather than GeoJSON (the reader already holds the GPKG blob; it currently decodes to GeoJSON and re-stringifies) | 3.5× on parse; also removes a JS decode + stringify per feature | Medium | Low |
| **R7** | Issue the check query as a named/prepared statement so PostgreSQL stops re-planning 200 lines per upload | ~170 ms per upload, size-independent | Small | Low |
| **R8** | **Make validation asynchronous** — return a job id, let the frontend's existing 120 s poll loop wait on it | Removes the 10 s `BACKEND_TIMEOUT_MS` cliff | Large | Medium |
| **R9** | Address the JSONB project document size (17.3 MB at 5,000 parcels) — it is read by the project list and summary pages | Out of scope here; likely the next binding constraint | Large | — |
| **R10** | Add a parcel-count guardrail and alarm on the existing `featureCount` metric | Operational visibility before a user finds the limit | Small | Very low |

R2 + R3 + R4 + R5 together are what the §7 prototype measures: **1.8–2.0×**. Adding R6
and R7 should reach **2.5–3×**, putting a 5,000-parcel file at roughly **400–450 ms** of
database time and the whole request comfortably under a second.

R1 is first on the list not because it changes production but because **without it, the
team is optimising against numbers that are ten times wrong**.

---

## Reproducing

Everything lives beside this report.

```sh
# 1. A native PostGIS (skip if your host is amd64)
docker run -d --name pgnew -e POSTGRES_USER=dev -e POSTGRES_PASSWORD=dev \
  -e POSTGRES_DB=bng_metric_backend -p 5433:5432 imresamu/postgis:16-3.5

# 2. Fixtures
for n in 50 100 250 500 750 1000 1500 2000 3000 5000 7500 10000; do
  node scripts/gen-gpkg.mjs --size $n --seed 42 --outdir gpkg/n$n
done
for f in overlapping-parcels parcel-outside-redline parcel-too-small bowtie-parcel \
         area-sum-mismatch tiny-gap self-intersecting-redline hedgerow-outside \
         watercourse-outside tree-outside; do
  node scripts/gen-gpkg.mjs --flaw $f --size 80 --seed 7 --outdir gpkg-bad/$f
done

# 3. Measurements (each writes into evidence/)
PGPORT=5433 REPEATS=3 node --expose-gc scripts/bench.mjs 50,100,250,500,1000,2000,5000,10000
PGPORT=5433 node scripts/profile.mjs 1000,5000     # per-check isolation + EXPLAIN ANALYZE
PGPORT=5433 node scripts/exp.mjs 5000              # optimisation experiments E1–E6
PGPORT=5433 node scripts/exp2.mjs 5000             # overlap-specific experiments F0–F6
PGPORT=5433 node scripts/stage2.mjs 250,1000,2000,5000   # extract / enrich / persist
PGPORT=5433 node scripts/runopt.mjs equiv          # prototype equivalence over 13 fixtures
PGPORT=5433 node scripts/runopt.mjs perf 250,1000,2000,5000,10000
PGPORT=5433 node scripts/conc.mjs                  # concurrency / throughput
```

The scripts import the backend's own modules by absolute path (`/bng-metric-backend/src/…`)
and its `pg` and `better-sqlite3` from its `node_modules`, so they measure the shipping
code with no duplication. Point them at port 5432 to reproduce the emulated figures.

### Evidence files

| File | Contents |
| --- | --- |
| `summary.json` | The §4 scaling table |
| `stage-timings-native.json` | Every raw run behind it |
| `branch-timings-native.json` | The §5 per-check isolation |
| `plan-1000.json`, `plan-5000.json` | `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` output |
| `experiments-geos311.json`, `experiments-geos39.json` | §6 E1–E6, native and emulated |
| `experiments-overlap-*.json` | §6 F0–F6 |
| `optimised-vs-current.json`, `optimised-branches.json` | §7 timings |
| `equivalence.json` | §7 fixture-by-fixture comparison |
| `stage2.json` | Extract / enrich / persist / JSONB document |
| `check-query.sql` | The exact statement the running code sent, captured from the pool |
