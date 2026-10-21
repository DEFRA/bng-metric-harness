/**
 * The checks the scenario runner makes on the files it generates, before
 * anything is priced or written into a workbook: a broken run fails here,
 * loudly, rather than shipping a fixture that misses its case.
 */

import { openGeoPackageReadonly } from "#gpkg-io";
import { refColumnFor } from "../gpkg-columns.mjs";

/**
 * Light pair check: the derived baseline must have cleared the area layer's
 * proposed state, and both halves must share a redline. The deep guarantees
 * are bng-library's own tests; this catches a broken run early.
 */
export function verifyPair(baselineFile, piFile) {
  const baseDb = openGeoPackageReadonly(baselineFile);
  const piDb = openGeoPackageReadonly(piFile);
  try {
    const leftoverProposed = baseDb
      .prepare(
        `SELECT count(*) AS n FROM "Habitats"
           WHERE "Proposed Condition" IS NOT NULL
              OR "Retention Category" IS NOT NULL`,
      )
      .get().n;
    if (leftoverProposed > 0) {
      throw new Error(
        `baseline half still carries proposed data on ${leftoverProposed} habitat row(s)`,
      );
    }
    const redlineSql = `SELECT hex(geometry) AS g FROM "Red Line Boundary"`;
    const baseRlb = baseDb.prepare(redlineSql).get()?.g;
    const piRlb = piDb.prepare(redlineSql).get()?.g;
    if (!baseRlb || baseRlb !== piRlb) {
      throw new Error("baseline and post-intervention redlines differ");
    }
  } finally {
    baseDb.close();
    piDb.close();
  }
}

/**
 * The scenario's subject feature must have landed. A hedgerow or watercourse
 * subject depends on the rejection sampler drawing enough lines, so fail
 * loudly rather than ship a fixture that silently misses its case.
 */
export function verifySubject(piFile, subject) {
  const refColumn = refColumnFor(subject.layer);
  const db = openGeoPackageReadonly(piFile);
  try {
    const found = db
      .prepare(
        `SELECT count(*) AS n FROM "${subject.layer}" WHERE "${refColumn}" = ?`,
      )
      .get(subject.ref).n;
    if (found === 0) {
      throw new Error(
        `subject ${subject.layer} "${subject.ref}" is missing — the layer generated too few features`,
      );
    }
  } finally {
    db.close();
  }
}

// The BNG Service layer a legacy subject layer names.
const BNG_SERVICE_LAYERS = {
  Habitats: "Area Habitats",
  Hedgerows: "Hedgerows",
  Rivers: "Watercourses",
  "Urban Trees": "Individual Trees",
};

/**
 * The scenario's subject feature must be in the BNG Service file, at either
 * stage (a created feature has no baseline row), by its Habitat Ref.
 */
export function verifyBngServiceSubject(file, subject) {
  const layer = BNG_SERVICE_LAYERS[subject.layer];
  const db = openGeoPackageReadonly(file);
  try {
    const found = ["Baseline", "Post-Intervention"].some(
      (stage) =>
        db
          .prepare(
            `SELECT count(*) AS n FROM "${layer} ${stage}" WHERE "Habitat Ref" = ?`,
          )
          .get(subject.ref).n > 0,
    );
    if (!found) {
      throw new Error(
        `subject ${layer} "${subject.ref}" is missing — the layer generated too few features`,
      );
    }
  } finally {
    db.close();
  }
}

/** A check the BNG Service file must pass, as recorded in the manifest. */
export function fileCheck(check, problems, describe) {
  return {
    check,
    expected: "no issues",
    actual: problems.length ? problems.map(describe).join("; ") : "no issues",
    passed: problems.length === 0,
  };
}
