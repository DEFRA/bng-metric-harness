/**
 * The rows of example-files/service-template/README.md, which
 * readme.mjs writes from the recipes: each fixture's path under the corpus,
 * with its Expected cell and the bare error code that cell names, if any.
 *
 * Read by the tests that hold other checks to the README's Expected column:
 * the corpus's expected codes, and the example file uploads' exceptions.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { HARNESS_ROOT } from "../_lib.mjs";

export const SERVICE_TEMPLATE_README = path.join(
  HARNESS_ROOT,
  "example-files",
  "service-template",
  "README.md",
);

// The Expected column, counted from the end of a row.
const EXPECTED_CELL = -3;
const SECTION = /^##\s+([\w-]+)\/\s*$/;
const FILE_CELL = /^`([^`]+\.gpkg)`$/;
const BARE_CODE = /^`?([A-Z][A-Z0-9_]+)`?$/;

/**
 * Each README row's file, under the corpus (`valid/default-site.gpkg`), with
 * its Expected cell and the bare code it names, or null where it names none
 * ("accepted", "refused: …").
 *
 * @param {string} [readme]
 * @returns {Map<string, { expected: string, code: string | null }>}
 */
export function readmeRows(readme = SERVICE_TEMPLATE_README) {
  const rows = new Map();
  let dir = null;
  for (const line of readFileSync(readme, "utf8").split("\n")) {
    const heading = SECTION.exec(line);
    if (heading) {
      dir = heading[1];
      continue;
    }
    if (!dir || !line.startsWith("|")) {
      continue;
    }
    const cells = line.split("|").map((cell) => cell.trim());
    const file = FILE_CELL.exec(cells[1] ?? "");
    if (file) {
      const expected = cells.at(EXPECTED_CELL) ?? "";
      rows.set(`${dir}/${file[1]}`, {
        expected,
        code: BARE_CODE.exec(expected)?.[1] ?? null,
      });
    }
  }
  return rows;
}
