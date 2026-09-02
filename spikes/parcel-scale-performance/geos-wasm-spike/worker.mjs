process.env.ENABLE_PERF_EVIDENCE = 'false'
import { parentPort, workerData } from 'node:worker_threads'
const { validateWithGeos } = await import('./validate-geos.mjs')
const { readGeoPackage } = await import('/bng-metric-backend/src/validation/geopackage/geopackage.js')
const layers = readGeoPackage(workerData.file)
parentPort.postMessage({ ready: true })
parentPort.on('message', () => {
  const s = performance.now()
  const r = validateWithGeos(layers)
  parentPort.postMessage({ ms: performance.now() - s, valid: r.valid, rssMb: Math.round(process.memoryUsage().rss / 1048576) })
})
