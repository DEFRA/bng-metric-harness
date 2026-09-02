process.env.ENABLE_PERF_EVIDENCE = 'false'
import fs from 'node:fs'
const BE = '/bng-metric-backend'
const { readGeoPackage } = await import(`${BE}/src/validation/geopackage/geopackage.js`)
const { materialiseIndexedAreas } = await import(`${BE}/src/validation/geopackage/postgis/index.js`)
const pgMod = await import(`${BE}/node_modules/pg/lib/index.js`)
const { Pool } = pgMod.default
const pool = new Pool({ host:'127.0.0.1', port: Number(process.env.PGPORT ?? 5432), user:'dev', password:'dev', database:'bng_metric_backend', max:2 })
const GRID = 0.001, TOL = 0.5
const t = async (c, label, sql, p=[]) => { const s=performance.now(); const r=await c.query(sql,p); return { label, ms:+(performance.now()-s).toFixed(1), out:r.rows[0] } }
const res = {}
for (const n of (process.argv[2] ?? '5000').split(',').map(Number)) {
  const layers = readGeoPackage(`gpkg/parcels-${n}.gpkg`)
  const c = await pool.connect(); await c.query('BEGIN')
  await materialiseIndexedAreas(c, layers)
  const R = []
  R.push(await t(c, 'stats: vertices per parcel', `SELECT count(*) n, round(avg(ST_NPoints(geom)),1) avg_pts, max(ST_NPoints(geom)) max_pts, round(avg(ST_Area(geom))::numeric,1) avg_area FROM areas_g`))
  R.push(await t(c, 'F0 candidate pairs (ST_Intersects join)', `SELECT count(*) pairs FROM areas_g a JOIN areas_g b ON a.idx<b.idx AND ST_Intersects(a.geom,b.geom)`))
  R.push(await t(c, 'F0b candidate pairs (bbox && only)', `SELECT count(*) pairs FROM areas_g a JOIN areas_g b ON a.idx<b.idx AND a.geom && b.geom`))
  R.push(await t(c, 'F1 current: ST_Area(ST_Intersection(a,b,grid))', `SELECT count(*) hits FROM areas_g a JOIN areas_g b ON a.idx<b.idx AND ST_Intersects(a.geom,b.geom) WHERE ST_Area(ST_Intersection(a.geom,b.geom,${GRID}))>${TOL}`))
  R.push(await t(c, 'F2 ST_Intersection without gridSize', `SELECT count(*) hits FROM areas_g a JOIN areas_g b ON a.idx<b.idx AND ST_Intersects(a.geom,b.geom) WHERE ST_Area(ST_Intersection(a.geom,b.geom))>${TOL}`))
  R.push(await t(c, 'F3 NOT ST_Touches pre-filter', `SELECT count(*) hits FROM areas_g a JOIN areas_g b ON a.idx<b.idx AND ST_Intersects(a.geom,b.geom) WHERE NOT ST_Touches(a.geom,b.geom) AND ST_Area(ST_Intersection(a.geom,b.geom,${GRID}))>${TOL}`))
  // F4: shrink each parcel once, then join on the shrunk geometries
  const tb = performance.now()
  await c.query(`CREATE TEMP TABLE areas_shrunk ON COMMIT DROP AS SELECT idx, ST_Buffer(geom, -0.05) AS geom FROM areas_g WHERE NOT ST_IsEmpty(ST_Buffer(geom, -0.05))`)
  await c.query(`CREATE INDEX ON areas_shrunk USING gist(geom); ANALYZE areas_shrunk;`)
  const shrinkMs = +(performance.now()-tb).toFixed(1)
  R.push({ label:'F4a build shrunk-parcel table (one negative buffer per parcel)', ms: shrinkMs })
  R.push(await t(c, 'F4b join on shrunk parcels, exact area only on survivors',
    `SELECT count(*) hits FROM areas_shrunk a JOIN areas_shrunk b ON a.idx<b.idx AND ST_Intersects(a.geom,b.geom)
     WHERE ST_Area(ST_Intersection((SELECT g.geom FROM areas_g g WHERE g.idx=a.idx),(SELECT g.geom FROM areas_g g WHERE g.idx=b.idx),${GRID}))>${TOL}`))
  // F5: how much of F1 is the overlay vs the predicate — measure overlay alone on the candidate set
  R.push(await t(c, 'F5 ST_Intersection area on every candidate pair, no threshold',
    `SELECT sum(ST_Area(ST_Intersection(a.geom,b.geom,${GRID}))) s FROM areas_g a JOIN areas_g b ON a.idx<b.idx AND ST_Intersects(a.geom,b.geom)`))
  // F6: parallelism
  await c.query(`SET LOCAL max_parallel_workers_per_gather = 4; SET LOCAL parallel_setup_cost = 0; SET LOCAL parallel_tuple_cost = 0; SET LOCAL min_parallel_table_scan_size = 0;`)
  R.push(await t(c, 'F6 current overlap check with parallel workers forced', `SELECT count(*) hits FROM areas_g a JOIN areas_g b ON a.idx<b.idx AND ST_Intersects(a.geom,b.geom) WHERE ST_Area(ST_Intersection(a.geom,b.geom,${GRID}))>${TOL}`))
  await c.query('ROLLBACK'); c.release()
  res[n]=R; console.log('=== parcels', n); R.forEach(r=>console.log(String(r.ms).padStart(9),'ms', JSON.stringify(r.out??{}), r.label))
}
fs.writeFileSync('results/experiments-overlap.json', JSON.stringify(res,null,2))
await pool.end()
