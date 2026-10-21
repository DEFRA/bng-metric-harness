#!/usr/bin/env node

/**
 * Build the curated BNG Service template corpus in
 * example-files/service-template/ (BMD-1081) from its recipes
 * (scripts/service-template/recipes.mjs), and write its README.
 *
 *   npm run generate:service-template
 *   npm run generate:service-template -- --only lineage-problems
 *   npm run generate:service-template -- --only valid/default-site.gpkg
 *
 * Every fixture has a fixed name and regenerates to the same bytes. A full
 * run also removes files no recipe builds any more. The scenario corpus in
 * service-template/permutations/ is generate:scenarios' own, and untouched.
 */

import { writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  HARNESS_ROOT,
  error,
  header,
  info,
  resolveInsideHarness,
  warn,
} from "./_lib.mjs";
import { buildRecipe, removeStaleFiles } from "./service-template/build.mjs";
import { renderReadme } from "./service-template/readme.mjs";
import { FAMILIES, RECIPES } from "./service-template/recipes.mjs";

const DEFAULT_OUTDIR = path.join(
  HARNESS_ROOT,
  "example-files",
  "service-template",
);

const USAGE = `
Usage: npm run generate:service-template -- [options]

  --only NAME     Build one family (e.g. lineage-problems) or one file
                  (e.g. valid/default-site.gpkg). Repeatable.
  --outdir DIR    Output folder (default: example-files/service-template).
  --list          Print the recipes and exit.
  -h, --help      Show this help.
`;

const { values: args } = parseArgs({
  options: {
    only: { type: "string", multiple: true, default: [] },
    outdir: { type: "string", default: "" },
    list: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: false,
});

const matches = (recipe, name) =>
  recipe.path === name || recipe.path.startsWith(`${name}/`);

/** The recipes --only names, or every recipe. Exits on a name none match. */
function selectedRecipes() {
  if (args.only.length === 0) {
    return RECIPES;
  }
  const unknown = args.only.filter(
    (name) => !RECIPES.some((recipe) => matches(recipe, name)),
  );
  if (unknown.length > 0) {
    error(`No family or file named: ${unknown.join(", ")}`);
    error(`Families: ${FAMILIES.map((f) => f.dir).join(", ")}`);
    process.exit(1);
  }
  return RECIPES.filter((recipe) =>
    args.only.some((name) => matches(recipe, name)),
  );
}

function outDirOrExit() {
  if (!args.outdir) {
    return DEFAULT_OUTDIR;
  }
  try {
    return resolveInsideHarness(args.outdir, "--outdir");
  } catch (err) {
    error(err.message);
    process.exit(1);
  }
}

function listRecipes(recipes) {
  header("BNG Service template recipes", "cyan");
  for (const recipe of recipes) {
    info(`  ${recipe.kind.padEnd(10)} ${recipe.path}`);
  }
  info(`\n${recipes.length} fixture(s).`);
}

function main() {
  if (args.help) {
    console.log(USAGE);
    return;
  }
  const recipes = selectedRecipes();
  if (args.list) {
    listRecipes(recipes);
    return;
  }
  const outDir = outDirOrExit();
  header(`generate:service-template: ${recipes.length} fixture(s)`, "cyan");
  info(`  → ${outDir}`);
  if (args.only.length === 0) {
    for (const stale of removeStaleFiles(outDir)) {
      warn(`  removed ${stale}: no recipe builds it`);
    }
  }
  for (const recipe of recipes) {
    buildRecipe(recipe, outDir);
    info(`  ✔ ${recipe.path} (${recipe.kind})`);
  }
  const readme = path.join(outDir, "README.md");
  writeFileSync(readme, renderReadme());
  info(`\n  README → ${readme}`);
}

main();
