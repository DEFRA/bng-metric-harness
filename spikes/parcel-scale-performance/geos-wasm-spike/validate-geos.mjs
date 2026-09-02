/**
 * Baseline GeoPackage geometry validation, run entirely in-process with GEOS
 * compiled to WebAssembly — the same library PostGIS calls, so every predicate,
 * overlay and tolerance is a like-for-like of the SQL in
 * backend/src/validation/geopackage/postgis/index.js.
 *
 * The GiST index is replaced by a bounding-box sweep in JS, which was measured
 * to reproduce the exact candidate-pair set the index produces.
 */
import fs from 'node:fs'
import initGeosJs from 'geos-wasm'
import { geojsonToGeosGeom } from 'geos-wasm/helpers'

const MIN_PARCEL_AREA_SQ_M = 1
const OVERLAP_TOLERANCE_SQ_M = 0.5
const AREA_SUM_TOLERANCE_SQ_M = 0.5
const MAX_REDLINE_AREA_SQ_M = 100 * 1000 * 1000
const PARCEL_OUTSIDE_TOLERANCE_SQ_M = 0.5
const OVERLAY_GRID_SIZE_M = 0.001
const OUTSIDE_BOUNDARY_TOLERANCE_M = 0.1
const REDLINE_OUTSIDE_ENGLAND_TOLERANCE_SQ_M = 0.5
const EPSG_BNG = 27700

const geos = await initGeosJs()
const M = geos.Module
const dbl = M._malloc(8)
/** GEOSArea / GEOSLength return via an out-pointer. */
const area = (g) => { geos.GEOSArea(g, dbl); return M.HEAPF64[dbl >> 3] }
const length = (g) => { geos.GEOSLength(g, dbl); return M.HEAPF64[dbl >> 3] }
const free = (g) => { if (g) geos.GEOSGeom_destroy(g) }

const ENGLAND_JSON = JSON.parse(fs.readFileSync(new URL('./england-27700.json', import.meta.url), 'utf8'))

/** Bounding box of a GeoJSON geometry. */
function bbox (geom) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  const walk = (c) => {
    if (typeof c[0] === 'number') {
      if (c[0] < x0) x0 = c[0]; if (c[0] > x1) x1 = c[0]
      if (c[1] < y0) y0 = c[1]; if (c[1] > y1) y1 = c[1]
      return
    }
    for (const n of c) walk(n)
  }
  walk(geom.coordinates)
  return [x0, y0, x1, y1]
}

/** Every pair whose bounding boxes overlap. Replaces the GiST index scan. */
function candidatePairs (boxes) {
  const order = boxes.map((_, i) => i).sort((a, b) => boxes[a][0] - boxes[b][0])
  const pairs = []
  const active = []
  for (const i of order) {
    const bi = boxes[i]
    for (let k = active.length - 1; k >= 0; k--) {
      const j = active[k]
      if (boxes[j][2] < bi[0]) { active[k] = active[active.length - 1]; active.pop(); continue }
      if (boxes[j][1] <= bi[3] && boxes[j][3] >= bi[1]) pairs.push(i < j ? [i, j] : [j, i])
    }
    active.push(i)
  }
  return pairs
}

const refOf = (p) => p?.['Parcel Ref'] ?? p?.['Tree Ref'] ?? p?.['Baseline Parcel Ref'] ?? null
const fidOf = (p) => (p?.fid == null ? null : String(p.fid))

/** Load one layer's features into GEOS, keeping raw and repaired geometry. */
function loadLayer (features) {
  return features.filter((f) => f.nativeGeometry).map((f, idx) => {
    if (f.nativeSrid !== EPSG_BNG) throw new Error(`unsupported SRID ${f.nativeSrid} — needs proj4 reprojection`)
    const geom = geojsonToGeosGeom(f.nativeGeometry, geos)
    return { idx, fid: fidOf(f.properties), ref: refOf(f.properties), geom, valid: geos.GEOSMakeValid(geom) }
  })
}

export function validateWithGeos (layers) {
  const L = {}
  for (const k of ['redline', 'areas', 'hedgerows', 'watercourses', 'iggis', 'trees']) L[k] = loadLayer(layers[k] ?? [])
  const errors = []
  const push = (code, details) => errors.push(details ? { code, details } : { code })
  const owned = []
  const keep = (g) => { owned.push(g); return g }

  try {
    // --- totals, computed on the RAW geometry exactly as the SQL does --------
    const redlineTotal = L.redline.reduce((a, f) => a + area(f.geom), 0)
    const habitatsTotal = L.areas.reduce((a, f) => a + area(f.geom), 0)
    if (L.redline.length === 0) push('NO_REDLINE')

    let redlineUnion = null
    if (L.redline.length) {
      const coll = keep(geos.GEOSGeom_createCollection(7, // GEOS_GEOMETRYCOLLECTION
        toPtrArray(L.redline.map((f) => geos.GEOSGeom_clone(f.valid))), L.redline.length))
      redlineUnion = keep(geos.GEOSUnaryUnion(coll))
      // REDLINE_OUTSIDE_ENGLAND
      const england = keep(geojsonToGeosGeom(ENGLAND_JSON, geos))
      for (const f of L.redline) {
        const d = geos.GEOSDifferencePrec(f.valid, england, OVERLAY_GRID_SIZE_M)
        const a = area(d); free(d)
        if (a > REDLINE_OUTSIDE_ENGLAND_TOLERANCE_SQ_M) { push('REDLINE_OUTSIDE_ENGLAND'); break }
      }
      if (redlineTotal > MAX_REDLINE_AREA_SQ_M) push('REDLINE_AREA_TOO_LARGE')
    }
    if (L.areas.length === 0) push('NO_HABITAT_AREAS')

    // --- REDLINE_INVALID_GEOMETRY -------------------------------------------
    for (const f of L.redline) {
      if (geos.GEOSisValid(f.geom) !== 1) { push('REDLINE_INVALID_GEOMETRY'); break }
    }

    // --- AREA_PARCELS_INVALID_GEOMETRY --------------------------------------
    const invalid = L.areas.filter((f) => geos.GEOSisValid(f.geom) !== 1)
    if (invalid.length) push('AREA_PARCELS_INVALID_GEOMETRY', { count: invalid.length })

    // --- PARCEL_OVERLAPS: bbox sweep, then the exact area test --------------
    const boxes = L.areas.map((f) => bbox(layers.areas[f.idx].nativeGeometry))
    let overlaps = 0
    for (const [i, j] of candidatePairs(boxes)) {
      const a = L.areas[i], b = L.areas[j]
      if (geos.GEOSIntersects(a.valid, b.valid) !== 1) continue
      const x = geos.GEOSIntersectionPrec(a.valid, b.valid, OVERLAY_GRID_SIZE_M)
      const ar = area(x); free(x)
      if (ar > OVERLAP_TOLERANCE_SQ_M) overlaps++
    }
    if (overlaps) push('PARCEL_OVERLAPS', { count: overlaps })

    // --- AREA_PARCELS_TOO_SMALL ---------------------------------------------
    const tooSmall = L.areas.filter((f) => area(f.valid) < MIN_PARCEL_AREA_SQ_M)
    if (tooSmall.length) push('AREA_PARCELS_TOO_SMALL', { count: tooSmall.length })

    // --- escapes, gated by CoveredBy; feeds both outside-the-redline errors --
    if (redlineUnion) {
      const prepared = geos.GEOSPrepare(redlineUnion)
      const escapes = []
      let outside = 0
      for (const f of L.areas) {
        if (geos.GEOSPreparedCoveredBy(prepared, f.valid) === 1) continue
        const esc = geos.GEOSDifferencePrec(f.valid, redlineUnion, OVERLAY_GRID_SIZE_M)
        if (area(esc) > PARCEL_OUTSIDE_TOLERANCE_SQ_M) outside++
        escapes.push(esc)
      }
      if (outside) push('AREA_PARCELS_OUTSIDE_REDLINE', { count: outside })

      // SLIVERS: union the escapes, dump, threshold each piece
      if (escapes.length) {
        const coll = geos.GEOSGeom_createCollection(7, toPtrArray(escapes), escapes.length)
        const u = geos.GEOSUnaryUnion(coll)
        let slivers = 0
        const n = geos.GEOSGetNumGeometries(u)
        for (let k = 0; k < n; k++) {
          if (area(geos.GEOSGetGeometryN(u, k)) > PARCEL_OUTSIDE_TOLERANCE_SQ_M) slivers++
        }
        if (slivers) push('SLIVERS_OUTSIDE_REDLINE', { count: slivers })
        free(u); free(coll)
      }

      // --- linear layers ----------------------------------------------------
      for (const [key, code] of [['hedgerows', 'HEDGEROWS_OUTSIDE_REDLINE'], ['watercourses', 'WATERCOURSES_OUTSIDE_REDLINE']]) {
        let n = 0
        for (const f of L[key]) {
          if (geos.GEOSPreparedCoveredBy(prepared, f.geom) === 1) continue
          const d = geos.GEOSDifferencePrec(f.geom, redlineUnion, OVERLAY_GRID_SIZE_M)
          const len = length(d); free(d)
          if (len > OUTSIDE_BOUNDARY_TOLERANCE_M) n++
        }
        if (n) push(code, { count: n })
      }
      let iggis = 0
      for (const f of L.iggis) {
        if (geos.GEOSPreparedCoveredBy(prepared, f.valid) === 1) continue
        const d = geos.GEOSDifferencePrec(f.valid, redlineUnion, OVERLAY_GRID_SIZE_M)
        const a = area(d); free(d)
        if (a > PARCEL_OUTSIDE_TOLERANCE_SQ_M) iggis++
      }
      if (iggis) push('IGGIS_OUTSIDE_REDLINE', { count: iggis })

      let trees = 0
      for (const f of L.trees) {
        if (geos.GEOSDistanceWithin(f.geom, redlineUnion, OUTSIDE_BOUNDARY_TOLERANCE_M) !== 1) trees++
      }
      if (trees) push('TREES_OUTSIDE_REDLINE', { count: trees })
      geos.GEOSPreparedGeom_destroy(prepared)
    }

    // --- AREA_SUM_MISMATCH ---------------------------------------------------
    if (L.redline.length && L.areas.length &&
        Math.abs(redlineTotal - habitatsTotal) > AREA_SUM_TOLERANCE_SQ_M) push('AREA_SUM_MISMATCH')
  } finally {
    for (const g of owned) free(g)
    for (const k of Object.keys(L)) for (const f of L[k]) { free(f.geom); free(f.valid) }
  }

  const ORDER = ['NO_REDLINE','REDLINE_OUTSIDE_ENGLAND','REDLINE_AREA_TOO_LARGE','NO_HABITAT_AREAS',
    'REDLINE_INVALID_GEOMETRY','AREA_PARCELS_INVALID_GEOMETRY','PARCEL_OVERLAPS','AREA_PARCELS_TOO_SMALL',
    'SLIVERS_OUTSIDE_REDLINE','AREA_PARCELS_OUTSIDE_REDLINE','HEDGEROWS_OUTSIDE_REDLINE',
    'WATERCOURSES_OUTSIDE_REDLINE','IGGIS_OUTSIDE_REDLINE','TREES_OUTSIDE_REDLINE','AREA_SUM_MISMATCH']
  const byCode = new Map(errors.map((e) => [e.code, e]))
  const ordered = ORDER.filter((c) => byCode.has(c)).map((c) => byCode.get(c))
  return { valid: ordered.length === 0, errors: ordered }
}

/** Copy an array of geometry pointers into WASM memory for createCollection. */
function toPtrArray (ptrs) {
  const buf = M._malloc(ptrs.length * 4)
  for (let i = 0; i < ptrs.length; i++) M.HEAPU32[(buf >> 2) + i] = ptrs[i]
  return buf
}
