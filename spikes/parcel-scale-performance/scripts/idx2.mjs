process.env.ENABLE_PERF_EVIDENCE = 'false'
const BE = '/bng-metric-backend'
const { readGeoPackage } = await import(`${BE}/src/validation/geopackage/geopackage.js`)
const pgMod = await import(`${BE}/node_modules/pg/lib/index.js`); const { Pool } = pgMod.default
const pool = new Pool({ host:'127.0.0.1', port:5433, user:'dev', password:'dev', database:'bng_metric_backend', max:2 })
const N = 5000
const layers = readGeoPackage(`gpkg/parcels-${N}.gpkg`)
const geoms = layers.areas.map(f => f.geometryJson ?? JSON.stringify(f.nativeGeometry))
const idxs = layers.areas.map((_, i) => i)
const srid = layers.areas[0].nativeSrid
const t = () => performance.now()
const c = await pool.connect()

async function scenario (name, { keyType, otherUploads, spread, extraIndex }) {
  await c.query(`DROP TABLE IF EXISTS va`)
  await c.query(`CREATE UNLOGGED TABLE va (upload_id ${keyType}, idx int, geom geometry(Geometry,27700))`)
  await c.query(`CREATE INDEX ON va USING gist (upload_id, geom)`)
  if (extraIndex) await c.query(`CREATE INDEX ON va (upload_id)`)
  const key = (n) => keyType === 'uuid'
    ? `'${String(n).padStart(8,'0')}-1111-4111-8111-111111111111'::uuid` : `${n}`
  // other uploads, each shifted `spread` metres east so they are different sites
  for (let k = 1; k <= otherUploads; k++) {
    await c.query(`INSERT INTO va (upload_id, idx, geom)
      SELECT ${key(k)}, idx, ST_Translate(ST_MakeValid(ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(g), $3::int),27700)), ${k * spread}, 0)
      FROM unnest($1::text[], $2::int[]) AS t(g, idx)`, [geoms, idxs, srid])
  }
  await c.query(`INSERT INTO va (upload_id, idx, geom)
    SELECT ${key(99)}, idx, ST_MakeValid(ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(g), $3::int),27700))
    FROM unnest($1::text[], $2::int[]) AS t(g, idx)`, [geoms, idxs, srid])
  await c.query(`ANALYZE va`)
  const s = t()
  const r = await c.query(`SELECT count(*) c FROM va a JOIN va b
    ON a.upload_id=${key(99)} AND b.upload_id=${key(99)} AND a.idx<b.idx AND ST_Intersects(a.geom,b.geom)`)
  const ms = t() - s
  const plan = await c.query(`EXPLAIN (ANALYZE, FORMAT JSON) SELECT count(*) FROM va a JOIN va b
    ON a.upload_id=${key(99)} AND b.upload_id=${key(99)} AND a.idx<b.idx AND ST_Intersects(a.geom,b.geom)`)
  const flat = JSON.stringify(plan.rows[0]['QUERY PLAN'])
  const scan = flat.match(/"Node Type":"(Index Scan|Bitmap Heap Scan|Seq Scan)"/g)?.join(',') ?? '?'
  console.log(`${name.padEnd(46)} join ${ms.toFixed(0).padStart(6)} ms  pairs ${r.rows[0].c.padStart(6)}  ${scan}`)
}

console.log('5,000-parcel upload joined against a shared table also holding other uploads\n')
await scenario('alone in the table (uuid key)',            { keyType:'uuid', otherUploads:0, spread:0 })
await scenario('8 others, SAME site (worst case)',          { keyType:'uuid', otherUploads:8, spread:0 })
await scenario('8 others, different sites 5 km apart',      { keyType:'uuid', otherUploads:8, spread:5000 })
await scenario('8 others, different sites 100 km apart',    { keyType:'uuid', otherUploads:8, spread:100000 })
await scenario('8 others, SAME site, monotonic int key',    { keyType:'bigint', otherUploads:8, spread:0 })
await scenario('8 others, SAME site, + btree on upload_id', { keyType:'uuid', otherUploads:8, spread:0, extraIndex:true })
await c.query(`DROP TABLE IF EXISTS va`); c.release(); await pool.end()
