/**
 * Shared header/value helpers for the metric-workbook readers. No sheet
 * knowledge — just generic xlsx parsing utilities and the column-name
 * constants reused by multiple sheet readers.
 */

// ---------------------------------------------------------------------------
// Sheet locations — the metric template is stable so we can name the sheets,
// but row positions vary a little (banner rows, version stamps), so we always
// find header rows by scanning for distinctive header text rather than hard-
// coding row indices.
// ---------------------------------------------------------------------------

export const SHEETS = {
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

export const INDIVIDUAL_TREES_BROAD = "Individual trees";

// Header text strings that appear in multiple sheet readers — promoted to
// named constants so any rename only needs to happen in one place.
export const HDR_REF = "Ref";
export const HDR_BASELINE_REF = "Baseline ref";
export const HDR_AREA_HECTARES = "Area (hectares)";
export const HDR_LENGTH_KM = "Length (km)";
export const HDR_DISTINCTIVENESS = "Distinctiveness";
export const HDR_CONDITION = "Condition";
export const HDR_STRATEGIC_SIGNIFICANCE = "Strategic significance";
export const HDR_PROPOSED_BROAD_HABITAT = "Proposed Broad Habitat";
export const HDR_PROPOSED_HABITAT = "Proposed habitat";
export const HDR_BROAD_HABITAT = "Broad Habitat";

const MAX_HEADER_SCAN_ROWS = 30;

// ---------------------------------------------------------------------------
// Header-row finders
// ---------------------------------------------------------------------------

/**
 * Find the header in a Defra metric sheet. The template often splits header
 * text across two adjacent rows (group label on top, column label below) so
 * we scan a sliding 2-row window, merge the cells (bottom row wins), and
 * pick whichever window contains the most expected tokens.
 */
export function findHeader(aoa, requiredTokens) {
  let best = { score: 0, dataStart: -1, header: null };
  const lim = Math.min(aoa.length - 1, MAX_HEADER_SCAN_ROWS);
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
  if (best.score < requiredTokens.length) {
    return { dataStart: -1, header: null };
  }
  return best;
}

function mergeHeaderRows(top, bottom) {
  const len = Math.max(top?.length ?? 0, bottom?.length ?? 0);
  const out = Array.from({ length: len });
  for (let i = 0; i < len; i++) {
    const b = bottom?.[i];
    const t = top?.[i];
    out[i] = b != null && String(b).trim() !== "" ? b : t;
  }
  return out;
}

// Header keys are trimmed here so callers don't need to list whitespace
// variants (the real workbook templates have inconsistent trailing/leading
// spaces in cells like "Condition " and " Habitat Type"). Case is preserved.
export function buildColumnIndex(headerRow) {
  const idx = {};
  for (let c = 0; c < headerRow.length; c++) {
    const v = headerRow[c];
    if (v == null) {
      continue;
    }
    const key = String(v).trim();
    if (!key) {
      continue;
    }
    if (!(key in idx)) {
      idx[key] = c;
    }
  }
  return idx;
}

// Pick a column by trying several candidate header strings. The index is
// already trimmed, so candidates only need to vary by spelling/case, not
// whitespace.
export function col(idx, ...candidates) {
  for (const c of candidates) {
    if (c in idx) {
      return idx[c];
    }
  }
  return -1;
}

/**
 * Find the first column whose header matches any of `candidates`, considering
 * only columns strictly to the right of `startCol`. Used on sheets where the
 * same header text (e.g. "Distinctiveness", "Condition") appears once on the
 * baseline side and again on the proposed side. Both sides of the comparison
 * are trimmed and lower-cased — candidates don't need whitespace or case
 * variants.
 */
export function findColAfter(header, candidates, startCol) {
  if (startCol < 0) {
    return -1;
  }
  const wanted = new Set(candidates.map((c) => c.trim().toLowerCase()));
  for (let c = startCol + 1; c < header.length; c++) {
    const v = header[c];
    if (v == null) {
      continue;
    }
    const key = String(v).trim().toLowerCase();
    if (wanted.has(key)) {
      return c;
    }
  }
  return -1;
}

/**
 * Strategic Significance has two columns with the same header in the template
 * (a category and a description). Pick the *first* one — it's the canonical
 * value used by the prototype/metric calc.
 */
export function findStrategicSignificanceCol(headerRow) {
  for (let c = 0; c < headerRow.length; c++) {
    if (readString(headerRow[c]) === HDR_STRATEGIC_SIGNIFICANCE) {
      return c;
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Value parsers
// ---------------------------------------------------------------------------

export function readNumber(v) {
  if (v == null) {
    return null;
  }
  if (typeof v === "number") {
    return Number.isFinite(v) ? v : null;
  }
  const s = String(v).trim();
  if (!s) {
    return null;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function readString(v) {
  if (v == null) {
    return null;
  }
  const s = String(v).trim();
  return s || null;
}

export function optString(row, colIdx) {
  return colIdx >= 0 ? readString(row[colIdx]) : null;
}

export function optNumber(row, colIdx) {
  return colIdx >= 0 ? readNumber(row[colIdx]) ?? 0 : 0;
}
