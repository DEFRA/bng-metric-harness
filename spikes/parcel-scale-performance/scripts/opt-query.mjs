/** Prototype: restructured baseline validation. Same inputs, same 15 error codes. */
export const GRID = 0.001
export const TOL = 0.5
export const MIN_AREA = 1
export const OUTSIDE_LEN_TOL = 0.1
export const MAX_REDLINE = 100 * 1000 * 1000
export const CAP = 50

/** One load statement for EVERY layer: parse + reproject + repair exactly once. */
export const LOAD_QUERY = /* sql */ `
CREATE TEMP TABLE feat_all ON COMMIT DROP AS
SELECT layer, idx, fid, feature_ref, geom, ST_MakeValid(geom) AS geom_valid
FROM (
  SELECT layer, idx, fid, feature_ref,
         ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(g), srid), 27700) AS geom
  FROM unnest($1::text[], $2::int[], $3::text[], $4::text[], $5::text[], $6::int[])
    AS t(layer, idx, fid, feature_ref, g, srid)
) s`

export const INDEX_QUERY = /* sql */ `
CREATE INDEX ON feat_all USING gist (geom_valid) WHERE layer = 'areas';
ANALYZE feat_all;`

export const CHECK_QUERY = /* sql */ `
WITH
redline      AS (SELECT * FROM feat_all WHERE layer = 'redline'),
areas        AS (SELECT * FROM feat_all WHERE layer = 'areas'),
hedgerows    AS (SELECT * FROM feat_all WHERE layer = 'hedgerows'),
watercourses AS (SELECT * FROM feat_all WHERE layer = 'watercourses'),
iggis        AS (SELECT * FROM feat_all WHERE layer = 'iggis'),
trees        AS (SELECT * FROM feat_all WHERE layer = 'trees'),
redline_union AS (SELECT ST_Union(geom_valid) AS geom FROM redline),
england AS (SELECT ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON($1), 4326), 27700) AS geom),

c_redline_total   AS (SELECT COALESCE(SUM(ST_Area(geom_valid)), 0) AS total, COUNT(*) AS n FROM redline),
c_habitats_total  AS (SELECT COALESCE(SUM(ST_Area(geom_valid)), 0) AS total, COUNT(*) AS n FROM areas),
c_redline_outside_england AS (
  SELECT 1 AS hit FROM redline feat, england engl
  WHERE ST_Area(ST_Difference(feat.geom_valid, engl.geom, ${GRID})) > ${TOL} LIMIT 1
),
c_redline_invalid AS (
  SELECT (ST_IsValidDetail(geom)).reason AS reason,
         ST_AsText((ST_IsValidDetail(geom)).location) AS location_wkt
  FROM redline WHERE NOT ST_IsValid(geom) LIMIT 1
),
c_areas_invalid AS (
  SELECT idx, fid, feature_ref, (ST_IsValidDetail(geom)).reason AS reason
  FROM areas WHERE NOT ST_IsValid(geom)
),
c_overlap_offending AS (
  SELECT a.idx AS idx_a, a.fid AS fid_a, a.feature_ref AS feature_ref_a,
         b.idx AS idx_b, b.fid AS fid_b, b.feature_ref AS feature_ref_b
  FROM feat_all a JOIN feat_all b
    ON a.layer = 'areas' AND b.layer = 'areas'
   AND a.idx < b.idx AND ST_Intersects(a.geom_valid, b.geom_valid)
  WHERE ST_Area(ST_Intersection(a.geom_valid, b.geom_valid, ${GRID})) > ${TOL}
),
c_areas_too_small AS (
  SELECT idx, fid, feature_ref, ST_Area(geom_valid) AS area_sqm
  FROM areas WHERE ST_Area(geom_valid) < ${MIN_AREA}
),
-- Escapes computed ONCE, per parcel, and only for parcels the redline does not
-- already cover. Both the per-parcel error and the dissolved-sliver error are
-- derived from this one rowset.
c_escapes AS (
  SELECT feat.idx, feat.fid, feat.feature_ref,
         ST_Difference(feat.geom_valid, redl.geom, ${GRID}) AS escape
  FROM areas feat CROSS JOIN redline_union redl
  WHERE redl.geom IS NOT NULL AND NOT ST_CoveredBy(feat.geom_valid, redl.geom)
),
c_areas_outside AS (
  SELECT idx, fid, feature_ref, ST_Area(escape) AS escape_area_sqm,
         ST_AsText(escape) AS escape_location_wkt
  FROM c_escapes WHERE ST_Area(escape) > ${TOL}
),
c_slivers_outside AS (
  SELECT ST_Area(g) AS area_sqm, ST_AsText(g) AS location_wkt
  FROM (SELECT (ST_Dump(ST_Union(escape))).geom AS g FROM c_escapes WHERE escape IS NOT NULL) leftover
  WHERE ST_Area(g) > ${TOL}
),
c_hedgerows_outside AS (
  SELECT feat.idx, feat.fid, feat.feature_ref
  FROM hedgerows feat CROSS JOIN redline_union redl
  WHERE redl.geom IS NOT NULL AND NOT ST_CoveredBy(feat.geom, redl.geom)
    AND ST_Length(ST_Difference(feat.geom, redl.geom, ${GRID})) > ${OUTSIDE_LEN_TOL}
),
c_watercourses_outside AS (
  SELECT feat.idx, feat.fid, feat.feature_ref
  FROM watercourses feat CROSS JOIN redline_union redl
  WHERE redl.geom IS NOT NULL AND NOT ST_CoveredBy(feat.geom, redl.geom)
    AND ST_Length(ST_Difference(feat.geom, redl.geom, ${GRID})) > ${OUTSIDE_LEN_TOL}
),
c_iggis_outside AS (
  SELECT feat.idx, feat.fid, feat.feature_ref
  FROM iggis feat CROSS JOIN redline_union redl
  WHERE redl.geom IS NOT NULL AND NOT ST_CoveredBy(feat.geom_valid, redl.geom)
    AND ST_Area(ST_Difference(feat.geom_valid, redl.geom, ${GRID})) > ${TOL}
),
c_trees_outside AS (
  SELECT feat.idx, feat.fid, feat.feature_ref
  FROM trees feat CROSS JOIN redline_union redl
  WHERE redl.geom IS NOT NULL AND NOT ST_DWithin(feat.geom, redl.geom, ${OUTSIDE_LEN_TOL})
)

SELECT 'NO_REDLINE' AS code, '{}'::jsonb AS payload FROM c_redline_total WHERE n = 0
UNION ALL SELECT 'REDLINE_OUTSIDE_ENGLAND', '{}'::jsonb FROM c_redline_outside_england
UNION ALL SELECT 'REDLINE_AREA_TOO_LARGE', jsonb_build_object('total', total) FROM c_redline_total WHERE total > ${MAX_REDLINE}
UNION ALL SELECT 'NO_HABITAT_AREAS', '{}'::jsonb FROM c_habitats_total WHERE n = 0
UNION ALL SELECT 'REDLINE_INVALID_GEOMETRY', jsonb_build_object('reason', reason, 'location_wkt', location_wkt) FROM c_redline_invalid
UNION ALL SELECT 'AREA_PARCELS_INVALID_GEOMETRY', jsonb_build_object('count', count(*), 'sample',
  (SELECT jsonb_agg(jsonb_build_object('idx', idx, 'fid', fid, 'feature_ref', feature_ref, 'reason', reason) ORDER BY idx)
   FROM (SELECT idx, fid, feature_ref, reason FROM c_areas_invalid ORDER BY idx LIMIT ${CAP}) s))
  FROM c_areas_invalid HAVING count(*) > 0
UNION ALL SELECT 'PARCEL_OVERLAPS', jsonb_build_object('count', count(*), 'sample',
  (SELECT jsonb_agg(jsonb_build_object('idx_a', idx_a, 'fid_a', fid_a, 'feature_ref_a', feature_ref_a, 'idx_b', idx_b, 'fid_b', fid_b, 'feature_ref_b', feature_ref_b) ORDER BY idx_a, idx_b)
   FROM (SELECT * FROM c_overlap_offending ORDER BY idx_a, idx_b LIMIT ${CAP}) s))
  FROM c_overlap_offending HAVING count(*) > 0
UNION ALL SELECT 'AREA_PARCELS_TOO_SMALL', jsonb_build_object('count', count(*), 'sample',
  (SELECT jsonb_agg(jsonb_build_object('idx', idx, 'fid', fid, 'feature_ref', feature_ref, 'area_sqm', area_sqm) ORDER BY idx)
   FROM (SELECT idx, fid, feature_ref, area_sqm FROM c_areas_too_small ORDER BY idx LIMIT ${CAP}) s))
  FROM c_areas_too_small HAVING count(*) > 0
UNION ALL SELECT 'SLIVERS_OUTSIDE_REDLINE', jsonb_build_object('count', count(*), 'sample',
  (SELECT jsonb_agg(jsonb_build_object('area_sqm', area_sqm, 'location_wkt', location_wkt) ORDER BY area_sqm DESC)
   FROM (SELECT area_sqm, location_wkt FROM c_slivers_outside ORDER BY area_sqm DESC LIMIT ${CAP}) s))
  FROM c_slivers_outside HAVING count(*) > 0
UNION ALL SELECT 'AREA_PARCELS_OUTSIDE_REDLINE', jsonb_build_object('count', count(*), 'sample',
  (SELECT jsonb_agg(jsonb_build_object('idx', idx, 'fid', fid, 'feature_ref', feature_ref, 'escape_area_sqm', escape_area_sqm, 'escape_location_wkt', escape_location_wkt) ORDER BY idx)
   FROM (SELECT idx, fid, feature_ref, escape_area_sqm, escape_location_wkt FROM c_areas_outside ORDER BY idx LIMIT ${CAP}) s))
  FROM c_areas_outside HAVING count(*) > 0
UNION ALL SELECT 'HEDGEROWS_OUTSIDE_REDLINE', jsonb_build_object('count', count(*), 'sample',
  (SELECT jsonb_agg(jsonb_build_object('idx', idx, 'fid', fid, 'feature_ref', feature_ref) ORDER BY idx)
   FROM (SELECT idx, fid, feature_ref FROM c_hedgerows_outside ORDER BY idx LIMIT ${CAP}) s))
  FROM c_hedgerows_outside HAVING count(*) > 0
UNION ALL SELECT 'WATERCOURSES_OUTSIDE_REDLINE', jsonb_build_object('count', count(*), 'sample',
  (SELECT jsonb_agg(jsonb_build_object('idx', idx, 'fid', fid, 'feature_ref', feature_ref) ORDER BY idx)
   FROM (SELECT idx, fid, feature_ref FROM c_watercourses_outside ORDER BY idx LIMIT ${CAP}) s))
  FROM c_watercourses_outside HAVING count(*) > 0
UNION ALL SELECT 'IGGIS_OUTSIDE_REDLINE', jsonb_build_object('count', count(*), 'sample',
  (SELECT jsonb_agg(jsonb_build_object('idx', idx, 'fid', fid, 'feature_ref', feature_ref) ORDER BY idx)
   FROM (SELECT idx, fid, feature_ref FROM c_iggis_outside ORDER BY idx LIMIT ${CAP}) s))
  FROM c_iggis_outside HAVING count(*) > 0
UNION ALL SELECT 'TREES_OUTSIDE_REDLINE', jsonb_build_object('count', count(*), 'sample',
  (SELECT jsonb_agg(jsonb_build_object('idx', idx, 'fid', fid, 'feature_ref', feature_ref) ORDER BY idx)
   FROM (SELECT idx, fid, feature_ref FROM c_trees_outside ORDER BY idx LIMIT ${CAP}) s))
  FROM c_trees_outside HAVING count(*) > 0
UNION ALL SELECT 'AREA_SUM_MISMATCH', jsonb_build_object('redline_total', rtot.total, 'habitats_total', htot.total)
  FROM c_redline_total rtot CROSS JOIN c_habitats_total htot
  WHERE rtot.n > 0 AND htot.n > 0 AND abs(rtot.total - htot.total) > ${TOL}`

/** Habitat sizing, off the same loaded table — no second parse. */
export const SIZING_QUERY = /* sql */ `
SELECT layer, fid,
       CASE WHEN layer = 'areas' THEN ST_Area(geom_valid) ELSE ST_Length(geom_valid) END AS size_value
FROM feat_all
WHERE layer IN ('areas', 'hedgerows', 'watercourses')
ORDER BY layer, idx`

const LAYER_NAMES = ['redline', 'areas', 'hedgerows', 'watercourses', 'iggis', 'trees']

export function buildArrays(layers) {
  const layerNames = [], idxs = [], fids = [], refs = [], geoms = [], srids = []
  for (const layerName of LAYER_NAMES) {
    ;(layers[layerName] ?? []).forEach((feature, index) => {
      if (!feature.nativeGeometry) return
      const p = feature.properties ?? {}
      layerNames.push(layerName)
      idxs.push(index)
      fids.push(p.fid == null ? null : String(p.fid))
      refs.push(p['Parcel Ref'] ?? p['Tree Ref'] ?? p['Baseline Parcel Ref'] ?? null)
      geoms.push(feature.geometryJson ?? JSON.stringify(feature.nativeGeometry))
      srids.push(feature.nativeSrid)
    })
  }
  return { layerNames, idxs, fids, refs, geoms, srids }
}
