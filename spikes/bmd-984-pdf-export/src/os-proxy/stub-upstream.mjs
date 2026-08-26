/**
 * A stand-in for api.os.uk.
 *
 * Returns a `fetch`-compatible function, so it substitutes for the real thing
 * at the same seam the CDP proxy uses — no HTTP server, no network, no key.
 * The proxy under test is the real proxy; only the upstream is fake.
 *
 * The tiles it serves are the SAME self-describing tiles the offline
 * registration proof uses: each one draws a grid at round EPSG:27700
 * coordinates. So the `--graticule` check still works end to end through the
 * proxy, cache and all — if a tile came back for the wrong z/col/row, or the
 * proxy mangled the coordinates, the overlay would visibly stop lining up.
 */

import { syntheticTileSource } from '../tiles.mjs'

/**
 * A capabilities document with the same shape OS publishes for EPSG:27700:
 * one shared top-left origin, 256px tiles, resolutions halving per level, and
 * per-level MatrixWidth/MatrixHeight (which, unlike Web Mercator, are not
 * 2^z square).
 */
export function stubCapabilities(grid, tileMatrixSetId = 'EPSG:27700') {
  const levels = grid.resolutions
    .map((resolution, z) => {
      const scaleDenominator = resolution / 0.00028
      const width = grid.matrixWidths?.[z] ?? Math.ceil(1_400_000 / (resolution * grid.tileSize))
      const height = grid.matrixHeights?.[z] ?? width
      return `
        <TileMatrix>
          <ows:Identifier>${z}</ows:Identifier>
          <ScaleDenominator>${scaleDenominator}</ScaleDenominator>
          <TopLeftCorner>${grid.originX} ${grid.originY}</TopLeftCorner>
          <TileWidth>${grid.tileSize}</TileWidth>
          <TileHeight>${grid.tileSize}</TileHeight>
          <MatrixWidth>${width}</MatrixWidth>
          <MatrixHeight>${height}</MatrixHeight>
        </TileMatrix>`
    })
    .join('')

  return `<?xml version="1.0" encoding="UTF-8"?>
<Capabilities xmlns:ows="http://www.opengis.net/ows/1.1">
  <Contents>
    <TileMatrixSet>
      <ows:Identifier>${tileMatrixSetId}</ows:Identifier>
      ${levels}
    </TileMatrixSet>
  </Contents>
</Capabilities>`
}

function textResponse(body, contentType, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: new Map([['content-type', contentType]]),
    text: async () => body,
    arrayBuffer: async () => Buffer.from(body)
  }
}

function binaryResponse(buffer, contentType) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: (name) => (name === 'content-type' ? contentType : null) },
    text: async () => buffer.toString('latin1'),
    arrayBuffer: async () => buffer
  }
}

function errorResponse(status, message) {
  return {
    ok: false,
    status,
    statusText: message,
    headers: { get: () => 'application/json' },
    text: async () => JSON.stringify({ error: message }),
    arrayBuffer: async () => Buffer.from(JSON.stringify({ error: message }))
  }
}

/**
 * @param {object} grid          the tile matrix the stub should claim to have
 * @param {object} [options]
 * @param {string} [options.expectKey]  reject requests without this key, the
 *   way OS rejects a key whose project lacks the OS Maps API product
 * @returns {{ fetch: Function, calls: Array }}
 */
export function stubOsFetch(grid, { expectKey = null } = {}) {
  const tile = syntheticTileSource()
  const calls = []

  async function stubFetch(url) {
    const parsed = new URL(url)
    calls.push(parsed.pathname + parsed.search)

    if (expectKey && parsed.searchParams.get('key') !== expectKey) {
      return errorResponse(401, 'Unauthorized')
    }

    if (parsed.searchParams.get('request') === 'GetCapabilities') {
      return textResponse(stubCapabilities(grid), 'application/xml')
    }

    // .../{layer}/{z}/{x}/{y}.png
    const match = parsed.pathname.match(/\/([^/]+)\/(\d+)\/(\d+)\/(\d+)\.png$/)
    if (!match) {
      return errorResponse(404, `Stub has no route for ${parsed.pathname}`)
    }

    const [, , z, col, row] = match
    const { png } = tile(grid, Number(z), Number(col), Number(row))
    return binaryResponse(png, 'image/png')
  }

  return { fetch: stubFetch, calls }
}
