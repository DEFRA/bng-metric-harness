/**
 * Shared constants used by all the workbook-driven writer modules:
 * site-metadata defaults, default pick-list values, fixture sizing rules,
 * and the RLB generator (which is layer-agnostic).
 */

import { SRS_ID, gpkgPolygon, registerLayer } from "./gpkg-core.mjs";
import {
  envelopeFromCoords,
  generateIrregularPolygon,
  polygonArea,
  scaleRingToArea,
} from "./geometry.mjs";

// ---------------------------------------------------------------------------
// Site metadata defaults. Used identically for baseline and post-intervention
// rows so the two files share Site Name / Survey Date / etc. fields.
// ---------------------------------------------------------------------------

export const SITE_NAME = "Oakwood Regional Development";
export const SURVEY_DATE = "2025-06-15";
export const BASE_MAP = "OS MasterMap";
export const WORKBOOK_IMPORT_LABEL = "Workbook import";
export const WORKBOOK_SURVEY_DETAILS = "From metric workbook";

// Default attribute values used by multiple writers — promoted to named
// constants so any rename / pick-list change happens in one place.
export const LOCATION_ON_SITE = "On-site";
export const TREE_SIZE_DEFAULT = "Medium";
export const RURAL_OR_URBAN_TREE_URBAN = "Urban";
export const SPATIAL_RISK_INSIDE_LPA = "Compensation inside LPA boundary or NCA of impact site";

// Pick list used only by post-intervention writes (baseline writes leave
// these NULL).
export const SPATIAL_RISK_HABITAT = [
  SPATIAL_RISK_INSIDE_LPA,
  "Compensation outside LPA or NCA of impact site, but in neighbouring LPA or NCA",
];

// ---------------------------------------------------------------------------
// Fixture sizing
// ---------------------------------------------------------------------------

export const HECTARES_TO_SQ_M = 10000;
// The boundary diameter must exceed the longest linear feature so it actually
// fits inside the polygon. 1.2× gives a comfortable margin.
const BOUNDARY_OVERSIZE_FACTOR = 1.2;
// Sites smaller than this are almost certainly an empty/unparseable workbook
// rather than a real BNG submission.
export const MIN_GENERATED_AREA_SQ_M = 100;
// Tiny-site floor: 0.1 ha minimum redline area so the partition algorithm has
// some slack to work with.
const MIN_RLB_AREA_M2 = 1000;
// Convex hull of random points in an annulus has area ≈ 0.85 × π × r²
// (depends on n, but stable for the default ~18 points).
const HULL_AREA_FACTOR = 0.85;

/**
 * Compute the redline area for a workbook-driven fixture. Picks the largest
 * of (sum of habitat areas, declared site area, area required to fit the
 * longest linear feature).
 */
export function computeWorkbookFixturePlan(workbook, habitatRows) {
  const habitatTotalM2 =
    habitatRows.reduce((s, r) => s + r.area, 0) * HECTARES_TO_SQ_M;
  const declaredSiteM2 =
    (workbook.siteInfo.totalSiteAreaHa ?? 0) * HECTARES_TO_SQ_M;

  const linearLengths = [
    ...workbook.hedgerows.baseline.map((h) => h.lengthM),
    ...workbook.hedgerows.created.map((h) => h.lengthM),
    ...workbook.watercourses.baseline.map((r) => r.lengthM),
    ...workbook.watercourses.created.map((r) => r.lengthM),
  ];
  const longestLinearM = linearLengths.length ? Math.max(...linearLengths) : 0;
  const minRadiusM = (longestLinearM * BOUNDARY_OVERSIZE_FACTOR) / 2;
  const minAreaFromDiameterM2 = Math.PI * minRadiusM * minRadiusM;

  const totalAreaM2 = Math.max(
    habitatTotalM2,
    declaredSiteM2,
    minAreaFromDiameterM2,
  );
  return {
    totalAreaM2,
    totalAreaHa: totalAreaM2 / HECTARES_TO_SQ_M,
    siteName: String(workbook.siteInfo.projectName ?? "BNG500 site"),
  };
}

export function generateRedLineBoundaryFromArea(db, cx, cy, totalAreaM2) {
  const targetRingArea = Math.max(totalAreaM2, MIN_RLB_AREA_M2);
  const radius = Math.sqrt(targetRingArea / (HULL_AREA_FACTOR * Math.PI));
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
