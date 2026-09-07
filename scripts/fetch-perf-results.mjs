/**
 * Download the raw results of a CDP perf-test run from the CDP Portal.
 *
 * The portal shows a JMeter dashboard, but the dashboard is the *rendered*
 * view. The run also publishes the file behind it: the per-sample CSV JMeter
 * writes with `-l` (see bng-perf-tests/entrypoint.sh — REPORTFILE), one row per
 * request, which is what you want for any analysis the dashboard does not
 * already do.
 *
 * Two portal routes make this possible, both unauthenticated for a public
 * suite (cdp-portal-frontend, src/server/test-suites/test-runs/routes.js):
 *
 *   /test-suites/{suite}                                    the run table
 *   /test-suites/report/{env}/{suite}/{runId}/{assetPath}    the S3 object
 *
 * The second one streams straight out of the `cdp-{env}-test-results` bucket.
 * Asking it for a path that does not exist is not a dead end — the handler
 * answers a 404 whose body LISTS every object under the run's prefix
 * (iframeS3FileHandler -> listSubFolder). That listing is the only way to learn
 * the CSV's name: the filename is stamped with the time the *container* started
 * (`date +%Y%m%d-%H%M%S`), which is a minute or so after the start time the
 * portal displays, so it cannot be derived from the run metadata.
 *
 * Usage:
 *   node scripts/fetch-perf-results.mjs                  # raw CSV, newest run
 *   node scripts/fetch-perf-results.mjs --all            # the whole report folder
 *   node scripts/fetch-perf-results.mjs --run 2          # 2nd newest run WITH a report
 *   node scripts/fetch-perf-results.mjs --exact          # number every row, reports or not
 *   node scripts/fetch-perf-results.mjs --run-id <uuid>  # a specific run
 *   node scripts/fetch-perf-results.mjs --list           # show runs, download nothing
 *   node scripts/fetch-perf-results.mjs --files          # show the run's files
 *   node scripts/fetch-perf-results.mjs --only graph.js  # substring filter
 *   node scripts/fetch-perf-results.mjs --summarise      # + run summarise-run.mjs
 *   node scripts/fetch-perf-results.mjs --no-store       # download only, no DB/report
 */
import { spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { ingestAndReport } from "./perf-report.mjs";

const PORTAL_BASE_URL =
  process.env.PORTAL_BASE_URL ?? "https://portal.cdp-int.defra.cloud";
const DEFAULT_SUITE = "bng-perf-tests";
const DEFAULT_ENVIRONMENT = "perf-test";

// Any assetPath that cannot exist in the bucket. The 404 it provokes is the
// folder listing — see the header comment.
const LISTING_PROBE_PATH = "__cdp_folder_listing__";

// The per-sample CSV entrypoint.sh publishes: <timestamp>-perftest-<scenario>-report.csv.
const RAW_RESULTS_PATTERN = /-perftest-.*-report\.csv$/;
const HTTP_NOT_FOUND = 404;
const BYTES_PER_MIB = 1024 * 1024;
const UUID_LENGTH = 36;
const TABLE_ROW_MARKER = '<tr class="app-entity-table__row"';

const harnessRoot = path.resolve(import.meta.dirname, "..");
const perfTestsDir = path.resolve(harnessRoot, "..", "bng-perf-tests");

/** Turn an Env cell ("Perf Test") into the kebab name the routes use. */
function toKebabEnvironment(text) {
  return text.trim().toLowerCase().replaceAll(/\s+/g, "-");
}

function formatSize(bytes) {
  if (bytes >= BYTES_PER_MIB) {
    return `${(bytes / BYTES_PER_MIB).toFixed(1)} MiB`;
  }
  return `${bytes} bytes`;
}

async function fetchText(url) {
  const response = await fetch(url);
  const body = await response.text();
  return { status: response.status, body };
}

/** Pull one `<td data-label="...">` out of a row's HTML. */
function cellHtml(rowHtml, label) {
  const pattern = new RegExp(
    `data-label="${label}"[^>]*>([\\s\\S]*?)</td>`,
    "i",
  );
  return pattern.exec(rowHtml)?.[1] ?? "";
}

function cellText(rowHtml, label) {
  return cellHtml(rowHtml, label)
    .replaceAll(/<[^>]*>/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
}

/**
 * Parse the run table. The page is server-rendered, so every row is in the
 * HTML — there is no XHR to replay.
 */
function parseRuns(html, suite) {
  const runIdPattern = new RegExp(
    `/test-suites/${suite}/runs/([0-9a-f-]{${UUID_LENGTH}})`,
    "i",
  );

  return html
    .split(TABLE_ROW_MARKER)
    .slice(1)
    .map((rowHtml) => {
      const runId = runIdPattern.exec(rowHtml)?.[1];
      if (!runId) {
        return null;
      }
      // The results link is the most reliable source of env + tag, but a run
      // that published nothing has no link — fall back to the Env cell.
      const resultsLink =
        /\/test-suites\/test-results\/([^/]+)\/([^/]+)\//.exec(rowHtml);
      return {
        runId,
        started: cellText(rowHtml, "Started"),
        version:
          resultsLink?.[2] ??
          /\/releases\/tag\/([^"]+)/.exec(rowHtml)?.[1] ??
          "",
        environment:
          resultsLink?.[1] ??
          toKebabEnvironment(cellText(rowHtml, "Environment")) ??
          DEFAULT_ENVIRONMENT,
        status: cellText(rowHtml, "Status"),
        duration: cellText(rowHtml, "Duration"),
        runBy: cellText(rowHtml, "Run by"),
        hasReport: Boolean(resultsLink),
      };
    })
    .filter(Boolean);
}

function reportBaseUrl({ environment, runId }, suite) {
  return `${PORTAL_BASE_URL}/test-suites/report/${environment}/${suite}/${runId}`;
}

/**
 * List the run's published objects by asking for a path that cannot exist.
 *
 * The portal's listing is a single un-paginated ListObjectsV2 call, so it stops
 * at 1000 keys. That is not a problem for the raw CSV — its name starts with a
 * digit, so it sorts ahead of every other object in the folder — but a very
 * large report could have its tail truncated, hence the warning.
 */
async function listRunFiles(run, suite) {
  const url = `${reportBaseUrl(run, suite)}/${LISTING_PROBE_PATH}`;
  const { status, body } = await fetchText(url);

  if (status !== HTTP_NOT_FOUND) {
    throw new Error(
      `expected ${HTTP_NOT_FOUND} (the folder listing) from ${url}, got ${status}`,
    );
  }

  const files = [
    ...body.matchAll(
      /<a class="govuk-link" href="\.\/([^"]+)">\s*[\s\S]*?- (\d+) bytes<\/a>/g,
    ),
  ].map(([, assetPath, bytes]) => ({ assetPath, bytes: Number(bytes) }));

  return files;
}

async function downloadFile(run, suite, file, outDir, force) {
  const destination = path.join(outDir, file.assetPath);

  if (!force) {
    const existing = await stat(destination).catch(() => null);
    if (existing?.size === file.bytes) {
      console.log(`  = ${file.assetPath} (already downloaded)`);
      return;
    }
  }

  const url = `${reportBaseUrl(run, suite)}/${file.assetPath}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GET ${url} -> ${response.status}`);
  }

  await mkdir(path.dirname(destination), { recursive: true });
  await pipeline(
    Readable.fromWeb(response.body),
    createWriteStream(destination),
  );
  console.log(`  ↓ ${file.assetPath} (${formatSize(file.bytes)})`);
}

function selectFiles(files, options) {
  if (options.only) {
    return files.filter((file) => file.assetPath.includes(options.only));
  }
  if (options.all) {
    return files;
  }
  return files.filter((file) => RAW_RESULTS_PATTERN.test(file.assetPath));
}

const STARTED_WIDTH = 26;
const VERSION_WIDTH = 9;
const STATUS_WIDTH = 12;
const INDEX_WIDTH = 3;

/** One column layout for the header and the rows, so they cannot drift apart. */
function runRow(cells) {
  const [index, started, version, status, runId] = cells;
  return [
    index.padStart(INDEX_WIDTH),
    started.padEnd(STARTED_WIDTH),
    version.padEnd(VERSION_WIDTH),
    status.padEnd(STATUS_WIDTH),
    runId,
  ].join("  ");
}

/**
 * Number the rows the way --run counts them.
 *
 * By default --run counts only runs that actually published something, so
 * `--run 1` is the newest DOWNLOADABLE run rather than the newest row. The top
 * row is routinely a run that is still in progress, and treating that as row 1
 * means every default invocation fails until it finishes. Rows with nothing to
 * download are still listed, numbered "-".
 */
function numberRuns(runs, exact) {
  let downloadable = 0;
  return runs.map((run) => {
    if (!exact && !run.hasReport) {
      return { run, label: "-" };
    }
    downloadable += 1;
    return { run, label: String(downloadable), index: downloadable };
  });
}

function printRuns(runs, exact) {
  console.log(`\n${runRow(["#", "Started", "Version", "Status", "Run ID"])}`);
  numberRuns(runs, exact).forEach(({ run, label }) => {
    const note = run.hasReport ? "" : "  (no report)";
    console.log(
      runRow([
        label,
        run.started,
        run.version,
        run.status,
        `${run.runId}${note}`,
      ]),
    );
  });
  console.log("");
}

/**
 * Hand the downloaded CSV to bng-perf-tests' own summariser.
 *
 * It imports csv-parse, so it only runs once that sibling has its dependencies —
 * checked up front, because the alternative is an ERR_MODULE_NOT_FOUND stack
 * trace where a one-line instruction belongs.
 */
async function summarise(csvPath) {
  const summariser = path.join(perfTestsDir, "scripts", "summarise-run.mjs");
  const manualStep = `  node ${summariser} ${csvPath}`;

  if (!(await stat(summariser).catch(() => null))) {
    console.error(
      `\nWARNING: no summariser at ${summariser} — skipping --summarise`,
    );
    return;
  }
  if (
    !(await stat(path.join(perfTestsDir, "node_modules")).catch(() => null))
  ) {
    console.error(
      "\nWARNING: bng-perf-tests has no node_modules, so --summarise cannot run.",
    );
    console.error(
      `Run \`npm install\` in ${perfTestsDir}, then:\n${manualStep}`,
    );
    return;
  }

  console.log(`\n▸ summarising via ${summariser}\n`);
  const result = spawnSync(process.execPath, [summariser, csvPath], {
    stdio: "inherit",
    cwd: perfTestsDir,
  });
  if (result.status !== 0) {
    console.error(
      `\nWARNING: summarise-run.mjs failed. Retry with:\n${manualStep}`,
    );
  }
}

function parseArgs(argv) {
  const options = {
    suite: DEFAULT_SUITE,
    run: 1,
    runId: null,
    all: false,
    only: null,
    list: false,
    files: false,
    force: false,
    exact: false,
    summarise: false,
    noStore: false,
    out: null,
  };
  const takesValue = new Set([
    "--suite",
    "--run",
    "--run-id",
    "--only",
    "--out",
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = takesValue.has(flag) ? argv[index + 1] : null;
    if (takesValue.has(flag) && value === undefined) {
      console.error(`${flag} needs a value`);
      process.exit(1);
    }
    if (takesValue.has(flag)) {
      index += 1;
    }

    switch (flag) {
      case "--suite":
        options.suite = value;
        break;
      case "--run":
        options.run = Number(value);
        break;
      case "--run-id":
        options.runId = value;
        break;
      case "--only":
        options.only = value;
        break;
      case "--out":
        options.out = value;
        break;
      case "--all":
        options.all = true;
        break;
      case "--list":
        options.list = true;
        break;
      case "--files":
        options.files = true;
        break;
      case "--force":
        options.force = true;
        break;
      case "--exact":
        options.exact = true;
        break;
      case "--no-store":
        options.noStore = true;
        break;
      case "--summarise":
      case "--summarize":
        options.summarise = true;
        break;
      default:
        console.error(`unknown option: ${flag}`);
        process.exit(1);
    }
  }

  if (!Number.isInteger(options.run) || options.run < 1) {
    console.error("--run must be a positive integer (1 = newest run)");
    process.exit(1);
  }
  return options;
}

function chooseRun(runs, options) {
  if (options.runId) {
    const match = runs.find((run) => run.runId === options.runId);
    if (!match) {
      console.error(
        `no run ${options.runId} on the first page of the run table`,
      );
      process.exit(1);
    }
    return match;
  }
  const selectable = numberRuns(runs, options.exact).filter(
    (row) => row.index !== undefined,
  );
  const match = selectable.find((row) => row.index === options.run);
  if (!match) {
    const what = options.exact ? "runs are listed" : "runs have a report";
    console.error(`--run ${options.run} but only ${selectable.length} ${what}`);
    process.exit(1);
  }

  const skipped = runs.indexOf(match.run);
  if (skipped > 0 && !options.exact && options.run === 1) {
    const noun = skipped === 1 ? "run" : "runs";
    console.log(
      `  skipping ${skipped} newer ${noun} with no report yet (--exact numbers every row)`,
    );
  }
  return match.run;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const suiteUrl = `${PORTAL_BASE_URL}/test-suites/${options.suite}`;

  console.log(`▸ reading the run table at ${suiteUrl}`);
  const { status, body } = await fetchText(suiteUrl);
  if (status !== 200) {
    console.error(`GET ${suiteUrl} -> ${status}`);
    process.exit(1);
  }

  const runs = parseRuns(body, options.suite);
  if (runs.length === 0) {
    console.error(
      `no runs parsed from ${suiteUrl} — the portal's table markup may have changed`,
    );
    process.exit(1);
  }
  console.log(`  ${runs.length} runs listed`);

  if (options.list) {
    printRuns(runs, options.exact);
    return;
  }

  const run = chooseRun(runs, options);
  console.log(
    `▸ run ${run.runId}\n` +
      `  started ${run.started} · version ${run.version} · ${run.environment} · ${run.status} · ${run.duration}`,
  );

  if (!run.hasReport) {
    console.error(
      "  this run published no report — there is nothing to download",
    );
    process.exit(1);
  }

  const files = await listRunFiles(run, options.suite);
  console.log(`  ${files.length} files published`);

  if (options.files) {
    files.forEach((file) => {
      console.log(
        `  ${formatSize(file.bytes).padStart(12)}  ${file.assetPath}`,
      );
    });
    return;
  }

  const selected = selectFiles(files, options);
  if (selected.length === 0) {
    console.error(
      options.only
        ? `nothing published matches --only ${options.only}`
        : "no per-sample results CSV in this run — try --all or --files",
    );
    process.exit(1);
  }

  const outDir =
    options.out ??
    path.join(harnessRoot, "perf-results", options.suite, run.runId);
  await mkdir(outDir, { recursive: true });
  console.log(`▸ downloading ${selected.length} file(s) to ${outDir}`);

  for (const file of selected) {
    await downloadFile(run, options.suite, file, outDir, options.force);
  }

  const rawCsv = selected.find((file) =>
    RAW_RESULTS_PATTERN.test(file.assetPath),
  );
  if (rawCsv) {
    console.log(
      `  raw per-sample data: ${path.join(outDir, rawCsv.assetPath)}`,
    );
  }
  if (!options.all && !options.only) {
    console.log("  (--all downloads the full JMeter dashboard as well)");
  }

  // Store and analyse. The download alone is a file in a folder; keeping the
  // samples is what makes "has this regressed" answerable later, so it happens
  // by default rather than behind a flag.
  if (rawCsv && !options.noStore) {
    const csvPath = path.join(outDir, rawCsv.assetPath);
    console.log("▸ storing samples and building the report");
    const result = await ingestAndReport(
      { ...run, suite: options.suite },
      csvPath,
    );
    console.log(
      `  ${result.stored} samples stored · ${result.runs} run(s) now in the store`,
    );
    console.log(`  report: ${result.report}`);
    console.log(`  index:  ${result.index}`);
  }

  if (options.summarise && rawCsv) {
    await summarise(path.join(outDir, rawCsv.assetPath));
  }
}

await main();
