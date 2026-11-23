import Database from "better-sqlite3";

// Each layer's type column. A habitat that gets worse is recorded as its
// parent lost and created again in the parent's own type (Metric User
// Guide, "Habitat retention"): a Created row, linked to its parent, in the
// type the parent has.
const LAYERS = [
  ["Area Habitats", "Habitat Type"],
  ["Vertical Area Habitats", "Habitat Type"],
  ["Hedgerows", "Hedge Type"],
  ["Watercourses", "River Type"],
];
const TREES = "Individual Trees";

/**
 * The rows of a BNG Service file that record a habitat getting worse, by
 * layer: on each habitat layer, a Created row linked to a parent of its own
 * type; on trees, an Existing tree Created over its baseline tree. A part c
 * lost to development, Created as Developed land; sealed surface, is another
 * type, so it is not one.
 */
export function worseRows(file) {
  const db = new Database(file, { readonly: true });
  try {
    const rows = Object.fromEntries(
      LAYERS.map(([layer, typeColumn]) => [
        layer,
        db
          .prepare(
            `SELECT p."Habitat Ref" ref FROM "${layer} Post-Intervention" p
               JOIN "${layer} Baseline" b ON b.feature_uuid = p.parent_uuid
              WHERE p."Retention Category" = 'Created'
                AND p."Proposed ${typeColumn}" = b."Baseline ${typeColumn}"`,
          )
          .all()
          .map((r) => r.ref),
      ]),
    );
    rows[TREES] = db
      .prepare(
        `SELECT p."Habitat Ref" ref FROM "${TREES} Post-Intervention" p
           JOIN "${TREES} Baseline" b ON b.feature_uuid = p.parent_uuid
          WHERE p."Retention Category" = 'Created'
            AND p.Category IS NOT 'Newly Planted'`,
      )
      .all()
      .map((r) => r.ref);
    return rows;
  } finally {
    db.close();
  }
}
