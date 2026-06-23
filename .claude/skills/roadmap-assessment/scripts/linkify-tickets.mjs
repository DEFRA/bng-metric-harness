// Linkify Jira ticket refs (BMD-NNN) in the generated assessment.md.
//
// Deterministic post-process run after the assessment workflow writes the report,
// so every BMD-* reference becomes a clickable Jira link. IDEMPOTENT — re-running
// never double-links (refs already inside a link are preceded by "[" or "/" and are
// skipped). Base URL overridable via the JIRA_BROWSE_URL env var.
//
//   node .claude/skills/roadmap-assessment/scripts/linkify-tickets.mjs [path-to-assessment.md]
//
// Defaults to roadmap-assessment/assessment.md relative to the current directory
// (the harness root, where the skill runs).

import fs from "node:fs";

const BASE_URL =
  process.env.JIRA_BROWSE_URL ?? "https://eaflood.atlassian.net/browse/";
const FILE = process.argv[2] ?? "roadmap-assessment/assessment.md";

// Match BMD-<digits> only when NOT already part of a link: skip when preceded by
// "[" (link text `[BMD-1]`) or "/" (inside the URL `.../browse/BMD-1`).
const BMD_REF = /(?<![[/])BMD-(\d+)/g;

function main() {
  if (!fs.existsSync(FILE)) {
    console.error(`No file at ${FILE}`);
    process.exit(1);
  }
  const text = fs.readFileSync(FILE, "utf8");
  const total = (text.match(/BMD-\d+/g) ?? []).length;
  const linked = text.replaceAll(
    BMD_REF,
    (_match, num) => `[BMD-${num}](${BASE_URL}BMD-${num})`,
  );
  fs.writeFileSync(FILE, linked);
  const linkCount = (linked.match(/\[BMD-\d+\]\(/g) ?? []).length;
  console.log(
    `Linkified BMD refs in ${FILE}: ${total} ref(s) present, ${linkCount} now linked`,
  );
}

main();
