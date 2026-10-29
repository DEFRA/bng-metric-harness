import { openGeoPackage, openGeoPackageReadonly } from "#gpkg-io";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";

const PARCEL_REF = "Parcel Ref";

export const TIMING_LAYERS = Object.freeze({
  Habitats: { document: "habitats", ref: PARCEL_REF, prefix: "habitat" },
  Hedgerows: { document: "hedgerows", ref: PARCEL_REF, prefix: "hedgerow" },
  Rivers: {
    document: "watercourses",
    ref: PARCEL_REF,
    prefix: "watercourse",
  },
  "Urban Trees": { document: "trees", ref: "Tree Ref", prefix: "habitat" },
});

function timingColumns(layer) {
  return layer === "Urban Trees"
    ? [
        "Habitat Created/Enhanced in advance/years",
        "Delay in starting habitat creation/enhancement in years",
      ]
    : [
        "Habitat created in advance/years",
        "Delay in starting habitat creation/years",
      ];
}

function existingGeoPackage(file) {
  // SQLite receives a canonical, existing filesystem filename, never a URI,
  // connection string or a name that can create an unintended database.
  const canonical = realpathSync(path.resolve(file));
  if (
    path.extname(canonical).toLowerCase() !== ".gpkg" ||
    !statSync(canonical).isFile()
  ) {
    throw new Error("Timing fixtures must be existing local GeoPackage files");
  }
  return canonical;
}
function attributeDatabase(file) {
  const db = openGeoPackage(existingGeoPackage(file));
  // Attribute-only edits must never execute a geometry-changing rtree trigger.
  for (const name of [
    "ST_IsEmpty",
    "ST_MinX",
    "ST_MaxX",
    "ST_MinY",
    "ST_MaxY",
  ]) {
    db.function(name, { varargs: true }, () => {
      throw new Error("Timing fixture unexpectedly changed geometry");
    });
  }
  return db;
}

/**
 * Each of `refs` must name exactly one Lost area habitat, so a scenario whose
 * site has changed fails here rather than keeping nothing Lost.
 */
function checkKeptLost(db, refs) {
  for (const ref of refs) {
    const { count } = db
      .prepare(
        `SELECT COUNT(*) AS count FROM Habitats WHERE "${PARCEL_REF}" = ? AND "Retention Category" = 'Lost'`,
      )
      .get(ref);
    if (count !== 1) {
      throw new Error(`keepLost ${ref} matched ${count} Lost area habitats`);
    }
  }
}

/**
 * Temporary adapter for the pinned library's legacy Lost label on Created areas.
 * Follow-up: correct the generator and consolidate timing recipes in its catalogue,
 * then remove this relabel. Genuine Lost coverage is deliberately restored by
 * invalid-timing-retained-lost below, across all four layers.
 *
 * `keepLost` lists the Parcel Refs of area habitats left Lost, as a user's
 * legacy file records a replaced area, for a scenario that needs a real upload
 * to count the loss (a real upload reads a Created row as new habitat on empty
 * land). It is not an import-timing case, so it adds no timing contract.
 */
export function prepareImportTiming(file, cases = [], keepLost = []) {
  const db = attributeDatabase(file);
  try {
    db.transaction(() => {
      checkKeptLost(db, keepLost);
      const kept = keepLost.map(() => "?").join(", ");
      db.prepare(
        `UPDATE Habitats SET "Retention Category" = 'Created' WHERE "Retention Category" = 'Lost'${
          keepLost.length > 0 ? ` AND "${PARCEL_REF}" NOT IN (${kept})` : ""
        }`,
      ).run(...keepLost);
      for (const item of cases) {
        const layer = TIMING_LAYERS[item.layer];
        if (!layer) {
          throw new Error(`Unknown timing layer: ${item.layer}`);
        }
        const [advance, delay] = timingColumns(item.layer);
        const changed = db
          .prepare(
            `UPDATE "${item.layer}" SET "Retention Category" = ?, "${advance}" = ?, "${delay}" = ? WHERE "${layer.ref}" = ?`,
          )
          .run(item.retention, item.advance, item.delay, item.ref);
        if (changed.changes !== 1) {
          throw new Error(
            `Timing case ${item.layer}/${item.ref} matched ${changed.changes} rows`,
          );
        }
      }
    })();
  } finally {
    db.close();
  }
}

/** Independent input policy from BMD-1060 and BMD-1070; no service results. */
export function metricTiming(
  retention,
  rawAdvance,
  rawDelay,
  layer = "Habitats",
) {
  if (
    retention === "Retained" ||
    (retention === "Lost" && layer !== "Habitats")
  ) {
    return { advanceYears: 0, delayYears: 0 };
  }
  const advanceYears = timingValue(rawAdvance);
  const delayYears = timingValue(rawDelay);
  const conflicting = advanceYears > 0 && delayYears > 0;
  return conflicting
    ? { advanceYears: null, delayYears: null }
    : { advanceYears, delayYears };
}

function timingValue(value) {
  if (value == null || String(value).trim() === "") {
    return null;
  }
  const numeric = Number.parseFloat(value);
  return Number.isFinite(numeric) ? numeric : null;
}

export function readTimingInputs(file) {
  const db = openGeoPackageReadonly(existingGeoPackage(file));
  const inputs = [];
  try {
    for (const [table, layer] of Object.entries(TIMING_LAYERS)) {
      if (
        !db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
          )
          .get(table)
      ) {
        continue;
      }
      const [advance, delay] = timingColumns(table);
      for (const row of db
        .prepare(
          `SELECT "${layer.ref}" AS ref, "Retention Category" AS retention, "${advance}" AS advance, "${delay}" AS delay FROM "${table}" ORDER BY rowid`,
        )
        .all()) {
        inputs.push({ table, ...layer, ...row });
      }
    }
  } finally {
    db.close();
  }
  return inputs;
}

export function expectedImport(cases) {
  if (!cases?.length) {
    return undefined;
  }
  return {
    accepted: true,
    features: cases.map((item) => {
      const retained = item.retention === "Retained";
      const timing = retained
        ? { advanceYears: null, delayYears: null }
        : metricTiming(item.retention, item.advance, item.delay, item.layer);
      const complete =
        retained ||
        (timing.advanceYears !== null && timing.delayYears !== null);
      return {
        layer: TIMING_LAYERS[item.layer].document,
        ref: item.ref,
        ...(item.retention === "Lost" && item.layer !== "Habitats"
          ? { absent: true }
          : {
              proposed: timing,
              status: complete ? "Complete" : "Incomplete",
              ...(complete ? {} : { units: null }),
            }),
      };
    }),
  };
}
