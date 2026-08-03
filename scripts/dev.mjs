import path from "node:path";

import {
  HARNESS_ROOT,
  REPOS,
  header,
  info,
  loadEnvFile,
  npmBin,
  parseTarget,
  repoPath,
  requireSibling,
  run,
  warn,
} from "./_lib.mjs";

const args = process.argv.slice(2);
const b2c = args.includes("--b2c");
const target = parseTarget(args.filter((a) => !a.startsWith("--")));

// Real Defra ID (B2C) login only differs for the frontend, which must run with
// OIDC_USE_STUB=false (its dev:b2c script) — otherwise its own dev script's
// cross-env pins the stub on. The backend reads its B2C verification config
// (OIDC_DISCOVERY_URL / OIDC_AUDIENCE / OIDC_ISSUER) from the environment, so it
// runs the same dev script either way.
const devScript = (repo) => (b2c && repo.key === "fe" ? "dev:b2c" : "dev");

// The frontend is where B2C login actually happens (OIDC_CLIENT_ID / SECRET /
// REDIRECT_URI), but unlike the backend it has no `dotenv` dependency and never
// passes `node --env-file`, so it cannot read a .env of its own. Rather than add
// env-loading to a sibling, the harness reads one shared .env and injects it into
// both children — the same thing a JetBrains run configuration does.
const B2C_ENV_CANDIDATES = [
  path.join(HARNESS_ROOT, ".env"),
  path.join(repoPath("bng-metric-backend"), ".env"),
];

function loadB2cEnv() {
  for (const candidate of B2C_ENV_CANDIDATES) {
    const parsed = loadEnvFile(candidate);
    const keys = parsed ? Object.keys(parsed) : [];
    if (keys.length === 0) {
      continue;
    }
    info(`  env file: ${candidate}`);
    info(`  injecting: ${keys.join(", ")}`);
    return parsed;
  }

  warn("--b2c requested but no .env with any values was found. Looked in:");
  for (const candidate of B2C_ENV_CANDIDATES) {
    warn(`    ${candidate}`);
  }
  warn("  Frontend will fall back to stub defaults and B2C login will fail.");
  return {};
}

// File wins over ambient env so the .env is the single source of truth for B2C.
// The FE/BE dev scripts' own cross-env values (e.g. OIDC_USE_STUB=false) are set
// downstream of this and still take precedence, which is what we want.
// Called after the header so its logging lands under the banner, not above it.
const buildChildEnv = () =>
  b2c ? { ...process.env, ...loadB2cEnv() } : process.env;

if (target === "all") {
  for (const repo of REPOS) requireSibling(repo.name);

  const { default: concurrently } = await import("concurrently");

  header(`dev: fe + be (concurrently)${b2c ? " [B2C]" : ""}`, "green");

  const childEnv = buildChildEnv();

  const { result } = concurrently(
    REPOS.map((r) => ({
      name: r.key,
      command: `${npmBin} run ${devScript(r)}`,
      cwd: repoPath(r.name),
      env: childEnv,
      prefixColor: r.color,
    })),
    {
      killOthers: ["failure", "success"],
      prefix: "name",
      prefixColors: REPOS.map((r) => r.color).join(","),
    },
  );

  try {
    await result;
  } catch (events) {
    const code = Array.isArray(events)
      ? (events.find((e) => e?.exitCode && e.exitCode !== 0)?.exitCode ?? 1)
      : 1;
    process.exit(typeof code === "number" ? code : 1);
  }
} else {
  const repo = REPOS.find((r) => r.key === target);
  requireSibling(repo.name);
  header(`dev: ${repo.name}${b2c ? " [B2C]" : ""}`, repo.color);
  info(`  cwd: ${repoPath(repo.name)}`);
  const code = await run(npmBin, ["run", devScript(repo)], {
    cwd: repoPath(repo.name),
    env: buildChildEnv(),
  });
  process.exit(code);
}
