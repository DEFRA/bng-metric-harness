/**
 * Tiny SQL-string helpers used when assembling INSERT statements for
 * feature tables with many columns.
 */

/** Build a `(?, ?, ?, …)` placeholder fragment with `n` slots. */
export function placeholders(n) {
  return Array.from({ length: n }, () => "?").join(", ");
}

/** Allocate a `length`-sized array pre-filled with `value` (default null). */
export function filledArray(length, value = null) {
  return Array.from({ length }, () => value);
}
