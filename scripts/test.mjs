import { readFileSync } from "node:fs";
import path from "node:path";
import {
  error,
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
const results = [];

for (const repo of reposForTarget(target)) {
  header(`test: ${repo.name}`, repo.color);
  requireSibling(repo.name);

  const cwd = repoPath(repo.name);
  const pkg = JSON.parse(readFileSync(path.join(cwd, "package.json"), "utf8"));

  if (!pkg.scripts?.test) {
    info("  no `test` script, skipping");
    results.push({ repo: repo.name, code: 0, skipped: true });
    continue;
  }

  const code = await run(npmBin, ["test"], { cwd });
  results.push({ repo: repo.name, code, skipped: false });
}

header("test: summary", "green");
let anyFailed = false;
for (const r of results) {
  if (r.skipped) info(`  ${r.repo}: skipped (no test script)`);
  else if (r.code === 0) info(`  ${r.repo}: ok`);
  else {
    error(`  ${r.repo}: failed (exit ${r.code})`);
    anyFailed = true;
  }
}

process.exit(anyFailed ? 1 : 0);
