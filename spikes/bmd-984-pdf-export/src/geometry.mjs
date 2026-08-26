/**
 * Geometry helpers over GeoJSON in a projected CRS (here, EPSG:27700 metres).
 *
 * All of these exist in `bng-library/gpkg-io` already (`envelopeFromCoords`,
 * `expandEnvelope`, `polygonAreaSqm`). They are re-stated here only so the
 * spike runs with no dependencies; the library versions are the ones to keep.
 */

/** An envelope is { minX, minY, maxX, maxY } in CRS units. */
export function emptyEnvelope() {
  return {
    minX: Infinity,
    minY: Infinity,
    maxX: -Infinity,
    maxY: -Infinity
  }
}

export function isEmptyEnvelope(envelope) {
  return !(envelope.minX <= envelope.maxX && envelope.minY <= envelope.maxY)
}

export function extendEnvelope(envelope, [x, y]) {
  if (x < envelope.minX) {
    envelope.minX = x
  }
  if (x > envelope.maxX) {
    envelope.maxX = x
  }
  if (y < envelope.minY) {
    envelope.minY = y
  }
  if (y > envelope.maxY) {
    envelope.maxY = y
  }
  return envelope
}

/**
 * Walk every coordinate pair of any GeoJSON geometry, whatever its nesting
 * depth, and hand each one to `visit`.
 */
export function forEachCoordinate(geometry, visit) {
  if (!geometry) {
    return
  }
  if (geometry.type === 'GeometryCollection') {
    for (const child of geometry.geometries) {
      forEachCoordinate(child, visit)
    }
    return
  }
  walkCoordinates(geometry.coordinates, visit)
}

// A coordinate is a [number, number]; anything else is a list of them.
function walkCoordinates(node, visit) {
  if (typeof node?.[0] === 'number') {
    visit(node)
    return
  }
  for (const child of node ?? []) {
    walkCoordinates(child, visit)
  }
}

export function envelopeOf(geometry) {
  const envelope = emptyEnvelope()
  forEachCoordinate(geometry, (coordinate) =>
    extendEnvelope(envelope, coordinate)
  )
  return envelope
}

export function envelopeOfAll(geometries) {
  const envelope = emptyEnvelope()
  for (const geometry of geometries) {
    forEachCoordinate(geometry, (coordinate) =>
      extendEnvelope(envelope, coordinate)
    )
  }
  return envelope
}

/**
 * Grow an envelope by a fraction of its own size on every side.
 *
 * A degenerate envelope (a single point, or a perfectly straight line) has
 * zero extent on at least one axis, so a proportional pad would leave it
 * degenerate and the page transform would divide by zero. Those fall back to
 * a fixed metre pad.
 */
const DEGENERATE_PAD_METRES = 25

export function padEnvelope(envelope, fraction) {
  const width = envelope.maxX - envelope.minX
  const height = envelope.maxY - envelope.minY
  const padX = width > 0 ? width * fraction : DEGENERATE_PAD_METRES
  const padY = height > 0 ? height * fraction : DEGENERATE_PAD_METRES
  return {
    minX: envelope.minX - padX,
    minY: envelope.minY - padY,
    maxX: envelope.maxX + padX,
    maxY: envelope.maxY + padY
  }
}

/**
 * Planar area in square CRS units via the shoelace formula, exterior rings
 * only. Meaningful because the coordinates are metres on a projected grid.
 */
export function polygonAreaSqm(geometry) {
  if (geometry?.type === 'Polygon') {
    return Math.abs(ringArea(geometry.coordinates[0]))
  }
  if (geometry?.type === 'MultiPolygon') {
    return geometry.coordinates.reduce(
      (total, polygon) => total + Math.abs(ringArea(polygon[0])),
      0
    )
  }
  return 0
}

function ringArea(ring = []) {
  let sum = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1])
  }
  return sum / 2
}

/** Total length in CRS units of any linear geometry. */
export function lineLengthMetres(geometry) {
  let total = 0
  const addLine = (line) => {
    for (let i = 1; i < line.length; i++) {
      total += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1])
    }
  }
  if (geometry?.type === 'LineString') {
    addLine(geometry.coordinates)
  }
  if (geometry?.type === 'MultiLineString') {
    geometry.coordinates.forEach(addLine)
  }
  return total
}
