/**
 * Reader for filled-in Defra Statutory Biodiversity Metric workbooks
 * (the "BNG500" corpus and similar). Targets Metric v4 layout — sheets
 * named "A-1 On-Site Habitat Baseline", "A-2 On-Site Habitat Creation",
 * etc. Older v3.x layouts are detected and rejected with a clear error.
 *
 * Usage:
 *   import { readMetricWorkbook } from "./lib/metric-workbook.mjs";
 *   const wb = readMetricWorkbook("path/to/file.xlsx");
 *   // wb = { siteInfo, version, habitats: { baseline, created, enhancements },
 *   //        hedgerows: { baseline, created }, watercourses: { baseline, created },
 *   //        trees: { baseline, created }, summary }
 *
 * The reader is tolerant: it skips rows it can't understand, logs them in
 * `summary.skipped`, and never throws on a bad row.
 */

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const XLSX = require("xlsx");

// ---------------------------------------------------------------------------
// Sheet locations — the metric template is stable so we can name the sheets,
// but row positions vary a little (banner rows, version stamps), so we always
// find header rows by scanning for distinctive header text rather than hard-
// coding row indices.
// ---------------------------------------------------------------------------

const SHEETS = {
  start: "Start",
  habitatsBaseline: "A-1 On-Site Habitat Baseline",
  habitatsCreation: "A-2 On-Site Habitat Creation",
  habitatsEnhancement: "A-3 On-Site Habitat Enhancement",
  hedgesBaseline: "B-1 On-Site Hedge Baseline",
  hedgesCreation: "B-2 On-Site Hedge Creation",
  hedgesEnhancement: "B-3 On-Site Hedge Enhancement",
  watercoursesBaseline: "C-1 On-Site WaterC' Baseline",
  watercoursesCreation: "C-2 On-Site WaterC' Creation",
  watercoursesEnhancement: "C-3 On-Site WaterC' Enhancement",
};

const INDIVIDUAL_TREES_BROAD = "Individual trees";

// ---------------------------------------------------------------------------
// Header-row finders — each layer has a stable set of column-header tokens.
// We find the row where the most expected tokens match, then map header text
// to column index.
// ---------------------------------------------------------------------------

/**
 * Find the header in a Defra metric sheet. The template often splits header
 * text across two adjacent rows (group label on top, column label below) so
 * we scan a sliding 2-row window, merge the cells (bottom row wins), and
 * pick whichever window contains the most expected tokens.
 *
 * Returns { dataStart, header } where `header` is the merged header row.
 */
function findHeader(aoa, requiredTokens) {
  let best = { score: 0, dataStart: -1, header: null };
  const lim = Math.min(aoa.length - 1, 30);
  for (let r = 0; r < lim; r++) {
    const merged = mergeHeaderRows(aoa[r], aoa[r + 1]);
    const cells = merged.map((v) => (v == null ? "" : String(v).trim().toLowerCase()));
    const matched = requiredTokens.filter((t) =>
      cells.some((c) => c === t.toLowerCase()),
    );
    if (matched.length > best.score) {
      best = { score: matched.length, dataStart: r + 2, header: merged };
    }
  }
  if (best.score < requiredTokens.length) return { dataStart: -1, header: null };
  return best;
}

function mergeHeaderRows(top, bottom) {
  const len = Math.max(top?.length ?? 0, bottom?.length ?? 0);
  const out = new Array(len);
  for (let i = 0; i < len; i++) {
    const b = bottom?.[i];
    const t = top?.[i];
    out[i] = b != null && String(b).trim() !== "" ? b : t;
  }
  return out;
}

function buildColumnIndex(headerRow) {
  const idx = {};
  for (let c = 0; c < headerRow.length; c++) {
    const v = headerRow[c];
    if (v == null) continue;
    const key = String(v).trim();
    if (!key) continue;
    if (!(key in idx)) idx[key] = c;
  }
  return idx;
}

// Pick a column by trying several candidate header strings.
function col(idx, ...candidates) {
  for (const c of candidates) {
    if (c in idx) return idx[c];
  }
  return -1;
}

function readNumber(v) {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function readString(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}

// ---------------------------------------------------------------------------
// Site info (Start sheet)
// ---------------------------------------------------------------------------

function readSiteInfo(workbook) {
  const ws = workbook.Sheets[SHEETS.start];
  if (!ws) return {};
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });

  // Each "Project details" field appears as label/value on the same row but in
  // varying columns. Walk every row and harvest known label → next-non-blank-cell.
  const labels = {
    "Planning authority:": "planningAuthority",
    "Project name:": "projectName",
    "Applicant:": "applicant",
    "Application type:": "applicationType",
    "Planning application reference:": "applicationRef",
    "Completed by:": "completedBy",
    "Reviewer:": "reviewer",
  };
  const info = {};
  for (const row of aoa) {
    if (!row) continue;
    for (let c = 0; c < row.length; c++) {
      const key = readString(row[c]);
      if (!key || !(key in labels)) continue;
      for (let cc = c + 1; cc < row.length; cc++) {
        const val = row[cc];
        if (val != null && String(val).trim() !== "") {
          info[labels[key]] = typeof val === "string" ? val.trim() : val;
          break;
        }
      }
    }
  }

  // Total site area (hectares) — search by label.
  for (const row of aoa) {
    if (!row) continue;
    for (let c = 0; c < row.length; c++) {
      const s = readString(row[c]);
      if (s && /total site area .*hectares/i.test(s)) {
        for (let cc = c + 1; cc < row.length; cc++) {
          const n = readNumber(row[cc]);
          if (n != null) {
            info.totalSiteAreaHa = n;
            break;
          }
        }
        break;
      }
    }
    if ("totalSiteAreaHa" in info) break;
  }

  return info;
}

// ---------------------------------------------------------------------------
// Per-sheet readers
// ---------------------------------------------------------------------------

/**
 * A-1 On-Site Habitat Baseline — one row per existing habitat parcel.
 * Columns of interest (header text after the empty banner rows):
 *   "Ref", "Broad Habitat", " Habitat Type", "Area (hectares)",
 *   "Distinctiveness", "Condition ", "Strategic significance" (×2)
 * The habitat-type header has a leading space in the template, hence the
 * lenient candidate list.
 */
function readBaselineHabitats(workbook, summary) {
  const ws = workbook.Sheets[SHEETS.habitatsBaseline];
  if (!ws) return [];
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });

  const { dataStart, header } = findHeader(aoa, ["Ref", "Broad Habitat", "Area (hectares)"]);
  if (dataStart < 0) {
    summary.warnings.push(`Could not locate header row in ${SHEETS.habitatsBaseline}`);
    return [];
  }
  const idx = buildColumnIndex(header);
  const cRef = col(idx, "Ref");
  const cBroad = col(idx, "Broad Habitat");
  const cType = col(idx, "Habitat Type", " Habitat Type", "Habitat type");
  const cArea = col(idx, "Area (hectares)");
  const cDist = col(idx, "Distinctiveness");
  const cCond = col(idx, "Condition", "Condition ");
  const cStrat = findStrategicSignificanceCol(header);
  const cIrrep = col(idx, "Irreplaceable habitat");

  const out = [];
  for (let r = dataStart; r < aoa.length; r++) {
    const row = aoa[r];
    if (!row) continue;
    const type = readString(row[cType]);
    const broad = readString(row[cBroad]);
    const area = readNumber(row[cArea]);
    if (!type || !broad) continue;
    if (/^total/i.test(type) || /^site area/i.test(type)) break;
    if (area == null) {
      summary.skipped.push({ sheet: SHEETS.habitatsBaseline, row: r + 1, reason: "blank area" });
      continue;
    }
    out.push({
      ref: readString(row[cRef]) ?? String(out.length + 1),
      broad,
      type,
      fullName: `${broad} - ${type}`,
      area,
      distinctiveness: readString(row[cDist]),
      condition: readString(row[cCond]),
      strategicSignificance: cStrat >= 0 ? readString(row[cStrat]) : null,
      irreplaceable: readString(row[cIrrep]) === "Yes",
      isIndividualTree: broad === INDIVIDUAL_TREES_BROAD,
    });
  }
  return out;
}

/**
 * Strategic Significance has two columns with the same header in the template
 * (a category and a description). Pick the *first* one — it's the canonical
 * value used by the prototype/metric calc.
 */
function findStrategicSignificanceCol(headerRow) {
  for (let c = 0; c < headerRow.length; c++) {
    if (readString(headerRow[c]) === "Strategic significance") return c;
  }
  return -1;
}

/**
 * A-2 On-Site Habitat Creation — one row per newly-created habitat. The
 * sheet is also used for newly-created Individual Trees (broad === "Individual
 * trees"); those are emitted separately on the Urban Trees layer.
 *
 * Columns (header row): "Ref", "Broad Habitat" (first occurrence is the
 * "category" rendering; the proposed broad/type appear as separate columns
 * just after). The simplest stable read is by the "Area (hectares)" anchor
 * and walking left for ref/broad/type — but the template's headers are
 * actually unique enough to use directly.
 */
function readCreatedHabitats(workbook, summary) {
  const ws = workbook.Sheets[SHEETS.habitatsCreation];
  if (!ws) return [];
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });

  const { dataStart, header } = findHeader(aoa, ["Ref", "Area (hectares)", "Distinctiveness"]);
  if (dataStart < 0) {
    summary.warnings.push(`Could not locate header row in ${SHEETS.habitatsCreation}`);
    return [];
  }
  const idx = buildColumnIndex(header);
  const cRef = col(idx, "Ref");
  const cArea = col(idx, "Area (hectares)");
  const cDist = col(idx, "Distinctiveness");
  const cCond = col(idx, "Condition", "Condition ");
  const cStrat = findStrategicSignificanceCol(header);
  const cAdvance = col(idx, "Habitat created in advance (years)", "Habitat created in advance");
  const cDelay = col(idx, "Delay in starting habitat creation (years)", "Delay in starting habitat creation");

  // A-2's broad/type/full-name columns sit between the Ref and Area columns.
  // The merged header has labels like "Broad Habitat" / "Proposed habitat"
  // (the latter appears twice for type then full-name). Resolve positionally:
  // walk right from cRef to cArea, take the last three non-empty header cells.
  const labelCols = [];
  for (let c = cRef + 1; c < cArea; c++) {
    if (readString(header[c])) labelCols.push(c);
  }
  const cFull = labelCols[labelCols.length - 1] ?? -1;
  const cType = labelCols[labelCols.length - 2] ?? -1;
  const cBroad = labelCols[labelCols.length - 3] ?? -1;

  const out = [];
  for (let r = dataStart; r < aoa.length; r++) {
    const row = aoa[r];
    if (!row) continue;
    const ref = readString(row[cRef]);
    const broad = readString(row[cBroad]);
    const type = readString(row[cType]);
    const full = readString(row[cFull]);
    const area = readNumber(row[cArea]);
    if (!broad || !type) continue;
    if (/^total/i.test(broad) || /^totals/i.test(type)) break;
    if (area == null) {
      summary.skipped.push({ sheet: SHEETS.habitatsCreation, row: r + 1, reason: "blank area" });
      continue;
    }
    out.push({
      ref: ref ?? String(out.length + 1),
      broad,
      type,
      fullName: full ?? `${broad} - ${type}`,
      area,
      distinctiveness: readString(row[cDist]),
      condition: readString(row[cCond]),
      strategicSignificance: cStrat >= 0 ? readString(row[cStrat]) : null,
      advanceYears: cAdvance >= 0 ? readNumber(row[cAdvance]) ?? 0 : 0,
      delayYears: cDelay >= 0 ? readNumber(row[cDelay]) ?? 0 : 0,
      isIndividualTree: broad === INDIVIDUAL_TREES_BROAD,
    });
  }
  return out;
}

/**
 * A-3 On-Site Habitat Enhancement — maps a baseline parcel to its proposed
 * (enhanced) state. Header text contains "Baseline ref" and "Proposed Broad
 * Habitat", which is unique enough to anchor the column index.
 */
function readEnhancementMappings(workbook, summary) {
  const ws = workbook.Sheets[SHEETS.habitatsEnhancement];
  if (!ws) return [];
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });

  const { dataStart, header } = findHeader(aoa, ["Baseline ref", "Proposed Broad Habitat", "Proposed habitat"]);
  if (dataStart < 0) {
    // sheet may exist but be empty for this site — not an error
    return [];
  }
  const idx = buildColumnIndex(header);
  const cBaseRef = col(idx, "Baseline ref");
  const cPropBroad = col(idx, "Proposed Broad Habitat");
  const cPropType = col(idx, "Proposed habitat");
  const cArea = col(idx, "Total habitat area (hectares)", "Area (hectares)");
  const cPropDist = col(idx, "Proposed distinctiveness category", "Proposed distinctiveness");
  const cPropCond = col(idx, "Proposed condition category", "Proposed condition");
  const cPropStrat = col(idx, "Proposed strategic significance category");
  const cAdvance = col(idx, "Habitat enhanced in advance (years)", "Habitat enhanced in advance");
  const cDelay = col(idx, "Delay in starting enhancement (years)", "Delay in starting habitat enhancement");

  const out = [];
  for (let r = dataStart; r < aoa.length; r++) {
    const row = aoa[r];
    if (!row) continue;
    const baselineRef = readString(row[cBaseRef]);
    const propBroad = readString(row[cPropBroad]);
    const propType = readString(row[cPropType]);
    if (!baselineRef || !propBroad || !propType) continue;
    if (/^total/i.test(baselineRef) || /^totals/i.test(propBroad)) break;
    out.push({
      baselineRef,
      proposedBroad: propBroad,
      proposedType: propType,
      proposedFullName: `${propBroad} - ${propType}`,
      proposedArea: cArea >= 0 ? readNumber(row[cArea]) : null,
      proposedDistinctiveness: cPropDist >= 0 ? readString(row[cPropDist]) : null,
      proposedCondition: cPropCond >= 0 ? readString(row[cPropCond]) : null,
      proposedStrategicSignificance: cPropStrat >= 0 ? readString(row[cPropStrat]) : null,
      advanceYears: cAdvance >= 0 ? readNumber(row[cAdvance]) ?? 0 : 0,
      delayYears: cDelay >= 0 ? readNumber(row[cDelay]) ?? 0 : 0,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Linear features (hedges, watercourses) — share a similar shape: ref, type,
// length-in-km, condition, distinctiveness, strategic significance.
// ---------------------------------------------------------------------------

function readLinearFeatures(workbook, sheetName, kind, summary) {
  const ws = workbook.Sheets[sheetName];
  if (!ws) return [];
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });

  // Hedge sheets use "Hedge number" + "Habitat type"; watercourse sheets use
  // "Watercourse type". Both have "Length (km)" as a stable anchor.
  const typeHeader = kind === "hedge" ? "Habitat type" : "Watercourse type";
  const { dataStart, header } = findHeader(aoa, ["Ref", typeHeader, "Length (km)"]);
  if (dataStart < 0) return [];
  const idx = buildColumnIndex(header);
  const cRef = col(idx, "Ref");
  const cType = col(idx, typeHeader);
  const cLen = col(idx, "Length (km)");
  const cDist = col(idx, "Distinctiveness");
  const cCond = col(idx, "Condition", "Condition ");
  const cStrat = findStrategicSignificanceCol(header);

  const out = [];
  for (let r = dataStart; r < aoa.length; r++) {
    const row = aoa[r];
    if (!row) continue;
    const ref = readString(row[cRef]);
    const type = readString(row[cType]);
    const lenKm = readNumber(row[cLen]);
    if (!type) continue;
    if (/^total/i.test(type)) break;
    if (lenKm == null) {
      summary.skipped.push({ sheet: sheetName, row: r + 1, reason: "blank length" });
      continue;
    }
    out.push({
      ref: ref ?? String(out.length + 1),
      type,
      lengthKm: lenKm,
      lengthM: Math.round(lenKm * 1000),
      distinctiveness: readString(row[cDist]),
      condition: readString(row[cCond]),
      strategicSignificance: cStrat >= 0 ? readString(row[cStrat]) : null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect which version of the metric template the workbook uses. Currently
 * we recognise v4 by the presence of the v4 sheet names; anything else is
 * "unknown" and the caller should bail out.
 */
export function detectMetricVersion(workbook) {
  const names = new Set(workbook.SheetNames);
  if (names.has(SHEETS.habitatsBaseline) && names.has(SHEETS.habitatsCreation)) {
    return "4.0";
  }
  return "unknown";
}

/**
 * Read a metric workbook from disk and return a normalised object suitable
 * for driving the GeoPackage generator.
 */
export function readMetricWorkbook(filePath) {
  const workbook = XLSX.readFile(filePath, { cellDates: true, cellNF: false });
  const version = detectMetricVersion(workbook);
  if (version === "unknown") {
    throw new Error(
      `Unrecognised metric workbook layout in ${filePath}. ` +
        "Expected sheets like 'A-1 On-Site Habitat Baseline'. " +
        "v3.x and other older layouts are not supported.",
    );
  }

  const summary = { warnings: [], skipped: [] };
  const siteInfo = readSiteInfo(workbook);
  const baselineHabitats = readBaselineHabitats(workbook, summary);
  const createdHabitats = readCreatedHabitats(workbook, summary);
  const enhancements = readEnhancementMappings(workbook, summary);

  // Split out individual-tree rows; they belong on the Urban Trees layer,
  // not Habitats. Hedge/river sheets have their own dedicated layers.
  const trees = {
    baseline: baselineHabitats.filter((h) => h.isIndividualTree),
    created: createdHabitats.filter((h) => h.isIndividualTree),
  };
  const habitats = {
    baseline: baselineHabitats.filter((h) => !h.isIndividualTree),
    created: createdHabitats.filter((h) => !h.isIndividualTree),
    enhancements,
  };

  const hedgerows = {
    baseline: readLinearFeatures(workbook, SHEETS.hedgesBaseline, "hedge", summary),
    created: readLinearFeatures(workbook, SHEETS.hedgesCreation, "hedge", summary),
  };
  const watercourses = {
    baseline: readLinearFeatures(workbook, SHEETS.watercoursesBaseline, "river", summary),
    created: readLinearFeatures(workbook, SHEETS.watercoursesCreation, "river", summary),
  };

  return { siteInfo, version, habitats, hedgerows, watercourses, trees, summary };
}

// ---------------------------------------------------------------------------
// CLI: inspection helper. Run `node scripts/lib/metric-workbook.mjs <file>`
// to print a JSON summary without writing any GeoPackage.
// ---------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: node scripts/lib/metric-workbook.mjs <workbook.xlsx>");
    process.exit(1);
  }
  const wb = readMetricWorkbook(file);
  const tally = {
    version: wb.version,
    siteInfo: wb.siteInfo,
    counts: {
      habitats: {
        baseline: wb.habitats.baseline.length,
        created: wb.habitats.created.length,
        enhancements: wb.habitats.enhancements.length,
      },
      hedgerows: {
        baseline: wb.hedgerows.baseline.length,
        created: wb.hedgerows.created.length,
      },
      watercourses: {
        baseline: wb.watercourses.baseline.length,
        created: wb.watercourses.created.length,
      },
      trees: {
        baseline: wb.trees.baseline.length,
        created: wb.trees.created.length,
      },
    },
    summary: wb.summary,
  };
  console.log(JSON.stringify(tally, null, 2));
}
