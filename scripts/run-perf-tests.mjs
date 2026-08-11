// Run the JMeter perf scenarios against the locally-running stack. Invoked by
// `npm run perf` — no Tilt resource, no perf mode. Just `tilt up` then this.
//
// The scenarios are whatever .jmx files the checked-out bng-perf-tests branch
// carries: all of them run by default; PERF_SCENARIO=<name> picks one. Nothing
// is keyed to scenario names or branches — what the harness prepares is
// inferred from the properties each scenario actually reads:
//
//   - reads bearerToken -> mint a REAL token from the cdp-defra-id-stub
//     (get-stub-token.mjs; the normal `tilt up` backend already trusts stub
//     tokens), verify the backend accepts it, and idempotently seed a
//     big-baseline project owned by the token's sub (fixed id + ON CONFLICT,
//     so re-runs don't pile up). Authenticated scenarios target the backend.
//   - otherwise -> nothing to mint or seed; the scenario targets the public
//     frontend.
//
// Assertion failures warn but do not fail the run: a suite that encodes
// unshipped acceptance criteria (like BMD-933's list-payload one) fails by
// design until the fix lands. Set PERF_FAIL_ON_ASSERT to gate on failures.
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
  runCapture,
  warn,
} from "./_lib.mjs";
import { getStubToken } from "./get-stub-token.mjs";

const cfg = {
  host: process.env.PERF_HOST ?? process.env.PERF_BACKEND_HOST ?? "localhost",
  backendPort: process.env.PERF_BACKEND_PORT ?? "3001",
  frontendPort: process.env.PERF_FRONTEND_PORT ?? "3000",
  parcels: Number(process.env.PERF_PARCELS ?? "2000"),
  threads: process.env.PERF_THREADS ?? "5",
  loops: process.env.PERF_LOOPS ?? "3",
  ramp: process.env.PERF_RAMP ?? "2",
  scenario: process.env.PERF_SCENARIO ?? null, // null = run every scenario found
  jmeterImage: process.env.PERF_JMETER_IMAGE ?? "alpine/jmeter:latest",
  postgresImage: process.env.PERF_POSTGRES_IMAGE ?? "postgis/postgis:16-3.5",
  failOnAssert: Boolean(process.env.PERF_FAIL_ON_ASSERT),
};

const PROJECT_ID = "00000000-0000-4000-8000-000000000933";
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
  return {
    name,
    needsAuth,
    port: needsAuth ? cfg.backendPort : cfg.frontendPort,
  };
}

function loadScenarios() {
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

// Find the running Postgres container by image so we don't depend on the
// compose project name Tilt happens to use.
async function findPostgresContainer() {
  const byImage = await runCapture("docker", [
    "ps",
    "--filter",
    `ancestor=${cfg.postgresImage}`,
    "--format",
    "{{.ID}}",
  ]);
  const id = byImage.stdout.trim().split("\n")[0];
  if (id) {
    return id;
  }
  const byName = await runCapture("docker", [
    "ps",
    "--filter",
    "name=postgres",
    "--format",
    "{{.ID}}",
  ]);
  return byName.stdout.trim().split("\n")[0] || null;
}

// The stub user is deterministic (same sub every run), and the upsert re-points
// the single fixed project row at that owner rather than piling up rows.
function seedSql(parcels, sub) {
  return `INSERT INTO bng.projects (id, user_id, relationship_id, org_id, project)
VALUES ('${PROJECT_ID}', '${sub}', NULL, NULL,
  jsonb_build_object(
    'name', 'BMD-933 perf big baseline',
    'baseline', jsonb_build_object('habitats', (
      SELECT jsonb_agg(jsonb_build_object(
        'featureId', gen_random_uuid(),
        'parcelRef', 'p' || g,
        'habitat', 'Mixed scrub',
        'areaHectares', 0.5,
        'condition', 'Moderate'
      )) FROM generate_series(1, ${parcels}) g))))
ON CONFLICT (id) DO UPDATE
  SET user_id = EXCLUDED.user_id, project = EXCLUDED.project, updated_at = now();`;
}

async function seedBigProject(sub) {
  const container = await findPostgresContainer();
  if (!container) {
    error(
      `Could not find a running Postgres container (image ${cfg.postgresImage}). Is the Tilt stack up?`,
    );
    return false;
  }
  info(`▸ seeding a ${cfg.parcels}-parcel baseline project for ${sub} (idempotent upsert)…`);
  const code = await run("docker", [
    "exec",
    "-i",
    container,
    "psql",
    "-U",
    "dev",
    "-d",
    "bng_metric_backend",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    seedSql(cfg.parcels, sub),
  ]);
  if (code !== 0) {
    error("Seeding failed — see psql output above.");
    return false;
  }
  return true;
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

// JMeter writes the JTL as quoted CSV whose failureMessage can contain commas
// AND newlines (multi-line assertion messages), so records cannot be found by
// splitting the file on "\n" — the quote state must carry across line breaks.
// One character walk over the whole file yields the true records.
function parseCsvRecords(text) {
  const records = [];
  let fields = [];
  let field = "";
  let inQuotes = false;

  const endField = () => {
    fields.push(field);
    field = "";
  };
  const endRecord = () => {
    endField();
    records.push(fields);
    fields = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      endField();
    } else if (ch === "\n" && !inQuotes) {
      endRecord();
    } else if (ch !== "\r" || inQuotes) {
      field += ch;
    }
  }
  if (field.length > 0 || fields.length > 0) {
    endRecord();
  }
  return records;
}

function accumulateSample(perLabel, f, cols) {
  const label = f[cols.iLabel];
  const ok = f[cols.iSuccess] === "true";
  const entry = perLabel.get(label) ?? { total: 0, failed: 0, messages: new Set() };
  entry.total += 1;
  if (!ok) {
    entry.failed += 1;
    if (cols.iMsg >= 0 && f[cols.iMsg]) {
      // Multi-line assertion messages print as one line in the summary.
      entry.messages.add(f[cols.iMsg].replaceAll(/\s+/g, " ").trim());
    }
  }
  perLabel.set(label, entry);
  return ok;
}

function printPerfResults(scenarioName, perLabel) {
  header(`Perf results (${scenarioName})`);
  for (const [label, e] of perLabel) {
    const status =
      e.failed === 0
        ? color("green", "PASS")
        : color("red", `FAIL (${e.failed}/${e.total})`);
    console.log(`  ${status}  ${label}`);
    for (const msg of e.messages) {
      console.log(color("dim", `        ↳ ${msg}`));
    }
  }
}

function summariseJtl(scenarioName, outDir) {
  const jtlPath = path.join(outDir, "out.jtl");
  if (!existsSync(jtlPath)) {
    error("No JTL produced — the JMeter run did not complete.");
    return { total: 0, failed: 0 };
  }
  const records = parseCsvRecords(readFileSync(jtlPath, "utf8"));
  if (records.length === 0) {
    error("The JTL was empty — the JMeter run did not produce samples.");
    return { total: 0, failed: 0 };
  }
  const headerCols = records[0];
  const cols = {
    iLabel: headerCols.indexOf("label"),
    iSuccess: headerCols.indexOf("success"),
    iMsg: headerCols.indexOf("failureMessage"),
  };

  const perLabel = new Map();
  let total = 0;
  let failed = 0;
  for (const record of records.slice(1)) {
    const ok = accumulateSample(perLabel, record, cols);
    total += 1;
    if (!ok) {
      failed += 1;
    }
  }

  printPerfResults(scenarioName, perLabel);
  return { total, failed };
}

// Any authenticated scenario needs a real stub token (accepted by the backend)
// and the seeded project its assertions exercise. Returns { idToken, sub }.
async function prepareAuthAndSeed() {
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

  if (!(await seedBigProject(sub))) {
    process.exit(1);
  }
  return { idToken, sub };
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
    `${failed}/${total} samples failed their assertions. A suite that encodes ` +
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
    ? await prepareAuthAndSeed()
    : { idToken: null, sub: null };

  const outRoot = path.join(HARNESS_ROOT, ".perf", "perf-out");
  rmSync(outRoot, { recursive: true, force: true });

  let total = 0;
  let failed = 0;
  for (const scenario of scenarios) {
    const outDir = path.join(outRoot, scenario.name);
    mkdirSync(outDir, { recursive: true });
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
    const result = summariseJtl(scenario.name, outDir);
    info(`Report: ${path.join(outDir, "report", "index.html")}`);
    total += result.total;
    failed += result.failed;
  }

  reportOutcome(total, failed);
}

main().catch((err) => {
  error(err.stack ?? String(err));
  process.exit(1);
});
