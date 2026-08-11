#!/usr/bin/env node

/**
 * Generates the "pond straddling two baseline parcels" fixture pair.
 *
 * The scenario it models: a proposed pond is dug across the line where two
 * baseline parcels meet. A post-intervention GeoPackage cannot describe that
 * with a single row, because every area-habitat row carries the baseline
 * habitat it replaces — and this one waterbody replaces two different
 * baseline habitats. So the pond arrives as TWO rows, split along the
 * baseline parcel boundary: one biting a chunk out of parcel H001, one out of
 * H002. Together they are one pond on the map; separately they are two
 * lineages in the metric.
 *
 *   Baseline (2 parcels tiling a 200 m x 120 m redline):
 *     H001  west half   Grassland / Modified grassland   12,000 m2
 *     H002  east half   Cropland / Cereal crops          12,000 m2
 *
 *   Post-intervention (4 parcels tiling the same redline):
 *     H001a  retained grassland, pond footprint removed  11,172 m2
 *     H001b  pond, west of the old parcel boundary          828 m2
 *     H002a  retained cereal crops, pond footprint removed 11,172 m2
 *     H002b  pond, east of the old parcel boundary          828 m2
 *
 * H001b and H002b share the straight edge that used to divide H001 from H002,
 * so the two halves reassemble into one 1,656 m2 octagonal pond.
 *
 * Unlike `gen-gpkg.mjs` this is not a general CLI: every coordinate and
 * attribute is fixed, so repeat runs are byte-stable and the fixture can be
 * regenerated after a schema change. Only `--outdir` varies.
 *
 * Usage:
 *   node scripts/gen-gpkg-pond-straddle.mjs [--outdir <dir>]
 */

import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { gpkgPolygon } from "#gpkg-io";
// bng-library's exports map publishes the generators and the generic gpkg-io
// helpers, but not the BNG table DDL / SRS this script writes rows against
// directly — hence the path import past the map. It keeps the NE template
// schema single-sourced rather than restating the DDL here; an `./bng-schema`
// export in bng-library would let this become a bare specifier.
import {
  HABITATS_INSERT_COLUMNS,
  SRS_ID,
  createAllTables,
  createLayerStyles,
  openGeoPackage,
  registerLayer,
} from "../node_modules/bng-library/src/bng-schema.mjs";

import { HARNESS_ROOT, header, info } from "./_lib.mjs";

const { values: args } = parseArgs({
  options: { outdir: { type: "string", default: "" } },
  allowPositionals: false,
});

const OUT_DIR = args.outdir
  ? path.resolve(args.outdir)
  : path.resolve(HARNESS_ROOT, "example-files", "valid");

const BASELINE_FILENAME = "Baseline - pond straddling two parcels.gpkg";
const POST_FILENAME = "Post-intervention - pond straddling two parcels.gpkg";

// ---------------------------------------------------------------------------
// Geometry — EPSG:27700 metres, centred on Maidenhead like the other fixtures.
// ---------------------------------------------------------------------------

const CENTRE_E = 530000;
const CENTRE_N = 180000;

// Redline: 200 m x 120 m = 24,000 m2, split down the middle at CENTRE_E.
const RLB_HALF_WIDTH_M = 100;
const RLB_HALF_HEIGHT_M = 60;

// Pond: an octagon 60 m x 30 m centred exactly on the parcel boundary, so half
// its footprint falls in each baseline parcel.
const POND_HALF_WIDTH_M = 30;
const POND_HALF_HEIGHT_M = 15;
// Corner chamfers, which turn the rectangle into an octagon so the shape reads
// as a waterbody rather than a building plot. The shoulder offsets are where
// each chamfer meets the pond's straight sides.
const POND_CHAMFER_X_M = 12;
const POND_CHAMFER_Y_M = 6;
const POND_SHOULDER_X_M = POND_HALF_WIDTH_M - POND_CHAMFER_X_M;
const POND_SHOULDER_Y_M = POND_HALF_HEIGHT_M - POND_CHAMFER_Y_M;

const west = (m) => CENTRE_E - m;
const east = (m) => CENTRE_E + m;
const south = (m) => CENTRE_N - m;
const north = (m) => CENTRE_N + m;

const closeRing = (points) => [...points, points[0]];

/** The whole site. Both files carry this identical redline. */
const REDLINE_RING = closeRing([
  [west(RLB_HALF_WIDTH_M), south(RLB_HALF_HEIGHT_M)],
  [east(RLB_HALF_WIDTH_M), south(RLB_HALF_HEIGHT_M)],
  [east(RLB_HALF_WIDTH_M), north(RLB_HALF_HEIGHT_M)],
  [west(RLB_HALF_WIDTH_M), north(RLB_HALF_HEIGHT_M)],
]);

/**
 * The pond's outline, walked from the boundary line northwards on one side.
 * `sign` is -1 for the western half, +1 for the eastern half; both halves
 * share the two vertices that sit on the old parcel boundary.
 */
function pondHalfRing(sign) {
  const offset = (m) => CENTRE_E + sign * m;
  return closeRing([
    [CENTRE_E, south(POND_HALF_HEIGHT_M)],
    [CENTRE_E, north(POND_HALF_HEIGHT_M)],
    [offset(POND_SHOULDER_X_M), north(POND_HALF_HEIGHT_M)],
    [offset(POND_HALF_WIDTH_M), north(POND_SHOULDER_Y_M)],
    [offset(POND_HALF_WIDTH_M), south(POND_SHOULDER_Y_M)],
    [offset(POND_SHOULDER_X_M), south(POND_HALF_HEIGHT_M)],
  ]);
}

/**
 * A baseline parcel with the pond's footprint bitten out of the edge it shares
 * with its neighbour. Walking the shared edge detours around the pond, which
 * leaves a simple (un-holed) polygon exactly complementary to the pond half.
 */
function parcelRemainderRing(sign) {
  const offset = (m) => CENTRE_E + sign * m;
  const outerX = offset(RLB_HALF_WIDTH_M);
  return closeRing([
    [CENTRE_E, south(RLB_HALF_HEIGHT_M)],
    [outerX, south(RLB_HALF_HEIGHT_M)],
    [outerX, north(RLB_HALF_HEIGHT_M)],
    [CENTRE_E, north(RLB_HALF_HEIGHT_M)],
    [CENTRE_E, north(POND_HALF_HEIGHT_M)],
    [offset(POND_SHOULDER_X_M), north(POND_HALF_HEIGHT_M)],
    [offset(POND_HALF_WIDTH_M), north(POND_SHOULDER_Y_M)],
    [offset(POND_HALF_WIDTH_M), south(POND_SHOULDER_Y_M)],
    [offset(POND_SHOULDER_X_M), south(POND_HALF_HEIGHT_M)],
    [CENTRE_E, south(POND_HALF_HEIGHT_M)],
  ]);
}

/** A whole baseline parcel: half the redline, no pond taken out of it yet. */
function baselineParcelRing(sign) {
  const outerX = CENTRE_E + sign * RLB_HALF_WIDTH_M;
  return closeRing([
    [CENTRE_E, south(RLB_HALF_HEIGHT_M)],
    [outerX, south(RLB_HALF_HEIGHT_M)],
    [outerX, north(RLB_HALF_HEIGHT_M)],
    [CENTRE_E, north(RLB_HALF_HEIGHT_M)],
  ]);
}

const WEST = -1;
const EAST = 1;

/** Shoelace area of a closed ring, in square metres. */
function ringArea(ring) {
  let twiceArea = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    twiceArea += x1 * y2 - x2 * y1;
  }
  return Math.abs(twiceArea) / 2;
}

// ---------------------------------------------------------------------------
// Attributes
// ---------------------------------------------------------------------------

const SITE_NAME = "Oakwood Regional Development";
const SURVEY_DATE = "2025-06-15";
const SURVEY_DETAILS = "Hand-built scenario fixture";
const MAPPED_BY = "Scenario fixture";
const BASE_MAP = "OS MasterMap";
const LOCATION_ON_SITE = "On-site";
const STRATEGIC_SIGNIFICANCE =
  "Area/compensation not in local strategy/ no local strategy";
const SPATIAL_RISK =
  "Compensation inside LPA boundary or NCA of impact site";
const NO_ADVANCE_YEARS = "0";
const NO_DELAY_YEARS = "0";

// "Lost" is how the NE template records a created habitat on an area parcel:
// the baseline habitat is lost and the proposed columns say what replaces it.
const RETENTION_RETAINED = "Retained";
const RETENTION_CREATED_ON_AREA = "Lost";

const GRASSLAND = {
  broad: "Grassland",
  type: "Modified grassland",
  condition: "Moderate",
  distinctiveness: "Low",
};

const CEREAL_CROPS = {
  broad: "Cropland",
  type: "Cereal crops",
  // The only condition the metric allows for cereal crops.
  condition: "Condition Assessment N/A",
  distinctiveness: "Low",
};

const POND = {
  broad: "Lakes",
  type: "Ponds (non-priority habitat)",
  condition: "Moderate",
  distinctiveness: "Medium",
};

const BASELINE_PARCELS = [
  { ref: "H001", ring: baselineParcelRing(WEST), habitat: GRASSLAND },
  { ref: "H002", ring: baselineParcelRing(EAST), habitat: CEREAL_CROPS },
];

const POST_PARCELS = [
  {
    ref: "H001a",
    ring: parcelRemainderRing(WEST),
    baseline: GRASSLAND,
    proposed: GRASSLAND,
    retention: RETENTION_RETAINED,
  },
  {
    ref: "H001b",
    ring: pondHalfRing(WEST),
    baseline: GRASSLAND,
    proposed: POND,
    retention: RETENTION_CREATED_ON_AREA,
  },
  {
    ref: "H002a",
    ring: parcelRemainderRing(EAST),
    baseline: CEREAL_CROPS,
    proposed: CEREAL_CROPS,
    retention: RETENTION_RETAINED,
  },
  {
    ref: "H002b",
    ring: pondHalfRing(EAST),
    baseline: CEREAL_CROPS,
    proposed: POND,
    retention: RETENTION_CREATED_ON_AREA,
  },
];

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

const HABITATS_SQL = `
  INSERT INTO "Habitats" (
    geom, "Parcel Ref", "Baseline Broad Habitat Type", "Baseline Habitat Type",
    "Area", "Baseline Condition", "Baseline Strategic Significance",
    "Retention Category", "Proposed Broad Habitat Type", "Proposed Habitat Type",
    "Proposed Condition", "Proposed Strategic Significance",
    "Habitat created in advance/years", "Delay in starting habitat creation/years",
    "Spatial risk category", "Location", "Site Name", "Survey Date",
    "Survey Details", "Comment", "Mapped by", "Company", "Base Map",
    "Baseline Distinctiveness", "Proposed Distinctiveness"
  ) VALUES (${new Array(HABITATS_INSERT_COLUMNS).fill("?").join(", ")})
`;

const REDLINE_SQL = `
  INSERT INTO "Red Line Boundary" (geometry, "Area", "Site Name")
  VALUES (?, ?, ?)
`;

/** Bounding box of a ring, in the [minX, maxX, minY, maxY] order registerLayer takes. */
function envelopeOf(rings) {
  const xs = rings.flat().map(([x]) => x);
  const ys = rings.flat().map(([, y]) => y);
  return [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
}

/**
 * The three unused feature tables. `createAllTables` writes all five NE
 * template tables; this fixture only needs habitats, and an empty-but-present
 * layer is itself a validation failure, so the rest are dropped.
 */
const UNUSED_TABLES = ["Hedgerows", "Rivers", "Urban Trees"];

function dropUnusedLayers(db) {
  for (const table of UNUSED_TABLES) {
    db.exec(`DROP TABLE IF EXISTS "${table}"`);
    db.prepare(`DELETE FROM layer_styles WHERE f_table_name = ?`).run(table);
  }
}

function writeRedLineBoundary(db) {
  db.prepare(REDLINE_SQL).run(
    gpkgPolygon(SRS_ID, REDLINE_RING),
    ringArea(REDLINE_RING),
    SITE_NAME,
  );
  registerLayer(
    db,
    "Red Line Boundary",
    "POLYGON",
    envelopeOf([REDLINE_RING]),
  );
}

function writeHabitats(db, rows, bindings) {
  const stmt = db.prepare(HABITATS_SQL);
  for (const row of rows) {
    stmt.run(...bindings(row));
  }
  registerLayer(
    db,
    "Habitats",
    "POLYGON",
    envelopeOf(rows.map((r) => r.ring)),
  );
}

/** Baseline rows: baseline attributes only, every proposed column NULL. */
function baselineBindings(row) {
  return [
    gpkgPolygon(SRS_ID, row.ring),
    row.ref,
    row.habitat.broad,
    row.habitat.type,
    Math.round(ringArea(row.ring)),
    row.habitat.condition,
    STRATEGIC_SIGNIFICANCE,
    null, // Retention Category
    null, // Proposed Broad Habitat Type
    null, // Proposed Habitat Type
    null, // Proposed Condition
    null, // Proposed Strategic Significance
    null, // Habitat created in advance/years
    null, // Delay in starting habitat creation/years
    null, // Spatial risk category
    null, // Location
    SITE_NAME,
    SURVEY_DATE,
    SURVEY_DETAILS,
    null, // Comment
    MAPPED_BY,
    MAPPED_BY,
    BASE_MAP,
    row.habitat.distinctiveness,
    null, // Proposed Distinctiveness
  ];
}

/** Post-intervention rows: the baseline habitat each parcel replaces, plus its end state. */
function postInterventionBindings(row) {
  return [
    gpkgPolygon(SRS_ID, row.ring),
    row.ref,
    row.baseline.broad,
    row.baseline.type,
    Math.round(ringArea(row.ring)),
    row.baseline.condition,
    STRATEGIC_SIGNIFICANCE,
    row.retention,
    row.proposed.broad,
    row.proposed.type,
    row.proposed.condition,
    STRATEGIC_SIGNIFICANCE,
    NO_ADVANCE_YEARS,
    NO_DELAY_YEARS,
    SPATIAL_RISK,
    LOCATION_ON_SITE,
    SITE_NAME,
    SURVEY_DATE,
    SURVEY_DETAILS,
    null, // Comment
    MAPPED_BY,
    MAPPED_BY,
    BASE_MAP,
    row.baseline.distinctiveness,
    row.proposed.distinctiveness,
  ];
}

function writeFile(outPath, rows, bindings) {
  const db = openGeoPackage(outPath);
  try {
    createAllTables(db);
    createLayerStyles(db);
    dropUnusedLayers(db);
    writeRedLineBoundary(db);
    writeHabitats(db, rows, bindings);
  } finally {
    db.close();
  }
}

/**
 * The parcels must tile the redline exactly, or the upload fails
 * AREA_SUM_MISMATCH. Both stages are checked before anything is written, so a
 * coordinate typo surfaces here rather than as a rejected upload.
 */
const AREA_TOLERANCE_SQ_M = 1e-6;

function assertTilesRedline(label, rows) {
  const redlineArea = ringArea(REDLINE_RING);
  const parcelArea = rows.reduce((sum, r) => sum + ringArea(r.ring), 0);
  if (Math.abs(parcelArea - redlineArea) > AREA_TOLERANCE_SQ_M) {
    throw new Error(
      `${label}: parcels total ${parcelArea} m2 but the redline is ${redlineArea} m2`,
    );
  }
}

function main() {
  header("Generating pond-straddling-two-parcels fixture pair");

  assertTilesRedline("baseline", BASELINE_PARCELS);
  assertTilesRedline("post-intervention", POST_PARCELS);

  if (!existsSync(OUT_DIR)) {
    mkdirSync(OUT_DIR, { recursive: true });
  }

  const baselinePath = path.join(OUT_DIR, BASELINE_FILENAME);
  const postPath = path.join(OUT_DIR, POST_FILENAME);

  writeFile(baselinePath, BASELINE_PARCELS, baselineBindings);
  info(`  ${BASELINE_FILENAME}`);
  for (const row of BASELINE_PARCELS) {
    info(
      `    ${row.ref}  ${row.habitat.broad} / ${row.habitat.type}  ${Math.round(ringArea(row.ring))} m2`,
    );
  }

  writeFile(postPath, POST_PARCELS, postInterventionBindings);
  info(`  ${POST_FILENAME}`);
  for (const row of POST_PARCELS) {
    info(
      `    ${row.ref}  ${row.retention} → ${row.proposed.broad} / ${row.proposed.type}  ${Math.round(ringArea(row.ring))} m2`,
    );
  }

  info(`  → ${OUT_DIR}`);
}

main();
