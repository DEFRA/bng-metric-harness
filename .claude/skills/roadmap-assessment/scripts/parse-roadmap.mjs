// Deterministic parser: Mural "BNG Backlog" story-map CSV -> roadmap.json
//
// The CSV carries each sticky's text, colour, and X/Y coordinates, so the whole
// board is reconstructed without visual guesswork:
//   - horizontal position (X)  -> which backbone activity ("theme")
//   - colour                   -> release phase, per the board's own legend
//   - the EPIC USER NEEDS band  -> overarching user-need statements
//
// This is the CANONICAL copy shipped with the roadmap-assessment skill. The skill
// copies it into `roadmap-assessment/parse-roadmap.mjs` (next to `source/`) and runs
// it there, so import.meta.dirname resolves source/ and roadmap.json as siblings.
//
// Output is roadmap.json ONLY — an intermediate, machine-readable structure that
// drives the assessment workflow. The single human deliverable (assessment.md) is
// produced later by the workflow. Roadmap items are keyed by their semantic THEME
// and STORY names — no synthetic IDs.
//
// Re-run after each Mural re-export. Watch the "UNKNOWN" phase count: > 0 means the
// board's colours drifted from the legend below and PHASE_BY_COLOUR needs updating.

import fs from "node:fs";
import path from "node:path";

const SOURCE_DIR = path.resolve(import.meta.dirname, "source");
const JSON_FILE = path.resolve(import.meta.dirname, "roadmap.json");

// Colour -> release phase (decoded from the NOW/NEXT/LATER/EVEN LATER legend
// stickies that sit top-left on the board).
const PHASE_BY_COLOUR = {
  "#FCF281": "NOW",
  "#D8C7FF": "NEXT",
  "#FEBBBE": "LATER",
  "#D8D8B1": "EVEN LATER",
};
const PHASE_ORDER = ["NOW", "NEXT", "LATER", "EVEN LATER", "UNKNOWN"];

const BACKBONE_COLOUR = "#EDEDED"; // grey 3x5 activity headers (the "themes")
const USER_NEED_COLOUR = "#AAED92"; // green EPIC USER NEEDS band
const LABEL_COLOUR = "#F6A324"; // section label sticky (not a requirement)
const LEGEND_TEXTS = new Set(["NOW", "NEXT", "LATER", "EVEN LATER", "USER NEEDS"]);

const COL = { id: 0, text: 1, colour: 2, type: 3, x: 5, y: 6, area: 7 };

function findCsv() {
  const csv = fs
    .readdirSync(SOURCE_DIR)
    .find((f) => f.toLowerCase().endsWith(".csv"));
  if (!csv) {
    console.error(`No CSV found in ${SOURCE_DIR}`);
    process.exit(1);
  }
  return path.join(SOURCE_DIR, csv);
}

// Minimal RFC-4180-ish CSV parser: handles quoted fields, embedded commas,
// escaped "" quotes, and CRLF.
function parseCsv(input) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"' && input[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function decodeEntities(text) {
  return text
    .replaceAll("&amp;", "&")
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&#39;", "'")
    .replaceAll("&quot;", '"')
    .trim();
}

function toRecords(rows) {
  return rows.slice(1).map((r) => ({
    id: r[COL.id],
    text: decodeEntities(r[COL.text] ?? ""),
    colour: (r[COL.colour] ?? "").trim().toUpperCase(),
    type: r[COL.type],
    x: Number(r[COL.x]),
    y: Number(r[COL.y]),
    area: (r[COL.area] ?? "").trim(),
  }));
}

function classify(records) {
  const themes = [];
  const userNeeds = [];
  const tasks = [];
  for (const rec of records) {
    if (!rec.id || Number.isNaN(rec.x)) {
      continue;
    }
    if (LEGEND_TEXTS.has(rec.text) || rec.colour === LABEL_COLOUR) {
      continue; // legend / section label — not a requirement
    }
    if (rec.colour === BACKBONE_COLOUR) {
      themes.push(rec);
    } else if (rec.colour === USER_NEED_COLOUR || rec.area === "USER NEEDS") {
      userNeeds.push(rec);
    } else {
      tasks.push(rec);
    }
  }
  themes.sort((a, b) => a.x - b.x); // left -> right
  userNeeds.sort((a, b) => a.x - b.x);
  return { themes, userNeeds, tasks };
}

function nearestThemeIndex(taskX, themes) {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < themes.length; i++) {
    const dist = Math.abs(taskX - themes[i].x);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

function phaseOf(colour) {
  return PHASE_BY_COLOUR[colour] ?? "UNKNOWN";
}

function buildModel(themes, tasks) {
  const buckets = themes.map((t) => ({ theme: t, tasks: [] }));
  for (const task of tasks) {
    const idx = nearestThemeIndex(task.x, themes);
    buckets[idx].tasks.push(task);
  }
  // top -> down within a column (smaller Y is higher on the board)
  for (const b of buckets) {
    b.tasks.sort((a, c) => a.y - c.y);
  }
  return buckets;
}

function phaseCounts(tasks) {
  const counts = Object.fromEntries(PHASE_ORDER.map((p) => [p, 0]));
  for (const t of tasks) {
    counts[phaseOf(t.colour)]++;
  }
  return counts;
}

function buildJsonModel(buckets, stats, userNeeds, csvName) {
  return {
    generatedFrom: csvName,
    totals: {
      themes: stats.themeCount,
      stories: stats.taskCount,
      userNeeds: userNeeds.length,
    },
    phaseCounts: stats.counts,
    legend: PHASE_BY_COLOUR,
    userNeeds: userNeeds.map((u) => u.text),
    themes: buckets.map((b) => ({
      name: b.theme.text,
      stories: b.tasks.map((task) => ({
        text: task.text,
        phase: phaseOf(task.colour),
      })),
    })),
  };
}

function main() {
  const csvPath = findCsv();
  const csvName = path.basename(csvPath);
  const rows = parseCsv(fs.readFileSync(csvPath, "utf8"));
  const records = toRecords(rows);
  const { themes, userNeeds, tasks } = classify(records);
  const buckets = buildModel(themes, tasks);
  const counts = phaseCounts(tasks);
  const stats = {
    themeCount: themes.length,
    taskCount: tasks.length,
    counts,
  };
  const jsonModel = buildJsonModel(buckets, stats, userNeeds, csvName);
  fs.writeFileSync(JSON_FILE, JSON.stringify(jsonModel, null, 2));
  console.log(
    `Parsed ${records.length} stickies -> ${themes.length} themes, ` +
      `${tasks.length} stories, ${userNeeds.length} user needs`,
  );
  console.log(`Phases: ${JSON.stringify(counts)}`);
  console.log(`Wrote ${JSON_FILE}`);
}

main();
