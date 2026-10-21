/**
 * Write example-files/service-template/README.md from the recipes, so the
 * list of fixtures, what each covers and how it is built can never drift
 * from what the generator does.
 */

import { STAGE_BASELINE } from "#bng-lib";
import {
  FAMILIES,
  GAPS,
  KIND_COPIED,
  KIND_DERIVED,
  RECIPES,
} from "./recipes.mjs";

const COMMAND = "npm run generate:service-template";

function generatedFrom({ options }) {
  const parts = [`seed ${options.seed}`];
  if (options.numParcels) {
    parts.push(`${options.numParcels} parcels`);
  }
  if (options.stage === STAGE_BASELINE) {
    parts.push("baseline stage");
  }
  if (options.templateFeatures === false) {
    parts.push("no template-only features");
  }
  for (const flaw of options.flaws ?? []) {
    parts.push(`flaw \`${flaw}\``);
  }
  return parts.join(", ");
}

function builtFrom(recipe) {
  if (recipe.kind === KIND_COPIED) {
    return `copy of \`${recipe.source}\``;
  }
  if (recipe.kind === KIND_DERIVED) {
    return recipe.edits.length > 0
      ? `\`${recipe.from}\`, edited by SQL`
      : `copy of \`${recipe.from}\``;
  }
  return generatedFrom(recipe);
}

const fileName = (recipePath) => recipePath.slice(recipePath.indexOf("/") + 1);

function familySection({ dir, covers }) {
  const rows = RECIPES.filter((r) => r.path.startsWith(`${dir}/`)).map(
    (r) =>
      `| \`${fileName(r.path)}\` | ${r.covers} | ${r.expected} | ${builtFrom(r)} |`,
  );
  return [
    `## ${dir}/`,
    "",
    `${covers}.`,
    "",
    "| File | Covers | Expected | Built from |",
    "| ---- | ------ | -------- | ---------- |",
    ...rows,
    "",
  ].join("\n");
}

/** The README's Markdown. */
export function renderReadme() {
  return [
    "# BNG Service template corpus",
    "",
    "<!-- Written by `npm run generate:service-template` from scripts/service-template/recipes.mjs. Edit the recipes, not this file. -->",
    "",
    "Fixtures in the **BNG Service template** format (BMD-1081): one GeoPackage",
    "holding both stages, with the lineage that links each post-intervention",
    "feature to its baseline parent, and the template version record. They",
    "mirror the legacy corpus's families in `example-files/`, kept apart from it.",
    "",
    "A file named `…-baseline.gpkg` is a **baseline-stage** file: its",
    "post-intervention tables are present and empty. Every other file holds both",
    "stages. **Expected** is the outcome the service should give the file with the",
    "service-template flag on (`SERVICE_TEMPLATE_ENABLED=true`); an error code is",
    "the one the legacy upload gives the same fault.",
    "",
    "Every file regenerates to the same bytes:",
    "",
    "```sh",
    `${COMMAND}                                   # every family`,
    `${COMMAND} -- --only lineage-problems        # one family`,
    `${COMMAND} -- --only valid/default-site.gpkg # one file`,
    "```",
    "",
    "A test (`tests/scripts/service-template/corpus.test.mjs`) rebuilds the",
    "whole corpus and compares it with these files byte for byte, but for the",
    "SQLite version each GeoPackage's header records. A bng-library repin that",
    "changes a fixture, or a SQLite (better-sqlite3) upgrade that changes how",
    "files are laid out, fails it until the corpus is regenerated and committed.",
    "",
    "**Expected** is the outcome BMD-1081 asks for. Where the service does not",
    "give it yet, the cell says what it does today, so a tester can tell a gap",
    "in the service from a failure.",
    "",
    "`npm run check:lineage -- --dir example-files/service-template` passes every",
    "file but `malformed/not-a-geopackage.gpkg`, which it reports as unreadable,",
    "as it should, and the legacy-layout file, which it skips. Each",
    "`lineage-problems/` file reports exactly the flaw its name gives.",
    "",
    "## permutations/",
    "",
    "The scenario corpus, one file per scenario with its baseline-stage file and",
    "its metric workbook, built by `npm run generate:scenarios -- --format",
    "bng-service` rather than from these recipes. See `permutations/index.md`",
    "and `docs/generate-scenarios.md`.",
    "",
    ...FAMILIES.map(familySection),
    "## Gaps",
    "",
    ...GAPS.map((gap) => `- ${gap}`),
    "",
  ].join("\n");
}
