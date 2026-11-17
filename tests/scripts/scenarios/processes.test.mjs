import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { HARNESS_SCENARIOS as SCENARIOS } from "../../../scripts/scenarios/catalogue.mjs";
import { HARNESS_ROOT } from "../../../scripts/_lib.mjs";
import { DEFAULT_CENTRE } from "../../../scripts/centre.mjs";
import { parseProcesses } from "../../../scripts/scenarios/processes.mjs";
import { buildScenarioCorpus } from "../../../scripts/scenarios/runner.mjs";

// A workbook's answers, as the recalculation hands them back: nothing on
// any row, so the scenario's checks have nothing to object to.
const RESULTS = {
  headline: {},
  trading: {},
  corrected: {},
  features: [],
  rowWarnings: [],
  sheetWarnings: [],
};

const save = vi.hoisted(() => vi.fn());

// The workbook writer and LibreOffice stand-ins: the GeoPackages are still
// drawn for real, but no template is read and nothing is recalculated, so
// all that is checked is what the corpus asks the recalculation for.
vi.mock("#workbook-writer", async (importOriginal) => ({
  ...(await importOriginal()),
  readTemplateVocabulary: () => ({}),
  checkVocabulary: () => [],
  writeMetricWorkbook: () => Buffer.from("workbook"),
  lintWorkbook: () => [],
  checkScenarioExpectations: () => [],
  saveRecalculatedWorkbooks: save,
}));

describe("parseProcesses", () => {
  it("gives the number asked for, as a number", () => {
    expect(parseProcesses("1")).toBe(1);
    expect(parseProcesses("2")).toBe(2);
  });

  it("gives undefined when the option is not given, for one per CPU", () => {
    expect(parseProcesses("")).toBeUndefined();
  });

  it.each(["0", "-1", "two", "1.5", "1e9", "0x2", " 2 ", "02"])(
    "refuses %j",
    (text) => {
      expect(() => parseProcesses(text)).toThrow(
        `--processes must be a whole number of 1 or more (got: ${text})`,
      );
    },
  );

  it("refuses more processes than the machine has CPUs", () => {
    expect(parseProcesses("4", 4)).toBe(4);
    expect(() => parseProcesses("5", 4)).toThrow(
      "--processes 5 is more than this machine's 4 CPUs",
    );
  });
});

describe("the LibreOffice process count, through the corpus build", () => {
  let outDir;
  const scenarios = SCENARIOS.filter(
    (s) => s.id === "intervention-area-retained",
  );

  beforeAll(() => {
    const parent = path.join(HARNESS_ROOT, "test-data");
    mkdirSync(parent, { recursive: true });
    outDir = mkdtempSync(path.join(parent, "scn-processes-"));
  });

  afterAll(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  async function build(options) {
    save.mockReset();
    save.mockImplementation(async (files) => files.map(() => RESULTS));
    await buildScenarioCorpus({
      scenarios,
      outDir,
      centre: DEFAULT_CENTRE,
      seed: 1,
      // Any file: the template's contents are only read by the stand-ins.
      templatePath: path.join(HARNESS_ROOT, "package.json"),
      recalculate: true,
      ...options,
    });
    expect(save).toHaveBeenCalledOnce();
    return save.mock.calls[0][1];
  }

  it("asks the recalculation for the number of processes given", async () => {
    const options = await build({ processes: 1 });
    expect(options.processes).toBe(1);
  });

  it("asks for none in particular when no number is given", async () => {
    const options = await build({});
    expect(options).toHaveProperty("processes", undefined);
  });
});
