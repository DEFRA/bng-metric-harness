/**
 * Pure geometry helpers. No SQL, no GeoPackage. All polygons are closed rings
 * (first === last). All coordinates are [x, y] pairs in whatever units the
 * caller picks (this module is unit-agnostic; downstream uses BNG metres).
 */

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
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Test whether every vertex of a linestring lies strictly inside the
 * boundary ring.
 */
export function lineInsideRing(coords, boundary) {
  for (const p of coords) {
    if (!pointInRing(p, boundary)) return false;
  }
  return true;
}

export function expandEnvelope(envelope, env) {
  envelope[0] = Math.min(envelope[0], env[0]);
  envelope[1] = Math.max(envelope[1], env[1]);
  envelope[2] = Math.min(envelope[2], env[2]);
  envelope[3] = Math.max(envelope[3], env[3]);
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
    length += Math.sqrt(dx * dx + dy * dy);
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
  return [cx / (3 * twiceArea), cy / (3 * twiceArea)];
}

// ---------------------------------------------------------------------------
// Random helpers
// ---------------------------------------------------------------------------

export function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function randBetween(min, max) {
  return min + Math.random() * (max - min);
}

export function randInt(min, max) {
  return Math.floor(randBetween(min, max));
}

function randomPointInBBox(bbox) {
  return [randBetween(bbox[0], bbox[1]), randBetween(bbox[2], bbox[3])];
}

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
    while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), p) <= 0) {
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
export function generateIrregularPolygon(cx, cy, radius, numPoints = 18) {
  const pts = [];
  for (let i = 0; i < numPoints; i++) {
    const angle = Math.random() * 2 * Math.PI;
    const r = radius * (0.65 + Math.random() * 0.7);
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
    }
  }
  if (out.length < 3) return null;
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
  const angle = Math.random() * Math.PI;
  const normal = [Math.cos(angle), Math.sin(angle)];

  let minSd = Infinity;
  let maxSd = -Infinity;
  for (let i = 0; i < ring.length - 1; i++) {
    const s = (ring[i][0] - c[0]) * normal[0] + (ring[i][1] - c[1]) * normal[1];
    if (s < minSd) minSd = s;
    if (s > maxSd) maxSd = s;
  }
  const offset = randBetween(minSd * 0.3, maxSd * 0.3);
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

/**
 * Carve a piece of approximately `targetArea` off a convex polygon. Returns
 * { piece, rest, pieceArea } or null if no chord direction could produce a
 * valid split. Picks a random chord direction, then binary-searches the
 * chord offset so the kept-side area matches the target. The remaining
 * polygon is convex (Sutherland-Hodgman on a convex input is convex).
 */
export function carveTargetArea(ring, targetArea) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const angle = Math.random() * Math.PI;
    const normal = [Math.cos(angle), Math.sin(angle)];

    let minSd = Infinity;
    let maxSd = -Infinity;
    for (let i = 0; i < ring.length - 1; i++) {
      const s = ring[i][0] * normal[0] + ring[i][1] * normal[1];
      if (s < minSd) minSd = s;
      if (s > maxSd) maxSd = s;
    }
    // Binary search the chord offset for which the kept-side area === target.
    // Larger offset → smaller kept area (kept side is `p · normal >= offset`).
    let lo = minSd;
    let hi = maxSd;
    for (let iter = 0; iter < 32; iter++) {
      const mid = (lo + hi) / 2;
      const piece = clipPolygonByOffset(ring, normal, mid);
      const a = piece ? polygonArea(piece) : 0;
      if (a > targetArea) lo = mid;
      else hi = mid;
    }
    const piece = clipPolygonByOffset(ring, normal, hi);
    const rest = clipPolygonByOffset(ring, [-normal[0], -normal[1]], -hi);
    if (piece && rest && polygonArea(piece) > 1 && polygonArea(rest) > 1) {
      return { piece, rest, pieceArea: polygonArea(piece) };
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
  if (targetAreas.length === 0) return [];
  if (targetAreas.length === 1) return [ring];

  const indexed = targetAreas.map((a, i) => ({ area: a, idx: i }));
  // Carve largest first so the last (smallest) carve is least sensitive to
  // accumulated rounding error.
  indexed.sort((x, y) => y.area - x.area);

  const cells = new Array(targetAreas.length);
  let remaining = ring;

  for (let i = 0; i < indexed.length - 1; i++) {
    const { area, idx } = indexed[i];
    const carved = carveTargetArea(remaining, area);
    if (!carved) {
      // Geometry refused to cooperate — give up cleanly. Caller will see a
      // shorter array.
      return cells.filter((c) => c);
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
  if (currentArea <= 0) return ring;
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
export function partitionPolygon(ring, n, maxRetriesPerSplit = 5) {
  const parcels = [ring];
  while (parcels.length < n) {
    parcels.sort((a, b) => polygonArea(b) - polygonArea(a));
    const big = parcels[0];
    let split = null;
    for (let r = 0; r < maxRetriesPerSplit; r++) {
      const [a, b] = splitPolygonRandom(big);
      if (a && b && polygonArea(a) > 1 && polygonArea(b) > 1) {
        split = [a, b];
        break;
      }
    }
    if (!split) break;
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
export function pickInteriorPoint(boundaryRing, maxAttempts = 100) {
  const bbox = envelopeFromCoords(boundaryRing);
  for (let i = 0; i < maxAttempts; i++) {
    const p = randomPointInBBox(bbox);
    if (pointInRing(p, boundaryRing)) return p;
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
  if (!start || !end) return null;
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0) return null;
  const px = -dy / len;
  const py = dx / len;
  const numMid = 1 + randInt(0, 3);
  const maxOffset = len * 0.1;
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
