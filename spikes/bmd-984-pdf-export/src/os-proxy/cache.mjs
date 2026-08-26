/**
 * Tile cache.
 *
 * Two implementations behind one tiny interface — `get(key)` / `set(key, buf)`:
 *
 *  - `memoryTileCache`  process-local, bounded, TTL'd. The default, and all the
 *    spike needs.
 *  - `redisTileCache`   the shape NRF uses (`nrf-frontend`'s
 *    `src/server/common/services/tile-cache.js`). Takes an ioredis-compatible
 *    client so this module never depends on ioredis itself.
 *
 * Caching matters more for PDFs than for browser maps. A browser user pans once
 * and their browser caches the result; a PDF re-fetches the same site's tiles on
 * every single download. One site map is ~30 tiles; the spike's per-habitat
 * basemap run fetched 112.
 */

const KEY_PREFIX = 'tile:'

export function tileKey({ layer, z, col, row }) {
  return `${layer}/${z}/${col}/${row}`
}

/**
 * Bounded, TTL'd, process-local cache.
 *
 * Insertion-ordered eviction (oldest first) rather than true LRU — for tiles
 * the difference is not worth a linked list, because a document fetches its
 * working set once and in a burst.
 */
export function memoryTileCache({ maxEntries = 2000, ttlSeconds = 3600 } = {}) {
  const entries = new Map()
  const ttlMs = ttlSeconds * 1000
  let hits = 0
  let misses = 0

  function evictIfFull() {
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value
      entries.delete(oldest)
    }
  }

  return {
    name: 'memory',

    async get(key, now = Date.now()) {
      const entry = entries.get(key)
      if (!entry) {
        misses += 1
        return null
      }
      if (entry.expiresAt <= now) {
        entries.delete(key)
        misses += 1
        return null
      }
      hits += 1
      return entry.buffer
    },

    async set(key, buffer, now = Date.now()) {
      // Re-inserting moves the key to the end of the iteration order, which is
      // what keeps eviction meaningful for keys that are re-fetched.
      entries.delete(key)
      entries.set(key, { buffer, expiresAt: now + ttlMs })
      evictIfFull()
    },

    async clear() {
      const count = entries.size
      entries.clear()
      return count
    },

    stats() {
      return { hits, misses, size: entries.size }
    }
  }
}

/**
 * Redis-backed cache, matching NRF's approach.
 *
 * `client` must provide `getBuffer` and `set` with ioredis' signatures — that
 * is exactly what `buildRedisClient` returns in both siblings, so this drops
 * in without a new dependency. A cache failure is logged and swallowed: a
 * missing cache must degrade to a slower request, never a failed one.
 */
export function redisTileCache({ client, ttlSeconds = 3600, logger = console }) {
  return {
    name: 'redis',

    async get(key) {
      try {
        return await client.getBuffer(`${KEY_PREFIX}${key}`)
      } catch (error) {
        logger.error?.(`Tile cache read failed for ${key}: ${error.message}`)
        return null
      }
    },

    async set(key, buffer) {
      try {
        await client.set(`${KEY_PREFIX}${key}`, buffer, 'EX', ttlSeconds)
      } catch (error) {
        logger.error?.(`Tile cache write failed for ${key}: ${error.message}`)
      }
    },

    stats() {
      return { hits: null, misses: null, size: null }
    }
  }
}
