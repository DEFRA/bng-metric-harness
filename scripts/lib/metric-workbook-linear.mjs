/**
 * Linear-feature sheet readers (Hedgerows + Watercourses): B-1 / C-1
 * baselines, B-3 / C-3 enhancement mappings. (B-2 / C-2 creation reuses the
 * baseline reader without the per-fate columns.)
 */

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const XLSX = require("xlsx");

import {
  HDR_BASELINE_REF,
  HDR_CONDITION,
  HDR_DISTINCTIVENESS,
  HDR_LENGTH_KM,
  HDR_PROPOSED_BROAD_HABITAT,
  HDR_PROPOSED_HABITAT,
  HDR_REF,
  HDR_STRATEGIC_SIGNIFICANCE,
  buildColumnIndex,
  col,
  findColAfter,
  findHeader,
  findStrategicSignificanceCol,
  optNumber,
  optString,
  readNumber,
  readString,
} from "./metric-workbook-helpers.mjs";

// Sentinel returned by row deciders to signal end-of-data.
const STOP = Symbol("stop");

const KM_TO_M = 1000;

// ---------------------------------------------------------------------------
// B-1 / C-1 baseline + B-2 / C-2 created
// ---------------------------------------------------------------------------

function resolveLinearCols(header, typeHeader, withFate) {
  const idx = buildColumnIndex(header);
  return {
    base: {
      cRef: col(idx, HDR_REF),
      cType: col(idx, typeHeader),
      cLen: col(idx, HDR_LENGTH_KM),
      cDist: col(idx, HDR_DISTINCTIVENESS),
      cCond: col(idx, HDR_CONDITION),
      cStrat: findStrategicSignificanceCol(header),
    },
    // B-1 / C-1 carry the same per-row fate split as A-1, in length units (km).
    // C-1 uses "Length Lost" (title-case) while B-1 uses "Length lost" — col()
    // is case-sensitive so list both. Whitespace variants are handled by
    // buildColumnIndex's trim.
    fate: {
      cLenRetained: withFate ? col(idx, "Length retained", "Length Retained") : -1,
      cLenEnhanced: withFate ? col(idx, "Length enhanced", "Length Enhanced") : -1,
      cLenLost: withFate ? col(idx, "Length lost", "Length Lost") : -1,
    },
  };
}

function classifyLinearRow(row, { cType, cLen }) {
  const type = readString(row[cType]);
  const lenKm = readNumber(row[cLen]);
  if (!type) {
    return { skip: true };
  }
  if (/^total/i.test(type)) {
    return { stop: true };
  }
  if (lenKm == null) {
    return { skipBlankLen: true };
  }
  return { type, lenKm };
}

function decideLinearRow(row, baseCols) {
  if (!row) {
    return {};
  }
  const decision = classifyLinearRow(row, baseCols);
  if (decision.stop) {
    return { stop: true };
  }
  if (decision.skipBlankLen) {
    return { skipBlankLen: true };
  }
  if (decision.skip) {
    return {};
  }
  return { decision };
}

function buildLinearEntry(row, { type, lenKm }, outIndex, baseCols, fateCols, withFate) {
  const { cRef, cDist, cCond, cStrat } = baseCols;
  const ref = readString(row[cRef]);
  const entry = {
    ref: ref ?? String(outIndex + 1),
    type,
    lengthKm: lenKm,
    lengthM: Math.round(lenKm * KM_TO_M),
    distinctiveness: readString(row[cDist]),
    condition: readString(row[cCond]),
    strategicSignificance: optString(row, cStrat),
  };
  if (withFate) {
    const { cLenRetained, cLenEnhanced, cLenLost } = fateCols;
    const lenRetainedKm = optNumber(row, cLenRetained);
    const lenEnhancedKm = optNumber(row, cLenEnhanced);
    const lenLostKm = optNumber(row, cLenLost);
    entry.lengthRetainedKm = lenRetainedKm;
    entry.lengthEnhancedKm = lenEnhancedKm;
    entry.lengthLostKm = lenLostKm;
    entry.lengthRetainedM = Math.round(lenRetainedKm * KM_TO_M);
    entry.lengthEnhancedM = Math.round(lenEnhancedKm * KM_TO_M);
    entry.lengthLostM = Math.round(lenLostKm * KM_TO_M);
  }
  return entry;
}

export function readLinearFeatures(workbook, sheetName, kind, summary, { withFate = false } = {}) {
  const ws = workbook.Sheets[sheetName];
  if (!ws) {
    return [];
  }
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });
  // Hedge sheets use "Hedge number" + "Habitat type"; watercourse sheets use
  // "Watercourse type". Both have "Length (km)" as a stable anchor.
  const typeHeader = kind === "hedge" ? "Habitat type" : "Watercourse type";
  const { dataStart, header } = findHeader(aoa, [HDR_REF, typeHeader, HDR_LENGTH_KM]);
  if (dataStart < 0) {
    return [];
  }
  const { base: baseCols, fate: fateCols } = resolveLinearCols(header, typeHeader, withFate);
  const out = [];
  for (let r = dataStart; r < aoa.length; r++) {
    const action = decideLinearRow(aoa[r], baseCols);
    if (action.stop) {
      break;
    }
    if (action.skipBlankLen) {
      summary.skipped.push({ sheet: sheetName, row: r + 1, reason: "blank length" });
    } else if (action.decision) {
      out.push(buildLinearEntry(aoa[r], action.decision, out.length, baseCols, fateCols, withFate));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// B-3 / C-3 enhancement mappings
// ---------------------------------------------------------------------------

function resolveLinearEnhancementCols(header) {
  const idx = buildColumnIndex(header);
  const cBaseRef = col(idx, HDR_BASELINE_REF);
  const cPropType = col(idx, HDR_PROPOSED_HABITAT, "Proposed Habitat");
  // B-3 / C-3 lay out proposed columns to the right of a "Proposed habitat"
  // group label that doesn't appear in the data row. Anchor on Baseline ref
  // and locate proposed distinctiveness / condition / strategic significance
  // positionally — the same trick used for A-3.
  const propAnchor = cPropType >= 0 ? cPropType : cBaseRef;
  return {
    cBaseRef,
    cPropBroad: col(idx, HDR_PROPOSED_BROAD_HABITAT),
    cPropType,
    cPropDist: findColAfter(header, [HDR_DISTINCTIVENESS], propAnchor),
    cPropCond: findColAfter(header, [HDR_CONDITION], propAnchor),
    cPropStrat: findColAfter(header, [HDR_STRATEGIC_SIGNIFICANCE], propAnchor),
    cAdvance: col(idx, "Habitat enhanced in advance (years)", "Habitat enhanced in advance"),
    cDelay: col(idx, "Delay in starting habitat enhancement (years)", "Delay in starting habitat enhancement"),
  };
}

function enhancementRefForRow(row, cBaseRef) {
  if (!row) {
    return null;
  }
  const baselineRef = readString(row[cBaseRef]);
  if (!baselineRef) {
    return null;
  }
  if (/^total/i.test(baselineRef)) {
    return STOP;
  }
  return baselineRef;
}

function buildLinearEnhancementEntry(row, baselineRef, c) {
  return {
    baselineRef,
    proposedBroad: optString(row, c.cPropBroad),
    proposedType: optString(row, c.cPropType),
    proposedDistinctiveness: optString(row, c.cPropDist),
    proposedCondition: optString(row, c.cPropCond),
    proposedStrategicSignificance: optString(row, c.cPropStrat),
    advanceYears: optNumber(row, c.cAdvance),
    delayYears: optNumber(row, c.cDelay),
  };
}

export function readLinearEnhancements(workbook, sheetName, _summary) {
  const ws = workbook.Sheets[sheetName];
  if (!ws) {
    return [];
  }
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });
  // The merged header sits on row 10 in practice; anchor on "Baseline ref".
  const { dataStart, header } = findHeader(aoa, [HDR_BASELINE_REF, HDR_LENGTH_KM]);
  if (dataStart < 0) {
    return [];
  }
  const cols = resolveLinearEnhancementCols(header);
  const out = [];
  for (let r = dataStart; r < aoa.length; r++) {
    const baselineRef = enhancementRefForRow(aoa[r], cols.cBaseRef);
    if (baselineRef === STOP) {
      break;
    }
    if (baselineRef) {
      out.push(buildLinearEnhancementEntry(aoa[r], baselineRef, cols));
    }
  }
  return out;
}
