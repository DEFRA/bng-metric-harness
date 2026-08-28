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

import { gridIntervalMetres, syntheticTileSource } from '../tiles.mjs'
import { tileSpanMetres, tileTopLeft } from '../grid.mjs'
import {
  DEFAULT_EXTENT, GEOMETRY_LINE, GEOMETRY_POLYGON, encodeVectorTile
} from '../mvt.mjs'

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

/**
 * The vector counterpart of stubCapabilities: an OGC API TileMatrixSet JSON
 * document with the same shape OS publishes at
 * /maps/vector/ngd/ota/v1/tilematrixsets/27700.
 */
export function stubTileMatrixSetJson(grid) {
  return {
    id: '27700',
    crs: 'http://www.opengis.net/def/crs/EPSG/0/27700',
    tileMatrices: grid.resolutions.map((resolution, z) => {
      const width =
        grid.matrixWidths?.[z] ?? Math.ceil(1_400_000 / (resolution * grid.tileSize))
      return {
        id: String(z),
        cellSize: resolution,
        pointOfOrigin: [grid.originX, grid.originY],
        tileWidth: grid.tileSize,
        tileHeight: grid.tileSize,
        matrixWidth: width,
        matrixHeight: grid.matrixHeights?.[z] ?? width
      }
    })
  }
}

/**
 * A synthetic VECTOR tile: the self-describing graticule again, as geometry.
 *
 * Same idea as the synthetic raster tile — every line is at a round
 * EPSG:27700 coordinate derived from the tile's own extent — but encoded as
 * MVT, so `--proxy-vector --graticule` proves the whole vector path offline:
 * proxy, cache, MVT decode, tile-local-to-world conversion and the page
 * transform. A misdecoded byte or a misplaced tile visibly breaks the
 * coincidence with the red overlay.
 *
 * Layers: `GB_land` (a full-tile square, exercising the real style) and
 * `Graticule` (_symbol 0 minor / 1 major, styled only for stub use).
 */
export function syntheticVectorTile(grid, z, col, row) {
  const span = tileSpanMetres(grid, z)
  const resolution = grid.resolutions[z]
  const [tileMinX, tileMaxY] = tileTopLeft(grid, z, col, row)
  const tileMaxX = tileMinX + span
  const tileMinY = tileMaxY - span
  const interval = gridIntervalMetres(resolution, grid.tileSize)
  const major = interval * 5
  const toLocal = (metres) => Math.round((metres / span) * DEFAULT_EXTENT)

  const lines = []
  for (let x = Math.ceil(tileMinX / interval) * interval; x <= tileMaxX; x += interval) {
    const px = toLocal(x - tileMinX)
    lines.push({
      symbol: isMultipleOf(x, major) ? 1 : 0,
      path: [[px, 0], [px, DEFAULT_EXTENT]]
    })
  }
  for (let y = Math.ceil(tileMinY / interval) * interval; y <= tileMaxY; y += interval) {
    // Northing increases upward; tile-local rows increase downward.
    const py = toLocal(tileMaxY - y)
    lines.push({
      symbol: isMultipleOf(y, major) ? 1 : 0,
      path: [[0, py], [DEFAULT_EXTENT, py]]
    })
  }

  const fullTile = [
    [0, 0], [DEFAULT_EXTENT, 0], [DEFAULT_EXTENT, DEFAULT_EXTENT], [0, DEFAULT_EXTENT]
  ]

  return encodeVectorTile([
    {
      name: 'GB_land',
      features: [{ type: GEOMETRY_POLYGON, properties: {}, paths: [fullTile] }]
    },
    {
      name: 'Graticule',
      features: lines.map(({ symbol, path }) => ({
        type: GEOMETRY_LINE,
        properties: { _symbol: symbol },
        paths: [path]
      }))
    }
  ])
}

const MULTIPLE_TOLERANCE = 1e-9

function isMultipleOf(value, step) {
  return Math.abs(value / step - Math.round(value / step)) < MULTIPLE_TOLERANCE
}

function textResponse(body, contentType, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: new Map([['content-type', contentType]]),
    text: async () => body,
    json: async () => JSON.parse(body),
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

    if (parsed.pathname.includes('/tilematrixsets/')) {
      return textResponse(JSON.stringify(stubTileMatrixSetJson(grid)), 'application/json')
    }

    // .../collections/{id}/tiles/27700/{z}/{row}/{col} — note ROW before
    // COLUMN, as OGC API Tiles orders them (and the raster ZXY does not).
    const vectorMatch = parsed.pathname.match(/\/tiles\/27700\/(\d+)\/(\d+)\/(\d+)$/)
    if (vectorMatch) {
      const [, z, row, col] = vectorMatch
      const pbf = syntheticVectorTile(grid, Number(z), Number(col), Number(row))
      return binaryResponse(pbf, 'application/vnd.mapbox-vector-tile')
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
