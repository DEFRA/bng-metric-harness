/**
 * The analyses the JMeter dashboard does not do.
 *
 * The dashboard answers "what were the numbers per label". These functions
 * answer the questions that need either the raw per-sample rows or more than
 * one run — which is exactly what the dashboard cannot reach:
 *
 *   - a 200 that FAILED an assertion is not the same event as a 502, and
 *     "error %" conflates them
 *   - four failures 0.3s apart are one blip, not a failure mode
 *   - what the everyday-user probe felt WHILE each load phase ran
 *   - how a ladder's cost actually scales with concurrency
 *   - whether any of it moved since the last run
 *
 * Everything here reads the store and returns plain data; rendering lives in
 * _perf-html.mjs so the same analyses can be printed to a terminal.
 */

const PERCENTILES = [50, 90, 95, 99];
const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const TIMELINE_BUCKET_MS = 30_000;
// Failures closer together than this are treated as one incident rather than
// as independent events.
const CLUSTER_GAP_MS = 5_000;
const PERCENT = 100;
// A run-over-run p95 move smaller than this is noise, not a regression.
const REGRESSION_THRESHOLD = 1.2;
const IMPROVEMENT_THRESHOLD = 0.83;
const MIN_SAMPLES_TO_COMPARE = 30;

/** Nearest-rank percentile over an already-sorted array. */
export function percentile(sorted, p) {
  if (sorted.length === 0) {
    return 0;
  }
  const rank = Math.ceil((p / PERCENT) * sorted.length) - 1;
  return sorted[Math.min(Math.max(rank, 0), sorted.length - 1)];
}

function summarise(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const total = sorted.reduce((sum, v) => sum + v, 0);
  const result = {
    n: sorted.length,
    mean: sorted.length ? total / sorted.length : 0,
    min: sorted[0] ?? 0,
    max: sorted.at(-1) ?? 0,
  };
  for (const p of PERCENTILES) {
    result[`p${p}`] = percentile(sorted, p);
  }
  return result;
}

/**
 * Split outcomes three ways.
 *
 * JMeter marks a sample failed when ANY assertion fails, including a latency
 * budget — so `success=false` with a 2xx code is a breached threshold, not a
 * broken service. Reporting those together is what makes a dashboard's error
 * rate untrustworthy.
 */
export function outcomes(db, runId) {
  const rows = db
    .prepare(
      `SELECT code, success, failure, COUNT(*) AS n
         FROM samples WHERE run_id = ?
        GROUP BY code, success, failure`,
    )
    .all(runId);

  const isHttpError = (code) => !/^[123]\d\d$/.test(String(code ?? ""));

  const totals = { ok: 0, assertionFailed: 0, httpError: 0 };
  const assertions = new Map();
  const errors = new Map();

  for (const row of rows) {
    if (row.success === 1) {
      totals.ok += row.n;
      continue;
    }
    const bucket = isHttpError(row.code) ? "httpError" : "assertionFailed";
    totals[bucket] += row.n;
    const into = bucket === "httpError" ? errors : assertions;
    // Assertion text carries the measured value ("It took 6,533 ms"), so
    // collapse the number out to group one rule together.
    const key =
      bucket === "httpError"
        ? `HTTP ${row.code}`
        : (row.failure ?? "(no message)")
            .split("\n")[0]
            .replaceAll(/[\d,]+/g, "N")
            .slice(0, 140);
    into.set(key, (into.get(key) ?? 0) + row.n);
  }

  const toList = (map) =>
    [...map.entries()]
      .map(([message, n]) => ({ message, n }))
      .sort((a, b) => b.n - a.n);

  return {
    totals,
    total: totals.ok + totals.assertionFailed + totals.httpError,
    assertions: toList(assertions),
    errors: toList(errors),
  };
}

export function runOverview(db, runId) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS samples,
              COUNT(DISTINCT label) AS labels,
              MIN(ts) AS startedMs, MAX(ts) AS endedMs,
              MAX(all_threads) AS peakThreads
         FROM samples WHERE run_id = ?`,
    )
    .get(runId);

  const windowMs = (row.endedMs ?? 0) - (row.startedMs ?? 0);
  return {
    ...row,
    windowMs,
    windowMinutes: windowMs / MS_PER_SECOND / SECONDS_PER_MINUTE,
    outcomes: outcomes(db, runId),
  };
}

export function labelStats(db, runId) {
  const rows = db
    .prepare(
      `SELECT label, elapsed, success, code
         FROM samples WHERE run_id = ? ORDER BY label`,
    )
    .all(runId);

  const byLabel = new Map();
  for (const row of rows) {
    if (!byLabel.has(row.label)) {
      byLabel.set(row.label, { elapsed: [], failed: 0, httpErrors: 0 });
    }
    const entry = byLabel.get(row.label);
    entry.elapsed.push(row.elapsed);
    if (row.success === 0) {
      entry.failed += 1;
      if (!/^[123]\d\d$/.test(String(row.code ?? ""))) {
        entry.httpErrors += 1;
      }
    }
  }

  return [...byLabel.entries()]
    .map(([label, entry]) => ({
      label,
      ...summarise(entry.elapsed),
      failed: entry.failed,
      httpErrors: entry.httpErrors,
      failRate: (entry.failed / entry.elapsed.length) * PERCENT,
    }))
    .sort((a, b) => b.p95 - a.p95);
}

/**
 * Group failures into incidents.
 *
 * Four 502s inside 0.3s is one backend blip; the same four spread over ten
 * minutes is a failure mode. A count cannot tell those apart, so cluster on
 * time and report the concurrency each incident happened at.
 */
export function failureClusters(db, runId) {
  const rows = db
    .prepare(
      `SELECT ts, label, code, all_threads AS threads, elapsed, failure
         FROM samples
        WHERE run_id = ? AND success = 0 AND code NOT GLOB '[123][0-9][0-9]'
        ORDER BY ts`,
    )
    .all(runId);

  const clusters = [];
  for (const row of rows) {
    const last = clusters.at(-1);
    if (last && row.ts - last.endMs <= CLUSTER_GAP_MS) {
      last.endMs = row.ts;
      last.n += 1;
      last.peakThreads = Math.max(last.peakThreads, row.threads);
      last.labels.add(row.label);
      continue;
    }
    clusters.push({
      startMs: row.ts,
      endMs: row.ts,
      n: 1,
      code: row.code,
      peakThreads: row.threads,
      labels: new Set([row.label]),
      message: (row.failure ?? "").split("\n")[0].slice(0, 120),
    });
  }

  return clusters.map((c) => ({
    ...c,
    labels: [...c.labels],
    spanMs: c.endMs - c.startMs,
  }));
}

/**
 * What an ordinary user experienced while the load phases ran.
 *
 * The probe thread group runs throughout, so bucketing it against the peak
 * concurrency in the same window turns "the probe averaged X" into a timeline
 * showing exactly which phase hurt.
 */
export function collateralImpact(db, runId, probePrefix = "probe") {
  const [{ t0 } = {}] = db
    .prepare("SELECT MIN(ts) AS t0 FROM samples WHERE run_id = ?")
    .all(runId);
  if (t0 == null) {
    return { buckets: [], baselineMs: 0, worstMs: 0 };
  }

  const rows = db
    .prepare(
      `SELECT ts, elapsed, label, all_threads AS threads
         FROM samples WHERE run_id = ? ORDER BY ts`,
    )
    .all(runId);

  const buckets = new Map();
  for (const row of rows) {
    const key = Math.floor((row.ts - t0) / TIMELINE_BUCKET_MS);
    if (!buckets.has(key)) {
      buckets.set(key, { key, probe: [], peakThreads: 0 });
    }
    const bucket = buckets.get(key);
    bucket.peakThreads = Math.max(bucket.peakThreads, row.threads);
    if (row.label.toLowerCase().startsWith(probePrefix)) {
      bucket.probe.push(row.elapsed);
    }
  }

  const series = [...buckets.values()]
    .sort((a, b) => a.key - b.key)
    .map((bucket) => ({
      minute:
        (bucket.key * TIMELINE_BUCKET_MS) / MS_PER_SECOND / SECONDS_PER_MINUTE,
      peakThreads: bucket.peakThreads,
      n: bucket.probe.length,
      ...summarise(bucket.probe),
    }))
    .filter((bucket) => bucket.n > 0);

  // Baseline = the quietest quarter of the run, so it is not itself polluted
  // by load.
  const calm = series
    .filter((b) => b.peakThreads <= Math.max(2, minThreadFloor(series)))
    .map((b) => b.mean);

  return {
    buckets: series,
    baselineMs: calm.length ? calm.reduce((a, b) => a + b, 0) / calm.length : 0,
    worstMs: series.length ? Math.max(...series.map((b) => b.mean)) : 0,
  };
}

function minThreadFloor(series) {
  const sorted = series.map((b) => b.peakThreads).sort((a, b) => a - b);
  return percentile(sorted, 25);
}

const LADDER_LABEL = /^(.*?) @ (\d+) user\(s\)(.*)$/;

/**
 * Rebuild the concurrency ladders from their labels.
 *
 * The plan encodes each step as "<family> @ N user(s)", so the steps of one
 * ladder can be put back together and the cost-vs-concurrency curve read off.
 * That curve — and where it turns superlinear — is the question the ladders
 * exist to answer, and the dashboard only ever shows the steps as unrelated
 * rows.
 */
export function ladders(db, runId) {
  const rows = db
    .prepare(`SELECT label, elapsed, success FROM samples WHERE run_id = ?`)
    .all(runId);

  const families = new Map();
  for (const row of rows) {
    const match = LADDER_LABEL.exec(row.label);
    if (!match) {
      continue;
    }
    const [, prefix, users, suffix] = match;
    const family = `${prefix}${suffix}`.trim();
    if (!families.has(family)) {
      families.set(family, new Map());
    }
    const steps = families.get(family);
    const key = Number(users);
    if (!steps.has(key)) {
      steps.set(key, { elapsed: [], failed: 0 });
    }
    steps.get(key).elapsed.push(row.elapsed);
    if (row.success === 0) {
      steps.get(key).failed += 1;
    }
  }

  return [...families.entries()]
    .map(([family, steps]) => {
      const points = [...steps.entries()]
        .map(([users, entry]) => ({
          users,
          ...summarise(entry.elapsed),
          failed: entry.failed,
        }))
        .sort((a, b) => a.users - b.users);
      const first = points[0];
      const last = points.at(-1);
      return {
        family,
        points,
        // How much worse the top of the ladder is than the bottom, per user
        // added — >1 means it degrades faster than concurrency grows.
        scaling:
          first && last && first.p95 > 0 && last.users > first.users
            ? last.p95 / first.p95 / (last.users / first.users)
            : null,
      };
    })
    .filter((f) => f.points.length > 1)
    .sort((a, b) => (b.scaling ?? 0) - (a.scaling ?? 0));
}

/**
 * Compare a run against a baseline run, per label.
 *
 * Label text is the join key, so a renamed thread group looks like a label that
 * vanished. That is worth reporting rather than hiding: between 0.7.0 and 0.8.0
 * every label was renamed, and a comparison that silently comes back empty
 * reads as "nothing changed".
 */
export function compareRuns(db, runId, baselineRunId) {
  const statsFor = (id) =>
    new Map(labelStats(db, id).map((row) => [row.label, row]));
  const current = statsFor(runId);
  const baseline = statsFor(baselineRunId);

  const shared = [...current.keys()].filter((label) => baseline.has(label));
  const comparable = shared.filter(
    (label) =>
      current.get(label).n >= MIN_SAMPLES_TO_COMPARE &&
      baseline.get(label).n >= MIN_SAMPLES_TO_COMPARE,
  );

  const changes = comparable
    .map((label) => {
      const now = current.get(label);
      const before = baseline.get(label);
      return {
        label,
        before: before.p95,
        after: now.p95,
        ratio: before.p95 > 0 ? now.p95 / before.p95 : null,
        n: now.n,
      };
    })
    .filter((row) => row.ratio !== null)
    .sort((a, b) => b.ratio - a.ratio);

  return {
    changes,
    regressions: changes.filter((c) => c.ratio >= REGRESSION_THRESHOLD),
    improvements: changes
      .filter((c) => c.ratio <= IMPROVEMENT_THRESHOLD)
      .reverse(),
    onlyInCurrent: [...current.keys()].filter((l) => !baseline.has(l)),
    onlyInBaseline: [...baseline.keys()].filter((l) => !current.has(l)),
    labelDrift: shared.length === 0,
    thresholds: {
      regression: REGRESSION_THRESHOLD,
      improvement: IMPROVEMENT_THRESHOLD,
      minSamples: MIN_SAMPLES_TO_COMPARE,
    },
  };
}

/** p95 per label across every stored run — the trend the portal cannot show. */
export function labelHistory(db, suite, labels) {
  if (labels.length === 0) {
    return [];
  }
  const placeholders = labels.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT s.run_id, r.started_ms, r.version, s.label, s.elapsed
         FROM samples s JOIN runs r ON r.run_id = s.run_id
        WHERE r.suite = ? AND s.label IN (${placeholders})
        ORDER BY r.started_ms`,
    )
    .all(suite, ...labels);

  const byLabel = new Map();
  for (const row of rows) {
    if (!byLabel.has(row.label)) {
      byLabel.set(row.label, new Map());
    }
    const runs = byLabel.get(row.label);
    if (!runs.has(row.run_id)) {
      runs.set(row.run_id, {
        runId: row.run_id,
        startedMs: row.started_ms,
        version: row.version,
        elapsed: [],
      });
    }
    runs.get(row.run_id).elapsed.push(row.elapsed);
  }

  return [...byLabel.entries()].map(([label, runs]) => ({
    label,
    points: [...runs.values()]
      .sort((a, b) => a.startedMs - b.startedMs)
      .map((run) => ({
        runId: run.runId,
        startedMs: run.startedMs,
        version: run.version,
        p95: percentile(
          [...run.elapsed].sort((a, b) => a - b),
          95,
        ),
        n: run.elapsed.length,
      })),
  }));
}

/** Everything the report needs, for one run and an optional baseline. */
export function analyseRun(db, run, baseline = null) {
  return {
    overview: runOverview(db, run.run_id),
    stats: labelStats(db, run.run_id),
    clusters: failureClusters(db, run.run_id),
    collateral: collateralImpact(db, run.run_id),
    ladders: ladders(db, run.run_id),
    comparison: baseline ? compareRuns(db, run.run_id, baseline.run_id) : null,
  };
}
