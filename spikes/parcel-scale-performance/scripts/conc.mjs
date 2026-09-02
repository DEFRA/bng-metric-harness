process.env.ENABLE_PERF_EVIDENCE='false'
const BE='/bng-metric-backend'
const { readGeoPackage } = await import(`${BE}/src/validation/geopackage/geopackage.js`)
const { validateGeoPackageLayersPostgis } = await import(`${BE}/src/validation/geopackage/postgis/index.js`)
const pgMod = await import(`${BE}/node_modules/pg/lib/index.js`); const { Pool } = pgMod.default
const pool = new Pool({ host:'127.0.0.1', port:Number(process.env.PGPORT ?? 5433), user:'dev', password:'dev', database:'bng_metric_backend', max:12 })
const layers = readGeoPackage('gpkg/parcels-1000.gpkg')
for (const c of [1,2,4,8]) {
  await Promise.all(Array.from({length:2},()=>validateGeoPackageLayersPostgis(pool, layers))) // warm
  const s = performance.now()
  const times = await Promise.all(Array.from({length:c}, async () => { const t=performance.now(); await validateGeoPackageLayersPostgis(pool, layers); return +(performance.now()-t).toFixed(0) }))
  const wall = +(performance.now()-s).toFixed(0)
  console.log(`concurrency=${c} wall=${wall}ms per-request=[${times.join(', ')}] throughput=${(c/(wall/1000)).toFixed(2)}/s`)
}
await pool.end()
