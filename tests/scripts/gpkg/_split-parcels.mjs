import Database from "better-sqlite3";

// The area habitat conditions, worst first.
const CONDITION_ORDER = [
  "Poor",
  "Fairly Poor",
  "Moderate",
  "Fairly Good",
  "Good",
];

const isWorse = (row) =>
  CONDITION_ORDER.includes(row.proposed) &&
  CONDITION_ORDER.indexOf(row.proposed) < CONDITION_ORDER.indexOf(row.baseline);

const isSplit = (children) =>
  children.length === 2 &&
  children.some((child) => child.retention === "Retained") &&
  children.some((child) => child.retention === "Created" && isWorse(child));

/**
 * How many baseline area habitats a BNG Service file splits into a Retained
 * part and a part Created in a worse condition, both naming it as parent.
 */
export function splitParcels(file) {
  const db = new Database(file, { readonly: true });
  try {
    const rows = db
      .prepare(
        `SELECT "Parent Ref" parent, "Retention Category" retention,
                "Baseline Condition" baseline, "Proposed Condition" proposed
           FROM "Area Habitats Post-Intervention"`,
      )
      .all();
    const byParent = Map.groupBy(rows, (row) => row.parent);
    return [...byParent.values()].filter(isSplit).length;
  } finally {
    db.close();
  }
}
