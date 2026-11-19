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
 * The stages a scenario's subject may name, each with its BNG Service table
 * suffix: the one list both formats' subject checks read (bng-library's
 * catalogue, checkSubject, holds scenarios to it too).
 */
export const SUBJECT_STAGES = Object.freeze({
  baseline: "Baseline",
  "post-intervention": "Post-Intervention",
});

/**
 * The stage a subject names, or null when it names none. One the checks do
 * not know is refused by name, rather than read as no stage at all or as a
 * table that is not there.
 */
export function subjectStage(subject) {
  const { stage } = subject;
  if (stage === undefined) {
    return null;
  }
  if (!Object.hasOwn(SUBJECT_STAGES, stage)) {
    throw new Error(
      `subject ${subject.layer} "${subject.ref}" names the stage ${JSON.stringify(stage)}, not one of ${Object.keys(SUBJECT_STAGES).join(", ")}`,
    );
  }
  return stage;
}

/** How a missing subject is named: its layer, and its stage if it names one. */
export function missingSubject(layer, stage, ref) {
  const where = stage ? `${layer} (${stage})` : layer;
  return new Error(
    `subject ${where} "${ref}" is missing — the layer generated too few features`,
  );
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
  const stage = subjectStage(subject);
  const db = openGeoPackageReadonly(piFile);
  try {
    const found = db
      .prepare(
        `SELECT count(*) AS n FROM "${subject.layer}" WHERE "${refColumn}" = ? ${stageCondition(subject.layer, stage)}`,
      )
      .get(subject.ref).n;
    if (found === 0) {
      throw missingSubject(subject.layer, stage, subject.ref);
    }
  } finally {
    db.close();
  }
}
