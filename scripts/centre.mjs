/**
 * The Red Line Boundary centre the generators place a synthetic site at, and
 * the --centre flag that moves it. Shared by gen-gpkg and gen-scenarios.
 */

import { error, warn } from "./_lib.mjs";

// British National Grid envelope, used for sanity-checking --centre input.
// Generous bounds — England/Scotland/Wales fit comfortably inside.
const BNG_MAX_EASTING = 700000;
const BNG_MAX_NORTHING = 1300000;

// EPSG:27700 (British National Grid) coords of Maidenhead, deep inside England
// — used as the fallback Red Line Boundary centre when --centre isn't given.
export const DEFAULT_CENTRE_E = 530000;
export const DEFAULT_CENTRE_N = 180000;
export const DEFAULT_CENTRE = [DEFAULT_CENTRE_E, DEFAULT_CENTRE_N];

/**
 * Parse the --centre "easting,northing" CLI value. Returns null when the
 * flag wasn't given, or [easting, northing] when valid. Exits on malformed
 * input rather than throwing.
 */
export function parseCentre(value) {
  if (!value) {
    return null;
  }
  const parts = value.split(",").map((s) => s.trim());
  if (parts.length !== 2) {
    error(`--centre expects "easting,northing" (got: ${value})`);
    return process.exit(1);
  }
  const e = Number(parts[0]);
  const n = Number(parts[1]);
  if (!Number.isFinite(e) || !Number.isFinite(n)) {
    error(`--centre values must be numbers (got: ${value})`);
    return process.exit(1);
  }
  // BNG covers roughly easting 0–700000, northing 0–1300000. Warn (not error)
  // outside that, since hand-typed coords often have transposed pairs.
  if (e < 0 || e > BNG_MAX_EASTING || n < 0 || n > BNG_MAX_NORTHING) {
    warn(
      `--centre ${e},${n} is outside the BNG envelope; the prototype's ` +
        "in-England check will likely reject the upload",
    );
  }
  return [e, n];
}
