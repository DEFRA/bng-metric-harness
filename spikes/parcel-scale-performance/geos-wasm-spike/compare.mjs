process.env.ENABLE_PERF_EVIDENCE = 'false'
import fs from 'node:fs'
const BE = '/bng-metric-backend'
const { validateWithGeos } = await import('./validate-geos.mjs')
const { readGeoPackage } = await import(`${BE}/src/validation/geopackage/geopackage.js`)
const { validateGeoPackageLayersPostgis } = await import(`${BE}/src/validation/geopackage/postgis/index.js`)
const pgMod = await import(`${BE}/node_modules/pg/lib/index.js`); const { Pool } = pgMod.default
const pool = new Pool({ host:'127.0.0.1', port:5433, user:'dev', password:'dev', database:'bng_metric_backend', max:2 })

const codes = (r) => r.errors.map((e) => e.code).sort()
const counts = (r) => JSON.stringify(Object.fromEntries(r.errors.filter((e) => e.details?.count != null).map((e) => [e.code, e.details.count])))

if (process.argv[2] === 'equiv') {
  const files = []
  for (const d of fs.readdirSync('../gpkg-bad')) for (const f of fs.readdirSync(`../gpkg-bad/${d}`)) files.push([d, `../gpkg-bad/${d}/${f}`])
  for (const n of [50, 250, 1000]) files.push([`clean-${n}`, `../gpkg/parcels-${n}.gpkg`])
  let ok = 0
  for (const [name, file] of files) {
    const layers = readGeoPackage(file)
    const pg = await validateGeoPackageLayersPostgis(pool, layers)
    const js = validateWithGeos(readGeoPackage(file))
    const same = JSON.stringify(codes(pg)) === JSON.stringify(codes(js)) && counts(pg) === counts(js)
    if (same) ok++
    console.log(`${same ? 'MATCH  ' : 'DIFFER '} ${name.padEnd(28)} postgis=${JSON.stringify(codes(pg))}${counts(pg) === '{}' ? '' : ' ' + counts(pg)}` +
      (same ? '' : `\n         geos-wasm=${JSON.stringify(codes(js))} ${counts(js)}`))
  }
  console.log(`\n${ok}/${files.length} match`)
} else {
  console.log('parcels |  PostGIS (validate) | GEOS-WASM in Node | ratio | verdicts')
  for (const n of (process.argv[3] ?? '250,1000,2000,5000,10000').split(',').map(Number)) {
    const layers = readGeoPackage(`../gpkg/parcels-${n}.gpkg`)
    let pgMs = 0, jsMs = 0, pgR, jsR
    for (let i = 0; i < 3; i++) {
      let s = performance.now(); pgR = await validateGeoPackageLayersPostgis(pool, layers); pgMs = performance.now() - s
      s = performance.now(); jsR = validateWithGeos(layers); jsMs = performance.now() - s
    }
    const same = JSON.stringify(codes(pgR)) === JSON.stringify(codes(jsR))
    console.log(`${String(n).padStart(7)} | ${pgMs.toFixed(0).padStart(15)} ms | ${jsMs.toFixed(0).padStart(14)} ms | ${(jsMs / pgMs).toFixed(2).padStart(5)}× | ${same ? 'identical' : 'DIFFER'}`)
  }
}
await pool.end()
