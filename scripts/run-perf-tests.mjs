// Run the JMeter perf suite against the locally-running backend. Invoked by
// `npm run perf` — no Tilt resource, no perf mode. Just `tilt up` then this.
//
// The suite targets BMD-933 (bng-perf-tests/scenarios/project-list-payload.jmx):
// the project list endpoints ship the whole project document. To exercise them we
// need (a) a token the backend accepts and (b) a project with a big baseline:
//
//   1. Get a REAL token from the cdp-defra-id-stub (scripts/get-stub-token.mjs) —
//      the same login the app does, just headless. The normal `tilt up` backend
//      already trusts stub tokens, so there is no backend change and no perf mode.
//   2. Idempotently seed one big-baseline project owned by that token's sub,
//      straight into Postgres (fixed id + ON CONFLICT, so re-runs don't pile up).
//   3. Run JMeter (the multi-arch alpine/jmeter image) against the backend and
//      summarise the assertion results.
//
// Pre-fix, the assertions FAIL by design — they encode the BMD-933 acceptance
// criteria. That is reported clearly and does not fail the run unless
// PERF_FAIL_ON_ASSERT is set (so CI can gate on it once the fix lands).
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
  runCapture,
  warn,
} from "./_lib.mjs";
import { getStubToken } from "./get-stub-token.mjs";

const cfg = {
  host: process.env.PERF_BACKEND_HOST ?? "localhost",
  port: process.env.PERF_BACKEND_PORT ?? "3001",
  parcels: Number(process.env.PERF_PARCELS ?? "2000"),
  threads: process.env.PERF_THREADS ?? "5",
  loops: process.env.PERF_LOOPS ?? "3",
  ramp: process.env.PERF_RAMP ?? "2",
  scenario: process.env.PERF_SCENARIO ?? "project-list-payload",
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

const baseUrl = `http://${cfg.host}:${cfg.port}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Containers reach the host's backend via host.docker.internal; on Linux that
// name needs the explicit host-gateway mapping (harmless on Docker Desktop).
const isLocalHost = cfg.host === "localhost" || cfg.host === "127.0.0.1";
const jmeterDomain = isLocalHost ? "host.docker.internal" : cfg.host;

async function waitForHealth() {
  for (let attempt = 1; attempt <= HEALTH_ATTEMPTS; attempt += 1) {
    try {
      const res = await fetch(`${baseUrl}/health`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (res.ok) {
        info(`▸ backend healthy at ${baseUrl}`);
        return true;
      }
    } catch {
      // not up yet — fall through to retry
    }
    await sleep(HEALTH_INTERVAL_MS);
  }
  error(`Backend never became healthy at ${baseUrl}/health`);
  return false;
}

// Probe the list endpoint with the token. A 401 means the backend rejected it
// (e.g. the stub issued something the backend won't accept).
async function probeAuth(token) {
  try {
    const res = await fetch(`${baseUrl}/projects`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    return res.status;
  } catch (err) {
    error(`Could not reach ${baseUrl}/projects: ${err.message}`);
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

// A fresh stub user (new `sub`) is registered each run, so the upsert re-points
// the single fixed project row at the current owner rather than piling up rows.
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

async function runJmeter(token, sub, outDir) {
  const scenariosDir = path.join(repoPath("bng-perf-tests"), "scenarios");
  // Hand the token to JMeter via a properties file (-q) rather than a
  // -JbearerToken= arg, so the secret never lands in the container's process
  // args (visible to `ps`) or in the Tilt logs. The file lives in the gitignored
  // .perf/ output dir and is deleted right after the run.
  const propsPath = path.join(outDir, "perf.properties");
  writeFileSync(propsPath, `bearerToken=${token}\n`);
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
      `/scenarios/${cfg.scenario}.jmx`,
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
      `-Jport=${cfg.port}`,
      `-JuserId=${sub}`,
      `-Jthreads=${cfg.threads}`,
      `-Jloops=${cfg.loops}`,
      `-JrampSeconds=${cfg.ramp}`,
    ]);
  } finally {
    rmSync(propsPath, { force: true });
  }
}

// Minimal RFC-4180-ish CSV line splitter — JMeter quotes fields containing commas
// (assertion messages do), so a naive split would mangle failureMessage.
function parseCsvLine(line) {
  const fields = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(field);
      field = "";
    } else {
      field += ch;
    }
  }
  fields.push(field);
  return fields;
}

function summariseJtl(outDir) {
  const jtlPath = path.join(outDir, "out.jtl");
  if (!existsSync(jtlPath)) {
    error("No JTL produced — the JMeter run did not complete.");
    return { total: 0, failed: 0 };
  }
  const lines = readFileSync(jtlPath, "utf8").trim().split("\n");
  const cols = parseCsvLine(lines[0]);
  const idx = (name) => cols.indexOf(name);
  const iLabel = idx("label");
  const iSuccess = idx("success");
  const iMsg = idx("failureMessage");

  const perLabel = new Map();
  let total = 0;
  let failed = 0;
  for (const line of lines.slice(1)) {
    const f = parseCsvLine(line);
    const label = f[iLabel];
    const ok = f[iSuccess] === "true";
    total += 1;
    if (!ok) {
      failed += 1;
    }
    const entry = perLabel.get(label) ?? { total: 0, failed: 0, messages: new Set() };
    entry.total += 1;
    if (!ok) {
      entry.failed += 1;
      if (iMsg >= 0 && f[iMsg]) {
        entry.messages.add(f[iMsg]);
      }
    }
    perLabel.set(label, entry);
  }

  header("Perf results (BMD-933)");
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
  return { total, failed };
}

async function main() {
  requireSibling("bng-perf-tests");

  if (!(await waitForHealth())) {
    process.exit(1);
  }

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
    error(`Unexpected status ${status} from ${baseUrl}/projects — aborting.`);
    process.exit(1);
  }
  info("▸ token accepted by the backend");

  if (!(await seedBigProject(sub))) {
    process.exit(1);
  }

  const outDir = path.join(HARNESS_ROOT, ".perf", "perf-out");
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  header(`Running JMeter (${cfg.scenario}) against ${baseUrl}`);
  const jmeterCode = await runJmeter(idToken, sub, outDir);
  if (jmeterCode !== 0) {
    warn(`JMeter exited ${jmeterCode} — this is expected while assertions fail.`);
  }

  const { total, failed } = summariseJtl(outDir);
  console.log("");
  info(`Report: ${path.join(outDir, "report", "index.html")}`);

  if (failed > 0) {
    warn(
      `${failed}/${total} samples failed the BMD-933 assertions. This is EXPECTED ` +
        "until the list endpoints are fixed — the suite encodes the acceptance criteria.",
    );
    if (cfg.failOnAssert) {
      process.exit(1);
    }
  } else if (total > 0) {
    console.log(color("green", `✔ All ${total} samples passed — BMD-933 looks fixed.`));
  }
}

main().catch((err) => {
  error(err.stack ?? String(err));
  process.exit(1);
});
