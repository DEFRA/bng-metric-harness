/**
 * The scenario runner's BNG Service format: each scenario drawn natively by
 * bng-library as one GeoPackage holding both stages, and its baseline-stage
 * file, then checked: the subject feature is there, every post-intervention
 * feature names its parent, and a valid scenario holds only values the
 * template offers.
 */

import { mkdirSync } from "node:fs";
import path from "node:path";
import {
  checkLineage,
  checkTemplateValues,
  generateBngServiceSynthetic,
} from "#bng-lib";
import { openGeoPackageReadonly } from "#gpkg-io";

// A scenario that breaks a rule on purpose, as bng-library marks it.
const INVALID_PREFIX = "invalid-";

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
function verifyBngServiceSubject(file, subject) {
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
function fileCheck(check, problems, describe) {
  return {
    check,
    expected: "no issues",
    actual: problems.length ? problems.map(describe).join("; ") : "no issues",
    passed: problems.length === 0,
  };
}

/**
 * Draw the scenario natively in the BNG Service format: the file holding both
 * stages, and its baseline-stage file, from the same seed. It holds exactly
 * what the scenario pins, as bng-library's own catalogue does. A valid
 * scenario must hold only values the template offers, and every scenario
 * must link each post-intervention feature to its parent.
 */
export function generateBngServiceScenario(
  scenario,
  files,
  { outDir, centre, plan },
) {
  const file = path.join(outDir, files.geoPackage);
  mkdirSync(path.dirname(file), { recursive: true });
  generateBngServiceSynthetic(file, centre, plan, { templateFeatures: false });
  generateBngServiceSynthetic(
    path.join(outDir, files.baselineStage),
    centre,
    plan,
    { templateFeatures: false, stage: "baseline" },
  );
  verifyBngServiceSubject(file, scenario.subject);
  const checks = [
    fileCheck(
      "every post-intervention feature names its parent",
      checkLineage(file),
      (p) => `${p.flaw} ${p.table} ${p.ref}`,
    ),
  ];
  if (!scenario.id.startsWith(INVALID_PREFIX)) {
    checks.unshift(
      fileCheck(
        "every value one the BNG Service template offers",
        checkTemplateValues(file),
        (i) => `${i.table} "${i.field}"`,
      ),
    );
  }
  return { source: { bngServiceFile: file }, checks };
}
