/**
 * Habitat-sheet readers: Start (site info), A-1 baseline, A-2 created,
 * A-3 enhancement mappings.
 */

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const XLSX = require("xlsx");

import {
  HDR_AREA_HECTARES,
  HDR_BASELINE_REF,
  HDR_BROAD_HABITAT,
  HDR_CONDITION,
  HDR_DISTINCTIVENESS,
  HDR_PROPOSED_BROAD_HABITAT,
  HDR_PROPOSED_HABITAT,
  HDR_REF,
  HDR_STRATEGIC_SIGNIFICANCE,
  INDIVIDUAL_TREES_BROAD,
  SHEETS,
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

// ---------------------------------------------------------------------------
// Start sheet — project metadata.
// ---------------------------------------------------------------------------

const SITE_INFO_LABELS = {
  "Planning authority:": "planningAuthority",
  "Project name:": "projectName",
  "Applicant:": "applicant",
  "Application type:": "applicationType",
  "Planning application reference:": "applicationRef",
  "Completed by:": "completedBy",
  "Reviewer:": "reviewer",
};

function harvestLabelValue(row, info) {
  for (let c = 0; c < row.length; c++) {
    const key = readString(row[c]);
    if (!key || !(key in SITE_INFO_LABELS)) {
      continue;
    }
    for (let cc = c + 1; cc < row.length; cc++) {
      const val = row[cc];
      if (val != null && String(val).trim() !== "") {
        info[SITE_INFO_LABELS[key]] = typeof val === "string" ? val.trim() : val;
        break;
      }
    }
  }
}

/** First numeric cell at or after `startCol` in `row`, or null. */
function firstNumberAfter(row, startCol) {
  for (let cc = startCol + 1; cc < row.length; cc++) {
    const n = readNumber(row[cc]);
    if (n != null) {
      return n;
    }
  }
  return null;
}

function harvestTotalSiteArea(row, info) {
  for (let c = 0; c < row.length; c++) {
    const s = readString(row[c]);
    if (!s || !/total site area .*hectares/i.test(s)) {
      continue;
    }
    const n = firstNumberAfter(row, c);
    if (n != null) {
      info.totalSiteAreaHa = n;
      return true;
    }
    return false;
  }
  return false;
}

export function readSiteInfo(workbook) {
  const ws = workbook.Sheets[SHEETS.start];
  if (!ws) {
    return {};
  }
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });
  const info = {};
  for (const row of aoa) {
    if (row) {
      harvestLabelValue(row, info);
    }
  }
  for (const row of aoa) {
    if (row && harvestTotalSiteArea(row, info)) {
      break;
    }
  }
  return info;
}

// ---------------------------------------------------------------------------
// A-1 On-Site Habitat Baseline
// ---------------------------------------------------------------------------

function resolveBaselineHabitatCols(header) {
  const idx = buildColumnIndex(header);
  return {
    cRef: col(idx, HDR_REF),
    cBroad: col(idx, HDR_BROAD_HABITAT),
    cType: col(idx, "Habitat Type", "Habitat type"),
    cArea: col(idx, HDR_AREA_HECTARES),
    cDist: col(idx, HDR_DISTINCTIVENESS),
    cCond: col(idx, HDR_CONDITION),
    cStrat: findStrategicSignificanceCol(header),
    cIrrep: col(idx, "Irreplaceable habitat"),
    cAreaRetained: col(idx, "Area retained"),
    cAreaEnhanced: col(idx, "Area enhanced"),
    cAreaLost: col(idx, "Area habitat lost", "Area Habitat Lost"),
  };
}

/** Decision codes for one A-1 row: stop scanning, skip silently, skip-with-
 * warning for blank area, or keep with parsed values. */
function classifyBaselineHabitatRow(row, { cType, cBroad, cArea }) {
  const type = readString(row[cType]);
  const broad = readString(row[cBroad]);
  const area = readNumber(row[cArea]);
  if (!type || !broad) {
    return { skip: true };
  }
  if (/^total/i.test(type) || /^site area/i.test(type)) {
    return { stop: true };
  }
  if (area == null) {
    return { skipBlankArea: true };
  }
  return { type, broad, area };
}

function decideBaselineHabitatRow(row, cols) {
  if (!row) {
    return {};
  }
  const decision = classifyBaselineHabitatRow(row, cols);
  if (decision.stop) {
    return { stop: true };
  }
  if (decision.skipBlankArea) {
    return { skipBlankArea: true };
  }
  if (decision.skip) {
    return {};
  }
  return { decision };
}

function buildBaselineHabitatEntry(row, decision, outIndex, cols) {
  const { type, broad, area } = decision;
  return {
    ref: readString(row[cols.cRef]) ?? String(outIndex + 1),
    broad,
    type,
    fullName: `${broad} - ${type}`,
    area,
    distinctiveness: readString(row[cols.cDist]),
    condition: readString(row[cols.cCond]),
    strategicSignificance: optString(row, cols.cStrat),
    irreplaceable: readString(row[cols.cIrrep]) === "Yes",
    isIndividualTree: broad === INDIVIDUAL_TREES_BROAD,
    areaRetained: optNumber(row, cols.cAreaRetained),
    areaEnhanced: optNumber(row, cols.cAreaEnhanced),
    areaLost: optNumber(row, cols.cAreaLost),
  };
}

export function readBaselineHabitats(workbook, summary) {
  const ws = workbook.Sheets[SHEETS.habitatsBaseline];
  if (!ws) {
    return [];
  }
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });
  const { dataStart, header } = findHeader(aoa, [HDR_REF, HDR_BROAD_HABITAT, HDR_AREA_HECTARES]);
  if (dataStart < 0) {
    summary.warnings.push(`Could not locate header row in ${SHEETS.habitatsBaseline}`);
    return [];
  }
  const cols = resolveBaselineHabitatCols(header);
  const out = [];
  for (let r = dataStart; r < aoa.length; r++) {
    const action = decideBaselineHabitatRow(aoa[r], cols);
    if (action.stop) {
      break;
    }
    if (action.skipBlankArea) {
      summary.skipped.push({ sheet: SHEETS.habitatsBaseline, row: r + 1, reason: "blank area" });
    } else if (action.decision) {
      out.push(buildBaselineHabitatEntry(aoa[r], action.decision, out.length, cols));
    } else {
      // row classified as skip (missing required fields) — silent drop
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// A-2 On-Site Habitat Creation
// ---------------------------------------------------------------------------

// A-2's broad/type/full-name columns sit between Ref and Area in this exact
// order from the right: …, broad, type, full-name. So the last non-empty
// label column is full-name, the second-last is type, the third-last is broad.
const A2_LABEL_FULL_OFFSET = 1;
const A2_LABEL_TYPE_OFFSET = 2;
const A2_LABEL_BROAD_OFFSET = 3;

function resolveCreatedHabitatCols(header) {
  const idx = buildColumnIndex(header);
  const cRef = col(idx, HDR_REF);
  const cArea = col(idx, HDR_AREA_HECTARES);
  // Walk right from cRef to cArea, take the last three non-empty header cells.
  const labelCols = [];
  for (let c = cRef + 1; c < cArea; c++) {
    if (readString(header[c])) {
      labelCols.push(c);
    }
  }
  return {
    cRef,
    cArea,
    cDist: col(idx, HDR_DISTINCTIVENESS),
    cCond: col(idx, HDR_CONDITION),
    cStrat: findStrategicSignificanceCol(header),
    cAdvance: col(idx, "Habitat created in advance (years)", "Habitat created in advance"),
    cDelay: col(idx, "Delay in starting habitat creation (years)", "Delay in starting habitat creation"),
    cFull: labelCols[labelCols.length - A2_LABEL_FULL_OFFSET] ?? -1,
    cType: labelCols[labelCols.length - A2_LABEL_TYPE_OFFSET] ?? -1,
    cBroad: labelCols[labelCols.length - A2_LABEL_BROAD_OFFSET] ?? -1,
  };
}

function decideCreatedRow(row, cols) {
  if (!row) {
    return {};
  }
  const broad = readString(row[cols.cBroad]);
  const type = readString(row[cols.cType]);
  if (!broad || !type) {
    return {};
  }
  if (/^total/i.test(broad) || /^totals/i.test(type)) {
    return { stop: true };
  }
  const area = readNumber(row[cols.cArea]);
  if (area == null) {
    return { skipBlankArea: true };
  }
  return { keep: true, area, broad, type };
}

function buildCreatedHabitatEntry(row, decision, outIndex, cols) {
  const { area, broad, type } = decision;
  return {
    ref: readString(row[cols.cRef]) ?? String(outIndex + 1),
    broad,
    type,
    fullName: readString(row[cols.cFull]) ?? `${broad} - ${type}`,
    area,
    distinctiveness: readString(row[cols.cDist]),
    condition: readString(row[cols.cCond]),
    strategicSignificance: optString(row, cols.cStrat),
    advanceYears: optNumber(row, cols.cAdvance),
    delayYears: optNumber(row, cols.cDelay),
    isIndividualTree: broad === INDIVIDUAL_TREES_BROAD,
  };
}

export function readCreatedHabitats(workbook, summary) {
  const ws = workbook.Sheets[SHEETS.habitatsCreation];
  if (!ws) {
    return [];
  }
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });
  const { dataStart, header } = findHeader(aoa, [HDR_REF, HDR_AREA_HECTARES, HDR_DISTINCTIVENESS]);
  if (dataStart < 0) {
    summary.warnings.push(`Could not locate header row in ${SHEETS.habitatsCreation}`);
    return [];
  }
  const cols = resolveCreatedHabitatCols(header);
  const out = [];
  for (let r = dataStart; r < aoa.length; r++) {
    const action = decideCreatedRow(aoa[r], cols);
    if (action.stop) {
      break;
    }
    if (action.skipBlankArea) {
      summary.skipped.push({ sheet: SHEETS.habitatsCreation, row: r + 1, reason: "blank area" });
      continue;
    }
    if (action.keep) {
      out.push(buildCreatedHabitatEntry(aoa[r], action, out.length, cols));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// A-3 On-Site Habitat Enhancement
// ---------------------------------------------------------------------------

function resolveEnhancementCols(header) {
  const idx = buildColumnIndex(header);
  const cPropType = col(idx, HDR_PROPOSED_HABITAT);
  return {
    cBaseRef: col(idx, HDR_BASELINE_REF),
    cPropBroad: col(idx, HDR_PROPOSED_BROAD_HABITAT),
    cPropType,
    // Two "Area (hectares)" columns exist — the first is the baseline parcel
    // total (col 6 in real workbooks), the second is the enhanced sub-area
    // (col 21). The fate columns on A-1 are authoritative for area, so this
    // value is informational only.
    cArea: col(idx, "Total habitat area (hectares)", HDR_AREA_HECTARES),
    // The proposed Distinctiveness/Condition/Strategic significance headers
    // sit after the "Proposed habitat" group and don't carry a "Proposed"
    // prefix in real workbooks. Locate them positionally.
    cPropDist: findColAfter(header, [HDR_DISTINCTIVENESS], cPropType),
    cPropCond: findColAfter(header, [HDR_CONDITION], cPropType),
    cPropStrat: findColAfter(header, [HDR_STRATEGIC_SIGNIFICANCE], cPropType),
    cAdvance: col(idx, "Habitat enhanced in advance (years)", "Habitat enhanced in advance"),
    cDelay: col(idx, "Delay in starting enhancement (years)", "Delay in starting habitat enhancement", "Delay in starting habitat enhancement (years)"),
  };
}

function decideEnhancementRow(row, cols) {
  if (!row) {
    return {};
  }
  const baselineRef = readString(row[cols.cBaseRef]);
  const propBroad = readString(row[cols.cPropBroad]);
  const propType = readString(row[cols.cPropType]);
  if (!baselineRef || !propBroad || !propType) {
    return {};
  }
  if (/^total/i.test(baselineRef) || /^totals/i.test(propBroad)) {
    return { stop: true };
  }
  return { baselineRef, propBroad, propType };
}

function buildEnhancementEntry(row, { baselineRef, propBroad, propType }, cols) {
  return {
    baselineRef,
    proposedBroad: propBroad,
    proposedType: propType,
    proposedFullName: `${propBroad} - ${propType}`,
    proposedArea: cols.cArea >= 0 ? readNumber(row[cols.cArea]) : null,
    proposedDistinctiveness: optString(row, cols.cPropDist),
    proposedCondition: optString(row, cols.cPropCond),
    proposedStrategicSignificance: optString(row, cols.cPropStrat),
    advanceYears: optNumber(row, cols.cAdvance),
    delayYears: optNumber(row, cols.cDelay),
  };
}

export function readEnhancementMappings(workbook, _summary) {
  const ws = workbook.Sheets[SHEETS.habitatsEnhancement];
  if (!ws) {
    return [];
  }
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });
  const { dataStart, header } = findHeader(aoa, [HDR_BASELINE_REF, HDR_PROPOSED_BROAD_HABITAT, HDR_PROPOSED_HABITAT]);
  if (dataStart < 0) {
    return [];
  }
  const cols = resolveEnhancementCols(header);
  const out = [];
  for (let r = dataStart; r < aoa.length; r++) {
    const action = decideEnhancementRow(aoa[r], cols);
    if (action.stop) {
      break;
    }
    if (action.baselineRef) {
      out.push(buildEnhancementEntry(aoa[r], action, cols));
    }
  }
  return out;
}
