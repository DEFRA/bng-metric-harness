/**
 * Registry of named --bad / --flaw fixtures and the resolution logic that
 * turns a CLI selection into a normalised plan (which geometric flaws to
 * apply, which feature layers to empty, which attribute overrides to pin).
 * The bad-fixture builder consumes the geometric list; the regular synthetic
 * generator consumes the empty set and the attribute overrides.
 */

import { error, warn } from "../../_lib.mjs";
import { bowtieRing, rectRing } from "../geometry.mjs";
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

// Categories drive dispatch in resolveFlawSelection. Each flaw belongs to
// exactly one. "geometric" is the default for flaws that mutate the bad-
// fixture state directly.
export const CATEGORY_GEOMETRIC = "geometric";
export const CATEGORY_EMPTY = "empty";
export const CATEGORY_ATTRIBUTE = "attribute";

const CATEGORY_LABEL = {
  [CATEGORY_GEOMETRIC]: "geometric",
  [CATEGORY_EMPTY]: "empty-layer",
  [CATEGORY_ATTRIBUTE]: "attribute-override",
};

function categoryOf(flaw) {
  return flaw.category ?? CATEGORY_GEOMETRIC;
}

/** Square ring of half-size `half` centred at (cx, cy). */
export function badSquareRing(cx, cy, half = BAD_PARCEL_HALF) {
  return rectRing(cx - half, cy - half, cx + half, cy + half);
}

/**
 * Registry of named flaws. Each entry has:
 *   description  short human-readable label, used in the banner
 *   errorCode    backend validation error this flaw is intended to trigger
 *   category     "geometric" (default) | "empty" | "attribute" — drives
 *                dispatch and selects which payload field is read
 *   standalone   true → cannot be combined with any other flaw
 *   apply(state) (geometric) mutates the bad-fixture state in place
 *   emptyLayer   (empty) key into EMPTYABLE_LAYERS; that layer is registered
 *                as an empty table instead of being populated
 *   attributeOverride
 *                (attribute) { layer, perRow } — generator pins the listed
 *                column values on the first perRow.length rows of `layer`
 */
export const FLAWS = {
  "self-intersecting-redline": {
    description: "redline drawn as a bowtie (self-intersecting)",
    errorCode: "REDLINE_INVALID_GEOMETRY",
    phase: "redline",
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
    ownsLayer: "parcels",
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
    phase: "redline",
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
    phase: "redline",
    apply(s) {
      s.redline = badSquareRing(s.cx, s.cy, TOO_LARGE_HALF);
    },
  },
  "no-habitats": {
    description: "Habitats layer present with zero rows",
    errorCode: "NO_HABITAT_AREAS",
    category: CATEGORY_EMPTY,
    emptyLayer: "habitats",
  },
  "distinctiveness-out-of-scope": {
    description: "habitat types whose reference-data distinctiveness is rejected by the BNG Beta service",
    errorCode: "HABITAT_DISTINCTIVENESS_NOT_IN_SCOPE",
    category: CATEGORY_ATTRIBUTE,
    // The backend derives distinctiveness from the Baseline Habitat Type via
    // a reference table — the Baseline Distinctiveness column is decorative.
    // Each perRow entry pins arbitrary column values on row i; the generator
    // applies whatever fields are present and randomises the rest. Forcing
    // retention to "Retained" keeps the proposed habitat aligned with the
    // baseline so the row stays internally consistent.
    attributeOverride: {
      layer: "habitats",
      perRow: [
        { habitatFullName: "Grassland - Lowland meadows", retention: "Retained" }, // V.High
        { habitatFullName: "Grassland - Traditional orchards", retention: "Retained" }, // High
      ],
    },
  },
  "no-hedgerows": {
    description: "Hedgerows layer present with zero rows",
    errorCode: NO_SPECIFIC_ERROR,
    category: CATEGORY_EMPTY,
    emptyLayer: "hedgerows",
  },
  "no-rivers": {
    description: "Rivers layer present with zero rows",
    errorCode: NO_SPECIFIC_ERROR,
    category: CATEGORY_EMPTY,
    emptyLayer: "rivers",
  },
  "no-trees": {
    description: "Urban Trees layer present with zero rows",
    errorCode: NO_SPECIFIC_ERROR,
    category: CATEGORY_EMPTY,
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

/** Flaws that `--bad` expands to. Only geometric, non-standalone flaws — and
 *  `sliver` is excluded because it conflicts with the parcel-modifying flaws. */
export const BAD_DEFAULT_FLAWS = ALL_FLAW_NAMES.filter((n) => {
  const f = FLAWS[n];
  if (categoryOf(f) !== CATEGORY_GEOMETRIC) {
    return false;
  }
  if (f.standalone) {
    return false;
  }
  if (n === "sliver") {
    return false;
  }
  return true;
});

// Category pairs that cannot coexist in a single selection. Attribute and
// empty are not listed here because they only conflict when they target the
// same layer — that case is handled separately by
// assertAttributeLayerNotEmptied.
const EXCLUSIVE_PAIRS = [
  [CATEGORY_EMPTY, CATEGORY_GEOMETRIC],
  [CATEGORY_ATTRIBUTE, CATEGORY_GEOMETRIC],
];

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

function partitionByCategory(names) {
  const buckets = {
    [CATEGORY_GEOMETRIC]: [],
    [CATEGORY_EMPTY]: [],
    [CATEGORY_ATTRIBUTE]: [],
  };
  for (const name of names) {
    buckets[categoryOf(FLAWS[name])].push(name);
  }
  return buckets;
}

function assertCategoryConflicts(buckets, bad) {
  for (const [a, b] of EXCLUSIVE_PAIRS) {
    if (!buckets[a].length || !buckets[b].length) {
      continue;
    }
    const nonGeometric = a === CATEGORY_GEOMETRIC ? b : a;
    if (bad && (a === CATEGORY_GEOMETRIC || b === CATEGORY_GEOMETRIC)) {
      error(`--bad cannot be combined with ${CATEGORY_LABEL[nonGeometric]} flaws.`);
    } else {
      error(
        `${CATEGORY_LABEL[a]} flaws (${buckets[a].join(", ")}) cannot be combined ` +
          `with ${CATEGORY_LABEL[b]} flaws (${buckets[b].join(", ")}).`,
      );
    }
    process.exit(1);
  }
}

function warnIfAllLayersEmpty(emptyNames) {
  if (emptyNames.length === Object.keys(EMPTYABLE_LAYERS).length) {
    warn(
      "every feature layer is being emptied; the output will contain only the Red Line Boundary",
    );
  }
}

// Attribute-override flaws need their target layer to actually contain rows;
// otherwise the override has nothing to attach to.
function assertAttributeLayerNotEmptied(attributeNames, emptyNames) {
  for (const name of attributeNames) {
    const targetLayer = FLAWS[name].attributeOverride.layer;
    const conflictingEmpty = emptyNames.find((n) => FLAWS[n].emptyLayer === targetLayer);
    if (conflictingEmpty) {
      error(
        `Flaw "${name}" overrides rows in the "${targetLayer}" layer ` +
          `but "${conflictingEmpty}" empties that layer.`,
      );
      process.exit(1);
    }
  }
}

function assertAttributeTargetsUnique(attributeNames) {
  const seen = new Map();
  for (const name of attributeNames) {
    const { layer } = FLAWS[name].attributeOverride;
    if (seen.has(layer)) {
      error(`Multiple attribute-override flaws target the "${layer}" layer; combine them manually.`);
      process.exit(1);
    }
    seen.set(layer, name);
  }
}

function buildAttributeOverrides(attributeNames) {
  const overrides = {};
  for (const name of attributeNames) {
    const { layer, perRow } = FLAWS[name].attributeOverride;
    overrides[layer] = perRow;
  }
  return overrides;
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
  const buckets = partitionByCategory(names);
  const geometricFlawNames = buckets[CATEGORY_GEOMETRIC];
  const emptyFlawNames = buckets[CATEGORY_EMPTY];
  const attributeFlawNames = buckets[CATEGORY_ATTRIBUTE];

  assertCategoryConflicts(buckets, bad);
  assertAttributeLayerNotEmptied(attributeFlawNames, emptyFlawNames);
  assertAttributeTargetsUnique(attributeFlawNames);
  assertNoStandaloneCombination(geometricFlawNames);
  assertNoPairwiseConflicts(geometricFlawNames);
  warnIfAllLayersEmpty(emptyFlawNames);

  return {
    geometricFlawNames,
    emptyFlawNames,
    attributeFlawNames,
    emptyLayers: new Set(emptyFlawNames.map((n) => FLAWS[n].emptyLayer)),
    attributeOverrides: buildAttributeOverrides(attributeFlawNames),
  };
}
