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

const [target, ...rest] = process.argv.slice(2);

const repo = REPOS.find((r) => r.key === target);
if (!repo) {
  error(`Usage: node scripts/proxy.mjs <fe|be> -- <npm script> [args...]`);
  process.exit(1);
}

if (rest.length === 0) {
  error(`No npm script provided. Example: npm run ${target} -- test`);
  process.exit(1);
}

requireSibling(repo.name);

header(`${repo.name}: npm run ${rest.join(" ")}`, repo.color);
info(`  cwd: ${repoPath(repo.name)}`);

const code = await run(npmBin, ["run", ...rest], { cwd: repoPath(repo.name) });
process.exit(code);
