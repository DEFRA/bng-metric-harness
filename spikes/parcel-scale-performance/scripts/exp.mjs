/**
 * Optimisation experiments. Each measures one candidate change against the
 * current implementation, on the same data, in the same session.
 */
process.env.ENABLE_PERF_EVIDENCE = 'false'
import fs from 'node:fs'
import Database from '/bng-metric-backend/node_modules/better-sqlite3/lib/index.js'
const BE = '/bng-metric-backend'
const { readGeoPackage } = await import(`${BE}/src/validation/geopackage/geopackage.js`)
const { materialiseIndexedAreas } = await import(`${BE}/src/validation/geopackage/postgis/index.js`)
const pgMod = await import(`${BE}/node_modules/pg/lib/index.js`)
const { Pool } = pgMod.default
const pool = new Pool({ host:'127.0.0.1', port: Number(process.env.PGPORT ?? 5432), user:'dev', password:'dev', database:'bng_metric_backend', max:2 })

const GRID = 0.001, TOL = 0.5, MIN_AREA = 1

/** Raw WKB (GPKG header stripped) for every row of a gpkg feature table. */
function wkbHexes(file, table, geomCol = 'geom') {
  const db = new Database(file, { readonly: true })
  const rows = db.prepare(`SELECT "${geomCol}" AS g FROM "${table}"`).all()
  db.close()
  const ENV = [0, 32, 48, 48, 64]
  return rows.map(({ g }) => {
    const flags = g[3]
    const env = ENV[(flags >> 1) & 0x07]
    return g.subarray(8 + env).toString('hex')
  })
}

async function timed(client, label, sql, params) {
  const t = performance.now()
  const r = await client.query(sql, params)
  return { label, ms: +(performance.now() - t).toFixed(1), rows: r.rowCount, sample: r.rows[0] }
}

const results = {}
for (const n of (process.argv[2] ?? '5000').split(',').map(Number)) {
  const file = `gpkg/parcels-${n}.gpkg`
  const layers = readGeoPackage(file)
  const srid = layers.areas[0].nativeSrid
  const geojson = layers.areas.map((f) => f.geometryJson ?? JSON.stringify(f.nativeGeometry))
  const hexes = wkbHexes(file, 'Habitats')
  const redlineJson = layers.redline.map((f) => f.geometryJson ?? JSON.stringify(f.nativeGeometry))
  const R = []
  const client = await pool.connect()
  await client.query('BEGIN')
  await client.query('SET LOCAL jit = off')

  // --- E1: input encoding -------------------------------------------------
  R.push(await timed(client, 'E1a GeoJSON parse+transform (areas)',
    `SELECT count(*) FROM unnest($1::text[]) AS t(g) WHERE ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(g), $2::int), 27700) IS NOT NULL`, [geojson, srid]))
  R.push(await timed(client, 'E1b WKB parse+transform (areas)',
    `SELECT count(*) FROM unnest($1::text[]) AS t(h) WHERE ST_Transform(ST_SetSRID(ST_GeomFromWKB(decode(h,'hex')), $2::int), 27700) IS NOT NULL`, [hexes, srid]))

  // Materialise the parcels exactly as production does.
  const arrays = await materialiseIndexedAreas(client, layers)
  const params = [arrays.layerNames, arrays.idxs, arrays.props, arrays.geoms, arrays.srids]
  const RL = `redline_union AS (SELECT ST_Union(ST_MakeValid(ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(g), ${srid}), 27700))) AS geom FROM unnest($1::text[]) AS t(g))`

  // --- E3: parcel overlap -------------------------------------------------
  R.push(await timed(client, 'E3a overlap: current (ST_Intersection area on every intersecting pair)',
    `SELECT count(*) FROM areas_g a JOIN areas_g b ON a.idx < b.idx AND ST_Intersects(a.geom, b.geom)
     WHERE ST_Area(ST_Intersection(a.geom, b.geom, ${GRID})) > ${TOL}`, []))
  R.push(await timed(client, 'E3b overlap: ST_Relate interior pre-filter, area only on survivors',
    `SELECT count(*) FROM areas_g a JOIN areas_g b ON a.idx < b.idx AND ST_Intersects(a.geom, b.geom)
     WHERE ST_Relate(a.geom, b.geom, 'T********')
       AND ST_Area(ST_Intersection(a.geom, b.geom, ${GRID})) > ${TOL}`, []))
  R.push(await timed(client, 'E3c overlap: candidate pairs only (no predicate beyond ST_Intersects)',
    `SELECT count(*) FROM areas_g a JOIN areas_g b ON a.idx < b.idx AND ST_Intersects(a.geom, b.geom)`, []))

  // --- E4: parcels outside redline ---------------------------------------
  R.push(await timed(client, 'E4a outside: current (ST_Difference per parcel, re-parsed geometry)',
    `WITH ${RL},
     areas AS (SELECT ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(g), s), 27700) AS geom
               FROM unnest($2::text[], $3::int[]) AS t(g, s))
     SELECT count(*) FROM (
       SELECT ST_Difference(ST_MakeValid(a.geom), r.geom, ${GRID}) AS escape
       FROM areas a CROSS JOIN redline_union r WHERE r.geom IS NOT NULL) s
     WHERE ST_Area(escape) > ${TOL}`, [redlineJson, geojson, arrays.srids.filter((_, i) => arrays.layerNames[i] === 'areas')]))
  R.push(await timed(client, 'E4b outside: reuse areas_g + ST_CoveredBy pre-filter',
    `WITH ${RL}
     SELECT count(*) FROM (
       SELECT ST_Difference(a.geom, r.geom, ${GRID}) AS escape
       FROM areas_g a CROSS JOIN redline_union r
       WHERE r.geom IS NOT NULL AND NOT ST_CoveredBy(a.geom, r.geom)) s
     WHERE ST_Area(escape) > ${TOL}`, [redlineJson]))

  // --- E5: slivers --------------------------------------------------------
  R.push(await timed(client, 'E5a slivers: current (ST_Union of every parcel, then difference)',
    `WITH ${RL},
     areas AS (SELECT ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(g), s), 27700) AS geom
               FROM unnest($2::text[], $3::int[]) AS t(g, s)),
     parcels_union AS (SELECT ST_Union(ST_MakeValid(geom)) AS geom FROM areas)
     SELECT count(*) FROM (
       SELECT (ST_Dump(ST_Difference(p.geom, r.geom, ${GRID}))).geom AS g
       FROM parcels_union p CROSS JOIN redline_union r
       WHERE p.geom IS NOT NULL AND r.geom IS NOT NULL) l
     WHERE ST_Area(g) > ${TOL}`, [redlineJson, geojson, arrays.srids.filter((_, i) => arrays.layerNames[i] === 'areas')]))
  R.push(await timed(client, 'E5b slivers: union only the per-parcel escapes',
    `WITH ${RL},
     escapes AS (SELECT ST_Difference(a.geom, r.geom, ${GRID}) AS geom
                 FROM areas_g a CROSS JOIN redline_union r
                 WHERE r.geom IS NOT NULL AND NOT ST_CoveredBy(a.geom, r.geom))
     SELECT count(*) FROM (
       SELECT (ST_Dump(ST_Union(geom))).geom AS g FROM escapes WHERE geom IS NOT NULL) l
     WHERE ST_Area(g) > ${TOL}`, [redlineJson]))

  // --- E2: too-small / invalid, reusing areas_g --------------------------
  R.push(await timed(client, 'E2a too-small: current (ST_MakeValid + ST_Area twice per row, re-parsed)',
    `WITH areas AS (SELECT ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(g), s), 27700) AS geom
                    FROM unnest($1::text[], $2::int[]) AS t(g, s))
     SELECT count(*) FROM (SELECT ST_Area(ST_MakeValid(geom)) AS a FROM areas) x WHERE a < ${MIN_AREA}`,
    [geojson, arrays.srids.filter((_, i) => arrays.layerNames[i] === 'areas')]))
  R.push(await timed(client, 'E2b too-small: reuse areas_g (already valid)',
    `SELECT count(*) FROM (SELECT idx, ST_Area(geom) AS a FROM areas_g) x WHERE a < ${MIN_AREA}`, []))
  R.push(await timed(client, 'E2c invalid-geometry: current (re-parsed, ST_IsValid on raw)',
    `WITH areas AS (SELECT ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(g), s), 27700) AS geom
                    FROM unnest($1::text[], $2::int[]) AS t(g, s))
     SELECT count(*) FROM areas WHERE NOT ST_IsValid(geom)`,
    [geojson, arrays.srids.filter((_, i) => arrays.layerNames[i] === 'areas')]))

  // --- E6: planning cost of the giant statement --------------------------
  const full = fs.readFileSync('results/check-query.sql', 'utf8')
  const englandGeoJson = JSON.parse(fs.readFileSync(`${BE}/src/validation/reference/england.geojson`, 'utf8'))
  const fullParams = [...params, JSON.stringify(englandGeoJson.geometry)]
  const tp = performance.now()
  await client.query(`EXPLAIN ${full}`, fullParams)
  R.push({ label: 'E6 planning-only time for CHECK_QUERY (EXPLAIN)', ms: +(performance.now() - tp).toFixed(1) })

  await client.query('ROLLBACK'); client.release()
  results[n] = R
  console.log('=== parcels', n)
  for (const r of R) console.log(String(r.ms).padStart(9), 'ms  rows=' + (r.rows ?? '-'), ' ', r.label)
}
fs.writeFileSync('results/experiments.json', JSON.stringify(results, null, 2))
await pool.end()
