import Database from "better-sqlite3";

// The area habitat conditions, worst first.
const CONDITION_ORDER = [
  "Poor",
  "Fairly Poor",
  "Moderate",
  "Fairly Good",
  "Good",
];

const SEALED_SURFACE = "Developed land; sealed surface";

const isWorse = (row) =>
  CONDITION_ORDER.includes(row.proposed) &&
  CONDITION_ORDER.indexOf(row.proposed) < CONDITION_ORDER.indexOf(row.baseline);

const isBetter = (row) =>
  CONDITION_ORDER.includes(row.proposed) &&
  CONDITION_ORDER.indexOf(row.proposed) > CONDITION_ORDER.indexOf(row.baseline);

const isSplit = (children) =>
  children.length === 2 &&
  children.some((child) => child.retention === "Retained") &&
  children.some((child) => child.retention === "Created" && isWorse(child));

/**
 * How many baseline area habitats a BNG Service file splits into a Retained
 * part and a part Created in a worse condition, both naming it as parent.
 */
export function splitParcels(file) {
  return [...childrenByParent(file).values()].filter(isSplit).length;
}

/** A parent's part by its letter: "H008b" of "H008". */
const part = (children, letter) =>
  children.find((child) => child.ref === `${child.parent}${letter}`);

const isThreeWaySplit = (children) => {
  if (children.length !== 3) {
    return false;
  }
  const [kept, enhanced, lost] = ["a", "b", "c"].map((letter) =>
    part(children, letter),
  );
  return (
    kept?.retention === "Retained" &&
    enhanced?.retention === "Enhanced" &&
    enhanced.proposedType === enhanced.baselineType &&
    isBetter(enhanced) &&
    lost?.retention === "Created" &&
    lost.proposedType === SEALED_SURFACE
  );
};

/**
 * How many baseline area habitats a BNG Service file splits three ways with
 * no part getting worse: a Retained part a, a part b Enhanced to a better
 * condition in its own type, and a part c lost to development, Created as
 * Developed land; sealed surface, all naming it as parent.
 */
export function threeWaySplitParcels(file) {
  return [...childrenByParent(file).values()].filter(isThreeWaySplit).length;
}

/** A BNG Service file's post-intervention area habitats, by parent ref. */
function childrenByParent(file) {
  const db = new Database(file, { readonly: true });
  try {
    const rows = db
      .prepare(
        `SELECT "Parent Ref" parent, "Retention Category" retention,
                "Baseline Condition" baseline, "Proposed Condition" proposed,
                "Habitat Ref" ref, "Baseline Habitat Type" baselineType,
                "Proposed Habitat Type" proposedType
           FROM "Area Habitats Post-Intervention"`,
      )
      .all();
    return Map.groupBy(rows, (row) => row.parent);
  } finally {
    db.close();
  }
}
