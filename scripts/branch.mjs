import {
  HARNESS_ROOT,
  REPOS,
  color,
  exists,
  repoPath,
  runCapture,
  warn,
} from "./_lib.mjs";

const rows = [];

rows.push({
  name: "bng-metric-harness",
  colorName: "green",
  branch: await currentBranch(HARNESS_ROOT),
});

for (const repo of REPOS) {
  if (!exists(repo.name)) {
    rows.push({
      name: repo.name,
      colorName: repo.color,
      branch: "(not cloned)",
    });
    continue;
  }
  rows.push({
    name: repo.name,
    colorName: repo.color,
    branch: await currentBranch(repoPath(repo.name)),
  });
}

const width = Math.max(...rows.map((r) => r.name.length));

console.log();
for (const row of rows) {
  const padded = row.name.padEnd(width, " ");
  console.log(`  ${color(row.colorName, padded)}  ${row.branch}`);
}
console.log();

async function currentBranch(cwd) {
  const { code, stdout } = await runCapture(
    "git",
    ["rev-parse", "--abbrev-ref", "HEAD"],
    { cwd },
  );
  if (code !== 0) {
    warn(`  could not read branch in ${cwd}`);
    return "(unknown)";
  }
  return stdout.trim();
}
