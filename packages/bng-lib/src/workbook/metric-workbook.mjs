/**
 * Reader for filled-in Defra Statutory Biodiversity Metric workbooks
 * (the "BNG500" corpus and similar). Targets Metric v4 layout — sheets
 * named "A-1 On-Site Habitat Baseline", "A-2 On-Site Habitat Creation",
 * etc. Older v3.x layouts are detected and rejected with a clear error.
 *
 * Usage:
 *   import { readMetricWorkbook } from "./lib/metric-workbook.mjs";
 *   const wb = readMetricWorkbook("path/to/file.xlsx");
 *   // wb = { siteInfo, version, habitats: { baseline, created, enhancements },
 *   //        hedgerows: { baseline, created, enhancements },
 *   //        watercourses: { baseline, created, enhancements },
 *   //        trees: { baseline, created }, summary }
 *
 * The reader is tolerant: it skips rows it can't understand, logs them in
 * `summary.skipped`, and never throws on a bad row.
 *
 * This file is the orchestrator. Per-sheet readers live in:
 *   - lib/metric-workbook-helpers.mjs   — header + value parsers, sheet names
 *   - lib/metric-workbook-habitats.mjs  — Start / A-1 / A-2 / A-3 readers
 *   - lib/metric-workbook-linear.mjs    — B-1 / B-2 / B-3 / C-1 / C-2 / C-3
 */

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const XLSX = require("xlsx");

import { SHEETS } from "./metric-workbook-helpers.mjs";
import {
  readBaselineHabitats,
  readCreatedHabitats,
  readEnhancementMappings,
  readSiteInfo,
} from "./metric-workbook-habitats.mjs";
import {
  readLinearEnhancements,
  readLinearFeatures,
} from "./metric-workbook-linear.mjs";

const METRIC_V4 = "4.0";
const METRIC_UNKNOWN = "unknown";

/**
 * Detect which version of the metric template the workbook uses. Currently
 * we recognise v4 by the presence of the v4 sheet names; anything else is
 * "unknown" and the caller should bail out.
 */
export function detectMetricVersion(workbook) {
  const names = new Set(workbook.SheetNames);
  if (names.has(SHEETS.habitatsBaseline) && names.has(SHEETS.habitatsCreation)) {
    return METRIC_V4;
  }
  return METRIC_UNKNOWN;
}

/**
 * Read a metric workbook from disk and return a normalised object suitable
 * for driving the GeoPackage generator.
 */
export function readMetricWorkbook(filePath) {
  const workbook = XLSX.readFile(filePath, { cellDates: true, cellNF: false });
  return normaliseWorkbook(workbook, filePath);
}

/**
 * Same as readMetricWorkbook but reads from an in-memory buffer. Used by the
 * web form path so the workbook never has to touch disk.
 */
export function readMetricWorkbookFromBuffer(buffer, sourceLabel = "<buffer>") {
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true, cellNF: false });
  return normaliseWorkbook(workbook, sourceLabel);
}

function normaliseWorkbook(workbook, sourceLabel) {
  const version = detectMetricVersion(workbook);
  if (version === METRIC_UNKNOWN) {
    throw new Error(
      `Unrecognised metric workbook layout in ${sourceLabel}. ` +
        "Expected sheets like 'A-1 On-Site Habitat Baseline'. " +
        "v3.x and other older layouts are not supported.",
    );
  }

  const summary = { warnings: [], skipped: [] };
  const siteInfo = readSiteInfo(workbook);
  const baselineHabitats = readBaselineHabitats(workbook, summary);
  const createdHabitats = readCreatedHabitats(workbook, summary);
  const enhancements = readEnhancementMappings(workbook, summary);

  // Split out individual-tree rows; they belong on the Urban Trees layer,
  // not Habitats. Hedge/river sheets have their own dedicated layers.
  const trees = {
    baseline: baselineHabitats.filter((h) => h.isIndividualTree),
    created: createdHabitats.filter((h) => h.isIndividualTree),
  };
  const habitats = {
    baseline: baselineHabitats.filter((h) => !h.isIndividualTree),
    created: createdHabitats.filter((h) => !h.isIndividualTree),
    enhancements,
  };

  const hedgerows = {
    baseline: readLinearFeatures(workbook, SHEETS.hedgesBaseline, "hedge", summary, { withFate: true }),
    created: readLinearFeatures(workbook, SHEETS.hedgesCreation, "hedge", summary),
    enhancements: readLinearEnhancements(workbook, SHEETS.hedgesEnhancement, summary),
  };
  const watercourses = {
    baseline: readLinearFeatures(workbook, SHEETS.watercoursesBaseline, "river", summary, { withFate: true }),
    created: readLinearFeatures(workbook, SHEETS.watercoursesCreation, "river", summary),
    enhancements: readLinearEnhancements(workbook, SHEETS.watercoursesEnhancement, summary),
  };

  return { siteInfo, version, habitats, hedgerows, watercourses, trees, summary };
}

// ---------------------------------------------------------------------------
// Direct invocation: print a JSON summary of a workbook without writing any
// GeoPackage. Run `node packages/bng-lib/src/workbook/metric-workbook.mjs <file>`.
// ---------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: node packages/bng-lib/src/workbook/metric-workbook.mjs <workbook.xlsx>");
    process.exit(1);
  }
  const wb = readMetricWorkbook(file);
  const tally = {
    version: wb.version,
    siteInfo: wb.siteInfo,
    counts: {
      habitats: {
        baseline: wb.habitats.baseline.length,
        created: wb.habitats.created.length,
        enhancements: wb.habitats.enhancements.length,
      },
      hedgerows: {
        baseline: wb.hedgerows.baseline.length,
        created: wb.hedgerows.created.length,
        enhancements: wb.hedgerows.enhancements.length,
      },
      watercourses: {
        baseline: wb.watercourses.baseline.length,
        created: wb.watercourses.created.length,
        enhancements: wb.watercourses.enhancements.length,
      },
      trees: {
        baseline: wb.trees.baseline.length,
        created: wb.trees.created.length,
      },
    },
    summary: wb.summary,
  };
  console.log(JSON.stringify(tally, null, 2));
}
