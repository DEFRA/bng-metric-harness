/**
 * Build the synthetic metric workbook corpus (BMD-1011).
 *
 * For each catalogue scenario: generate the GeoPackage pair, write the
 * matching metric workbook from the post-intervention half, recalculate it
 * headlessly, and read back the metric's own answers. The scenario's declared
 * expectations are checked against those answers, so a scenario that no
 * longer demonstrates what it claims to fails the run.
 *
 * Everything lands in one flat folder, named by scenario id.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  PERMUTATION_DEFAULT_SIZE,
  deriveBaselineFromSynthetic,
  derivePermutationSeed,
  generateOne,
  setMode,
} from "#bng-lib";
import {
  checkScenarioExpectations,
  readTemplateVocabulary,
  recalculateWorkbooks,
  workbookFromGeoPackage,
} from "#workbook-writer";
import { header, info, warn } from "../_lib.mjs";

// BNG/EPSG:27700 coords of Maidenhead — the default centre gen-gpkg uses.
const MAIDENHEAD_EASTING = 530000;
const MAIDENHEAD_NORTHING = 180000;
const DEFAULT_CENTRE = [MAIDENHEAD_EASTING, MAIDENHEAD_NORTHING];

// Report recalculation progress every this many workbooks.
const PROGRESS_EVERY = 5;
const WORK_PREFIX = ".recalc-";

export const MANIFEST_FILE = "manifest.json";

export function scenarioFiles(scenario) {
  return {
    baseline: `${scenario.id}-baseline.gpkg`,
    postIntervention: `${scenario.id}-post-intervention.gpkg`,
    workbook: `${scenario.id}.xlsx`,
  };
}

/**
 * Remove the files a previous run wrote, as its manifest lists them, so a
 * scenario dropped from the catalogue cannot linger. Nothing else in the
 * folder is touched.
 */
function clearPreviousRun(outDir) {
  const manifestPath = path.join(outDir, MANIFEST_FILE);
  if (!existsSync(manifestPath)) {
    return;
  }
  const previous = JSON.parse(readFileSync(manifestPath, "utf8"));
  for (const entry of previous.scenarios ?? []) {
    for (const file of Object.values(entry.files ?? {})) {
      rmSync(path.join(outDir, file), { force: true });
    }
  }
}

function countRows(rows) {
  return Object.fromEntries(
    Object.entries(rows).map(([sheet, list]) => [sheet, list.length]),
  );
}

function generateScenario(scenario, { outDir, seed, template, vocabulary }) {
  const files = scenarioFiles(scenario);
  const piPath = path.join(outDir, files.postIntervention);
  const plan = {
    numParcels: scenario.size ?? PERMUTATION_DEFAULT_SIZE,
    emptyLayers: new Set(scenario.emptyLayers ?? []),
    attributeOverrides: scenario.overrides ?? {},
    seed: derivePermutationSeed(seed, scenario.id),
  };
  generateOne(piPath, DEFAULT_CENTRE, plan);
  deriveBaselineFromSynthetic(piPath, path.join(outDir, files.baseline));

  const { buffer, rows, issues, notes } = workbookFromGeoPackage({
    postInterventionPath: piPath,
    templateBuffer: template,
    vocabulary,
  });
  writeFileSync(path.join(outDir, files.workbook), buffer);

  const flag = issues.length > 0 ? ` — ${issues.length} rejected input(s)` : "";
  info(`  ✓ ${scenario.id}${flag}`);
  return {
    id: scenario.id,
    purpose: scenario.purpose,
    title: scenario.title,
    description: scenario.description,
    subject: scenario.subject,
    files,
    inputRows: countRows(rows),
    rejectedInputs: issues.map(({ allowed, ...issue }) => issue),
    notes,
  };
}

/** Collapse row warnings to one entry per feature and message. */
function groupWarnings(rowWarnings) {
  const grouped = new Map();
  for (const w of rowWarnings) {
    const key = `${w.sheet}|${w.reference}|${w.message}`;
    const entry = grouped.get(key) ?? {
      sheet: w.sheet,
      reference: w.reference,
      message: w.message,
      cells: [],
    };
    entry.cells.push(w.cell);
    grouped.set(key, entry);
  }
  return [...grouped.values()];
}

function uniqueSheetWarnings(sheetWarnings) {
  const seen = new Set();
  return sheetWarnings.filter((w) => {
    const key = `${w.sheet}|${w.message}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function attachResults(entry, scenario, results) {
  entry.metric = {
    headline: results.headline,
    trading: results.trading,
    uncorrected: results.uncorrected,
    sheetWarnings: uniqueSheetWarnings(results.sheetWarnings),
    rowWarnings: groupWarnings(results.rowWarnings),
  };
  entry.checks = checkScenarioExpectations(
    scenario,
    results,
    entry.rejectedInputs,
  );
  for (const check of entry.checks.filter((c) => !c.passed)) {
    warn(
      `  ${scenario.id}: ${check.check} — expected ${check.expected}, got ${check.actual}`,
    );
  }
}

async function recalculateAll(entries, scenarios, { outDir, soffice }) {
  // Beside the corpus rather than in the OS temp dir: the workbooks can then
  // be staged as hard links, and a small tmpfs is never filled.
  const workDir = mkdtempSync(path.join(outDir, WORK_PREFIX));
  try {
    const results = await recalculateWorkbooks(
      entries.map((e) => path.join(outDir, e.files.workbook)),
      {
        workDir,
        soffice,
        onProgress: (done, total) => {
          if (done % PROGRESS_EVERY === 0 || done === total) {
            info(`  recalculated ${done} of ${total}`);
          }
        },
      },
    );
    entries.forEach((entry, i) => {
      const scenario = scenarios.find((s) => s.id === entry.id);
      attachResults(entry, scenario, results[i]);
    });
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

/**
 * @param {object} options
 * @param {object[]} options.scenarios catalogue entries to build
 * @param {string} options.outDir the corpus folder
 * @param {string} options.templatePath the Defra metric v4 workbook
 * @param {number} options.seed run seed; each scenario derives its own
 * @param {boolean} options.recalculate run LibreOffice and read results
 * @param {string} [options.soffice] LibreOffice binary
 * @returns {Promise<object[]>} manifest entries, in catalogue order
 */
export async function buildWorkbookCorpus({
  scenarios,
  outDir,
  templatePath,
  seed,
  recalculate,
  soffice,
}) {
  const template = readFileSync(templatePath);
  const vocabulary = readTemplateVocabulary(template);

  mkdirSync(outDir, { recursive: true });
  clearPreviousRun(outDir);

  setMode("silent");
  header("Generating synthetic metric workbooks", "cyan");
  info(`  ${scenarios.length} scenario(s), seed ${seed} → ${outDir}`);
  const entries = scenarios.map((scenario) =>
    generateScenario(scenario, { outDir, seed, template, vocabulary }),
  );
  setMode("cli");

  if (recalculate) {
    header("Recalculating with LibreOffice", "cyan");
    await recalculateAll(entries, scenarios, { outDir, soffice });
  }
  return entries;
}
