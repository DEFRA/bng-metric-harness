/**
 * Option B: generate the overlap candidate pairs in Node with a bounding-box
 * sweep, so PostGIS needs no temp table and no GiST index — and therefore no
 * held connection. Measures the sweep, verifies the pair set, and times the
 * resulting single stateless statement against the current two-statement path.
 */
process.env.ENABLE_PERF_EVIDENCE = 'false'
const BE = '/bng-metric-backend'
const { readGeoPackage } = await import(`${BE}/src/validation/geopackage/geopackage.js`)
const { materialiseIndexedAreas } = await import(`${BE}/src/validation/geopackage/postgis/index.js`)
const pgMod = await import(`${BE}/node_modules/pg/lib/index.js`); const { Pool } = pgMod.default
const pool = new Pool({ host:'127.0.0.1', port:5433, user:'dev', password:'dev', database:'bng_metric_backend', max:2 })
const GRID = 0.001, TOL = 0.5
const t = () => performance.now()

/** Bounding box of a GeoJSON Polygon/MultiPolygon, walking the coordinate tree. */
function bbox (geom) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  const walk = (c) => {
    if (typeof c[0] === 'number') {
      if (c[0] < x0) x0 = c[0]; if (c[0] > x1) x1 = c[0]
      if (c[1] < y0) y0 = c[1]; if (c[1] > y1) y1 = c[1]
      return
    }
    for (const n of c) walk(n)
  }
  walk(geom.coordinates)
  return [x0, y0, x1, y1]
}

/** Sweep-line over x: every pair of boxes that overlap in both axes. O(n log n + k). */
function candidatePairs (boxes) {
  const order = boxes.map((b, i) => i).sort((a, b) => boxes[a][0] - boxes[b][0])
  const pairsA = [], pairsB = []
  const active = []
  for (const i of order) {
    const bi = boxes[i]
    for (let k = active.length - 1; k >= 0; k--) {
      const j = active[k]
      if (boxes[j][2] < bi[0]) { active[k] = active[active.length - 1]; active.pop(); continue }
      if (boxes[j][1] <= bi[3] && boxes[j][3] >= bi[1]) {
        const [lo, hi] = i < j ? [i, j] : [j, i]
        pairsA.push(lo); pairsB.push(hi)
      }
    }
    active.push(i)
  }
  return { pairsA, pairsB }
}

for (const N of (process.argv[2] ?? '1000,5000,10000').split(',').map(Number)) {
  const layers = readGeoPackage(`gpkg/parcels-${N}.gpkg`)
  const areas = layers.areas
  const geoms = areas.map(f => f.geometryJson ?? JSON.stringify(f.nativeGeometry))
  const idxs = areas.map((_, i) => i)
  const srid = areas[0].nativeSrid

  // --- Node side: bbox sweep --------------------------------------------
  let s = t()
  const boxes = areas.map(f => bbox(f.nativeGeometry))
  const bboxMs = t() - s
  s = t()
  const { pairsA, pairsB } = candidatePairs(boxes)
  const sweepMs = t() - s

  // brute-force cross-check that the sweep missed nothing
  s = t()
  let brute = 0
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j]
    if (a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1]) brute++
  }
  const bruteMs = t() - s

  // --- Today: temp table + GiST + join, inside a transaction -------------
  const c1 = await pool.connect()
  s = t()
  await c1.query('BEGIN')
  await materialiseIndexedAreas(c1, layers)
  const prepMs = t() - s
  s = t()
  const cur = await c1.query(`SELECT count(*) c FROM areas_g a JOIN areas_g b
    ON a.idx<b.idx AND ST_Intersects(a.geom,b.geom)
    WHERE ST_Area(ST_Intersection(a.geom,b.geom,${GRID}))>${TOL}`)
  const curJoinMs = t() - s
  await c1.query('ROLLBACK'); c1.release()
  const heldMs = prepMs + curJoinMs

  // --- Option B: one stateless statement, pairs supplied -----------------
  s = t()
  const optB = await pool.query(`
    WITH areas AS (
      SELECT idx, ST_MakeValid(ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(g), $3::int), 27700)) AS geom
      FROM unnest($1::text[], $2::int[]) AS t(g, idx)
    )
    SELECT count(*) c
    FROM unnest($4::int[], $5::int[]) AS p(ia, ib)
    JOIN areas a ON a.idx = p.ia
    JOIN areas b ON b.idx = p.ib
    WHERE ST_Intersects(a.geom, b.geom)
      AND ST_Area(ST_Intersection(a.geom, b.geom, ${GRID})) > ${TOL}`,
    [geoms, idxs, srid, pairsA, pairsB])
  const optBMs = t() - s

  console.log(`\nparcels=${N}`)
  console.log(`  Node   bbox extract ${bboxMs.toFixed(1)} ms · sweep ${sweepMs.toFixed(1)} ms → ${pairsA.length} candidate pairs` +
              `  (brute-force check ${brute} pairs in ${bruteMs.toFixed(0)} ms — ${brute === pairsA.length ? 'MATCH' : 'MISMATCH'})`)
  console.log(`  TODAY  temp table + GiST + ANALYZE ${prepMs.toFixed(0)} ms, join ${curJoinMs.toFixed(0)} ms` +
              `  → connection held ${heldMs.toFixed(0)} ms, overlaps ${cur.rows[0].c}`)
  console.log(`  OPT B  one statement ${optBMs.toFixed(0)} ms` +
              `  → connection held ${optBMs.toFixed(0)} ms (no transaction), overlaps ${optB.rows[0].c}` +
              `  ${cur.rows[0].c === optB.rows[0].c ? 'SAME ANSWER' : '*** DIFFERS ***'}`)
}
await pool.end()
