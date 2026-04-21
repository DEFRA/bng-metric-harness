import { readFileSync } from "node:fs";
import path from "node:path";
import {
  REPOS,
  error,
  header,
  info,
  npmBin,
  repoPath,
  requireSibling,
  run,
} from "./_lib.mjs";

const results = [];

for (const repo of REPOS) {
  header(`lint: ${repo.name}`, repo.color);
  requireSibling(repo.name);

  const cwd = repoPath(repo.name);
  const pkg = JSON.parse(readFileSync(path.join(cwd, "package.json"), "utf8"));

  if (!pkg.scripts?.lint) {
    info("  no `lint` script, skipping");
    results.push({ repo: repo.name, code: 0, skipped: true });
    continue;
  }

  const code = await run(npmBin, ["run", "lint"], { cwd });
  results.push({ repo: repo.name, code, skipped: false });
}

header("lint: summary", "green");
let anyFailed = false;
for (const r of results) {
  if (r.skipped) info(`  ${r.repo}: skipped (no lint script)`);
  else if (r.code === 0) info(`  ${r.repo}: ok`);
  else {
    error(`  ${r.repo}: failed (exit ${r.code})`);
    anyFailed = true;
  }
}

process.exit(anyFailed ? 1 : 0);
