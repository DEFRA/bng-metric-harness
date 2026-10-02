/**
 * Build the scenario corpus from the bng-library catalogue — one command for
 * both the GeoPackage fixtures and the metric workbooks that go with them.
 *
 * For each scenario:
 *   1. generate the post-intervention GeoPackage and derive its baseline half,
 *      and check the pair and the scenario's subject feature;
 *   2. price its habitats through our engine when it expects a net gain;
 *   3. unless workbooks are off, write the Defra metric workbook describing
 *      the same site;
 * then, unless recalculation is off, recalculate every workbook with
 * LibreOffice and check each scenario's expectations against the metric's own
 * verdict.
 *
 * Files are organised one folder per purpose. A failed expectation is
 * recorded rather than thrown, so one run reports every scenario that no
 * longer demonstrates what it claims to.
 */

import { createHash } from "node:crypto";
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
import { openGeoPackageReadonly } from "#gpkg-io";
import {
  checkScenarioExpectations,
  lintWorkbook,
  readMetricResults,
  readTemplateVocabulary,
  saveRecalculatedWorkbooks,
  workbookFromGeoPackage,
} from "#workbook-writer";
import { header, info, warn } from "../_lib.mjs";
import { refColumnFor } from "../gpkg-columns.mjs";
import { readScenarioManifest } from "./manifest.mjs";
import { loadEngine } from "./engine.mjs";
import { meetsNetGain, priceHabitats } from "./engine-units.mjs";

// Report recalculation progress every this many workbooks.
const PROGRESS_EVERY = 5;
// Lint issues quoted in a failed check; the manifest keeps them all.
const LINT_ISSUES_QUOTED = 3;
const WORK_PREFIX = ".recalc-";

/**
 * File names within the scenario's purpose folder. When the id leads with its
 * purpose, it is dropped rather than repeated: intervention/area-created-…,
 * not intervention/intervention-area-created-….
 */
export function scenarioFiles(scenario) {
  const prefix = `${scenario.purpose}-`;
  const base = scenario.id.startsWith(prefix)
    ? scenario.id.slice(prefix.length)
    : scenario.id;
  const inFolder = (name) => path.join(scenario.purpose, name);
  return {
    baseline: inFolder(`${base}-baseline.gpkg`),
    postIntervention: inFolder(`${base}-post-intervention.gpkg`),
    workbook: inFolder(`${base}.xlsx`),
  };
}

/**
 * Light pair check: the derived baseline must have cleared the area layer's
 * proposed state, and both halves must share a redline. The deep guarantees
 * are bng-library's own tests; this catches a broken run early.
 */
function verifyPair(baselineFile, piFile) {
  const baseDb = openGeoPackageReadonly(baselineFile);
  const piDb = openGeoPackageReadonly(piFile);
  try {
    const leftoverProposed = baseDb
      .prepare(
        `SELECT count(*) AS n FROM "Habitats"
           WHERE "Proposed Condition" IS NOT NULL
              OR "Retention Category" IS NOT NULL`,
      )
      .get().n;
    if (leftoverProposed > 0) {
      throw new Error(
        `baseline half still carries proposed data on ${leftoverProposed} habitat row(s)`,
      );
    }
    const redlineSql = `SELECT hex(geometry) AS g FROM "Red Line Boundary"`;
    const baseRlb = baseDb.prepare(redlineSql).get()?.g;
    const piRlb = piDb.prepare(redlineSql).get()?.g;
    if (!baseRlb || baseRlb !== piRlb) {
      throw new Error("baseline and post-intervention redlines differ");
    }
  } finally {
    baseDb.close();
    piDb.close();
  }
}

/**
 * The scenario's subject feature must have landed. A hedgerow or watercourse
 * subject depends on the rejection sampler drawing enough lines, so fail
 * loudly rather than ship a fixture that silently misses its case.
 */
function verifySubject(piFile, subject) {
  const refColumn = refColumnFor(subject.layer);
  const db = openGeoPackageReadonly(piFile);
  try {
    const found = db
      .prepare(
        `SELECT count(*) AS n FROM "${subject.layer}" WHERE "${refColumn}" = ?`,
      )
      .get(subject.ref).n;
    if (found === 0) {
      throw new Error(
        `subject ${subject.layer} "${subject.ref}" is missing — the layer generated too few features`,
      );
    }
  } finally {
    db.close();
  }
}

/** Our engine's view of the net gain, recorded and checked like the rest. */
function priceGain(engine, scenario, piFile) {
  const priced = priceHabitats(engine, piFile);
  const met = meetsNetGain(priced.netGainPercentage);
  const gain = {
    expected: scenario.expectGain,
    percentage: priced.netGainPercentage,
    netUnitChange: priced.netUnitChange,
    baselineUnits: priced.baselineTotal,
    postInterventionUnits: priced.postInterventionTotal,
    met,
    priced: priced.priced,
    skipped: priced.skipped,
  };
  const actual = met ? "met" : "unmet";
  const check = {
    check: "net gain (our engine)",
    expected: scenario.expectGain,
    actual,
    passed: actual === scenario.expectGain,
  };
  return { gain, check };
}

function countRows(rows) {
  return Object.fromEntries(
    Object.entries(rows).map(([sheet, list]) => [sheet, list.length]),
  );
}

/**
 * The workbook lint as a check: the structural faults Excel "repairs" on
 * opening, which LibreOffice and the recalculation read straight past.
 */
function lintCheck(issues) {
  const quoted = issues
    .slice(0, LINT_ISSUES_QUOTED)
    .map((i) => [i.rule, i.part, i.ref].filter(Boolean).join(" "));
  const more =
    issues.length > LINT_ISSUES_QUOTED
      ? `, and ${issues.length - LINT_ISSUES_QUOTED} more`
      : "";
  return {
    check: "workbook opens in Excel without repair (lint)",
    expected: "no issues",
    actual: issues.length
      ? `${issues.length} issue(s): ${quoted.join("; ")}${more}`
      : "no issues",
    passed: issues.length === 0,
  };
}

/**
 * Write a scenario's workbook. The workbook as written — formulas and inputs,
 * no values — is fingerprinted: when the last run saved a recalculated
 * workbook from exactly the same source, that saved workbook is kept as it
 * was instead, and is not recalculated again. LibreOffice does not save the
 * same workbook to the same bytes twice (it orders styles and validations
 * differently from run to run), so this is what keeps a regenerated corpus
 * from rewriting every workbook, and it is faster.
 *
 * @returns {boolean} true when the saved workbook was kept
 */
function writeWorkbook(entry, piFile, outDir, workbook, saved) {
  const { buffer, rows, issues, notes } = workbookFromGeoPackage({
    postInterventionPath: piFile,
    templateBuffer: workbook.template,
    vocabulary: workbook.vocabulary,
  });
  entry.workbookSource = createHash("sha256").update(buffer).digest("hex");
  const prior = saved.get(entry.id);
  const keep = prior?.source === entry.workbookSource;
  writeFileSync(
    path.join(outDir, entry.files.workbook),
    keep ? prior.buffer : buffer,
  );
  entry.inputRows = countRows(rows);
  entry.rejectedInputs = issues.map(({ allowed: _allowed, ...issue }) => issue);
  entry.notes = notes;
  const lint = lintWorkbook(buffer);
  entry.checks.push(lintCheck(lint));
  if (lint.length > 0) {
    entry.lintIssues = lint;
  }
  return keep;
}

function generateScenario(scenario, context) {
  const { outDir, centre, seed, engine, workbook, saved, kept } = context;
  const files = scenarioFiles(scenario);
  if (!workbook) {
    delete files.workbook;
  }
  const piFile = path.join(outDir, files.postIntervention);
  const baselineFile = path.join(outDir, files.baseline);
  mkdirSync(path.dirname(piFile), { recursive: true });

  generateOne(piFile, centre, {
    numParcels: scenario.size ?? PERMUTATION_DEFAULT_SIZE,
    numTrees: scenario.treeCount,
    emptyLayers: new Set(scenario.emptyLayers ?? []),
    attributeOverrides: scenario.overrides ?? {},
    seed: derivePermutationSeed(seed, scenario.id),
  });
  deriveBaselineFromSynthetic(piFile, baselineFile);
  verifyPair(baselineFile, piFile);
  verifySubject(piFile, scenario.subject);

  const entry = {
    id: scenario.id,
    purpose: scenario.purpose,
    title: scenario.title,
    description: scenario.description,
    size: scenario.size ?? PERMUTATION_DEFAULT_SIZE,
    subject: scenario.subject,
    files,
    gain: null,
    checks: [],
  };
  if (scenario.expectGain) {
    const { gain, check } = priceGain(engine, scenario, piFile);
    entry.gain = gain;
    entry.checks.push(check);
  }
  if (workbook && writeWorkbook(entry, piFile, outDir, workbook, saved)) {
    kept.add(entry.id);
  }

  const rejected = entry.rejectedInputs?.length
    ? ` — ${entry.rejectedInputs.length} rejected input(s)`
    : "";
  info(`  ✓ ${scenario.purpose}/${scenario.id}${rejected}`);
  return entry;
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
    corrected: results.corrected,
    sheetWarnings: uniqueSheetWarnings(results.sheetWarnings),
    rowWarnings: groupWarnings(results.rowWarnings),
  };
  entry.checks.push(
    ...checkScenarioExpectations(scenario, results, entry.rejectedInputs),
  );
}

async function recalculateAll(entries, scenarios, { outDir, soffice, kept }) {
  const attach = (entry, results) =>
    attachResults(
      entry,
      scenarios.find((s) => s.id === entry.id),
      results,
    );
  for (const entry of entries.filter((e) => kept.has(e.id))) {
    attach(
      entry,
      readMetricResults(readFileSync(path.join(outDir, entry.files.workbook))),
    );
  }
  if (kept.size > 0) {
    info(`  ${kept.size} workbook(s) unchanged since the last run: kept`);
  }
  const changed = entries.filter((e) => !kept.has(e.id));
  if (changed.length === 0) {
    return;
  }
  // Beside the corpus rather than in the OS temp dir: the workbooks can then
  // be staged as hard links, and a small tmpfs is never filled.
  const workDir = mkdtempSync(path.join(outDir, WORK_PREFIX));
  try {
    // Each workbook is saved over itself with its calculated values in, so
    // the metric's answers can be read straight from it — by a tester opening
    // it, or by the backend's metric comparison — without recalculating.
    const results = await saveRecalculatedWorkbooks(
      changed.map((e) => path.join(outDir, e.files.workbook)),
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
    changed.forEach((entry, i) => attach(entry, results[i]));
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

/**
 * The recalculated workbooks the last run saved, by scenario id, with the
 * fingerprint of the source each was saved from. Read before the output
 * folder is cleared, so an unchanged one can be put back as it was.
 */
function savedWorkbooks(outDir, scenarios) {
  const saved = new Map();
  const previous = readScenarioManifest(outDir);
  if (!previous?.recalculated) {
    return saved;
  }
  const sources = new Map(
    previous.scenarios.map((e) => [e.id, e.workbookSource]),
  );
  for (const scenario of scenarios) {
    const file = path.join(outDir, scenarioFiles(scenario).workbook);
    const source = sources.get(scenario.id);
    if (source && existsSync(file)) {
      saved.set(scenario.id, { source, buffer: readFileSync(file) });
    }
  }
  return saved;
}

function loadTemplate(templatePath) {
  const template = readFileSync(templatePath);
  return { template, vocabulary: readTemplateVocabulary(template) };
}

/**
 * Remove the purpose folders about to be regenerated, so a scenario dropped
 * from the catalogue cannot linger. Nothing else under the output folder is
 * touched.
 */
function clearPurposeFolders(outDir, scenarios) {
  for (const purpose of new Set(scenarios.map((s) => s.purpose))) {
    const purposeDir = path.join(outDir, purpose);
    if (existsSync(purposeDir)) {
      rmSync(purposeDir, { recursive: true, force: true });
    }
  }
}

/**
 * Remove files named relative to the output folder. A name that would
 * resolve outside it is refused, since the names can come from a manifest.
 */
export function removeCorpusFiles(outDir, files) {
  const root = path.resolve(outDir);
  for (const file of files) {
    const target = path.resolve(root, file);
    if (!target.startsWith(`${root}${path.sep}`)) {
      throw new Error(`refusing to remove ${file}: it is outside ${root}`);
    }
    rmSync(target, { force: true });
  }
}

/**
 * A filtered run replaces only the files of the scenarios it builds, so the
 * rest of the corpus survives it. All three names go, whether or not this run
 * writes a workbook.
 */
function clearScenarioFiles(outDir, scenarios) {
  removeCorpusFiles(
    outDir,
    scenarios.flatMap((s) => Object.values(scenarioFiles(s))),
  );
}

function reportFailedChecks(entries) {
  for (const entry of entries) {
    for (const check of entry.checks.filter((c) => !c.passed)) {
      warn(
        `  ${entry.id}: ${check.check} — expected ${check.expected}, got ${check.actual}`,
      );
    }
  }
}

/**
 * @param {object} options
 * @param {object[]} options.scenarios catalogue entries to build
 * @param {string} options.outDir the corpus folder
 * @param {[number, number]} options.centre RLB centre (BNG easting, northing)
 * @param {number} options.seed run seed; each scenario derives its own
 * @param {string} [options.templatePath] the metric workbook to write into;
 *   omit for GeoPackages only
 * @param {boolean} [options.recalculate] run LibreOffice and check the
 *   metric's verdicts (needs a template)
 * @param {string} [options.soffice] LibreOffice binary
 * @param {boolean} [options.partial] a filtered run: replace only these
 *   scenarios' files rather than their whole purpose folders
 * @returns {Promise<object[]>} manifest entries, in catalogue order
 */
export async function buildScenarioCorpus({
  scenarios,
  outDir,
  centre,
  seed,
  templatePath,
  recalculate = false,
  soffice,
  partial = false,
}) {
  const workbook = templatePath ? loadTemplate(templatePath) : null;
  // Only the net-gain scenarios price habitats through the engine.
  const engine = scenarios.some((s) => s.expectGain)
    ? await loadEngine()
    : null;

  mkdirSync(outDir, { recursive: true });
  const saved =
    workbook && recalculate ? savedWorkbooks(outDir, scenarios) : new Map();
  const kept = new Set();
  if (partial) {
    clearScenarioFiles(outDir, scenarios);
  } else {
    clearPurposeFolders(outDir, scenarios);
  }

  // bng-library logs a banner per file; silence it and print our own progress.
  setMode("silent");
  header("Generating scenarios", "cyan");
  info(`  ${scenarios.length} scenario(s), seed ${seed} → ${outDir}`);
  const entries = scenarios.map((scenario) =>
    generateScenario(scenario, {
      outDir,
      centre,
      seed,
      engine,
      workbook,
      saved,
      kept,
    }),
  );
  setMode("cli");

  if (workbook && recalculate) {
    header("Recalculating the workbooks with LibreOffice", "cyan");
    await recalculateAll(entries, scenarios, { outDir, soffice, kept });
  }
  reportFailedChecks(entries);
  return entries;
}
