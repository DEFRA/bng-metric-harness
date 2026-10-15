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

/** The library's synthetic Created areas use the legacy Lost label. */
export function prepareImportTiming(file, cases = []) {
  const db = attributeDatabase(file);
  try {
    db.transaction(() => {
      db.prepare(
        `UPDATE Habitats SET "Retention Category" = 'Created' WHERE "Retention Category" = 'Lost'`,
      ).run();
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

/** Independent workbook input policy from BMD-1060 AC3-AC5; no engine results. */
export function metricTiming(retention, advanceYears, delayYears) {
  const redundant = retention === "Retained" || retention === "Lost";
  const conflicting =
    ["Created", "Enhanced"].includes(retention) &&
    advanceYears > 0 &&
    delayYears > 0;
  return redundant || conflicting
    ? { advanceYears: 0, delayYears: 0 }
    : { advanceYears, delayYears };
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
    features: cases.map((item) => ({
      layer: TIMING_LAYERS[item.layer].document,
      ref: item.ref,
      ...(item.retention === "Lost" && item.layer !== "Habitats"
        ? { absent: true }
        : { proposed: { advanceYears: null, delayYears: null } }),
    })),
  };
}
