#!/usr/bin/env node

/**
 * Generate the BNG scenario corpus: every scenario in the bng-library
 * catalogue as a baseline / post-intervention GeoPackage pair and, by
 * default, the Statutory Biodiversity Metric workbook written from it,
 * recalculated with LibreOffice so manifest.json records the metric's own
 * results to compare a service run against.
 *
 *   --no-workbooks   GeoPackages only: no template, no LibreOffice.
 *   --no-recalc      write the workbooks but don't recalculate them.
 *
 * A filtered run (--only / --scenario) replaces only its own scenarios'
 * files and merges them into the manifest already in the output folder.
 *
 * The template defaults to the calculation tool Defra publishes, downloaded
 * once and cached; --template or METRIC_TEMPLATE names another.
 */

// First, so a broken scenario catalogue is reported plainly (see the module).
import "./scenarios/catalogue-errors.mjs";
import { existsSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { randomInt } from "node:crypto";
import { PERMUTATION_PURPOSES, PERMUTATION_SCENARIOS } from "#bng-lib";
import { isLibreOfficeAvailable } from "#workbook-writer";
import {
  HARNESS_ROOT,
  error,
  header,
  info,
  resolveInsideHarness,
  warn,
} from "./_lib.mjs";
import { DEFAULT_CENTRE, parseCentre } from "./centre.mjs";
import {
  buildScenarioCorpus,
  removeCorpusFiles,
} from "./scenarios/runner.mjs";
import {
  corpusConflicts,
  mergeScenarioEntries,
  readScenarioManifest,
  writeScenarioManifest,
} from "./scenarios/manifest.mjs";
import {
  ensurePublishedTemplate,
  resolveTemplate,
} from "./scenarios/template.mjs";

// Seeds are 32-bit, as bng-library's generator takes them.
const SEED_BITS = 31;
const MAX_SEED = 2 ** SEED_BITS;
// Wide enough for the longest scenario id in the catalogue, so titles align.
const CATALOGUE_ID_COLUMN_WIDTH = 46;

const USAGE = `
Usage: npm run generate:scenarios -- [options]

  --only PURPOSE    Build one purpose only (${PERMUTATION_PURPOSES.join(", ")}).
  --scenario ID     Build one scenario only (repeatable).
                    A filtered run replaces only those scenarios' files and
                    merges them into the existing manifest, reusing its seed.
  --outdir DIR      Output folder (default: <harness>/test-data/scenarios).
                    Files are organised one folder per purpose.
  --seed N          Run seed, for byte-reproducible GeoPackages (default:
                    random, recorded in the manifest; a filtered run
                    defaults to the existing corpus's seed).
  --centre E,N      Red Line Boundary centre, BNG/EPSG:27700 (default
                    ${DEFAULT_CENTRE.join(",")}).
  --no-workbooks    GeoPackages only: no metric workbooks, no LibreOffice.
  --no-recalc       Write the workbooks without recalculating them. Excel
                    recalculates on open; manifest.json then has no metric
                    results.
  --template PATH   Statutory Biodiversity Metric workbook to write into
                    (default: $METRIC_TEMPLATE, else the published tool,
                    downloaded once from GOV.UK and cached).
  --download-template
                    Download the published template into the cache and exit.
  --list            Print the catalogue and exit.
  -h, --help        Show this help.

Refresh the committed fixtures in example-files/permutations with:
  npm run generate:scenarios -- --outdir example-files/permutations --seed 1
`;

const { values: args } = parseArgs({
  options: {
    only: { type: "string", default: "" },
    scenario: { type: "string", multiple: true, default: [] },
    outdir: { type: "string", default: "" },
    seed: { type: "string", default: "" },
    centre: { type: "string", default: "" },
    "no-workbooks": { type: "boolean", default: false },
    "no-recalc": { type: "boolean", default: false },
    template: { type: "string", default: process.env.METRIC_TEMPLATE ?? "" },
    "download-template": { type: "boolean", default: false },
    list: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: false,
});

function selectScenarios() {
  if (args.only && !PERMUTATION_PURPOSES.includes(args.only)) {
    error(
      `Unknown purpose "${args.only}". Known: ${PERMUTATION_PURPOSES.join(", ")}`,
    );
    process.exit(1);
  }
  let selected = PERMUTATION_SCENARIOS;
  if (args.only) {
    selected = selected.filter((s) => s.purpose === args.only);
  }
  if (args.scenario.length > 0) {
    const wanted = new Set(args.scenario);
    selected = selected.filter((s) => wanted.has(s.id));
  }
  return selected;
}

function listCatalogue(scenarios) {
  header("Scenario catalogue", "cyan");
  const purposes = [...new Set(scenarios.map((s) => s.purpose))];
  for (const purpose of purposes) {
    info(`\n${purpose}`);
    for (const s of scenarios.filter((x) => x.purpose === purpose)) {
      info(`  ${s.id.padEnd(CATALOGUE_ID_COLUMN_WIDTH)} ${s.title}`);
    }
  }
  info(
    `\n${scenarios.length} scenarios across ${purposes.length} purposes.`,
  );
}

function isFiltered() {
  return Boolean(args.only) || args.scenario.length > 0;
}

function resolveSeed(previous) {
  if (!args.seed) {
    return previous ? previous.seed : randomInt(MAX_SEED);
  }
  const seed = Number(args.seed);
  if (!Number.isInteger(seed)) {
    error(`--seed must be an integer (got: ${args.seed})`);
    process.exit(1);
  }
  return seed;
}

/** The template to write into, or null for GeoPackages only. */
async function templateOrExit() {
  if (args["no-workbooks"]) {
    return null;
  }
  let template = null;
  try {
    template = await resolveTemplate(args.template);
  } catch (err) {
    error(err.message);
    process.exit(1);
  }
  if (!existsSync(template.path)) {
    error(`Metric template not found: ${template.path}`);
    process.exit(1);
  }
  info(`  template: ${path.basename(template.path)} (${template.source})`);
  return template.path;
}

function assertLibreOffice(recalculate) {
  if (recalculate && !isLibreOfficeAvailable()) {
    error(
      "LibreOffice is needed to recalculate the workbooks (install libreoffice-calc, or set SOFFICE_PATH). " +
        "Use --no-recalc to write them without results, --no-workbooks for GeoPackages only, " +
        "or npm run generate:scenarios:docker to run it all in a container.",
    );
    process.exit(1);
  }
}

function outDirOrExit() {
  if (!args.outdir) {
    return path.resolve(HARNESS_ROOT, "test-data", "scenarios");
  }
  let outDir = null;
  try {
    outDir = resolveInsideHarness(args.outdir, "--outdir");
  } catch (err) {
    error(err.message);
    process.exit(1);
  }
  return outDir;
}

/**
 * The corpus a filtered run merges into, or null when there is none to keep.
 * Exits if the manifest is unreadable, rather than overwrite it.
 */
function previousCorpusOrExit(outDir) {
  if (!isFiltered()) {
    return null;
  }
  let previous = null;
  try {
    previous = readScenarioManifest(outDir);
  } catch (err) {
    error(`Cannot read the existing manifest in ${outDir}: ${err.message}`);
    error(
      "Run without --only / --scenario to regenerate it, or use a fresh --outdir.",
    );
    process.exit(1);
  }
  return previous;
}

/** Refuse a filtered run that would leave a manifest no single run made. */
function assertFitsCorpus(previous, run, outDir) {
  const conflicts = corpusConflicts(previous, run);
  if (conflicts.length === 0) {
    return;
  }
  error(`This filtered run cannot be merged into the corpus in ${outDir}:`);
  for (const conflict of conflicts) {
    error(`  - this run has ${conflict}`);
  }
  error(
    "Run without --only / --scenario to regenerate the corpus, or use a fresh --outdir.",
  );
  process.exit(1);
}

/** The manifest entries to write: this run's, merged into the corpus's. */
function corpusEntries(previous, entries, outDir) {
  if (!previous) {
    return entries;
  }
  const merged = mergeScenarioEntries(
    previous.scenarios,
    entries,
    PERMUTATION_SCENARIOS.map((s) => s.id),
  );
  for (const entry of merged.dropped) {
    warn(`  removing ${entry.id}: no longer in the catalogue`);
    removeCorpusFiles(outDir, Object.values(entry.files));
  }
  info(
    `  merged ${entries.length} scenario(s) into the corpus (${merged.entries.length} in all)`,
  );
  return merged.entries;
}

async function main() {
  if (args.help) {
    console.log(USAGE);
    return;
  }
  if (args["download-template"]) {
    info(`  template → ${await ensurePublishedTemplate()}`);
    return;
  }
  const scenarios = selectScenarios();
  if (scenarios.length === 0) {
    error("No scenarios match the --only / --scenario filters.");
    process.exit(1);
  }
  if (args.list) {
    listCatalogue(scenarios);
    return;
  }

  const templatePath = await templateOrExit();
  const recalculate = Boolean(templatePath) && !args["no-recalc"];
  assertLibreOffice(recalculate);

  const outDir = outDirOrExit();
  const previous = previousCorpusOrExit(outDir);
  const seed = resolveSeed(previous);
  if (previous) {
    assertFitsCorpus(previous, { seed, templatePath, recalculate }, outDir);
  }
  const entries = await buildScenarioCorpus({
    scenarios,
    outDir,
    centre: parseCentre(args.centre) ?? DEFAULT_CENTRE,
    seed,
    templatePath,
    recalculate,
    partial: isFiltered(),
  });
  const { indexPath } = writeScenarioManifest(outDir, {
    entries: corpusEntries(previous, entries, outDir),
    seed,
    templatePath,
  });
  info(`\n  index → ${indexPath}`);

  const failed = entries.filter((e) => e.checks.some((c) => !c.passed));
  if (failed.length > 0) {
    error(
      `${failed.length} scenario(s) did not meet their expectations: ${failed.map((e) => e.id).join(", ")}`,
    );
    process.exit(1);
  }
}

await main();
