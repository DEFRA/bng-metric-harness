/**
 * The single-file lineage check for BNG Service GeoPackages, which hold both
 * stages: does each post-intervention feature name its baseline parent
 * correctly? The legacy pair check (`check-gpkg-pair.mjs`) is its legacy
 * counterpart.
 *
 * A file whose name names a lineage flaw (as the corpus and generate:gpkg
 * name them, e.g. `…-lineage-parent-missing-….gpkg`) must report exactly that
 * flaw; every other file must report none.
 */

import { BNG_SERVICE_FLAWS, CATEGORY_LINEAGE, checkLineage } from "#bng-lib";
import { openGeoPackageReadonly } from "#gpkg-io";

const BNG_SERVICE_TABLE = "Area Habitats Baseline";

/** The lineage flaws, longest name first, so a longer name wins a match. */
const LINEAGE_FLAWS = Object.entries(BNG_SERVICE_FLAWS)
  .filter(([, flaw]) => flaw.category === CATEGORY_LINEAGE)
  .map(([name]) => name)
  .sort((a, b) => b.length - a.length);

/** The lineage flaw a file's name says it holds, or null. */
export function expectedFlaw(fileName) {
  return LINEAGE_FLAWS.find((name) => fileName.includes(name)) ?? null;
}

function isBngService(db) {
  return Boolean(
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(BNG_SERVICE_TABLE),
  );
}

/**
 * Check one file.
 *
 * @returns {{ status: 'pass' | 'fail' | 'skip', problems: object[],
 *   expected: string | null, reason?: string }}
 */
export function checkFile(file, fileName = file) {
  const db = openGeoPackageReadonly(file);
  try {
    if (!isBngService(db)) {
      return {
        status: "skip",
        problems: [],
        expected: null,
        reason:
          "not a BNG Service file; check a legacy pair with check-gpkg-pair",
      };
    }
    const problems = checkLineage(db);
    const expected = expectedFlaw(fileName);
    const flaws = problems.map((p) => p.flaw);
    // A lineage flaw breaks one feature, and the generator takes one lineage
    // flaw per file, so a flaw file normally reports one problem. Any number
    // passes, as long as every problem is the flaw its name says.
    const ok = expected
      ? flaws.length > 0 && flaws.every((flaw) => flaw === expected)
      : flaws.length === 0;
    return { status: ok ? "pass" : "fail", problems, expected };
  } finally {
    db.close();
  }
}
