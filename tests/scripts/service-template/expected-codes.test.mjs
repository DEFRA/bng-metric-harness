// The BNG Service template corpus against example-files/service-template/
// README.md's Expected column, for the checks the harness can run without
// PostGIS:
//
// - every schema-valid fixture holds only values the template's lists offer
//   (BMD-1175), unless its README row expects VALUE_NOT_ALLOWED, so no fixture
//   is refused for a value before it reaches the check it was built for. This
//   needs only bng-library, so it runs in CI.
// - the backend's BNG Service template gate refuses each schema-valid fixture
//   whose README row names a code the gate raises with exactly that code, and
//   passes every other fixture with a README row, which then fails, if at
//   all, at a later stage. The scenario corpus has no rows, and is left out
//   to keep the run short.
//   This needs an installed backend beside the harness (or BNG_BACKEND_DIR),
//   and skips without one.
//
// The byte-for-byte rebuild (corpus.test.mjs) cannot catch a fixture whose
// recipe changed with it; the lineage flaws are checked there too.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { loadGate } from "../../../.claude/skills/geopackage-validation-explainer/scripts/observe-fixtures.mjs";
import { disallowedValues } from "../../../scripts/allowed-values.mjs";
import {
  backendDir,
  isBackendInstalled,
} from "../../../scripts/metric-comparison/backend.mjs";

// Reading every fixture takes a second or two; a slow runner may need more.
const SLOW_TEST_TIMEOUT = 30_000;
const EXAMPLE_FILES = path.resolve(import.meta.dirname, "../../../example-files");
const CORPUS_DIR = "service-template";
const CORPUS = path.join(EXAMPLE_FILES, CORPUS_DIR);
const README = path.join(CORPUS, "README.md");

// The Expected column, counted from the end of a row.
const EXPECTED_CELL = -3;
const SECTION = /^##\s+([\w-]+)\/\s*$/;
const FILE_CELL = /^`([^`]+\.gpkg)`$/;
const BARE_CODE = /^`?([A-Z][A-Z0-9_]+)`?$/;

// Folders whose files are refused before any value is read: their schema is
// not the template's, or they are not GeoPackages at all.
const NOT_SCHEMA_VALID = new Set(["invalid-schema", "malformed"]);
// The scenario corpus, described by its own index rather than README rows.
const PERMUTATIONS = "permutations";

// The codes the BNG Service template gate itself raises for a file whose
// schema is the template's: its version record, then its text values. Any
// other code is raised by a later stage, after the gate passes.
const GATE_CODE =
  /^(TEMPLATE_VERSION_[A-Z_]+|TEXT_TOO_LONG|VALUE_NOT_ALLOWED|FEATURE_UUID_INVALID|PARENT_UUID_INVALID|PARENT_GEOM_INVALID)$/;

/**
 * Each README row's file, under the corpus, with its Expected cell and the
 * bare code it names, or null where it names none ("accepted", "refused: …").
 */
function readmeRows() {
  const rows = new Map();
  let dir = null;
  for (const line of readFileSync(README, "utf8").split("\n")) {
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

const ROWS = readmeRows();
const FIXTURES = readdirSync(CORPUS, { recursive: true })
  .map((file) => file.split(path.sep).join("/"))
  .filter((file) => file.endsWith(".gpkg"))
  .sort();
const SCHEMA_VALID = FIXTURES.filter(
  (file) => !NOT_SCHEMA_VALID.has(file.split("/")[0]),
);
const SCHEMA_VALID_ROWS = SCHEMA_VALID.filter((file) => ROWS.has(file));
const codeOf = (file) => ROWS.get(file)?.code ?? null;

describe("the service-template README's Expected column", () => {
  it("names only files in the corpus", () => {
    expect([...ROWS.keys()].filter((file) => !FIXTURES.includes(file))).toEqual(
      [],
    );
  });

  it("has a row for every fixture outside the scenario corpus", () => {
    expect(
      FIXTURES.filter(
        (file) => !file.startsWith(`${PERMUTATIONS}/`) && !ROWS.has(file),
      ),
    ).toEqual([]);
  });
});

describe("the schema-valid service-template fixtures' drop-down values", () => {
  it("hold only values the template's lists offer, unless a fixture expects VALUE_NOT_ALLOWED", () => {
    const refused = SCHEMA_VALID.filter(
      (file) => codeOf(file) !== "VALUE_NOT_ALLOWED",
    ).flatMap((file) =>
      disallowedValues(path.join(CORPUS, file)).map(
        ({ table, column, value }) =>
          `${file}: ${table}.${column} = ${JSON.stringify(value)}`,
      ),
    );
    expect(refused).toEqual([]);
  }, SLOW_TEST_TIMEOUT);

  it("hold a refused value where a fixture expects VALUE_NOT_ALLOWED", () => {
    for (const file of SCHEMA_VALID.filter(
      (f) => codeOf(f) === "VALUE_NOT_ALLOWED",
    )) {
      expect(disallowedValues(path.join(CORPUS, file)).length, file).toBeGreaterThan(0);
    }
  });
});

describe.skipIf(!isBackendInstalled())(
  "the BNG Service template gate over the schema-valid fixtures",
  () => {
    let gate;

    beforeAll(async () => {
      process.env.LOG_LEVEL = "silent";
      gate = await loadGate(backendDir());
    });

    const gateCodes = (file) => {
      const result = gate(path.join(CORPUS, file), `${CORPUS_DIR}/${file}`);
      return [...new Set(result.errors.map((error) => error.code))];
    };

    it("refuses each fixture whose README names a gate code with exactly that code", () => {
      const gateFixtures = SCHEMA_VALID_ROWS.filter((file) =>
        GATE_CODE.test(codeOf(file) ?? ""),
      );
      expect(gateFixtures.length).toBeGreaterThan(0);
      for (const file of gateFixtures) {
        expect(gateCodes(file), file).toEqual([codeOf(file)]);
      }
    });

    it("passes every other fixture with a README row, to fail, if at all, at the stage it was built for", () => {
      const refused = SCHEMA_VALID_ROWS.filter(
        (file) => !GATE_CODE.test(codeOf(file) ?? ""),
      )
        .map((file) => ({ file, codes: gateCodes(file) }))
        .filter(({ codes }) => codes.length > 0);
      expect(refused).toEqual([]);
    }, SLOW_TEST_TIMEOUT);
  },
);
