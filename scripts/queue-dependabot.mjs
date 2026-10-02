// Sweep the BNG repos for Dependabot PRs the per-repo auto-approve workflow
// has already vetted (approved by github-actions + green) and add them to the
// merge queue as *you*. A workflow's GITHUB_TOKEN cannot usefully enqueue or
// arm auto-merge when a merge queue is required (recursive-trigger protection,
// see https://github.com/orgs/community/discussions/70310), so a developer
// runs this once a day with their own gh identity:
//
//   npm run queue-deps                     # enqueue everything eligible
//   npm run queue-deps -- --dry-run
//   npm run queue-deps -- backend          # one repo only (name substring)

import {
  color,
  error,
  header,
  info,
  mapInSequence,
  runCapture,
  warn,
} from "./_lib.mjs";

const OWNER = "DEFRA";
const GITHUB_REPOS = [
  "bng-metric-harness",
  "bng-metric-frontend",
  "bng-metric-backend",
  "bng-metric-digital-prototype",
  "bng-library",
  "bng-metric-journey-tests",
  "bng-perf-tests",
];

const PR_LIST_FIELDS =
  "id,number,title,isDraft,reviewDecision,latestReviews,statusCheckRollup";

// The only direct "add to the queue now" API. `gh pr merge` cannot do this:
// on a queue-protected branch it merely arms auto-merge.
const ENQUEUE_MUTATION =
  "mutation ($prId: ID!) { enqueuePullRequest(input: { pullRequestId: $prId }) { mergeQueueEntry { position } } }";

// The auto-approve workflow reviews as github-actions[bot], whose GraphQL
// login drops the [bot] suffix.
const VETTING_REVIEWER = "github-actions";

// Check runs report `conclusion`, commit statuses report `state`.
const PASSING_CHECK_RESULTS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const CLI_ARGS_START = 2;

async function gh(args) {
  const { code, stdout, stderr } = await runCapture("gh", args);
  if (code !== 0) {
    throw new Error(stderr.trim() || `gh exited with code ${code}`);
  }
  return stdout;
}

const ghJson = async (args) => JSON.parse(await gh(args));

const approvedByWorkflow = (reviews) =>
  reviews?.some(
    (r) => r.author?.login === VETTING_REVIEWER && r.state === "APPROVED",
  );

const checksAreGreen = (rollup) =>
  rollup?.length > 0 &&
  rollup.every((c) => PASSING_CHECK_RESULTS.has(c.conclusion || c.state));

// A PR qualifies when the repo's own workflow already applied its policy
// (patch/minor → approved by github-actions) and CI is green; the first matching rule
// explains why a PR is skipped, and nothing is ever merged by force.
const VETTING_RULES = [
  (pr) => pr.isDraft && "draft",
  (pr) =>
    !approvedByWorkflow(pr.latestReviews) &&
    "not approved by the auto-approve workflow (major bump?)",
  (pr) =>
    pr.reviewDecision !== "APPROVED" &&
    `review decision is ${pr.reviewDecision || "pending"}`,
  (pr) => !checksAreGreen(pr.statusCheckRollup) && "checks are not all green",
];

const skipReason = (pr) => VETTING_RULES.map((rule) => rule(pr)).find(Boolean);

async function enqueue(pr, dryRun) {
  const label = `#${pr.number} ${pr.title}`;
  if (dryRun) {
    info(`  would enqueue ${label}`);
    return "enqueued";
  }
  try {
    const result = await ghJson([
      "api",
      "graphql",
      "-f",
      `query=${ENQUEUE_MUTATION}`,
      "-f",
      `prId=${pr.id}`,
    ]);
    const entry = result.data.enqueuePullRequest.mergeQueueEntry;
    if (!entry) {
      error(`  enqueue of ${label} returned no queue entry — check manually`);
      return "failed";
    }
    console.log(
      color("green", `  ✓ enqueued ${label} (position ${entry.position})`),
    );
    return "enqueued";
  } catch (err) {
    if (/already.*queue/i.test(err.message)) {
      info(`  skipping ${label} — already in the merge queue`);
      return "skipped";
    }
    error(`  failed to enqueue ${label}: ${err.message}`);
    return "failed";
  }
}

async function processRepo(repo, dryRun) {
  header(`${OWNER}/${repo}`);
  const counts = { enqueued: 0, skipped: 0, failed: 0 };

  let prs;
  try {
    prs = await ghJson([
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
  } catch (err) {
    error(`  could not list PRs: ${err.message}`);
    return { ...counts, failed: 1 };
  }

  if (prs.length === 0) {
    info("  no open Dependabot PRs");
  }
  // One PR at a time, so they join the merge queue in the order listed.
  await mapInSequence(prs, async (pr) => {
    const reason = skipReason(pr);
    if (reason) {
      info(`  skipping #${pr.number} ${pr.title} — ${reason}`);
      counts.skipped += 1;
    } else {
      counts[await enqueue(pr, dryRun)] += 1;
    }
  });
  return counts;
}

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

async function ensureGhReady() {
  try {
    await gh(["auth", "status"]);
  } catch (err) {
    error(`GitHub CLI is not ready: ${err.message}`);
    info("  → Install gh and run `gh auth login` first.");
    process.exit(1);
  }
}

async function main() {
  const args = process.argv.slice(CLI_ARGS_START);
  const dryRun = args.includes("--dry-run");
  const repos = selectRepos(args.filter((a) => !a.startsWith("--")));
  if (dryRun) {
    warn("dry run — nothing will be enqueued");
  }
  await ensureGhReady();

  // One repo at a time, so each one's log reads together under its heading.
  const perRepo = await mapInSequence(repos, (repo) =>
    processRepo(repo, dryRun),
  );
  const totals = {
    enqueued: perRepo.reduce((sum, r) => sum + r.enqueued, 0),
    failed: perRepo.reduce((sum, r) => sum + r.failed, 0),
  };

  header("summary", "green");
  console.log(
    `  ${totals.enqueued} PR(s) ${dryRun ? "would be " : ""}enqueued, ${totals.failed} failure(s)`,
  );
  if (totals.failed > 0) {
    process.exit(1);
  }
}

await main();
