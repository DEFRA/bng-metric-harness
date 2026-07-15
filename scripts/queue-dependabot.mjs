// Sweep the BNG repos for Dependabot PRs that the per-repo auto-merge
// workflow has already vetted (approved + armed + green) and add them to the
// merge queue as *you*.
//
// Why this exists: the auto-merge workflows arm Dependabot PRs with the
// GitHub Actions GITHUB_TOKEN, and GitHub deliberately ignores bot-armed
// auto-merge when a merge queue is required (recursive-trigger protection:
// https://github.com/orgs/community/discussions/70310). A real user's
// enqueue works, so a developer runs this once a day:
//
//   npm run queue-deps                     # enqueue everything eligible
//   npm run queue-deps -- --dry-run
//   npm run queue-deps -- backend          # one repo only (name substring)
//
// Requires the GitHub CLI (`gh`) authenticated as a user with write access.

import { color, error, header, info, runCapture, warn } from "./_lib.mjs";

const OWNER = "DEFRA";
const GITHUB_REPOS = [
  "bng-metric-frontend",
  "bng-metric-backend",
  "bng-metric-digital-prototype",
  "bng-library",
  "bng-metric-journey-tests",
];

const PR_LIST_FIELDS = [
  "id",
  "number",
  "title",
  "isDraft",
  "reviewDecision",
  "autoMergeRequest",
  "statusCheckRollup",
].join(",");

// `gh pr merge` cannot do this: on a queue-protected branch it only arms
// auto-merge, which is a silent no-op when the PR is already armed (by the
// workflow's bot token) — the PR never reaches the queue. The GraphQL
// mutation is the only direct "add to the queue now" API, and its response
// proves the enqueue actually happened.
const ENQUEUE_MUTATION = `
  mutation ($prId: ID!) {
    enqueuePullRequest(input: { pullRequestId: $prId }) {
      mergeQueueEntry { position }
    }
  }
`;

// Check runs report `conclusion`, commit statuses report `state`; any of
// these values means that item is not blocking a merge.
const PASSING_CHECK_RESULTS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

async function gh(args) {
  const { code, stdout, stderr } = await runCapture("gh", args);
  if (code !== 0) {
    throw new Error(stderr.trim() || `gh exited with code ${code}`);
  }
  return stdout;
}

function checksAreGreen(rollup) {
  if (!rollup || rollup.length === 0) {
    return false;
  }
  return rollup.every((item) =>
    PASSING_CHECK_RESULTS.has(item.conclusion || item.state),
  );
}

// A PR qualifies when the repo's Dependabot auto-merge workflow has already
// applied its policy (patch/minor only → approved + armed) and CI is green.
// Anything else is skipped with the reason, never merged by force.
function skipReason(pr) {
  if (pr.isDraft) {
    return "draft";
  }
  if (!pr.autoMergeRequest) {
    return "not armed by the auto-merge workflow (major bump?)";
  }
  if (pr.reviewDecision !== "APPROVED") {
    return `review decision is ${pr.reviewDecision || "pending"}`;
  }
  if (!checksAreGreen(pr.statusCheckRollup)) {
    return "checks are not all green";
  }
  return null;
}

async function enqueue(pr, dryRun) {
  const label = `#${pr.number} ${pr.title}`;
  if (dryRun) {
    info(`  would enqueue ${label}`);
    return "enqueued";
  }
  try {
    const stdout = await gh([
      "api",
      "graphql",
      "-f",
      `query=${ENQUEUE_MUTATION}`,
      "-f",
      `prId=${pr.id}`,
    ]);
    const entry =
      JSON.parse(stdout).data.enqueuePullRequest.mergeQueueEntry ?? null;
    if (!entry) {
      error(`  enqueue of ${label} returned no queue entry — check manually`);
      return "failed";
    }
    console.log(
      color("green", `  ✓ enqueued ${label} (position ${entry.position})`),
    );
    return "enqueued";
  } catch (err) {
    if (/already.*(queue|queued)/i.test(err.message)) {
      info(`  skipping ${label} — already in the merge queue`);
      return "skipped";
    }
    error(`  failed to enqueue ${label}: ${err.message}`);
    return "failed";
  }
}

async function processRepo(repo, dryRun) {
  header(`${OWNER}/${repo}`);
  let prs;
  try {
    const stdout = await gh([
      "pr",
      "list",
      "--repo",
      `${OWNER}/${repo}`,
      "--author",
      "app/dependabot",
      "--state",
      "open",
      "--json",
      PR_LIST_FIELDS,
    ]);
    prs = JSON.parse(stdout);
  } catch (err) {
    error(`  could not list PRs: ${err.message}`);
    return { enqueued: 0, failed: 1 };
  }

  if (prs.length === 0) {
    info("  no open Dependabot PRs");
    return { enqueued: 0, failed: 0 };
  }

  const counts = { enqueued: 0, skipped: 0, failed: 0 };
  for (const pr of prs) {
    const reason = skipReason(pr);
    if (reason) {
      info(`  skipping #${pr.number} ${pr.title} — ${reason}`);
      counts.skipped += 1;
      continue;
    }
    const outcome = await enqueue(pr, dryRun);
    counts[outcome] += 1;
  }
  return { enqueued: counts.enqueued, failed: counts.failed };
}

const CLI_ARGS_START = 2;

function selectRepos(filters) {
  if (filters.length === 0) {
    return GITHUB_REPOS;
  }
  const selected = GITHUB_REPOS.filter((repo) =>
    filters.some((f) => repo.includes(f)),
  );
  if (selected.length === 0) {
    error(`No repo matches "${filters.join(", ")}".`);
    info(`  → Known repos: ${GITHUB_REPOS.join(", ")}`);
    process.exit(1);
  }
  return selected;
}

async function main() {
  const args = process.argv.slice(CLI_ARGS_START);
  const dryRun = args.includes("--dry-run");
  const repos = selectRepos(args.filter((a) => !a.startsWith("--")));
  if (dryRun) {
    warn("dry run — nothing will be enqueued");
  }

  try {
    await gh(["auth", "status"]);
  } catch (err) {
    error(`GitHub CLI is not ready: ${err.message}`);
    info("  → Install gh and run `gh auth login` first.");
    process.exit(1);
  }

  let enqueued = 0;
  let failed = 0;
  for (const repo of repos) {
    const result = await processRepo(repo, dryRun);
    enqueued += result.enqueued;
    failed += result.failed;
  }

  header("summary", "green");
  console.log(
    `  ${enqueued} PR(s) ${dryRun ? "would be " : ""}enqueued, ${failed} failure(s)`,
  );
  if (failed > 0) {
    process.exit(1);
  }
}

await main();
