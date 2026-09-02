/**
 * Parcel-scale benchmark for the BNG baseline GeoPackage upload pipeline.
 * Drives the real backend modules (no re-implementation) against the real
 * PostGIS container, and records per-stage timings plus the SQL actually sent.
 */
process.env.ENABLE_PERF_EVIDENCE = 'false'

import fs from 'node:fs'
import path from 'node:path'

const BE = '/bng-metric-backend'
const { validateAndReadGpkgFile } = await import(`${BE}/src/validation/geopackage/geopackage.js`)
const { validateGeoPackageLayersPostgis } = await import(`${BE}/src/validation/geopackage/postgis/index.js`)
const { calculateHabitatSizes } = await import(`${BE}/src/services/upload/calculate-habitat-sizes.js`)
const pgMod = await import(`${BE}/node_modules/pg/lib/index.js`)
const { Pool } = pgMod.default

const GPKG_DIR = path.resolve('gpkg')
const OUT = path.resolve('results')
fs.mkdirSync(OUT, { recursive: true })

const sizes = process.argv[2] ? process.argv[2].split(',').map(Number) : [50,100,250,500,750,1000,1500,2000,3000,5000]
const REPEATS = Number(process.env.REPEATS ?? 2)

const pool = new Pool({
  host: '127.0.0.1', port: Number(process.env.PGPORT ?? 5432), user: 'dev', password: 'dev',
  database: 'bng_metric_backend', max: 4
})

/** Wrap a pool so every client.query is timed and its SQL captured. */
function instrument(pool, sink) {
  return {
    connect: async () => {
      const c = await pool.connect()
      const orig = c.query.bind(c)
      c.query = async (...args) => {
        const t = performance.now()
        const r = await orig(...args)
        sink.push({ sql: args[0], params: args[1], ms: performance.now() - t })
        return r
      }
      return c
    },
    query: (...a) => pool.query(...a)
  }
}

function label(sql) {
  const s = String(sql).trim()
  if (s.startsWith('BEGIN')) return 'begin'
  if (s.startsWith('COMMIT')) return 'commit'
  if (s.startsWith('CREATE TEMP TABLE')) return 'materialise'
  if (s.startsWith('CREATE INDEX')) return 'index+analyze'
  return 'check-query'
}

const rows = []
let capturedCheckSql = null
let capturedCheckParams = null

for (const n of sizes) {
  const file = `${GPKG_DIR}/parcels-${n}.gpkg`
  if (!fs.existsSync(file)) { console.error('missing', file); continue }
  const fileBytes = fs.statSync(file).size

  for (let rep = 0; rep < REPEATS; rep++) {
    global.gc?.()
    const memBefore = process.memoryUsage()

    const tParse = performance.now()
    const gate = validateAndReadGpkgFile(file)
    const parseMs = performance.now() - tParse
    if (!gate.valid) { console.error(`size ${n}: gate rejected`, gate.errors); break }
    const layers = gate.layers
    const featureCount = ['redline','areas','hedgerows','watercourses','iggis','trees']
      .reduce((a, k) => a + (layers[k]?.length ?? 0), 0)

    const sink = []
    const tPg = performance.now()
    const result = await validateGeoPackageLayersPostgis(instrument(pool, sink), layers)
    const postgisMs = performance.now() - tPg

    const check = sink.find((q) => label(q.sql) === 'check-query')
    if (!capturedCheckSql) { capturedCheckSql = check.sql; capturedCheckParams = check.params }

    const tSize = performance.now()
    await calculateHabitatSizes(pool, layers)
    const sizingMs = performance.now() - tSize

    const memAfter = process.memoryUsage()
    const payloadBytes = check.params[3].reduce((a, g) => a + Buffer.byteLength(g), 0)
      + check.params[2].reduce((a, p) => a + Buffer.byteLength(p), 0)

    const row = {
      parcels: n, rep, fileBytes, featureCount,
      areaFeatures: layers.areas.length,
      parseMs: +parseMs.toFixed(1),
      materialiseMs: +sink.filter(q => label(q.sql)==='materialise').reduce((a,q)=>a+q.ms,0).toFixed(1),
      indexMs: +sink.filter(q => label(q.sql)==='index+analyze').reduce((a,q)=>a+q.ms,0).toFixed(1),
      checkMs: +check.ms.toFixed(1),
      postgisTotalMs: +postgisMs.toFixed(1),
      sizingMs: +sizingMs.toFixed(1),
      geojsonPayloadBytes: payloadBytes,
      rssDeltaMb: Math.round((memAfter.rss - memBefore.rss) / 1048576),
      valid: result.valid,
      errorCodes: result.errors.map(e => e.code)
    }
    rows.push(row)
    console.log(JSON.stringify(row))
  }
}

fs.writeFileSync(`${OUT}/stage-timings-${process.env.TAG ?? 'geos39'}.json`, JSON.stringify(rows, null, 2))
if (capturedCheckSql) {
  fs.writeFileSync(`${OUT}/check-query.sql`, capturedCheckSql)
}
await pool.end()
