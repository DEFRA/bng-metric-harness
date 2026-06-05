import {
  REPOS,
  error,
  header,
  info,
  packageManagerFor,
  repoPath,
  requireSibling,
  run,
} from "./_lib.mjs";

const [target, ...rest] = process.argv.slice(2);

const repo = REPOS.find((r) => r.key === target);
if (!repo) {
  error(`Usage: node scripts/proxy.mjs <fe|be> -- <script> [args...]`);
  process.exit(1);
}

if (rest.length === 0) {
  error(`No script provided. Example: npm run ${target} -- test`);
  process.exit(1);
}

requireSibling(repo.name);

const pm = packageManagerFor(repo.name);

header(`${repo.name}: ${pm} run ${rest.join(" ")}`, repo.color);
info(`  cwd: ${repoPath(repo.name)}`);

const code = await run(pm, ["run", ...rest], { cwd: repoPath(repo.name) });
process.exit(code);
