/**
 * Which mechanism slows the service when several large GeoPackages are validated
 * at once — connections, or the big JSONB documents?
 *
 * Two probes run continuously while N validations are in flight:
 *   LIGHT  a project-list style read that does NOT touch the document body
 *   HEAVY  a project-summary style read that pulls the whole 17 MB document
 *
 * Each probe times pool.connect() and the query SEPARATELY. Waiting to ACQUIRE a
 * connection is starvation; a fast acquire with a slow query is CPU/document
 * contention. On a 2-vCPU host that split is the only clean discriminator.
 */
process.env.ENABLE_PERF_EVIDENCE = 'false'
const BE = '/bng-metric-backend'
const { readGeoPackage } = await import(`${BE}/src/validation/geopackage/geopackage.js`)
const { validateGeoPackageLayersPostgis } = await import(`${BE}/src/validation/geopackage/postgis/index.js`)
const { assignFeatureIds } = await import(`${BE}/src/validation/geopackage/assign-feature-ids.js`)
const { extractHabitatData } = await import(`${BE}/src/validation/geopackage/baseline/extract-habitat-data.js`)
const { calculateHabitatSizes } = await import(`${BE}/src/services/upload/calculate-habitat-sizes.js`)
const pgMod = await import(`${BE}/node_modules/pg/lib/index.js`); const { Pool } = pgMod.default

const PG = { host:'127.0.0.1', port:5433, user:'dev', password:'dev', database:'bng_metric_backend' }
const mkPool = (max) => new Pool({ ...PG, max })
const setup = mkPool(4)
const layers = readGeoPackage('gpkg/parcels-5000.gpkg')

// --- build a realistic projects table: 4 rows carrying a 17 MB baseline doc ---
{
  const withIds = assignFeatureIds(layers, new Map())
  const habitatSizes = await calculateHabitatSizes(setup, withIds)
  const { document } = extractHabitatData(withIds, { uploadId:'00000000-0000-4000-8000-000000000000', filename:'f.gpkg', fileSize:1, habitatSizes, variant:'baseline' })
  const json = JSON.stringify(document)
  await setup.query(`DROP TABLE IF EXISTS projects_sim`)
  await setup.query(`CREATE UNLOGGED TABLE projects_sim (id int primary key, name text, has_baseline bool, project jsonb)`)
  for (let i = 0; i < 4; i++) {
    await setup.query(`INSERT INTO projects_sim VALUES ($1::int, 'Project ' || $1::int::text, true, $2::jsonb)`, [i, json])
  }
  await setup.query(`ANALYZE projects_sim`)
  const sz = await setup.query(`SELECT pg_size_pretty(pg_total_relation_size('projects_sim')) s`)
  console.log(`projects_sim: 4 rows, ${Math.round(Buffer.byteLength(json)/1048576)} MB document each, table ${sz.rows[0].s}\n`)
}

const LIGHT = `SELECT id, name, has_baseline FROM projects_sim ORDER BY name LIMIT 20`
const HEAVY = `SELECT project FROM projects_sim WHERE id = $1`

async function probe (pool, sql, params, out) {
  const t0 = performance.now()
  const c = await pool.connect()
  const acquired = performance.now()
  try { await c.query(sql, params) } finally { c.release() }
  out.push({ acquire: acquired - t0, query: performance.now() - acquired })
}

const pct = (a, p) => a.length ? a.slice().sort((x,y)=>x-y)[Math.min(a.length-1, Math.floor(a.length*p))] : 0
const fmt = (rows, key) => {
  const v = rows.map(r => r[key])
  return `p50 ${String(Math.round(pct(v,.5))).padStart(5)}  p95 ${String(Math.round(pct(v,.95))).padStart(6)}  max ${String(Math.round(Math.max(0,...v))).padStart(6)}`
}

async function scenario (name, { uploads, probePool, uploadPool, seconds = 12 }) {
  const light = [], heavy = []
  let stop = false
  const probers = [
    (async () => { while (!stop) await probe(probePool, LIGHT, [], light) })(),
    (async () => { let i = 0; while (!stop) await probe(probePool, HEAVY, [i++ % 4], heavy) })()
  ]
  const load = []
  let done = 0
  const runner = async () => { while (!stop) { await validateGeoPackageLayersPostgis(uploadPool, layers); done++ } }
  for (let i = 0; i < uploads; i++) load.push(runner())
  await new Promise((r) => setTimeout(r, seconds * 1000))
  stop = true
  await Promise.all([...probers, ...load])
  console.log(`${name}`)
  console.log(`   LIGHT (no document)  n=${String(light.length).padStart(4)}  acquire ${fmt(light,'acquire')}   query ${fmt(light,'query')}`)
  console.log(`   HEAVY (17 MB doc)    n=${String(heavy.length).padStart(4)}  acquire ${fmt(heavy,'acquire')}   query ${fmt(heavy,'query')}`)
  if (uploads) console.log(`   validations completed: ${done} in ${seconds}s`)
  console.log()
}

const shared = mkPool(10)                       // today: one pool for everything
await scenario('IDLE — probes only, no uploads', { uploads: 0, probePool: shared, uploadPool: shared })
await scenario('SHARED POOL (max 10) — 4 concurrent 5,000-parcel validations',  { uploads: 4,  probePool: shared, uploadPool: shared })
await scenario('SHARED POOL (max 10) — 12 concurrent 5,000-parcel validations', { uploads: 12, probePool: shared, uploadPool: shared })
await shared.end()

const appPool = mkPool(10), valPool = mkPool(2)  // S1: validation gets its own small pool
await scenario('SPLIT POOLS (app 10 / validation 2) — 12 concurrent validations', { uploads: 12, probePool: appPool, uploadPool: valPool })
await appPool.end(); await valPool.end()

await setup.query(`DROP TABLE projects_sim`); await setup.end()
