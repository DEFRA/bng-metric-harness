/**
 * Registry of named --bad / --flaw fixtures and the resolution logic that
 * turns a CLI selection into a normalised plan (which geometric flaws to
 * apply, which feature layers to empty). The bad-fixture builder consumes
 * the geometric list; the regular synthetic generator consumes the empty
 * set.
 */

import { error, warn } from "../_lib.mjs";
import { bowtieRing, rectRing } from "./geometry.mjs";
import {
  AREA_MISMATCH_PARCEL_DXY,
  BAD_PARCEL_HALF,
  BAD_REDLINE_HALF,
  BOWTIE_PARCEL_DY,
  BOWTIE_PARCEL_HALF,
  HEDGEROW_INSIDE_OFFSET,
  HEDGEROW_OUTSIDE_OFFSET,
  IGGI_HALF,
  IGGI_OUTSIDE_OFFSET,
  OUTSIDE_PARCEL_DXY,
  OVERLAP_A_DX,
  OVERLAP_A_DY,
  OVERLAP_B_DX,
  OVERLAP_B_DY,
  SLIVER_GAP,
  SNOWDONIA_E,
  SNOWDONIA_N,
  TOO_LARGE_HALF,
  TREE_OUTSIDE_OFFSET,
  WATERCOURSE_INSIDE_OFFSET,
  WATERCOURSE_OUTSIDE_OFFSET,
} from "./synthetic-constants.mjs";

export const NO_SPECIFIC_ERROR = "(no specific backend error)";

/** Square ring of half-size `half` centred at (cx, cy). */
export function badSquareRing(cx, cy, half = BAD_PARCEL_HALF) {
  return rectRing(cx - half, cy - half, cx + half, cy + half);
}

/**
 * Registry of named flaws. Each entry has:
 *   description  short human-readable label, used in the banner
 *   errorCode    backend validation error this flaw is intended to trigger
 *   standalone   true → cannot be combined with any other flaw
 *   apply(state) mutates the bad-fixture state in place (geometric flaws only)
 *   emptyLayer   key into EMPTYABLE_LAYERS; if present, the flaw routes through
 *                the regular generator with that layer skipped and registered
 *                as an empty table — not through the bad-fixture builder
 */
export const FLAWS = {
  "self-intersecting-redline": {
    description: "redline drawn as a bowtie (self-intersecting)",
    errorCode: "REDLINE_INVALID_GEOMETRY",
    apply(s) {
      s.redline = bowtieRing(s.cx, s.cy, BAD_REDLINE_HALF);
    },
  },
  "bowtie-parcel": {
    description: "one habitat parcel drawn as a bowtie",
    errorCode: "AREA_PARCELS_INVALID_GEOMETRY",
    apply(s) {
      s.parcels.push(bowtieRing(s.cx, s.cy + BOWTIE_PARCEL_DY, BOWTIE_PARCEL_HALF));
    },
  },
  "overlapping-parcels": {
    description: "two habitat parcels overlap each other",
    errorCode: "PARCEL_OVERLAPS",
    apply(s) {
      s.parcels.push(
        badSquareRing(s.cx + OVERLAP_A_DX, s.cy + OVERLAP_A_DY),
        badSquareRing(s.cx + OVERLAP_B_DX, s.cy + OVERLAP_B_DY),
      );
    },
  },
  "parcel-outside-redline": {
    description: "a habitat parcel placed entirely outside the redline",
    errorCode: "AREA_PARCELS_OUTSIDE_REDLINE",
    apply(s) {
      s.parcels.push(badSquareRing(s.cx + OUTSIDE_PARCEL_DXY, s.cy + OUTSIDE_PARCEL_DXY));
    },
  },
  sliver: {
    description: "two parcels almost tile the redline, leaving a hairline gap",
    errorCode: "SLIVERS_INSIDE_REDLINE",
    conflictsWith: [
      "bowtie-parcel",
      "overlapping-parcels",
      "parcel-outside-redline",
      "area-sum-mismatch",
    ],
    apply(s) {
      const r = BAD_REDLINE_HALF;
      s.parcels.push(
        rectRing(s.cx - r, s.cy - r, s.cx + r, s.cy),
        rectRing(s.cx - r, s.cy + SLIVER_GAP, s.cx + r, s.cy + r),
      );
    },
  },
  "hedgerow-outside": {
    description: "a hedgerow runs from inside to outside the redline",
    errorCode: "HEDGEROWS_OUTSIDE_REDLINE",
    apply(s) {
      s.hedgerows.push([
        [s.cx - HEDGEROW_INSIDE_OFFSET, s.cy + HEDGEROW_INSIDE_OFFSET],
        [s.cx + HEDGEROW_OUTSIDE_OFFSET, s.cy + HEDGEROW_OUTSIDE_OFFSET],
      ]);
    },
  },
  "watercourse-outside": {
    description: "a watercourse runs from inside to outside the redline",
    errorCode: "WATERCOURSES_OUTSIDE_REDLINE",
    apply(s) {
      s.rivers.push([
        [s.cx + WATERCOURSE_INSIDE_OFFSET, s.cy - WATERCOURSE_INSIDE_OFFSET],
        [s.cx + WATERCOURSE_OUTSIDE_OFFSET, s.cy - WATERCOURSE_OUTSIDE_OFFSET],
      ]);
    },
  },
  "tree-outside": {
    description: "a tree is placed outside the redline",
    errorCode: "TREES_OUTSIDE_REDLINE",
    apply(s) {
      s.trees.push([s.cx + TREE_OUTSIDE_OFFSET, s.cy + TREE_OUTSIDE_OFFSET]);
    },
  },
  "iggi-outside": {
    description: "an IGGI polygon is placed outside the redline",
    errorCode: "IGGIS_OUTSIDE_REDLINE",
    apply(s) {
      s.iggis.push(badSquareRing(s.cx - IGGI_OUTSIDE_OFFSET, s.cy - IGGI_OUTSIDE_OFFSET, IGGI_HALF));
    },
  },
  "area-sum-mismatch": {
    description: "habitat parcels do not tile the redline",
    errorCode: "AREA_SUM_MISMATCH",
    apply(s) {
      s.parcels.push(badSquareRing(s.cx + AREA_MISMATCH_PARCEL_DXY, s.cy + AREA_MISMATCH_PARCEL_DXY));
    },
  },
  "redline-not-in-england": {
    description: "redline placed outside England (Snowdonia, Wales)",
    errorCode: "REDLINE_OUTSIDE_ENGLAND",
    standalone: true,
    apply(s) {
      s.cx = SNOWDONIA_E;
      s.cy = SNOWDONIA_N;
      s.centre = [s.cx, s.cy];
      s.redline = badSquareRing(s.cx, s.cy, BAD_REDLINE_HALF);
    },
  },
  "redline-too-large": {
    description: "redline area exceeds the 100 sq km limit",
    errorCode: "REDLINE_AREA_TOO_LARGE",
    standalone: true,
    apply(s) {
      s.redline = badSquareRing(s.cx, s.cy, TOO_LARGE_HALF);
    },
  },
  "no-habitats": {
    description: "Habitats layer present with zero rows",
    errorCode: "NO_HABITAT_AREAS",
    emptyLayer: "habitats",
  },
  "no-hedgerows": {
    description: "Hedgerows layer present with zero rows",
    errorCode: NO_SPECIFIC_ERROR,
    emptyLayer: "hedgerows",
  },
  "no-rivers": {
    description: "Rivers layer present with zero rows",
    errorCode: NO_SPECIFIC_ERROR,
    emptyLayer: "rivers",
  },
  "no-trees": {
    description: "Urban Trees layer present with zero rows",
    errorCode: NO_SPECIFIC_ERROR,
    emptyLayer: "trees",
  },
};

/** Lookup for layers that can be emitted with zero rows via an `emptyLayer`
 *  flaw. Each maps to the (gpkg_contents) table name and geometry type that
 *  the generator must register so the layer still exists in the file. */
export const EMPTYABLE_LAYERS = {
  habitats: { table: "Habitats", geom: "POLYGON" },
  hedgerows: { table: "Hedgerows", geom: "LINESTRING" },
  rivers: { table: "Rivers", geom: "LINESTRING" },
  trees: { table: "Urban Trees", geom: "POINT" },
};

export const ALL_FLAW_NAMES = Object.keys(FLAWS);

/** Flaws that `--bad` expands to. Excludes standalone-only flaws, empty-layer
 *  flaws (different generation path), and `sliver` (which conflicts with the
 *  parcel-modifying flaws). */
export const BAD_DEFAULT_FLAWS = ALL_FLAW_NAMES.filter((n) => {
  const f = FLAWS[n];
  if (f.standalone) {
    return false;
  }
  if (f.emptyLayer) {
    return false;
  }
  if (n === "sliver") {
    return false;
  }
  return true;
});

function collectRequestedFlaws(bad, flaws) {
  const requested = new Set(bad ? BAD_DEFAULT_FLAWS : []);
  for (const name of flaws) {
    if (!FLAWS[name]) {
      error(`Unknown flaw: ${name}. Valid: ${ALL_FLAW_NAMES.join(", ")}`);
      process.exit(1);
    }
    requested.add(name);
  }
  return [...requested];
}

function assertEmptyAndGeometricNotMixed(emptyLayerNames, geometricNames, bad) {
  if (emptyLayerNames.length && geometricNames.length) {
    error(
      `Empty-layer flaws (${emptyLayerNames.join(", ")}) cannot be combined ` +
        `with geometric flaws (${geometricNames.join(", ")}).`,
    );
    process.exit(1);
  }
  if (emptyLayerNames.length && bad) {
    error("--bad cannot be combined with empty-layer flaws.");
    process.exit(1);
  }
  if (emptyLayerNames.length === Object.keys(EMPTYABLE_LAYERS).length) {
    warn(
      "every feature layer is being emptied; the output will contain only the Red Line Boundary",
    );
  }
}

function assertNoStandaloneCombination(geometricNames) {
  const standalone = geometricNames.filter((n) => FLAWS[n].standalone);
  if (standalone.length && geometricNames.length > 1) {
    error(
      `Flaw "${standalone[0]}" is standalone and cannot be combined with other flaws. Got: ${geometricNames.join(", ")}`,
    );
    process.exit(1);
  }
}

function assertNoPairwiseConflicts(geometricNames) {
  for (const name of geometricNames) {
    const conflicts = FLAWS[name].conflictsWith ?? [];
    const clash = conflicts.find((other) => geometricNames.includes(other));
    if (clash) {
      error(`Flaws "${name}" and "${clash}" conflict and cannot be combined.`);
      process.exit(1);
    }
  }
}

export function resolveFlawSelection({ bad, flaws }) {
  const names = collectRequestedFlaws(bad, flaws);
  const emptyLayerNames = names.filter((n) => FLAWS[n].emptyLayer);
  const geometricNames = names.filter((n) => !FLAWS[n].emptyLayer);

  assertEmptyAndGeometricNotMixed(emptyLayerNames, geometricNames, bad);
  assertNoStandaloneCombination(geometricNames);
  assertNoPairwiseConflicts(geometricNames);

  return {
    geometric: geometricNames,
    emptyLayers: new Set(emptyLayerNames.map((n) => FLAWS[n].emptyLayer)),
    emptyFlawNames: emptyLayerNames,
  };
}
