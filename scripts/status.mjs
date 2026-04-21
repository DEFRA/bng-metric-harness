import {
  HARNESS_ROOT,
  REPOS,
  exists,
  header,
  info,
  repoPath,
  run,
  warn,
} from "./_lib.mjs";

header("status: bng-metric-harness (this repo)", "green");
await run("git", ["status", "--short"], { cwd: HARNESS_ROOT });

for (const repo of REPOS) {
  header(`status: ${repo.name}`, repo.color);
  if (!exists(repo.name)) {
    warn(`not present at ${repoPath(repo.name)} — run \`npm run bootstrap\``);
    continue;
  }
  await run("git", ["status", "--short"], { cwd: repoPath(repo.name) });
}

info("");
