/**
 * Bulk index build on a per-upload temp table (today) vs incremental inserts
 * into a shared, permanently-indexed table (Option A).
 */
process.env.ENABLE_PERF_EVIDENCE = 'false'
const BE = '/bng-metric-backend'
const { readGeoPackage } = await import(`${BE}/src/validation/geopackage/geopackage.js`)
const pgMod = await import(`${BE}/node_modules/pg/lib/index.js`); const { Pool } = pgMod.default
const pool = new Pool({ host:'127.0.0.1', port:5433, user:'dev', password:'dev', database:'bng_metric_backend', max:4 })
const N = Number(process.argv[2] ?? 5000)
const layers = readGeoPackage(`gpkg/parcels-${N}.gpkg`)
const geoms = layers.areas.map(f => f.geometryJson ?? JSON.stringify(f.nativeGeometry))
const idxs = layers.areas.map((_, i) => i)
const srid = layers.areas[0].nativeSrid
const t = () => performance.now()

// --- Today: temp table + bulk GiST build + ANALYZE, per upload -------------
const c1 = await pool.connect(); await c1.query('BEGIN')
let s = t()
await c1.query(`CREATE TEMP TABLE areas_g ON COMMIT DROP AS
  SELECT idx, ST_MakeValid(ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(g), $3::int),27700)) AS geom
  FROM unnest($1::text[], $2::int[]) AS t(g, idx)`, [geoms, idxs, srid])
const loadMs = t() - s
s = t(); await c1.query(`CREATE INDEX ON areas_g USING gist (geom)`); const buildMs = t() - s
s = t(); await c1.query(`ANALYZE areas_g`); const analyzeMs = t() - s
s = t(); const a = await c1.query(`SELECT count(*) c FROM areas_g a JOIN areas_g b ON a.idx<b.idx AND ST_Intersects(a.geom,b.geom)`); const joinMs = t() - s
await c1.query('ROLLBACK'); c1.release()

// --- Option A: shared unlogged table, index already exists ------------------
const c2 = await pool.connect()
await c2.query(`DROP TABLE IF EXISTS validation_areas`)
await c2.query(`CREATE UNLOGGED TABLE validation_areas (upload_id uuid, idx int, geom geometry(Geometry,27700))`)
await c2.query(`CREATE INDEX ON validation_areas USING gist (upload_id, geom)`)
const UP = '11111111-1111-4111-8111-111111111111'
s = t()
await c2.query(`INSERT INTO validation_areas (upload_id, idx, geom)
  SELECT $4::uuid, idx, ST_MakeValid(ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(g), $3::int),27700))
  FROM unnest($1::text[], $2::int[]) AS t(g, idx)`, [geoms, idxs, srid, UP])
const insertMs = t() - s
s = t(); const b = await c2.query(`SELECT count(*) c FROM validation_areas a JOIN validation_areas b
  ON a.upload_id=$1::uuid AND b.upload_id=$1::uuid AND a.idx<b.idx AND ST_Intersects(a.geom,b.geom)`, [UP])
const joinMs2 = t() - s
s = t(); await c2.query(`DELETE FROM validation_areas WHERE upload_id = $1::uuid`, [UP]); const deleteMs = t() - s

// --- Option A under a dirty table: 8 other uploads' rows already present ----
for (let k = 0; k < 8; k++) {
  await c2.query(`INSERT INTO validation_areas (upload_id, idx, geom)
    SELECT gen_random_uuid(), idx, ST_MakeValid(ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(g), $3::int),27700))
    FROM unnest($1::text[], $2::int[]) AS t(g, idx)`, [geoms, idxs, srid])
}
await c2.query(`ANALYZE validation_areas`)
s = t()
await c2.query(`INSERT INTO validation_areas (upload_id, idx, geom)
  SELECT $4::uuid, idx, ST_MakeValid(ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(g), $3::int),27700))
  FROM unnest($1::text[], $2::int[]) AS t(g, idx)`, [geoms, idxs, srid, UP])
const insertDirtyMs = t() - s
s = t(); const d = await c2.query(`SELECT count(*) c FROM validation_areas a JOIN validation_areas b
  ON a.upload_id=$1::uuid AND b.upload_id=$1::uuid AND a.idx<b.idx AND ST_Intersects(a.geom,b.geom)`, [UP])
const joinDirtyMs = t() - s
const sz = await c2.query(`SELECT pg_size_pretty(pg_total_relation_size('validation_areas')) s, count(*) n FROM validation_areas`)
await c2.query(`DROP TABLE validation_areas`); c2.release()

const r = (x) => x.toFixed(1)
console.log(`parcels=${N}`)
console.log(`TODAY  (temp + bulk build)   load ${r(loadMs)} | index build ${r(buildMs)} | analyze ${r(analyzeMs)} | join ${r(joinMs)}  → prep ${r(buildMs+analyzeMs)} ms, pairs ${a.rows[0].c}`)
console.log(`OPT A  (shared, pre-indexed) insert ${r(insertMs)} | join ${r(joinMs2)} | delete ${r(deleteMs)}   → prep 0 ms, pairs ${b.rows[0].c}`)
console.log(`OPT A  (8 other uploads resident) insert ${r(insertDirtyMs)} | join ${r(joinDirtyMs)}  pairs ${d.rows[0].c} | table ${sz.rows[0].s} / ${sz.rows[0].n} rows`)
console.log(`load-vs-insert delta: ${r(insertMs - loadMs)} ms (insert includes the per-row index maintenance the bulk build does in one pass)`)
await pool.end()
