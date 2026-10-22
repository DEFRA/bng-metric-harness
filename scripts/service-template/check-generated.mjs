/**
 * The checks generate:gpkg runs on each BNG Service file it writes, so a
 * broken file is reported when it is made, not when it is opened or
 * uploaded:
 *
 *   - lineage: each post-intervention feature names its baseline parent (the
 *     check `npm run check:lineage` runs). A file named for a lineage flaw
 *     must report exactly that flaw.
 *   - template values: every value is one the template's drop-downs offer.
 *
 * A check is strict, and fails the run, where the file should pass it; it
 * only warns where a flaw asked for may break it on purpose (a geometric,
 * empty-layer, attribute or degrade flaw), or where a workbook may name a
 * habitat the template does not offer.
 */

import path from "node:path";
import { checkTemplateValues } from "#bng-lib";
import { checkFile } from "../lineage-check.mjs";

const MAX_EXAMPLES = 3;

/**
 * @param {string} file
 * @param {{ strictLineage: boolean, strictValues: boolean }} strictness
 * @returns {{ ok: boolean, findings: { level: 'info' | 'warn' | 'error',
 *   text: string }[] }}
 */
export function checkGenerated(file, { strictLineage, strictValues }) {
  const findings = [];
  const add = (strict, failed, text) => {
    let level = "info";
    if (failed) {
      level = strict ? "error" : "warn";
    }
    findings.push({ level, text });
  };

  const lineage = checkFile(file, path.basename(file));
  if (lineage.status === "pass") {
    add(
      strictLineage,
      false,
      lineage.expected
        ? `lineage: reports ${lineage.expected}, as its name says`
        : "lineage: every post-intervention feature names its parent",
    );
  } else if (lineage.status === "skip") {
    add(strictLineage, true, `lineage: not checked: ${lineage.reason}`);
  } else {
    const flaws = [...new Set(lineage.problems.map((p) => p.flaw))];
    const expected = lineage.expected
      ? `; its name says ${lineage.expected}`
      : "";
    add(
      strictLineage,
      true,
      `lineage: ${lineage.problems.length} problem(s) (${flaws.join(", ")})${expected}. See npm run check:lineage -- ${file}`,
    );
  }

  const values = checkTemplateValues(file);
  if (values.length === 0) {
    add(strictValues, false, "template values: all offered by the template");
  } else {
    const fields = values
      .slice(0, MAX_EXAMPLES)
      .map((v) => `${v.table} / ${v.field}`)
      .join(", ");
    add(
      strictValues,
      true,
      `template values: ${values.length} field(s) hold values the template does not offer (${fields})`,
    );
  }

  return {
    ok: findings.every((f) => f.level !== "error"),
    findings,
  };
}

/**
 * How strict the checks are for a synthetic file: strict unless a flaw asked
 * for may break them. A lineage or version flaw leaves the values alone, and
 * the lineage check expects a lineage flaw by the file's name. A --habitat
 * pin is checked against the legacy habitat list, which offers habitats the
 * template's area layer does not (an individual tree, say), so with pins the
 * values check only warns, as it does for a workbook.
 *
 * @param {{ contentFlaws: number, habitatPins?: number }} plan  how many
 *   geometric, empty-layer, attribute and degrade flaws the file carries,
 *   and how many habitats it pins
 */
export function syntheticStrictness({ contentFlaws, habitatPins = 0 }) {
  const clean = contentFlaws === 0;
  return { strictLineage: clean, strictValues: clean && habitatPins === 0 };
}

/** A workbook site's lineage is the generator's; its values are the workbook's. */
export const WORKBOOK_STRICTNESS = Object.freeze({
  strictLineage: true,
  strictValues: false,
});
