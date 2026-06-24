// Insert a "## Progress (NOW)" section into the generated assessment.md.
//
// Deterministic post-process: parses the Coverage matrix table, aggregates each
// theme's NOW stories into on-track / in-progress / not-started, and renders:
//   - a chips line (theme counts), matching the sprint-progress style;
//   - emoji stacked bars per theme (pure Markdown, renders in Confluence);
//   - Evidence + Links columns, merged from the progress-now.json sidecar that the
//     workflow's synth agent writes (plain-language evidence + GitHub links). If the
//     sidecar is absent, those two columns are left blank ("—").
//
// Built ON the coverage data behind the Theme-status table. NOW-phase only. Idempotent
// (re-running replaces the existing Progress section). Run after the workflow:
//
//   node .claude/skills/roadmap-assessment/scripts/progress-chart.mjs [path-to-assessment.md]

import fs from "node:fs";
import path from "node:path";

const FILE = process.argv[2] ?? "roadmap-assessment/assessment.md";
const SIDECAR = path.join(path.dirname(FILE), "progress-now.json");
const BAR_WIDTH = 10;
const SQ = { green: "🟩", amber: "🟨", red: "🟥" };

// Judgement cell text -> progress state (text match is emoji-variation-proof).
function stateOf(judgement) {
  // Only inspect the status word (before any evidence bullets in the cell). Cells use
  // inline `• ` bullets (NO HTML — Confluence renders <br> literally), so the status
  // word is everything up to the first bullet glyph.
  const j = judgement.split("•")[0].toLowerCase();
  if (j.includes("on-track") || j.includes("ahead")) {
    return "green";
  }
  if (j.includes("test gap")) {
    return "amber";
  }
  if (j.includes("delivery gap") || j.includes("placeholder")) {
    return "red";
  }
  return null; // expected-absent and anything else: not a NOW progress item
}

// Per-theme evidence + links written by the synth agent (sidecar FILE 2). Optional.
function loadSidecar() {
  const map = new Map();
  try {
    const arr = JSON.parse(fs.readFileSync(SIDECAR, "utf8"));
    for (const entry of arr) {
      if (entry && entry.theme) {
        map.set(entry.theme, entry);
      }
    }
  } catch {
    // no sidecar (or unreadable) — Evidence/Links columns stay blank
  }
  return map;
}

function escapeCell(text) {
  return String(text).replaceAll("|", "\\|");
}

// Pull the rows of the "## N. Coverage matrix" table.
function parseMatrix(md) {
  const rows = [];
  let inMatrix = false;
  for (const line of md.split("\n")) {
    if (/^##\s/.test(line)) {
      inMatrix = /coverage matrix/i.test(line);
      continue;
    }
    if (!inMatrix || !line.trim().startsWith("|")) {
      continue;
    }
    const cells = line.split("|").map((c) => c.trim());
    if (cells[1] === "Theme" || cells[1].startsWith("---")) {
      continue; // header / separator
    }
    // | Theme | Item | Related | Phase | Coverage | Judgement | Confidence | Tickets |
    rows.push({ theme: cells[1], phase: (cells[4] ?? "").toUpperCase(), judgement: cells[6] ?? "" });
  }
  return rows;
}

function aggregate(rows) {
  const order = [];
  const byTheme = new Map();
  for (const { theme, phase, judgement } of rows) {
    if (!byTheme.has(theme)) {
      byTheme.set(theme, { green: 0, amber: 0, red: 0, hasNow: false });
      order.push(theme);
    }
    if (phase !== "NOW") {
      continue;
    }
    const rec = byTheme.get(theme);
    rec.hasNow = true;
    const state = stateOf(judgement);
    if (state) {
      rec[state]++;
    }
  }
  return { order, byTheme };
}

function nowCount(rec) {
  return rec.green + rec.amber + rec.red;
}

function classify(rec) {
  const n = nowCount(rec);
  if (!rec.hasNow || n === 0) {
    return "notStarted"; // future-only theme, or no assessable NOW work
  }
  if (rec.green === n) {
    return "onTrack";
  }
  if (rec.green > 0 || rec.amber > 0) {
    return "inProgress";
  }
  return "notStarted"; // all delivery-gap / placeholder
}

function bar(rec) {
  const n = nowCount(rec);
  let g = Math.round((rec.green / n) * BAR_WIDTH);
  let a = Math.round((rec.amber / n) * BAR_WIDTH);
  if (g + a > BAR_WIDTH) {
    a = BAR_WIDTH - g;
  }
  const r = BAR_WIDTH - g - a;
  return SQ.green.repeat(g) + SQ.amber.repeat(a) + SQ.red.repeat(r);
}

function pct(rec) {
  return Math.round((rec.green / nowCount(rec)) * 100);
}

function renderSection({ order, byTheme }, sidecar) {
  // Only themes with actual NOW work belong in a NOW progress summary; future-only
  // themes (no NOW stories) are excluded so the chip totals match the bars shown below.
  const nowThemes = order.filter((t) => byTheme.get(t).hasNow && nowCount(byTheme.get(t)) > 0);
  const tally = { onTrack: 0, inProgress: 0, notStarted: 0 };
  for (const theme of nowThemes) {
    tally[classify(byTheme.get(theme))]++;
  }

  const chips = `**Progress (NOW)** — 🟢 ${tally.onTrack} on track · 🟡 ${tally.inProgress} in progress · 🔴 ${tally.notStarted} not started`;

  const barRows = nowThemes
    .map((t) => {
      const rec = byTheme.get(t);
      const side = sidecar.get(t) ?? {};
      // Inline, space-joined cells — NO HTML. Markdown table cells take no real newline
      // and Confluence renders <br> as literal text, so bullets/links sit on one line.
      const evidence =
        (side.evidence ?? []).map((b) => `• ${escapeCell(b)}`).join(" ") || "—";
      const links =
        (side.links ?? [])
          .map((l) => `[${escapeCell(l.label)}](${l.url})`)
          .join(" ") || "—";
      return `| ${t} | ${bar(rec)} | ${pct(rec)}% | ${evidence} | ${links} |`;
    })
    .join("\n");

  return `## Progress (NOW)

${chips}

_Legend: 🟩 on track · 🟨 in progress (built, needs a journey test) · 🟥 not started. Bars show each theme's NOW story mix; % = on-track share._

| Theme | Progress (NOW) | % done | Evidence | Links |
|---|---|---|---|---|
${barRows}
`;
}

function upsert(md, section) {
  // Remove any existing Progress (NOW) section, then normalise blank lines so the
  // result is identical on every run (idempotent).
  let out = md.replace(/^## Progress \(NOW\)[\s\S]*?(?=\n## [0-9])/m, "");
  out = out.replace(/\n{3,}/g, "\n\n");
  const anchor = out.match(/^##\s*\d*\.?\s*Theme status.*$/m);
  if (!anchor) {
    return `${out.trimEnd()}\n\n${section.trimEnd()}\n`;
  }
  const idx = out.indexOf(anchor[0]);
  const before = out.slice(0, idx).replace(/\n+$/, "");
  const after = out.slice(idx);
  return `${before}\n\n${section.trimEnd()}\n\n${after}`;
}

function main() {
  if (!fs.existsSync(FILE)) {
    console.error(`No file at ${FILE}`);
    process.exit(1);
  }
  const md = fs.readFileSync(FILE, "utf8");
  const rows = parseMatrix(md);
  if (rows.length === 0) {
    console.error("No coverage-matrix rows found — is this an assessment.md?");
    process.exit(1);
  }
  const model = aggregate(rows);
  const sidecar = loadSidecar();
  const section = renderSection(model, sidecar);
  fs.writeFileSync(FILE, upsert(md, section));
  const totals = model.order.reduce(
    (acc, t) => {
      const r = model.byTheme.get(t);
      acc.green += r.green;
      acc.amber += r.amber;
      acc.red += r.red;
      return acc;
    },
    { green: 0, amber: 0, red: 0 },
  );
  const sidecarNote = sidecar.size > 0 ? `(${sidecar.size} themes)` : "MISSING — Evidence/Links blank";
  console.log(
    `Progress (NOW) inserted into ${FILE}: ${rows.length} matrix rows; ` +
      `NOW totals on-track=${totals.green} in-progress=${totals.amber} not-started=${totals.red}; ` +
      `sidecar ${sidecarNote}`,
  );
}

main();
