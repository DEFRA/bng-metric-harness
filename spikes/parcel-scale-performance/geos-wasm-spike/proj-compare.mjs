/** How far apart are proj4js and PostGIS ST_Transform for EPSG:4326 → 27700? */
import proj4 from 'proj4'
const BE = '/bng-metric-backend'
const pgMod = await import(`${BE}/node_modules/pg/lib/index.js`); const { Pool } = pgMod.default
const pool = new Pool({ host:'127.0.0.1', port:5433, user:'dev', password:'dev', database:'bng_metric_backend', max:1 })

// EPSG:27700 as EPSG.io / PROJ publish it (7-parameter Helmert, no grid).
proj4.defs('EPSG:27700',
  '+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 ' +
  '+ellps=airy +towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489 +units=m +no_defs')

const sites = [
  ['Maidenhead (default fixture centre)', -0.72, 51.52],
  ['Newcastle', -1.61, 54.97],
  ['Penzance', -5.54, 50.12],
  ['Norwich', 1.30, 52.63],
  ['Carlisle', -2.94, 54.89],
  ['London', -0.12, 51.51],
  ['Birmingham', -1.90, 52.48],
  ['coastal — Skegness', 0.34, 53.14]
]
let worst = 0
console.log('site                                   PostGIS easting/northing        proj4js delta (m)')
for (const [name, lon, lat] of sites) {
  const { rows } = await pool.query(
    `SELECT ST_X(p) x, ST_Y(p) y FROM (SELECT ST_Transform(ST_SetSRID(ST_MakePoint($1,$2),4326),27700) p) t`, [lon, lat])
  const [jx, jy] = proj4('EPSG:4326', 'EPSG:27700', [lon, lat])
  const d = Math.hypot(jx - rows[0].x, jy - rows[0].y)
  if (d > worst) worst = d
  console.log(`${name.padEnd(38)} ${rows[0].x.toFixed(3).padStart(11)} ${rows[0].y.toFixed(3).padStart(11)}   ${d < 0.001 ? d.toExponential(1) : d.toFixed(4)}`)
}
console.log(`\nworst-case disagreement across England: ${worst < 0.001 ? worst.toExponential(2) : worst.toFixed(4)} m`)
console.log(`(tolerances in the validator: 0.1 m for boundary grazing, 0.5 sq m for area overlays)`)
await pool.end()
