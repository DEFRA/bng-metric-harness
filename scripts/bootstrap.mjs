import {
  REPOS,
  SUPPORT_REPOS,
  WORKSPACE_ROOT,
  exists,
  header,
  info,
  run,
  warn,
} from "./_lib.mjs";

// Clones `repo` beside the harness unless it is already there. Resolves to
// true when the repo is present afterwards.
async function ensureCloned(repo) {
  header(`bootstrap: ${repo.name}`, repo.color);
  if (exists(repo.name)) {
    info(`  already present, skipping clone`);
    return true;
  }
  info(`  cloning ${repo.remote}`);
  const code = await run("git", ["clone", repo.remote, repo.name], {
    cwd: WORKSPACE_ROOT,
  });
  if (code !== 0) {
    warn(`clone failed for ${repo.name} (exit ${code})`);
    return false;
  }
  return true;
}

async function failedClones(repos) {
  const failed = [];
  for (const repo of repos) {
    if (!(await ensureCloned(repo))) {
      failed.push(repo.name);
    }
  }
  return failed;
}

// Only the core repos decide the exit code: install, dev, lint and test need
// them. A support repo the developer cannot clone (no access, say) is reported
// but does not fail the bootstrap.
const coreFailures = await failedClones(REPOS);
const supportFailures = await failedClones(SUPPORT_REPOS);

if (supportFailures.length > 0) {
  info("");
  warn(
    `Could not clone ${supportFailures.join(", ")}. The core repos do not ` +
      "need them; re-run `npm run bootstrap` once you have access to use the " +
      "commands that do.",
  );
}

if (coreFailures.length > 0) {
  process.exit(1);
}

info("\nCore siblings present. Next: `npm run install:all`.");
