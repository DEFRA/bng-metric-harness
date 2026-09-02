// Pre-project the England reference polygon into EPSG:27700 once, using PostGIS.
// In production this file would be shipped alongside the GeoJSON, exactly as here.
import fs from 'node:fs'
const BE = '/bng-metric-backend'
const pgMod = await import(`${BE}/node_modules/pg/lib/index.js`); const { Pool } = pgMod.default
const pool = new Pool({ host:'127.0.0.1', port:5433, user:'dev', password:'dev', database:'bng_metric_backend', max:1 })
const src = JSON.parse(fs.readFileSync(`${BE}/src/validation/reference/england.geojson`, 'utf8')).geometry
const { rows } = await pool.query(
  `SELECT ST_AsGeoJSON(ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON($1), 4326), 27700), 9) AS g`, [JSON.stringify(src)])
fs.writeFileSync('england-27700.json', rows[0].g)
console.log('england-27700.json written,', (rows[0].g.length / 1024).toFixed(0), 'KB')
await pool.end()
