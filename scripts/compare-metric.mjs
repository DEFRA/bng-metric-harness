#!/usr/bin/env node

/**
 * Compare the service's figures with the Statutory Biodiversity Metric's, for
 * every scenario in a folder of scenarios (BMD-1036), and write a report.
 *
 *   npm run compare:metric                         # every committed scenario
 *   npm run compare:metric -- --only trading-rules # a purpose, or scenario ids
 *   npm run compare:metric -- --corpus <dir>       # any folder of scenarios
 *   npm run compare:metric -- --fail-on-unexplained
 *
 * The service is the backend checkout beside this repo (BNG_BACKEND_DIR names
 * another), run in process; see scripts/metric-comparison/backend.mjs.
 *
 * Writes, to metric-comparison/ in this repo, report.html (a short,
 * self-contained summary), report.xlsx (every difference at full precision,
 * one row each), report.md, summary.md (the report without each scenario's
 * detail, for a CI job summary) and report.json.
 *
 * Every report leads with the differences nothing known explains (see
 * scripts/metric-comparison/unexplained.mjs). With --fail-on-unexplained, any
 * such difference also makes this exit non-zero, after the reports are
 * written so they show what failed; a difference that is explained, by
 * something the service does not do yet, never does. Without it, only a
 * comparison that cannot run exits non-zero. CI does not pass the flag yet: a
 * follow-up will, once the BMD-1042 pull requests have merged (see the note in
 * .github/workflows/check-pull-request.yml).
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  OUTCOME,
  renderComparisonHtml,
  renderComparisonReport,
  renderComparisonXlsx,
} from "#metric-compare";
import {
  HARNESS_ROOT,
  error,
  header,
  info,
  runCapture,
  warn,
} from "./_lib.mjs";
import {
  BACKEND_DIR_ENV,
  backendDir,
  isBackendInstalled,
} from "./metric-comparison/backend.mjs";
import {
  DEFAULT_CORPUS_DIR,
  runMetricComparison,
} from "./metric-comparison/run-metric-comparison.mjs";
import {
  findUnexplained,
  hasUnexplained,
  renderUnexplained,
} from "./metric-comparison/unexplained.mjs";

const JSON_INDENT = 2;
const SHORT_SHA_LENGTH = 7;
const OUTCOME_COLUMN_WIDTH = "rejected-as-expected".length;
// Fixed rather than a flag: the CI workflow uploads this folder, and nothing
// from the command line reaches the file system.
const OUT_DIR = path.join(HARNESS_ROOT, "metric-comparison");

const { values } = parseArgs({
  options: {
    only: { type: "string", multiple: true, default: [] },
    corpus: { type: "string" },
    "fail-on-unexplained": { type: "boolean", default: false },
  },
});
const only = values.only.flatMap((v) => v.split(",")).filter(Boolean);
const corpusDir = values.corpus
  ? path.resolve(values.corpus)
  : DEFAULT_CORPUS_DIR;

const backend = backendDir();
if (!isBackendInstalled(backend)) {
  error(`No installed backend at ${backend}`);
  info(
    `  → Run \`npm run bootstrap\` and \`npm run install:be\`, or name a checkout in ${BACKEND_DIR_ENV}.`,
  );
  process.exit(1);
}
if (!existsSync(corpusDir)) {
  error(`No scenarios at ${corpusDir}`);
  process.exit(1);
}

/** The backend commit under test, for the report. */
async function backendCommit() {
  const { code, stdout } = await runCapture(
    "git",
    ["rev-parse", `--short=${SHORT_SHA_LENGTH}`, "HEAD"],
    { cwd: backend },
  );
  return code === 0 ? stdout.trim() : "unknown";
}

const onlySuffix = only.length ? ` (${only.join(", ")})` : "";
header(`Comparing the service with the metric${onlySuffix}`);
info(`  service:   ${backend}`);
info(`  scenarios: ${corpusDir}`);

const { unmatched, results } = await runMetricComparison({
  corpusDir,
  only,
  onResult: (r) => {
    const discrepancySuffix = r.discrepancies?.length
      ? ` — ${r.discrepancies.length} discrepancies`
      : "";
    console.log(
      `  ${r.outcome.padEnd(OUTCOME_COLUMN_WIDTH)}  ${r.id}${discrepancySuffix}`,
    );
  },
});
for (const workbook of unmatched) {
  warn(`skipped ${workbook}: no GeoPackage pair beside it`);
}

const harnessCommit = process.env.GITHUB_SHA?.slice(0, SHORT_SHA_LENGTH);
const harnessSuffix = harnessCommit ? `, harness ${harnessCommit}` : "";
const context = [
  `Scenarios from ${corpusDir}.`,
  `Generated ${new Date().toISOString()} for backend ${await backendCommit()}${harnessSuffix}.`,
];

const unexplained = findUnexplained(results);
const unexplainedReport = renderUnexplained(unexplained);

mkdirSync(OUT_DIR, { recursive: true });
const write = (name, content) =>
  writeFileSync(path.join(OUT_DIR, name), content);

write("report.html", renderComparisonHtml(results, { context }));
write("report.xlsx", renderComparisonXlsx(results, { context }));
write("report.md", renderComparisonReport(results, { preamble: context }));
write(
  "summary.md",
  renderComparisonReport(results, {
    preamble: [
      ...context,
      "The full report, with every discrepancy, is `report.html` (and `report.xlsx`) in the `metric-comparison` artifact.",
      unexplainedReport,
    ].filter(Boolean),
    details: false,
  }),
);
write(
  "report.json",
  `${JSON.stringify({ corpusDir, unmatched, results }, null, JSON_INDENT)}\n`,
);

const differing = results.filter((r) => r.discrepancies?.length).length;
const unreadable = results.filter(
  (r) => r.outcome === OUTCOME.workbookUnreadable,
).length;
const unreadableSuffix = unreadable
  ? `; ${unreadable} workbook(s) could not be read, so were not compared`
  : "";
const failed = results.filter((r) => r.outcome === OUTCOME.importFailed);
for (const r of failed) {
  warn(`the service failed to import ${r.id}: ${r.errors[0].message}`);
}
const failedSuffix = failed.length
  ? `; the service failed to import ${failed.length}, so they were not compared`
  : "";
console.log(
  `${differing} of ${results.length} scenarios differ from the metric${unreadableSuffix}${failedSuffix}. Reports → ${path.join(OUT_DIR, "report.html")} and report.xlsx`,
);

for (const id of unexplained.stale) {
  warn(`${id} is refused now, so its entry in VALIDATION_GAPS can go`);
}
if (hasUnexplained(unexplained)) {
  const count = unexplained.scenarios.length + unexplained.discrepancies.length;
  const report = values["fail-on-unexplained"] ? error : warn;
  report(`${count} difference(s) from the metric have no known explanation:`);
  console.log(renderUnexplained({ ...unexplained, stale: [] }));
  if (values["fail-on-unexplained"]) {
    process.exit(1);
  }
} else {
  info("Every difference from the metric has a known explanation.");
}
