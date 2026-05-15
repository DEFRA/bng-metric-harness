/**
 * Workbook-driven Habitats writers + geometry derivation. The other layers
 * (Hedgerows, Rivers, Urban Trees) live in their own sibling modules so no
 * file balloons past Sonar's 500-line ceiling:
 *
 *   - lib/workbook-layers-shared.mjs  — site-metadata constants, RLB,
 *                                       fixture-sizing
 *   - lib/workbook-layers-lines.mjs   — Hedgerows + Rivers
 *   - lib/workbook-layers-trees.mjs   — Urban Trees
 *
 * This file re-exports everything as a convenience so callers can import
 * from `./workbook-layers.mjs` without caring about the per-layer split.
 *
 * Function-name convention used throughout:
 *   generate*  — produces fresh geometry from scratch (random sampling
 *                inside the RLB). Used for the baseline pass.
 *   derive*    — shapes the post-intervention geometry FROM the baseline
 *                geometry the caller passes in. Never invents shapes for
 *                retained/enhanced rows — only Created rows get fresh
 *                geometry inside derive*, and only when no baseline
 *                ancestor exists to reuse.
 */

import {
  envelopeFromCoords,
  expandEnvelope,
  filledArray,
  gpkgPolygon,
  placeholders,
} from "#gpkg-io";
import {
  HABITATS_INSERT_COLUMNS,
  SRS_ID,
  registerLayer,
} from "../bng-schema.mjs";
import {
  carveTargetArea,
  partitionPolygonByAreas,
  pick,
  polygonArea,
} from "../geometry.mjs";
import {
  BASE_MAP,
  HECTARES_TO_SQ_M,
  LOCATION_ON_SITE,
  MIN_GENERATED_AREA_SQ_M,
  SITE_NAME,
  SPATIAL_RISK_HABITAT,
  SURVEY_DATE,
  WORKBOOK_IMPORT_LABEL,
  WORKBOOK_SURVEY_DETAILS,
} from "./workbook-layers-shared.mjs";

// Re-export so callers can keep their existing `import { ... } from "./workbook-layers.mjs"`.
export {
  HECTARES_TO_SQ_M,
  MIN_GENERATED_AREA_SQ_M,
  computeWorkbookFixturePlan,
  generateRedLineBoundaryFromArea,
} from "./workbook-layers-shared.mjs";
export {
  derivePostInterventionLinearCoords,
  generateBaselineHedgerowGeometry,
  generateBaselineRiverGeometry,
  writeHedgerowsBaseline,
  writeHedgerowsPostIntervention,
  writeRiversBaseline,
  writeRiversPostIntervention,
} from "./workbook-layers-lines.mjs";
export {
  derivePostInterventionTreePoints,
  generateBaselineTreePoints,
  writeUrbanTreesBaseline,
  writeUrbanTreesPostIntervention,
} from "./workbook-layers-trees.mjs";

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
// per-row column values differ.
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
  ) VALUES (${placeholders(HABITATS_INSERT_COLUMNS)})
`;

function writeHabitatLayer(db, cells, rows, bindings) {
  if (rows.length === 0) {
    registerLayer(db, "Habitats", "POLYGON", null);
    return 0;
  }
  const stmt = db.prepare(HABITATS_SQL);
  const allEnvelope = [Infinity, -Infinity, Infinity, -Infinity];
  let written = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const cell = cells[i];
    if (cell) {
      expandEnvelope(allEnvelope, envelopeFromCoords(cell));
      stmt.run(...bindings(rows[i], cell));
      written += 1;
    }
  }
  registerLayer(db, "Habitats", "POLYGON", written > 0 ? allEnvelope : null);
  return written;
}

function habitatBaselineBindings(r, cell) {
  return [
    gpkgPolygon(SRS_ID, cell),
    r.ref,
    r.broad,
    r.type,
    Math.round(polygonArea(cell)),
    r.condition,
    r.strategicSig,
    null, // Retention Category
    null, // Proposed Broad Habitat Type
    null, // Proposed Habitat Type
    null, // Proposed Condition
    null, // Proposed Strategic Significance
    null, // advance/years
    null, // delay/years
    null, // Spatial risk category
    null, // Location
    SITE_NAME,
    SURVEY_DATE,
    WORKBOOK_SURVEY_DETAILS,
    null, // Comment
    WORKBOOK_IMPORT_LABEL,
    WORKBOOK_IMPORT_LABEL,
    BASE_MAP,
    r.distinctiveness,
    null, // Proposed Distinctiveness
  ];
}

function habitatPostBindings(r, cell) {
  return [
    gpkgPolygon(SRS_ID, cell),
    r.ref,
    r.baseline?.broad ?? null,
    r.baseline?.type ?? null,
    Math.round(polygonArea(cell)),
    r.baseline?.condition ?? null,
    r.baseline?.strategicSig ?? null,
    r.retention,
    r.proposed.broad,
    r.proposed.type,
    r.proposed.condition,
    r.proposed.strategicSig,
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
    r.baseline?.distinctiveness ?? null,
    r.proposed.distinctiveness,
  ];
}

export function writeHabitatsBaseline(db, cells, rows) {
  return writeHabitatLayer(db, cells, rows, habitatBaselineBindings);
}

export function writeHabitatsPostIntervention(db, cells, rows) {
  return writeHabitatLayer(db, cells, rows, habitatPostBindings);
}

// ---------------------------------------------------------------------------
// Post-intervention habitat geometry derivation
// ---------------------------------------------------------------------------

const LOST_POOL = "lostPool";
const ORPHAN_UNDERSIZE_WARN_RATIO = 0.7;

/**
 * Group post rows by baselineRef. Assigned-created rows (lineage linkage)
 * carry a baselineRef so they land in their parent baseline's group;
 * unmatched created rows fall out into the second return value.
 */
function groupPostRowsForGeometry(postRows) {
  const groupedByBaseline = new Map();
  const unassignedCreated = [];
  for (let i = 0; i < postRows.length; i += 1) {
    const r = postRows[i];
    if (r.baselineRef != null) {
      if (!groupedByBaseline.has(r.baselineRef)) {
        groupedByBaseline.set(r.baselineRef, []);
      }
      groupedByBaseline.get(r.baselineRef).push({ row: r, postIndex: i });
    } else if (r.retention === "Created") {
      unassignedCreated.push({ row: r, postIndex: i });
    } else {
      // baseline-less, non-Created rows are unreachable in the current row
      // builder — defensive no-op for forward compatibility.
    }
  }
  return { groupedByBaseline, unassignedCreated };
}

/**
 * Compute the per-sub-cell area targets and their post-row assignments for
 * one baseline parcel. Lost residual gets the sentinel "lostPool" assignment.
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
  const createdEntries = group.filter((entry) => entry.row.retention === "Created");
  for (const entry of createdEntries) {
    const target = entry.row.area * HECTARES_TO_SQ_M;
    subTargets.push(target);
    subAssignments.push(entry.postIndex);
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
  for (let i = 0; i < subAssignments.length; i += 1) {
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
  for (let i = 0; i < unassignedCreated.length; i += 1) {
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

/**
 * Derive post-intervention habitat geometry from the baseline cells —
 * i.e. SLICE existing baseline polygons rather than generate fresh ones,
 * so retained/enhanced post rows occupy the same ground as their parent
 * baseline parcel. Assigned-created cells come straight out of the same
 * partition as their parent baseline (lineage preservation); unmatched
 * created rows fall back to the orphan lost pool with a warning when
 * fragmentation produces undersized cells.
 */
export function derivePostInterventionHabitatCells(baselineCellsByRef, baselineRowsRaw, postRows, warnings = []) {
  const cellsForPost = filledArray(postRows.length);
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
 * Distribute carve targets across a pool of polygons. For each target, picks
 * the largest available pool polygon, carves the target out, and pushes the
 * remainder back. Returns one cell per target, or null if unsatisfiable.
 */
function allocateAcrossPool(pool, targets) {
  const out = filledArray(targets.length);
  const live = pool.slice();
  for (let i = 0; i < targets.length; i += 1) {
    if (live.length === 0) {
      break;
    }
    if (targets[i] > 0) {
      live.sort((a, b) => polygonArea(b) - polygonArea(a));
      allocateOneTarget(live, targets[i], out, i);
    }
  }
  return out;
}

function allocateOneTarget(live, target, out, idx) {
  const big = live[0];
  if (polygonArea(big) <= target + 1) {
    out[idx] = big;
    live.shift();
    return;
  }
  const carved = carveTargetArea(big, target);
  if (!carved) {
    out[idx] = big;
    live.shift();
    return;
  }
  out[idx] = carved.piece;
  live[0] = carved.rest;
}
