/**
 * Tile grid maths for a WMTS-style tile matrix set in a projected CRS.
 *
 * A grid is:
 *   { originX, originY, tileSize, resolutions }
 * where (originX, originY) is the TOP-LEFT corner of tile (0, 0) in CRS units,
 * tileSize is the tile edge in pixels, and resolutions[z] is CRS units per
 * pixel at zoom z. Rows increase southward from originY; columns increase
 * eastward from originX. That is the standard WMTS convention and the one OS
 * publishes for EPSG:27700.
 *
 * The grid is a PARAMETER, not a hard-coded constant, so the same code drives
 * the real OS basemap and the synthetic self-describing basemap used by the
 * offline proof. The test therefore exercises the production path.
 */

/**
 * OGC WMTS defines a standardised pixel size of 0.28 mm, so
 *   resolution (CRS units/px) = scaleDenominator * 0.00028
 * when the CRS unit is the metre.
 */
const OGC_STANDARD_PIXEL_METRES = 0.00028

/**
 * Build a grid from an OS WMTS GetCapabilities document.
 *
 * THIS IS THE ONLY SUPPORTED WAY TO GET THE REAL OS GRID. The numbers must
 * come from OS, not from memory or a blog post — an origin that is out by one
 * tile puts the whole basemap in the wrong place, and it will look plausible
 * while doing so.
 *
 * @param {string} xml  the GetCapabilities response body
 * @param {string} tileMatrixSetId  e.g. 'EPSG:27700'
 */
export function gridFromWmtsCapabilities(xml, tileMatrixSetId) {
  const setBlock = matchTileMatrixSet(xml, tileMatrixSetId)
  if (!setBlock) {
    throw new Error(`TileMatrixSet "${tileMatrixSetId}" not found in capabilities`)
  }

  const matrices = [...setBlock.matchAll(/<TileMatrix>([\s\S]*?)<\/TileMatrix>/g)]
    .map((match) => match[1])
    .map((block) => ({
      identifier: tagText(block, 'ows:Identifier') ?? tagText(block, 'Identifier'),
      scaleDenominator: Number(tagText(block, 'ScaleDenominator')),
      topLeftCorner: (tagText(block, 'TopLeftCorner') ?? '').trim().split(/\s+/).map(Number),
      tileWidth: Number(tagText(block, 'TileWidth')),
      // Matrix dimensions are per-level and, for a national grid like
      // EPSG:27700, are NOT 2^z square the way Web Mercator's are. Anything
      // validating tile indices must use these, not a 2^z assumption.
      matrixWidth: Number(tagText(block, 'MatrixWidth')),
      matrixHeight: Number(tagText(block, 'MatrixHeight'))
    }))
    .filter((matrix) => Number.isFinite(matrix.scaleDenominator))

  if (matrices.length === 0) {
    throw new Error(`TileMatrixSet "${tileMatrixSetId}" declared no TileMatrix entries`)
  }

  // Zoom 0 is the coarsest level, i.e. the largest scale denominator, so
  // ordering by descending denominator puts the levels in zoom order.
  matrices.sort((a, b) => b.scaleDenominator - a.scaleDenominator)

  const [originX, originY] = matrices[0].topLeftCorner
  for (const matrix of matrices) {
    const [x, y] = matrix.topLeftCorner
    if (x !== originX || y !== originY) {
      throw new Error(
        'TileMatrix levels declare different origins; this code assumes one shared origin'
      )
    }
  }

  return {
    originX,
    originY,
    tileSize: matrices[0].tileWidth,
    resolutions: matrices.map(
      (matrix) => matrix.scaleDenominator * OGC_STANDARD_PIXEL_METRES
    ),
    matrixWidths: matrices.map((matrix) => matrix.matrixWidth),
    matrixHeights: matrices.map((matrix) => matrix.matrixHeight)
  }
}

/**
 * Build a grid from an OGC API TileMatrixSet JSON document.
 *
 * This is the vector-tile counterpart of gridFromWmtsCapabilities, and the
 * same rule applies: THE NUMBERS MUST COME FROM OS. The 27700 tiling scheme
 * definition is published machine-readably at
 * /maps/vector/ngd/ota/v1/tilematrixsets/27700, and it is the grid the
 * ngd-base tileset's EPSG:27700 tiles are cut to (verified live: a tile
 * requested at coordinates computed from this document decodes to the
 * expected ground features).
 *
 * Unlike WMTS capabilities this format gives cellSize (metres per pixel)
 * directly, so there is no 0.28 mm scale-denominator dance.
 */
export function gridFromTileMatrixSetJson(document) {
  const matrices = (document.tileMatrices ?? [])
    .map((matrix) => ({
      id: Number(matrix.id),
      cellSize: Number(matrix.cellSize),
      pointOfOrigin: matrix.pointOfOrigin,
      tileWidth: Number(matrix.tileWidth),
      matrixWidth: Number(matrix.matrixWidth),
      matrixHeight: Number(matrix.matrixHeight)
    }))
    .filter((matrix) => Number.isFinite(matrix.cellSize))
    .sort((a, b) => a.id - b.id)

  if (matrices.length === 0) {
    throw new Error('TileMatrixSet document declared no tileMatrices')
  }

  const [originX, originY] = matrices[0].pointOfOrigin
  for (const matrix of matrices) {
    const [x, y] = matrix.pointOfOrigin
    if (x !== originX || y !== originY) {
      throw new Error(
        'TileMatrix levels declare different origins; this code assumes one shared origin'
      )
    }
  }

  return {
    originX,
    originY,
    tileSize: matrices[0].tileWidth,
    resolutions: matrices.map((matrix) => matrix.cellSize),
    matrixWidths: matrices.map((matrix) => matrix.matrixWidth),
    matrixHeights: matrices.map((matrix) => matrix.matrixHeight)
  }
}

/**
 * Whether (z, col, row) names a tile this grid actually has.
 *
 * grants-ui validates tile indices against 2^z, which is correct for Web
 * Mercator and wrong for EPSG:27700 — the British National Grid matrix is
 * rectangular and does not double cleanly per level. When capabilities gave us
 * MatrixWidth/MatrixHeight, use them; otherwise fall back to a bound derived
 * from the grid's own extent so an unbounded index can never be forwarded
 * upstream.
 */
export function isTileInGrid(grid, z, col, row) {
  if (!Number.isInteger(z) || !Number.isInteger(col) || !Number.isInteger(row)) {
    return false
  }
  if (z < 0 || z >= grid.resolutions.length || col < 0 || row < 0) {
    return false
  }

  const width = grid.matrixWidths?.[z]
  const height = grid.matrixHeights?.[z]
  if (Number.isFinite(width) && Number.isFinite(height)) {
    return col < width && row < height
  }

  // No capabilities to hand: bound by however many tiles span the grid at this
  // zoom, using a generous national extent. Still finite, still cheap.
  const span = tileSpanMetres(grid, z)
  const fallback = Math.ceil(FALLBACK_GRID_EXTENT_METRES / span)
  return col < fallback && row < fallback
}

// Great Britain fits comfortably inside 1400 km on both axes.
const FALLBACK_GRID_EXTENT_METRES = 1_400_000

function matchTileMatrixSet(xml, id) {
  for (const match of xml.matchAll(/<TileMatrixSet>([\s\S]*?)<\/TileMatrixSet>/g)) {
    const block = match[1]
    const identifier =
      tagText(block, 'ows:Identifier') ?? tagText(block, 'Identifier')
    if (identifier?.trim() === id) {
      return block
    }
  }
  return null
}

function tagText(xml, tag) {
  return xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1]
}

/** Metres covered by one tile edge at zoom z. */
export function tileSpanMetres(grid, z) {
  const resolution = grid.resolutions[z]
  if (resolution === undefined) {
    throw new Error(`Zoom ${z} is outside this grid (0..${grid.resolutions.length - 1})`)
  }
  return resolution * grid.tileSize
}

/**
 * The TOP-LEFT corner of tile (col, row) in CRS units.
 *
 * This is the value that makes registration exact: it is derived from the same
 * integers used to request the tile, so the tile image and this coordinate
 * describe the same square of ground by definition.
 */
export function tileTopLeft(grid, z, col, row) {
  const span = tileSpanMetres(grid, z)
  return [grid.originX + col * span, grid.originY - row * span]
}

/** Every tile index intersecting `extent` at zoom z. */
export function tilesCovering(grid, z, extent) {
  const span = tileSpanMetres(grid, z)
  const colMin = Math.floor((extent.minX - grid.originX) / span)
  const colMax = Math.floor((extent.maxX - grid.originX) / span)
  // Rows count southward, so maxY yields the smallest row index.
  const rowMin = Math.floor((grid.originY - extent.maxY) / span)
  const rowMax = Math.floor((grid.originY - extent.minY) / span)

  const tiles = []
  for (let row = rowMin; row <= rowMax; row++) {
    for (let col = colMin; col <= colMax; col++) {
      tiles.push({ z, col, row })
    }
  }
  return tiles
}

/**
 * Choose the coarsest zoom whose resolution still meets a target print
 * density for this frame.
 *
 * Sharpness and registration are independent: too coarse a zoom gives a soft
 * basemap, never a misaligned one. So this can be tuned freely without any
 * risk to alignment.
 */
const POINTS_PER_INCH = 72

export function pickZoom(grid, extent, frameWidthPoints, targetDpi = 200) {
  const neededPixels = (frameWidthPoints / POINTS_PER_INCH) * targetDpi
  const neededResolution = (extent.maxX - extent.minX) / neededPixels

  // Never pick a zoom the deployment cannot fetch. `grid.maxZoom` arrives from
  // the proxy's /capabilities and folds in both the product's ceiling and the
  // plan's, so the builder stays ignorant of OS plans and still never asks for
  // a tile that would 403. Too coarse a zoom costs sharpness only — never
  // registration — so clamping is always safe.
  const highest = Math.min(
    grid.resolutions.length - 1,
    grid.maxZoom ?? grid.resolutions.length - 1
  )

  for (let z = 0; z <= highest; z++) {
    if (grid.resolutions[z] <= neededResolution) {
      return z
    }
  }
  return highest
}

/**
 * The effective print resolution the chosen zoom actually delivers, so callers
 * can report it rather than guess.
 */
export function effectiveDpi(grid, z, extent, frameWidthPoints) {
  const pixels = (extent.maxX - extent.minX) / grid.resolutions[z]
  return pixels / (frameWidthPoints / POINTS_PER_INCH)
}
