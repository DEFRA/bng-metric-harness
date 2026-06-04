/**
 * Retention vocabulary translation.
 *
 * The row builders and synthetic generators use an internal four-value
 * vocabulary — Retained / Enhanced / Lost / Created — where "Created" tags
 * a created parcel for accounting purposes (it consumes lost-area budget
 * from a parent baseline parcel, or carries a self-similar baseline shape
 * when orphaned).
 *
 * The gpkg's "Retention Category" column follows the NE template, which has
 * only three values: Retained / Enhanced / Lost. Created parcels are
 * represented as Lost rows with proposed-state columns describing what's
 * being put there.
 *
 * `gpkgRetention` is the translation step. Call it at every column-write
 * site that emits the retention value, so internal accounting stays
 * unchanged but the persisted column matches the NE template.
 */

export function gpkgRetention(internalRetention) {
  return internalRetention === "Created" ? "Lost" : internalRetention;
}
