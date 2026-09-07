/**
 * Store perf-run samples and build the HTML report.
 *
 * `fetch-perf-results.mjs` calls into this after a download, so the normal path
 * is fetch → store → analyse → report with no extra step. It is also a CLI in
 * its own right, because once the samples are in SQLite the analysis is worth
 * re-running without re-fetching: a new baseline arrives, or the report itself
 * gains a section.
 *
 *   node scripts/perf-report.mjs                      # report the newest stored run
 *   node scripts/perf-report.mjs --run-id <uuid>      # a specific stored run
 *   node scripts/perf-report.mjs --all                # rebuild every report
 *   node scripts/perf-report.mjs --list               # what is in the store
 *   node scripts/perf-report.mjs --ingest <csv> ...   # add a CSV fetched elsewhere
 */
import { readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  openStore,
  ingestRun,
  parseJmeterCsv,
  listRuns,
  getRun,
  previousRun,
} from "./_perf-store.mjs";
import { analyseRun, labelHistory } from "./_perf-analysis.mjs";
import { renderReport, escapeHtml } from "./_perf-html.mjs";

const harnessRoot = path.resolve(import.meta.dirname, "..");
export const RESULTS_ROOT = path.join(harnessRoot, "perf-results");
export const DB_PATH = path.join(RESULTS_ROOT, "perf-runs.db");
export const REPORT_DIR = path.join(RESULTS_ROOT, "reports");

// Labels worth charting a trend for. More than this and the history table stops
// being readable; they are picked slowest-first, which is where drift matters.
const HISTORY_LABEL_LIMIT = 40;

// Enough run id to identify a report at a glance and stay unique in the folder;
// the full id is in the report body and the index.
const SHORT_ID_LENGTH = 8;

const MONTHS = {
  jan: "01",
  feb: "02",
  mar: "03",
  apr: "04",
  may: "05",
  jun: "06",
  jul: "07",
  aug: "08",
  sep: "09",
  oct: "10",
  nov: "11",
  dec: "12",
};

// "7th Sep 2026 at 16:45:38" — the portal's own rendering of the start time.
const PORTAL_DATE =
  /(\d{1,2})\w*\s+(\w{3})\w*\s+(\d{4})\s+at\s+(\d{2}):(\d{2}):(\d{2})/i;

/**
 * A sortable stamp for the run's start time.
 *
 * Prefers the portal's displayed start time, so a filename can be matched
 * against the CDP run table by eye. Falls back to the first sample's timestamp
 * (in UTC) when that string is missing or in a format this does not know —
 * which is still sortable, just possibly an hour off the portal's local time.
 */
export function startedStamp(run) {
  const match = PORTAL_DATE.exec(run.started ?? "");
  if (match) {
    const [, day, month, year, hour, minute, second] = match;
    const mm = MONTHS[month.toLowerCase()];
    if (mm) {
      return `${year}${mm}${day.padStart(2, "0")}-${hour}${minute}${second}`;
    }
  }
  if (run.started_ms) {
    return new Date(run.started_ms)
      .toISOString()
      .replaceAll(/[-:]/g, "")
      .replace("T", "-")
      .slice(0, 15);
  }
  return "unknown-time";
}

/** Reports are named so `ls` orders them chronologically. */
export function reportFileName(run) {
  return `${startedStamp(run)}-${run.run_id.slice(0, SHORT_ID_LENGTH)}.html`;
}

/**
 * Drop any earlier report for this run under a different name, so renaming the
 * scheme does not leave the folder holding two copies of the same run.
 */
async function removeStaleReports(outDir, run, keep) {
  const shortId = run.run_id.slice(0, SHORT_ID_LENGTH);
  const existing = await readdir(outDir).catch(() => []);
  await Promise.all(
    existing
      .filter(
        (name) =>
          name !== keep &&
          name.endsWith(".html") &&
          (name === `${run.run_id}.html` || name.includes(shortId)),
      )
      .map((name) => rm(path.join(outDir, name), { force: true })),
  );
}

/** Read a JMeter CSV off disk and store it against `run`. */
export async function ingestCsv(db, run, csvPath) {
  const samples = parseJmeterCsv(await readFile(csvPath, "utf8"));
  ingestRun(db, { ...run, csvName: path.basename(csvPath) }, samples);
  return samples.length;
}

/** Analyse one stored run and write its HTML report. Returns the file path. */
export async function writeReport(db, runId, outDir = REPORT_DIR) {
  const run = getRun(db, runId);
  if (!run) {
    throw new Error(`run ${runId} is not in the store`);
  }

  const baseline = previousRun(db, run);
  const analysis = analyseRun(db, run, baseline);
  const history = labelHistory(
    db,
    run.suite,
    analysis.stats.slice(0, HISTORY_LABEL_LIMIT).map((s) => s.label),
  );

  const html = renderReport({
    run,
    analysis,
    history,
    baseline,
    generatedAt: new Date().toISOString().replace("T", " ").slice(0, 19) + "Z",
  });

  await mkdir(outDir, { recursive: true });
  const name = reportFileName(run);
  const file = path.join(outDir, name);
  await writeFile(file, html, "utf8");
  await removeStaleReports(outDir, run, name);
  return file;
}

/** An index page so the reports are navigable as a set, not a folder of UUIDs. */
export async function writeIndex(db, outDir = REPORT_DIR) {
  const runs = listRuns(db);
  const rows = runs
    .map(
      (run) => `<tr>
        <td><a href="./${escapeHtml(reportFileName(run))}">${escapeHtml(run.started ?? run.run_id)}</a></td>
        <td>${escapeHtml(run.version ?? "")}</td>
        <td>${escapeHtml(run.environment)}</td>
        <td>${escapeHtml(run.status ?? "")}</td>
        <td class="num">${run.sample_count}</td>
        <td>${escapeHtml(run.run_by ?? "")}</td>
      </tr>`,
    )
    .join("");

  const html = `<title>Perf runs — ${escapeHtml(runs[0]?.suite ?? "bng-perf-tests")}</title>
<style>
:root { --bg:#fff; --panel:#f7f8fa; --border:#d8dce2; --text:#14181d; --muted:#5a6572; --accent:#1d70b8; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --bg:#0f1319; --panel:#161c24; --border:#2a3441; --text:#e6edf3; --muted:#93a1b1; --accent:#58a6ff; } }
:root[data-theme="dark"] { --bg:#0f1319; --panel:#161c24; --border:#2a3441; --text:#e6edf3; --muted:#93a1b1; --accent:#58a6ff; }
body { margin:0; background:var(--bg); color:var(--text); font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
.wrap { max-width:900px; margin:0 auto; padding:32px 20px 60px; }
h1 { font-size:1.5rem; margin:0 0 4px; }
p.sub { color:var(--muted); margin:0 0 22px; font-size:0.92rem; }
.table-wrap { overflow-x:auto; border:1px solid var(--border); border-radius:8px; }
table { border-collapse:collapse; width:100%; font-size:0.9rem; }
th,td { text-align:left; padding:8px 12px; border-bottom:1px solid var(--border); white-space:nowrap; }
th { background:var(--panel); font-weight:600; }
tbody tr:last-child td { border-bottom:0; }
td.num { text-align:right; font-variant-numeric:tabular-nums; }
a { color:var(--accent); }
</style>
<div class="wrap">
  <h1>Perf runs</h1>
  <p class="sub">${runs.length} run(s) in the local store. Newest first.</p>
  <div class="table-wrap"><table>
    <thead><tr><th>Started</th><th>Version</th><th>Env</th><th>Status</th><th class="num">Samples</th><th>Run by</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>
</div>`;

  await mkdir(outDir, { recursive: true });
  const file = path.join(outDir, "index.html");
  await writeFile(file, html, "utf8");
  return file;
}

/** The whole pipeline for one freshly downloaded run. */
export async function ingestAndReport(run, csvPath, { dbPath = DB_PATH } = {}) {
  const db = openStore(dbPath);
  try {
    const stored = await ingestCsv(db, run, csvPath);
    const report = await writeReport(db, run.runId);
    const index = await writeIndex(db);
    return { stored, report, index, runs: listRuns(db).length };
  } finally {
    db.close();
  }
}

function parseArgs(argv) {
  const options = { runId: null, all: false, list: false, ingest: null };
  const takesValue = new Set(["--run-id", "--ingest", "--db"]);
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = takesValue.has(flag) ? argv[i + 1] : null;
    if (takesValue.has(flag)) {
      if (value === undefined) {
        console.error(`${flag} needs a value`);
        process.exit(1);
      }
      i += 1;
    }
    switch (flag) {
      case "--run-id":
        options.runId = value;
        break;
      case "--ingest":
        options.ingest = value;
        break;
      case "--db":
        options.db = value;
        break;
      case "--all":
        options.all = true;
        break;
      case "--list":
        options.list = true;
        break;
      default:
        console.error(`unknown option: ${flag}`);
        process.exit(1);
    }
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const db = openStore(options.db ?? DB_PATH);

  try {
    if (options.ingest) {
      if (!options.runId) {
        console.error("--ingest also needs --run-id to file the samples under");
        process.exit(1);
      }
      const run = getRun(db, options.runId) ?? {
        runId: options.runId,
        suite: "bng-perf-tests",
        environment: "perf-test",
      };
      const n = await ingestCsv(
        db,
        { ...run, runId: options.runId },
        options.ingest,
      );
      console.log(`▸ stored ${n} samples for ${options.runId}`);
    }

    const runs = listRuns(db);
    if (runs.length === 0) {
      console.error("the store is empty — run `npm run perf:results` first");
      process.exit(1);
    }

    if (options.list) {
      console.log(
        `\n  ${runs.length} run(s) stored in ${options.db ?? DB_PATH}\n`,
      );
      for (const run of runs) {
        console.log(
          `  ${(run.started ?? "").padEnd(26)} ${(run.version ?? "").padEnd(8)} ${String(run.sample_count).padStart(6)} samples  ${run.run_id}`,
        );
      }
      console.log("");
      return;
    }

    const targets = options.all
      ? runs.map((r) => r.run_id)
      : [options.runId ?? runs[0].run_id];

    for (const runId of targets) {
      const file = await writeReport(db, runId);
      console.log(`  ✓ ${path.relative(harnessRoot, file)}`);
    }
    const index = await writeIndex(db);
    console.log(`  ✓ ${path.relative(harnessRoot, index)}`);
  } finally {
    db.close();
  }
}

// Only run as a CLI when this file IS the entry point. argv[1] is undefined
// under `node -e`, a REPL or a test importing these helpers, so it is checked
// rather than assumed.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
