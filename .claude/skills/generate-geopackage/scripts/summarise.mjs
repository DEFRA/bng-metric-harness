#!/usr/bin/env node
/**
 * Say what a BNG Service GeoPackage shows, layer by layer: how many features
 * each stage holds, the post-intervention Retention Categories, and every
 * row that records a habitat getting worse (Created, linked to its baseline
 * parent, in its own type: "30+" or "10" years in advance, or a watercourse
 * whose condition gets worse). Use it to compare seeds, and to write the
 * table that goes with a file handed over.
 *
 *   node .claude/skills/generate-geopackage/scripts/summarise.mjs <file.gpkg> [--json]
 */

import Database from "better-sqlite3";

const LAYERS = [
  ["Area Habitats", "Habitat Type", "Area"],
  ["Vertical Area Habitats", "Habitat Type", "Area"],
  ["Hedgerows", "Hedge Type", "Length"],
  ["Watercourses", "River Type", "Length"],
  ["Individual Trees", null, null],
];
const ADVANCE = "Habitat created in advance/years";
const DEGRADED_ADVANCE = "30+";
const ROUND = 1;

const [file, flag] = process.argv.slice(2);
if (!file) {
  console.error("Usage: summarise.mjs <file.gpkg> [--json]");
  process.exit(1);
}

const db = new Database(file, { readonly: true });
const all = (sql) => db.prepare(sql).all();

function worseRows(layer, typeColumn, sizeColumn) {
  if (!typeColumn) {
    return [];
  }
  const pi = `${layer} Post-Intervention`;
  // A habitat that gets worse is Created, keeps its parent, and is in the
  // parent's own type: an area, vertical or hedgerow habitat 30+ years in
  // advance (Metric User Guide, section 5); a watercourse with 10 years for
  // more encroachment, or none for a worse condition (section 7).
  const advance =
    layer === "Watercourses" ? "" : `AND "${ADVANCE}" = '${DEGRADED_ADVANCE}'`;
  return all(
    `SELECT "Habitat Ref" ref, "Parent Ref" parent, "Baseline ${typeColumn}" type,
            "Baseline Condition" fromCondition, "Proposed Condition" toCondition,
            "${ADVANCE}" advance, "${sizeColumn}" size, Comment comment
       FROM "${pi}"
      WHERE "Retention Category" = 'Created' AND "Parent Ref" IS NOT NULL
        AND "Baseline ${typeColumn}" = "Proposed ${typeColumn}" ${advance}
      ORDER BY fid`,
  ).map((r) => ({
    ...r,
    size: r.size == null ? null : Number(r.size.toFixed(ROUND)),
  }));
}

const summary = LAYERS.map(([layer, typeColumn, sizeColumn]) => ({
  layer,
  baseline: all(`SELECT count(*) n FROM "${layer} Baseline"`)[0].n,
  postIntervention: all(
    `SELECT count(*) n FROM "${layer} Post-Intervention"`,
  )[0].n,
  retention: Object.fromEntries(
    all(
      `SELECT "Retention Category" k, count(*) n FROM "${layer} Post-Intervention" GROUP BY 1 ORDER BY 1`,
    ).map((r) => [r.k, r.n]),
  ),
  lost: all(
    `SELECT b."Habitat Ref" ref FROM "${layer} Baseline" b
      WHERE NOT EXISTS (SELECT 1 FROM "${layer} Post-Intervention" p WHERE p.parent_uuid = b.feature_uuid)
      ORDER BY b.fid`,
  ).map((r) => r.ref),
  worse: worseRows(layer, typeColumn, sizeColumn),
}));
db.close();

if (flag === "--json") {
  console.log(JSON.stringify(summary, null, 2));
} else {
  for (const s of summary) {
    const retention = Object.entries(s.retention)
      .map(([k, n]) => `${k} ${n}`)
      .join(", ");
    console.log(
      `${s.layer}: ${s.baseline} baseline / ${s.postIntervention} post-intervention (${retention || "none"}); lost: ${s.lost.join(", ") || "none"}`,
    );
    for (const w of s.worse) {
      console.log(
        `  worse: ${w.ref} (parent ${w.parent}) ${w.type}: ${w.fromCondition} -> ${w.toCondition}, advance ${w.advance ?? "blank"}, ${w.size ?? "?"}`,
      );
    }
  }
}
