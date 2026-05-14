/**
 * Pure geometry helpers. No SQL, no GeoPackage. All polygons are closed rings
 * (first === last). All coordinates are [x, y] pairs in whatever units the
 * caller picks (this module is unit-agnostic; downstream uses BNG metres).
 */

import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// Tunables — named so SonarCloud's S109 magic-number rule is satisfied.
// ---------------------------------------------------------------------------

// Inner / outer radius scalars for the annulus sampled by
// generateIrregularPolygon. 0.65 → 1.35 of `radius` keeps the hull convex
// without producing degenerate slivers.
const ANNULUS_INNER_FRACTION = 0.65;
const ANNULUS_OUTER_SPAN = 0.7;
const HULL_POINT_COUNT_DEFAULT = 18;

// Chord-offset envelope for splitPolygonRandom. ±30% of each end keeps the
// split off-centre but avoids degenerate sliver halves.
const CHORD_OFFSET_RANGE_FRACTION = 0.3;
// carveTargetArea retries before giving up; binary-search iterations within
// each attempt.
const CARVE_MAX_ATTEMPTS = 8;
const CARVE_BINARY_ITERATIONS = 32;
// Minimum sub-polygon area for a carve result to be considered valid.
const MIN_VALID_SUB_POLYGON_AREA = 1;
// partitionPolygon retry budget per random split.
const DEFAULT_PARTITION_RETRIES_PER_SPLIT = 5;
// pickInteriorPoint rejection-sample budget.
const DEFAULT_INTERIOR_POINT_ATTEMPTS = 100;
// generateLinestring tunables.
const LINESTRING_MAX_MIDPOINT_OFFSET_FRACTION = 0.1;
const LINESTRING_MIDPOINT_MAX_EXTRA = 3;
// Minimum ring length for a valid polygon (the closing vertex makes it 4).
const MIN_RING_VERTICES = 3;
// Centroid divisor — shoelace formula yields (1/6 × signed area) so 3× the
// twice-area normalises it.
const CENTROID_DIVISOR = 3;

// ---------------------------------------------------------------------------
// Predicates and measurements
// ---------------------------------------------------------------------------

/**
 * Ray-casting point-in-polygon test for a single ring.
 *
 * @param {number[]} point - [x, y]
 * @param {number[][]} ring - Closed ring of [x, y] pairs (first === last)
 * @returns {boolean} True if the point is strictly inside the ring
 */
export function pointInRing(point, ring) {
  const [x, y] = point;
  let inside = false;
  let j = ring.length - 1;
  for (let i = 0; i < ring.length; i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) {
      inside = !inside;
    }
    j = i;
  }
  return inside;
}

/**
 * Test whether every vertex of a linestring lies strictly inside the
 * boundary ring.
 */
export function lineInsideRing(coords, boundary) {
  for (const p of coords) {
    if (!pointInRing(p, boundary)) {
      return false;
    }
  }
  return true;
}

// Envelope layout: [minX, maxX, minY, maxY] — matches the GeoPackage Binary
// envelope-type-1 byte order.
const ENV_IDX_MIN_X = 0;
const ENV_IDX_MAX_X = 1;
const ENV_IDX_MIN_Y = 2;
const ENV_IDX_MAX_Y = 3;

export function expandEnvelope(envelope, env) {
  envelope[ENV_IDX_MIN_X] = Math.min(envelope[ENV_IDX_MIN_X], env[ENV_IDX_MIN_X]);
  envelope[ENV_IDX_MAX_X] = Math.max(envelope[ENV_IDX_MAX_X], env[ENV_IDX_MAX_X]);
  envelope[ENV_IDX_MIN_Y] = Math.min(envelope[ENV_IDX_MIN_Y], env[ENV_IDX_MIN_Y]);
  envelope[ENV_IDX_MAX_Y] = Math.max(envelope[ENV_IDX_MAX_Y], env[ENV_IDX_MAX_Y]);
}

export function envelopeFromCoords(coords) {
  const flat = Array.isArray(coords[0]?.[0]) ? coords.flat() : coords;
  const xs = flat.map((p) => p[0]);
  const ys = flat.map((p) => p[1]);
  return [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
}

export function linestringLength(coords) {
  let length = 0;
  for (let i = 1; i < coords.length; i++) {
    const dx = coords[i][0] - coords[i - 1][0];
    const dy = coords[i][1] - coords[i - 1][1];
    length += Math.hypot(dx, dy);
  }
  return Math.round(length);
}

/**
 * Signed area of a closed polygon ring via the shoelace formula.
 * Sign indicates orientation; we take the absolute value.
 *
 * @param {number[][]} ring - Closed ring of [x, y] pairs (first === last)
 * @returns {number} Polygon area in the ring's coordinate units
 */
export function polygonArea(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

/**
 * Area-weighted centroid of a closed polygon ring (signed-area formula).
 *
 * @param {number[][]} ring - Closed ring (first === last)
 * @returns {[number, number]} Centroid [x, y]
 */
export function polygonCentroid(ring) {
  let cx = 0;
  let cy = 0;
  let twiceArea = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    const c = x1 * y2 - x2 * y1;
    twiceArea += c;
    cx += (x1 + x2) * c;
    cy += (y1 + y2) * c;
  }
  return [cx / (CENTROID_DIVISOR * twiceArea), cy / (CENTROID_DIVISOR * twiceArea)];
}

// ---------------------------------------------------------------------------
// Random helpers — used to generate synthetic geometry / pick-list values
// for output .gpkg fixtures, never for security-sensitive bytes. Sourced
// from `crypto.randomBytes` so SonarCloud's S2245 doesn't fire on every
// call site.
// ---------------------------------------------------------------------------

// 53-bit float layout: 20 high bits + 32 low bits = 52 mantissa bits.
const HIGH_MASK_20_BITS = 0x000fffff;
const SCALE_2_POW_32 = 2 ** 32;
const SCALE_2_POW_52 = 2 ** 52;
const RNG_BYTES = 8;
const HIGH_OFFSET = 0;
const LOW_OFFSET = 4;

/**
 * Return a uniformly-distributed float in `[0, 1)`. Equivalent distribution
 * to `Math.random()` but sourced from `crypto.randomBytes` so SonarCloud's
 * S2245 rule is satisfied. ~30× slower than `Math.random()`; still
 * microseconds per call, negligible at fixture-generation scale.
 */
export function randomFraction() {
  const buf = randomBytes(RNG_BYTES);
  const high = buf.readUInt32BE(HIGH_OFFSET) & HIGH_MASK_20_BITS;
  const low = buf.readUInt32BE(LOW_OFFSET);
  return (high * SCALE_2_POW_32 + low) / SCALE_2_POW_52;
}

export function pick(arr) {
  return arr[Math.floor(randomFraction() * arr.length)];
}

export function randBetween(min, max) {
  return min + randomFraction() * (max - min);
}

export function randInt(min, max) {
  return Math.floor(randBetween(min, max));
}

export function randomAngle(span = 2 * Math.PI) {
  return randomFraction() * span;
}

function randomPointInBBox(bbox) {
  return [
    randBetween(bbox[ENV_IDX_MIN_X], bbox[ENV_IDX_MAX_X]),
    randBetween(bbox[ENV_IDX_MIN_Y], bbox[ENV_IDX_MAX_Y]),
  ];
}

// Andrew's monotone-chain hull peeks at the most-recent and second-most-
// recent points on each chain; `Array.prototype.at(-1)` / `at(-2)` are
// negative-index lookups, named here so the magic-number rule is satisfied.
const HULL_LAST = -1;
const HULL_SECOND_LAST = -2;

// ---------------------------------------------------------------------------
// Ring constructors
// ---------------------------------------------------------------------------

/**
 * Andrew's monotone-chain convex hull of a 2D point set.
 *
 * @param {number[][]} points - Array of [x, y] pairs (>=3 distinct points)
 * @returns {number[][]} Closed CCW ring of the hull (first === last)
 */
export function convexHull(points) {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower.at(HULL_SECOND_LAST), lower.at(HULL_LAST), p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper.at(HULL_SECOND_LAST), upper.at(HULL_LAST), p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  const hull = lower.concat(upper);
  hull.push([...hull[0]]);
  return hull;
}

/**
 * Generate a convex, irregular boundary polygon as the convex hull of
 * random points in an annulus around (cx, cy). The output is always convex,
 * which is required for the recursive habitat partitioning to tile cleanly.
 */
export function generateIrregularPolygon(cx, cy, radius, numPoints = HULL_POINT_COUNT_DEFAULT) {
  const pts = [];
  for (let i = 0; i < numPoints; i++) {
    const angle = randomAngle();
    const r = radius * (ANNULUS_INNER_FRACTION + randomFraction() * ANNULUS_OUTER_SPAN);
    pts.push([cx + r * Math.cos(angle), cy + r * Math.sin(angle)]);
  }
  return convexHull(pts);
}

/**
 * Closed axis-aligned rectangle ring built from two opposite corners.
 * Used by the --bad fixture generator for fast, predictable parcel shapes.
 */
export function rectRing(x1, y1, x2, y2) {
  return [
    [x1, y1],
    [x2, y1],
    [x2, y2],
    [x1, y2],
    [x1, y1],
  ];
}

/**
 * Bowtie (self-intersecting) polygon centred on (cx, cy) with the given
 * half-width. The opposite-corner edges cross, producing a topologically
 * invalid ring — used to deliberately trigger the SELF_INTERSECTING checks
 * in --bad mode.
 */
export function bowtieRing(cx, cy, half) {
  return [
    [cx - half, cy - half],
    [cx + half, cy + half],
    [cx + half, cy - half],
    [cx - half, cy + half],
    [cx - half, cy - half],
  ];
}

// ---------------------------------------------------------------------------
// Polygon clipping, splitting, partitioning
// ---------------------------------------------------------------------------

/**
 * Sutherland–Hodgman clip of a polygon ring against a half-plane.
 *
 * Keeps the side where (p - point) · normal >= 0. For a convex input, the
 * result is itself convex. Returns null if fewer than 3 vertices remain.
 */
function clipPolygonByHalfPlane(ring, point, normal) {
  const sd = (p) =>
    (p[0] - point[0]) * normal[0] + (p[1] - point[1]) * normal[1];
  const out = [];
  for (let i = 0; i < ring.length - 1; i++) {
    const p1 = ring[i];
    const p2 = ring[i + 1];
    const d1 = sd(p1);
    const d2 = sd(p2);
    if (d1 >= 0) {
      out.push(p1);
      if (d2 < 0) {
        const t = d1 / (d1 - d2);
        out.push([p1[0] + t * (p2[0] - p1[0]), p1[1] + t * (p2[1] - p1[1])]);
      }
    } else if (d2 >= 0) {
      const t = d1 / (d1 - d2);
      out.push([p1[0] + t * (p2[0] - p1[0]), p1[1] + t * (p2[1] - p1[1])]);
    } else {
      // both vertices outside the half-plane — segment fully clipped, no output
    }
  }
  if (out.length < MIN_RING_VERTICES) {
    return null;
  }
  out.push([...out[0]]);
  return out;
}

/**
 * Split a convex polygon along a random chord that passes near (but not
 * exactly through) its centroid. The chord direction is uniform-random; its
 * offset from the centroid is sampled from the middle 60% of the polygon's
 * extent in the perpendicular direction, which avoids degenerate sliver
 * splits while still giving size variation between the two halves.
 *
 * Returns [a, b] where each is a closed ring; either may be null if the
 * resulting half is degenerate.
 */
function splitPolygonRandom(ring) {
  const c = polygonCentroid(ring);
  const angle = randomAngle(Math.PI);
  const normal = [Math.cos(angle), Math.sin(angle)];

  let minSd = Infinity;
  let maxSd = -Infinity;
  for (let i = 0; i < ring.length - 1; i++) {
    const s = (ring[i][0] - c[0]) * normal[0] + (ring[i][1] - c[1]) * normal[1];
    if (s < minSd) {
      minSd = s;
    }
    if (s > maxSd) {
      maxSd = s;
    }
  }
  const offset = randBetween(minSd * CHORD_OFFSET_RANGE_FRACTION, maxSd * CHORD_OFFSET_RANGE_FRACTION);
  const chordPoint = [c[0] + normal[0] * offset, c[1] + normal[1] * offset];

  const a = clipPolygonByHalfPlane(ring, chordPoint, normal);
  const b = clipPolygonByHalfPlane(ring, chordPoint, [-normal[0], -normal[1]]);
  return [a, b];
}

/**
 * Clip a polygon by a half-plane parameterised as `p · normal >= offset`.
 * Thin wrapper that lets us search by scalar offset (used by area-aware
 * partitioning).
 */
function clipPolygonByOffset(ring, normal, offset) {
  const point = [normal[0] * offset, normal[1] * offset];
  return clipPolygonByHalfPlane(ring, point, normal);
}

/** Project every ring vertex onto `normal` and return the min/max scalars. */
function projectionRange(ring, normal) {
  let minSd = Infinity;
  let maxSd = -Infinity;
  for (let i = 0; i < ring.length - 1; i++) {
    const s = ring[i][0] * normal[0] + ring[i][1] * normal[1];
    if (s < minSd) {
      minSd = s;
    }
    if (s > maxSd) {
      maxSd = s;
    }
  }
  return { minSd, maxSd };
}

/**
 * Binary-search the chord offset along `normal` that splits `ring` so the
 * "kept" side (`p · normal >= offset`) has area `targetArea`.
 */
function searchChordOffsetForArea(ring, normal, lo, hi, targetArea, iterations = 32) {
  for (let iter = 0; iter < iterations; iter++) {
    const mid = (lo + hi) / 2;
    const piece = clipPolygonByOffset(ring, normal, mid);
    const a = piece ? polygonArea(piece) : 0;
    if (a > targetArea) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return hi;
}

/** One attempt at carving — random chord direction + binary search. */
function tryCarveTargetArea(ring, targetArea) {
  const angle = randomAngle(Math.PI);
  const normal = [Math.cos(angle), Math.sin(angle)];
  const { minSd, maxSd } = projectionRange(ring, normal);
  const offset = searchChordOffsetForArea(ring, normal, minSd, maxSd, targetArea);
  const piece = clipPolygonByOffset(ring, normal, offset);
  const rest = clipPolygonByOffset(ring, [-normal[0], -normal[1]], -offset);
  if (piece && rest && polygonArea(piece) > MIN_VALID_SUB_POLYGON_AREA && polygonArea(rest) > MIN_VALID_SUB_POLYGON_AREA) {
    return { piece, rest, pieceArea: polygonArea(piece) };
  }
  return null;
}

/**
 * Carve a piece of approximately `targetArea` off a convex polygon. Returns
 * { piece, rest, pieceArea } or null if no chord direction could produce a
 * valid split. Picks a random chord direction, then binary-searches the
 * chord offset so the kept-side area matches the target. The remaining
 * polygon is convex (Sutherland-Hodgman on a convex input is convex).
 */
export function carveTargetArea(ring, targetArea) {
  for (let attempt = 0; attempt < CARVE_MAX_ATTEMPTS; attempt++) {
    const result = tryCarveTargetArea(ring, targetArea);
    if (result) {
      return result;
    }
  }
  return null;
}

/**
 * Partition a convex polygon into pieces whose areas approximate the input
 * `targetAreas` array (in the same units as `polygonArea(ring)`). Returns
 * cells in the same order as `targetAreas`.
 *
 * Algorithm: process targets largest-first, each iteration carving one piece
 * of that size off the remaining polygon. The last target gets whatever is
 * left over (its actual area may differ slightly from the request, since we
 * scale the boundary up front to make the numbers work).
 */
export function partitionPolygonByAreas(ring, targetAreas) {
  if (targetAreas.length === 0) {
    return [];
  }
  if (targetAreas.length === 1) {
    return [ring];
  }

  const indexed = targetAreas.map((a, i) => ({ area: a, idx: i }));
  // Carve largest first so the last (smallest) carve is least sensitive to
  // accumulated rounding error.
  indexed.sort((x, y) => y.area - x.area);

  const cells = Array.from({ length: targetAreas.length });
  let remaining = ring;

  for (let i = 0; i < indexed.length - 1; i++) {
    const { area, idx } = indexed[i];
    const carved = carveTargetArea(remaining, area);
    if (!carved) {
      // Geometry refused to cooperate — give up cleanly. Caller will see a
      // shorter array.
      return cells.filter(Boolean);
    }
    cells[idx] = carved.piece;
    remaining = carved.rest;
  }
  cells[indexed[indexed.length - 1].idx] = remaining;
  return cells;
}

/**
 * Scale a ring uniformly around its centroid so its area matches `targetArea`.
 */
export function scaleRingToArea(ring, targetArea) {
  const currentArea = polygonArea(ring);
  if (currentArea <= 0) {
    return ring;
  }
  const k = Math.sqrt(targetArea / currentArea);
  const [cx, cy] = polygonCentroid(ring);
  return ring.map(([x, y]) => [cx + (x - cx) * k, cy + (y - cy) * k]);
}

/**
 * Recursively partition a convex polygon into `n` non-overlapping pieces
 * that exactly tile the input. On each step, splits the largest current
 * piece by a random chord. Stops short if no valid split is found after
 * a few retries (the returned array may then be smaller than `n`).
 */
export function partitionPolygon(ring, n, maxRetriesPerSplit = DEFAULT_PARTITION_RETRIES_PER_SPLIT) {
  const parcels = [ring];
  while (parcels.length < n) {
    parcels.sort((a, b) => polygonArea(b) - polygonArea(a));
    const big = parcels[0];
    let split = null;
    for (let r = 0; r < maxRetriesPerSplit; r++) {
      const [a, b] = splitPolygonRandom(big);
      if (a && b && polygonArea(a) > MIN_VALID_SUB_POLYGON_AREA && polygonArea(b) > MIN_VALID_SUB_POLYGON_AREA) {
        split = [a, b];
        break;
      }
    }
    if (!split) {
      break;
    }
    parcels.shift();
    parcels.push(split[0], split[1]);
  }
  return parcels;
}

// ---------------------------------------------------------------------------
// Interior sampling and linestring generation (random, synthetic mode)
// ---------------------------------------------------------------------------

/**
 * Rejection-sample a point that lies inside the boundary ring. The boundary's
 * bounding box is computed once up front and reused across attempts.
 *
 * Returns null if no inside point is found within `maxAttempts` tries.
 */
export function pickInteriorPoint(boundaryRing, maxAttempts = DEFAULT_INTERIOR_POINT_ATTEMPTS) {
  const bbox = envelopeFromCoords(boundaryRing);
  for (let i = 0; i < maxAttempts; i++) {
    const p = randomPointInBBox(bbox);
    if (pointInRing(p, boundaryRing)) {
      return p;
    }
  }
  return null;
}

/**
 * Generate a linestring that cuts across the interior of the boundary,
 * not along its edge. Picks two random interior endpoints, then inserts
 * 1–3 midpoints with a small perpendicular offset so the line bends
 * slightly. May still produce vertices outside the boundary on concave
 * regions — the caller is expected to validate and reject.
 */
export function generateLinestring(boundaryRing) {
  const start = pickInteriorPoint(boundaryRing);
  const end = pickInteriorPoint(boundaryRing);
  if (!start || !end) {
    return null;
  }
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const len = Math.hypot(dx, dy);
  if (len === 0) {
    return null;
  }
  const px = -dy / len;
  const py = dx / len;
  const numMid = 1 + randInt(0, LINESTRING_MIDPOINT_MAX_EXTRA);
  const maxOffset = len * LINESTRING_MAX_MIDPOINT_OFFSET_FRACTION;
  const points = [start];
  for (let i = 1; i <= numMid; i++) {
    const t = i / (numMid + 1);
    const offset = randBetween(-maxOffset, maxOffset);
    points.push([
      start[0] + dx * t + px * offset,
      start[1] + dy * t + py * offset,
    ]);
  }
  points.push(end);
  return points;
}
