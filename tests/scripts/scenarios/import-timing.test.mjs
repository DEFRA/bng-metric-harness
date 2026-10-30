import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  expectedImport,
  metricTiming,
  prepareImportTiming,
  readTimingInputs,
} from "../../../scripts/scenarios/import-timing.mjs";
import { isBackendInstalled } from "../../../scripts/metric-comparison/backend.mjs";
import { importGeoPackagePair } from "../../../scripts/metric-comparison/import-geopackage-pair.mjs";
import { assertExpectedImport } from "../../../scripts/metric-comparison/import-expectations.mjs";
import { loadEngine } from "../../../scripts/scenarios/engine.mjs";
import { priceHabitats } from "../../../scripts/scenarios/engine-units.mjs";
import { DEFAULT_CENTRE } from "../../../scripts/centre.mjs";

const COMMITTED_CORPUS = path.resolve(
  import.meta.dirname,
  "../../../example-files/permutations",
);
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

describe("Lost area saved-value contracts", () => {
  it.each([
    ["4", "0", 4, 0, "Complete"],
    ["0", "4", 0, 4, "Complete"],
    ["30+", "0", 30, 0, "Complete"],
    ["2", "3", null, null, "Incomplete"],
    [null, "0", null, 0, "Incomplete"],
    ["0", null, 0, null, "Incomplete"],
    [null, null, null, null, "Incomplete"],
  ])(
    "asserts Lost area timing %j/%j and completeness",
    (advance, delay, advanceYears, delayYears, status) => {
      const contract = expectedImport([
        { layer: "Habitats", ref: "H002", retention: "Lost", advance, delay },
      ]);
      expect(contract).toEqual({
        accepted: true,
        features: [
          {
            layer: "habitats",
            ref: "H002",
            proposed: { advanceYears, delayYears },
            status,
            ...(status === "Incomplete" ? { units: null } : {}),
          },
        ],
      });
      expect(Object.hasOwn(contract.features[0], "units")).toBe(
        status === "Incomplete",
      );
    },
  );

  it("writes preserved Lost-area timing into the generated manifest contract", () => {
    const { entry } = pair("invalid-timing-retained-lost");
    const saved = entry.expectedImport.features.find(
      (f) => f.layer === "habitats" && f.ref === "H002",
    );
    expect(saved).toEqual({
      layer: "habitats",
      ref: "H002",
      proposed: { advanceYears: 4, delayYears: 0 },
      status: "Complete",
    });
    expect(Object.hasOwn(saved, "units")).toBe(false);
  });
});

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
    ["Lost", 0, 4, 0, 4],
    ["Lost", 2, 3, null, null],
    ["Lost", null, null, null, null],
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

  it("keeps all six advance/difficulty controls Lost replacements, with their original advance and baseline", () => {
    const { pi, baseline } = pair(advanceScenario.id);
    const raw = readTimingInputs(pi).filter((i) => i.table === "Habitats");
    expect(raw.map((i) => i.retention)).toEqual(Array(6).fill("Lost"));
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

  it("prices Lost replacements with their timing credit and retains the baseline loss", () => {
    const { baseline, pi } = pair("invalid-timing-retained-lost");
    const { rows, timingChanges } = importWorkbookRows(baseline, pi);
    expect(rows.habitatCreation).toEqual([
      expect.objectContaining({
        reference: "H002",
        condition: "Good",
        advanceYears: 4,
        delayYears: 0,
      }),
    ]);
    expect(rows.habitatBaseline.map((r) => r.reference)).toContain("H002");
    expect(timingChanges).toEqual([]);
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

    // A replaced area is recorded Lost, which the service saves as a Created
    // replacement before any timing rule runs. A row recorded Created takes
    // the same timing rules, and differs only in having no baseline habitat:
    // the service leaves it out of the baseline it rebuilds, and so does the
    // workbook projection.
    const areaReplacements = cases.filter((scenario) =>
      scenario.importCases.some(
        (c) => c.layer === "Habitats" && c.retention === "Lost",
      ),
    );
    it.each(areaReplacements)(
      "applies the same timing rules to $id's area row recorded Created",
      async (scenario) => {
        const { baseline, pi } = pair(scenario.id);
        const asCreated = scenario.importCases.map((c) =>
          c.layer === "Habitats" && c.retention === "Lost"
            ? { ...c, retention: "Created" }
            : c,
        );
        const relabelled = asCreated.filter(
          (c, i) => c !== scenario.importCases[i],
        );
        const copy = path.join(directory, `${scenario.id}-created.gpkg`);
        copyFileSync(pi, copy);
        prepareImportTiming(copy, relabelled);

        const result = await importGeoPackagePair({
          baseline,
          postIntervention: copy,
        });

        expect(result.accepted, JSON.stringify(result.errors)).toBe(true);
        expect(expectedImport(asCreated)).toEqual(
          expectedImport(scenario.importCases),
        );
        expect(() =>
          assertExpectedImport(result, expectedImport(asCreated)),
        ).not.toThrow();
        const refs = relabelled.map((c) => c.ref);
        const savedBaseline = result.project.project.baseline.habitats.map(
          (h) => h.ref,
        );
        const workbookBaseline = importWorkbookRows(
          baseline,
          copy,
        ).rows.habitatBaseline.map((row) => row.reference);
        for (const ref of refs) {
          expect(savedBaseline).not.toContain(ref);
          expect(workbookBaseline).not.toContain(ref);
        }
      },
      30_000,
    );
  },
);

describe("generator net-gain checks use the expected import timing", () => {
  it("counts advance credit on a raw Lost area replacement", async () => {
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
        4,
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

describe("no generated area replacement is written Created", () => {
  // A Created row has no baseline habitat, so the service leaves its parcel
  // out of the baseline it rebuilds from the post-intervention file: an area
  // drawn with a baseline habitat must stay Lost, as a user's file records it.
  let builtDirectory;
  let built;
  beforeAll(async () => {
    builtDirectory = mkdtempSync(path.join(tmpdir(), "harness-replaced-"));
    built = await buildScenarioCorpus({
      scenarios: HARNESS_SCENARIOS.filter((s) =>
        [
          "trading-heathland-replaced-by-grassland",
          "trading-surplus-in-another-broad-habitat",
        ].includes(s.id),
      ),
      outDir: builtDirectory,
      centre: DEFAULT_CENTRE,
      seed: 1,
      recalculate: false,
    });
  });
  afterAll(() => rmSync(builtDirectory, { recursive: true, force: true }));

  function baselineRefs(dir, entry) {
    const db = new Database(path.join(dir, entry.files.baseline), {
      readonly: true,
    });
    try {
      return new Set(
        db
          .prepare('SELECT "Parcel Ref" AS ref FROM Habitats')
          .all()
          .map((row) => row.ref),
      );
    } finally {
      db.close();
    }
  }

  function createdRefs(dir, entry) {
    const db = new Database(path.join(dir, entry.files.postIntervention), {
      readonly: true,
    });
    try {
      return db
        .prepare(
          `SELECT "Parcel Ref" AS ref FROM Habitats WHERE "Retention Category" = 'Created'`,
        )
        .all()
        .map((row) => row.ref);
    } finally {
      db.close();
    }
  }

  it("writes no area habitat with a baseline habitat Created, in the timing and trading scenarios it builds", () => {
    const corpora = [
      ...entries.map((entry) => [directory, entry]),
      ...built.map((entry) => [builtDirectory, entry]),
    ];
    for (const [dir, entry] of corpora) {
      const inBaseline = baselineRefs(dir, entry);
      expect(
        createdRefs(dir, entry).filter((ref) => inBaseline.has(ref)),
        entry.id,
      ).toEqual([]);
    }
  });

  it("holds no area habitat with a baseline habitat Created, in any scenario of the committed legacy corpus", () => {
    const manifest = JSON.parse(
      readFileSync(path.join(COMMITTED_CORPUS, "manifest.json"), "utf8"),
    );
    expect(manifest.scenarios.length).toBeGreaterThan(0);
    for (const entry of manifest.scenarios) {
      const inBaseline = baselineRefs(COMMITTED_CORPUS, entry);
      expect(
        createdRefs(COMMITTED_CORPUS, entry).filter((ref) =>
          inBaseline.has(ref),
        ),
        entry.id,
      ).toEqual([]);
    }
  });

  it("writes the replaced heathland Lost in both trading-rules scenarios", () => {
    for (const id of [
      "trading-heathland-replaced-by-grassland",
      "trading-surplus-in-another-broad-habitat",
    ]) {
      const entry = built.find((e) => e.id === id);
      const { retention } = readTimingInputs(
        path.join(builtDirectory, entry.files.postIntervention),
      ).find((i) => i.table === "Habitats" && i.ref === "H004");
      expect(retention, id).toBe("Lost");
    }
  });

  it("refuses a timing case that matches no row", () => {
    const entry = built[0];
    const copy = path.join(builtDirectory, "timing-copy.gpkg");
    copyFileSync(path.join(builtDirectory, entry.files.postIntervention), copy);
    expect(() =>
      prepareImportTiming(copy, [
        { layer: "Habitats", ref: "H999", retention: "Lost" },
      ]),
    ).toThrow("Timing case Habitats/H999 matched 0 rows");
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
