/**
 * Workbook-driven writers for the Urban Trees (point) layer. Baseline and
 * post-intervention paths share the writer loop helper.
 */

import {
  SRS_ID,
  URBAN_TREES_INSERT_COLUMNS,
  filledArray,
  gpkgPoint,
  placeholders,
  registerLayer,
} from "./gpkg-core.mjs";
import { expandEnvelope, pickInteriorPoint } from "./geometry.mjs";
import {
  BASE_MAP,
  LOCATION_ON_SITE,
  RURAL_OR_URBAN_TREE_URBAN,
  SITE_NAME,
  SPATIAL_RISK_INSIDE_LPA,
  SURVEY_DATE,
  TREE_SIZE_DEFAULT,
  WORKBOOK_IMPORT_LABEL,
  WORKBOOK_SURVEY_DETAILS,
} from "./workbook-layers-shared.mjs";

const URBAN_TREES_SQL = `
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
  ) VALUES (${placeholders(URBAN_TREES_INSERT_COLUMNS)})
`;

const TREE_COUNT_DEFAULT = 1;

export function generateBaselineTreePoints(boundaryRing, baselineRows) {
  const points = [];
  const byRef = new Map();
  for (const row of baselineRows) {
    const point = pickInteriorPoint(boundaryRing);
    points.push(point);
    if (point) {
      byRef.set(row.baselineRef, point);
    }
  }
  return { points, byRef };
}

/**
 * Shared point-feature writer loop. Each per-mode writer just supplies a
 * `bindings(row, point)` function that maps to the INSERT placeholder order.
 */
function writePointFeatureLayer(db, sql, tableName, points, rows, bindings) {
  const stmt = db.prepare(sql);
  const allEnvelope = [Infinity, -Infinity, Infinity, -Infinity];
  let written = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const point = points[i];
    if (point) {
      const [x, y] = point;
      expandEnvelope(allEnvelope, [x, x, y, y]);
      stmt.run(...bindings(rows[i], point));
      written += 1;
    }
  }
  registerLayer(db, tableName, "POINT", written > 0 ? allEnvelope : null);
  return written;
}

function treeBaselineBindings(r, [x, y]) {
  return [
    gpkgPoint(SRS_ID, x, y),
    r.ref,
    TREE_SIZE_DEFAULT, // workbook doesn't carry a tree size
    r.condition,
    r.strategicSig,
    r.type,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    SITE_NAME,
    SURVEY_DATE,
    WORKBOOK_SURVEY_DETAILS,
    null,
    WORKBOOK_IMPORT_LABEL,
    WORKBOOK_IMPORT_LABEL,
    BASE_MAP,
    TREE_COUNT_DEFAULT,
    RURAL_OR_URBAN_TREE_URBAN,
    null,
  ];
}

function treePostBindings(r, [x, y]) {
  return [
    gpkgPoint(SRS_ID, x, y),
    r.ref,
    TREE_SIZE_DEFAULT,
    r.baseline?.condition ?? null,
    r.baseline?.strategicSig ?? null,
    r.baseline?.type ?? null,
    r.retention,
    r.retention === "Lost" ? "Lost" : "Retained",
    TREE_SIZE_DEFAULT,
    r.proposed.condition,
    r.proposed.strategicSig,
    r.proposed.type,
    LOCATION_ON_SITE,
    String(r.proposed.advanceYears ?? 0),
    String(r.proposed.delayYears ?? 0),
    SPATIAL_RISK_INSIDE_LPA,
    SITE_NAME,
    SURVEY_DATE,
    WORKBOOK_SURVEY_DETAILS,
    null,
    WORKBOOK_IMPORT_LABEL,
    WORKBOOK_IMPORT_LABEL,
    BASE_MAP,
    TREE_COUNT_DEFAULT,
    r.baseline ? RURAL_OR_URBAN_TREE_URBAN : null,
    RURAL_OR_URBAN_TREE_URBAN,
  ];
}

export function writeUrbanTreesBaseline(db, points, rows) {
  return writePointFeatureLayer(db, URBAN_TREES_SQL, "Urban Trees", points, rows, treeBaselineBindings);
}

/**
 * Derive post-intervention tree points — retained/enhanced rows reuse the
 * baseline point at the same baseline ref; Created rows get a fresh
 * interior point.
 */
export function derivePostInterventionTreePoints(boundaryRing, baselinePointsByRef, postRows) {
  const out = filledArray(postRows.length);
  for (let i = 0; i < postRows.length; i += 1) {
    const r = postRows[i];
    if (r.retention === "Created") {
      out[i] = pickInteriorPoint(boundaryRing);
    } else if (r.baselineRef && baselinePointsByRef.has(r.baselineRef)) {
      out[i] = baselinePointsByRef.get(r.baselineRef);
    }
  }
  return out;
}

export function writeUrbanTreesPostIntervention(db, points, rows) {
  return writePointFeatureLayer(db, URBAN_TREES_SQL, "Urban Trees", points, rows, treePostBindings);
}
