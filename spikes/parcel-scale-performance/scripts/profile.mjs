/**
 * Deep profile of the single baseline CHECK_QUERY: EXPLAIN ANALYZE of the whole
 * statement, plus isolated timings for each UNION ALL branch (one per check)
 * so the cost can be attributed to individual validation rules.
 */
process.env.ENABLE_PERF_EVIDENCE = 'false'
import fs from 'node:fs'

const BE = '/bng-metric-backend'
const { readGeoPackage } = await import(`${BE}/src/validation/geopackage/geopackage.js`)
const { materialiseIndexedAreas } = await import(`${BE}/src/validation/geopackage/postgis/index.js`)
const pgMod = await import(`${BE}/node_modules/pg/lib/index.js`)
const { Pool } = pgMod.default

const englandGeoJson = JSON.parse(fs.readFileSync(`${BE}/src/validation/reference/england.geojson`, 'utf8'))
const ENGLAND = JSON.stringify(englandGeoJson.geometry)

const full = fs.readFileSync('results/check-query.sql', 'utf8')
const marker = "\nSELECT 'NO_REDLINE'"
const cut = full.indexOf(marker)
const withBlock = full.slice(0, cut)          // ends with the last CTE + newline
const body = full.slice(cut + 1)
const branches = body.split(/\nUNION ALL\n/)
const branchName = (b) => (b.match(/SELECT '([A-Z_]+)'/) ?? [, '?'])[1]

const sizes = process.argv[2] ? process.argv[2].split(',').map(Number) : [1000, 5000]
const pool = new Pool({ host: '127.0.0.1', port: Number(process.env.PGPORT ?? 5432), user: 'dev', password: 'dev', database: 'bng_metric_backend', max: 2 })

const out = {}
for (const n of sizes) {
  const layers = readGeoPackage(`gpkg/parcels-${n}.gpkg`)
  const client = await pool.connect()
  await client.query('BEGIN')
  const { layerNames, idxs, props, geoms, srids } = await materialiseIndexedAreas(client, layers)
  const params = [layerNames, idxs, props, geoms, srids, ENGLAND]

  // 1. Whole-statement EXPLAIN ANALYZE
  const plan = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${full}`, params)
  fs.writeFileSync(`results/plan-${n}.json`, JSON.stringify(plan.rows[0]['QUERY PLAN'], null, 2))

  // 2. Per-branch isolated timing (same CTE prefix, one output branch)
  const perBranch = []
  for (const b of branches) {
    const sql = withBlock + b
    const t = performance.now()
    let rows = 0
    try { rows = (await client.query(sql, params)).rowCount } catch (e) { perBranch.push({ check: branchName(b), error: e.message }); continue }
    perBranch.push({ check: branchName(b), ms: +(performance.now() - t).toFixed(1), rows })
  }
  // 3. Baseline: the CTE prefix cost alone (parse+transform every feature, no checks)
  const bare = withBlock + "SELECT count(*) AS code, '{}'::jsonb AS payload FROM features_in"
  const t0 = performance.now()
  await client.query(bare, params)
  const bareMs = +(performance.now() - t0).toFixed(1)

  // 4. Cost of just parsing + reprojecting (no union/makevalid)
  const tParseOnly = performance.now()
  await client.query(`SELECT count(*) FROM unnest($1::text[],$2::int[],$3::text[],$4::text[],$5::int[]) AS t(layer,idx,props,g,srid) WHERE ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(g), srid),27700) IS NOT NULL`, params.slice(0,5))
  const parseOnlyMs = +(performance.now() - tParseOnly).toFixed(1)

  await client.query('ROLLBACK')
  client.release()
  out[n] = { bareMs, parseOnlyMs, perBranch }
  console.log(n, JSON.stringify(out[n], null, 1))
}
fs.writeFileSync('results/branch-timings.json', JSON.stringify(out, null, 2))
await pool.end()
