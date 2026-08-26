/**
 * The OS tiles proxy, mounted in a real Hapi server.
 *
 * Only the upstream is faked — the plugin, routing, validation, caching and
 * capabilities parsing under test are the ones that would ship.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import Hapi from '@hapi/hapi'

import { createOsTilesPlugin } from '../src/os-proxy/plugin.mjs'
import { stubOsFetch } from '../src/os-proxy/stub-upstream.mjs'
import { memoryTileCache } from '../src/os-proxy/cache.mjs'
import { proxyTileSource, fetchGridFromProxy } from '../src/tiles.mjs'

const GRID = {
  originX: -238375,
  originY: 1376256,
  tileSize: 256,
  resolutions: [896, 448, 224, 112, 56, 28, 14, 7, 3.5, 1.75, 0.875, 0.4375, 0.21875, 0.109375]
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

test('serves the EPSG:27700 grid from capabilities', async () => {
  const { server } = await serverWith()

  const res = await server.inject('/os-tiles/capabilities')
  assert.equal(res.statusCode, 200)

  const { layer, grid } = JSON.parse(res.payload)
  assert.equal(layer, 'Light_27700')
  assert.equal(grid.originX, GRID.originX)
  assert.equal(grid.originY, GRID.originY)
  assert.equal(grid.tileSize, 256)
  assert.ok(Math.abs(grid.resolutions[0] - 896) < 1e-9)
  // Matrix dimensions must survive — tile validation depends on them.
  assert.ok(Number.isFinite(grid.matrixWidths[0]))
})

test('serves a PNG tile', async () => {
  const { server } = await serverWith()

  const res = await server.inject('/os-tiles/9/300/400.png')
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['content-type'], 'image/png')
  // PNG signature.
  assert.deepEqual([...res.rawPayload.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47])
})

test('the API key never appears in a response', async () => {
  const { server } = await serverWith()

  for (const path of ['/os-tiles/capabilities', '/os-tiles/9/300/400.png']) {
    const res = await server.inject(path)
    assert.ok(
      !res.rawPayload.includes(Buffer.from(API_KEY)),
      `${path} leaked the API key`
    )
  }
})

test('the key is sent upstream, once, as a query parameter', async () => {
  const { server, upstream } = await serverWith()
  await server.inject('/os-tiles/9/300/400.png')

  assert.ok(upstream.calls.length > 0)
  assert.ok(upstream.calls.every((call) => call.includes(`key=${API_KEY}`)))
})

test('a second request for the same tile is served from cache', async () => {
  const cache = memoryTileCache({ ttlSeconds: 60 })
  const { server, upstream } = await serverWith({ cache })

  const first = await server.inject('/os-tiles/9/300/400.png')
  const tileCallsAfterFirst = upstream.calls.filter((c) => c.endsWith('.png')).length

  const second = await server.inject('/os-tiles/9/300/400.png')
  const tileCallsAfterSecond = upstream.calls.filter((c) => c.endsWith('.png')).length

  assert.equal(first.headers['x-tile-cache'], 'miss')
  assert.equal(second.headers['x-tile-cache'], 'hit')
  assert.equal(tileCallsAfterFirst, tileCallsAfterSecond, 'cache hit must not go upstream')
  assert.deepEqual(second.rawPayload, first.rawPayload)
})

test('out-of-range tile coordinates are rejected without going upstream', async () => {
  const { server, upstream } = await serverWith()
  await server.inject('/os-tiles/capabilities') // warm the grid
  const before = upstream.calls.length

  for (const path of [
    '/os-tiles/9/-1/0.png',
    '/os-tiles/9/0/-5.png',
    '/os-tiles/99/0/0.png',
    '/os-tiles/9/99999999/0.png'
  ]) {
    const res = await server.inject(path)
    assert.equal(res.statusCode, 404, `${path} should be rejected`)
  }

  assert.equal(
    upstream.calls.length,
    before,
    'a rejected tile must never become an outbound request'
  )
})

test('zoom beyond the layer maximum is rejected', async () => {
  // Leisure_27700 stops at zoom 9 where the others go to 13.
  const { server } = await serverWith({ config: { layer: 'Leisure_27700' } })

  assert.equal((await server.inject('/os-tiles/9/300/400.png')).statusCode, 200)
  const tooDeep = await server.inject('/os-tiles/12/300/400.png')
  assert.equal(tooDeep.statusCode, 404)
  assert.match(JSON.parse(tooDeep.payload).error, /exceeds max zoom 9/)
})

test('an unknown layer is rejected at construction, not at request time', () => {
  assert.throws(
    () => createOsTilesPlugin({ config: { layer: 'Light_3857' }, logger: silent }),
    /Unknown OS layer/
  )
})

test('a 401 from OS explains the two ways a key can be wrong', async () => {
  const { server } = await serverWith({ config: { apiKey: 'wrong-key' } })

  const res = await server.inject('/os-tiles/9/300/400.png')
  assert.equal(res.statusCode, 401)
  assert.match(JSON.parse(res.payload).error, /OS Maps API" product added/)
})

test('a missing key is warned about at registration', async () => {
  const warnings = []
  const built = createOsTilesPlugin({
    config: { apiKey: '' },
    logger: { ...silent, warn: (message) => warnings.push(message) }
  })
  const server = Hapi.server({ port: 0 })
  await server.register(built.plugin)

  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /OS_MAPS_API_KEY is not set/)
})

test('the PDF tile source drives the proxy end to end', async () => {
  const { server } = await serverWith()
  // Hapi's inject gives us a fetch-shaped call without opening a socket.
  const asFetch = async (url) => {
    const res = await server.inject(new URL(url).pathname)
    return {
      ok: res.statusCode >= 200 && res.statusCode < 300,
      status: res.statusCode,
      statusText: '',
      json: async () => JSON.parse(res.payload),
      arrayBuffer: async () => res.rawPayload
    }
  }

  const base = 'http://localhost/os-tiles'
  const grid = await fetchGridFromProxy(base, asFetch)
  assert.equal(grid.originX, GRID.originX)

  const source = proxyTileSource({ baseUrl: base, fetchImpl: asFetch })
  const tile = await source(grid, 9, 300, 400)
  assert.deepEqual([...tile.png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47])

  // The PDF-side source caches too, so a document never re-requests a tile.
  const again = await source(grid, 9, 300, 400)
  assert.equal(again, tile)
})

test('memory cache evicts oldest and honours TTL', async () => {
  const cache = memoryTileCache({ maxEntries: 2, ttlSeconds: 10 })
  await cache.set('a', Buffer.from('1'), 0)
  await cache.set('b', Buffer.from('2'), 0)
  await cache.set('c', Buffer.from('3'), 0)

  assert.equal(await cache.get('a', 0), null, 'oldest should have been evicted')
  assert.ok(await cache.get('c', 0))
  assert.equal(await cache.get('c', 20_000), null, 'entry should expire')
})
