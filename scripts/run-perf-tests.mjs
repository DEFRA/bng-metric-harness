// Run the JMeter perf suite against the locally-running stack (`npm run perf`).
//
// The suite is a SINGLE plan — bng-perf-tests/scenarios/bng-perf.jmx — with two
// thread groups in one execution: a public home-page smoke check (frontend) and
// the authenticated BMD-933 project-list endpoints (backend). So the harness
// always prepares both: it health-checks both hosts, mints a stub token for the
// backend group, and seeds the owner's projects through the backend API (the same
// portable seed the CDP container uses) before JMeter runs. One run → one report.
//
// PERF_SCENARIO=<name> picks a different scenarios/<name>.jmx. Assertion failures
// warn but do not fail the run — a suite that encodes unshipped acceptance
// criteria fails by design until the fix lands. Set PERF_FAIL_ON_ASSERT to gate.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  color,
  error,
  header,
  HARNESS_ROOT,
  info,
  repoPath,
  requireSibling,
  run,
  warn,
} from "./_lib.mjs";
import { getStubToken } from "./get-stub-token.mjs";

const cfg = {
  host: process.env.PERF_HOST ?? process.env.PERF_BACKEND_HOST ?? "localhost",
  backendPort: process.env.PERF_BACKEND_PORT ?? "3001",
  frontendPort: process.env.PERF_FRONTEND_PORT ?? "3000",
  threads: process.env.PERF_THREADS ?? "5",
  loops: process.env.PERF_LOOPS ?? "3",
  ramp: process.env.PERF_RAMP ?? "2",
  scenario: process.env.PERF_SCENARIO ?? "bng-perf",
  jmeterImage: process.env.PERF_JMETER_IMAGE ?? "alpine/jmeter:latest",
  failOnAssert: Boolean(process.env.PERF_FAIL_ON_ASSERT),
  // The plan seeds the backend owner's projects through the API by default, the
  // same as the CDP container. Set PERF_SKIP_SEED to run against existing data.
  skipSeed: Boolean(process.env.PERF_SKIP_SEED),
};

const HEALTH_ATTEMPTS = 30;
const HEALTH_INTERVAL_MS = 1000;
const HTTP_UNAUTHORIZED = 401;
const HTTP_OK = 200;
const FETCH_TIMEOUT_MS = 5000;

const perfRepo = repoPath("bng-perf-tests");
const scenariosDir = path.join(perfRepo, "scenarios");
const seedViaApiScript = path.join(perfRepo, "scripts", "seed-via-api.mjs");
const backendUrl = `http://${cfg.host}:${cfg.backendPort}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Containers reach the host's apps via host.docker.internal; on Linux that
// name needs the explicit host-gateway mapping (harmless on Docker Desktop).
const isLocalHost = cfg.host === "localhost" || cfg.host === "127.0.0.1";
const jmeterDomain = isLocalHost ? "host.docker.internal" : cfg.host;

function scenarioFile() {
  const file = path.join(scenariosDir, `${cfg.scenario}.jmx`);
  if (!existsSync(scenariosDir)) {
    error(`No scenarios directory at ${scenariosDir} — is bng-perf-tests on the right branch?`);
    process.exit(1);
  }
  if (!existsSync(file)) {
    error(
      `Scenario ${cfg.scenario}.jmx not found in bng-perf-tests/scenarios. ` +
        "Scenarios differ per bng-perf-tests branch — check the right one is checked out.",
    );
    process.exit(1);
  }
  return file;
}

async function waitForHealth(baseUrl) {
  for (let attempt = 1; attempt <= HEALTH_ATTEMPTS; attempt += 1) {
    try {
      const res = await fetch(`${baseUrl}/health`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (res.ok) {
        info(`▸ target healthy at ${baseUrl}`);
        return true;
      }
    } catch {
      // not up yet — fall through to retry
    }
    await sleep(HEALTH_INTERVAL_MS);
  }
  error(`Target never became healthy at ${baseUrl}/health`);
  return false;
}

// Probe the list endpoint with the token. A 401 means the backend rejected it
// (e.g. the stub issued something the backend won't accept).
async function probeAuth(token) {
  try {
    const res = await fetch(`${backendUrl}/projects`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    return res.status;
  } catch (err) {
    error(`Could not reach ${backendUrl}/projects: ${err.message}`);
    return null;
  }
}

async function runJmeter(scenarioPath, token, sub, outDir) {
  // Hand the token to JMeter via a properties file (-q) rather than a
  // -JbearerToken= arg, so the secret never lands in the container's process
  // args (visible to `ps`) or in the Tilt logs. The file lives in the gitignored
  // .perf/ output dir and is deleted right after the run.
  const propsPath = path.join(outDir, "perf.properties");
  writeFileSync(propsPath, token ? `bearerToken=${token}\n` : "");
  try {
    return await run("docker", [
      "run",
      "--rm",
      "--add-host=host.docker.internal:host-gateway",
      "-v",
      `${scenariosDir}:/scenarios`,
      "-v",
      `${outDir}:/out`,
      cfg.jmeterImage,
      "-n",
      "-t",
      `/scenarios/${path.basename(scenarioPath)}`,
      "-q",
      "/out/perf.properties",
      "-l",
      "/out/out.jtl",
      "-e",
      "-o",
      "/out/report",
      "-f",
      "-Jenv=local",
      "-Jprotocol=http",
      // Each thread group targets its own host/port — one run hits both services.
      `-JfrontendDomain=${jmeterDomain}`,
      `-JbackendDomain=${jmeterDomain}`,
      `-JfrontendPort=${cfg.frontendPort}`,
      `-JbackendPort=${cfg.backendPort}`,
      ...(sub ? [`-JuserId=${sub}`] : []),
      // Both groups share the local load profile so `npm run perf` stays light.
      `-JhomeThreads=${cfg.threads}`,
      `-JhomeLoops=${cfg.loops}`,
      `-JhomeRampSeconds=${cfg.ramp}`,
      `-JlistThreads=${cfg.threads}`,
      `-JlistLoops=${cfg.loops}`,
      `-JlistRampSeconds=${cfg.ramp}`,
    ]);
  } finally {
    rmSync(propsPath, { force: true });
  }
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

// Per-label pass/fail and latency come from the statistics.json JMeter writes
// alongside its HTML dashboard — no JTL parsing. The WHY of a failure (the
// assertion messages) lives in the HTML report.
function summariseReport(outDir) {
  const statsPath = path.join(outDir, "report", "statistics.json");
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

// The backend group needs a real stub token accepted by the backend.
// Returns { idToken, sub }.
async function prepareAuth() {
  const { idToken, sub } = await getStubToken();
  info(`▸ got a stub token for ${sub}`);

  const status = await probeAuth(idToken);
  if (status === HTTP_UNAUTHORIZED) {
    error(
      "Backend rejected the stub token (401). Check the stub and backend share an OIDC config.",
    );
    process.exit(1);
  }
  if (status !== HTTP_OK) {
    error(`Unexpected status ${status} from ${backendUrl}/projects — aborting.`);
    process.exit(1);
  }
  info("▸ token accepted by the backend");
  return { idToken, sub };
}

// Seed the owner's projects through the backend API — the same portable seed the
// CDP container runs (bng-perf-tests/scripts/seed-via-api.mjs). The token's sub
// owns the seeded rows, so no --sub is needed.
async function seedViaApi(token) {
  if (cfg.skipSeed) {
    info("▸ PERF_SKIP_SEED set — running against existing data");
    return;
  }
  info("▸ seeding baseline projects via the backend API");
  const code = await run("node", [seedViaApiScript], {
    env: { ...process.env, API_BASE_URL: backendUrl, BEARER_TOKEN: token },
  });
  if (code !== 0) {
    error("Seeding via the backend API failed — aborting.");
    process.exit(1);
  }
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

async function main() {
  requireSibling("bng-perf-tests");
  const scenarioPath = scenarioFile();
  info(`▸ scenario: ${cfg.scenario}`);

  // The plan hits both services, so both must be healthy first.
  for (const port of new Set([cfg.frontendPort, cfg.backendPort])) {
    if (!(await waitForHealth(`http://${cfg.host}:${port}`))) {
      process.exit(1);
    }
  }

  const { idToken, sub } = await prepareAuth();
  await seedViaApi(idToken);

  const outDir = path.join(HARNESS_ROOT, ".perf", "perf-out");
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  header(`Running JMeter (${cfg.scenario}) — frontend :${cfg.frontendPort}, backend :${cfg.backendPort}`);
  const jmeterCode = await runJmeter(scenarioPath, idToken, sub, outDir);
  if (jmeterCode !== 0) {
    warn(`JMeter exited ${jmeterCode} — see the assertion summary below.`);
  }
  const { total, failed } = summariseReport(outDir);
  info(`Report: ${path.join(outDir, "report", "index.html")}`);

  reportOutcome(total, failed);
}

try {
  await main();
} catch (err) {
  error(err.stack ?? String(err));
  process.exit(1);
}
