import {
  REPOS,
  WORKSPACE_ROOT,
  exists,
  header,
  info,
  run,
  warn,
} from "./_lib.mjs";

let failures = 0;

for (const repo of REPOS) {
  header(`bootstrap: ${repo.name}`, repo.color);
  if (exists(repo.name)) {
    info(`  already present, skipping clone`);
    continue;
  }
  info(`  cloning ${repo.remote}`);
  const code = await run("git", ["clone", repo.remote, repo.name], {
    cwd: WORKSPACE_ROOT,
  });
  if (code !== 0) {
    warn(`clone failed for ${repo.name} (exit ${code})`);
    failures++;
  }
}

if (failures > 0) {
  process.exit(1);
}

info("\nAll siblings present. Next: `npm run install:all`.");
