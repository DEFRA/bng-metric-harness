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

const target = parseTarget(process.argv.slice(2));

if (target === "all") {
  for (const repo of REPOS) requireSibling(repo.name);

  const { default: concurrently } = await import("concurrently");

  header("dev: fe + be (concurrently)", "green");

  const { result } = concurrently(
    REPOS.map((r) => ({
      name: r.key,
      command: `${npmBin} run dev`,
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
  header(`dev: ${repo.name}`, repo.color);
  info(`  cwd: ${repoPath(repo.name)}`);
  const code = await run(npmBin, ["run", "dev"], { cwd: repoPath(repo.name) });
  process.exit(code);
}
