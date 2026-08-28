/**
 * A portable Hapi plugin serving OS basemap tiles from an internal route.
 *
 *   GET /os-tiles/capabilities        the EPSG:27700 grid, as JSON
 *   GET /os-tiles/{z}/{col}/{row}.png one raster tile
 *
 * Deliberately imports nothing — not Hapi, not ioredis, not a logger. A Hapi
 * plugin is a plain object with a `register` function, so this mounts in either
 * sibling as-is, and takes its cache and logger by injection.
 *
 * Why one proxy serves both consumers:
 *
 *   browser map ─┐
 *                ├─→ /os-tiles/… ─→ cache ─→ api.os.uk (via the CDP proxy)
 *   PDF builder ─┘        key injected here, once
 *
 * The PDF builder needs no API key — only a URL. That is the whole point.
 */

import { keyWarning, resolveConfig } from './config.mjs'
import { memoryTileCache, tileKey } from './cache.mjs'
import { fetchGrid, fetchTile, fetchVectorGrid, fetchVectorTile } from './upstream.mjs'
import { isTileInGrid } from '../grid.mjs'

const HTTP_BAD_REQUEST = 400
const HTTP_NOT_FOUND = 404
const HTTP_BAD_GATEWAY = 502

/**
 * @param {object} options
 * @param {object} [options.config]   see resolveConfig
 * @param {object} [options.cache]    get/set, defaults to an in-process cache
 * @param {object} [options.logger]   console-compatible
 * @param {Function} [options.fetchImpl]
 */
export function createOsTilesPlugin(options = {}) {
  const config = resolveConfig(options.config)
  const logger = options.logger ?? console
  const fetchImpl = options.fetchImpl ?? fetch
  const cache =
    options.cache ??
    memoryTileCache({
      maxEntries: config.cacheMaxEntries,
      ttlSeconds: config.cacheTtlSeconds
    })

  /**
   * The raster and vector routes are the same proxy with different upstreams,
   * so each is described as a "flavour" and the handlers are built once.
   */
  function makeFlavour({ label, maxZoom, maxZoomHint, cacheLayer, contentType, fetchGridFn, fetchTileFn }) {
    // Capabilities are fetched once and reused. The grid is static for the
    // life of the product, and every tile request needs it for validation.
    let gridPromise = null
    function getGrid() {
      gridPromise ??= fetchGridFn(config, fetchImpl).catch((error) => {
        gridPromise = null // let a transient failure be retried
        throw error
      })
      return gridPromise
    }
    return { label, maxZoom, maxZoomHint, cacheLayer, contentType, fetchTileFn, getGrid }
  }

  const raster = makeFlavour({
    label: config.layer,
    maxZoom: config.maxZoom,
    maxZoomHint: 'If this key is on a Premium/PSGA plan, raise or unset OS_MAPS_MAX_ZOOM.',
    cacheLayer: config.layer,
    contentType: 'image/png',
    fetchGridFn: fetchGrid,
    fetchTileFn: async (coords) => {
      const { png, contentType } = await fetchTile(config, coords, fetchImpl)
      return { payload: png, contentType }
    }
  })

  const vector = makeFlavour({
    label: 'vector (ngd-base 27700)',
    maxZoom: config.vectorMaxZoom,
    maxZoomHint: 'The ngd-base tileset publishes zooms 0-15; raise OS_VECTOR_MAX_ZOOM only if OS do.',
    cacheLayer: 'ngd-base-27700',
    contentType: 'application/vnd.mapbox-vector-tile',
    fetchGridFn: fetchVectorGrid,
    fetchTileFn: async (coords) => {
      const { pbf, contentType } = await fetchVectorTile(config, coords, fetchImpl)
      return { payload: pbf, contentType }
    }
  })

  function tileHandlerFor(flavour) {
    return async function tileHandler(request, h) {
      const z = Number(request.params.z)
      const col = Number(request.params.col)
      const row = Number(request.params.row)

      let grid
      try {
        grid = await flavour.getGrid()
      } catch (error) {
        logger.error?.(`OS capabilities unavailable: ${error.message}`)
        return h.response({ error: error.message }).code(error.status ?? HTTP_BAD_GATEWAY)
      }

      // Validate before going upstream. Unbounded indices from a client must
      // never become an outbound request — that is how a proxy becomes an open
      // relay and how a cache gets poisoned with junk keys.
      if (!isTileInGrid(grid, z, col, row)) {
        return h
          .response({ error: `Tile ${z}/${col}/${row} is outside the ${flavour.label} grid` })
          .code(HTTP_NOT_FOUND)
      }
      // The flavour's maxZoom folds in the product's ceiling and (for raster)
      // the plan's. Rejecting here rather than upstream turns what would be a
      // burst of opaque 403s into one local, explicable 404.
      if (z > flavour.maxZoom) {
        return h
          .response({
            error:
              `Zoom ${z} exceeds max zoom ${flavour.maxZoom} for ${flavour.label}. ` +
              flavour.maxZoomHint
          })
          .code(HTTP_NOT_FOUND)
      }

      const key = tileKey({ layer: flavour.cacheLayer, z, col, row })
      const cached = await cache.get(key)
      if (cached) {
        return h.response(cached).type(flavour.contentType).header('x-tile-cache', 'hit')
      }

      try {
        const { payload, contentType } = await flavour.fetchTileFn({ z, col, row })
        await cache.set(key, payload)
        return h.response(payload).type(contentType).header('x-tile-cache', 'miss')
      } catch (error) {
        logger.error?.(`OS tile ${key} failed: ${error.message}`)
        return h.response({ error: error.message }).code(error.status ?? HTTP_BAD_GATEWAY)
      }
    }
  }

  function capabilitiesHandlerFor(flavour) {
    return async function capabilitiesHandler(_request, h) {
      try {
        const grid = await flavour.getGrid()
        // Serving the grid onward is what lets the PDF builder do exact tile
        // maths without holding a key or parsing OS's formats itself. maxZoom
        // rides along on the grid so consumers clamp to what this deployment
        // can actually fetch — a client must not have to know the plan to
        // pick a zoom, any more than it has to know the key.
        return h.response({
          layer: flavour.label,
          grid: { ...grid, maxZoom: flavour.maxZoom }
        })
      } catch (error) {
        logger.error?.(`OS capabilities unavailable: ${error.message}`)
        return h.response({ error: error.message }).code(error.status ?? HTTP_BAD_GATEWAY)
      }
    }
  }

  return {
    plugin: {
      name: 'os-tiles',
      version: '1.0.0',
      register(server) {
        const warning = keyWarning(config)
        if (warning) {
          logger.warn?.(warning)
        }

        server.route([
          {
            method: 'GET',
            path: `${config.routePrefix}/capabilities`,
            options: { auth: false },
            handler: capabilitiesHandlerFor(raster)
          },
          {
            method: 'GET',
            // `.png` is part of the path so the route cannot collide with
            // `/capabilities` and so browsers and CDNs see a file extension.
            path: `${config.routePrefix}/{z}/{col}/{row}.png`,
            options: { auth: false },
            handler: tileHandlerFor(raster)
          },
          // The vector flavour: same proxy, same validation and cache, a
          // different OS product upstream. `/vector` in the path keeps the
          // two capability documents distinct — their grids differ (512px
          // tiles vs 256px, and a deeper zoom range).
          {
            method: 'GET',
            path: `${config.routePrefix}/vector/capabilities`,
            options: { auth: false },
            handler: capabilitiesHandlerFor(vector)
          },
          {
            method: 'GET',
            path: `${config.routePrefix}/vector/{z}/{col}/{row}.pbf`,
            options: { auth: false },
            handler: tileHandlerFor(vector)
          }
        ])
      }
    },
    config,
    cache,
    // Exposed for tests and for a warm-up call at startup.
    getGrid: raster.getGrid,
    getVectorGrid: vector.getGrid
  }
}

export { HTTP_BAD_REQUEST, HTTP_NOT_FOUND, HTTP_BAD_GATEWAY }
