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

async function pullIn(label, cwd, colorName) {
  header(`pull: ${label}`, colorName);
  const code = await run("git", ["pull", "--ff-only"], { cwd });
  if (code !== 0) {
    warn(
      `fast-forward failed in ${label} — diverged or local changes; skipping`,
    );
  }
}

await pullIn("bng-metric-harness", HARNESS_ROOT, "green");

for (const repo of REPOS) {
  if (!exists(repo.name)) {
    header(`pull: ${repo.name}`, repo.color);
    warn(`not present — run \`npm run bootstrap\``);
    continue;
  }
  await pullIn(repo.name, repoPath(repo.name), repo.color);
}

info("");
