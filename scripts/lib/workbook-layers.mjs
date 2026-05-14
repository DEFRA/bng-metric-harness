/**
 * Workbook-driven layer generators: writers + geometry derivation for
 * baseline and post-intervention GeoPackages.
 *
 * The eight `write*` functions split each layer's column-population rules
 * along the baseline / post-intervention seam so it's obvious by reading
 * which file gets which values. Geometry derivation reuses the baseline's
 * cells / linestrings / points where possible, so the two files share an
 * identical RLB and post-intervention rows trace back to baseline parcels
 * by ref.
 *
 * Function-name convention used throughout:
 *   generate*  — produces fresh geometry from scratch (random sampling
 *                inside the RLB). Used for the baseline pass.
 *   derive*    — shapes the post-intervention geometry FROM the baseline
 *                geometry the caller passes in (slices baseline cells,
 *                walks consecutive segments of baseline linestrings,
 *                reuses baseline tree points). Never invents shapes for
 *                retained/enhanced rows — only Created rows get fresh
 *                geometry inside derive*, and only when no baseline
 *                ancestor exists to reuse.
 */

import {
  HABITATS_INSERT_COLUMNS,
  HEDGEROWS_INSERT_COLUMNS,
  RIVERS_INSERT_COLUMNS,
  SRS_ID,
  URBAN_TREES_INSERT_COLUMNS,
  gpkgLineString,
  gpkgPoint,
  gpkgPolygon,
  registerLayer,
} from "./gpkg-core.mjs";
import {
  carveTargetArea,
  envelopeFromCoords,
  expandEnvelope,
  generateIrregularPolygon,
  linestringLength,
  partitionPolygonByAreas,
  pick,
  pickInteriorPoint,
  pointInRing,
  polygonArea,
  randBetween,
  randInt,
  scaleRingToArea,
} from "./geometry.mjs";

// ---------------------------------------------------------------------------
// Site metadata defaults. Used identically for baseline and post-intervention
// rows so the two files share Site Name / Survey Date / etc. fields.
// ---------------------------------------------------------------------------

const SITE_NAME = "Oakwood Regional Development";
const SURVEY_DATE = "2025-06-15";
const BASE_MAP = "OS MasterMap";
const WORKBOOK_IMPORT_LABEL = "Workbook import";
const WORKBOOK_SURVEY_DETAILS = "From metric workbook";

// Default attribute values used by multiple writers — promoted to named
// constants so any rename / pick-list change happens in one place.
const LOCATION_ON_SITE = "On-site";
const TREE_SIZE_DEFAULT = "Medium";
const RURAL_OR_URBAN_TREE_URBAN = "Urban";
const SPATIAL_RISK_INSIDE_LPA = "Compensation inside LPA boundary or NCA of impact site";

// Pick lists used only by post-intervention writes (baseline writes leave
// these NULL).
const SPATIAL_RISK_HABITAT = [
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

// ---------------------------------------------------------------------------
// Habitats — baseline / post-intervention split
// ---------------------------------------------------------------------------

/**
 * Partition the boundary ring into baseline habitat cells, one per row. The
 * returned `byRef` map lets the post-intervention pass slice and reuse the
 * same cells.
 */
export function partitionBaselineHabitats(boundaryRing, baselineRows) {
  const targets = baselineRows.map((r) => r.area * HECTARES_TO_SQ_M);
  const cells = partitionPolygonByAreas(boundaryRing, targets);
  const byRef = new Map();
  cells.forEach((cell, i) => {
    if (cell && baselineRows[i]) {
      byRef.set(baselineRows[i].baselineRef, cell);
    }
  });
  return { cells, byRef };
}

// Both baseline and post-intervention writers use the same INSERT — only the
// per-row column values differ. Aliased to keep the writer bodies readable.
const HABITATS_SQL = `
  INSERT INTO "Habitats" (
    geometry, "Parcel Ref", "Baseline Broad Habitat Type", "Baseline Habitat Type",
    "Area", "Baseline Condition", "Baseline Strategic Significance",
    "Retention Category", "Proposed Broad Habitat Type", "Proposed Habitat Type",
    "Proposed Condition", "Proposed Strategic Significance",
    "Habitat created in advance/years", "Delay in starting habitat creation/years",
    "Spatial risk category", "Location", "Site Name", "Survey Date",
    "Survey Details", "Comment", "Mapped by", "Company", "Base Map",
    "Baseline Distinctiveness", "Proposed Distinctiveness"
  ) VALUES (${Array(HABITATS_INSERT_COLUMNS).fill("?").join(", ")})
`;

export function writeHabitatsBaseline(db, cells, rows) {
  if (rows.length === 0) {
    registerLayer(db, "Habitats", "POLYGON", null);
    return 0;
  }
  const stmt = db.prepare(HABITATS_SQL);
  const allEnvelope = [Infinity, -Infinity, Infinity, -Infinity];
  let written = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const cell = cells[i];
    if (!cell) {
      continue;
    }
    const geom = gpkgPolygon(SRS_ID, cell);
    expandEnvelope(allEnvelope, envelopeFromCoords(cell));
    stmt.run(
      geom,
      r.ref,
      r.broad,                       // Baseline Broad Habitat Type
      r.type,                        // Baseline Habitat Type
      Math.round(polygonArea(cell)), // Area
      r.condition,                   // Baseline Condition
      r.strategicSig,                // Baseline Strategic Significance
      null,                          // Retention Category
      null,                          // Proposed Broad Habitat Type
      null,                          // Proposed Habitat Type
      null,                          // Proposed Condition
      null,                          // Proposed Strategic Significance
      null,                          // Habitat created in advance/years
      null,                          // Delay in starting habitat creation/years
      null,                          // Spatial risk category
      null,                          // Location
      SITE_NAME,
      SURVEY_DATE,
      WORKBOOK_SURVEY_DETAILS,
      null,                          // Comment
      WORKBOOK_IMPORT_LABEL,
      WORKBOOK_IMPORT_LABEL,
      BASE_MAP,
      r.distinctiveness,             // Baseline Distinctiveness
      null,                          // Proposed Distinctiveness
    );
    written++;
  }
  registerLayer(db, "Habitats", "POLYGON", written > 0 ? allEnvelope : null);
  return written;
}

/**
 * Derive post-intervention habitat geometry from the baseline cells —
 * i.e. SLICE existing baseline polygons rather than generate fresh ones,
 * so retained/enhanced post rows occupy the same ground as their parent
 * baseline parcel.
 *
 * For each baseline parcel, the cell is partitioned in a single pass into:
 *   retained slice + enhanced slice + 0..N assigned-created slices + lost
 *   residual.
 *
 * Because the row builder has already matched A-2 created rows to baseline
 * parcels with sufficient lost-area capacity, assigned-created cells come
 * straight out of the same partition as their parent baseline — no
 * fragmentation risk and the geometry honours the baseline → created lineage
 * in the same way the refs do (H001a / H001b / H001c …).
 *
 * The lost residual (anything not claimed by an assigned-created row) feeds
 * an orphan pool that catches the remaining unmatched created rows. When a
 * fallback create comes back significantly undersized — because the pool is
 * fragmented and we don't union polygons — a warning is emitted.
 *
 * @param {Map} baselineCellsByRef
 * @param {Array} baselineRowsRaw  Workbook A-1 rows in original order.
 * @param {Array} postRows         Output of buildPostInterventionRows.
 * @param {string[]} warnings      Mutable warning sink.
 */
const LOST_POOL = "lostPool";
const ORPHAN_UNDERSIZE_WARN_RATIO = 0.7;

/**
 * Group post rows by baselineRef. Assigned-created rows carry a baselineRef
 * so they land in their parent baseline's group; unmatched created rows fall
 * out into the second return value.
 */
function groupPostRowsForGeometry(postRows) {
  const groupedByBaseline = new Map();
  const unassignedCreated = [];
  for (let i = 0; i < postRows.length; i++) {
    const r = postRows[i];
    if (r.baselineRef != null) {
      if (!groupedByBaseline.has(r.baselineRef)) {
        groupedByBaseline.set(r.baselineRef, []);
      }
      groupedByBaseline.get(r.baselineRef).push({ row: r, postIndex: i });
    } else if (r.retention === "Created") {
      unassignedCreated.push({ row: r, postIndex: i });
    }
  }
  return { groupedByBaseline, unassignedCreated };
}

/**
 * Compute the per-sub-cell area targets and their post-row assignments for
 * one baseline parcel. Output arrays are aligned and feed
 * partitionPolygonByAreas. Lost residual (not absorbed by an assigned-
 * created row) gets the sentinel "lostPool" assignment.
 */
function planBaselineCellPartition(baseline, cellArea, group) {
  const subTargets = [];
  const subAssignments = [];

  const retainedRow = group.find((g) => g.row.retention === "Retained");
  if (baseline.areaRetained > 0 && retainedRow) {
    subTargets.push((baseline.areaRetained / baseline.area) * cellArea);
    subAssignments.push(retainedRow.postIndex);
  }

  const enhancedRow = group.find((g) => g.row.retention === "Enhanced");
  if (baseline.areaEnhanced > 0 && enhancedRow) {
    subTargets.push((baseline.areaEnhanced / baseline.area) * cellArea);
    subAssignments.push(enhancedRow.postIndex);
  }

  let assignedCreatedM2 = 0;
  for (const g of group.filter((g) => g.row.retention === "Created")) {
    const target = g.row.area * HECTARES_TO_SQ_M;
    subTargets.push(target);
    subAssignments.push(g.postIndex);
    assignedCreatedM2 += target;
  }

  const residualLostM2 = (baseline.areaLost / baseline.area) * cellArea - assignedCreatedM2;
  if (residualLostM2 > MIN_GENERATED_AREA_SQ_M) {
    subTargets.push(residualLostM2);
    subAssignments.push(LOST_POOL);
  }
  return { subTargets, subAssignments };
}

/**
 * Slice one baseline cell into sub-cells and distribute them to post-row
 * indices (or the orphan lost pool).
 */
function distributeBaselineCell(cell, subTargets, subAssignments, cellsForPost, orphanedLostPool) {
  if (subTargets.length === 0) {
    return;
  }
  const subCells = subTargets.length === 1 ? [cell] : partitionPolygonByAreas(cell, subTargets);
  for (let i = 0; i < subAssignments.length; i++) {
    const assignment = subAssignments[i];
    const sub = subCells[i];
    if (!sub) {
      continue;
    }
    if (assignment === LOST_POOL) {
      orphanedLostPool.push(sub);
    } else {
      cellsForPost[assignment] = sub;
    }
  }
}

/**
 * Allocate geometry for unmatched created rows from the orphan lost pool.
 * Pushes warnings when the pool can't satisfy a request (fragmented).
 */
function fillUnassignedCreatedFromOrphanPool(unassignedCreated, orphanedLostPool, cellsForPost, warnings) {
  if (unassignedCreated.length === 0) {
    return;
  }
  if (orphanedLostPool.length === 0) {
    for (const u of unassignedCreated) {
      warnings.push(`created habitat ${u.row.ref}: no lost-area pool available — geometry omitted`);
    }
    return;
  }
  const targets = unassignedCreated.map((u) => u.row.area * HECTARES_TO_SQ_M);
  const allocated = allocateAcrossPool(orphanedLostPool, targets);
  for (let i = 0; i < unassignedCreated.length; i++) {
    warnOrAssignOrphanCell(unassignedCreated[i], allocated[i], targets[i], cellsForPost, warnings);
  }
}

function warnOrAssignOrphanCell(unassigned, cell, target, cellsForPost, warnings) {
  if (!cell) {
    warnings.push(`created habitat ${unassigned.row.ref}: orphan lost-area pool exhausted — geometry omitted`);
    return;
  }
  cellsForPost[unassigned.postIndex] = cell;
  const actualM2 = polygonArea(cell);
  if (actualM2 < target * ORPHAN_UNDERSIZE_WARN_RATIO) {
    warnings.push(
      `created habitat ${unassigned.row.ref}: orphan-pool carve produced ${(actualM2 / HECTARES_TO_SQ_M).toFixed(4)} ha, requested ${(target / HECTARES_TO_SQ_M).toFixed(4)} ha (lost-area pool is fragmented)`,
    );
  }
}

export function derivePostInterventionHabitatCells(baselineCellsByRef, baselineRowsRaw, postRows, warnings = []) {
  const cellsForPost = new Array(postRows.length).fill(null);
  const orphanedLostPool = [];
  const { groupedByBaseline, unassignedCreated } = groupPostRowsForGeometry(postRows);

  for (const b of baselineRowsRaw) {
    const baselineRef = String(b.ref);
    const cell = baselineCellsByRef.get(baselineRef);
    if (!cell || b.area <= 0) {
      continue;
    }
    const group = groupedByBaseline.get(baselineRef) ?? [];
    const { subTargets, subAssignments } = planBaselineCellPartition(b, polygonArea(cell), group);
    distributeBaselineCell(cell, subTargets, subAssignments, cellsForPost, orphanedLostPool);
  }

  fillUnassignedCreatedFromOrphanPool(unassignedCreated, orphanedLostPool, cellsForPost, warnings);
  return cellsForPost;
}

/**
 * Distribute carve targets across a pool of polygons. For each target,
 * picks the largest available pool polygon, carves the target out, and
 * pushes the remainder back into the pool. Returns one cell per target,
 * or null if a target couldn't be satisfied.
 */
function allocateAcrossPool(pool, targets) {
  const out = new Array(targets.length).fill(null);
  const live = pool.slice();
  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    if (target <= 0) {
      continue;
    }
    live.sort((a, b) => polygonArea(b) - polygonArea(a));
    if (live.length === 0) {
      break;
    }
    const big = live[0];
    if (polygonArea(big) <= target + 1) {
      // Use the whole polygon — close enough.
      out[i] = big;
      live.shift();
      continue;
    }
    const carved = carveTargetArea(big, target);
    if (!carved) {
      out[i] = big;
      live.shift();
      continue;
    }
    out[i] = carved.piece;
    live[0] = carved.rest;
  }
  return out;
}

export function writeHabitatsPostIntervention(db, cells, rows) {
  if (rows.length === 0) {
    registerLayer(db, "Habitats", "POLYGON", null);
    return 0;
  }
  const stmt = db.prepare(HABITATS_SQL);
  const allEnvelope = [Infinity, -Infinity, Infinity, -Infinity];
  let written = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const cell = cells[i];
    if (!cell) {
      continue;
    }
    const geom = gpkgPolygon(SRS_ID, cell);
    expandEnvelope(allEnvelope, envelopeFromCoords(cell));
    stmt.run(
      geom,
      r.ref,
      r.baseline?.broad ?? null,                       // Baseline Broad Habitat Type
      r.baseline?.type ?? null,                        // Baseline Habitat Type
      Math.round(polygonArea(cell)),                   // Area
      r.baseline?.condition ?? null,                   // Baseline Condition
      r.baseline?.strategicSig ?? null,                // Baseline Strategic Significance
      r.retention,                                     // Retention Category
      r.proposed.broad,                                // Proposed Broad Habitat Type
      r.proposed.type,                                 // Proposed Habitat Type
      r.proposed.condition,                            // Proposed Condition
      r.proposed.strategicSig,                         // Proposed Strategic Significance
      String(r.proposed.advanceYears ?? 0),
      String(r.proposed.delayYears ?? 0),
      pick(SPATIAL_RISK_HABITAT),
      LOCATION_ON_SITE,
      SITE_NAME,
      SURVEY_DATE,
      WORKBOOK_SURVEY_DETAILS,
      null,
      WORKBOOK_IMPORT_LABEL,
      WORKBOOK_IMPORT_LABEL,
      BASE_MAP,
      r.baseline?.distinctiveness ?? null,             // Baseline Distinctiveness
      r.proposed.distinctiveness,                      // Proposed Distinctiveness
    );
    written++;
  }
  registerLayer(db, "Habitats", "POLYGON", written > 0 ? allEnvelope : null);
  return written;
}

// ---------------------------------------------------------------------------
// Linestring generation shared by hedgerows and rivers
// ---------------------------------------------------------------------------

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
    if (!start) {
      return null;
    }
    const angle = Math.random() * 2 * Math.PI;
    const end = [
      start[0] + targetLengthM * Math.cos(angle),
      start[1] + targetLengthM * Math.sin(angle),
    ];
    if (!pointInRing(end, boundaryRing)) {
      continue;
    }

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
    if (points.length === 0) {
      continue;
    }
    points.push(end);
    return points;
  }
  return null;
}

/**
 * Derive post-intervention linear coords (hedgerows / rivers) — reuses
 * each baseline linestring by walking a cursor along it and handing out
 * consecutive, non-overlapping segments to its post rows. No fresh
 * sampling for retained/enhanced rows; only Created rows generate fresh.
 *
 * For a baseline of 100 m with 70 m retained + 30 m enhanced, the
 * retained slice covers [0, 70 m] and the enhanced slice covers
 * [70 m, 100 m].
 */
/**
 * Bucket baseline-derived post rows by baselineRef. Created rows are written
 * out directly with fresh geometry and don't appear in the returned groups.
 */
function bucketLinearPostRowsForDerivation(postRows, boundaryRing, out) {
  const groupsByBaseline = new Map();
  for (let i = 0; i < postRows.length; i++) {
    const r = postRows[i];
    if (r.retention === "Created") {
      out[i] = generateLinestringOfLength(boundaryRing, r.lengthM);
      continue;
    }
    if (!r.baselineRef) {
      continue;
    }
    if (!groupsByBaseline.has(r.baselineRef)) {
      groupsByBaseline.set(r.baselineRef, []);
    }
    groupsByBaseline.get(r.baselineRef).push({ row: r, postIndex: i });
  }
  return groupsByBaseline;
}

/**
 * Walk a cursor along `baseCoords` handing out consecutive segments to each
 * row in `group`, writing into `out`.
 */
function distributeBaselineLinestring(baseCoords, group, out) {
  const totalLen = linestringLength(baseCoords);
  let cursor = 0;
  for (const { row, postIndex } of group) {
    if (totalLen === 0 || cursor >= totalLen) {
      // Baseline exhausted — fall back to the full line so the row at
      // least carries something. Length will read shorter than the
      // workbook value, but the geometry is non-overlapping.
      out[postIndex] = baseCoords;
      continue;
    }
    const segment = sliceLinestringSegment(baseCoords, cursor, cursor + row.lengthM);
    out[postIndex] = segment ?? baseCoords;
    cursor += row.lengthM;
  }
}

export function derivePostInterventionLinearCoords(boundaryRing, baselineCoordsByRef, postRows) {
  const out = new Array(postRows.length).fill(null);
  const groupsByBaseline = bucketLinearPostRowsForDerivation(postRows, boundaryRing, out);

  for (const [baselineRef, group] of groupsByBaseline) {
    const baseCoords = baselineCoordsByRef.get(baselineRef);
    if (!baseCoords) {
      continue;
    }
    distributeBaselineLinestring(baseCoords, group, out);
  }

  return out;
}

/**
 * Return the sub-linestring between distances `startM` and `endM` along
 * `coords`. Walks vertex-to-vertex, interpolating on the segments that the
 * start and end points fall on.
 */
function sliceLinestringSegment(coords, startM, endM) {
  if (!coords || coords.length < 2 || endM <= startM) {
    return null;
  }
  const totalLen = linestringLength(coords);
  const sStart = Math.max(0, Math.min(startM, totalLen));
  const sEnd = Math.max(sStart, Math.min(endM, totalLen));
  if (sEnd - sStart < 0.5) {
    return null;
  }

  const out = [];
  let acc = 0;
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1];
    const b = coords[i];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const seg = Math.sqrt(dx * dx + dy * dy);
    const segStart = acc;
    const segEnd = acc + seg;
    if (segEnd < sStart) {
      acc = segEnd;
      continue;
    }
    if (segStart > sEnd) {
      break;
    }
    if (out.length === 0) {
      const t = seg === 0 ? 0 : (sStart - segStart) / seg;
      out.push([a[0] + dx * t, a[1] + dy * t]);
    }
    if (segEnd >= sEnd) {
      const t = seg === 0 ? 0 : (sEnd - segStart) / seg;
      out.push([a[0] + dx * t, a[1] + dy * t]);
      return out;
    }
    out.push(b);
    acc = segEnd;
  }
  return out.length >= 2 ? out : null;
}

// ---------------------------------------------------------------------------
// Hedgerows — baseline / post-intervention split
// ---------------------------------------------------------------------------

/**
 * Generate one linestring per baseline hedge row. Returns ordered coords
 * array (aligned to baselineRows) and a Map<baselineRef, coords>.
 */
export function generateBaselineHedgerowGeometry(boundaryRing, baselineRows) {
  const coordsList = [];
  const byRef = new Map();
  for (const row of baselineRows) {
    const coords = generateLinestringOfLength(boundaryRing, row.lengthM);
    coordsList.push(coords);
    if (coords) {
      byRef.set(row.baselineRef, coords);
    }
  }
  return { coordsList, byRef };
}

const HEDGEROWS_SQL = `
  INSERT INTO "Hedgerows" (
    geometry, "Parcel Ref", "Baseline Hedge Type", "Baseline Condition",
    "Baseline Strategic Significance", "Retention Category",
    "Proposed Hedge Type", "Proposed Condition", "Proposed Strategic Significance",
    "Length", "Habitat created in advance/years",
    "Delay in starting habitat creation/years", "Spatial risk category",
    "Location", "Site Name", "Survey Date", "Survey Details", "Comments",
    "Mapped by", "Company", "Base Map",
    "Baseline Distinctiveness", "Proposed Distinctiveness"
  ) VALUES (${Array(HEDGEROWS_INSERT_COLUMNS).fill("?").join(", ")})
`;

export function writeHedgerowsBaseline(db, coordsList, rows) {
  const stmt = db.prepare(HEDGEROWS_SQL);
  const allEnvelope = [Infinity, -Infinity, Infinity, -Infinity];
  let written = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const coords = coordsList[i];
    if (!coords) {
      continue;
    }
    expandEnvelope(allEnvelope, envelopeFromCoords(coords));
    stmt.run(
      gpkgLineString(SRS_ID, coords),
      r.ref,
      r.type,                                // Baseline Hedge Type
      r.condition,                           // Baseline Condition
      r.strategicSig,                        // Baseline Strategic Significance
      null,                                  // Retention Category
      null,                                  // Proposed Hedge Type
      null,                                  // Proposed Condition
      null,                                  // Proposed Strategic Significance
      r.lengthM,                             // Length
      null,                                  // Habitat created in advance/years
      null,                                  // Delay in starting habitat creation/years
      null,                                  // Spatial risk category
      null,                                  // Location
      SITE_NAME,
      SURVEY_DATE,
      WORKBOOK_SURVEY_DETAILS,
      null,
      WORKBOOK_IMPORT_LABEL,
      WORKBOOK_IMPORT_LABEL,
      BASE_MAP,
      r.distinctiveness,                     // Baseline Distinctiveness
      null,                                  // Proposed Distinctiveness
    );
    written++;
  }
  registerLayer(db, "Hedgerows", "LINESTRING", written > 0 ? allEnvelope : null);
  return written;
}

export function writeHedgerowsPostIntervention(db, coordsList, rows) {
  const stmt = db.prepare(HEDGEROWS_SQL);
  const allEnvelope = [Infinity, -Infinity, Infinity, -Infinity];
  let written = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const coords = coordsList[i];
    if (!coords) {
      continue;
    }
    expandEnvelope(allEnvelope, envelopeFromCoords(coords));
    stmt.run(
      gpkgLineString(SRS_ID, coords),
      r.ref,
      r.baseline?.type ?? null,
      r.baseline?.condition ?? null,
      r.baseline?.strategicSig ?? null,
      r.retention,
      r.proposed.type,
      r.proposed.condition,
      r.proposed.strategicSig,
      Math.round(linestringLength(coords)),
      String(r.proposed.advanceYears ?? 0),
      String(r.proposed.delayYears ?? 0),
      SPATIAL_RISK_INSIDE_LPA,
      LOCATION_ON_SITE,
      SITE_NAME,
      SURVEY_DATE,
      WORKBOOK_SURVEY_DETAILS,
      null,
      WORKBOOK_IMPORT_LABEL,
      WORKBOOK_IMPORT_LABEL,
      BASE_MAP,
      r.baseline?.distinctiveness ?? null,
      r.proposed.distinctiveness,
    );
    written++;
  }
  registerLayer(db, "Hedgerows", "LINESTRING", written > 0 ? allEnvelope : null);
  return written;
}

// ---------------------------------------------------------------------------
// Rivers — baseline / post-intervention split
// ---------------------------------------------------------------------------

const RIVERS_SQL = `
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
  ) VALUES (${Array(RIVERS_INSERT_COLUMNS).fill("?").join(", ")})
`;

export function generateBaselineRiverGeometry(boundaryRing, baselineRows) {
  const coordsList = [];
  const byRef = new Map();
  for (const row of baselineRows) {
    const coords = generateLinestringOfLength(boundaryRing, row.lengthM);
    coordsList.push(coords);
    if (coords) {
      byRef.set(row.baselineRef, coords);
    }
  }
  return { coordsList, byRef };
}

export function writeRiversBaseline(db, coordsList, rows) {
  const stmt = db.prepare(RIVERS_SQL);
  const allEnvelope = [Infinity, -Infinity, Infinity, -Infinity];
  let written = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const coords = coordsList[i];
    if (!coords) {
      continue;
    }
    expandEnvelope(allEnvelope, envelopeFromCoords(coords));
    stmt.run(
      gpkgLineString(SRS_ID, coords),
      r.ref,
      r.type,                                // Baseline River Type
      r.condition,                           // Baseline Condition
      r.strategicSig,                        // Baseline Strategic Significance
      null,                                  // Baseline Encroachment into Watercourse
      null,                                  // Baseline Encroachment into riparian zone
      null,                                  // Retention Category
      null,                                  // Proposed River Type
      null,                                  // Proposed Condition
      null,                                  // Proposed Strategic Significance
      r.lengthM,                             // Length
      null,                                  // Habitat created in advance/years
      null,                                  // Delay in starting habitat creation/years
      null,                                  // Spatial risk category
      null,                                  // Location
      null,                                  // Proposed Encroachment into Watercourse
      null,                                  // Proposed Encroachment into riparian zone
      SITE_NAME,
      SURVEY_DATE,
      WORKBOOK_SURVEY_DETAILS,
      null,
      WORKBOOK_IMPORT_LABEL,
      WORKBOOK_IMPORT_LABEL,
      BASE_MAP,
      null,                                  // Enhancement Type
      r.distinctiveness,                     // Baseline Distinctiveness
      null,                                  // Proposed Distinctiveness
    );
    written++;
  }
  registerLayer(db, "Rivers", "LINESTRING", written > 0 ? allEnvelope : null);
  return written;
}

export function writeRiversPostIntervention(db, coordsList, rows) {
  const stmt = db.prepare(RIVERS_SQL);
  const allEnvelope = [Infinity, -Infinity, Infinity, -Infinity];
  let written = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const coords = coordsList[i];
    if (!coords) {
      continue;
    }
    expandEnvelope(allEnvelope, envelopeFromCoords(coords));
    stmt.run(
      gpkgLineString(SRS_ID, coords),
      r.ref,
      r.baseline?.type ?? null,
      r.baseline?.condition ?? null,
      r.baseline?.strategicSig ?? null,
      "No Encroachment",
      "No Encroachment/No Encroachment",
      r.retention,
      r.proposed.type,
      r.proposed.condition,
      r.proposed.strategicSig,
      Math.round(linestringLength(coords)),
      String(r.proposed.advanceYears ?? 0),
      String(r.proposed.delayYears ?? 0),
      "Within waterbody catchment",
      LOCATION_ON_SITE,
      "No Encroachment",
      "No Encroachment/No Encroachment",
      SITE_NAME,
      SURVEY_DATE,
      WORKBOOK_SURVEY_DETAILS,
      null,
      WORKBOOK_IMPORT_LABEL,
      WORKBOOK_IMPORT_LABEL,
      BASE_MAP,
      null,
      r.baseline?.distinctiveness ?? null,
      r.proposed.distinctiveness,
    );
    written++;
  }
  registerLayer(db, "Rivers", "LINESTRING", written > 0 ? allEnvelope : null);
  return written;
}

// ---------------------------------------------------------------------------
// Urban Trees — baseline / post-intervention split
// ---------------------------------------------------------------------------

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
  ) VALUES (${Array(URBAN_TREES_INSERT_COLUMNS).fill("?").join(", ")})
`;

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

export function writeUrbanTreesBaseline(db, points, rows) {
  const stmt = db.prepare(URBAN_TREES_SQL);
  const allEnvelope = [Infinity, -Infinity, Infinity, -Infinity];
  let written = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const point = points[i];
    if (!point) {
      continue;
    }
    const [x, y] = point;
    expandEnvelope(allEnvelope, [x, x, y, y]);
    stmt.run(
      gpkgPoint(SRS_ID, x, y),
      r.ref,
      TREE_SIZE_DEFAULT,                     // Baseline Tree Size (workbook doesn't carry this)
      r.condition,                           // Baseline Condition
      r.strategicSig,                        // Baseline Strategic Significance
      r.type,                                // Baseline Tree Type
      null,                                  // Retention Category
      null,                                  // Category
      null,                                  // Proposed Tree Size
      null,                                  // Proposed Condition
      null,                                  // Proposed Strategic Significance
      null,                                  // Proposed Tree Type
      null,                                  // Location
      null,                                  // advance/years
      null,                                  // delay/years
      null,                                  // Spatial risk category
      SITE_NAME,
      SURVEY_DATE,
      WORKBOOK_SURVEY_DETAILS,
      null,
      WORKBOOK_IMPORT_LABEL,
      WORKBOOK_IMPORT_LABEL,
      BASE_MAP,
      1,                                     // Count
      RURAL_OR_URBAN_TREE_URBAN,             // Baseline Rural or Urban Tree
      null,                                  // Proposed Rural or Urban Tree
    );
    written++;
  }
  registerLayer(db, "Urban Trees", "POINT", written > 0 ? allEnvelope : null);
  return written;
}

/**
 * Derive post-intervention tree points — retained/enhanced rows reuse the
 * baseline point at the same baseline ref; Created rows get a fresh
 * interior point.
 */
export function derivePostInterventionTreePoints(boundaryRing, baselinePointsByRef, postRows) {
  const out = new Array(postRows.length).fill(null);
  for (let i = 0; i < postRows.length; i++) {
    const r = postRows[i];
    if (r.retention === "Created") {
      out[i] = pickInteriorPoint(boundaryRing);
      continue;
    }
    if (r.baselineRef && baselinePointsByRef.has(r.baselineRef)) {
      out[i] = baselinePointsByRef.get(r.baselineRef);
    }
  }
  return out;
}

export function writeUrbanTreesPostIntervention(db, points, rows) {
  const stmt = db.prepare(URBAN_TREES_SQL);
  const allEnvelope = [Infinity, -Infinity, Infinity, -Infinity];
  let written = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const point = points[i];
    if (!point) {
      continue;
    }
    const [x, y] = point;
    expandEnvelope(allEnvelope, [x, x, y, y]);
    stmt.run(
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
      1,
      r.baseline ? RURAL_OR_URBAN_TREE_URBAN : null,
      RURAL_OR_URBAN_TREE_URBAN,
    );
    written++;
  }
  registerLayer(db, "Urban Trees", "POINT", written > 0 ? allEnvelope : null);
  return written;
}
