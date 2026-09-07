/**
 * Render the analysis as a single self-contained HTML file.
 *
 * Self-contained is a hard requirement, not a preference: the file gets opened
 * from a local path, attached to a ticket and dropped in Slack, so it cannot
 * depend on a CDN or a sibling assets folder. Every chart is inline SVG built
 * here — no chart library, no network.
 *
 * The JMeter dashboard already renders per-label tables and time series. This
 * report deliberately does NOT re-render those; it leads with the things the
 * dashboard cannot say (what broke vs what merely breached a budget, what the
 * everyday user felt, how the ladders scale, what moved since last run) and
 * keeps the full label table at the bottom as reference.
 */

const PERCENT = 100;
const MS_PER_SECOND = 1000;
const CHART_WIDTH = 860;
const CHART_HEIGHT = 260;
const PAD_LEFT = 56;
const PAD_RIGHT = 52;
const PAD_TOP = 16;
const PAD_BOTTOM = 34;
const LADDER_WIDTH = 300;
const LADDER_HEIGHT = 170;
const SPARK_WIDTH = 150;
const SPARK_HEIGHT = 28;
const AXIS_TICKS = 4;
const MAX_TABLE_ROWS = 200;
const SUPERLINEAR = 1.2;

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function fmtMs(ms) {
  if (ms >= MS_PER_SECOND) {
    return `${(ms / MS_PER_SECOND).toFixed(2)}s`;
  }
  return `${Math.round(ms)}ms`;
}

function niceMax(value) {
  if (value <= 0) {
    return 1;
  }
  const magnitude = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / magnitude) * magnitude;
}

function pathFor(points) {
  return points
    .map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
    .join(" ");
}

/**
 * A line chart with an optional second series on its own right-hand axis.
 * Used for probe latency against concurrency, where the whole point is seeing
 * the two lines move together.
 */
function lineChart({
  primary,
  secondary,
  width = CHART_WIDTH,
  height = CHART_HEIGHT,
  xLabel = "",
  yLabel = "",
  y2Label = "",
}) {
  if (primary.length < 2) {
    return `<p class="muted">Not enough data to chart.</p>`;
  }

  const xs = primary.map((p) => p.x);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yMax = niceMax(Math.max(...primary.map((p) => p.y)));
  const y2Max = secondary?.length
    ? niceMax(Math.max(...secondary.map((p) => p.y)))
    : 0;

  const plotW = width - PAD_LEFT - PAD_RIGHT;
  const plotH = height - PAD_TOP - PAD_BOTTOM;
  const sx = (x) =>
    PAD_LEFT + (xMax === xMin ? 0 : ((x - xMin) / (xMax - xMin)) * plotW);
  const sy = (y) => PAD_TOP + plotH - (y / yMax) * plotH;
  const sy2 = (y) => PAD_TOP + plotH - (y / (y2Max || 1)) * plotH;

  const gridLines = [];
  const yTicks = [];
  for (let i = 0; i <= AXIS_TICKS; i += 1) {
    const value = (yMax / AXIS_TICKS) * i;
    const y = sy(value);
    gridLines.push(
      `<line class="grid" x1="${PAD_LEFT}" y1="${y.toFixed(1)}" x2="${(PAD_LEFT + plotW).toFixed(1)}" y2="${y.toFixed(1)}"/>`,
    );
    yTicks.push(
      `<text class="tick" x="${PAD_LEFT - 8}" y="${(y + 3).toFixed(1)}" text-anchor="end">${fmtMs(value)}</text>`,
    );
  }

  const xTicks = [];
  for (let i = 0; i <= AXIS_TICKS; i += 1) {
    const value = xMin + ((xMax - xMin) / AXIS_TICKS) * i;
    xTicks.push(
      `<text class="tick" x="${sx(value).toFixed(1)}" y="${height - 12}" text-anchor="middle">${value.toFixed(0)}</text>`,
    );
  }

  const secondaryPath = secondary?.length
    ? `<path class="series-2" d="${pathFor(secondary.map((p) => ({ x: sx(p.x), y: sy2(p.y) })))}"/>`
    : "";
  const y2Ticks =
    secondary?.length && y2Max
      ? [0, y2Max]
          .map(
            (v) =>
              `<text class="tick tick-2" x="${(PAD_LEFT + plotW + 8).toFixed(1)}" y="${(sy2(v) + 3).toFixed(1)}">${v}</text>`,
          )
          .join("")
      : "";

  const dots = primary
    .map(
      (p) =>
        `<circle class="dot" cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="2.5"><title>${escapeHtml(p.title ?? "")}</title></circle>`,
    )
    .join("");

  return `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(yLabel)} over ${escapeHtml(xLabel)}">
  ${gridLines.join("")}
  ${secondaryPath}
  <path class="series-1" d="${pathFor(primary.map((p) => ({ x: sx(p.x), y: sy(p.y) })))}"/>
  ${dots}
  ${yTicks.join("")}${y2Ticks}${xTicks.join("")}
  <text class="axis" x="${PAD_LEFT}" y="${height - 1}">${escapeHtml(xLabel)}</text>
  <text class="axis" x="${PAD_LEFT}" y="10">${escapeHtml(yLabel)}${y2Label ? ` · <tspan class="axis-2">${escapeHtml(y2Label)}</tspan>` : ""}</text>
</svg>`;
}

function ladderChart(points) {
  const primary = points.map((p) => ({
    x: p.users,
    y: p.p95,
    title: `${p.users} user(s): p95 ${fmtMs(p.p95)} over ${p.n} samples`,
  }));
  return lineChart({
    primary,
    width: LADDER_WIDTH,
    height: LADDER_HEIGHT,
    xLabel: "users",
    yLabel: "p95",
  });
}

function sparkline(points) {
  if (points.length < 2) {
    return `<span class="muted">—</span>`;
  }
  const max = Math.max(...points.map((p) => p.p95)) || 1;
  const step = SPARK_WIDTH / (points.length - 1);
  const coords = points.map((p, i) => ({
    x: i * step,
    y: SPARK_HEIGHT - (p.p95 / max) * (SPARK_HEIGHT - 4) - 2,
  }));
  return `<svg class="spark" viewBox="0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}" role="img" aria-label="trend"><path d="${pathFor(coords)}"/><circle cx="${coords.at(-1).x.toFixed(1)}" cy="${coords.at(-1).y.toFixed(1)}" r="2.5"/></svg>`;
}

function tile(label, value, note = "", tone = "") {
  return `<div class="tile ${tone}"><div class="tile-value">${escapeHtml(value)}</div><div class="tile-label">${escapeHtml(label)}</div>${note ? `<div class="tile-note">${escapeHtml(note)}</div>` : ""}</div>`;
}

function table(headers, rows, className = "") {
  if (rows.length === 0) {
    return "";
  }
  const head = headers
    .map(
      (h) =>
        `<th${h.numeric ? ' class="num"' : ""}>${escapeHtml(h.text ?? h)}</th>`,
    )
    .join("");
  const body = rows
    .map(
      (row) =>
        `<tr>${row.map((cell) => (typeof cell === "object" && cell !== null ? `<td class="${cell.className ?? ""}">${cell.html ?? escapeHtml(cell.text)}</td>` : `<td>${escapeHtml(cell)}</td>`)).join("")}</tr>`,
    )
    .join("");
  return `<div class="table-wrap"><table class="${className}"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function num(value) {
  return { text: value, className: "num" };
}

function outcomeSection(outcomes) {
  const { totals, total } = outcomes;
  const pct = (n) => (total ? (n / total) * PERCENT : 0);
  const bar = `<div class="stack" role="img" aria-label="outcome split">
    <span class="seg ok" style="width:${pct(totals.ok).toFixed(2)}%" title="${totals.ok} passed"></span>
    <span class="seg warn" style="width:${pct(totals.assertionFailed).toFixed(2)}%" title="${totals.assertionFailed} assertion failures"></span>
    <span class="seg bad" style="width:${pct(totals.httpError).toFixed(2)}%" title="${totals.httpError} HTTP errors"></span>
  </div>
  <p class="legend"><span class="key ok"></span>passed ${totals.ok}
     <span class="key warn"></span>assertion failed ${totals.assertionFailed}
     <span class="key bad"></span>HTTP error ${totals.httpError}</p>`;

  const assertions = table(
    ["Breached assertion (numbers masked)", { text: "Samples", numeric: true }],
    outcomes.assertions.map((a) => [a.message, num(a.n)]),
  );
  const errors = table(
    ["HTTP error", { text: "Samples", numeric: true }],
    outcomes.errors.map((e) => [e.message, num(e.n)]),
  );

  return `<section id="outcomes">
    <h2>What actually failed</h2>
    <p class="lede">JMeter marks a sample failed when <em>any</em> assertion fails — including a latency budget. A 200 that took too long and a 502 are both "errors" in the dashboard; they are different events, so they are split here.</p>
    ${bar}
    ${totals.assertionFailed ? `<h3>Assertion failures — the service answered, but outside budget</h3>${assertions}` : ""}
    ${totals.httpError ? `<h3>HTTP errors — the service did not answer</h3>${errors}` : `<p class="good">No HTTP errors in this run.</p>`}
  </section>`;
}

function incidentSection(clusters) {
  if (clusters.length === 0) {
    return "";
  }
  const rows = clusters.map((c) => [
    new Date(c.startMs).toISOString().slice(11, 19),
    num(c.n),
    `${(c.spanMs / MS_PER_SECOND).toFixed(1)}s`,
    num(c.peakThreads),
    c.code,
    c.labels.join(", ").slice(0, 80),
  ]);
  return `<section id="incidents">
    <h2>Incidents</h2>
    <p class="lede">HTTP failures grouped by time. Failures bunched into seconds are one blip; failures spread across a phase are a failure mode. A raw count cannot tell those apart.</p>
    ${table(
      [
        "First seen (UTC)",
        { text: "Failures", numeric: true },
        "Span",
        { text: "Concurrency", numeric: true },
        "Code",
        "Labels",
      ],
      rows,
    )}
  </section>`;
}

function collateralSection(collateral) {
  if (collateral.buckets.length < 2) {
    return "";
  }
  const primary = collateral.buckets.map((b) => ({
    x: b.minute,
    y: b.mean,
    title: `min ${b.minute.toFixed(1)}: probe mean ${fmtMs(b.mean)}, max ${fmtMs(b.max)}, ${b.peakThreads} threads`,
  }));
  const secondary = collateral.buckets.map((b) => ({
    x: b.minute,
    y: b.peakThreads,
  }));
  const ratio = collateral.baselineMs
    ? collateral.worstMs / collateral.baselineMs
    : 0;

  return `<section id="collateral">
    <h2>What an ordinary user felt</h2>
    <p class="lede">The probe thread group runs throughout, so its latency plotted against live concurrency shows which phase actually hurt — rather than one averaged number covering both the calm and the storm.</p>
    <p class="callout">Quiet baseline <strong>${fmtMs(collateral.baselineMs)}</strong> → worst 30s window <strong>${fmtMs(collateral.worstMs)}</strong>${ratio ? ` · <strong>${ratio.toFixed(1)}×</strong> degradation under load` : ""}</p>
    ${lineChart({ primary, secondary, xLabel: "minutes into run", yLabel: "probe latency (mean)", y2Label: "concurrent threads" })}
  </section>`;
}

function ladderSection(families) {
  if (families.length === 0) {
    return "";
  }
  const cards = families
    .slice(0, 12)
    .map((f) => {
      const tone = f.scaling >= SUPERLINEAR ? "bad" : f.scaling ? "ok" : "";
      const badge =
        f.scaling === null
          ? ""
          : `<span class="badge ${tone}">${f.scaling.toFixed(2)}× per user added</span>`;
      const steps = f.points
        .map((p) => `${p.users}u ${fmtMs(p.p95)}`)
        .join(" · ");
      return `<div class="card">
        <h3>${escapeHtml(f.family)}</h3>
        ${badge}
        ${ladderChart(f.points)}
        <p class="steps">${escapeHtml(steps)}</p>
      </div>`;
    })
    .join("");

  return `<section id="ladders">
    <h2>How cost scales with concurrency</h2>
    <p class="lede">Each ladder step is a separate thread group, so the dashboard shows them as unrelated rows. Reassembled, the curve shows where cost stops tracking concurrency and starts outrunning it. Above 1.00× a step costs more per user than the step below it.</p>
    <div class="cards">${cards}</div>
  </section>`;
}

function comparisonSection(comparison, baseline) {
  if (!comparison) {
    return `<section id="compare"><h2>Compared with the previous run</h2><p class="muted">No earlier run for this suite in the store yet — fetch another run and this section fills in.</p></section>`;
  }

  const when = baseline.started ?? baseline.run_id;
  if (comparison.labelDrift) {
    return `<section id="compare">
      <h2>Compared with the previous run</h2>
      <p class="warn-box"><strong>Not comparable.</strong> The baseline run (${escapeHtml(when)}${baseline.version ? `, ${escapeHtml(baseline.version)}` : ""}) shares <strong>no label names</strong> with this one, so every measurement would be comparing different things. This normally means the thread groups were renamed between versions. ${comparison.onlyInBaseline.length} labels only in the baseline, ${comparison.onlyInCurrent.length} only here.</p>
    </section>`;
  }

  const row = (c) => [
    c.label,
    num(fmtMs(c.before)),
    num(fmtMs(c.after)),
    {
      text: `${c.ratio.toFixed(2)}×`,
      className: `num ${c.ratio >= comparison.thresholds.regression ? "bad" : "good"}`,
    },
  ];
  const headers = [
    "Label",
    { text: "Baseline p95", numeric: true },
    { text: "This run p95", numeric: true },
    { text: "Change", numeric: true },
  ];

  return `<section id="compare">
    <h2>Compared with the previous run</h2>
    <p class="lede">Baseline: ${escapeHtml(when)}${baseline.version ? ` · ${escapeHtml(baseline.version)}` : ""}. ${comparison.changes.length} labels had at least ${comparison.thresholds.minSamples} samples in both runs. The portal has no run-comparison view at all — this is only possible because the samples are stored locally.</p>
    ${comparison.regressions.length ? `<h3>Slower (≥${comparison.thresholds.regression}×)</h3>${table(headers, comparison.regressions.map(row))}` : `<p class="good">Nothing regressed beyond ${comparison.thresholds.regression}×.</p>`}
    ${comparison.improvements.length ? `<h3>Faster (≤${comparison.thresholds.improvement}×)</h3>${table(headers, comparison.improvements.map(row))}` : ""}
    ${comparison.onlyInCurrent.length || comparison.onlyInBaseline.length ? `<p class="muted">${comparison.onlyInCurrent.length} labels new in this run, ${comparison.onlyInBaseline.length} gone since the baseline.</p>` : ""}
  </section>`;
}

function historySection(history) {
  const withTrend = history.filter((h) => h.points.length > 1);
  if (withTrend.length === 0) {
    return "";
  }
  const rows = withTrend.slice(0, 25).map((h) => {
    const first = h.points[0];
    const last = h.points.at(-1);
    const ratio = first.p95 > 0 ? last.p95 / first.p95 : null;
    return [
      h.label,
      { html: sparkline(h.points), className: "spark-cell" },
      num(h.points.length),
      num(fmtMs(first.p95)),
      num(fmtMs(last.p95)),
      ratio
        ? {
            text: `${ratio.toFixed(2)}×`,
            className: `num ${ratio >= SUPERLINEAR ? "bad" : "good"}`,
          }
        : num("—"),
    ];
  });
  return `<section id="history">
    <h2>Trend across stored runs</h2>
    <p class="lede">p95 per label over every run in the local store. This is the view the portal structurally cannot offer: each run's dashboard lives in its own S3 prefix with nothing joining them.</p>
    ${table(
      [
        "Label",
        "Trend",
        { text: "Runs", numeric: true },
        { text: "First p95", numeric: true },
        { text: "Latest p95", numeric: true },
        { text: "Change", numeric: true },
      ],
      rows,
    )}
  </section>`;
}

function labelSection(stats) {
  const rows = stats.slice(0, MAX_TABLE_ROWS).map((s) => [
    s.label,
    num(s.n),
    num(fmtMs(s.mean)),
    num(fmtMs(s.p50)),
    num(fmtMs(s.p90)),
    num(fmtMs(s.p95)),
    num(fmtMs(s.p99)),
    num(fmtMs(s.max)),
    s.failed
      ? {
          text: `${s.failed}${s.httpErrors ? ` (${s.httpErrors} HTTP)` : ""}`,
          className: `num ${s.httpErrors ? "bad" : "warn"}`,
        }
      : num("—"),
  ]);
  return `<section id="labels">
    <h2>Every label</h2>
    <p class="lede">Sorted by p95, slowest first. Reference detail — the dashboard covers this ground too.</p>
    ${table(
      [
        "Label",
        { text: "n", numeric: true },
        { text: "mean", numeric: true },
        { text: "p50", numeric: true },
        { text: "p90", numeric: true },
        { text: "p95", numeric: true },
        { text: "p99", numeric: true },
        { text: "max", numeric: true },
        { text: "failed", numeric: true },
      ],
      rows,
    )}
    ${stats.length > MAX_TABLE_ROWS ? `<p class="muted">Showing the ${MAX_TABLE_ROWS} slowest of ${stats.length} labels.</p>` : ""}
  </section>`;
}

const STYLES = `
:root {
  --bg: #ffffff; --panel: #f7f8fa; --border: #d8dce2; --text: #14181d;
  --muted: #5a6572; --accent: #1d70b8; --accent-2: #b58900;
  --ok: #00703c; --warn: #b58900; --bad: #d4351c; --grid: #e6e9ed;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #0f1319; --panel: #161c24; --border: #2a3441; --text: #e6edf3;
    --muted: #93a1b1; --accent: #58a6ff; --accent-2: #e3b341;
    --ok: #3fb950; --warn: #e3b341; --bad: #f85149; --grid: #222b36;
  }
}
:root[data-theme="dark"] {
  --bg: #0f1319; --panel: #161c24; --border: #2a3441; --text: #e6edf3;
  --muted: #93a1b1; --accent: #58a6ff; --accent-2: #e3b341;
  --ok: #3fb950; --warn: #e3b341; --bad: #f85149; --grid: #222b36;
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--text);
  font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
.wrap { max-width: 1100px; margin: 0 auto; padding: 32px 20px 80px; }
header.run { border-bottom: 3px solid var(--accent); padding-bottom: 18px; margin-bottom: 24px; }
h1 { font-size: 1.6rem; margin: 0 0 6px; letter-spacing: -0.01em; }
h2 { font-size: 1.25rem; margin: 0 0 8px; letter-spacing: -0.01em; }
h3 { font-size: 1rem; margin: 22px 0 8px; }
.sub { color: var(--muted); font-size: 0.92rem; margin: 0; }
.lede { color: var(--muted); margin: 0 0 16px; max-width: 78ch; font-size: 0.94rem; }
section { margin: 40px 0; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin: 20px 0 8px; }
.tile { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; }
.tile-value { font-size: 1.5rem; font-weight: 650; letter-spacing: -0.02em; }
.tile-label { color: var(--muted); font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; margin-top: 2px; }
.tile-note { color: var(--muted); font-size: 0.8rem; margin-top: 4px; }
.tile.bad .tile-value { color: var(--bad); }
.tile.warn .tile-value { color: var(--warn); }
.tile.ok .tile-value { color: var(--ok); }
.stack { display: flex; height: 22px; border-radius: 5px; overflow: hidden; border: 1px solid var(--border); }
.seg.ok { background: var(--ok); } .seg.warn { background: var(--warn); } .seg.bad { background: var(--bad); }
.legend { font-size: 0.85rem; color: var(--muted); margin: 8px 0 0; }
.key { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin: 0 5px 0 14px; }
.legend .key:first-child { margin-left: 0; }
.key.ok { background: var(--ok); } .key.warn { background: var(--warn); } .key.bad { background: var(--bad); }
.callout { background: var(--panel); border-left: 3px solid var(--accent); padding: 10px 14px; border-radius: 0 6px 6px 0; margin: 0 0 16px; font-size: 0.95rem; }
.warn-box { background: var(--panel); border-left: 3px solid var(--warn); padding: 12px 14px; border-radius: 0 6px 6px 0; max-width: 78ch; }
.good { color: var(--ok); font-size: 0.94rem; }
.muted { color: var(--muted); font-size: 0.9rem; }
.table-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: 8px; }
table { border-collapse: collapse; width: 100%; font-size: 0.88rem; }
th, td { text-align: left; padding: 7px 11px; border-bottom: 1px solid var(--border); white-space: nowrap; }
th { background: var(--panel); font-weight: 600; position: sticky; top: 0; }
tbody tr:last-child td { border-bottom: 0; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
td.bad { color: var(--bad); font-weight: 600; }
td.good { color: var(--ok); }
td.warn { color: var(--warn); }
td:first-child { white-space: normal; min-width: 22ch; }
.chart { width: 100%; height: auto; display: block; margin: 8px 0; }
.chart .grid { stroke: var(--grid); stroke-width: 1; }
.chart .series-1 { fill: none; stroke: var(--accent); stroke-width: 2; stroke-linejoin: round; }
.chart .series-2 { fill: none; stroke: var(--accent-2); stroke-width: 1.5; stroke-dasharray: 4 3; }
.chart .dot { fill: var(--accent); }
.chart .tick { fill: var(--muted); font-size: 10px; }
.chart .tick-2 { fill: var(--accent-2); }
.chart .axis { fill: var(--muted); font-size: 10px; }
.chart .axis-2 { fill: var(--accent-2); }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(290px, 1fr)); gap: 14px; }
.card { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; }
.card h3 { margin: 0 0 6px; font-size: 0.9rem; line-height: 1.35; }
.badge { display: inline-block; font-size: 0.75rem; padding: 2px 7px; border-radius: 99px; background: var(--border); color: var(--text); }
.badge.bad { background: var(--bad); color: #fff; }
.badge.ok { background: var(--ok); color: #fff; }
.steps { font-size: 0.78rem; color: var(--muted); margin: 4px 0 0; font-variant-numeric: tabular-nums; }
.spark { width: ${SPARK_WIDTH}px; height: ${SPARK_HEIGHT}px; }
.spark path { fill: none; stroke: var(--accent); stroke-width: 1.5; }
.spark circle { fill: var(--accent); }
.spark-cell { padding: 2px 11px; }
nav.toc { margin: 18px 0 0; font-size: 0.88rem; }
nav.toc a { color: var(--accent); margin-right: 14px; text-decoration: none; }
nav.toc a:hover { text-decoration: underline; }
footer { margin-top: 56px; padding-top: 16px; border-top: 1px solid var(--border); color: var(--muted); font-size: 0.82rem; }
code { background: var(--panel); padding: 1px 5px; border-radius: 4px; font-size: 0.86em; }
`;

export function renderReport({
  run,
  analysis,
  history,
  baseline,
  generatedAt,
}) {
  const { overview, stats, clusters, collateral } = analysis;
  const { totals } = overview.outcomes;

  const tiles = [
    tile("samples", String(overview.samples)),
    tile("labels", String(overview.labels)),
    tile("window", `${overview.windowMinutes.toFixed(1)} min`),
    tile("peak concurrency", String(overview.peakThreads)),
    tile(
      "HTTP errors",
      String(totals.httpError),
      totals.httpError ? `${clusters.length} incident(s)` : "none",
      totals.httpError ? "bad" : "ok",
    ),
    tile(
      "assertion failures",
      String(totals.assertionFailed),
      "budget breaches",
      totals.assertionFailed ? "warn" : "ok",
    ),
  ].join("");

  return `<title>Perf run ${escapeHtml(run.started ?? run.run_id)}</title>
<style>${STYLES}</style>
<div class="wrap">
  <header class="run">
    <h1>${escapeHtml(run.suite)} — ${escapeHtml(run.started ?? run.run_id)}</h1>
    <p class="sub">version ${escapeHtml(run.version ?? "?")} · ${escapeHtml(run.environment)} · ${escapeHtml(run.status ?? "")} · ${escapeHtml(run.duration ?? "")} · run by ${escapeHtml(run.run_by ?? "?")}</p>
    <p class="sub">run id <code>${escapeHtml(run.run_id)}</code></p>
    <nav class="toc">
      <a href="#outcomes">Failures</a>
      ${clusters.length ? '<a href="#incidents">Incidents</a>' : ""}
      <a href="#collateral">User impact</a>
      <a href="#ladders">Scaling</a>
      <a href="#compare">vs previous</a>
      <a href="#history">Trend</a>
      <a href="#labels">All labels</a>
    </nav>
  </header>

  <div class="tiles">${tiles}</div>

  ${outcomeSection(overview.outcomes)}
  ${incidentSection(clusters)}
  ${collateralSection(collateral)}
  ${ladderSection(analysis.ladders)}
  ${comparisonSection(analysis.comparison, baseline)}
  ${historySection(history)}
  ${labelSection(stats)}

  <footer>
    Generated ${escapeHtml(generatedAt)} by <code>scripts/perf-report.mjs</code> from the raw JMeter samples published by the CDP portal.
    The portal's own JMeter dashboard remains the reference for per-request detail; this report covers what that dashboard cannot.
  </footer>
</div>`;
}
