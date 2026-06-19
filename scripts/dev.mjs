import {
  REPOS,
  header,
  info,
  npmBin,
  parseTarget,
  repoPath,
  requireSibling,
  run,
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

if (target === "all") {
  for (const repo of REPOS) requireSibling(repo.name);

  const { default: concurrently } = await import("concurrently");

  header(`dev: fe + be (concurrently)${b2c ? " [B2C]" : ""}`, "green");

  const { result } = concurrently(
    REPOS.map((r) => ({
      name: r.key,
      command: `${npmBin} run ${devScript(r)}`,
      cwd: repoPath(r.name),
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
  });
  process.exit(code);
}
