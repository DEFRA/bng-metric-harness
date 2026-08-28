/**
 * The proxy's vector flavour, mounted in a real Hapi server.
 *
 * Same posture as os-proxy.test.mjs: only the upstream is faked. The routes,
 * validation, caching and TileMatrixSet parsing under test are the ones that
 * would ship.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import Hapi from '@hapi/hapi'

import { createOsTilesPlugin } from '../src/os-proxy/plugin.mjs'
import { stubOsFetch } from '../src/os-proxy/stub-upstream.mjs'
import { memoryTileCache } from '../src/os-proxy/cache.mjs'
import { vectorProxyTileSource, fetchVectorGridFromProxy } from '../src/tiles.mjs'
import { decodeVectorTile } from '../src/mvt.mjs'

const GRID = {
  originX: -238375,
  originY: 1376256,
  tileSize: 512,
  resolutions: [3584, 1792, 896, 448, 224, 112, 56, 28, 14, 7, 3.5, 1.75, 0.875, 0.4375, 0.21875, 0.109375]
}

const API_KEY = 'test-key'
const silent = { warn() {}, error() {}, info() {} }

async function serverWith(overrides = {}) {
  const upstream = stubOsFetch(GRID, { expectKey: API_KEY })
  const built = createOsTilesPlugin({
    config: { apiKey: API_KEY, ...overrides.config },
    fetchImpl: overrides.fetchImpl ?? upstream.fetch,
    logger: silent,
    cache: overrides.cache
  })

  const server = Hapi.server({ port: 0 })
  await server.register(built.plugin)
  await server.initialize()
  return { server, upstream, built }
}

test('serves the vector grid from its own capabilities route', async () => {
  const { server } = await serverWith()

  const res = await server.inject('/os-tiles/vector/capabilities')
  assert.equal(res.statusCode, 200)

  const { grid } = JSON.parse(res.payload)
  assert.equal(grid.originX, GRID.originX)
  assert.equal(grid.tileSize, 512)
  assert.equal(grid.resolutions.length, 16)
  assert.equal(grid.maxZoom, 15, 'the product ceiling must ride along')
  assert.ok(Number.isFinite(grid.matrixWidths[0]))
})

test('serves a decodable vector tile with the MVT content type', async () => {
  const { server } = await serverWith()

  const res = await server.inject('/os-tiles/vector/12/300/400.pbf')
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['content-type'], 'application/vnd.mapbox-vector-tile')

  const tile = decodeVectorTile(res.rawPayload)
  assert.ok(tile.layers.GB_land, 'stub tiles carry a land polygon')
  assert.ok(tile.layers.Graticule.features.length > 0, 'and graticule lines')
})

test('the raster and vector flavours cache separately', async () => {
  const cache = memoryTileCache({ ttlSeconds: 60 })
  const { server } = await serverWith({ cache })

  const vector = await server.inject('/os-tiles/vector/12/300/400.pbf')
  const raster = await server.inject('/os-tiles/12/300/400.png')

  assert.equal(vector.headers['x-tile-cache'], 'miss')
  assert.equal(raster.headers['x-tile-cache'], 'miss', 'same z/col/row must not collide across flavours')
  assert.notDeepEqual(vector.rawPayload, raster.rawPayload)

  const again = await server.inject('/os-tiles/vector/12/300/400.pbf')
  assert.equal(again.headers['x-tile-cache'], 'hit')
  assert.deepEqual(again.rawPayload, vector.rawPayload)
})

test('the API key never appears in a vector response', async () => {
  const { server } = await serverWith()

  for (const path of ['/os-tiles/vector/capabilities', '/os-tiles/vector/12/300/400.pbf']) {
    const res = await server.inject(path)
    assert.ok(!res.rawPayload.includes(Buffer.from(API_KEY)), `${path} leaked the API key`)
  }
})

test('out-of-range vector tiles are rejected without going upstream', async () => {
  const { server, upstream } = await serverWith()
  await server.inject('/os-tiles/vector/capabilities') // warm the grid
  const before = upstream.calls.length

  for (const path of [
    '/os-tiles/vector/9/-1/0.pbf',
    '/os-tiles/vector/99/0/0.pbf',
    '/os-tiles/vector/9/99999999/0.pbf'
  ]) {
    const res = await server.inject(path)
    assert.equal(res.statusCode, 404, `${path} should be rejected`)
  }
  assert.equal(upstream.calls.length, before)
})

test('a 401 on the vector path names a vector product, not the raster one', async () => {
  const { server } = await serverWith({ config: { apiKey: 'wrong-key' } })

  // The FIRST thing the flavour fetches is the tiling-scheme document, so
  // that is where a bad key surfaces — and the diagnostic must name the
  // product that request needed, not "OS Maps API".
  const res = await server.inject('/os-tiles/vector/12/300/400.pbf')
  assert.equal(res.statusCode, 401)
  const { error } = JSON.parse(res.payload)
  assert.match(error, /"OS NGD API – Tiles" product/)
  assert.doesNotMatch(error, /"OS Maps API"/)
})

test('the vector upstream is asked for ROW before COLUMN', async () => {
  const { server, upstream } = await serverWith()
  await server.inject('/os-tiles/vector/12/300/400.pbf') // col 300, row 400

  const tileCall = upstream.calls.find((call) => call.includes('/tiles/27700/'))
  assert.ok(tileCall.includes('/tiles/27700/12/400/300?'), `expected z/row/col in ${tileCall}`)
})

test('the PDF vector tile source drives the proxy end to end', async () => {
  const { server } = await serverWith()
  const asFetch = async (url) => {
    const res = await server.inject(new URL(url, 'http://localhost').pathname)
    return {
      ok: res.statusCode >= 200 && res.statusCode < 300,
      status: res.statusCode,
      statusText: '',
      json: async () => JSON.parse(res.payload),
      arrayBuffer: async () => res.rawPayload
    }
  }

  const base = 'http://localhost/os-tiles'
  const grid = await fetchVectorGridFromProxy(base, asFetch)
  assert.equal(grid.originX, GRID.originX)

  const source = vectorProxyTileSource({ baseUrl: base, fetchImpl: asFetch })
  const tile = await source(grid, 12, 300, 400)
  assert.ok(tile.layers.Graticule)

  // Decoded once, reused thereafter.
  const again = await source(grid, 12, 300, 400)
  assert.equal(again, tile)
})
