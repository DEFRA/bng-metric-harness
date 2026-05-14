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
  if (!metricDistinctiveness[key]) return false;
  const conds = metricConditionScores[key];
  if (!conds) return false;
  const v = conds[condition];
  return typeof v === "number";
}

// ---------------------------------------------------------------------------
// Baseline row builder
// ---------------------------------------------------------------------------

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
    habitats.push({
      ref: makeRef("H", b.ref),
      baselineRef: String(b.ref),
      area: b.area,
      broad: b.broad,
      type: b.type,
      distinctiveness: b.distinctiveness,
      condition: b.condition,
      strategicSig: b.strategicSignificance,
    });
  }

  const hedgerows = wb.hedgerows.baseline.map((h) => ({
    ref: makeRef("HG", h.ref),
    baselineRef: String(h.ref),
    type: h.type,
    lengthM: h.lengthM,
    distinctiveness: h.distinctiveness,
    condition: h.condition,
    strategicSig: h.strategicSignificance,
  }));

  const rivers = wb.watercourses.baseline.map((r) => ({
    ref: makeRef("R", r.ref),
    baselineRef: String(r.ref),
    type: r.type,
    lengthM: r.lengthM,
    distinctiveness: r.distinctiveness,
    condition: r.condition,
    strategicSig: r.strategicSignificance,
  }));

  const trees = wb.trees.baseline.map((t) => ({
    ref: makeRef("T", t.ref),
    baselineRef: String(t.ref),
    type: t.type,
    distinctiveness: t.distinctiveness,
    condition: t.condition,
    strategicSig: t.strategicSignificance,
  }));

  return { habitats, hedgerows, rivers, trees, skipReasons };
}

// ---------------------------------------------------------------------------
// Post-intervention row builder
// ---------------------------------------------------------------------------

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

  const habEnh = new Map();
  for (const e of wb.habitats.enhancements) habEnh.set(String(e.baselineRef), e);
  const hedgeEnh = new Map();
  for (const e of wb.hedgerows.enhancements) hedgeEnh.set(String(e.baselineRef), e);
  const riverEnh = new Map();
  for (const e of wb.watercourses.enhancements) riverEnh.set(String(e.baselineRef), e);

  // --- Habitats --------------------------------------------------------------
  //
  // Pass 1 — filter & validate baseline rows; pre-compute strictness-skips
  // for created rows so the matcher only considers eligible candidates.
  const eligibleBaselines = [];
  for (const b of wb.habitats.baseline) {
    if (strict && !isHabitatConditionValid(b.broad, b.type, b.condition)) {
      skipReasons.push(`baseline habitat ref ${b.ref}: invalid (habitat, condition) under --strict-habitats`);
      continue;
    }
    if (!fateReconciles(b.area, b.areaRetained, b.areaEnhanced, b.areaLost)) {
      warnings.push(
        `habitat ref ${b.ref}: area accounting off (total=${b.area} retained=${b.areaRetained} enhanced=${b.areaEnhanced} lost=${b.areaLost})`,
      );
    }
    eligibleBaselines.push(b);
  }

  const eligibleCreatedIdxs = [];
  for (let i = 0; i < wb.habitats.created.length; i++) {
    const c = wb.habitats.created[i];
    if (strict && !isHabitatConditionValid(c.broad, c.type, c.condition)) {
      skipReasons.push(`created habitat ref ${c.ref}: invalid (habitat, condition) under --strict-habitats`);
      continue;
    }
    eligibleCreatedIdxs.push(i);
  }

  // Pass 2 — greedy lost→created assignment. For each created row (largest
  // first), pick the baseline parcel with the largest remaining lost-area
  // capacity that is still big enough to absorb it.
  const lostRemainingHa = new Map();
  for (const b of eligibleBaselines) {
    if (b.areaLost > 0) lostRemainingHa.set(String(b.ref), b.areaLost);
  }
  const createdAssignment = new Map(); // workbook-created idx → baselineRef
  const createdSortedByAreaDesc = eligibleCreatedIdxs
    .slice()
    .sort((a, b) => (wb.habitats.created[b].area ?? 0) - (wb.habitats.created[a].area ?? 0));
  for (const idx of createdSortedByAreaDesc) {
    const c = wb.habitats.created[idx];
    const needed = c.area ?? 0;
    if (needed <= 0) continue;
    let bestRef = null;
    let bestRemaining = -Infinity;
    for (const [ref, remaining] of lostRemainingHa) {
      if (remaining + FATE_AREA_ABSOLUTE_FLOOR_HA >= needed && remaining > bestRemaining) {
        bestRef = ref;
        bestRemaining = remaining;
      }
    }
    if (bestRef != null) {
      createdAssignment.set(idx, bestRef);
      lostRemainingHa.set(bestRef, bestRemaining - needed);
    }
  }

  // Pass 3 — emit rows. Per baseline: retained, enhanced, then any
  // assigned-created in their original A-2 order. Suffix letters are
  // allocated only when the baseline expands to more than one surviving row.
  const habitats = [];
  const SUFFIX_LETTERS = "abcdefghijklmnopqrstuvwxyz";
  for (const b of eligibleBaselines) {
    const baselineRef = String(b.ref);
    const assignedCreatedIdxs = [...createdAssignment.entries()]
      .filter(([, ref]) => ref === baselineRef)
      .map(([idx]) => idx)
      .sort((a, b2) => a - b2);

    let enhancedRowPlanned = false;
    const enhanced = (() => {
      if (b.areaEnhanced <= 0) return null;
      const enh = habEnh.get(baselineRef);
      const proposed = {
        broad: enh?.proposedBroad ?? b.broad,
        type: enh?.proposedType ?? b.type,
        distinctiveness: enh?.proposedDistinctiveness ?? b.distinctiveness,
        condition: enh?.proposedCondition ?? b.condition,
        strategicSig: enh?.proposedStrategicSignificance ?? b.strategicSignificance,
        advanceYears: enh?.advanceYears ?? 0,
        delayYears: enh?.delayYears ?? 0,
      };
      if (strict && !isHabitatConditionValid(proposed.broad, proposed.type, proposed.condition)) {
        skipReasons.push(`enhanced habitat ref ${baselineRef}: invalid proposed (habitat, condition) under --strict-habitats`);
        return null;
      }
      enhancedRowPlanned = true;
      return proposed;
    })();

    const sliceCount =
      (b.areaRetained > 0 ? 1 : 0) +
      (enhancedRowPlanned ? 1 : 0) +
      assignedCreatedIdxs.length;
    const useSuffix = sliceCount > 1;
    let suffixIdx = 0;
    const nextSuffix = () => (useSuffix ? SUFFIX_LETTERS[suffixIdx++] : "");

    if (b.areaRetained > 0) {
      habitats.push({
        ref: makeRef("H", baselineRef, nextSuffix()),
        baselineRef,
        retention: "Retained",
        area: b.areaRetained,
        baseline: { broad: b.broad, type: b.type, distinctiveness: b.distinctiveness, condition: b.condition, strategicSig: b.strategicSignificance },
        proposed: { broad: b.broad, type: b.type, distinctiveness: b.distinctiveness, condition: b.condition, strategicSig: b.strategicSignificance, advanceYears: 0, delayYears: 0 },
      });
    }

    if (enhanced) {
      habitats.push({
        ref: makeRef("H", baselineRef, nextSuffix()),
        baselineRef,
        retention: "Enhanced",
        area: b.areaEnhanced,
        baseline: { broad: b.broad, type: b.type, distinctiveness: b.distinctiveness, condition: b.condition, strategicSig: b.strategicSignificance },
        proposed: enhanced,
      });
    }

    for (const idx of assignedCreatedIdxs) {
      const c = wb.habitats.created[idx];
      habitats.push({
        ref: makeRef("H", baselineRef, nextSuffix()),
        baselineRef,
        retention: "Created",
        area: c.area,
        baseline: null,
        proposed: {
          broad: c.broad,
          type: c.type,
          distinctiveness: c.distinctiveness,
          condition: c.condition,
          strategicSig: c.strategicSignificance,
          advanceYears: c.advanceYears ?? 0,
          delayYears: c.delayYears ?? 0,
        },
      });
    }
  }

  // Unassigned created rows fall back to fresh refs (numbered after the
  // highest baseline ref). They'll carve from the orphaned lost-area pool
  // in the geometry pass.
  let createdSeq = wb.habitats.baseline.length + 1;
  for (const idx of eligibleCreatedIdxs) {
    if (createdAssignment.has(idx)) continue;
    const c = wb.habitats.created[idx];
    habitats.push({
      ref: makeRef("H", createdSeq++),
      baselineRef: null,
      retention: "Created",
      area: c.area,
      baseline: null,
      proposed: {
        broad: c.broad,
        type: c.type,
        distinctiveness: c.distinctiveness,
        condition: c.condition,
        strategicSig: c.strategicSignificance,
        advanceYears: c.advanceYears ?? 0,
        delayYears: c.delayYears ?? 0,
      },
    });
  }

  // --- Hedgerows / Rivers — same shape ---------------------------------------
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

  // --- Trees — points, classify by dominant fate -----------------------------
  // A tree row may span multiple individual trees with a mix of fates; v1
  // uses the dominant-fate heuristic and emits a single point per surviving
  // row. Fully-lost rows drop out entirely.
  const trees = [];
  for (const t of wb.trees.baseline) {
    const retained = t.areaRetained ?? 0;
    const enhanced = t.areaEnhanced ?? 0;
    const lost = t.areaLost ?? 0;
    if (retained === 0 && enhanced === 0 && lost > 0) continue; // fully lost
    const retention = enhanced > retained ? "Enhanced" : "Retained";
    trees.push({
      ref: makeRef("T", t.ref),
      baselineRef: String(t.ref),
      retention,
      baseline: { type: t.type, distinctiveness: t.distinctiveness, condition: t.condition, strategicSig: t.strategicSignificance },
      proposed: { type: t.type, distinctiveness: t.distinctiveness, condition: t.condition, strategicSig: t.strategicSignificance, advanceYears: 0, delayYears: 0 },
    });
  }
  let treeCreatedSeq = wb.trees.baseline.length + 1;
  for (const c of wb.trees.created) {
    trees.push({
      ref: makeRef("T", treeCreatedSeq++),
      baselineRef: null,
      retention: "Created",
      baseline: null,
      proposed: { type: c.type, distinctiveness: c.distinctiveness, condition: c.condition, strategicSig: c.strategicSignificance, advanceYears: c.advanceYears ?? 0, delayYears: c.delayYears ?? 0 },
    });
  }

  return { habitats, hedgerows, rivers, trees, skipReasons, warnings };
}

function buildLinearPostIntervention({ baseline, created, enhMap, refPrefix, warnings }) {
  const rows = [];
  for (const b of baseline) {
    const retainedM = b.lengthRetainedM ?? 0;
    const enhancedM = b.lengthEnhancedM ?? 0;
    const lostM = b.lengthLostM ?? 0;
    if (retainedM === 0 && enhancedM === 0 && lostM === 0 && b.lengthM > 0) {
      // No fate columns populated — treat the whole length as retained so
      // the linear feature still appears post-intervention.
      rows.push(makeLinearRow(b, b.lengthM, "Retained", refPrefix));
      continue;
    }
    const totalReconciled = retainedM + enhancedM + lostM;
    if (totalReconciled > 0 && Math.abs(totalReconciled - b.lengthM) > Math.max(b.lengthM * FATE_AREA_RELATIVE_TOLERANCE, 1)) {
      warnings.push(`${refPrefix} ref ${b.ref}: length accounting off (total=${b.lengthM}m retained=${retainedM} enhanced=${enhancedM} lost=${lostM})`);
    }
    const fates = [];
    if (retainedM > 0) fates.push("Retained");
    if (enhancedM > 0) fates.push("Enhanced");
    const split = fates.length > 1;
    const suffixFor = (fate) => (split ? (fate === "Retained" ? "a" : "b") : "");

    if (retainedM > 0) {
      rows.push(makeLinearRow(b, retainedM, "Retained", refPrefix, suffixFor("Retained")));
    }
    if (enhancedM > 0) {
      const enh = enhMap.get(String(b.ref));
      rows.push(makeLinearRow(b, enhancedM, "Enhanced", refPrefix, suffixFor("Enhanced"), enh));
    }
  }
  let seq = baseline.length + 1;
  for (const c of created) {
    rows.push({
      ref: makeRef(refPrefix, seq++),
      baselineRef: null,
      retention: "Created",
      lengthM: c.lengthM,
      baseline: null,
      proposed: { type: c.type, distinctiveness: c.distinctiveness, condition: c.condition, strategicSig: c.strategicSignificance, advanceYears: c.advanceYears ?? 0, delayYears: c.delayYears ?? 0 },
    });
  }
  return rows;
}

function makeLinearRow(b, lengthM, retention, refPrefix, suffix = "", enh = null) {
  return {
    ref: makeRef(refPrefix, b.ref, suffix),
    baselineRef: String(b.ref),
    retention,
    lengthM,
    baseline: { type: b.type, distinctiveness: b.distinctiveness, condition: b.condition, strategicSig: b.strategicSignificance },
    proposed: {
      type: enh?.proposedType ?? b.type,
      distinctiveness: enh?.proposedDistinctiveness ?? b.distinctiveness,
      condition: enh?.proposedCondition ?? b.condition,
      strategicSig: enh?.proposedStrategicSignificance ?? b.strategicSignificance,
      advanceYears: enh?.advanceYears ?? 0,
      delayYears: enh?.delayYears ?? 0,
    },
  };
}
