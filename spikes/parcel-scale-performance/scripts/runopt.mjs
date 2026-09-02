process.env.ENABLE_PERF_EVIDENCE = 'false'
import fs from 'node:fs'
import { LOAD_QUERY, INDEX_QUERY, CHECK_QUERY, SIZING_QUERY, buildArrays } from './opt-query.mjs'
const BE = '/bng-metric-backend'
const { readGeoPackage } = await import(`${BE}/src/validation/geopackage/geopackage.js`)
const { validateGeoPackageLayersPostgis } = await import(`${BE}/src/validation/geopackage/postgis/index.js`)
const { calculateHabitatSizes } = await import(`${BE}/src/services/upload/calculate-habitat-sizes.js`)
const pgMod = await import(`${BE}/node_modules/pg/lib/index.js`)
const { Pool } = pgMod.default
const pool = new Pool({ host:'127.0.0.1', port:Number(process.env.PGPORT ?? 5433), user:'dev', password:'dev', database:'bng_metric_backend', max:2 })
const ENGLAND = JSON.stringify(JSON.parse(fs.readFileSync(`${BE}/src/validation/reference/england.geojson`,'utf8')).geometry)

async function runOptimised(layers) {
  const a = buildArrays(layers)
  const c = await pool.connect()
  const t = {}
  try {
    await c.query('BEGIN')
    let s = performance.now()
    await c.query(LOAD_QUERY, [a.layerNames, a.idxs, a.fids, a.refs, a.geoms, a.srids])
    t.loadMs = performance.now() - s
    s = performance.now(); await c.query(INDEX_QUERY); t.indexMs = performance.now() - s
    s = performance.now(); const { rows } = await c.query(CHECK_QUERY, [ENGLAND]); t.checkMs = performance.now() - s
    s = performance.now(); await c.query(SIZING_QUERY); t.sizingMs = performance.now() - s
    await c.query('COMMIT')
    t.codes = rows.map(r => r.code).sort()
    t.payloads = Object.fromEntries(rows.map(r => [r.code, r.payload]))
  } finally { c.release() }
  return t
}

const mode = process.argv[2] ?? 'perf'
if (mode === 'perf') {
  const out = []
  for (const n of (process.argv[3] ?? '250,1000,2000,5000,10000').split(',').map(Number)) {
    const layers = readGeoPackage(`gpkg/parcels-${n}.gpkg`)
    let cur, opt
    for (let i = 0; i < 3; i++) {
      let s = performance.now(); await validateGeoPackageLayersPostgis(pool, layers); const curMs = performance.now() - s
      s = performance.now(); const o = await runOptimised(layers); const optTotal = performance.now() - s
      s = performance.now(); await calculateHabitatSizes(pool, layers); const curSizing = performance.now() - s
      cur = { totalMs: +curMs.toFixed(1), sizingMs: +curSizing.toFixed(1) }
      opt = { totalMs: +optTotal.toFixed(1), loadMs: +o.loadMs.toFixed(1), indexMs: +o.indexMs.toFixed(1), checkMs: +o.checkMs.toFixed(1), sizingMs: +o.sizingMs.toFixed(1) }
    }
    const row = { parcels: n,
      current: { validateMs: cur.totalMs, sizingMs: cur.sizingMs, totalMs: +(cur.totalMs + cur.sizingMs).toFixed(1) },
      optimised: { ...opt },
      speedup: +(((cur.totalMs + cur.sizingMs) / opt.totalMs)).toFixed(2) }
    out.push(row); console.log(JSON.stringify(row))
  }
  fs.writeFileSync('results/optimised-vs-current.json', JSON.stringify(out, null, 2))
} else {
  // equivalence over the flawed fixtures + the clean ladder
  const files = []
  for (const d of fs.readdirSync('gpkg-bad')) for (const f of fs.readdirSync(`gpkg-bad/${d}`)) files.push([d, `gpkg-bad/${d}/${f}`])
  for (const n of [50, 250, 1000]) files.push([`clean-${n}`, `gpkg/parcels-${n}.gpkg`])
  const rows = []
  for (const [name, file] of files) {
    const layers = readGeoPackage(file)
    const current = await validateGeoPackageLayersPostgis(pool, layers)
    const o = await runOptimised(layers)
    const curCodes = current.errors.map(e => e.code).sort()
    const curCounts = Object.fromEntries(current.errors.filter(e => e.details?.count != null).map(e => [e.code, e.details.count]))
    const optCounts = Object.fromEntries(Object.entries(o.payloads).filter(([, p]) => p?.count != null).map(([k, p]) => [k, p.count]))
    const same = JSON.stringify(curCodes) === JSON.stringify(o.codes) && JSON.stringify(curCounts) === JSON.stringify(optCounts)
    rows.push({ fixture: name, current: curCodes, optimised: o.codes, curCounts, optCounts, match: same })
    console.log(same ? 'MATCH  ' : 'DIFFER ', name.padEnd(28), JSON.stringify(curCodes), JSON.stringify(curCounts), same ? '' : ('!= ' + JSON.stringify(o.codes) + JSON.stringify(optCounts)))
  }
  fs.writeFileSync('results/equivalence.json', JSON.stringify(rows, null, 2))
}
await pool.end()
