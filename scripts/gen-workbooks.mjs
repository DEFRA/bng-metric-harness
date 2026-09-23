#!/usr/bin/env node

/**
 * Generate the synthetic metric workbook corpus (BMD-1011).
 *
 * Every scenario in the bng-library permutations catalogue becomes three
 * files in one folder: a baseline GeoPackage, a post-intervention GeoPackage,
 * and the Statutory Biodiversity Metric workbook written from them. The
 * workbook is recalculated headlessly with LibreOffice and its answers — the
 * metric's own — are recorded in manifest.json, ready to compare a service
 * run against. index.md summarises them.
 *
 * The template defaults to the calculation tool Defra publishes, downloaded
 * once and cached; --template or METRIC_TEMPLATE names another. Needs
 * LibreOffice (soffice on PATH or SOFFICE_PATH) unless --no-recalc.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { randomInt } from "node:crypto";
import { PERMUTATION_PURPOSES, PERMUTATION_SCENARIOS } from "#bng-lib";
import { isLibreOfficeAvailable } from "#workbook-writer";
import { HARNESS_ROOT, error, header, info } from "./_lib.mjs";
import { buildWorkbookCorpus } from "./workbooks/runner.mjs";
import { writeWorkbookManifest } from "./workbooks/manifest.mjs";
import {
  ensurePublishedTemplate,
  resolveTemplate,
} from "./workbooks/template.mjs";

// Seeds are 32-bit, as bng-library's generator takes them.
const MAX_SEED = 2 ** 31;

const USAGE = `
Usage: npm run generate:workbooks -- [options]

  --template PATH   Statutory Biodiversity Metric workbook to write into
                    (default: $METRIC_TEMPLATE, else the published tool,
                    downloaded once from GOV.UK and cached). Any rows it
                    already holds are cleared; its formulas are never changed.
  --outdir DIR      Output folder (default: <harness>/test-data/workbooks).
  --only PURPOSE    Build one purpose only (${PERMUTATION_PURPOSES.join(", ")}).
  --scenario ID     Build one scenario only (repeatable).
  --seed N          Run seed, for byte-reproducible GeoPackages (default:
                    random, recorded in the manifest).
  --no-recalc       Write the workbooks without recalculating them. Excel
                    recalculates on open; manifest.json then has no results.
  --list            Print the catalogue and exit.
  --download-template
                    Download the published template into the cache and exit.
  -h, --help        Show this help.
`;

const { values: args } = parseArgs({
  options: {
    template: { type: "string", default: process.env.METRIC_TEMPLATE ?? "" },
    outdir: { type: "string", default: "" },
    only: { type: "string", default: "" },
    scenario: { type: "string", multiple: true, default: [] },
    seed: { type: "string", default: "" },
    "no-recalc": { type: "boolean", default: false },
    list: { type: "boolean", default: false },
    "download-template": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: false,
});

function selectScenarios() {
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
  header("Metric workbook scenarios", "cyan");
  for (const s of scenarios) {
    info(`  ${s.purpose.padEnd(24)} ${s.id} — ${s.title}`);
  }
}

function resolveSeed() {
  if (!args.seed) {
    return randomInt(MAX_SEED);
  }
  const seed = Number(args.seed);
  if (!Number.isInteger(seed)) {
    error(`--seed must be an integer (got: ${args.seed})`);
    process.exit(1);
  }
  return seed;
}

async function templateOrExit() {
  const template = await resolveTemplate(args.template);
  if (!existsSync(template.path)) {
    error(`Metric template not found: ${template.path}`);
    process.exit(1);
  }
  return template;
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

  const template = await templateOrExit();
  const templatePath = template.path;
  info(`  template: ${path.basename(templatePath)} (${template.source})`);
  const recalculate = !args["no-recalc"];
  if (recalculate && !isLibreOfficeAvailable()) {
    error(
      "LibreOffice is needed to recalculate the workbooks (install libreoffice-calc, or set SOFFICE_PATH). Use --no-recalc to write them without results.",
    );
    process.exit(1);
  }

  const outDir = args.outdir
    ? path.resolve(args.outdir)
    : path.resolve(HARNESS_ROOT, "test-data", "workbooks");
  const seed = resolveSeed();
  const entries = await buildWorkbookCorpus({
    scenarios,
    outDir,
    templatePath,
    seed,
    recalculate,
  });
  const { indexPath } = writeWorkbookManifest(outDir, {
    entries,
    seed,
    templatePath,
  });
  info(`\n  index → ${indexPath}`);

  const failed = entries.filter((e) => e.checks?.some((c) => !c.passed));
  if (failed.length > 0) {
    error(
      `${failed.length} scenario(s) did not meet their expectations: ${failed.map((e) => e.id).join(", ")}`,
    );
    process.exit(1);
  }
}

await main();
