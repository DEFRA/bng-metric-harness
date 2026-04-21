import {
  HARNESS_ROOT,
  header,
  info,
  npmBin,
  parseTarget,
  repoPath,
  reposForTarget,
  requireSibling,
  run,
} from "./_lib.mjs";

const target = parseTarget(process.argv.slice(2));

if (target === "all") {
  header("install: bng-metric-harness", "green");
  const code = await run(npmBin, ["install"], { cwd: HARNESS_ROOT });
  if (code !== 0) process.exit(code);
}

for (const repo of reposForTarget(target)) {
  header(`install: ${repo.name}`, repo.color);
  requireSibling(repo.name);
  const code = await run(npmBin, ["install"], { cwd: repoPath(repo.name) });
  if (code !== 0) process.exit(code);
}

info("\nDone.");
