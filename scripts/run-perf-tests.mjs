// Run the JMeter perf scenarios against the locally-running stack (`npm run
// perf`). Every .jmx in bng-perf-tests/scenarios runs by default;
// PERF_SCENARIO=<name> picks one. What the harness prepares is inferred from
// the properties each scenario reads:
//
//   - reads bearerToken -> mint a stub token (get-stub-token.mjs) and target
//     the backend; otherwise target the public frontend.
//   - a scenarios/<name>.seed.mjs beside the .jmx (owned by bng-perf-tests)
//     is run first to seed the scenario's data, passed --sub for the token.
//
// Assertion failures warn but do not fail the run — a suite that encodes
// unshipped acceptance criteria fails by design until the fix lands. Set
// PERF_FAIL_ON_ASSERT to gate on failures.
import {
  existsSync,
  mkdirSync,
  readdirSync,
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
  scenario: process.env.PERF_SCENARIO ?? null, // null = run every scenario found
  jmeterImage: process.env.PERF_JMETER_IMAGE ?? "alpine/jmeter:latest",
  failOnAssert: Boolean(process.env.PERF_FAIL_ON_ASSERT),
};

const HEALTH_ATTEMPTS = 30;
const HEALTH_INTERVAL_MS = 1000;
const HTTP_UNAUTHORIZED = 401;
const HTTP_OK = 200;
const FETCH_TIMEOUT_MS = 5000;

const scenariosDir = path.join(repoPath("bng-perf-tests"), "scenarios");
const backendUrl = `http://${cfg.host}:${cfg.backendPort}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Containers reach the host's apps via host.docker.internal; on Linux that
// name needs the explicit host-gateway mapping (harmless on Docker Desktop).
const isLocalHost = cfg.host === "localhost" || cfg.host === "127.0.0.1";
const jmeterDomain = isLocalHost ? "host.docker.internal" : cfg.host;

// What the harness must prepare is inferred from the properties the scenario
// reads: one that reads bearerToken needs a token (and the seeded project its
// assertions exercise) and therefore targets the backend; an unauthenticated
// one is pointed at the public frontend.
function describeScenario(name) {
  const jmx = readFileSync(path.join(scenariosDir, `${name}.jmx`), "utf8");
  const needsAuth = jmx.includes("__P(bearerToken");
  const seedScript = path.join(scenariosDir, `${name}.seed.mjs`);
  return {
    name,
    needsAuth,
    seedScript: existsSync(seedScript) ? seedScript : null,
    port: needsAuth ? cfg.backendPort : cfg.frontendPort,
  };
}

function loadScenarios() {
  if (!existsSync(scenariosDir)) {
    error(`No scenarios directory at ${scenariosDir} — is bng-perf-tests on the right branch?`);
    process.exit(1);
  }
  const available = readdirSync(scenariosDir)
    .filter((f) => f.endsWith(".jmx"))
    .map((f) => f.replace(/\.jmx$/, ""))
    .sort();
  if (available.length === 0) {
    error(`No .jmx scenarios found in ${scenariosDir}.`);
    process.exit(1);
  }
  if (cfg.scenario && !available.includes(cfg.scenario)) {
    error(
      `Scenario ${cfg.scenario}.jmx not found in bng-perf-tests/scenarios ` +
        `(available: ${available.join(", ")}). Scenarios differ per bng-perf-tests ` +
        "branch — check the right one is checked out.",
    );
    process.exit(1);
  }
  const selected = cfg.scenario ? [cfg.scenario] : available;
  return selected.map(describeScenario);
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

async function runJmeter(scenario, token, sub, outDir) {
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
      `/scenarios/${scenario.name}.jmx`,
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
      `-Jdomain=${jmeterDomain}`,
      `-Jport=${scenario.port}`,
      ...(sub ? [`-JuserId=${sub}`] : []),
      `-Jthreads=${cfg.threads}`,
      `-Jloops=${cfg.loops}`,
      `-JrampSeconds=${cfg.ramp}`,
    ]);
  } finally {
    rmSync(propsPath, { force: true });
  }
}

// Columns rendered per transaction, in order, sourced from statistics.json.
const STAT_HEADS = ["count", "err%", "avg", "p90", "p95", "p99", "max", "req/s"];
const STAT_COL_W = 8;
const NAME_MIN_W = 20;
const NAME_MAX_W = 44;
const PERCENT = 100;

// pct1/pct2/pct3ResTime are the dashboard's three percentiles — 90/95/99 by default.
function statCells(s) {
  const errPct = s.sampleCount === 0 ? 0 : (s.errorCount / s.sampleCount) * PERCENT;
  return [
    s.sampleCount,
    errPct.toFixed(1),
    Math.round(s.meanResTime),
    Math.round(s.pct1ResTime),
    Math.round(s.pct2ResTime),
    Math.round(s.pct3ResTime),
    Math.round(s.maxResTime),
    (s.throughput ?? 0).toFixed(1),
  ];
}

// `result` is a 4-char PASS/FAIL/blank token (already colour-wrapped or spaces);
// all three are the same display width, so columns stay aligned.
function statRow(result, name, cells, nameW) {
  const nameCol = String(name).padEnd(nameW).slice(0, nameW);
  const numCols = cells.map((c) => String(c).padStart(STAT_COL_W)).join("");
  return `  ${result}  ${nameCol}${numCols}`;
}

// Print the full per-transaction table (result, counts, error rate, latency
// percentiles, throughput) to the terminal — the same numbers as the HTML
// dashboard, so the result is readable in the logs without opening the report.
function printPerfResults(scenarioName, labels, totalRow) {
  header(`Perf results (${scenarioName})`);
  const nameW = Math.min(
    NAME_MAX_W,
    Math.max(NAME_MIN_W, ...labels.map((s) => s.transaction.length)),
  );
  console.log(color("dim", statRow("    ", "transaction", STAT_HEADS, nameW)));
  for (const s of labels) {
    const ok = s.errorCount === 0;
    const result = ok ? color("green", "PASS") : color("red", "FAIL");
    console.log(statRow(result, s.transaction, statCells(s), nameW));
  }
  if (totalRow) {
    const ok = totalRow.errorCount === 0;
    const result = ok ? color("green", "PASS") : color("red", "FAIL");
    console.log(statRow(result, "TOTAL", statCells(totalRow), nameW));
  }
}

// Per-label counts, latency percentiles and throughput come from the
// statistics.json JMeter writes alongside its HTML dashboard — no JTL parsing.
// The WHY of a failure (the assertion messages) lives in the HTML report.
function summariseReport(scenarioName, outDir) {
  const statsPath = path.join(outDir, "report", "statistics.json");
  if (!existsSync(statsPath)) {
    error("No report statistics produced — the JMeter run did not complete.");
    return { total: 0, failed: 0 };
  }
  const stats = JSON.parse(readFileSync(statsPath, "utf8"));
  const labels = Object.values(stats).filter((s) => s.transaction !== "Total");
  const totalRow = Object.values(stats).find((s) => s.transaction === "Total");
  printPerfResults(scenarioName, labels, totalRow);
  return {
    total: labels.reduce((sum, s) => sum + s.sampleCount, 0),
    failed: labels.reduce((sum, s) => sum + s.errorCount, 0),
  };
}

// Any authenticated scenario needs a real stub token accepted by the backend.
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

// Seed data is owned by the scenario: a scenarios/<name>.seed.mjs beside the
// .jmx is run before it, passed the token's sub when one was minted.
async function runSeedScript(scenario, sub) {
  info(`▸ seeding data for ${scenario.name} (${path.basename(scenario.seedScript)})`);
  const args = [scenario.seedScript, ...(sub ? [`--sub=${sub}`] : [])];
  const code = await run("node", args);
  if (code !== 0) {
    error(`Seed script for ${scenario.name} failed — aborting.`);
    process.exit(1);
  }
}

function reportOutcome(total, failed) {
  console.log("");
  if (total === 0) {
    warn("No samples were recorded — check the JMeter runs produced results.");
    return;
  }
  if (failed === 0) {
    console.log(color("green", `✔ All ${total} samples passed.`));
    return;
  }
  warn(
    `${failed}/${total} samples failed their assertions — see the per-scenario ` +
      "HTML reports above for the failing assertion detail. A suite that encodes " +
      "unshipped acceptance criteria (like BMD-933's list-payload one) fails by " +
      "design until the fix lands; set PERF_FAIL_ON_ASSERT to gate on failures.",
  );
  if (cfg.failOnAssert) {
    process.exit(1);
  }
}

async function main() {
  requireSibling("bng-perf-tests");
  const scenarios = loadScenarios();
  info(`▸ scenarios: ${scenarios.map((s) => s.name).join(", ")}`);

  const targets = [...new Set(scenarios.map((s) => s.port))];
  for (const port of targets) {
    if (!(await waitForHealth(`http://${cfg.host}:${port}`))) {
      process.exit(1);
    }
  }

  const { idToken, sub } = scenarios.some((s) => s.needsAuth)
    ? await prepareAuth()
    : { idToken: null, sub: null };

  const outRoot = path.join(HARNESS_ROOT, ".perf", "perf-out");
  rmSync(outRoot, { recursive: true, force: true });

  let total = 0;
  let failed = 0;
  for (const scenario of scenarios) {
    const outDir = path.join(outRoot, scenario.name);
    mkdirSync(outDir, { recursive: true });
    if (scenario.seedScript) {
      await runSeedScript(scenario, sub);
    }
    header(`Running JMeter (${scenario.name}) against http://${cfg.host}:${scenario.port}`);
    const jmeterCode = await runJmeter(
      scenario,
      scenario.needsAuth ? idToken : null,
      scenario.needsAuth ? sub : null,
      outDir,
    );
    if (jmeterCode !== 0) {
      warn(`JMeter exited ${jmeterCode} — see the assertion summary below.`);
    }
    const result = summariseReport(scenario.name, outDir);
    info(`Report: ${path.join(outDir, "report", "index.html")}`);
    total += result.total;
    failed += result.failed;
  }

  reportOutcome(total, failed);
}

try {
  await main();
} catch (err) {
  error(err.stack ?? String(err));
  process.exit(1);
}
