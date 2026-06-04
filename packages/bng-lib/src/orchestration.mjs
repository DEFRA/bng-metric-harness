/**
 * Workbook-driven orchestration. Lays out the baseline geometry, optionally
 * derives the post-intervention pair, and returns write statistics for the
 * caller's banner. Lives in the package so the CLI and the web handler share
 * a single code path — only the surrounding file-management differs.
 */

import {
  SRS_ID,
  createAllTables,
  createLayerStyles,
  openGeoPackage,
  registerLayer,
} from "./bng-schema.mjs";
import { envelopeFromCoords, gpkgPolygon } from "./gpkg-io/index.mjs";
import { polygonArea } from "./geometry.mjs";
import { color, header, info, warn } from "./log.mjs";
import {
  buildBaselineRows,
  buildPostInterventionRows,
} from "./workbook/workbook-rows.mjs";
import {
  MIN_GENERATED_AREA_SQ_M,
  computeWorkbookFixturePlan,
  derivePostInterventionHabitatCells,
  derivePostInterventionLinearCoords,
  derivePostInterventionTreePoints,
  generateBaselineHedgerowGeometry,
  generateBaselineRiverGeometry,
  generateBaselineTreePoints,
  generateRedLineBoundaryFromArea,
  partitionBaselineHabitats,
  writeHabitatsBaseline,
  writeHabitatsPostIntervention,
  writeHedgerowsBaseline,
  writeHedgerowsPostIntervention,
  writeRiversBaseline,
  writeRiversPostIntervention,
  writeUrbanTreesBaseline,
  writeUrbanTreesPostIntervention,
} from "./workbook/workbook-layers.mjs";

export const MODE_BASELINE = "baseline";
export const MODE_POST_INTERVENTION = "post-intervention";
export const MODE_BOTH = "both";
export const VALID_MODES = new Set([MODE_BASELINE, MODE_POST_INTERVENTION, MODE_BOTH]);

const IN_MEMORY_DB = ":memory:";

/**
 * Generate the baseline GeoPackage. Lays out the RLB, partitions habitats,
 * picks linear feature routes and tree positions. Returns the geometry it
 * produced so the post-intervention pass can derive from it.
 */
export function generateBaselineFile(outPath, _workbook, baselineRows, plan, centre) {
  const [cx, cy] = centre;
  const db = openGeoPackage(outPath);
  createAllTables(db);

  const ring = generateRedLineBoundaryFromArea(db, cx, cy, plan.totalAreaM2);

  const { cells: habitatCells, byRef: habitatCellsByRef } =
    partitionBaselineHabitats(ring, baselineRows.habitats);
  const habitatsWritten = writeHabitatsBaseline(db, habitatCells, baselineRows.habitats);

  const { coordsList: hedgeCoords, byRef: hedgeCoordsByRef } =
    generateBaselineHedgerowGeometry(ring, baselineRows.hedgerows);
  const hedgesWritten = writeHedgerowsBaseline(db, hedgeCoords, baselineRows.hedgerows);

  const { coordsList: riverCoords, byRef: riverCoordsByRef } =
    generateBaselineRiverGeometry(ring, baselineRows.rivers);
  const riversWritten = writeRiversBaseline(db, riverCoords, baselineRows.rivers);

  const { points: treePoints, byRef: treePointsByRef } =
    generateBaselineTreePoints(ring, baselineRows.trees);
  const treesWritten = writeUrbanTreesBaseline(db, treePoints, baselineRows.trees);

  createLayerStyles(db);
  db.close();

  return {
    ring,
    habitatCellsByRef,
    hedgeCoordsByRef,
    riverCoordsByRef,
    treePointsByRef,
    written: {
      habitats: habitatsWritten,
      hedgerows: hedgesWritten,
      rivers: riversWritten,
      trees: treesWritten,
    },
  };
}

/**
 * Generate the post-intervention GeoPackage, reusing the baseline RLB and
 * deriving each layer's geometry from the baseline's.
 */
export function generatePostInterventionFile(outPath, workbook, postRows, baselineGeom, plan) {
  const db = openGeoPackage(outPath);
  createAllTables(db);

  const ring = baselineGeom.ring;
  const geom = gpkgPolygon(SRS_ID, ring);
  db.prepare(`INSERT INTO "Red Line Boundary" (geometry, "Area", "Site Name") VALUES (?, ?, ?)`)
    .run(geom, Math.round(polygonArea(ring)), plan.siteName);
  registerLayer(db, "Red Line Boundary", "POLYGON", envelopeFromCoords(ring));

  const habitatCells = derivePostInterventionHabitatCells(
    baselineGeom.habitatCellsByRef,
    workbook.habitats.baseline,
    postRows.habitats,
    postRows.warnings,
  );
  const habitatsWritten = writeHabitatsPostIntervention(db, habitatCells, postRows.habitats);

  const hedgeCoords = derivePostInterventionLinearCoords(ring, baselineGeom.hedgeCoordsByRef, postRows.hedgerows);
  const hedgesWritten = writeHedgerowsPostIntervention(db, hedgeCoords, postRows.hedgerows);

  const riverCoords = derivePostInterventionLinearCoords(ring, baselineGeom.riverCoordsByRef, postRows.rivers);
  const riversWritten = writeRiversPostIntervention(db, riverCoords, postRows.rivers);

  const treePoints = derivePostInterventionTreePoints(ring, baselineGeom.treePointsByRef, postRows.trees);
  const treesWritten = writeUrbanTreesPostIntervention(db, treePoints, postRows.trees);

  createLayerStyles(db);
  db.close();

  return {
    written: {
      habitats: habitatsWritten,
      hedgerows: hedgesWritten,
      rivers: riversWritten,
      trees: treesWritten,
    },
  };
}

function logWorkbookFixtureBanner({
  workbook,
  sourceLabel,
  centre,
  outPath,
  habitatRows,
  plan,
  mode,
}) {
  header(`Generating BNG GeoPackage from workbook`, "cyan");
  info(`  source: ${sourceLabel}`);
  info(
    `  site: ${plan.siteName} (${workbook.siteInfo.planningAuthority ?? "unknown LPA"})`,
  );
  info(`  mode: ${mode ?? MODE_BOTH}`);
  info(
    `  total area: ${plan.totalAreaHa.toFixed(4)} ha (${Math.round(plan.totalAreaM2)} m²)`,
  );
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
}

function logWorkbookFileSummary(label, written, outPath) {
  info(
    `  ${label}: ${written.habitats} habitats, ${written.hedgerows} hedgerows, ${written.rivers} rivers, ${written.trees} trees → ${outPath}`,
  );
}

function surfaceWorkbookWarnings(workbook, baselineRows, postRows) {
  for (const w of workbook.summary.warnings) {
    warn(`  ${w}`);
  }
  for (const s of workbook.summary.skipped) {
    warn(`  skipped ${s.sheet}:${s.row} (${s.reason})`);
  }
  for (const r of baselineRows.skipReasons) {
    warn(`  ${r}`);
  }
  if (postRows) {
    for (const r of postRows.skipReasons) {
      warn(`  ${r}`);
    }
    for (const r of postRows.warnings) {
      warn(`  ${r}`);
    }
  }
}

function bannerOutPath(outPaths, mode) {
  if (mode === MODE_BOTH) {
    return `${outPaths.baseline} + ${outPaths.postIntervention}`;
  }
  return outPaths.baseline ?? outPaths.postIntervention;
}

/**
 * Top-level workbook → gpkg orchestration. Caller picks file paths. Returns
 * { success, plan } so the caller can decide what to do with the produced
 * files (e.g. read them back as buffers, attach to a zip, etc).
 *
 * When `mode === MODE_POST_INTERVENTION` the baseline pipeline still runs
 * — its geometry is the input to post-intervention derivation — but it
 * writes to an in-memory throwaway db, so only outPaths.postIntervention
 * is produced.
 */
export function generateFromWorkbook(
  outPaths,
  workbook,
  sourceLabel,
  { strict = false, centre, mode = MODE_BOTH } = {},
) {
  const baselineRows = buildBaselineRows(workbook, { strict });
  const postRows = mode === MODE_BASELINE ? null : buildPostInterventionRows(workbook, { strict });

  const habitatRowsForSizing = baselineRows.habitats.map((r) => ({ area: r.area }));
  const plan = computeWorkbookFixturePlan(workbook, habitatRowsForSizing);

  logWorkbookFixtureBanner({
    workbook,
    sourceLabel,
    centre,
    outPath: bannerOutPath(outPaths, mode),
    habitatRows: baselineRows.habitats,
    plan,
    mode,
  });

  if (plan.totalAreaM2 < MIN_GENERATED_AREA_SQ_M) {
    warn(
      `  total area is < ${MIN_GENERATED_AREA_SQ_M} m² — workbook may be empty or unparseable; aborting`,
    );
    return { success: false, plan };
  }

  const baselineDest = mode === MODE_POST_INTERVENTION ? IN_MEMORY_DB : outPaths.baseline;
  const baselineGeom = generateBaselineFile(baselineDest, workbook, baselineRows, plan, centre);
  if (mode !== MODE_POST_INTERVENTION) {
    logWorkbookFileSummary("baseline", baselineGeom.written, outPaths.baseline);
  }

  if (mode !== MODE_BASELINE) {
    const postWritten = generatePostInterventionFile(
      outPaths.postIntervention,
      workbook,
      postRows,
      baselineGeom,
      plan,
    );
    logWorkbookFileSummary("post-intervention", postWritten.written, outPaths.postIntervention);
  }

  surfaceWorkbookWarnings(workbook, baselineRows, postRows);
  info(color("green", `✔ Done.`));
  return { success: true, plan };
}
