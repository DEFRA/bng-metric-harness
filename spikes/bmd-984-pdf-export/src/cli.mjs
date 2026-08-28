#!/usr/bin/env node
/**
 * Build a sample PDF from the harness's example GeoPackages.
 *
 *   node src/cli.mjs                       # defaults, synthetic basemap
 *   node src/cli.mjs --graticule           # overlay the registration proof
 *   node src/cli.mjs --no-habitat-basemap  # drop the per-parcel thumbnail basemap
 *   node src/cli.mjs --baseline <file> --post <file> --out <file>
 *
 *   node src/cli.mjs --proxy               # tiles via the real /os-tiles proxy,
 *                                          # backed by a stub upstream (no key)
 *   OS_MAPS_API_KEY=… node src/cli.mjs --os  # same proxy, real Ordnance Survey
 *
 * The vector basemap — the same maps drawn from OS NGD API – Tiles geometry
 * (the ngd-base tileset) instead of raster images. Needs the "OS NGD API –
 * Tiles" product on the key, NOT "OS Maps API", which is the whole reason
 * it exists. (The older OS Vector Tile API also serves vector tiles, but OS
 * have marked it for retirement, so it is not used here.)
 *
 *   node src/cli.mjs --proxy-vector        # stub vector upstream, no key
 *   node src/cli.mjs --os-vector           # real OS vector tiles
 *
 * The key can live in a gitignored `.env` instead — see `src/env.mjs` and
 * `.env.example`. A real environment variable still overrides the file.
 */

import fs from 'node:fs'
import path from 'node:path'

import { loadEnv } from './env.mjs'
import { readSite } from './gpkg.mjs'
import { buildSummaryPdf } from './document.mjs'
import {
  syntheticTileSource, proxyTileSource, fetchGridFromProxy,
  vectorProxyTileSource, fetchVectorGridFromProxy
} from './tiles.mjs'
import { startTileProxy } from './os-proxy/server.mjs'

const EXAMPLES = path.resolve(import.meta.dirname, '../../../example-files/valid')

/**
 * A tile matrix set shaped like the one OS publishes for EPSG:27700: a shared
 * top-left origin, 256px tiles, resolutions halving per level.
 *
 * Used ONLY with the synthetic basemap, where the numbers are arbitrary
 * because the tiles are generated from the same grid they are drawn against.
 * The real OS grid must be read from GetCapabilities — see `--os` below. Do
 * not promote these constants into anything that talks to api.os.uk.
 */
const SYNTHETIC_GRID = {
  originX: -238375,
  originY: 1376256,
  tileSize: 256,
  resolutions: [896, 448, 224, 112, 56, 28, 14, 7, 3.5, 1.75, 0.875, 0.4375, 0.21875, 0.109375]
}

export function parseArgs(argv) {
  const args = {
    baseline: path.join(EXAMPLES, 'Baseline - retained watercourse.gpkg'),
    post: path.join(EXAMPLES, 'Post-intervention - retained watercourse.gpkg'),
    out: path.resolve(import.meta.dirname, '../out/site-summary.pdf'),
    graticule: false,
    habitatBasemap: true,
    proxy: false,
    os: false,
    proxyVector: false,
    osVector: false
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--graticule') {
      args.graticule = true
    } else if (arg === '--habitat-basemap') {
      // Now the default; kept so existing invocations and docs still work.
      args.habitatBasemap = true
    } else if (arg === '--no-habitat-basemap') {
      // Must be matched explicitly: the generic `--key value` branch below
      // would otherwise swallow the NEXT argument as its value.
      args.habitatBasemap = false
    } else if (arg === '--proxy') {
      args.proxy = true
    } else if (arg === '--os') {
      args.os = true
    } else if (arg === '--proxy-vector') {
      args.proxyVector = true
    } else if (arg === '--os-vector') {
      args.osVector = true
    } else if (arg === '--no-post') {
      args.post = null
    } else if (arg.startsWith('--')) {
      args[arg.slice(2)] = argv[++i]
    }
  }
  return args
}

/**
 * Pick a basemap.
 *
 * `--proxy` and `--os` both run the REAL tile proxy in-process; they differ
 * only in what sits upstream of it. So `--proxy` exercises the whole
 * production path — route, validation, cache, grid-from-capabilities, and the
 * PDF fetching tiles by URL with no API key — without needing a key at all.
 *
 * `--proxy-vector` and `--os-vector` are the same pair for the vector
 * flavour: identical proxy, different OS product upstream, and the basemap
 * is drawn from decoded tile geometry rather than placed as images.
 */
async function resolveBasemap(args) {
  const vector = args.proxyVector || args.osVector
  const real = args.os || args.osVector

  if (!vector && !args.proxy && !args.os) {
    return {
      grid: SYNTHETIC_GRID,
      tileSource: syntheticTileSource(),
      kind: 'synthetic (direct, no proxy)'
    }
  }

  const apiKey = process.env.OS_MAPS_API_KEY ?? ''
  if (real && !apiKey) {
    throw new Error(
      `--${args.osVector ? 'os-vector' : 'os'} requires OS_MAPS_API_KEY in the environment`
    )
  }

  const proxy = await startTileProxy({
    apiKey: apiKey || 'stub-key',
    stubGrid: real ? null : SYNTHETIC_GRID
  })

  // The grid comes from the proxy's own capabilities route, so nothing here
  // holds a key or parses OS's WMTS XML / TileMatrixSet JSON itself. The two
  // flavours have DIFFERENT grids (512px vector tiles vs 256px raster).
  if (vector) {
    return {
      grid: await fetchVectorGridFromProxy(proxy.baseUrl),
      tileSource: vectorProxyTileSource({ baseUrl: proxy.baseUrl }),
      kind: args.osVector
        ? `OS NGD API – Tiles (ngd-base) via ${proxy.baseUrl}`
        : `stub vector upstream via the real proxy at ${proxy.baseUrl}`,
      stop: () => proxy.stop()
    }
  }

  return {
    grid: await fetchGridFromProxy(proxy.baseUrl),
    tileSource: proxyTileSource({ baseUrl: proxy.baseUrl }),
    kind: args.os
      ? `OS Maps API via ${proxy.baseUrl}`
      : `stub upstream via the real proxy at ${proxy.baseUrl}`,
    stop: () => proxy.stop()
  }
}

async function main() {
  // Before anything reads process.env — resolveConfig() does, at call time.
  loadEnv()

  const args = parseArgs(process.argv.slice(2))

  const baseline = readSite(args.baseline)
  const postIntervention = args.post ? readSite(args.post) : null
  const { grid, tileSource, kind, stop } = await resolveBasemap(args)

  console.log(`Site       : ${baseline.siteName ?? '(unnamed)'}`)
  console.log(`Baseline   : ${path.basename(args.baseline)}`)
  console.log(`Post       : ${args.post ? path.basename(args.post) : '(none)'}`)
  console.log(`Basemap    : ${kind}${args.graticule ? ' + graticule proof' : ''}`)

  const { doc, stats } = await buildSummaryPdf({
    baseline,
    postIntervention,
    grid,
    tileSource,
    graticule: args.graticule,
    habitatBasemap: args.habitatBasemap
  })

  fs.mkdirSync(path.dirname(args.out), { recursive: true })
  const stream = fs.createWriteStream(args.out)
  doc.pipe(stream)
  doc.end()
  await new Promise((resolve, reject) => {
    stream.on('finish', resolve)
    stream.on('error', reject)
  })

  await stop?.()

  const { size } = fs.statSync(args.out)
  console.log(
    `\nWrote ${args.out}\n` +
      `  ${(size / 1024).toFixed(1)} kB · ${stats.maps} site maps · ${stats.habitats} habitat rows · ` +
      `${stats.tiles} tiles · zoom ${stats.zooms.join(', ')}`
  )
}

// Only when run directly — importing this module (the tests do, for parseArgs)
// must not build a PDF. Same guard as src/os-proxy/server.mjs.
const runDirectly =
  process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())

if (runDirectly) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
