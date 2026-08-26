#!/usr/bin/env node
/**
 * Build a sample PDF from the harness's example GeoPackages.
 *
 *   node src/cli.mjs                       # defaults, synthetic basemap
 *   node src/cli.mjs --graticule           # overlay the registration proof
 *   node src/cli.mjs --habitat-basemap     # basemap behind each parcel thumbnail
 *   node src/cli.mjs --baseline <file> --post <file> --out <file>
 *   OS_API_KEY=… node src/cli.mjs --os     # real OS basemap (unverified path)
 */

import fs from 'node:fs'
import path from 'node:path'

import { readSite } from './gpkg.mjs'
import { buildSummaryPdf } from './document.mjs'
import { syntheticTileSource, osTileSource } from './tiles.mjs'
import { gridFromWmtsCapabilities } from './grid.mjs'

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

const OS_WMTS_CAPABILITIES =
  'https://api.os.uk/maps/raster/v1/wmts?service=WMTS&request=GetCapabilities&version=2.0.0'

function parseArgs(argv) {
  const args = {
    baseline: path.join(EXAMPLES, 'Baseline - retained watercourse.gpkg'),
    post: path.join(EXAMPLES, 'Post-intervention - retained watercourse.gpkg'),
    out: path.resolve(import.meta.dirname, '../out/site-summary.pdf'),
    graticule: false,
    habitatBasemap: false,
    os: false
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--graticule') {
      args.graticule = true
    } else if (arg === '--habitat-basemap') {
      args.habitatBasemap = true
    } else if (arg === '--os') {
      args.os = true
    } else if (arg === '--no-post') {
      args.post = null
    } else if (arg.startsWith('--')) {
      args[arg.slice(2)] = argv[++i]
    }
  }
  return args
}

async function resolveBasemap(args) {
  if (!args.os) {
    return { grid: SYNTHETIC_GRID, tileSource: syntheticTileSource(), kind: 'synthetic' }
  }

  const apiKey = process.env.OS_API_KEY
  if (!apiKey) {
    throw new Error('--os requires OS_API_KEY in the environment')
  }
  // The grid MUST come from OS, not from a constant. An origin out by one tile
  // produces a basemap that looks plausible and is wrong.
  const response = await fetch(`${OS_WMTS_CAPABILITIES}&key=${apiKey}`)
  if (!response.ok) {
    throw new Error(`GetCapabilities failed: ${response.status} ${response.statusText}`)
  }
  const grid = gridFromWmtsCapabilities(await response.text(), 'EPSG:27700')
  return { grid, tileSource: osTileSource({ apiKey }), kind: 'OS Maps API' }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  const baseline = readSite(args.baseline)
  const postIntervention = args.post ? readSite(args.post) : null
  const { grid, tileSource, kind } = await resolveBasemap(args)

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

  const { size } = fs.statSync(args.out)
  console.log(
    `\nWrote ${args.out}\n` +
      `  ${(size / 1024).toFixed(1)} kB · ${stats.maps} site maps · ${stats.habitats} habitat rows · ` +
      `${stats.tiles} tiles · zoom ${stats.zooms.join(', ')}`
  )
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
