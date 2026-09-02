process.env.ENABLE_PERF_EVIDENCE = 'false'
import fs from 'node:fs'
import Database from '/bng-metric-backend/node_modules/better-sqlite3/lib/index.js'
import { LOAD_QUERY, INDEX_QUERY, CHECK_QUERY, buildArrays } from './opt-query.mjs'
const BE = '/bng-metric-backend'
const { readGeoPackage } = await import(`${BE}/src/validation/geopackage/geopackage.js`)
const pgMod = await import(`${BE}/node_modules/pg/lib/index.js`)
const { Pool } = pgMod.default
const pool = new Pool({ host:'127.0.0.1', port:Number(process.env.PGPORT ?? 5433), user:'dev', password:'dev', database:'bng_metric_backend', max:2 })
const ENGLAND = JSON.stringify(JSON.parse(fs.readFileSync(`${BE}/src/validation/reference/england.geojson`,'utf8')).geometry)
const ENV=[0,32,48,48,64]
function wkbHexes(file, table){ const db=new Database(file,{readonly:true});
  const col = db.prepare('SELECT column_name FROM gpkg_geometry_columns WHERE table_name = ?').get(table).column_name
  const rows=db.prepare(`SELECT "${col}" AS g FROM "${table}"`).all(); db.close();
  return rows.map(({g})=>g.subarray(8+ENV[(g[3]>>1)&7]).toString('hex')) }

const n = Number(process.argv[2] ?? 5000)
const layers = readGeoPackage(`gpkg/parcels-${n}.gpkg`)
const a = buildArrays(layers)
const c = await pool.connect(); await c.query('BEGIN')
await c.query(LOAD_QUERY, [a.layerNames, a.idxs, a.fids, a.refs, a.geoms, a.srids])
await c.query(INDEX_QUERY)

const marker = "\nSELECT 'NO_REDLINE'"
const cut = CHECK_QUERY.indexOf(marker)
const withBlock = CHECK_QUERY.slice(0, cut)
const branches = CHECK_QUERY.slice(cut + 1).split(/\nUNION ALL /)
const bare = withBlock + "SELECT count(*)::text AS code, '{}'::jsonb AS payload FROM feat_all"
let s = performance.now(); await c.query(bare, [ENGLAND]); const bareMs = +(performance.now()-s).toFixed(1)
const out = []
for (const b of branches) {
  s = performance.now()
  await c.query(withBlock + b, [ENGLAND])
  out.push({ check: (b.match(/SELECT '([A-Z_]+)'/)??[,'?'])[1], ms: +(performance.now()-s).toFixed(1) })
}
console.log('optimised prefix (load-table scan only):', bareMs, 'ms')
out.sort((x,y)=>y.ms-x.ms).forEach(r=>console.log('  ', r.check.padEnd(32), String(r.ms).padStart(7), 'marginal=', (r.ms-bareMs).toFixed(1)))
await c.query('ROLLBACK'); c.release()

// WKB vs GeoJSON for the load statement
const wkbByLayer = { redline: wkbHexes(`gpkg/parcels-${n}.gpkg`,'Red Line Boundary'), areas: wkbHexes(`gpkg/parcels-${n}.gpkg`,'Habitats'),
  hedgerows: wkbHexes(`gpkg/parcels-${n}.gpkg`,'Hedgerows'), watercourses: wkbHexes(`gpkg/parcels-${n}.gpkg`,'Rivers'),
  iggis: [], trees: wkbHexes(`gpkg/parcels-${n}.gpkg`,'Urban Trees') }
const order = ['redline','areas','hedgerows','watercourses','iggis','trees']
const hexes = order.flatMap(l => wkbByLayer[l])
const c2 = await pool.connect(); await c2.query('BEGIN')
s = performance.now(); await c2.query(LOAD_QUERY, [a.layerNames, a.idxs, a.fids, a.refs, a.geoms, a.srids]); const geojsonLoad = +(performance.now()-s).toFixed(1)
await c2.query('ROLLBACK'); await c2.query('BEGIN')
const LOAD_WKB = LOAD_QUERY.replace('ST_GeomFromGeoJSON(g)', "ST_GeomFromWKB(decode(g,'hex'))")
s = performance.now(); await c2.query(LOAD_WKB, [a.layerNames, a.idxs, a.fids, a.refs, hexes, a.srids]); const wkbLoad = +(performance.now()-s).toFixed(1)
await c2.query('ROLLBACK'); c2.release()
console.log('load with GeoJSON params:', geojsonLoad, 'ms  bytes:', a.geoms.reduce((x,g)=>x+Buffer.byteLength(g),0))
console.log('load with WKB-hex params:', wkbLoad, 'ms  bytes:', hexes.reduce((x,g)=>x+g.length,0), ' (rows match:', hexes.length === a.geoms.length, ')')
fs.writeFileSync('results/optimised-branches.json', JSON.stringify({ bareMs, out, geojsonLoad, wkbLoad }, null, 2))
await pool.end()
