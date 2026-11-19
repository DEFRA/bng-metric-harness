import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifySubject } from "../../../scripts/scenarios/verify.mjs";
import { verifyBngServiceSubject } from "../../../scripts/scenarios/bng-service.mjs";

// intervention-tree-condition-lowered: T001 is lost and created again, and
// keeps its ref, so T001 is at both stages. Its subject names the
// post-intervention row, the one that shows the tree was created again.
const EXAMPLES = path.resolve(import.meta.dirname, "../../../example-files");
const LEGACY = path.join(
  EXAMPLES,
  "permutations/intervention/tree-condition-lowered-post-intervention.gpkg",
);
const BNG_SERVICE = path.join(
  EXAMPLES,
  "service-template/permutations/intervention/tree-condition-lowered.gpkg",
);
const subject = (stage) => ({
  layer: "Urban Trees",
  ref: "T001",
  note: "T001 recreated",
  ...(stage && { stage }),
});

let directory;
beforeAll(() => {
  directory = mkdtempSync(path.join(tmpdir(), "harness-verify-subject-"));
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));

/** A copy of `file` with `sql` run on it: the recreated tree not drawn. */
function without(file, sql) {
  const copy = path.join(directory, path.basename(file));
  copyFileSync(file, copy);
  const db = new Database(copy);
  try {
    db.prepare(sql).run();
  } finally {
    db.close();
  }
  return copy;
}

describe.each([
  [
    "legacy",
    verifySubject,
    LEGACY,
    `DELETE FROM "Urban Trees" WHERE "Tree Ref" = 'T001' AND "Retention Category" = 'Created'`,
  ],
  [
    "BNG Service",
    verifyBngServiceSubject,
    BNG_SERVICE,
    `DELETE FROM "Individual Trees Post-Intervention" WHERE "Habitat Ref" = 'T001'`,
  ],
])("the %s subject check", (_, verify, file, removeRecreated) => {
  it("finds the subject at the stage it names", () => {
    expect(() => verify(file, subject("post-intervention"))).not.toThrow();
    expect(() => verify(file, subject("baseline"))).not.toThrow();
  });

  it("refuses a subject missing at the stage it names, though its ref is at the other", () => {
    const copy = without(file, removeRecreated);

    expect(() => verify(copy, subject("post-intervention"))).toThrow(
      /subject .* "T001" is missing/,
    );
    expect(() => verify(copy, subject())).not.toThrow();
  });
});
