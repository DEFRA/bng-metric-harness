process.env.ENABLE_PERF_EVIDENCE = 'false'
const BE = '/bng-metric-backend'
const { readGeoPackage } = await import(`${BE}/src/validation/geopackage/geopackage.js`)
const pgMod = await import(`${BE}/node_modules/pg/lib/index.js`); const { Pool } = pgMod.default
const pool = new Pool({ host:'127.0.0.1', port:5433, user:'dev', password:'dev', database:'bng_metric_backend', max:2 })
const GRID = 0.001, TOL = 0.5
function bbox (geom) { let x0=1/0,y0=1/0,x1=-1/0,y1=-1/0
  const w=(c)=>{ if(typeof c[0]==='number'){ if(c[0]<x0)x0=c[0]; if(c[0]>x1)x1=c[0]; if(c[1]<y0)y0=c[1]; if(c[1]>y1)y1=c[1]; return } for(const n of c) w(n) }
  w(geom.coordinates); return [x0,y0,x1,y1] }
function candidatePairs (boxes) {
  const order = boxes.map((b,i)=>i).sort((a,b)=>boxes[a][0]-boxes[b][0])
  const A=[],B=[],active=[]
  for (const i of order) { const bi=boxes[i]
    for (let k=active.length-1;k>=0;k--){ const j=active[k]
      if (boxes[j][2]<bi[0]) { active[k]=active[active.length-1]; active.pop(); continue }
      if (boxes[j][1]<=bi[3] && boxes[j][3]>=bi[1]) { const [lo,hi]=i<j?[i,j]:[j,i]; A.push(lo); B.push(hi) } }
    active.push(i) }
  return { pairsA:A, pairsB:B }
}
const N = Number(process.argv[2] ?? 10000)
const layers = readGeoPackage(`gpkg/parcels-${N}.gpkg`)
const areas = layers.areas
const geoms = areas.map(f => f.geometryJson ?? JSON.stringify(f.nativeGeometry))
const idxs = areas.map((_, i) => i)
const srid = areas[0].nativeSrid
const { pairsA, pairsB } = candidatePairs(areas.map(f => bbox(f.nativeGeometry)))
const SQL = `
  WITH areas AS (
    SELECT idx, ST_MakeValid(ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(g), $3::int), 27700)) AS geom
    FROM unnest($1::text[], $2::int[]) AS t(g, idx)
  )
  SELECT count(*) c
  FROM unnest($4::int[], $5::int[]) AS p(ia, ib)
  JOIN areas a ON a.idx = p.ia
  JOIN areas b ON b.idx = p.ib
  WHERE ST_Intersects(a.geom, b.geom)
    AND ST_Area(ST_Intersection(a.geom, b.geom, ${GRID})) > ${TOL}`
const params = [geoms, idxs, srid, pairsA, pairsB]

for (const wm of ['4MB', '64MB', '256MB']) {
  const c = await pool.connect()
  await c.query(`SET work_mem = '${wm}'`)
  const plan = await c.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${SQL}`, params)
  const flat = JSON.stringify(plan.rows[0]['QUERY PLAN'])
  const joins = (flat.match(/"Node Type":"(Nested Loop|Hash Join|Merge Join)"/g) ?? []).map(x => x.split('":"')[1].replace('"','')).join(' + ')
  const exec = plan.rows[0]['QUERY PLAN'][0]['Execution Time']
  const spill = /"Peak Memory Usage":(\d+)/.exec(flat)?.[1] ?? '-'
  console.log(`work_mem=${wm.padStart(6)}  exec ${String(Math.round(exec)).padStart(6)} ms   joins: ${joins}   hash peak KB: ${spill}`)
  await c.query(`RESET work_mem`); c.release()
}
console.log(`\n(${N} parcels, ${pairsA.length} candidate pairs supplied from Node)`)
await pool.end()
