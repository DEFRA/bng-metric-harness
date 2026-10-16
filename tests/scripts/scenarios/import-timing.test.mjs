import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HARNESS_SCENARIOS } from "../../../scripts/scenarios/catalogue.mjs";
import { buildScenarioCorpus } from "../../../scripts/scenarios/runner.mjs";
import {
  importWorkbookRows,
  filterProjectedInputIssues,
} from "../../../scripts/scenarios/import-workbook-rows.mjs";
import {
  metricTiming,
  readTimingInputs,
} from "../../../scripts/scenarios/import-timing.mjs";
import { isBackendInstalled } from "../../../scripts/metric-comparison/backend.mjs";
import { importGeoPackagePair } from "../../../scripts/metric-comparison/import-geopackage-pair.mjs";
import { assertExpectedImport } from "../../../scripts/metric-comparison/import-expectations.mjs";
import { loadEngine } from "../../../scripts/scenarios/engine.mjs";
import { priceHabitats } from "../../../scripts/scenarios/engine-units.mjs";
import { DEFAULT_CENTRE } from "../../../scripts/centre.mjs";

const cases = HARNESS_SCENARIOS.filter((s) => s.importCases);
const advanceScenario = HARNESS_SCENARIOS.find(
  (s) => s.id === "advance-delay-created-advance-difficulty",
);
let directory;
let entries;
beforeAll(async () => {
  directory = mkdtempSync(path.join(tmpdir(), "harness-import-timing-"));
  entries = await buildScenarioCorpus({
    scenarios: [...cases, advanceScenario],
    outDir: directory,
    centre: DEFAULT_CENTRE,
    seed: 1,
    recalculate: false,
  });
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));

function pair(id) {
  const entry = entries.find((e) => e.id === id);
  return {
    entry,
    baseline: path.join(directory, entry.files.baseline),
    pi: path.join(directory, entry.files.postIntervention),
  };
}

describe("independent AC3-AC5 workbook timing inputs", () => {
  it.each([
    ["Created", 2, 3, null, null],
    ["Enhanced", 0.5, 0.25, null, null],
    ["Created", 2, 0, 2, 0],
    ["Enhanced", 0, 3, 0, 3],
    ["Created", 0, 0, 0, 0],
    ["Created", "30+", "0", 30, 0],
    ["Created", null, 0, null, 0],
    ["Enhanced", 0, null, 0, null],
    ["Created", " ", "0", null, 0],
    ["Retained", 4, 0, 0, 0],
    ["Lost", 0, 4, 0, 0],
  ])(
    "%s timing %s/%s becomes %s/%s only in workbook inputs",
    (retention, advance, delay, a, d) => {
      expect(metricTiming(retention, advance, delay)).toEqual({
        advanceYears: a,
        delayYears: d,
      });
    },
  );

  it.each(cases)(
    "keeps raw timing and explicit saved-value assertions for $id",
    (scenario) => {
      const { entry, pi, baseline } = pair(scenario.id);
      const raw = readTimingInputs(pi);
      for (const item of scenario.importCases) {
        const input = raw.find(
          (i) => i.table === item.layer && i.ref === item.ref,
        );
        expect(input).toMatchObject({
          retention: item.retention,
          advance: item.advance,
          delay: item.delay,
        });
      }
      expect(entry.expectedImport.accepted).toBe(true);
      expect(entry.expectedImport.features).toHaveLength(
        scenario.importCases.length,
      );
      const { rows } = importWorkbookRows(baseline, pi);
      for (const input of raw) {
        if (input.advance === "2" && input.delay === "3") {
          for (const stage of ["Creation", "Enhancement"]) {
            const row = rows[`${input.prefix}${stage}`].find(
              (r) => r.reference === input.ref,
            );
            if (row) {
              expect(row).toMatchObject({
                condition: null,
                advanceYears: null,
                delayYears: null,
              });
            }
          }
        }
      }
      expect(readTimingInputs(pi)).toEqual(raw);
    },
  );

  it("keeps all six advance/difficulty controls Created, with their original advance and baseline", () => {
    const { pi, baseline } = pair(advanceScenario.id);
    const raw = readTimingInputs(pi).filter((i) => i.table === "Habitats");
    expect(raw.map((i) => i.retention)).toEqual(Array(6).fill("Created"));
    const { rows, timingChanges } = importWorkbookRows(baseline, pi);
    expect(rows.habitatBaseline).toHaveLength(6);
    expect(rows.habitatCreation.map((r) => r.advanceYears)).toEqual([
      4, 5, 2, 2, 2, 2,
    ]);
    expect(rows.habitatCreation.map((r) => r.delayYears)).toEqual(
      Array(6).fill(0),
    );
    expect(timingChanges).toEqual([]);
  });

  it("prices Lost replacements without timing credit and retains the baseline loss", () => {
    const { baseline, pi } = pair("invalid-timing-retained-lost");
    const { rows, timingChanges } = importWorkbookRows(baseline, pi);
    expect(rows.habitatCreation).toEqual([
      expect.objectContaining({
        reference: "H002",
        condition: "Good",
        advanceYears: 0,
        delayYears: 0,
      }),
    ]);
    expect(rows.habitatBaseline.map((r) => r.reference)).toContain("H002");
    expect(timingChanges).toHaveLength(1);
    expect(timingChanges[0]).toMatchObject({
      retention: "Lost",
      raw: { advanceYears: "4", delayYears: "0" },
      metric: { advanceYears: 0, delayYears: 0 },
    });
  });

  it.each(cases)(
    "preserves every geometry and baseline attribute in $id",
    (scenario) => {
      const { baseline, pi } = pair(scenario.id);
      const baseDb = new Database(baseline, { readonly: true });
      const piDb = new Database(pi, { readonly: true });
      try {
        for (const table of [
          "Habitats",
          "Hedgerows",
          "Rivers",
          "Urban Trees",
        ]) {
          const columns = baseDb
            .prepare(`PRAGMA table_info("${table}")`)
            .all()
            .map((c) => c.name)
            .filter((c) => c === "geometry" || c.startsWith("Baseline "));
          const selection = columns.map((c) => `"${c}"`).join(", ");
          expect(
            piDb
              .prepare(`SELECT ${selection} FROM "${table}" ORDER BY rowid`)
              .all(),
          ).toEqual(
            baseDb
              .prepare(`SELECT ${selection} FROM "${table}" ORDER BY rowid`)
              .all(),
          );
        }
      } finally {
        baseDb.close();
        piDb.close();
      }
    },
  );
});

describe.skipIf(!isBackendInstalled())(
  "timing scenarios through the real backend",
  () => {
    it.each(cases)(
      "accepts and cleans $id without changing raw inputs",
      async (scenario) => {
        const { entry, baseline, pi } = pair(scenario.id);
        const raw = readTimingInputs(pi);
        const result = await importGeoPackagePair({
          baseline,
          postIntervention: pi,
        });
        expect(result.accepted, JSON.stringify(result.errors)).toBe(true);
        expect(() =>
          assertExpectedImport(result, entry.expectedImport),
        ).not.toThrow();
        expect(readTimingInputs(pi)).toEqual(raw);
      },
      30_000,
    );
  },
);

describe("generator net-gain checks use the expected import timing", () => {
  it("does not count advance credit on a raw Lost area", async () => {
    const { pi } = pair("invalid-timing-retained-lost");
    const engine = await loadEngine();
    const db = new Database(pi, { readonly: true });
    let areas;
    try {
      areas = db
        .prepare('SELECT "Area" AS area FROM Habitats ORDER BY rowid')
        .all();
    } finally {
      db.close();
    }
    const expectedUnits = engine.calculateRetainedAreaHabitatPostIntervention(
      areas[0].area / 10000,
      "Grassland - Modified grassland",
      "Moderate",
    ).units;
    const lostReplacementUnits =
      engine.calculateCreatedAreaHabitatPostIntervention(
        areas[1].area / 10000,
        "Grassland - Modified grassland",
        "Good",
        0,
        0,
      ).units;
    const expectedBaseline = areas.reduce(
      (total, row) =>
        total +
        engine.calculateAreaHabitatBaseline(
          row.area / 10000,
          "Grassland - Modified grassland",
          "Moderate",
        ).units,
      0,
    );
    expect(priceHabitats(engine, pi).baselineTotal).toBeCloseTo(
      expectedBaseline,
      10,
    );
    expect(priceHabitats(engine, pi).postInterventionTotal).toBeCloseTo(
      expectedUnits + lostReplacementUnits,
      10,
    );
  });
});

describe("timing fixture databases use existing local files", () => {
  it.each([
    ":memory:",
    "file:timing?mode=memory",
    path.join(tmpdir(), "nonexistent-timing.gpkg"),
  ])("refuses database URI or nonexistent filename %s", (file) => {
    expect(() => readTimingInputs(file)).toThrow();
  });
});

describe("projected workbook vocabulary checks", () => {
  it("only removes exact null fields declared for the unpriced row", () => {
    const known = {
      sheet: "habitatEnhancement",
      reference: "H002",
      field: "condition",
      value: null,
    };
    const unexpected = [
      { ...known, value: "invalid" },
      { ...known, reference: "H003" },
      { ...known, field: "habitatType" },
    ];
    const changes = [
      {
        sheet: known.sheet,
        reference: known.reference,
        excludedFromCalculation: true,
        metric: { condition: null, advanceYears: null, delayYears: 0 },
      },
    ];
    expect(filterProjectedInputIssues([known, ...unexpected], changes)).toEqual(
      unexpected,
    );
    expect(filterProjectedInputIssues([known])).toEqual([known]);
  });
});

describe("valid workbook timing labels", () => {
  it("preserves the existing 30+ input rather than rewriting a valid control", () => {
    const root = path.resolve("example-files/permutations/intervention");
    const { rows, timingChanges } = importWorkbookRows(
      path.join(root, "hedgerow-condition-lowered-baseline.gpkg"),
      path.join(root, "hedgerow-condition-lowered-post-intervention.gpkg"),
    );
    expect(
      rows.hedgerowCreation.find((row) => row.reference === "HG002")
        .advanceYears,
    ).toBe("30+");
    expect(timingChanges).toEqual([]);
  });
});
