
WITH

features_in AS (
  SELECT layer, idx, props::jsonb AS props,
         ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(g), srid), 27700) AS geom
  FROM unnest($1::text[], $2::int[], $3::text[], $4::text[], $5::int[])
    AS t(layer, idx, props, g, srid)
),
-- Per-layer views over features_in.
redline      AS (SELECT idx, props, geom FROM features_in WHERE layer = 'redline'),
areas        AS (SELECT idx, props, geom FROM features_in WHERE layer = 'areas'),
hedgerows    AS (SELECT idx, props, geom FROM features_in WHERE layer = 'hedgerows'),
watercourses AS (SELECT idx, props, geom FROM features_in WHERE layer = 'watercourses'),
iggis        AS (SELECT idx, props, geom FROM features_in WHERE layer = 'iggis'),
trees        AS (SELECT idx, props, geom FROM features_in WHERE layer = 'trees'),
-- Single dissolved geometry per layer used for containment / leftover checks.
-- ST_MakeValid first so we don't propagate self-intersection failures.
redline_union AS (SELECT ST_Union(ST_MakeValid(geom)) AS geom FROM redline),
parcels_union AS (SELECT ST_Union(ST_MakeValid(geom)) AS geom FROM areas),
-- England reference polygon, reprojected to match.
england AS (
  SELECT ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON($6), 4326), 27700) AS geom
),

-- ---------------------------------------------------------------------------
-- Per-check CTEs. Each one resolves to either an empty rowset (check passes)
-- or one+ rows that the final UNION ALL converts into an error row.
-- ---------------------------------------------------------------------------

c_redline_total AS (
  SELECT COALESCE(SUM(ST_Area(geom)), 0) AS total, COUNT(*) AS n FROM redline
),
c_habitats_total AS (
  SELECT COALESCE(SUM(ST_Area(geom)), 0) AS total, COUNT(*) AS n FROM areas
),
-- Redline must lie wholly within England.
-- In plain English: subtract England from the redline; whatever's left is the
-- redline's escaping bit. Flag if its area exceeds the tolerance.
-- (Area-of-difference rather than strict ST_Within so coastline-adjacent
-- redlines aren't tripped by sub-millimetre numerical noise on the shared edge.)
c_redline_outside_england AS (
  SELECT 1 AS hit
  FROM redline feat, england engl
  WHERE ST_Area(ST_Difference(ST_MakeValid(feat.geom), engl.geom, 0.001)) > 0.5
  LIMIT 1
),
-- Invalid redline geometry. ST_IsValid catches self-intersection, ring
-- orientation problems, duplicate rings, hole-outside-shell, etc.;
-- ST_IsValidDetail surfaces the specific reason + location so the error
-- message can name what's wrong.
c_redline_invalid AS (
  SELECT (ST_IsValidDetail(geom)).reason AS reason,
         ST_AsText((ST_IsValidDetail(geom)).location) AS location_wkt
  FROM redline
  WHERE NOT ST_IsValid(geom)
  LIMIT 1
),
-- Each remaining CTE returns one row per offending feature so the final
-- UNION ALL can aggregate count + capped sample for the response. Per-layer
-- offenders carry idx (position within the layer), fid (SQLite primary key),
-- and feature_ref (Parcel Ref / Tree Ref / Baseline Parcel Ref — first
-- non-null wins).

-- List every self-intersecting / invalid area habitat polygon.
c_areas_invalid AS (
  SELECT idx,
         props->>'fid' AS fid,
         COALESCE(props->>'Parcel Ref', props->>'Tree Ref', props->>'Baseline Parcel Ref') AS feature_ref,
         (ST_IsValidDetail(geom)).reason AS reason
  FROM areas
  WHERE NOT ST_IsValid(geom)
),
-- List every overlapping pair (idx_a < idx_b avoids duplicates).
-- Reads the GiST-indexed temp table rather than the inline areas view so
-- the planner prunes candidate pairs by bounding box instead of testing
-- every pair; its geometries are already valid, so no per-pair ST_MakeValid.
-- That means ST_Intersects sees repaired geometry too: an invalid parcel is
-- compared as the shape ST_MakeValid resolves it into, and a pair GEOS refuses
-- to evaluate against the raw ring ("side location conflict") no longer takes
-- the whole check down. See the invalid-parcel overlap cases in
-- integration-tests/postgis-validate-baseline-layers.test.js.
c_overlap_offending AS (
  SELECT prc1.idx AS idx_a,
         prc1.props->>'fid' AS fid_a,
         COALESCE(prc1.props->>'Parcel Ref', prc1.props->>'Tree Ref', prc1.props->>'Baseline Parcel Ref') AS feature_ref_a,
         prc2.idx AS idx_b,
         prc2.props->>'fid' AS fid_b,
         COALESCE(prc2.props->>'Parcel Ref', prc2.props->>'Tree Ref', prc2.props->>'Baseline Parcel Ref') AS feature_ref_b
  FROM areas_g prc1 JOIN areas_g prc2
    ON prc1.idx < prc2.idx AND ST_Intersects(prc1.geom, prc2.geom)
  WHERE ST_Area(ST_Intersection(prc1.geom, prc2.geom, 0.001)) > 0.5
),
-- Area habitat parcels whose own footprint is under MIN_PARCEL_AREA_SQ_M as
-- supplied in the file. Area only — a parcel is not judged on how thin or
-- elongated it is. Reported per parcel, with the area, so the user can find the
-- offending polygon and redraw it. Zero-area parcels are included: unlike
-- derived overlay geometry, a parcel the file itself declares with no area is
-- always a mistake.
c_areas_too_small AS (
  SELECT idx,
         props->>'fid' AS fid,
         COALESCE(props->>'Parcel Ref', props->>'Tree Ref', props->>'Baseline Parcel Ref') AS feature_ref,
         ST_Area(ST_MakeValid(geom)) AS area_sqm
  FROM areas
  WHERE ST_Area(ST_MakeValid(geom)) < 1
),
-- Habitat parcel parts that fall outside the redline, reported as the
-- *escaping geometry* rather than as a list of parcels (the per-parcel view
-- below does that). Subtract the redline from the dissolved parcels and dump
-- the result into individual pieces; each piece bigger than
-- PARCEL_OUTSIDE_TOLERANCE_SQ_M is a sliver that shouldn't be there. Threshold
-- matches the per-parcel view so boundary noise from shared edges is suppressed
-- in both.
c_slivers_outside AS (
  SELECT ST_Area(g) AS area_sqm,
         ST_AsText(g) AS location_wkt
  FROM (
    SELECT (ST_Dump(ST_Difference(parc.geom, redl.geom, 0.001))).geom AS g
    FROM parcels_union parc CROSS JOIN redline_union redl
    WHERE parc.geom IS NOT NULL AND redl.geom IS NOT NULL
  ) leftover
  WHERE ST_Area(g) > 0.5
),
-- Habitat parcels that fall (partially) outside the redline.
-- In plain English: subtract the redline from each parcel; whatever's left is
-- the parcel's escaping bit. Flag if its area exceeds the tolerance.
-- (Area-of-difference rather than strict ST_Within so parcels sharing boundary
-- edges with the redline aren't false-flagged by GEOS robustness wobbles.)
-- Also exposes the escape geometry's area + WKT so the per-parcel report can
-- be merged with the per-piece sliver view into a single line in the UI.
c_areas_outside AS (
  SELECT idx, fid, feature_ref,
         ST_Area(escape) AS escape_area_sqm,
         ST_AsText(escape) AS escape_location_wkt
  FROM (
    SELECT feat.idx,
           feat.props->>'fid' AS fid,
           COALESCE(feat.props->>'Parcel Ref', feat.props->>'Tree Ref', feat.props->>'Baseline Parcel Ref') AS feature_ref,
           ST_Difference(ST_MakeValid(feat.geom), redl.geom, 0.001) AS escape
    FROM areas feat CROSS JOIN redline_union redl
    WHERE redl.geom IS NOT NULL
  ) sub
  WHERE ST_Area(escape) > 0.5
),
-- Linear habitat layers (hedgerows, watercourses) outside the redline.
-- In plain English: subtract the redline polygon from the feature line; whatever's
-- left is the bit of the line that escapes. Flag if its length exceeds
-- OUTSIDE_BOUNDARY_TOLERANCE_M.
-- (Length-of-difference rather than strict ST_Within so lines whose endpoints sit
-- on the redline boundary aren't false-flagged by GEOS robustness wobbles — a
-- vertex one ULP (Unit in the Last Place, the smallest representable float gap,
-- ~6e-11 m at British National Grid / EPSG:27700 magnitudes) outside the edge
-- gives ST_Within=false even though the geometric distance is zero.)
c_hedgerows_outside AS (
  SELECT feat.idx,
         feat.props->>'fid' AS fid,
         COALESCE(feat.props->>'Parcel Ref', feat.props->>'Tree Ref', feat.props->>'Baseline Parcel Ref') AS feature_ref
  FROM hedgerows feat CROSS JOIN redline_union redl
  WHERE redl.geom IS NOT NULL
    AND ST_Length(ST_Difference(feat.geom, redl.geom, 0.001)) > 0.1
),
c_watercourses_outside AS (
  SELECT feat.idx,
         feat.props->>'fid' AS fid,
         COALESCE(feat.props->>'Parcel Ref', feat.props->>'Tree Ref', feat.props->>'Baseline Parcel Ref') AS feature_ref
  FROM watercourses feat CROSS JOIN redline_union redl
  WHERE redl.geom IS NOT NULL
    AND ST_Length(ST_Difference(feat.geom, redl.geom, 0.001)) > 0.1
),
-- IGGIs (polygons in current uploads): same shape as c_areas_outside.
-- In plain English: subtract the redline from each IGGI; flag if the area of
-- whatever's left exceeds the tolerance. Reuses PARCEL_OUTSIDE_TOLERANCE_SQ_M
-- because both are area features sharing edges with the redline.
c_iggis_outside AS (
  SELECT feat.idx,
         feat.props->>'fid' AS fid,
         COALESCE(feat.props->>'Parcel Ref', feat.props->>'Tree Ref', feat.props->>'Baseline Parcel Ref') AS feature_ref
  FROM iggis feat CROSS JOIN redline_union redl
  WHERE redl.geom IS NOT NULL
    AND ST_Area(ST_Difference(ST_MakeValid(feat.geom), redl.geom, 0.001)) > 0.5
),
-- Trees are points.
-- In plain English: ST_DWithin(point, polygon, tol) is true if the point is
-- inside, on the boundary, or within tol metres outside. Flag any tree
-- where it's false.
-- (ST_Within alone returns FALSE for any point exactly on the boundary —
-- a point has no interior to intersect the polygon's interior.)
c_trees_outside AS (
  SELECT feat.idx,
         feat.props->>'fid' AS fid,
         COALESCE(feat.props->>'Parcel Ref', feat.props->>'Tree Ref', feat.props->>'Baseline Parcel Ref') AS feature_ref
  FROM trees feat CROSS JOIN redline_union redl
  WHERE redl.geom IS NOT NULL AND NOT ST_DWithin(feat.geom, redl.geom, 0.1)
)

-- ---------------------------------------------------------------------------
-- Output: one row per triggered error. Codes match ERROR_CODES on the Node
-- side; payloads are consumed by ERROR_BUILDERS to construct the final error
-- objects. HAVING count(*) > 0 suppresses zero-row aggregates so passing
-- checks emit nothing at all.
-- ---------------------------------------------------------------------------

SELECT 'NO_REDLINE' AS code, '{}'::jsonb AS payload
FROM c_redline_total WHERE n = 0
UNION ALL
SELECT 'REDLINE_OUTSIDE_ENGLAND', '{}'::jsonb
FROM c_redline_outside_england
UNION ALL
SELECT 'REDLINE_AREA_TOO_LARGE', jsonb_build_object('total', total)
FROM c_redline_total WHERE total > 100000000
UNION ALL
SELECT 'NO_HABITAT_AREAS', '{}'::jsonb
FROM c_habitats_total WHERE n = 0
UNION ALL
SELECT 'REDLINE_INVALID_GEOMETRY',
       jsonb_build_object('reason', reason, 'location_wkt', location_wkt)
FROM c_redline_invalid
UNION ALL
SELECT 'AREA_PARCELS_INVALID_GEOMETRY',
       jsonb_build_object(
         'count', count(*),
         'sample', (
           SELECT jsonb_agg(jsonb_build_object('idx', idx, 'fid', fid, 'feature_ref', feature_ref, 'reason', reason) ORDER BY idx)
           FROM (SELECT idx, fid, feature_ref, reason FROM c_areas_invalid ORDER BY idx LIMIT 50) s
         )
       )
FROM c_areas_invalid
HAVING count(*) > 0
UNION ALL
SELECT 'PARCEL_OVERLAPS',
       jsonb_build_object(
         'count', count(*),
         'sample', (
           SELECT jsonb_agg(jsonb_build_object('idx_a', idx_a, 'fid_a', fid_a, 'feature_ref_a', feature_ref_a, 'idx_b', idx_b, 'fid_b', fid_b, 'feature_ref_b', feature_ref_b) ORDER BY idx_a, idx_b)
           FROM (SELECT * FROM c_overlap_offending ORDER BY idx_a, idx_b LIMIT 50) s
         )
       )
FROM c_overlap_offending
HAVING count(*) > 0
UNION ALL
SELECT 'AREA_PARCELS_TOO_SMALL',
       jsonb_build_object(
         'count', count(*),
         'sample', (
           SELECT jsonb_agg(jsonb_build_object('idx', idx, 'fid', fid, 'feature_ref', feature_ref, 'area_sqm', area_sqm) ORDER BY idx)
           FROM (SELECT idx, fid, feature_ref, area_sqm FROM c_areas_too_small ORDER BY idx LIMIT 50) s
         )
       )
FROM c_areas_too_small
HAVING count(*) > 0
UNION ALL
SELECT 'SLIVERS_OUTSIDE_REDLINE',
       jsonb_build_object(
         'count', count(*),
         'sample', (
           SELECT jsonb_agg(jsonb_build_object('area_sqm', area_sqm, 'location_wkt', location_wkt) ORDER BY area_sqm DESC)
           FROM (SELECT area_sqm, location_wkt FROM c_slivers_outside ORDER BY area_sqm DESC LIMIT 50) s
         )
       )
FROM c_slivers_outside
HAVING count(*) > 0
UNION ALL
SELECT 'AREA_PARCELS_OUTSIDE_REDLINE',
       jsonb_build_object(
         'count', count(*),
         'sample', (
           SELECT jsonb_agg(jsonb_build_object('idx', idx, 'fid', fid, 'feature_ref', feature_ref, 'escape_area_sqm', escape_area_sqm, 'escape_location_wkt', escape_location_wkt) ORDER BY idx)
           FROM (SELECT idx, fid, feature_ref, escape_area_sqm, escape_location_wkt FROM c_areas_outside ORDER BY idx LIMIT 50) s
         )
       )
FROM c_areas_outside
HAVING count(*) > 0
UNION ALL
SELECT 'HEDGEROWS_OUTSIDE_REDLINE',
       jsonb_build_object(
         'count', count(*),
         'sample', (
           SELECT jsonb_agg(jsonb_build_object('idx', idx, 'fid', fid, 'feature_ref', feature_ref) ORDER BY idx)
           FROM (SELECT idx, fid, feature_ref FROM c_hedgerows_outside ORDER BY idx LIMIT 50) s
         )
       )
FROM c_hedgerows_outside
HAVING count(*) > 0
UNION ALL
SELECT 'WATERCOURSES_OUTSIDE_REDLINE',
       jsonb_build_object(
         'count', count(*),
         'sample', (
           SELECT jsonb_agg(jsonb_build_object('idx', idx, 'fid', fid, 'feature_ref', feature_ref) ORDER BY idx)
           FROM (SELECT idx, fid, feature_ref FROM c_watercourses_outside ORDER BY idx LIMIT 50) s
         )
       )
FROM c_watercourses_outside
HAVING count(*) > 0
UNION ALL
SELECT 'IGGIS_OUTSIDE_REDLINE',
       jsonb_build_object(
         'count', count(*),
         'sample', (
           SELECT jsonb_agg(jsonb_build_object('idx', idx, 'fid', fid, 'feature_ref', feature_ref) ORDER BY idx)
           FROM (SELECT idx, fid, feature_ref FROM c_iggis_outside ORDER BY idx LIMIT 50) s
         )
       )
FROM c_iggis_outside
HAVING count(*) > 0
UNION ALL
SELECT 'TREES_OUTSIDE_REDLINE',
       jsonb_build_object(
         'count', count(*),
         'sample', (
           SELECT jsonb_agg(jsonb_build_object('idx', idx, 'fid', fid, 'feature_ref', feature_ref) ORDER BY idx)
           FROM (SELECT idx, fid, feature_ref FROM c_trees_outside ORDER BY idx LIMIT 50) s
         )
       )
FROM c_trees_outside
HAVING count(*) > 0
UNION ALL
SELECT 'AREA_SUM_MISMATCH',
       jsonb_build_object('redline_total', rtot.total, 'habitats_total', htot.total)
FROM c_redline_total rtot CROSS JOIN c_habitats_total htot
WHERE rtot.n > 0 AND htot.n > 0 AND abs(rtot.total - htot.total) > 0.5
