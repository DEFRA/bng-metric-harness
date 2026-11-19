/**
 * The checks the scenario runner makes on the legacy pairs it generates,
 * before anything is priced or written into a workbook: a broken run fails
 * here, loudly, rather than shipping a fixture that misses its case. The BNG
 * Service format's checks are in bng-service.mjs.
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
 * The rows of a legacy post-intervention layer at each stage a subject may
 * name: the file holds both. A Lost tree, hedgerow or watercourse is the
 * baseline feature alone; a Lost area habitat is created again in place
 * (bng-library's workbook rows), so it is at both stages. A Created row is
 * post-intervention alone.
 */
function stageCondition(layer, stage) {
  if (stage === "post-intervention" && layer !== "Habitats") {
    return `AND "Retention Category" IS NOT 'Lost'`;
  }
  if (stage === "baseline") {
    return `AND "Retention Category" IS NOT 'Created'`;
  }
  return "";
}

/**
 * The scenario's subject feature must have landed, at the stage it names if
 * it names one: a tree that worsens keeps the ref of the tree it is, so only
 * its post-intervention row shows it was drawn. A hedgerow or watercourse
 * subject depends on the rejection sampler drawing enough lines, so fail
 * loudly rather than ship a fixture that silently misses its case.
 */
export function verifySubject(piFile, subject) {
  const refColumn = refColumnFor(subject.layer);
  const db = openGeoPackageReadonly(piFile);
  try {
    const found = db
      .prepare(
        `SELECT count(*) AS n FROM "${subject.layer}" WHERE "${refColumn}" = ? ${stageCondition(subject.layer, subject.stage)}`,
      )
      .get(subject.ref).n;
    if (found === 0) {
      throw new Error(
        `subject ${subject.layer}${subject.stage ? ` (${subject.stage})` : ""} "${subject.ref}" is missing — the layer generated too few features`,
      );
    }
  } finally {
    db.close();
  }
}
