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

/** A table row's file and Expected cell, or null for any other line. */
function parseRow(line) {
  if (!line.startsWith("|")) {
    return null;
  }
  const cells = line.split("|").map((cell) => cell.trim());
  const file = FILE_CELL.exec(cells[1] ?? "");
  if (!file) {
    return null;
  }
  const expected = cells.at(EXPECTED_CELL) ?? "";
  return {
    file: file[1],
    expected,
    code: BARE_CODE.exec(expected)?.[1] ?? null,
  };
}

/** Add a line's row to `rows`, if it is a table row under a heading. */
function addRow(rows, dir, line) {
  const row = dir ? parseRow(line) : null;
  if (row) {
    rows.set(`${dir}/${row.file}`, { expected: row.expected, code: row.code });
  }
}

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
    } else {
      addRow(rows, dir, line);
    }
  }
  return rows;
}
