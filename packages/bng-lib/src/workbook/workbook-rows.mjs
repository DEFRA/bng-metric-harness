/**
 * Workbook → row builders. Two flavours:
 *   - buildBaselineRows(wb)         — what an ecologist would upload at the
 *                                     baseline stage. Only A-1 / B-1 / C-1
 *                                     rows, no proposed data, no retention.
 *   - buildPostInterventionRows(wb) — the proposed end-state, derived row by
 *                                     row from A-1 / B-1 / C-1 per-fate
 *                                     columns (areaRetained / areaEnhanced /
 *                                     areaLost and the length equivalents)
 *                                     plus A-2 / B-2 / C-2 created entries
 *                                     and A-3 / B-3 / C-3 enhancement
 *                                     attributes.
 *
 * Pure data transformations. No SQL, no geometry — just shaping workbook
 * rows into the structure the writer modules consume.
 */

import { conditionScores as metricConditionScores } from "../data/metric-values-habitat-condition.mjs";
import { distinctivenessCategories as metricDistinctiveness } from "../data/metric-values-habitat-distinctiveness.mjs";

// ---------------------------------------------------------------------------
// Ref formatting
// ---------------------------------------------------------------------------

// Width of the zero-padded numeric suffix used in feature reference codes
// (e.g. H001, HG003, T012). Kept consistent across all layers and generators.
export const FEATURE_REF_PAD = 3;
export const FEATURE_REF_PAD_CHAR = "0";

// Pad helper for letter-suffix derived refs (e.g. H001 → H001a / H001b).
export function makeRef(prefix, baselineRef, suffix) {
  const num = String(baselineRef).padStart(FEATURE_REF_PAD, FEATURE_REF_PAD_CHAR);
  return `${prefix}${num}${suffix ?? ""}`;
}

// ---------------------------------------------------------------------------
// Fate-area reconciliation
// ---------------------------------------------------------------------------

// 0.5% relative, with a 1 m² absolute floor (0.0001 ha). See plan decision 4.
export const FATE_AREA_RELATIVE_TOLERANCE = 0.005;
export const FATE_AREA_ABSOLUTE_FLOOR_HA = 0.0001;

export function fateReconciles(total, retained, enhanced, lost) {
  const sum = (retained ?? 0) + (enhanced ?? 0) + (lost ?? 0);
  const tol = Math.max(total * FATE_AREA_RELATIVE_TOLERANCE, FATE_AREA_ABSOLUTE_FLOOR_HA);
  return Math.abs(total - sum) <= tol;
}

// ---------------------------------------------------------------------------
// Habitat metric-table validation
// ---------------------------------------------------------------------------

export function isHabitatConditionValid(broad, type, condition) {
  const key = `${broad} - ${type}`;
  if (!metricDistinctiveness[key]) {
    return false;
  }
  const conds = metricConditionScores[key];
  if (!conds) {
    return false;
  }
  const v = conds[condition];
  return typeof v === "number";
}

// ---------------------------------------------------------------------------
// Shared shape builders. The baseline + proposed sub-objects are constructed
// many times across the row builders; centralising the shapes keeps the
// builders short and the column-set obvious.
// ---------------------------------------------------------------------------

function habitatBaselineShape(b) {
  return {
    broad: b.broad,
    type: b.type,
    distinctiveness: b.distinctiveness,
    condition: b.condition,
    strategicSig: b.strategicSignificance,
  };
}

function habitatProposedFromBaseline(b) {
  return { ...habitatBaselineShape(b), advanceYears: 0, delayYears: 0 };
}

function habitatProposedFromCreated(c) {
  return {
    broad: c.broad,
    type: c.type,
    distinctiveness: c.distinctiveness,
    condition: c.condition,
    strategicSig: c.strategicSignificance,
    advanceYears: c.advanceYears ?? 0,
    delayYears: c.delayYears ?? 0,
  };
}

function habitatProposedFromEnhancement(b, enh) {
  return {
    broad: enh?.proposedBroad ?? b.broad,
    type: enh?.proposedType ?? b.type,
    distinctiveness: enh?.proposedDistinctiveness ?? b.distinctiveness,
    condition: enh?.proposedCondition ?? b.condition,
    strategicSig: enh?.proposedStrategicSignificance ?? b.strategicSignificance,
    advanceYears: enh?.advanceYears ?? 0,
    delayYears: enh?.delayYears ?? 0,
  };
}

function linearAttributeShape(b) {
  return {
    type: b.type,
    distinctiveness: b.distinctiveness,
    condition: b.condition,
    strategicSig: b.strategicSignificance,
  };
}

function linearProposedFromEnh(b, enh) {
  return {
    type: enh?.proposedType ?? b.type,
    distinctiveness: enh?.proposedDistinctiveness ?? b.distinctiveness,
    condition: enh?.proposedCondition ?? b.condition,
    strategicSig: enh?.proposedStrategicSignificance ?? b.strategicSignificance,
    advanceYears: enh?.advanceYears ?? 0,
    delayYears: enh?.delayYears ?? 0,
  };
}

function linearProposedFromCreated(c) {
  return {
    type: c.type,
    distinctiveness: c.distinctiveness,
    condition: c.condition,
    strategicSig: c.strategicSignificance,
    advanceYears: c.advanceYears ?? 0,
    delayYears: c.delayYears ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Baseline row builder
// ---------------------------------------------------------------------------

function mapBaselineHabitat(b) {
  return {
    ref: makeRef("H", b.ref),
    baselineRef: String(b.ref),
    area: b.area,
    ...habitatBaselineShape(b),
  };
}

function mapBaselineLinear(prefix, row) {
  return {
    ref: makeRef(prefix, row.ref),
    baselineRef: String(row.ref),
    type: row.type,
    lengthM: row.lengthM,
    distinctiveness: row.distinctiveness,
    condition: row.condition,
    strategicSig: row.strategicSignificance,
  };
}

function mapBaselineTree(t) {
  return {
    ref: makeRef("T", t.ref),
    baselineRef: String(t.ref),
    type: t.type,
    distinctiveness: t.distinctiveness,
    condition: t.condition,
    strategicSig: t.strategicSignificance,
  };
}

/**
 * Build baseline rows from a workbook. Each layer's output is the raw A-1 /
 * B-1 / C-1 / individual-trees-baseline content with no post-intervention
 * data attached.
 */
export function buildBaselineRows(wb, { strict = false } = {}) {
  const skipReasons = [];
  const habitats = [];
  for (const b of wb.habitats.baseline) {
    if (strict && !isHabitatConditionValid(b.broad, b.type, b.condition)) {
      skipReasons.push(`baseline habitat ref ${b.ref}: invalid (habitat, condition) under --strict-habitats`);
      continue;
    }
    habitats.push(mapBaselineHabitat(b));
  }
  return {
    habitats,
    hedgerows: wb.hedgerows.baseline.map((h) => mapBaselineLinear("HG", h)),
    rivers: wb.watercourses.baseline.map((r) => mapBaselineLinear("R", r)),
    trees: wb.trees.baseline.map(mapBaselineTree),
    skipReasons,
  };
}

// ---------------------------------------------------------------------------
// Post-intervention row builder. Composed from small per-pass helpers; the
// public entry point just wires them together for each layer.
// ---------------------------------------------------------------------------

const SUFFIX_LETTERS = "abcdefghijklmnopqrstuvwxyz";

/**
 * Filter A-1 baseline rows under --strict-habitats and accumulate skip /
 * accounting warnings.
 */
function filterEligibleBaselines(baseline, strict, skipReasons, warnings) {
  const out = [];
  for (const b of baseline) {
    if (strict && !isHabitatConditionValid(b.broad, b.type, b.condition)) {
      skipReasons.push(`baseline habitat ref ${b.ref}: invalid (habitat, condition) under --strict-habitats`);
      continue;
    }
    if (!fateReconciles(b.area, b.areaRetained, b.areaEnhanced, b.areaLost)) {
      warnings.push(
        `habitat ref ${b.ref}: area accounting off (total=${b.area} retained=${b.areaRetained} enhanced=${b.areaEnhanced} lost=${b.areaLost})`,
      );
    }
    out.push(b);
  }
  return out;
}

/** Filter A-2 created rows under --strict-habitats. */
function filterEligibleCreated(created, strict, skipReasons) {
  const idxs = [];
  for (let i = 0; i < created.length; i++) {
    const c = created[i];
    if (strict && !isHabitatConditionValid(c.broad, c.type, c.condition)) {
      skipReasons.push(`created habitat ref ${c.ref}: invalid (habitat, condition) under --strict-habitats`);
      continue;
    }
    idxs.push(i);
  }
  return idxs;
}

/**
 * Greedy lost→created matching: for each created row (largest first), pick
 * the baseline parcel whose remaining lost-area capacity is the largest
 * sufficient match. Returns Map<createdIdx, baselineRef>.
 */
function assignCreatedToBaselines(eligibleBaselines, created, eligibleCreatedIdxs) {
  const lostRemaining = new Map();
  for (const b of eligibleBaselines) {
    if (b.areaLost > 0) {
      lostRemaining.set(String(b.ref), b.areaLost);
    }
  }
  const assignment = new Map();
  const sortedByAreaDesc = eligibleCreatedIdxs
    .slice()
    .sort((a, b) => (created[b].area ?? 0) - (created[a].area ?? 0));
  for (const idx of sortedByAreaDesc) {
    const needed = created[idx].area ?? 0;
    if (needed <= 0) {
      continue;
    }
    const best = findBestBaselineForCreated(lostRemaining, needed);
    if (best != null) {
      assignment.set(idx, best.ref);
      lostRemaining.set(best.ref, best.remaining - needed);
    }
  }
  return assignment;
}

function findBestBaselineForCreated(lostRemaining, needed) {
  let bestRef = null;
  let bestRemaining = -Infinity;
  for (const [ref, remaining] of lostRemaining) {
    if (remaining + FATE_AREA_ABSOLUTE_FLOOR_HA >= needed && remaining > bestRemaining) {
      bestRef = ref;
      bestRemaining = remaining;
    }
  }
  return bestRef == null ? null : { ref: bestRef, remaining: bestRemaining };
}

/** Build the proposed-side payload for an A-3 enhancement, applying strict. */
function planEnhancementProposed(b, baselineRef, habEnh, strict, skipReasons) {
  if (b.areaEnhanced <= 0) {
    return null;
  }
  const proposed = habitatProposedFromEnhancement(b, habEnh.get(baselineRef));
  if (strict && !isHabitatConditionValid(proposed.broad, proposed.type, proposed.condition)) {
    skipReasons.push(`enhanced habitat ref ${baselineRef}: invalid proposed (habitat, condition) under --strict-habitats`);
    return null;
  }
  return proposed;
}

/** Emit a retained-slice row. */
function emitRetainedRow(b, baselineRef, suffix) {
  return {
    ref: makeRef("H", baselineRef, suffix),
    baselineRef,
    retention: "Retained",
    area: b.areaRetained,
    baseline: habitatBaselineShape(b),
    proposed: habitatProposedFromBaseline(b),
  };
}

/** Emit an enhanced-slice row. */
function emitEnhancedRow(b, baselineRef, suffix, proposed) {
  return {
    ref: makeRef("H", baselineRef, suffix),
    baselineRef,
    retention: "Enhanced",
    area: b.areaEnhanced,
    baseline: habitatBaselineShape(b),
    proposed,
  };
}

/**
 * Emit a created-slice row (lineage-linked to a baseline parcel). Internal
 * retention stays "Created" so the writer's geometry partitioner can match
 * it against the parent's lost-area budget; the gpkg-written retention
 * column is translated to "Lost" at write time (NE-template convention).
 */
function emitLinkedCreatedRow(b, c, baselineRef, suffix) {
  return {
    ref: makeRef("H", baselineRef, suffix),
    baselineRef,
    retention: "Created",
    area: c.area,
    baseline: habitatBaselineShape(b),
    proposed: habitatProposedFromCreated(c),
  };
}

/** Emit a created-only row with a fresh sequential ref. Self-similar baseline
 *  shape keeps the row self-contained for downstream calculators. */
function emitUnassignedCreatedRow(c, freshRefIndex) {
  return {
    ref: makeRef("H", freshRefIndex),
    baselineRef: null,
    retention: "Created",
    area: c.area,
    baseline: habitatBaselineShape(c),
    proposed: habitatProposedFromCreated(c),
  };
}

/**
 * Per-baseline emission: retained, enhanced, then any assigned-created in
 * original A-2 order. Suffix letters allocated only when a baseline expands
 * to more than one surviving row.
 */
function emitRowsForBaseline(b, baselineRef, assignedCreatedIdxs, created, habEnh, strict, skipReasons) {
  const proposed = planEnhancementProposed(b, baselineRef, habEnh, strict, skipReasons);
  const sliceCount =
    (b.areaRetained > 0 ? 1 : 0) +
    (proposed ? 1 : 0) +
    assignedCreatedIdxs.length;
  const useSuffix = sliceCount > 1;
  let suffixIdx = 0;
  const nextSuffix = () => {
    if (!useSuffix) {
      return "";
    }
    const s = SUFFIX_LETTERS[suffixIdx];
    suffixIdx += 1;
    return s;
  };

  const rows = [];
  if (b.areaRetained > 0) {
    rows.push(emitRetainedRow(b, baselineRef, nextSuffix()));
  }
  if (proposed) {
    rows.push(emitEnhancedRow(b, baselineRef, nextSuffix(), proposed));
  }
  for (const idx of assignedCreatedIdxs) {
    rows.push(emitLinkedCreatedRow(b, created[idx], baselineRef, nextSuffix()));
  }
  return rows;
}

function buildHabitatPostRows(wb, strict, skipReasons, warnings) {
  const habEnh = new Map();
  for (const e of wb.habitats.enhancements) {
    habEnh.set(String(e.baselineRef), e);
  }
  const eligibleBaselines = filterEligibleBaselines(wb.habitats.baseline, strict, skipReasons, warnings);
  const eligibleCreatedIdxs = filterEligibleCreated(wb.habitats.created, strict, skipReasons);
  const createdAssignment = assignCreatedToBaselines(eligibleBaselines, wb.habitats.created, eligibleCreatedIdxs);

  const habitats = [];
  for (const b of eligibleBaselines) {
    const baselineRef = String(b.ref);
    const assignedCreatedIdxs = [...createdAssignment.entries()]
      .filter(([, ref]) => ref === baselineRef)
      .map(([idx]) => idx)
      .sort((a, b2) => a - b2);
    habitats.push(
      ...emitRowsForBaseline(b, baselineRef, assignedCreatedIdxs, wb.habitats.created, habEnh, strict, skipReasons),
    );
  }

  let createdSeq = wb.habitats.baseline.length + 1;
  for (const idx of eligibleCreatedIdxs) {
    if (createdAssignment.has(idx)) {
      continue;
    }
    habitats.push(emitUnassignedCreatedRow(wb.habitats.created[idx], createdSeq));
    createdSeq += 1;
  }
  return habitats;
}

/**
 * Build post-intervention rows from a workbook. Each baseline row may expand
 * into multiple rows: a retained slice, an enhanced slice, plus any A-2
 * created parcels matched against that baseline's lost-area budget.
 *
 * Suffix scheme:
 *   - A baseline parcel with a single surviving slice keeps its ref unchanged
 *     (`H001`).
 *   - Multiple slices get suffix letters in order: retained → `H001a`,
 *     enhanced → `H001b`, then any assigned-created → `H001c`, `H001d`, …
 *   - Unassigned created parcels (workbook A-2 rows that didn't fit any
 *     baseline's lost-area budget) get fresh refs continuing the numeric
 *     sequence after the highest baseline ref.
 *
 * Lost→created matching is greedy: sort created rows largest-first, then
 * for each pick the baseline parcel whose remaining lost capacity is the
 * largest sufficient match. Capacity is tracked in hectares and decremented
 * per assignment.
 */
export function buildPostInterventionRows(wb, { strict = false } = {}) {
  const skipReasons = [];
  const warnings = [];

  const hedgeEnh = new Map();
  for (const e of wb.hedgerows.enhancements) {
    hedgeEnh.set(String(e.baselineRef), e);
  }
  const riverEnh = new Map();
  for (const e of wb.watercourses.enhancements) {
    riverEnh.set(String(e.baselineRef), e);
  }

  const habitats = buildHabitatPostRows(wb, strict, skipReasons, warnings);
  const hedgerows = buildLinearPostIntervention({
    baseline: wb.hedgerows.baseline,
    created: wb.hedgerows.created,
    enhMap: hedgeEnh,
    refPrefix: "HG",
    warnings,
  });
  const rivers = buildLinearPostIntervention({
    baseline: wb.watercourses.baseline,
    created: wb.watercourses.created,
    enhMap: riverEnh,
    refPrefix: "R",
    warnings,
  });
  const trees = buildTreePostRows(wb);

  return { habitats, hedgerows, rivers, trees, skipReasons, warnings };
}

// ---------------------------------------------------------------------------
// Linear features (hedgerows, rivers)
// ---------------------------------------------------------------------------

function makeLinearRow(b, lengthM, retention, refPrefix, suffix = "", enh = null) {
  return {
    ref: makeRef(refPrefix, b.ref, suffix),
    baselineRef: String(b.ref),
    retention,
    lengthM,
    baseline: linearAttributeShape(b),
    proposed: linearProposedFromEnh(b, enh),
  };
}

function makeCreatedLinearRow(c, refPrefix, freshRefIndex) {
  return {
    ref: makeRef(refPrefix, freshRefIndex),
    baselineRef: null,
    retention: "Created",
    lengthM: c.lengthM,
    baseline: linearAttributeShape(c),
    proposed: linearProposedFromCreated(c),
  };
}

function warnIfLinearAccountingOff(b, retainedM, enhancedM, lostM, refPrefix, warnings) {
  const totalReconciled = retainedM + enhancedM + lostM;
  if (totalReconciled <= 0) {
    return;
  }
  const tol = Math.max(b.lengthM * FATE_AREA_RELATIVE_TOLERANCE, 1);
  if (Math.abs(totalReconciled - b.lengthM) > tol) {
    warnings.push(
      `${refPrefix} ref ${b.ref}: length accounting off (total=${b.lengthM}m retained=${retainedM} enhanced=${enhancedM} lost=${lostM})`,
    );
  }
}

function linearSuffix(retainedM, enhancedM, fate) {
  const split = retainedM > 0 && enhancedM > 0;
  if (!split) {
    return "";
  }
  return fate === "Retained" ? "a" : "b";
}

function expandBaselineLinearRow(b, enhMap, refPrefix, warnings) {
  const retainedM = b.lengthRetainedM ?? 0;
  const enhancedM = b.lengthEnhancedM ?? 0;
  const lostM = b.lengthLostM ?? 0;
  // No fate columns populated — treat the whole length as retained so
  // the linear feature still appears post-intervention.
  if (retainedM === 0 && enhancedM === 0 && lostM === 0 && b.lengthM > 0) {
    return [makeLinearRow(b, b.lengthM, "Retained", refPrefix)];
  }
  warnIfLinearAccountingOff(b, retainedM, enhancedM, lostM, refPrefix, warnings);
  const rows = [];
  if (retainedM > 0) {
    rows.push(makeLinearRow(b, retainedM, "Retained", refPrefix, linearSuffix(retainedM, enhancedM, "Retained")));
  }
  if (enhancedM > 0) {
    rows.push(
      makeLinearRow(b, enhancedM, "Enhanced", refPrefix, linearSuffix(retainedM, enhancedM, "Enhanced"), enhMap.get(String(b.ref))),
    );
  }
  return rows;
}

function buildLinearPostIntervention({ baseline, created, enhMap, refPrefix, warnings }) {
  const rows = [];
  for (const b of baseline) {
    rows.push(...expandBaselineLinearRow(b, enhMap, refPrefix, warnings));
  }
  let seq = baseline.length + 1;
  for (const c of created) {
    rows.push(makeCreatedLinearRow(c, refPrefix, seq));
    seq += 1;
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Trees (point features)
// ---------------------------------------------------------------------------

function treeRetentionForRow(t) {
  const retained = t.areaRetained ?? 0;
  const enhanced = t.areaEnhanced ?? 0;
  const lost = t.areaLost ?? 0;
  // Fully-lost row: emit nothing post-intervention.
  if (retained === 0 && enhanced === 0 && lost > 0) {
    return null;
  }
  return enhanced > retained ? "Enhanced" : "Retained";
}

function makeRetainedTreeRow(t, retention) {
  const attrs = linearAttributeShape(t);
  return {
    ref: makeRef("T", t.ref),
    baselineRef: String(t.ref),
    retention,
    baseline: attrs,
    proposed: { ...attrs, advanceYears: 0, delayYears: 0 },
  };
}

function makeCreatedTreeRow(c, freshRefIndex) {
  return {
    ref: makeRef("T", freshRefIndex),
    baselineRef: null,
    retention: "Created",
    baseline: linearAttributeShape(c),
    proposed: linearProposedFromCreated(c),
  };
}

function buildTreePostRows(wb) {
  const trees = [];
  for (const t of wb.trees.baseline) {
    const retention = treeRetentionForRow(t);
    if (retention) {
      trees.push(makeRetainedTreeRow(t, retention));
    }
  }
  let treeCreatedSeq = wb.trees.baseline.length + 1;
  for (const c of wb.trees.created) {
    trees.push(makeCreatedTreeRow(c, treeCreatedSeq));
    treeCreatedSeq += 1;
  }
  return trees;
}
