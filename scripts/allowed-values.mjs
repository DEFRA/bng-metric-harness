// The values a GeoPackage's drop-down and filled-in columns may hold, as the
// backend's text-values gate compares them (BMD-1175), for the harness's own
// checks of the committed corpus. The lists come from bng-library's
// TEMPLATE_ALLOWED_VALUES; the comparison is written out here, not loaded from
// the backend, so the check runs where no backend is checked out.

import Database from "better-sqlite3";
import { RED_LINE_BOUNDARY, TEMPLATE_ALLOWED_VALUES } from "bng-library/bng-service";

// A legacy list number, as in "4. Fairly Poor", but not the whole part of a
// decimal: "5.0" is five years, not list item 5 of "0".
const LIST_NUMBER = /^\d+\.(?!\d)\s*/;
// A whole number of years written as a decimal, as in "5.0".
const WHOLE_DECIMAL = /^(\d+)\.0+$/;
const WHITESPACE_RUN = /\s+/g;
// Riparian encroachment pairs are spelt "Minor/ Minor" and "Minor/Minor".
const SLASH = "/";
// The word GIS tools write for a missing value.
const NULL_WORD = "null";

/**
 * A column name as the check compares it: trimmed and in lower case.
 *
 * @param {string} column
 * @returns {string}
 */
export function columnKey(column) {
  return String(column).trim().toLowerCase();
}

/**
 * A value as the check compares it (the rules of the backend's
 * normaliseListValue, text-limits.js): trimmed, without a leading list number,
 * with each run of whitespace one space and none around a slash, a whole
 * number written as a decimal without its decimal places, in lower case.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normaliseListValue(value) {
  return String(value)
    .trim()
    .replace(LIST_NUMBER, "")
    .replaceAll(WHITESPACE_RUN, " ")
    .split(SLASH)
    .map((part) => part.trim())
    .join(SLASH)
    .replace(WHOLE_DECIMAL, "$1")
    .toLowerCase();
}

/**
 * Whether a value is blank: null, only whitespace, or the word "Null".
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isBlankValue(value) {
  if (value === null || value === undefined) {
    return true;
  }
  const text = String(value).trim();
  return text === "" || text.toLowerCase() === NULL_WORD;
}

/**
 * Column key → the normalised values its lists offer. Two names that are one
 * column once compared share one list, joined from both.
 *
 * @param {Record<string, string[]>} lists
 * @returns {Map<string, Set<string>>}
 */
export function buildAllowedValues(lists = TEMPLATE_ALLOWED_VALUES) {
  const allowed = new Map();
  for (const [column, values] of Object.entries(lists)) {
    const key = columnKey(column);
    const set = allowed.get(key) ?? new Set();
    for (const value of values) {
      set.add(normaliseListValue(value));
    }
    allowed.set(key, set);
  }
  return allowed;
}

const ALLOWED_VALUES = buildAllowedValues();

/**
 * Whether a column's value is one its lists offer, or blank. A column with no
 * list allows anything; so does a value that is not text but reads as one.
 *
 * @param {string} column
 * @param {unknown} value
 * @param {Map<string, Set<string>>} [allowed]
 * @returns {boolean}
 */
export function isAllowedValue(column, value, allowed = ALLOWED_VALUES) {
  const values = allowed.get(columnKey(column));
  if (!values || isBlankValue(value)) {
    return true;
  }
  if (Buffer.isBuffer(value)) {
    return false;
  }
  return values.has(normaliseListValue(value));
}

const quote = (name) => `"${String(name).replaceAll('"', '""')}"`;

/**
 * Every value in a GeoPackage's habitat tables that its column's lists do not
 * offer, each distinct one once: every feature table but Red Line Boundary,
 * every column with a list.
 *
 * @param {string} file
 * @returns {Array<{ table: string, column: string, value: unknown }>}
 */
export function disallowedValues(file) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const tables = db
      .prepare(
        "SELECT table_name FROM gpkg_contents WHERE lower(data_type) = 'features' ORDER BY rowid",
      )
      .all()
      .map((row) => String(row.table_name))
      .filter((table) => columnKey(table) !== columnKey(RED_LINE_BOUNDARY));
    return tables.flatMap((table) =>
      db
        .prepare(`PRAGMA table_info(${quote(table)})`)
        .all()
        .map((info) => String(info.name))
        .filter((column) => ALLOWED_VALUES.has(columnKey(column)))
        .flatMap((column) =>
          db
            .prepare(`SELECT DISTINCT ${quote(column)} AS value FROM ${quote(table)}`)
            .all()
            .filter((row) => !isAllowedValue(column, row.value))
            .map((row) => ({ table, column, value: row.value })),
        ),
    );
  } finally {
    db.close();
  }
}
