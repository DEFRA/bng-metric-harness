/** JS-side extract/enrich cost + a faithful simulation of the persist inserts. */
process.env.ENABLE_PERF_EVIDENCE = 'false'
import fs from 'node:fs'
const BE = '/bng-metric-backend'
const { readGeoPackage } = await import(`${BE}/src/validation/geopackage/geopackage.js`)
const { assignFeatureIds } = await import(`${BE}/src/validation/geopackage/assign-feature-ids.js`)
const { extractHabitatData } = await import(`${BE}/src/validation/geopackage/baseline/extract-habitat-data.js`)
const { enrichBaselineDocumentWithUnits } = await import(`${BE}/src/utilities/enrichment/baseline/enrich-baseline-units.js`)
const { calculateHabitatSizes } = await import(`${BE}/src/services/upload/calculate-habitat-sizes.js`)
const pgMod = await import(`${BE}/node_modules/pg/lib/index.js`)
const { Pool } = pgMod.default
const pool = new Pool({ host:'127.0.0.1', port: Number(process.env.PGPORT ?? 5432), user:'dev', password:'dev', database:'bng_metric_backend', max:2 })
const NOOP = { info(){}, warn(){}, error(){}, debug(){} }
const BATCH = 500
const out = []
for (const n of (process.argv[2] ?? '1000,5000').split(',').map(Number)) {
  const layers = readGeoPackage(`gpkg/parcels-${n}.gpkg`)
  const withIds = assignFeatureIds(layers, new Map())
  const habitatSizes = await calculateHabitatSizes(pool, withIds)
  let t = performance.now()
  const { document, geometries } = extractHabitatData(withIds, { uploadId:'00000000-0000-4000-8000-000000000000', filename:'f.gpkg', fileSize:1, habitatSizes, variant:'baseline' })
  const extractMs = performance.now() - t
  t = performance.now()
  enrichBaselineDocumentWithUnits(document, NOOP, {})
  const enrichMs = performance.now() - t
  const docBytes = Buffer.byteLength(JSON.stringify(document))

  // Persist simulation: same statement shape as persist-upload.js, into a temp table.
  const client = await pool.connect()
  await client.query('BEGIN')
  await client.query(`CREATE TEMP TABLE persist_sim (id uuid, project_id uuid, ref text, geom geometry) ON COMMIT DROP`)
  await client.query(`CREATE TEMP TABLE doc_sim (id uuid primary key, project jsonb) ON COMMIT DROP`)
  const allRows = [...(geometries.habitats ?? []), ...(geometries.hedgerows ?? []), ...(geometries.watercourses ?? []), ...(geometries.trees ?? [])]
  const rows = allRows
  t = performance.now()
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH)
    const vals = []
    const params = []
    batch.forEach((r, j) => {
      const b = j * 3
      params.push(r.featureId, JSON.stringify(r.geometry), r.srid)
      vals.push(`($${b+1}::uuid, '00000000-0000-4000-8000-000000000000'::uuid, null, ST_Multi(ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON($${b+2}), $${b+3}), 27700)))`)
    })
    await client.query(`INSERT INTO persist_sim (id, project_id, ref, geom) VALUES ${vals.join(', ')}`, params)
  }
  const persistGeomMs = performance.now() - t
  const docJson = JSON.stringify(document)
  t = performance.now()
  await client.query(`INSERT INTO doc_sim (id, project) VALUES ('00000000-0000-4000-8000-000000000000'::uuid, $1::jsonb)`, [docJson])
  const docInsertMs = performance.now() - t
  t = performance.now()
  await client.query(`UPDATE doc_sim SET project = jsonb_set(project, '{baseline}', $1::jsonb) WHERE id = '00000000-0000-4000-8000-000000000000'::uuid`, [docJson])
  const docUpdateMs = performance.now() - t
  t = performance.now()
  await client.query(`SELECT project FROM doc_sim WHERE id = '00000000-0000-4000-8000-000000000000'::uuid`)
  const docReadMs = performance.now() - t
  await client.query('ROLLBACK'); client.release()

  const row = { parcels:n, extractMs:+extractMs.toFixed(1), enrichMs:+enrichMs.toFixed(1), docBytes,
                geomRows: rows.length, persistGeomMs:+persistGeomMs.toFixed(1),
                docInsertMs:+docInsertMs.toFixed(1), docUpdateMs:+docUpdateMs.toFixed(1), docReadMs:+docReadMs.toFixed(1),
                geometryLayers: Object.fromEntries(Object.entries(geometries).map(([k,v])=>[k, Array.isArray(v)?v.length:1])) }
  out.push(row); console.log(JSON.stringify(row))
}
fs.writeFileSync('results/stage2.json', JSON.stringify(out, null, 2))
await pool.end()
