#!/usr/bin/env node

/**
 * Compare the service's figures with the Statutory Biodiversity Metric's, for
 * every scenario in a folder of scenarios (BMD-1036), and write a report.
 *
 *   npm run compare:metric                         # every committed scenario
 *   npm run compare:metric -- --only trading-rules # a purpose, or scenario ids
 *   npm run compare:metric -- --exclude invalid-interventions # all but these
 *   npm run compare:metric -- --corpus <dir>       # any folder of scenarios
 *   npm run compare:metric -- --service-template   # the BNG Service template's
 *   npm run compare:metric -- --fail-on-unexplained
 *
 * The service is the backend checkout beside this repo (BNG_BACKEND_DIR names
 * another), run in process; see scripts/metric-comparison/backend.mjs.
 *
 * The backend reads one template or the other, as its service-template flag
 * says, so a run compares one: the legacy scenarios by default, with the flag
 * off whatever the shell says, or with --service-template the BNG Service
 * template's (example-files/service-template/permutations by default), with
 * the flag on. A scenario in the other template stops the run.
 *
 * Writes, to metric-comparison/ in this repo (metric-comparison/
 * service-template/ with --service-template, so the two runs' reports sit
 * side by side), report.html (a short, self-contained summary), report.xlsx
 * (every difference at full precision, one row each), report.md, summary.md (the report without each scenario's
 * detail, for a CI job summary) and report.json. The console gets each
 * scenario's outcome as it runs, then every difference figure by figure, so
 * a CI log shows what differed without opening the report.
 *
 * Every report leads with the differences nothing known explains (see
 * scripts/metric-comparison/unexplained.mjs). With --fail-on-unexplained, any
 * such difference also makes this exit non-zero, after the reports are
 * written so they show what failed; a difference that is explained, by
 * something the service does not do yet, never does. Without it, only a
 * comparison that cannot run exits non-zero. CI passes the flag (see
 * .github/workflows/metric-comparison.yml).
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
import { renderDifferences } from "./metric-comparison/differences.mjs";
import {
  DEFAULT_CORPUS_DIR,
  SERVICE_TEMPLATE_CORPUS_DIR,
  runMetricComparison,
} from "./metric-comparison/run-metric-comparison.mjs";
import { SERVICE_TEMPLATE_FLAG } from "./dev-env.mjs";
import {
  comparisonVerdict,
  explanationsFor,
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
    exclude: { type: "string", multiple: true, default: [] },
    corpus: { type: "string" },
    "service-template": { type: "boolean", default: false },
    "fail-on-unexplained": { type: "boolean", default: false },
  },
});
const splitList = (list) => list.flatMap((v) => v.split(",")).filter(Boolean);
const only = splitList(values.only);
const exclude = splitList(values.exclude);
const serviceTemplate = values["service-template"];
const corpusDir = values.corpus
  ? path.resolve(values.corpus)
  : defaultCorpusDir(serviceTemplate);
const outDir = serviceTemplate
  ? path.join(OUT_DIR, "service-template")
  : OUT_DIR;
// Before the backend's config is first imported, which reads it once: the
// flag decides which template the service's format gate lets through.
process.env[SERVICE_TEMPLATE_FLAG] = String(serviceTemplate);

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

function defaultCorpusDir(serviceTemplateOn) {
  return serviceTemplateOn ? SERVICE_TEMPLATE_CORPUS_DIR : DEFAULT_CORPUS_DIR;
}

/** The short commit checked out in `dir`, or "unknown" outside a checkout. */
async function commitOf(dir) {
  const { code, stdout } = await runCapture(
    "git",
    ["rev-parse", `--short=${SHORT_SHA_LENGTH}`, "HEAD"],
    { cwd: dir },
  );
  return code === 0 ? stdout.trim() : "unknown";
}

/**
 * Where the summary should send its reader for the full report. In CI the
 * workflow names the artifact it uploads the reports to, which differs per
 * leg; elsewhere the reports are beside the summary.
 */
function fullReportLocation() {
  const artifact = process.env.METRIC_COMPARISON_ARTIFACT;
  const folder = serviceTemplate ? ", in its `service-template/` folder" : "";
  return artifact
    ? `in this job's \`${artifact}\` artifact${folder}`
    : `beside it in \`${outDir}\``;
}

const templateName = serviceTemplate
  ? `the BNG Service template (${SERVICE_TEMPLATE_FLAG}=true)`
  : `the legacy template (${SERVICE_TEMPLATE_FLAG}=false)`;
const filters = [...only, ...exclude.map((name) => `not ${name}`)];
const onlySuffix = filters.length ? ` (${filters.join(", ")})` : "";
header(`Comparing the service with the metric${onlySuffix}`);
info(`  service:   ${backend}`);
info(`  scenarios: ${corpusDir}`);
info(`  template:  ${templateName}`);

// Every scenario compared, or the reason the run cannot start.
let comparison;
try {
  comparison = await runMetricComparison({
    corpusDir,
    only,
    exclude,
    serviceTemplate,
    onResult: (r) => {
      const discrepancySuffix = r.discrepancies?.length
        ? ` — ${r.discrepancies.length} discrepancies`
        : "";
      console.log(
        `  ${r.outcome.padEnd(OUTCOME_COLUMN_WIDTH)}  ${r.id}${discrepancySuffix}`,
      );
    },
  });
} catch (cause) {
  error(cause.message);
  process.exit(1);
}
const { unmatched, results } = comparison;
for (const workbook of unmatched) {
  warn(`skipped ${workbook}: no GeoPackage pair beside it`);
}

// Both commits from their checkouts. Not the run's sha: when the backend
// calls the workflow, that is the backend's.
const context = [
  `Scenarios from ${corpusDir}, in ${templateName}.`,
  `Generated ${new Date().toISOString()} for backend ${await commitOf(backend)}, harness ${await commitOf(HARNESS_ROOT)}.`,
];

// Each corpus has its own explanation tables: the two share scenario ids.
const { validationGaps, incompleteFeatures } = explanationsFor(serviceTemplate);
const unexplained = findUnexplained(
  results,
  validationGaps,
  incompleteFeatures,
);
const unexplainedReport = renderUnexplained(unexplained);

mkdirSync(outDir, { recursive: true });
const write = (name, content) =>
  writeFileSync(path.join(outDir, name), content);

// A bng-library that predates the verdict option ignores it.
write(
  "report.html",
  renderComparisonHtml(results, {
    context,
    verdict: comparisonVerdict(results, unexplained),
  }),
);
write("report.xlsx", renderComparisonXlsx(results, { context }));
write("report.md", renderComparisonReport(results, { preamble: context }));
write(
  "summary.md",
  renderComparisonReport(results, {
    preamble: [
      ...context,
      `The full report, with every discrepancy, is \`report.html\` (and \`report.xlsx\`) ${fullReportLocation()}.`,
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
// Every difference, figure by figure, so a CI log shows what differed
// without opening the report.
const differences = renderDifferences(
  results,
  unexplained,
  validationGaps,
  incompleteFeatures,
);
if (differences) {
  console.log(`\n${differences}\n`);
}
console.log(
  `${differing} of ${results.length} scenarios differ from the metric${unreadableSuffix}${failedSuffix}. Reports → ${path.join(outDir, "report.html")} and report.xlsx`,
);

for (const id of unexplained.stale) {
  warn(
    `${id} is refused now, so its entry in VALIDATION_GAPS or INCOMPLETE_FEATURES can go`,
  );
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
