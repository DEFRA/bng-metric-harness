// Run the JMeter perf suite against the locally-running stack (`npm run perf`).
//
// This drives bng-perf-tests' OWN container — the same image and the same
// entrypoint.sh a CDP task runs — rather than reimplementing the pipeline here.
// Minting a stub token, seeding the owner's projects, staging uploads, running
// JMeter and summarising the result all live in that entrypoint. This file used
// to do those steps itself in Node, and the two copies drifted the moment the
// upload phases landed: the container grew upload staging and this did not, so a
// local run reported ten samplers failing for reasons that had nothing to do with
// the service. One pipeline, and local is literally what CDP runs.
//
// One command, one thing it does: the whole suite. Fixtures are generated, pushed
// through the CDP Uploader and virus-scanned before JMeter starts, then the plan
// runs every thread group — home page, project list, background probe, size ramp,
// the upload/edit ladders and the mixed workload. Budget ~18 minutes for the run
// plus up to two minutes of staging, and have cdp-uploader on :7337 (it ships in
// the backend's compose) alongside the frontend, backend and stub.
//
// Every phase is an env var away from being suppressed if you want a narrower run
// — see "Running only the everyday half" in bng-perf-tests' README — but that is a
// thing you reach for occasionally, not a second command to keep in step with this
// one.
//
// Assertion failures warn but do not fail the run: the project-list group encodes
// unshipped BMD-933 acceptance criteria and is red by design until the fix lands,
// and a red Duration Assertion beyond N users IS the result. Set PERF_FAIL_ON_ASSERT
// to gate on them.
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import {
  color,
  error,
  header,
  info,
  repoPath,
  requireSibling,
  run,
  warn,
} from "./_lib.mjs";

const cfg = {
  host: process.env.PERF_HOST ?? process.env.PERF_BACKEND_HOST ?? "localhost",
  backendPort: process.env.PERF_BACKEND_PORT ?? "3001",
  frontendPort: process.env.PERF_FRONTEND_PORT ?? "3000",
  stubPort: process.env.PERF_STUB_PORT ?? "3200",
  uploaderPort: process.env.PERF_UPLOADER_PORT ?? "7337",
  threads: process.env.PERF_THREADS ?? "5",
  loops: process.env.PERF_LOOPS ?? "3",
  ramp: process.env.PERF_RAMP ?? "2",
  // TEST_SCENARIO is the container's own escape hatch; an unknown name falls back
  // to bng-perf, so this can never fail the run.
  scenario: process.env.PERF_SCENARIO ?? "",
  image: process.env.PERF_IMAGE ?? "bng-perf-tests:local",
  failOnAssert: Boolean(process.env.PERF_FAIL_ON_ASSERT),
  skipBuild: Boolean(process.env.PERF_SKIP_BUILD),
  // Short feedback loop. The full plan is ~18 minutes, which is far too slow to
  // iterate on a memory or capacity change: you learn whether it worked once an
  // hour. Quick mode shortens every phase window and loop count so the same
  // shape of load runs in ~3 minutes. It is for iterating, NOT for judging
  // throughput — the numbers are not comparable with a full run.
  quick: Boolean(process.env.PERF_QUICK),
};

// PERF_QUICK: the same plan, cut to the phases that stress memory.
//
// The full plan is ~18 minutes because it walks 42 concurrency steps. That is
// the right shape for judging throughput and the wrong one for iterating on a
// memory change, where you only need the steps that put several large files in
// flight at once.
//
// It works by zeroing each unwanted phase's WINDOW, which entrypoint.sh treats
// as "skip" — and, because the phase delays are derived rather than written
// down, a skipped phase hands its wall clock back instead of leaving dead air.
// That is the escape hatch the suite already documents, so this needs no change
// to bng-perf-tests, and in particular does not reintroduce the extra profiles
// that repo deliberately deleted.
//
// Kept: journey_large_10 and revalidate_large_20 (the heaviest bursts, 10 and
// 20 concurrent large uploads) and the mixed workload, shortened. NOT a
// substitute for a full run before believing a throughput number.
const QUICK_KEPT_PHASES = Object.freeze([
  "journey_large_10",
  "revalidate_large_20",
  "mixed",
]);

const QUICK_SKIPPED_PHASES = Object.freeze([
  "journey_normal_1",
  "journey_normal_2",
  "journey_normal_3",
  "journey_normal_4",
  "journey_normal_5",
  "journey_normal_6",
  "journey_normal_7",
  "journey_normal_8",
  "journey_normal_9",
  "journey_normal_10",
  "journey_busy_1",
  "journey_busy_5",
  "journey_busy_10",
  "journey_large_1",
  "journey_large_2",
  "journey_large_3",
  "journey_large_5",
  "revalidate_large_1",
  "revalidate_large_2",
  "revalidate_large_5",
  "revalidate_large_10",
  "pi_normal_1",
  "pi_normal_2",
  "pi_normal_5",
  "pi_normal_10",
  "pi_large_1",
  "pi_large_5",
  "edit_normal_1",
  "edit_normal_2",
  "edit_normal_3",
  "edit_normal_5",
  "edit_normal_10",
  "edit_large_1",
  "edit_large_5",
  "editContention_2",
  "editContention_3",
  "editContention_5",
  "editContention_10",
  "fetchRamp",
]);

const QUICK_ENV = Object.freeze({
  ...Object.fromEntries(
    QUICK_SKIPPED_PHASES.map((phase) => [`WINDOW_${phase}`, "0"]),
  ),
  EVERYDAY_PHASE_DURATION_SECONDS: "8",
  PROBE_BASELINE_SECONDS: "8",
  PHASE_GAP_SECONDS: "2",
  // The mixed workload uses the same WINDOW_<phase> override as the skips.
  WINDOW_mixed: "20",
  CREATE_LOOPS: "2",
  CREATE_LARGE_LOOPS: "1",
  SIZE_LOOPS_NORMAL: "2",
  SIZE_LOOPS_BUSY: "1",
  SIZE_LOOPS_LARGE: "1",
  SIZE_LOOPS_XLARGE: "1",
});

const HEALTH_ATTEMPTS = 30;
const HEALTH_INTERVAL_MS = 1000;
const FETCH_TIMEOUT_MS = 5000;

const perfRepo = repoPath("bng-perf-tests");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Containers reach the host's apps via host.docker.internal; on Linux that name
// needs the explicit host-gateway mapping (harmless on Docker Desktop).
const isLocalHost = cfg.host === "localhost" || cfg.host === "127.0.0.1";
const containerHost = isLocalHost ? "host.docker.internal" : cfg.host;

async function waitForHealth(label, url) {
  for (let attempt = 1; attempt <= HEALTH_ATTEMPTS; attempt += 1) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (res.ok) {
        info(`▸ ${label} healthy at ${url}`);
        return true;
      }
    } catch {
      // not up yet — fall through to retry
    }
    await sleep(HEALTH_INTERVAL_MS);
  }
  error(`${label} never became healthy at ${url}`);
  return false;
}

// The uploader answers its root with a 404 rather than a health endpoint, so any
// HTTP response at all means it is listening. Only reachability matters here.
async function waitForUploader(url) {
  for (let attempt = 1; attempt <= HEALTH_ATTEMPTS; attempt += 1) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      info(`▸ cdp-uploader reachable at ${url}`);
      return true;
    } catch {
      // not up yet — fall through to retry
    }
    await sleep(HEALTH_INTERVAL_MS);
  }
  error(
    `cdp-uploader never answered at ${url}. The upload phases stage their fixtures ` +
      "through it, so it has to be up: `(cd ../bng-metric-backend && docker compose up -d)`.",
  );
  return false;
}

// Everything the container needs, as it would come from a CDP task's config. The
// harness only has to say where the local stack is and how heavy to run.
function containerEnv() {
  const env = {
    ENVIRONMENT: "local",
    SERVICE_URL_SCHEME: "http",
    FRONTEND_DOMAIN: containerHost,
    BACKEND_DOMAIN: containerHost,
    FRONTEND_PORT: cfg.frontendPort,
    BACKEND_PORT: cfg.backendPort,
    STUB_BASE_URL: `http://${containerHost}:${cfg.stubPort}/cdp-defra-id-stub`,
    // The stub stamps each token's `iss` from the Host header it was minted
    // with, and the backend rejects any issuer other than the one its own
    // discovery fetch named. The container minting via host.docker.internal
    // against a backend that discovered via localhost would disagree on every
    // token, so pin the mint request's Host header to the host-side name.
    STUB_ISSUER_HOST: `${cfg.host}:${cfg.stubPort}`,
    // RESULTS_OUTPUT_S3_PATH is deliberately absent: unset, the entrypoint logs
    // "skipping S3 publish" and exits 0, so a local run needs no LocalStack.
    //
    // Keep local runs light; the CDP profile is heavier by default.
    HOME_THREADS: cfg.threads,
    HOME_LOOPS: cfg.loops,
    HOME_RAMP_SECONDS: cfg.ramp,
    LIST_THREADS: cfg.threads,
    LIST_LOOPS: cfg.loops,
    LIST_RAMP_SECONDS: cfg.ramp,
  };

  if (cfg.quick) {
    Object.assign(env, QUICK_ENV);
  }

  if (cfg.scenario) {
    env.TEST_SCENARIO = cfg.scenario;
  }

  // The entrypoint resolves this to localhost:7337 for ENVIRONMENT=local, which is
  // right for a process on the host and wrong from inside a container.
  env.CDP_UPLOADER_URL = `http://${containerHost}:${cfg.uploaderPort}`;
  return env;
}

async function buildImage() {
  if (cfg.skipBuild) {
    info("▸ PERF_SKIP_BUILD set — using the existing image");
    return true;
  }
  header("Building the perf-tests image");
  // Only the COPY layers change when a scenario or script is edited, so a warm
  // rebuild is a file copy. The npm ci layer keys off package*.json alone.
  const code = await run("docker", ["build", "-t", cfg.image, "."], {
    cwd: perfRepo,
  });
  if (code !== 0) {
    error("Could not build the perf-tests image.");
    return false;
  }
  return true;
}

function dockerRunArgs(reportsDir) {
  const envArgs = Object.entries(containerEnv()).flatMap(([key, value]) => [
    "-e",
    `${key}=${value}`,
  ]);
  return [
    "run",
    "--rm",
    "--add-host=host.docker.internal:host-gateway",
    "-v",
    `${reportsDir}:/opt/perftest/reports`,
    ...envArgs,
    cfg.image,
  ];
}

function printPerfResults(labels) {
  header("Perf results");
  for (const s of labels) {
    const status =
      s.errorCount === 0
        ? color("green", "PASS")
        : color("red", `FAIL (${s.errorCount}/${s.sampleCount})`);
    // pct2ResTime is the dashboard's second percentile — 95th by default.
    const latency = `avg ${Math.round(s.meanResTime)} ms · p95 ${Math.round(s.pct2ResTime)} ms`;
    console.log(`  ${status}  ${s.transaction}  ${color("dim", latency)}`);
  }
}

// Per-label pass/fail comes from the statistics.json JMeter writes alongside its
// HTML dashboard, which the container writes into the mounted reports dir. The
// WHY of a failure (the assertion messages) lives in the HTML report, and the
// container has already printed its own plain-English summary above this.
function summariseReport(reportsDir) {
  const statsPath = path.join(reportsDir, "statistics.json");
  if (!existsSync(statsPath)) {
    error("No report statistics produced — the JMeter run did not complete.");
    return { total: 0, failed: 0 };
  }
  const stats = JSON.parse(readFileSync(statsPath, "utf8"));
  const labels = Object.values(stats).filter((s) => s.transaction !== "Total");
  printPerfResults(labels);
  return {
    total: labels.reduce((sum, s) => sum + s.sampleCount, 0),
    failed: labels.reduce((sum, s) => sum + s.errorCount, 0),
  };
}

function reportOutcome(total, failed) {
  console.log("");
  if (total === 0) {
    warn("No samples were recorded — check the JMeter run produced results.");
    return;
  }
  if (failed === 0) {
    console.log(color("green", `✔ All ${total} samples passed.`));
    return;
  }
  warn(
    `${failed}/${total} samples failed their assertions — see the HTML report ` +
      "above for the failing assertion detail. A suite that encodes unshipped " +
      "acceptance criteria (like BMD-933's list-payload one) fails by design " +
      "until the fix lands; set PERF_FAIL_ON_ASSERT to gate on failures.",
  );
  if (cfg.failOnAssert) {
    process.exit(1);
  }
}

async function checkStack() {
  // The plan hits both services, and the container mints a token against the stub
  // before JMeter starts, so all three have to be up.
  for (const port of new Set([cfg.frontendPort, cfg.backendPort])) {
    if (
      !(await waitForHealth(`:${port}`, `http://${cfg.host}:${port}/health`))
    ) {
      error(
        "Start the stack first: `docker compose up -d` in bng-metric-backend, " +
          "then `npm run dev` here.",
      );
      return false;
    }
  }
  return waitForUploader(`http://${cfg.host}:${cfg.uploaderPort}/`);
}

async function main() {
  requireSibling("bng-perf-tests");

  info(
    cfg.quick
      ? "▸ PERF_QUICK — staging uploads, then ~2-3 minutes of JMeter (shape of the full plan, not its throughput numbers)"
      : "▸ running the full suite — staging uploads, then ~18 minutes of JMeter",
  );

  if (!(await checkStack())) {
    process.exit(1);
  }
  if (!(await buildImage())) {
    process.exit(1);
  }

  // JMeter writes its dashboard with -f, but start clean so a previous run's
  // statistics.json can never be read back as this run's result.
  const reportsDir = path.join(perfRepo, "reports");
  rmSync(reportsDir, { recursive: true, force: true });
  mkdirSync(reportsDir, { recursive: true });

  header(
    `Running the perf suite — frontend :${cfg.frontendPort}, backend :${cfg.backendPort}`,
  );
  const code = await run("docker", dockerRunArgs(reportsDir));
  if (code !== 0) {
    // The entrypoint exits non-zero only on an infrastructure failure — a failed
    // token mint, seed or staging step, or no report to publish. Assertions never
    // gate it, so a non-zero code here is not a red assertion.
    error(
      `The perf run failed (exit ${code}) — see the container output above.`,
    );
    process.exit(code);
  }

  const { total, failed } = summariseReport(reportsDir);
  info(`Report: ${path.join(reportsDir, "index.html")}`);
  reportOutcome(total, failed);
}

try {
  await main();
} catch (err) {
  error(err.stack ?? String(err));
  process.exit(1);
}
