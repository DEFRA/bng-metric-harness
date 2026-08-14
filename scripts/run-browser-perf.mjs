// Run the browser-driven BMD-911 perf test (bng-perf-tests/browser-perf) against
// a DEPLOYED CDP environment, from the workspace root. Convenience only: it
// resolves the sibling, installs the suite's deps + Chromium on first use, hands
// it the Defra ID test-account credentials, and runs it.
//
//   npm run perf:browser -- --cdp-env=dev        # → CDP dev (deployed)
//   npm run perf:browser -- --base-url=https://…  # explicit deployed URL
//
// It deliberately refuses localhost: browser-perf drives the REAL Defra ID login,
// whose pages differ from the local cdp-defra-id-stub, so it cannot run against a
// Tilt/compose stack. For a LOCAL BMD-911 check use the JMeter scenario instead:
//   PERF_SCENARIO=baseline-overlap-scaling npm run perf
import { existsSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  error,
  HARNESS_ROOT,
  header,
  info,
  loadEnvFile,
  npmBin,
  repoPath,
  requireSibling,
  run,
  warn,
} from "./_lib.mjs";

// The real Defra ID test-account secrets browser-perf signs in with — the same
// names the journey-tests use in e2e mode. Never logged, only forwarded.
const CRED_KEYS = ["DEFRA_ID_USERNAME", "DEFRA_ID_PASSWORD"];
const LOCALHOST_PATTERN = /localhost|127\.0\.0\.1|\[::1\]/i;
const npxBin = process.platform === "win32" ? "npx.cmd" : "npx";

// The local stack's frontend and the cdp-defra-id-stub login it uses.
const LOCAL_FRONTEND_URL = "http://localhost:3000";

const USAGE = `Usage: npm run perf:browser -- (--cdp-env=<env> | --base-url=<url> | --local) [--reinstall]

Runs bng-perf-tests/browser-perf (Playwright) — the BMD-911 perf test — against a
deployed CDP environment (real Defra ID) or the local stack (cdp-defra-id-stub).

  --cdp-env=<env>   deployed CDP env; frontend URL derived as
                    https://bng-metric-frontend.<env>.cdp-int.defra.cloud
                    (perf-test and other real-B2C envs use the real Defra ID login)
  --base-url=<url>  target an explicit deployed frontend URL instead
  --local           run against the LOCAL stack (${LOCAL_FRONTEND_URL}) using the
                    cdp-defra-id-stub login — no Defra ID credentials needed. The
                    frontend + backend compose stack must be up (e.g. npm run dev).
  --reinstall       force npm install + playwright install in browser-perf
  -h, --help        show this help

Credentials (real mode only): DEFRA_ID_USERNAME / DEFRA_ID_PASSWORD are read from
the environment, then the harness root .env, then bng-metric-backend/.env.`;

const { values: args } = parseArgs({
  options: {
    "cdp-env": { type: "string", default: "" },
    "base-url": { type: "string", default: "" },
    local: { type: "boolean", default: false },
    reinstall: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: false,
});

function refuseLocalhost(url) {
  error(`Refusing to run browser-perf against ${url}.`);
  info("  browser-perf drives the REAL Defra ID login, whose pages differ from");
  info("  the local cdp-defra-id-stub — it can't run against your Tilt stack.");
  info("  For a local BMD-911 check use the JMeter scenario instead:");
  info("    PERF_SCENARIO=baseline-overlap-scaling npm run perf");
  process.exit(1);
}

// Turn the flags into the env vars browser-perf/env.js reads. Exactly one of
// --base-url / --cdp-env must be given, and neither may point at localhost.
function resolveTarget() {
  const baseUrl = args["base-url"].trim();
  const cdpEnv = args["cdp-env"].trim();
  if (baseUrl && cdpEnv) {
    error("Pass only one of --base-url or --cdp-env.");
    process.exit(1);
  }
  if (baseUrl) {
    if (LOCALHOST_PATTERN.test(baseUrl)) {
      refuseLocalhost(baseUrl);
    }
    return { env: { BASE_URL: baseUrl }, label: baseUrl };
  }
  if (cdpEnv) {
    if (LOCALHOST_PATTERN.test(cdpEnv)) {
      refuseLocalhost(cdpEnv);
    }
    return {
      env: { ENVIRONMENT: cdpEnv },
      label: `bng-metric-frontend.${cdpEnv}.cdp-int.defra.cloud (CDP ${cdpEnv})`,
    };
  }
  error("Specify a deployed target: --cdp-env=<env> (e.g. dev) or --base-url=<url>.");
  info("  browser-perf runs against a DEPLOYED CDP environment, never localhost.");
  process.exit(1);
  return null; // unreachable; keeps the return type explicit
}

// DEFRA_ID_* from the environment, then the harness root .env, then the backend
// .env — the same precedence the B2C dev flow uses. Values are never logged.
function resolveCredentials() {
  const creds = {};
  for (const key of CRED_KEYS) {
    if (process.env[key]) {
      creds[key] = process.env[key];
    }
  }
  if (CRED_KEYS.every((key) => creds[key])) {
    info("▸ using DEFRA_ID_* from the environment");
    return creds;
  }
  const sources = [
    path.join(HARNESS_ROOT, ".env"),
    path.join(repoPath("bng-metric-backend"), ".env"),
  ];
  for (const source of sources) {
    const parsed = loadEnvFile(source);
    if (!parsed) {
      continue;
    }
    for (const key of CRED_KEYS) {
      if (!creds[key] && parsed[key]) {
        creds[key] = parsed[key];
      }
    }
    if (CRED_KEYS.every((key) => creds[key])) {
      info(`▸ using DEFRA_ID_* from ${source}`);
      return creds;
    }
  }
  error("DEFRA_ID_USERNAME and DEFRA_ID_PASSWORD are required (the real Defra ID test account).");
  info("  Set them in your shell, the harness root .env, or bng-metric-backend/.env.");
  process.exit(1);
  return null; // unreachable
}

// Install the suite's deps + the Chromium browser Playwright drives, but only on
// first use (or --reinstall) — both are no-ops to repeat but slow.
async function ensureDeps(browserPerfDir) {
  const installed = existsSync(path.join(browserPerfDir, "node_modules"));
  if (installed && !args.reinstall) {
    return;
  }
  header("Preparing browser-perf (first run)");
  const installCode = await run(npmBin, ["install"], { cwd: browserPerfDir });
  if (installCode !== 0) {
    error("npm install failed in browser-perf.");
    process.exit(installCode);
  }
  info("▸ installing the Chromium browser Playwright drives…");
  const browserCode = await run(npxBin, ["playwright", "install", "chromium"], {
    cwd: browserPerfDir,
  });
  if (browserCode !== 0) {
    error("`playwright install chromium` failed.");
    process.exit(browserCode);
  }
}

async function main() {
  if (args.help) {
    console.log(USAGE);
    process.exit(0);
  }

  requireSibling("bng-perf-tests");
  const browserPerfDir = path.join(repoPath("bng-perf-tests"), "browser-perf");
  if (!existsSync(browserPerfDir)) {
    error(`No browser-perf/ at ${browserPerfDir}.`);
    info("  → Check bng-perf-tests is on the BMD-911 branch (BMD-911-overlap-scaling-perf-test).");
    process.exit(1);
  }

  // Local stub mode drives the cdp-defra-id-stub login against the compose stack
  // — no deployed target, no Defra ID credentials, no egress proxy.
  let target;
  let creds = {};
  if (args.local) {
    const baseUrl = args["base-url"].trim() || LOCAL_FRONTEND_URL;
    target = {
      env: { BASE_URL: baseUrl, PERF_LOGIN_MODE: "stub" },
      label: `${baseUrl} (local, cdp-defra-id-stub login)`,
    };
    info("▸ local mode: stub login — no Defra ID credentials needed");
    info("  (the frontend + backend compose stack must be running)");
  } else {
    target = resolveTarget();
    creds = resolveCredentials();
    if (!process.env.HTTPS_PROXY && !process.env.HTTP_PROXY) {
      warn(
        "No HTTPS_PROXY/HTTP_PROXY set — the external Defra ID login may be unreachable " +
          "without the platform egress proxy.",
      );
    }
  }

  await ensureDeps(browserPerfDir);

  header(`Running browser-perf against ${target.label}`);
  const env = { ...process.env, ...target.env, ...creds };
  const code = await run(npmBin, ["run", "perf"], {
    cwd: browserPerfDir,
    env,
  });
  process.exit(code);
}

main();
