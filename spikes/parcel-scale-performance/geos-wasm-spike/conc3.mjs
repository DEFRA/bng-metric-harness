/**
 * Does running GEOS in Node hold up operationally?
 *   1. leak check — 30 back-to-back validations, watching WASM/heap growth
 *   2. event-loop lag with validation on the MAIN thread vs in a WORKER
 *   3. database probe latency while N validations run in Node (should be nil)
 */
process.env.ENABLE_PERF_EVIDENCE = 'false'
import { Worker } from 'node:worker_threads'
const BE = '/bng-metric-backend'
const { validateWithGeos } = await import('./validate-geos.mjs')
const { readGeoPackage } = await import(`${BE}/src/validation/geopackage/geopackage.js`)
const pgMod = await import(`${BE}/node_modules/pg/lib/index.js`); const { Pool } = pgMod.default
const FILE = '../gpkg/parcels-5000.gpkg'
const layers = readGeoPackage(FILE)
const mb = () => Math.round(process.memoryUsage().rss / 1048576)

// --- 1. leak check ----------------------------------------------------------
const before = mb()
let times = []
for (let i = 0; i < 30; i++) { const s = performance.now(); validateWithGeos(layers); times.push(performance.now() - s) }
const after = mb()
console.log(`LEAK CHECK  30 validations of 5,000 parcels`)
console.log(`   first ${times[0].toFixed(0)} ms · last ${times[29].toFixed(0)} ms · median ${times.slice().sort((a,b)=>a-b)[15].toFixed(0)} ms`)
console.log(`   RSS ${before} MB → ${after} MB  (${after - before >= 0 ? '+' : ''}${after - before} MB over 30 runs)\n`)

// --- 2. event-loop lag ------------------------------------------------------
async function lagDuring (label, run) {
  const lags = []
  let stop = false
  const tick = () => { const t = performance.now(); setTimeout(() => { lags.push(performance.now() - t - 5); if (!stop) tick() }, 5) }
  tick()
  await run()
  stop = true
  await new Promise((r) => setTimeout(r, 20))
  const s = lags.slice().sort((a, b) => a - b)
  console.log(`   ${label.padEnd(34)} event-loop lag  p50 ${Math.round(s[Math.floor(s.length*.5)] ?? 0)} ms   max ${Math.round(Math.max(0, ...s))} ms`)
}
console.log('EVENT LOOP — 4 validations of 5,000 parcels')
await lagDuring('on the main thread', async () => { for (let i = 0; i < 4; i++) validateWithGeos(layers) })

const spawn = () => new Promise((res) => {
  const w = new Worker(new URL('./worker.mjs', import.meta.url), { workerData: { file: FILE } })
  w.once('message', () => res(w))
})
const workers = await Promise.all([spawn(), spawn()])
const runOn = (w) => new Promise((res) => { w.once('message', res); w.postMessage('go') })
await lagDuring('in 2 worker threads', async () => {
  await Promise.all([runOn(workers[0]), runOn(workers[1])])
  await Promise.all([runOn(workers[0]), runOn(workers[1])])
})
console.log()

// --- 3. database probe while Node validates ---------------------------------
const pool = new Pool({ host:'127.0.0.1', port:5433, user:'dev', password:'dev', database:'bng_metric_backend', max:10 })
await pool.query(`DROP TABLE IF EXISTS probe_sim`)
await pool.query(`CREATE UNLOGGED TABLE probe_sim (id int primary key, name text)`)
await pool.query(`INSERT INTO probe_sim SELECT i, 'p'||i FROM generate_series(1,50) i`)
async function probeFor (label, seconds, busy) {
  const lat = []; let stop = false
  const p = (async () => { while (!stop) { const t = performance.now(); const c = await pool.connect(); const acq = performance.now(); await c.query('SELECT id,name FROM probe_sim ORDER BY name LIMIT 20'); c.release(); lat.push({ a: acq - t, q: performance.now() - acq }) } })()
  const load = busy ? (async () => { while (!stop) await Promise.all(workers.map(runOn)) })() : Promise.resolve()
  await new Promise((r) => setTimeout(r, seconds * 1000))
  stop = true; await Promise.all([p, load])
  const srt = (k) => lat.map(x => x[k]).sort((a,b)=>a-b)
  const A = srt('a'), Q = srt('q')
  console.log(`   ${label.padEnd(46)} n=${String(lat.length).padStart(6)}  acquire p50 ${Math.round(A[Math.floor(A.length*.5)]||0)} / p95 ${Math.round(A[Math.floor(A.length*.95)]||0)} ms   query p50 ${Math.round(Q[Math.floor(Q.length*.5)]||0)} ms`)
}
console.log('DATABASE PROBE (light project-list read)')
await probeFor('idle', 8, false)
await probeFor('while 2 workers validate 5,000 parcels continuously', 8, true)
await pool.query(`DROP TABLE probe_sim`); await pool.end()
for (const w of workers) await w.terminate()
