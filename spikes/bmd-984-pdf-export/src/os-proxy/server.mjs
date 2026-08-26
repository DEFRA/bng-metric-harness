/**
 * Stand the tile proxy up on its own.
 *
 * In production this plugin is registered on an existing sibling's Hapi server
 * — it is deliberately a plugin, not a service. This wrapper exists so the
 * spike's CLI can drive the real proxy in-process, and so anyone can poke the
 * routes by hand:
 *
 *   npm run serve:tiles
 *   curl localhost:3100/os-tiles/capabilities
 *   curl -o tile.png localhost:3100/os-tiles/9/300/400.png
 */

import { loadEnv } from '../env.mjs'
import Hapi from '@hapi/hapi'

import { createOsTilesPlugin } from './plugin.mjs'
import { stubOsFetch } from './stub-upstream.mjs'

/**
 * @param {object} options
 * @param {string} options.apiKey
 * @param {object|null} [options.stubGrid]  when set, serve a stub upstream
 *   claiming this grid instead of calling api.os.uk
 * @param {number} [options.port]  0 picks a free port
 */
export async function startTileProxy({
  apiKey,
  stubGrid = null,
  port = 0,
  logger = console
}) {
  const upstream = stubGrid ? stubOsFetch(stubGrid, { expectKey: apiKey }) : null

  const built = createOsTilesPlugin({
    config: { apiKey },
    fetchImpl: upstream?.fetch,
    logger
  })

  const server = Hapi.server({ port, host: '127.0.0.1' })
  await server.register(built.plugin)
  await server.start()

  return {
    baseUrl: `${server.info.uri}${built.config.routePrefix}`,
    server,
    cache: built.cache,
    stop: () => server.stop({ timeout: 1000 })
  }
}

// `node src/os-proxy/server.mjs` runs it standalone.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  loadEnv()
  const useStub = !process.env.OS_MAPS_API_KEY
  const stubGrid = useStub
    ? {
        originX: -238375,
        originY: 1376256,
        tileSize: 256,
        resolutions: [
          896, 448, 224, 112, 56, 28, 14, 7, 3.5, 1.75, 0.875, 0.4375, 0.21875,
          0.109375
        ]
      }
    : null

  const proxy = await startTileProxy({
    apiKey: process.env.OS_MAPS_API_KEY ?? 'stub-key',
    stubGrid,
    port: Number(process.env.PORT ?? 3100)
  })

  console.log(`Tile proxy listening on ${proxy.baseUrl}`)
  console.log(
    useStub
      ? 'Upstream: STUB (set OS_MAPS_API_KEY to talk to Ordnance Survey)'
      : 'Upstream: api.os.uk'
  )
}
