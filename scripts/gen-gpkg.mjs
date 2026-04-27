#!/usr/bin/env node

/**
 * Generates a realistic BNG GeoPackage matching the Natural England
 * statutory biodiversity metric QGIS template schema.
 *
 * Produces a single file with all 5 feature layers:
 *   Red Line Boundary, Habitats, Hedgerows, Rivers, Urban Trees
 *
 * Geometry and attribute values are randomised on each run — the same inputs
 * will produce different output each time.
 *
 * Usage:
 *   node scripts/gen-gpkg.mjs
 *   node scripts/gen-gpkg.mjs --size 20
 *   node scripts/gen-gpkg.mjs --count 10
 *   node scripts/gen-gpkg.mjs --outdir /tmp/test-data
 *   node scripts/gen-gpkg.mjs --bad
 *   node scripts/gen-gpkg.mjs --from path/to/MetricWorkbook.xlsx
 *   node scripts/gen-gpkg.mjs --from "https://github.com/abitatdotdev/bng-metrics/blob/main/metrics/CAMBRIDGE_24_02948_FUL.xlsx"
 *   node scripts/gen-gpkg.mjs --from-list workbook-urls.txt
 *   node scripts/gen-gpkg.mjs --inspect path/to/MetricWorkbook.xlsx
 *
 * Options:
 *   --size <n>      Overall fixture size — sets habitat parcel count and
 *                   scales hedgerow, river, and urban tree counts from it.
 *                   Ignored when --from / --from-list is set (parcel counts
 *                   come from the workbook). (default: 50)
 *   --count <n>     Generate n different GeoPackages in one run, each with
 *                   its own randomised RLB shape, habitat partition, and
 *                   attribute values. Files are numbered
 *                   bng-test-data-001.gpkg, bng-test-data-002.gpkg, ...
 *                   When >1, existing files are overwritten without prompt.
 *                   (default: 1)
 *   --outdir <dir>  Output directory (default: test-data/)
 *   --from <ref>    Drive generation from a Defra Statutory Biodiversity
 *                   Metric workbook (xlsx/xlsm). Accepts a local file path or
 *                   an HTTPS URL. GitHub blob URLs are auto-rewritten to the
 *                   LFS-aware media URL. Downloaded files are cached in
 *                   .cache/bng500/. The output filename is derived from the
 *                   workbook (e.g. CAMBRIDGE_24_02948_FUL.gpkg).
 *   --from-list <f> Newline-delimited file of paths/URLs; runs --from for
 *                   each entry. Existing files are overwritten without prompt.
 *   --strict-habitats
 *                   Skip workbook habitat rows whose (habitat, condition)
 *                   pair the prototype's metric tables would reject.
 *                   Without this flag, all rows are emitted as-is — useful
 *                   for testing the prototype's error handling against
 *                   real-world data.
 *   --inspect       Print a JSON summary of the workbook (--from required)
 *                   without writing any GeoPackage. Use to debug parsing.
 *   --centre <e,n>  Easting,Northing of the Red Line Boundary centre, in
 *                   British National Grid (EPSG:27700). Defaults to
 *                   530000,180000 (Maidenhead). Examples:
 *                     --centre 545000,258000   (central Cambridge)
 *                     --centre 393000,93000    (central Bournemouth)
 *                     --centre 528000,357000   (central Nottingham)
 *                   Must be inside England for the prototype to accept the
 *                   uploaded GeoPackage.
 *   --bad           Generate an intentionally invalid GeoPackage for testing
 *                   upload validation. Currently omits the Red Line Boundary
 *                   layer.
 */

import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { color, error, header, info, warn } from "./_lib.mjs";
import { conditionScores as metricConditionScores } from "./data/metric-values-habitat-condition.mjs";
import { distinctivenessCategories as metricDistinctiveness } from "./data/metric-values-habitat-distinctiveness.mjs";
import { readMetricWorkbook } from "./lib/metric-workbook.mjs";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const { values: args } = parseArgs({
  options: {
    size: { type: "string", default: "50" },
    count: { type: "string", default: "1" },
    outdir: { type: "string", default: "" },
    bad: { type: "boolean", default: false },
    from: { type: "string", default: "" },
    "from-list": { type: "string", default: "" },
    "strict-habitats": { type: "boolean", default: false },
    inspect: { type: "boolean", default: false },
    centre: { type: "string", default: "" },
  },
  allowPositionals: false,
});

const HARNESS_ROOT = path.resolve(import.meta.dirname, "..");
const OUT_DIR = args.outdir
  ? path.resolve(args.outdir)
  : path.resolve(HARNESS_ROOT, "test-data");

// Restrict to inland broad types — fixture site is land-based, so coastal,
// intertidal, rocky-shore etc. are out of scope. Also skips any habitat the
// metric defines as non-area (e.g. "Individual trees", "Watercourse footprint",
// "Infrastructure (IGGI)"), which belong on other layers or aren't applicable.
const INLAND_BROAD_TYPES = new Set([
  "Cropland",
  "Grassland",
  "Heathland and shrub",
  "Lakes",
  "Sparsely vegetated land",
  "Urban",
  "Wetland",
  "Woodland and forest",
]);

/** @type {{ fullName: string, broad: string, type: string, validConditions: string[], distinctiveness: string }[]} */
const HABITATS = [];
const HABITATS_BY_BROAD = {};

for (const fullName of Object.keys(metricDistinctiveness)) {
  const sepIdx = fullName.indexOf(" - ");
  if (sepIdx < 0) continue;
  const broad = fullName.slice(0, sepIdx);
  const type = fullName.slice(sepIdx + 3);
  if (!INLAND_BROAD_TYPES.has(broad)) continue;

  const conds = metricConditionScores[fullName];
  if (!conds) continue;
  const validConditions = Object.entries(conds)
    .filter(([, v]) => typeof v === "number")
    .map(([k]) => k);
  if (validConditions.length === 0) continue;

  const habitat = {
    fullName,
    broad,
    type,
    validConditions,
    distinctiveness: metricDistinctiveness[fullName],
  };
  HABITATS.push(habitat);
  (HABITATS_BY_BROAD[broad] = HABITATS_BY_BROAD[broad] || []).push(habitat);
}

const BROAD_HABITAT_TYPES = Object.keys(HABITATS_BY_BROAD);

// Hedgerows / Rivers / Urban Trees use their own metric tables; the prototype
// validates them separately. Until the same wiring is added for those layers,
// keep the generic enum lists used previously.
const CONDITIONS = ["Good", "Fairly Good", "Moderate", "Fairly Poor", "Poor"];
const DISTINCTIVENESS = ["V.High", "High", "Medium", "Low", "V.Low"];

const STRATEGIC_SIGNIFICANCE = [
  "Formally identified in local strategy",
  "Location ecologically desirable but not in local strategy",
  "Area/compensation not in local strategy/ no local strategy",
];

const RETENTION_CATEGORIES = ["Retained", "Enhanced", "Lost", "Created"];

const LOCATIONS = ["On-site", "Off-site"];

const SPATIAL_RISK_HABITAT = [
  "Compensation inside LPA boundary or NCA of impact site",
  "Compensation outside LPA or NCA of impact site, but in neighbouring LPA or NCA",
];

const HEDGE_TYPES = [
  "Species-rich native hedgerow with trees",
  "Species-rich native hedgerow",
  "Native hedgerow with trees",
  "Native hedgerow",
  "Native hedgerow - associated with bank or ditch",
  "Line of trees",
  "Non-native and ornamental hedgerow",
];

const HEDGE_CONDITIONS = ["Good", "Moderate", "Poor"];

const RIVER_TYPES = [
  "Priority habitat",
  "Other rivers and streams",
  "Ditches",
  "Canals",
  "Culvert",
];

const ENCROACHMENT_WATERCOURSE = ["No Encroachment", "Minor", "Major"];

const ENCROACHMENT_RIPARIAN = [
  "Major/Major",
  "Major/Moderate",
  "Moderate/Moderate",
  "Minor/Minor",
  "Minor/No Encroachment",
  "No Encroachment/No Encroachment",
];

const SPATIAL_RISK_RIVER = [
  "Within waterbody catchment",
  "Outside waterbody catchment, but within operational catchment",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Ray-casting point-in-polygon test for a single ring.
 *
 * @param {number[]} point - [x, y]
 * @param {number[][]} ring - Closed ring of [x, y] pairs (first === last)
 * @returns {boolean} True if the point is strictly inside the ring
 */
function pointInRing(point, ring) {
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
function lineInsideRing(coords, boundary) {
  for (const p of coords) {
    if (!pointInRing(p, boundary)) return false;
  }
  return true;
}

function expandEnvelope(envelope, env) {
  envelope[0] = Math.min(envelope[0], env[0]);
  envelope[1] = Math.max(envelope[1], env[1]);
  envelope[2] = Math.min(envelope[2], env[2]);
  envelope[3] = Math.max(envelope[3], env[3]);
}

function linestringLength(coords) {
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
function polygonArea(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randBetween(min, max) {
  return min + Math.random() * (max - min);
}

function randInt(min, max) {
  return Math.floor(randBetween(min, max));
}

// ---------------------------------------------------------------------------
// Geometry generators (EPSG:27700 — British National Grid)
// ---------------------------------------------------------------------------

/**
 * Andrew's monotone-chain convex hull of a 2D point set.
 *
 * @param {number[][]} points - Array of [x, y] pairs (>=3 distinct points)
 * @returns {number[][]} Closed CCW ring of the hull (first === last)
 */
function convexHull(points) {
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
function generateIrregularPolygon(cx, cy, radius, numPoints = 18) {
  const pts = [];
  for (let i = 0; i < numPoints; i++) {
    const angle = Math.random() * 2 * Math.PI;
    const r = radius * (0.65 + Math.random() * 0.7);
    pts.push([cx + r * Math.cos(angle), cy + r * Math.sin(angle)]);
  }
  return convexHull(pts);
}

/**
 * Area-weighted centroid of a closed polygon ring (signed-area formula).
 *
 * @param {number[][]} ring - Closed ring (first === last)
 * @returns {[number, number]} Centroid [x, y]
 */
function polygonCentroid(ring) {
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
    const s =
      (ring[i][0] - c[0]) * normal[0] + (ring[i][1] - c[1]) * normal[1];
    if (s < minSd) minSd = s;
    if (s > maxSd) maxSd = s;
  }
  const offset = randBetween(minSd * 0.3, maxSd * 0.3);
  const chordPoint = [
    c[0] + normal[0] * offset,
    c[1] + normal[1] * offset,
  ];

  const a = clipPolygonByHalfPlane(ring, chordPoint, normal);
  const b = clipPolygonByHalfPlane(ring, chordPoint, [-normal[0], -normal[1]]);
  return [a, b];
}

/**
 * Clip a polygon by a half-plane parameterised as `p · normal >= offset`.
 * Thin wrapper over `clipPolygonByHalfPlane` that lets us search by scalar
 * offset (used by area-aware partitioning).
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
function carveTargetArea(ring, targetArea) {
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
function partitionPolygonByAreas(ring, targetAreas) {
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
function scaleRingToArea(ring, targetArea) {
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
function partitionPolygon(ring, n, maxRetriesPerSplit = 5) {
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

/**
 * Rejection-sample a point that lies inside the boundary ring. The boundary's
 * bounding box is computed once up front and reused across attempts.
 *
 * Returns null if no inside point is found within `maxAttempts` tries.
 */
function pickInteriorPoint(boundaryRing, maxAttempts = 100) {
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
function generateLinestring(boundaryRing) {
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

function randomPointInBBox(bbox) {
  return [randBetween(bbox[0], bbox[1]), randBetween(bbox[2], bbox[3])];
}

// ---------------------------------------------------------------------------
// WKB encoding (little-endian)
// ---------------------------------------------------------------------------

function writeDouble(buf, offset, val) {
  buf.writeDoubleLE(val, offset);
  return offset + 8;
}

function writeUInt32(buf, offset, val) {
  buf.writeUInt32LE(val, offset);
  return offset + 4;
}

/**
 * Encode a point as WKB (Well-Known Binary), little-endian.
 *
 * Layout: byteOrder (1) | wkbType (uint32 = 1) | x (float64) | y (float64)
 *
 * @param {number} x - X coordinate
 * @param {number} y - Y coordinate
 * @returns {Buffer} WKB-encoded point
 * @see https://www.ogc.org/standard/sfa/ - OGC Simple Features (WKB encoding)
 */
function encodeWkbPoint(x, y) {
  const buf = Buffer.alloc(1 + 4 + 16);
  let off = 0;
  buf[off++] = 1;
  off = writeUInt32(buf, off, 1);
  off = writeDouble(buf, off, x);
  writeDouble(buf, off, y);
  return buf;
}

/**
 * Encode a linestring as WKB (Well-Known Binary), little-endian.
 *
 * Layout: byteOrder (1) | wkbType (uint32 = 2) | numPoints (uint32) | points (x,y float64 pairs)
 *
 * @param {number[][]} coords - Array of [x, y] coordinate pairs
 * @returns {Buffer} WKB-encoded linestring
 * @see https://www.ogc.org/standard/sfa/ - OGC Simple Features (WKB encoding)
 */
function encodeWkbLineString(coords) {
  const buf = Buffer.alloc(1 + 4 + 4 + coords.length * 16);
  let off = 0;
  buf[off++] = 1;
  off = writeUInt32(buf, off, 2);
  off = writeUInt32(buf, off, coords.length);
  for (const [x, y] of coords) {
    off = writeDouble(buf, off, x);
    off = writeDouble(buf, off, y);
  }
  return buf;
}

/**
 * Encode a polygon as WKB (Well-Known Binary), little-endian.
 *
 * Layout: byteOrder (1) | wkbType (uint32 = 3) | numRings (uint32) |
 *         for each ring: numPoints (uint32) | points (x,y float64 pairs)
 *
 * The first ring is the exterior boundary; any subsequent rings are interior
 * holes (not currently used by this script).
 *
 * @param {number[][][]} rings - Array of rings, each an array of [x, y] coordinate pairs
 * @returns {Buffer} WKB-encoded polygon
 * @see https://www.ogc.org/standard/sfa/ - OGC Simple Features (WKB encoding)
 */
function encodeWkbPolygon(rings) {
  let size = 1 + 4 + 4;
  for (const ring of rings) {
    size += 4 + ring.length * 16;
  }
  const buf = Buffer.alloc(size);
  let off = 0;
  buf[off++] = 1;
  off = writeUInt32(buf, off, 3);
  off = writeUInt32(buf, off, rings.length);
  for (const ring of rings) {
    off = writeUInt32(buf, off, ring.length);
    for (const [x, y] of ring) {
      off = writeDouble(buf, off, x);
      off = writeDouble(buf, off, y);
    }
  }
  return buf;
}

// ---------------------------------------------------------------------------
// GeoPackage Binary encoding (header + WKB)
// ---------------------------------------------------------------------------

/**
 * Wraps a WKB geometry in a GeoPackage Binary header.
 *
 * Layout: magic ("GP") | version (0) | flags | srsId (uint32) | [envelope] | wkb
 *
 * The flags byte encodes byte order (bit 0, always 1 = little-endian) and
 * envelope type (bits 1-3). When an envelope is provided, type 1 is used
 * which stores [minX, maxX, minY, maxY] as four doubles (32 bytes).
 *
 * @param {number} srsId - Spatial reference system ID (e.g. 27700)
 * @param {Buffer} wkb - Well-Known Binary encoded geometry
 * @param {number[]|null} envelope - Bounding box [minX, maxX, minY, maxY], or null for no envelope
 * @returns {Buffer} GeoPackage Binary blob ready to store in a geometry column
 * @see https://www.geopackage.org/spec/#gpb_format - GeoPackage Binary format spec
 * @see https://www.ogc.org/standard/sfa/ - OGC Simple Features (WKB encoding)
 */
function encodeGpkgBinary(srsId, wkb, envelope) {
  const envType = envelope ? 1 : 0;
  const flags = 0x01 | (envType << 1);
  const envSize = envelope ? 32 : 0;
  const headerSize = 2 + 1 + 1 + 4 + envSize;
  const buf = Buffer.alloc(headerSize + wkb.length);
  let off = 0;
  buf[off++] = 0x47; // 'G'
  buf[off++] = 0x50; // 'P'
  buf[off++] = 0;
  buf[off++] = flags;
  off = writeUInt32(buf, off, srsId);
  if (envelope) {
    off = writeDouble(buf, off, envelope[0]);
    off = writeDouble(buf, off, envelope[1]);
    off = writeDouble(buf, off, envelope[2]);
    off = writeDouble(buf, off, envelope[3]);
  }
  wkb.copy(buf, off);
  return buf;
}

function envelopeFromCoords(coords) {
  const flat = Array.isArray(coords[0]?.[0]) ? coords.flat() : coords;
  const xs = flat.map((p) => p[0]);
  const ys = flat.map((p) => p[1]);
  return [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
}

function gpkgPolygon(srsId, ring) {
  return encodeGpkgBinary(srsId, encodeWkbPolygon([ring]), envelopeFromCoords(ring));
}

function gpkgLineString(srsId, coords) {
  return encodeGpkgBinary(srsId, encodeWkbLineString(coords), envelopeFromCoords(coords));
}

function gpkgPoint(srsId, x, y) {
  return encodeGpkgBinary(srsId, encodeWkbPoint(x, y), [x, x, y, y]);
}

// ---------------------------------------------------------------------------
// GeoPackage schema creation
// ---------------------------------------------------------------------------

const SRS_ID = 27700;

const SRS_27700_DEF = `PROJCS["OSGB 1936 / British National Grid",GEOGCS["OSGB 1936",DATUM["OSGB_1936",SPHEROID["Airy 1830",6377563.396,299.3249646]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",49],PARAMETER["central_meridian",-2],PARAMETER["scale_factor",0.9996012717],PARAMETER["false_easting",400000],PARAMETER["false_northing",-100000],UNIT["metre",1]]`;

/**
 * Initialise a SQLite database as a valid GeoPackage by setting the required
 * pragmas and creating the three mandatory metadata tables:
 *
 * - `gpkg_spatial_ref_sys` — spatial reference system definitions
 * - `gpkg_contents` — registry of feature/tile tables in the file
 * - `gpkg_geometry_columns` — geometry column metadata per feature table
 *
 * Pre-populates the SRS table with WGS 84 (4326) and British National Grid (27700).
 *
 * @param {import("better-sqlite3").Database} db - An open better-sqlite3 database
 * @see https://www.geopackage.org/spec/#_requirement-1 - GeoPackage required tables
 */
function initGeoPackage(db) {
  db.pragma("journal_mode = WAL");
  db.pragma("application_id = 0x47504B47");
  db.pragma("user_version = 10301");

  db.exec(`
    CREATE TABLE IF NOT EXISTS gpkg_spatial_ref_sys (
      srs_name TEXT NOT NULL, srs_id INTEGER NOT NULL PRIMARY KEY,
      organization TEXT NOT NULL, organization_coordsys_id INTEGER NOT NULL,
      definition TEXT NOT NULL, description TEXT
    );
    INSERT OR IGNORE INTO gpkg_spatial_ref_sys VALUES
      ('Undefined cartesian SRS', -1, 'NONE', -1, 'undefined', 'undefined cartesian coordinate reference system'),
      ('Undefined geographic SRS', 0, 'NONE', 0, 'undefined', 'undefined geographic coordinate reference system'),
      ('WGS 84 geodetic', 4326, 'EPSG', 4326,
        'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]',
        'longitude/latitude coordinates in decimal degrees on the WGS 84 spheroid'),
      ('OSGB 1936 / British National Grid', ${SRS_ID}, 'EPSG', ${SRS_ID},
        '${SRS_27700_DEF}', 'British National Grid');

    CREATE TABLE IF NOT EXISTS gpkg_contents (
      table_name TEXT NOT NULL PRIMARY KEY, data_type TEXT NOT NULL DEFAULT 'features',
      identifier TEXT UNIQUE, description TEXT DEFAULT '',
      last_change DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      min_x DOUBLE, min_y DOUBLE, max_x DOUBLE, max_y DOUBLE,
      srs_id INTEGER REFERENCES gpkg_spatial_ref_sys(srs_id)
    );

    CREATE TABLE IF NOT EXISTS gpkg_geometry_columns (
      table_name TEXT NOT NULL, column_name TEXT NOT NULL DEFAULT 'geometry',
      geometry_type_name TEXT NOT NULL, srs_id INTEGER NOT NULL,
      z TINYINT NOT NULL DEFAULT 0, m TINYINT NOT NULL DEFAULT 0,
      CONSTRAINT pk_geom_cols PRIMARY KEY (table_name, column_name),
      CONSTRAINT fk_gc_tn FOREIGN KEY (table_name) REFERENCES gpkg_contents(table_name)
    );
  `);
}

/**
 * Register a feature layer in the GeoPackage metadata tables.
 *
 * Inserts (or replaces) rows in `gpkg_contents` and `gpkg_geometry_columns`
 * so that GIS tools recognise the table as a spatial layer.
 *
 * @param {import("better-sqlite3").Database} db - An open better-sqlite3 database
 * @param {string} tableName - Name of the feature table (e.g. "Habitats")
 * @param {string} geomType - Geometry type name (e.g. "POLYGON", "LINESTRING", "POINT")
 * @param {number[]|null} envelope - Bounding box [minX, maxX, minY, maxY], or null
 */
function registerLayer(db, tableName, geomType, envelope) {
  db.prepare(`
    INSERT OR REPLACE INTO gpkg_contents
      (table_name, data_type, identifier, description, min_x, min_y, max_x, max_y, srs_id)
    VALUES (?, 'features', ?, '', ?, ?, ?, ?, ?)
  `).run(tableName, tableName, envelope?.[0] ?? null, envelope?.[2] ?? null,
    envelope?.[1] ?? null, envelope?.[3] ?? null, SRS_ID);

  db.prepare(`
    INSERT OR REPLACE INTO gpkg_geometry_columns
      (table_name, column_name, geometry_type_name, srs_id, z, m)
    VALUES (?, 'geometry', ?, ?, 0, 0)
  `).run(tableName, geomType, SRS_ID);
}

// ---------------------------------------------------------------------------
// Layer table DDL — matches the NE QGIS template exactly
// ---------------------------------------------------------------------------

function createAllTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS "Red Line Boundary" (
      fid INTEGER PRIMARY KEY AUTOINCREMENT, geometry POLYGON,
      "Area" REAL, "Site Name" TEXT(99)
    );

    CREATE TABLE IF NOT EXISTS "Habitats" (
      fid INTEGER PRIMARY KEY AUTOINCREMENT, geometry POLYGON,
      "Parcel Ref" TEXT(99), "Baseline Broad Habitat Type" TEXT(99),
      "Baseline Habitat Type" TEXT(99), "Area" MEDIUMINT,
      "Baseline Condition" TEXT(99), "Baseline Strategic Significance" TEXT(99),
      "Retention Category" TEXT(99), "Proposed Broad Habitat Type" TEXT(99),
      "Proposed Habitat Type" TEXT(99), "Proposed Condition" TEXT(99),
      "Proposed Strategic Significance" TEXT(99),
      "Habitat created in advance/years" TEXT(99),
      "Delay in starting habitat creation/years" TEXT(99),
      "Spatial risk category" TEXT(99), "Location" TEXT(99),
      "Site Name" TEXT(999), "Survey Date" DATE, "Survey Details" TEXT(999),
      "Comment" TEXT(999), "Mapped by" TEXT(999), "Company" TEXT(999),
      "Base Map" TEXT(999), "Baseline Distinctiveness" TEXT(999),
      "Proposed Distinctiveness" TEXT(999)
    );

    CREATE TABLE IF NOT EXISTS "Hedgerows" (
      fid INTEGER PRIMARY KEY AUTOINCREMENT, geometry LINESTRING,
      "Parcel Ref" TEXT(99), "Baseline Hedge Type" TEXT(99),
      "Baseline Condition" TEXT(99), "Baseline Strategic Significance" TEXT(99),
      "Retention Category" TEXT(99), "Proposed Hedge Type" TEXT(99),
      "Proposed Condition" TEXT(99), "Proposed Strategic Significance" TEXT(99),
      "Length" MEDIUMINT, "Habitat created in advance/years" TEXT(99),
      "Delay in starting habitat creation/years" TEXT(99),
      "Spatial risk category" TEXT(99), "Location" TEXT(99),
      "Site Name" TEXT(999), "Survey Date" DATE, "Survey Details" TEXT(999),
      "Comments" TEXT(999), "Mapped by" TEXT(999), "Company" TEXT(999),
      "Base Map" TEXT(999), "Baseline Distinctiveness" TEXT(999),
      "Proposed Distinctiveness" TEXT(999)
    );

    CREATE TABLE IF NOT EXISTS "Rivers" (
      fid INTEGER PRIMARY KEY AUTOINCREMENT, geometry LINESTRING,
      "Parcel Ref" TEXT(99), "Baseline River Type" TEXT(99),
      "Baseline Condition" TEXT(99), "Baseline Strategic Significance" TEXT(99),
      "Baseline Encroachment into Watercourse" TEXT(99),
      "Baseline Encroachment into riparian zone" TEXT(99),
      "Retention Category" TEXT(99), "Proposed River Type" TEXT(99),
      "Proposed Condition" TEXT(99), "Proposed Strategic Significance" TEXT(99),
      "Length" MEDIUMINT, "Habitat created in advance/years" TEXT(99),
      "Delay in starting habitat creation/years" TEXT(99),
      "Spatial risk category" TEXT(99), "Location" TEXT(99),
      "Proposed Encroachment into Watercourse" TEXT(99),
      "Proposed Encroachment into riparian zone" TEXT(99),
      "Site Name" TEXT(999), "Survey Date" DATE, "Survey Details" TEXT(999),
      "Comments" TEXT(999), "Mapped by" TEXT(999), "Company" TEXT(999),
      "Base Map" TEXT(999), "Enhancement Type" TEXT(999),
      "Baseline Distinctiveness" TEXT(999), "Proposed Distinctiveness" TEXT(999)
    );

    CREATE TABLE IF NOT EXISTS "Urban Trees" (
      fid INTEGER PRIMARY KEY AUTOINCREMENT, geometry POINT,
      "Tree Ref" TEXT(99), "Baseline Tree Size" TEXT(99),
      "Baseline Condition" TEXT(99), "Baseline Strategic Significance" TEXT(99),
      "Baseline Tree Type" TEXT(99), "Retention Category" TEXT(99),
      "Category" TEXT(99), "Proposed Tree Size" TEXT(99),
      "Proposed Condition" TEXT(99), "Proposed Strategic Significance" TEXT(99),
      "Proposed Tree Type" TEXT(99), "Location" TEXT(99),
      "Habitat Created/Enhanced in advance/years" TEXT(99),
      "Delay in starting habitat creation/enhancement in years" TEXT(99),
      "Spatial risk category" TEXT(99), "Site Name" TEXT(999),
      "Survey Date" DATE, "Survey Details" TEXT(999), "Comment" TEXT(999),
      "Mapped by" TEXT(999), "Company" TEXT(999), "Base Map" TEXT(999),
      "Count" MEDIUMINT, "Baseline Rural or Urban Tree" TEXT(999),
      "Proposed Rural or Urban Tree" TEXT(999)
    );
  `);
}

// ---------------------------------------------------------------------------
// Data generators
// ---------------------------------------------------------------------------

const SITE_NAME = "Oakwood Regional Development";
const SURVEY_DATE = "2025-06-15";

function generateRedLineBoundary(db, cx, cy, radius) {
  const ring = generateIrregularPolygon(cx, cy, radius);
  const geom = gpkgPolygon(SRS_ID, ring);
  const area = polygonArea(ring);

  db.prepare(
    `INSERT INTO "Red Line Boundary" (geometry, "Area", "Site Name") VALUES (?, ?, ?)`,
  ).run(geom, Math.round(area), SITE_NAME);

  registerLayer(db, "Red Line Boundary", "POLYGON", envelopeFromCoords(ring));
  return ring;
}

function generateHabitats(db, boundaryRing, numParcels) {
  const parcels = partitionPolygon(boundaryRing, numParcels);

  const stmt = db.prepare(`
    INSERT INTO "Habitats" (
      geometry, "Parcel Ref", "Baseline Broad Habitat Type", "Baseline Habitat Type",
      "Area", "Baseline Condition", "Baseline Strategic Significance",
      "Retention Category", "Proposed Broad Habitat Type", "Proposed Habitat Type",
      "Proposed Condition", "Proposed Strategic Significance",
      "Habitat created in advance/years", "Delay in starting habitat creation/years",
      "Spatial risk category", "Location", "Site Name", "Survey Date",
      "Survey Details", "Comment", "Mapped by", "Company", "Base Map",
      "Baseline Distinctiveness", "Proposed Distinctiveness"
    ) VALUES (${Array(25).fill("?").join(", ")})
  `);

  const allEnvelope = [Infinity, -Infinity, Infinity, -Infinity];

  for (let i = 0; i < parcels.length; i++) {
    const ring = parcels[i];
    const geom = gpkgPolygon(SRS_ID, ring);
    const env = envelopeFromCoords(ring);
    expandEnvelope(allEnvelope, env);

    const baseline = pick(HABITATS);
    const retention = pick(RETENTION_CATEGORIES);
    const proposedBroad = retention === "Lost" ? pick(BROAD_HABITAT_TYPES) : baseline.broad;
    const proposed = retention === "Retained"
      ? baseline
      : pick(HABITATS_BY_BROAD[proposedBroad]);
    const area = Math.round(polygonArea(ring));

    stmt.run(
      geom, `H${String(i + 1).padStart(3, "0")}`,
      baseline.broad, baseline.type,
      area,
      pick(baseline.validConditions),
      pick(STRATEGIC_SIGNIFICANCE),
      retention,
      proposed.broad, proposed.type,
      pick(proposed.validConditions),
      pick(STRATEGIC_SIGNIFICANCE),
      retention === "Created" ? String(randInt(0, 5)) : "0",
      retention === "Created" ? String(randInt(0, 3)) : "0",
      pick(SPATIAL_RISK_HABITAT), pick(LOCATIONS), SITE_NAME, SURVEY_DATE,
      "Phase 1 habitat survey", null, "J. Smith", "Ecological Consultants Ltd",
      "OS MasterMap", baseline.distinctiveness, proposed.distinctiveness,
    );
  }

  registerLayer(db, "Habitats", "POLYGON", parcels.length > 0 ? allEnvelope : null);
}

/**
 * Shared rejection-sampling driver for linestring layers (Hedgerows, Rivers).
 *
 * Picks linestrings via `generateLinestring`, rejects any whose vertices fall
 * outside the boundary, and inserts up to `count` accepted features. The
 * caller supplies the table name, prepared INSERT SQL, and a per-row builder
 * that maps `(coords, index)` to the bind values for that row.
 */
function generateLineFeatures(db, boundaryRing, count, { tableName, sql, buildRow }) {
  const stmt = db.prepare(sql);
  const allEnvelope = [Infinity, -Infinity, Infinity, -Infinity];

  let produced = 0;
  let attempts = 0;
  const maxAttempts = count * 20;
  while (produced < count && attempts < maxAttempts) {
    attempts++;
    const coords = generateLinestring(boundaryRing);
    if (!coords || !lineInsideRing(coords, boundaryRing)) continue;
    expandEnvelope(allEnvelope, envelopeFromCoords(coords));
    stmt.run(...buildRow(coords, produced));
    produced++;
  }

  registerLayer(db, tableName, "LINESTRING", produced > 0 ? allEnvelope : null);
}

function generateHedgerows(db, boundaryRing, count) {
  generateLineFeatures(db, boundaryRing, count, {
    tableName: "Hedgerows",
    sql: `
      INSERT INTO "Hedgerows" (
        geometry, "Parcel Ref", "Baseline Hedge Type", "Baseline Condition",
        "Baseline Strategic Significance", "Retention Category",
        "Proposed Hedge Type", "Proposed Condition", "Proposed Strategic Significance",
        "Length", "Habitat created in advance/years",
        "Delay in starting habitat creation/years", "Spatial risk category",
        "Location", "Site Name", "Survey Date", "Survey Details", "Comments",
        "Mapped by", "Company", "Base Map",
        "Baseline Distinctiveness", "Proposed Distinctiveness"
      ) VALUES (${Array(23).fill("?").join(", ")})
    `,
    buildRow: (coords, i) => {
      const hedgeType = pick(HEDGE_TYPES);
      const retention = pick(RETENTION_CATEGORIES);
      return [
        gpkgLineString(SRS_ID, coords),
        `HG${String(i + 1).padStart(3, "0")}`, hedgeType,
        pick(HEDGE_CONDITIONS), pick(STRATEGIC_SIGNIFICANCE), retention,
        retention === "Lost" ? pick(HEDGE_TYPES) : hedgeType,
        pick(HEDGE_CONDITIONS), pick(STRATEGIC_SIGNIFICANCE),
        linestringLength(coords),
        retention === "Created" ? String(randInt(0, 3)) : "0",
        retention === "Created" ? String(randInt(0, 2)) : "0",
        pick(SPATIAL_RISK_HABITAT), pick(LOCATIONS), SITE_NAME, SURVEY_DATE,
        "Hedgerow survey", null, "J. Smith", "Ecological Consultants Ltd",
        "OS MasterMap", pick(DISTINCTIVENESS), pick(DISTINCTIVENESS),
      ];
    },
  });
}

function generateRivers(db, boundaryRing, count) {
  generateLineFeatures(db, boundaryRing, count, {
    tableName: "Rivers",
    sql: `
      INSERT INTO "Rivers" (
        geometry, "Parcel Ref", "Baseline River Type", "Baseline Condition",
        "Baseline Strategic Significance",
        "Baseline Encroachment into Watercourse",
        "Baseline Encroachment into riparian zone",
        "Retention Category", "Proposed River Type", "Proposed Condition",
        "Proposed Strategic Significance", "Length",
        "Habitat created in advance/years",
        "Delay in starting habitat creation/years",
        "Spatial risk category", "Location",
        "Proposed Encroachment into Watercourse",
        "Proposed Encroachment into riparian zone",
        "Site Name", "Survey Date", "Survey Details", "Comments",
        "Mapped by", "Company", "Base Map",
        "Enhancement Type", "Baseline Distinctiveness", "Proposed Distinctiveness"
      ) VALUES (${Array(28).fill("?").join(", ")})
    `,
    buildRow: (coords, i) => {
      const riverType = pick(RIVER_TYPES);
      const retention = pick(["Retained", "Enhanced"]);
      return [
        gpkgLineString(SRS_ID, coords),
        `R${String(i + 1).padStart(3, "0")}`, riverType,
        pick(CONDITIONS), pick(STRATEGIC_SIGNIFICANCE),
        pick(ENCROACHMENT_WATERCOURSE), pick(ENCROACHMENT_RIPARIAN),
        retention, riverType, pick(CONDITIONS), pick(STRATEGIC_SIGNIFICANCE),
        linestringLength(coords), "0", "0",
        pick(SPATIAL_RISK_RIVER), pick(LOCATIONS),
        pick(ENCROACHMENT_WATERCOURSE), pick(ENCROACHMENT_RIPARIAN),
        SITE_NAME, SURVEY_DATE, "River corridor survey", null,
        "J. Smith", "Ecological Consultants Ltd", "OS MasterMap",
        null, pick(DISTINCTIVENESS), pick(DISTINCTIVENESS),
      ];
    },
  });
}

function generateUrbanTrees(db, boundaryRing, count) {
  const treeSizes = ["Small", "Medium", "Large"];
  const treeTypes = ["Street tree", "Park/garden tree", "Woodland tree", "Hedgerow tree"];

  const stmt = db.prepare(`
    INSERT INTO "Urban Trees" (
      geometry, "Tree Ref", "Baseline Tree Size", "Baseline Condition",
      "Baseline Strategic Significance", "Baseline Tree Type",
      "Retention Category", "Category",
      "Proposed Tree Size", "Proposed Condition",
      "Proposed Strategic Significance", "Proposed Tree Type",
      "Location", "Habitat Created/Enhanced in advance/years",
      "Delay in starting habitat creation/enhancement in years",
      "Spatial risk category", "Site Name", "Survey Date",
      "Survey Details", "Comment", "Mapped by", "Company", "Base Map",
      "Count", "Baseline Rural or Urban Tree", "Proposed Rural or Urban Tree"
    ) VALUES (${Array(26).fill("?").join(", ")})
  `);

  const allEnvelope = [Infinity, -Infinity, Infinity, -Infinity];

  let produced = 0;
  while (produced < count) {
    const point = pickInteriorPoint(boundaryRing);
    if (!point) break;
    const [x, y] = point;
    expandEnvelope(allEnvelope, [x, x, y, y]);

    const size = pick(treeSizes);
    const type = pick(treeTypes);
    const retention = pick(["Retained", "Enhanced", "Lost"]);

    stmt.run(
      gpkgPoint(SRS_ID, x, y), `T${String(produced + 1).padStart(3, "0")}`, size,
      pick(CONDITIONS), pick(STRATEGIC_SIGNIFICANCE), type,
      retention, retention === "Lost" ? "Lost" : "Retained",
      retention === "Lost" ? pick(treeSizes) : size,
      pick(CONDITIONS), pick(STRATEGIC_SIGNIFICANCE),
      retention === "Lost" ? pick(treeTypes) : type,
      pick(LOCATIONS), "0", "0", pick(SPATIAL_RISK_HABITAT),
      SITE_NAME, SURVEY_DATE, "Tree survey", null,
      "J. Smith", "Ecological Consultants Ltd", "OS MasterMap",
      1, "Urban", "Urban",
    );
    produced++;
  }

  registerLayer(db, "Urban Trees", "POINT", produced > 0 ? allEnvelope : null);
}

// ---------------------------------------------------------------------------
// SLD styles
// ---------------------------------------------------------------------------

/**
 * Wrap a symbolizer XML fragment in a complete SLD 1.0.0 document.
 *
 * @param {string} layerName - Layer name used in NamedLayer and UserStyle
 * @param {string} symbolizerXml - Inner symbolizer XML (e.g. PolygonSymbolizer)
 * @returns {string} Complete SLD XML document
 */
function sld(layerName, symbolizerXml) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<StyledLayerDescriptor version="1.0.0"
  xmlns="http://www.opengis.net/sld"
  xmlns:ogc="http://www.opengis.net/ogc">
  <NamedLayer>
    <Name>${layerName}</Name>
    <UserStyle>
      <Name>${layerName}</Name>
      <FeatureTypeStyle>
        <Rule>
          ${symbolizerXml}
        </Rule>
      </FeatureTypeStyle>
    </UserStyle>
  </NamedLayer>
</StyledLayerDescriptor>`;
}

/**
 * Generate an SLD document for a polygon layer.
 *
 * @param {string} name - Layer name
 * @param {string} fill - Fill colour as hex (e.g. "#FF0000")
 * @param {string} stroke - Stroke colour as hex
 * @param {number} [fillOpacity=0.5] - Fill opacity (0–1)
 * @param {number} [strokeWidth=1.5] - Stroke width in pixels
 * @returns {string} Complete SLD XML document
 */
function polygonSld(name, fill, stroke, fillOpacity = 0.5, strokeWidth = 1.5) {
  return sld(name, `<PolygonSymbolizer>
            <Fill>
              <CssParameter name="fill">${fill}</CssParameter>
              <CssParameter name="fill-opacity">${fillOpacity}</CssParameter>
            </Fill>
            <Stroke>
              <CssParameter name="stroke">${stroke}</CssParameter>
              <CssParameter name="stroke-width">${strokeWidth}</CssParameter>
            </Stroke>
          </PolygonSymbolizer>`);
}

/**
 * Generate an SLD document for a line layer.
 *
 * @param {string} name - Layer name
 * @param {string} stroke - Stroke colour as hex (e.g. "#0000FF")
 * @param {number} [strokeWidth=2] - Stroke width in pixels
 * @returns {string} Complete SLD XML document
 */
function lineSld(name, stroke, strokeWidth = 2) {
  return sld(name, `<LineSymbolizer>
            <Stroke>
              <CssParameter name="stroke">${stroke}</CssParameter>
              <CssParameter name="stroke-width">${strokeWidth}</CssParameter>
            </Stroke>
          </LineSymbolizer>`);
}

/**
 * Generate an SLD document for a point layer using a circle marker.
 *
 * @param {string} name - Layer name
 * @param {string} fill - Marker fill colour as hex
 * @param {string} stroke - Marker outline colour as hex
 * @param {number} [size=8] - Marker size in pixels
 * @returns {string} Complete SLD XML document
 */
function pointSld(name, fill, stroke, size = 8) {
  return sld(name, `<PointSymbolizer>
            <Graphic>
              <Mark>
                <WellKnownName>circle</WellKnownName>
                <Fill>
                  <CssParameter name="fill">${fill}</CssParameter>
                </Fill>
                <Stroke>
                  <CssParameter name="stroke">${stroke}</CssParameter>
                  <CssParameter name="stroke-width">1</CssParameter>
                </Stroke>
              </Mark>
              <Size>${size}</Size>
            </Graphic>
          </PointSymbolizer>`);
}

// ---------------------------------------------------------------------------
// QML styles (QGIS native format — used for auto-loading)
// ---------------------------------------------------------------------------

/**
 * Convert a hex colour string to a comma-separated RGBA value for QML.
 *
 * @param {string} hex - Hex colour (e.g. "#FF0000")
 * @param {number} [alpha=255] - Alpha value (0–255)
 * @returns {string} RGBA string (e.g. "255,0,0,255")
 */
function hexToRgba(hex, alpha = 255) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `${r},${g},${b},${alpha}`;
}

/**
 * Generate a QGIS QML style document for a polygon layer.
 *
 * @param {string} fill - Fill colour as hex (e.g. "#FF0000")
 * @param {string} stroke - Stroke colour as hex
 * @param {number} [fillOpacity=0.5] - Fill opacity (0–1)
 * @param {number} [strokeWidth=1.5] - Stroke width in mm
 * @returns {string} Complete QML XML document
 */
function polygonQml(fill, stroke, fillOpacity = 0.5, strokeWidth = 1.5) {
  const fillAlpha = Math.round(fillOpacity * 255);
  return `<!DOCTYPE qgis PUBLIC 'http://mrcc.com/qgis.dtd' 'SYSTEM'>
<qgis version="3.34" styleCategories="Symbology">
  <renderer-v2 type="singleSymbol" symbollevels="0">
    <symbols>
      <symbol type="fill" name="0" alpha="1">
        <layer class="SimpleFill">
          <Option type="Map">
            <Option type="QString" name="color" value="${hexToRgba(fill, fillAlpha)}"/>
            <Option type="QString" name="outline_color" value="${hexToRgba(stroke)}"/>
            <Option type="QString" name="outline_width" value="${strokeWidth}"/>
            <Option type="QString" name="outline_width_unit" value="MM"/>
            <Option type="QString" name="style" value="solid"/>
            <Option type="QString" name="outline_style" value="solid"/>
          </Option>
        </layer>
      </symbol>
    </symbols>
  </renderer-v2>
</qgis>`;
}

/**
 * Generate a QGIS QML style document for a line layer.
 *
 * @param {string} stroke - Stroke colour as hex (e.g. "#0000FF")
 * @param {number} [strokeWidth=2] - Stroke width in mm
 * @returns {string} Complete QML XML document
 */
function lineQml(stroke, strokeWidth = 2) {
  return `<!DOCTYPE qgis PUBLIC 'http://mrcc.com/qgis.dtd' 'SYSTEM'>
<qgis version="3.34" styleCategories="Symbology">
  <renderer-v2 type="singleSymbol" symbollevels="0">
    <symbols>
      <symbol type="line" name="0" alpha="1">
        <layer class="SimpleLine">
          <Option type="Map">
            <Option type="QString" name="line_color" value="${hexToRgba(stroke)}"/>
            <Option type="QString" name="line_width" value="${strokeWidth}"/>
            <Option type="QString" name="line_width_unit" value="MM"/>
            <Option type="QString" name="line_style" value="solid"/>
            <Option type="QString" name="capstyle" value="round"/>
            <Option type="QString" name="joinstyle" value="round"/>
          </Option>
        </layer>
      </symbol>
    </symbols>
  </renderer-v2>
</qgis>`;
}

/**
 * Generate a QGIS QML style document for a point layer using a circle marker.
 *
 * @param {string} fill - Marker fill colour as hex
 * @param {string} stroke - Marker outline colour as hex
 * @param {number} [size=4] - Marker size in mm
 * @returns {string} Complete QML XML document
 */
function pointQml(fill, stroke, size = 4) {
  return `<!DOCTYPE qgis PUBLIC 'http://mrcc.com/qgis.dtd' 'SYSTEM'>
<qgis version="3.34" styleCategories="Symbology">
  <renderer-v2 type="singleSymbol" symbollevels="0">
    <symbols>
      <symbol type="marker" name="0" alpha="1">
        <layer class="SimpleMarker">
          <Option type="Map">
            <Option type="QString" name="color" value="${hexToRgba(fill)}"/>
            <Option type="QString" name="outline_color" value="${hexToRgba(stroke)}"/>
            <Option type="QString" name="outline_width" value="0.4"/>
            <Option type="QString" name="size" value="${size}"/>
            <Option type="QString" name="size_unit" value="MM"/>
            <Option type="QString" name="name" value="circle"/>
          </Option>
        </layer>
      </symbol>
    </symbols>
  </renderer-v2>
</qgis>`;
}

const LAYER_STYLES = [
  { table: "Red Line Boundary", sld: polygonSld("Red Line Boundary", "#FF0000", "#CC0000", 0.2, 2.5), qml: polygonQml("#FF0000", "#CC0000", 0.2, 2.5) },
  { table: "Habitats",          sld: polygonSld("Habitats", "#FFB74D", "#F57C00"),                     qml: polygonQml("#FFB74D", "#F57C00") },
  { table: "Hedgerows",         sld: lineSld("Hedgerows", "#2E7D32", 3),                               qml: lineQml("#2E7D32", 3) },
  { table: "Rivers",            sld: lineSld("Rivers", "#1565C0", 2.5),                                qml: lineQml("#1565C0", 2.5) },
  { table: "Urban Trees",       sld: pointSld("Urban Trees", "#8D6E63", "#4E342E", 8),                 qml: pointQml("#8D6E63", "#4E342E", 4) },
];

/**
 * Create the `layer_styles` table and insert default styles for all layers.
 *
 * Stores both QML (for QGIS auto-loading) and SLD (for portability to other
 * GIS tools) in each row.
 *
 * @param {import("better-sqlite3").Database} db - An open better-sqlite3 database
 */
function createLayerStyles(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS layer_styles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      f_table_catalog TEXT DEFAULT '',
      f_table_schema TEXT DEFAULT '',
      f_table_name TEXT NOT NULL,
      f_geometry_column TEXT,
      styleName TEXT,
      styleQML TEXT,
      styleSLD TEXT,
      useAsDefault BOOLEAN DEFAULT 1,
      description TEXT DEFAULT '',
      owner TEXT DEFAULT '',
      ui TEXT,
      update_time DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);

  const stmt = db.prepare(`
    INSERT INTO layer_styles (f_table_name, f_geometry_column, styleName, styleQML, styleSLD, useAsDefault)
    VALUES (?, 'geometry', ?, ?, ?, 1)
  `);

  for (const style of LAYER_STYLES) {
    stmt.run(style.table, style.table, style.qml, style.sld);
  }
}

// ---------------------------------------------------------------------------
// Workbook source resolution: turn a path-or-URL into a local file path,
// downloading and caching as needed.
// ---------------------------------------------------------------------------

const CACHE_DIR = path.resolve(HARNESS_ROOT, ".cache", "bng500");

/**
 * Convert a GitHub HTML blob URL to the LFS-aware media URL. The BNG500
 * corpus uses Git LFS for the workbook files, so `raw.githubusercontent.com`
 * returns only the LFS pointer; `media.githubusercontent.com/media` resolves
 * the actual file content.
 */
function rewriteGithubBlobUrl(url) {
  const m = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/);
  if (!m) return url;
  const [, owner, repo, ref, p] = m;
  return `https://media.githubusercontent.com/media/${owner}/${repo}/${ref}/${p}`;
}

async function downloadToCache(url) {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  const hash = createHash("sha256").update(url).digest("hex").slice(0, 16);
  const ext = path.extname(new URL(url).pathname) || ".xlsx";
  const cached = path.join(CACHE_DIR, `${hash}${ext}`);
  if (existsSync(cached)) {
    info(`  cache hit: ${path.basename(cached)}`);
    return cached;
  }
  info(`  fetching ${url}`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  // Detect a Git LFS pointer accidentally returned (small text starting with
  // "version https://git-lfs"). Most often happens when callers pass a raw.
  // url instead of a media.githubusercontent.com URL.
  if (buf.length < 1024 && buf.slice(0, 64).toString("utf8").startsWith("version https://git-lfs")) {
    throw new Error(
      `${url} returned a Git LFS pointer, not the actual file. ` +
        "Use the GitHub blob URL (or the media.githubusercontent.com/media URL) for LFS-tracked files.",
    );
  }
  writeFileSync(cached, buf);
  return cached;
}

/**
 * Resolve a workbook source (local path or HTTPS URL) to a local file path.
 * Returns the resolved path; downloads remote URLs into the cache.
 */
async function resolveWorkbookSource(ref) {
  const trimmed = ref.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    const url = rewriteGithubBlobUrl(trimmed);
    return downloadToCache(url);
  }
  const abs = path.resolve(trimmed);
  if (!existsSync(abs)) {
    throw new Error(`Workbook not found: ${abs}`);
  }
  return abs;
}

// ---------------------------------------------------------------------------
// Workbook → habitat rows: combine baseline / enhancement / creation entries
// from a metric workbook into the rows our Habitats layer needs (one row per
// physical land parcel, with both baseline and proposed columns populated).
// ---------------------------------------------------------------------------

// Synthetic "before" attributes used for workbook rows in retention="Created".
// The metric workbook's A-2 sheet records only what's *being created*; the
// pre-development state isn't captured. We use a generic "developed land"
// baseline, which is what most created parcels in real planning applications
// genuinely succeed.
const CREATED_BASELINE = {
  broad: "Urban",
  type: "Developed land; sealed surface",
  distinctiveness: "V.Low",
  condition: "N/A - Other",
  strategicSig: "Area/compensation not in local strategy/ no local strategy",
};

function isHabitatConditionValid(broad, type, condition) {
  const key = `${broad} - ${type}`;
  if (!metricDistinctiveness[key]) return false;
  const conds = metricConditionScores[key];
  if (!conds) return false;
  const v = conds[condition];
  return typeof v === "number";
}

function buildHabitatRowsFromWorkbook(wb, { strict = false } = {}) {
  const enhMap = new Map();
  for (const e of wb.habitats.enhancements) {
    enhMap.set(String(e.baselineRef), e);
  }

  const rows = [];
  let nextRef = 1;
  const skipReasons = [];

  for (const b of wb.habitats.baseline) {
    const enh = enhMap.get(String(b.ref));
    const proposed = enh
      ? {
          broad: enh.proposedBroad,
          type: enh.proposedType,
          distinctiveness: enh.proposedDistinctiveness,
          condition: enh.proposedCondition,
          strategicSig: enh.proposedStrategicSignificance,
          advanceYears: enh.advanceYears,
          delayYears: enh.delayYears,
        }
      : {
          broad: b.broad,
          type: b.type,
          distinctiveness: b.distinctiveness,
          condition: b.condition,
          strategicSig: b.strategicSignificance,
          advanceYears: 0,
          delayYears: 0,
        };

    if (
      strict &&
      (!isHabitatConditionValid(b.broad, b.type, b.condition) ||
        !isHabitatConditionValid(proposed.broad, proposed.type, proposed.condition))
    ) {
      skipReasons.push(`baseline ref ${b.ref}: invalid (habitat, condition) under --strict-habitats`);
      continue;
    }

    rows.push({
      ref: `H${String(nextRef++).padStart(3, "0")}`,
      retention: enh ? "Enhanced" : "Retained",
      area: b.area,
      baseline: {
        broad: b.broad,
        type: b.type,
        distinctiveness: b.distinctiveness,
        condition: b.condition,
        strategicSig: b.strategicSignificance,
      },
      proposed,
    });
  }

  for (const c of wb.habitats.created) {
    if (
      strict &&
      !isHabitatConditionValid(c.broad, c.type, c.condition)
    ) {
      skipReasons.push(`created ref ${c.ref}: invalid (habitat, condition) under --strict-habitats`);
      continue;
    }
    rows.push({
      ref: `H${String(nextRef++).padStart(3, "0")}`,
      retention: "Created",
      area: c.area,
      baseline: { ...CREATED_BASELINE },
      proposed: {
        broad: c.broad,
        type: c.type,
        distinctiveness: c.distinctiveness,
        condition: c.condition,
        strategicSig: c.strategicSignificance,
        advanceYears: c.advanceYears,
        delayYears: c.delayYears,
      },
    });
  }

  return { rows, skipReasons };
}

// ---------------------------------------------------------------------------
// Workbook-driven layer generators (parallel to the synthetic versions but
// reading attributes and target geometry sizes from the workbook).
// ---------------------------------------------------------------------------

function generateRedLineBoundaryFromArea(db, cx, cy, totalAreaM2) {
  // Convex hull of random points in an annulus has area ≈ 0.85 × π × r²
  // (depends on n, but stable for n=18). Solve for radius that gives the
  // requested total area.
  const targetRingArea = Math.max(totalAreaM2, 1000); // floor at 0.1 ha for tiny sites
  const radius = Math.sqrt(targetRingArea / (0.85 * Math.PI));
  let ring = generateIrregularPolygon(cx, cy, radius);
  // Adjust to exact area in case the random hull was unlucky.
  ring = scaleRingToArea(ring, targetRingArea);

  const geom = gpkgPolygon(SRS_ID, ring);
  const area = polygonArea(ring);
  db.prepare(
    `INSERT INTO "Red Line Boundary" (geometry, "Area", "Site Name") VALUES (?, ?, ?)`,
  ).run(geom, Math.round(area), SITE_NAME);
  registerLayer(db, "Red Line Boundary", "POLYGON", envelopeFromCoords(ring));
  return ring;
}

function generateHabitatsFromWorkbook(db, boundaryRing, rows) {
  const stmt = db.prepare(`
    INSERT INTO "Habitats" (
      geometry, "Parcel Ref", "Baseline Broad Habitat Type", "Baseline Habitat Type",
      "Area", "Baseline Condition", "Baseline Strategic Significance",
      "Retention Category", "Proposed Broad Habitat Type", "Proposed Habitat Type",
      "Proposed Condition", "Proposed Strategic Significance",
      "Habitat created in advance/years", "Delay in starting habitat creation/years",
      "Spatial risk category", "Location", "Site Name", "Survey Date",
      "Survey Details", "Comment", "Mapped by", "Company", "Base Map",
      "Baseline Distinctiveness", "Proposed Distinctiveness"
    ) VALUES (${Array(25).fill("?").join(", ")})
  `);

  if (rows.length === 0) {
    registerLayer(db, "Habitats", "POLYGON", null);
    return 0;
  }

  // Excel areas are in hectares; convert to m² to match the polygon area unit.
  const targetAreasM2 = rows.map((r) => r.area * 10000);
  const cells = partitionPolygonByAreas(boundaryRing, targetAreasM2);

  const allEnvelope = [Infinity, -Infinity, Infinity, -Infinity];
  let written = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const cell = cells[i];
    if (!cell) continue;
    const geom = gpkgPolygon(SRS_ID, cell);
    expandEnvelope(allEnvelope, envelopeFromCoords(cell));
    stmt.run(
      geom, r.ref,
      r.baseline.broad, r.baseline.type,
      Math.round(polygonArea(cell)),
      r.baseline.condition, r.baseline.strategicSig,
      r.retention,
      r.proposed.broad, r.proposed.type,
      r.proposed.condition, r.proposed.strategicSig,
      String(r.proposed.advanceYears ?? 0),
      String(r.proposed.delayYears ?? 0),
      pick(SPATIAL_RISK_HABITAT), "On-site", SITE_NAME, SURVEY_DATE,
      "From metric workbook", null, "Workbook import", "Workbook import",
      "OS MasterMap", r.baseline.distinctiveness, r.proposed.distinctiveness,
    );
    written++;
  }
  registerLayer(db, "Habitats", "POLYGON", written > 0 ? allEnvelope : null);
  return written;
}

/**
 * Generate a linestring with vertices inside `boundaryRing` whose total
 * length is approximately `targetLengthM`. Picks a random interior start
 * point, then a random direction, lays the end point at `targetLengthM`
 * along that direction, and inserts 1–2 lightly-offset midpoints. Retries
 * if either endpoint falls outside the boundary.
 */
function generateLinestringOfLength(boundaryRing, targetLengthM, maxAttempts = 20) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const start = pickInteriorPoint(boundaryRing);
    if (!start) return null;
    const angle = Math.random() * 2 * Math.PI;
    const end = [
      start[0] + targetLengthM * Math.cos(angle),
      start[1] + targetLengthM * Math.sin(angle),
    ];
    if (!pointInRing(end, boundaryRing)) continue;

    const dx = end[0] - start[0];
    const dy = end[1] - start[1];
    const px = -dy / targetLengthM;
    const py = dx / targetLengthM;
    const numMid = 1 + randInt(0, 2);
    const maxOffset = targetLengthM * 0.05;
    const points = [start];
    for (let i = 1; i <= numMid; i++) {
      const t = i / (numMid + 1);
      const offset = randBetween(-maxOffset, maxOffset);
      const mid = [
        start[0] + dx * t + px * offset,
        start[1] + dy * t + py * offset,
      ];
      if (!pointInRing(mid, boundaryRing)) {
        points.length = 0;
        break;
      }
      points.push(mid);
    }
    if (points.length === 0) continue;
    points.push(end);
    return points;
  }
  return null;
}

function generateHedgerowsFromWorkbook(db, boundaryRing, baseline, created) {
  const stmt = db.prepare(`
    INSERT INTO "Hedgerows" (
      geometry, "Parcel Ref", "Baseline Hedge Type", "Baseline Condition",
      "Baseline Strategic Significance", "Retention Category",
      "Proposed Hedge Type", "Proposed Condition", "Proposed Strategic Significance",
      "Length", "Habitat created in advance/years",
      "Delay in starting habitat creation/years", "Spatial risk category",
      "Location", "Site Name", "Survey Date", "Survey Details", "Comments",
      "Mapped by", "Company", "Base Map",
      "Baseline Distinctiveness", "Proposed Distinctiveness"
    ) VALUES (${Array(23).fill("?").join(", ")})
  `);
  const allEnvelope = [Infinity, -Infinity, Infinity, -Infinity];
  let written = 0;

  const records = [
    ...baseline.map((h) => ({ retention: "Retained", hedge: h, isCreated: false })),
    ...created.map((h) => ({ retention: "Created", hedge: h, isCreated: true })),
  ];
  for (let i = 0; i < records.length; i++) {
    const { retention, hedge, isCreated } = records[i];
    const coords = generateLinestringOfLength(boundaryRing, hedge.lengthM);
    if (!coords) continue;
    const geom = gpkgLineString(SRS_ID, coords);
    expandEnvelope(allEnvelope, envelopeFromCoords(coords));
    stmt.run(
      geom, `HG${String(i + 1).padStart(3, "0")}`,
      isCreated ? "(Created)" : hedge.type,
      hedge.condition ?? "Moderate",
      hedge.strategicSignificance ?? "Area/compensation not in local strategy/ no local strategy",
      retention,
      hedge.type, hedge.condition ?? "Moderate",
      hedge.strategicSignificance ?? "Area/compensation not in local strategy/ no local strategy",
      hedge.lengthM, "0", "0",
      "Compensation inside LPA boundary or NCA of impact site", "On-site",
      SITE_NAME, SURVEY_DATE, "From metric workbook", null,
      "Workbook import", "Workbook import", "OS MasterMap",
      hedge.distinctiveness ?? "Medium", hedge.distinctiveness ?? "Medium",
    );
    written++;
  }
  registerLayer(db, "Hedgerows", "LINESTRING", written > 0 ? allEnvelope : null);
  return written;
}

function generateRiversFromWorkbook(db, boundaryRing, baseline, created) {
  const stmt = db.prepare(`
    INSERT INTO "Rivers" (
      geometry, "Parcel Ref", "Baseline River Type", "Baseline Condition",
      "Baseline Strategic Significance",
      "Baseline Encroachment into Watercourse",
      "Baseline Encroachment into riparian zone",
      "Retention Category", "Proposed River Type", "Proposed Condition",
      "Proposed Strategic Significance", "Length",
      "Habitat created in advance/years",
      "Delay in starting habitat creation/years",
      "Spatial risk category", "Location",
      "Proposed Encroachment into Watercourse",
      "Proposed Encroachment into riparian zone",
      "Site Name", "Survey Date", "Survey Details", "Comments",
      "Mapped by", "Company", "Base Map",
      "Enhancement Type", "Baseline Distinctiveness", "Proposed Distinctiveness"
    ) VALUES (${Array(28).fill("?").join(", ")})
  `);
  const allEnvelope = [Infinity, -Infinity, Infinity, -Infinity];
  let written = 0;

  const records = [
    ...baseline.map((r) => ({ retention: "Retained", river: r })),
    ...created.map((r) => ({ retention: "Created", river: r })),
  ];
  for (let i = 0; i < records.length; i++) {
    const { retention, river } = records[i];
    const coords = generateLinestringOfLength(boundaryRing, river.lengthM);
    if (!coords) continue;
    const geom = gpkgLineString(SRS_ID, coords);
    expandEnvelope(allEnvelope, envelopeFromCoords(coords));
    stmt.run(
      geom, `R${String(i + 1).padStart(3, "0")}`,
      river.type, river.condition ?? "Moderate",
      river.strategicSignificance ?? "Within waterbody catchment",
      "No Encroachment", "No Encroachment/No Encroachment",
      retention, river.type, river.condition ?? "Moderate",
      river.strategicSignificance ?? "Within waterbody catchment",
      river.lengthM, "0", "0",
      "Within waterbody catchment", "On-site",
      "No Encroachment", "No Encroachment/No Encroachment",
      SITE_NAME, SURVEY_DATE, "From metric workbook", null,
      "Workbook import", "Workbook import", "OS MasterMap",
      null, river.distinctiveness ?? "Medium", river.distinctiveness ?? "Medium",
    );
    written++;
  }
  registerLayer(db, "Rivers", "LINESTRING", written > 0 ? allEnvelope : null);
  return written;
}

function generateUrbanTreesFromWorkbook(db, boundaryRing, baseline, created) {
  const stmt = db.prepare(`
    INSERT INTO "Urban Trees" (
      geometry, "Tree Ref", "Baseline Tree Size", "Baseline Condition",
      "Baseline Strategic Significance", "Baseline Tree Type",
      "Retention Category", "Category",
      "Proposed Tree Size", "Proposed Condition",
      "Proposed Strategic Significance", "Proposed Tree Type",
      "Location", "Habitat Created/Enhanced in advance/years",
      "Delay in starting habitat creation/enhancement in years",
      "Spatial risk category", "Site Name", "Survey Date",
      "Survey Details", "Comment", "Mapped by", "Company", "Base Map",
      "Count", "Baseline Rural or Urban Tree", "Proposed Rural or Urban Tree"
    ) VALUES (${Array(26).fill("?").join(", ")})
  `);
  const allEnvelope = [Infinity, -Infinity, Infinity, -Infinity];
  let written = 0;

  const records = [
    ...baseline.map((t) => ({ retention: "Retained", tree: t })),
    ...created.map((t) => ({ retention: "Created", tree: t })),
  ];
  for (let i = 0; i < records.length; i++) {
    const { retention, tree } = records[i];
    const point = pickInteriorPoint(boundaryRing);
    if (!point) continue;
    const [x, y] = point;
    expandEnvelope(allEnvelope, [x, x, y, y]);
    stmt.run(
      gpkgPoint(SRS_ID, x, y),
      `T${String(i + 1).padStart(3, "0")}`,
      "Medium", tree.condition ?? "Moderate",
      tree.strategicSignificance ?? "Area/compensation not in local strategy/ no local strategy",
      tree.type, retention, retention === "Lost" ? "Lost" : "Retained",
      "Medium", tree.condition ?? "Moderate",
      tree.strategicSignificance ?? "Area/compensation not in local strategy/ no local strategy",
      tree.type, "On-site", "0", "0",
      "Compensation inside LPA boundary or NCA of impact site",
      SITE_NAME, SURVEY_DATE, "From metric workbook", null,
      "Workbook import", "Workbook import", "OS MasterMap",
      1, "Urban", "Urban",
    );
    written++;
  }
  registerLayer(db, "Urban Trees", "POINT", written > 0 ? allEnvelope : null);
  return written;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Prompt the user with a yes/no question on stdin.
 *
 * @param {string} question - The prompt text to display
 * @returns {Promise<boolean>} Resolves true if the user answered yes
 */
function confirm(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase().startsWith("y"));
    });
  });
}

// EPSG:27700 (British National Grid) coords of Maidenhead, deep inside England
// — used as the fallback Red Line Boundary centre when --centre isn't given.
const DEFAULT_CENTRE_E = 530000;
const DEFAULT_CENTRE_N = 180000;

/**
 * Parse the --centre "easting,northing" CLI value. Returns null when the
 * flag wasn't given, or [easting, northing] when valid. Exits on malformed
 * input rather than throwing — caller is `main()`.
 */
function parseCentre(value) {
  if (!value) return null;
  const parts = value.split(",").map((s) => s.trim());
  if (parts.length !== 2) {
    error(`--centre expects "easting,northing" (got: ${value})`);
    process.exit(1);
  }
  const e = Number(parts[0]);
  const n = Number(parts[1]);
  if (!Number.isFinite(e) || !Number.isFinite(n)) {
    error(`--centre values must be numbers (got: ${value})`);
    process.exit(1);
  }
  // BNG covers roughly easting 0–700000, northing 0–1300000. Warn (not error)
  // outside that, since hand-typed coords often have transposed pairs.
  if (e < 0 || e > 700000 || n < 0 || n > 1300000) {
    warn(`--centre ${e},${n} is outside the BNG envelope; the prototype's ` +
      "in-England check will likely reject the upload");
  }
  return [e, n];
}

function generateOne(outPath, bad, numParcels, centre) {
  const numHedgerows = Math.max(3, Math.floor(numParcels / 3));
  const numRivers = Math.max(1, Math.floor(numParcels / 15));
  const numTrees = Math.max(5, Math.floor(numParcels / 2));

  header(`Generating ${bad ? "BAD " : ""}BNG test GeoPackage`, "cyan");
  if (bad) info("  ⚠ Bad mode: omitting Red Line Boundary");
  info(`  ${SITE_NAME}`);
  info(`  ${numParcels} habitat parcels, ${numHedgerows} hedgerows, ${numRivers} rivers, ${numTrees} urban trees`);
  info(`  centre: ${centre[0]},${centre[1]} (BNG)`);
  info(`  → ${outPath}`);

  const [cx, cy] = centre;
  const radius = 400;

  const db = new Database(outPath);
  initGeoPackage(db);
  createAllTables(db);

  // In bad mode, generate the boundary ring for placing features but don't
  // insert it into the database — leaves the Red Line Boundary table empty.
  const ring = bad
    ? generateIrregularPolygon(cx, cy, radius)
    : generateRedLineBoundary(db, cx, cy, radius);
  generateHabitats(db, ring, numParcels);
  generateHedgerows(db, ring, numHedgerows);
  generateRivers(db, ring, numRivers);
  generateUrbanTrees(db, ring, numTrees);
  createLayerStyles(db);

  db.close();

  const verify = new Database(outPath, { readonly: true });
  const layers = verify
    .prepare("SELECT table_name FROM gpkg_contents WHERE data_type = 'features'")
    .all();
  for (const layer of layers) {
    const count = verify
      .prepare(`SELECT COUNT(*) as n FROM "${layer.table_name}"`)
      .get();
    info(`  ${layer.table_name}: ${count.n} feature(s)`);
  }
  verify.close();
  console.log(color("green", `✔ Done. ${outPath}`));
}

function generateOneFromWorkbook(outPath, workbook, sourceLabel, { strict = false, centre } = {}) {
  const { rows: habitatRows, skipReasons } = buildHabitatRowsFromWorkbook(workbook, { strict });
  const habitatTotalM2 = habitatRows.reduce((s, r) => s + r.area, 0) * 10000;
  const declaredSiteM2 = (workbook.siteInfo.totalSiteAreaHa ?? 0) * 10000;

  // Make sure the boundary is large enough to accommodate the longest linear
  // feature (longest hedge or river) — otherwise it can't physically fit
  // inside the polygon. We require boundary diameter > 1.2 × longest length.
  const linearLengths = [
    ...workbook.hedgerows.baseline.map((h) => h.lengthM),
    ...workbook.hedgerows.created.map((h) => h.lengthM),
    ...workbook.watercourses.baseline.map((r) => r.lengthM),
    ...workbook.watercourses.created.map((r) => r.lengthM),
  ];
  const longestLinearM = linearLengths.length ? Math.max(...linearLengths) : 0;
  const minRadiusM = (longestLinearM * 1.2) / 2;
  const minAreaFromDiameterM2 = Math.PI * minRadiusM * minRadiusM;

  const totalAreaM2 = Math.max(habitatTotalM2, declaredSiteM2, minAreaFromDiameterM2);
  const totalAreaHa = totalAreaM2 / 10000;
  const siteName = String(workbook.siteInfo.projectName ?? "BNG500 site");

  header(`Generating BNG GeoPackage from workbook`, "cyan");
  info(`  source: ${sourceLabel}`);
  info(`  site: ${siteName} (${workbook.siteInfo.planningAuthority ?? "unknown LPA"})`);
  info(`  total area: ${totalAreaHa.toFixed(4)} ha (${Math.round(totalAreaM2)} m²)`);
  info(
    `  habitats: ${habitatRows.length} (${workbook.habitats.baseline.length} baseline, ` +
      `${workbook.habitats.created.length} created, ${workbook.habitats.enhancements.length} enhanced)`,
  );
  info(
    `  hedgerows: ${workbook.hedgerows.baseline.length} baseline + ${workbook.hedgerows.created.length} created`,
  );
  info(
    `  rivers: ${workbook.watercourses.baseline.length} baseline + ${workbook.watercourses.created.length} created`,
  );
  info(
    `  trees: ${workbook.trees.baseline.length} baseline + ${workbook.trees.created.length} created`,
  );
  info(`  centre: ${centre[0]},${centre[1]} (BNG)`);
  info(`  → ${outPath}`);

  if (totalAreaM2 < 100) {
    warn(`  total area is < 100 m² — workbook may be empty or unparseable; aborting`);
    return false;
  }

  const [cx, cy] = centre;

  const db = new Database(outPath);
  initGeoPackage(db);
  createAllTables(db);

  const ring = generateRedLineBoundaryFromArea(db, cx, cy, totalAreaM2);
  const habitatsWritten = generateHabitatsFromWorkbook(db, ring, habitatRows);
  const hedgerowsWritten = generateHedgerowsFromWorkbook(
    db, ring, workbook.hedgerows.baseline, workbook.hedgerows.created,
  );
  const riversWritten = generateRiversFromWorkbook(
    db, ring, workbook.watercourses.baseline, workbook.watercourses.created,
  );
  const treesWritten = generateUrbanTreesFromWorkbook(
    db, ring, workbook.trees.baseline, workbook.trees.created,
  );
  createLayerStyles(db);
  db.close();

  info(
    `  written: ${habitatsWritten} habitats, ${hedgerowsWritten} hedgerows, ` +
      `${riversWritten} rivers, ${treesWritten} trees`,
  );
  for (const w of workbook.summary.warnings) warn(`  ${w}`);
  for (const s of workbook.summary.skipped) {
    warn(`  skipped ${s.sheet}:${s.row} (${s.reason})`);
  }
  for (const r of skipReasons) warn(`  ${r}`);
  console.log(color("green", `✔ Done. ${outPath}`));
  return true;
}

function workbookOutputName(source) {
  // Strip trailing query/hash, keep last path segment, replace extension.
  const url = source.replace(/[?#].*$/, "");
  const base = path.basename(url).replace(/\.(xlsx|xlsm|xls)$/i, "");
  return `${base || "bng-from-workbook"}.gpkg`;
}

async function runFromWorkbook(source, { strict, inspect, centre }) {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const localPath = await resolveWorkbookSource(source);
  const workbook = readMetricWorkbook(localPath);

  if (inspect) {
    const summary = {
      source,
      resolvedPath: localPath,
      version: workbook.version,
      siteInfo: workbook.siteInfo,
      counts: {
        habitats: {
          baseline: workbook.habitats.baseline.length,
          created: workbook.habitats.created.length,
          enhancements: workbook.habitats.enhancements.length,
        },
        hedgerows: {
          baseline: workbook.hedgerows.baseline.length,
          created: workbook.hedgerows.created.length,
        },
        watercourses: {
          baseline: workbook.watercourses.baseline.length,
          created: workbook.watercourses.created.length,
        },
        trees: {
          baseline: workbook.trees.baseline.length,
          created: workbook.trees.created.length,
        },
      },
      summary: workbook.summary,
    };
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  const outPath = path.join(OUT_DIR, workbookOutputName(source));
  if (existsSync(outPath)) unlinkSync(outPath);
  generateOneFromWorkbook(outPath, workbook, source, { strict, centre });
}

async function main() {
  if (args.inspect && !args.from) {
    error("--inspect requires --from <path-or-url>");
    process.exit(1);
  }

  const centre = parseCentre(args.centre) ?? [DEFAULT_CENTRE_E, DEFAULT_CENTRE_N];

  if (args["from-list"]) {
    const listPath = path.resolve(args["from-list"]);
    if (!existsSync(listPath)) {
      error(`--from-list file not found: ${listPath}`);
      process.exit(1);
    }
    const entries = readFileSync(listPath, "utf8")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith("#"));
    for (const entry of entries) {
      try {
        await runFromWorkbook(entry, { strict: args["strict-habitats"], inspect: false, centre });
      } catch (e) {
        error(`Failed for ${entry}: ${e.message}`);
      }
    }
    return;
  }

  if (args.from) {
    await runFromWorkbook(args.from, {
      strict: args["strict-habitats"],
      inspect: args.inspect,
      centre,
    });
    return;
  }

  const numParcels = parseInt(args.size, 10) || 50;
  const total = Math.max(1, parseInt(args.count, 10) || 1);
  const bad = args.bad;

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

  for (let i = 1; i <= total; i++) {
    const suffix = total > 1 ? `-${String(i).padStart(3, "0")}` : "";
    const filename = bad
      ? `bng-test-data-bad${suffix}.gpkg`
      : `bng-test-data${suffix}.gpkg`;
    const outPath = path.join(OUT_DIR, filename);

    if (existsSync(outPath)) {
      if (total > 1) {
        unlinkSync(outPath);
      } else {
        const overwrite = await confirm(
          `${outPath} already exists. Overwrite? (y/N) `,
        );
        if (!overwrite) {
          console.log("Aborted.");
          process.exit(0);
        }
        unlinkSync(outPath);
      }
    }

    generateOne(outPath, bad, numParcels, centre);
  }
}

main().catch((err) => {
  error(err.stack || err.message || String(err));
  process.exit(1);
});
