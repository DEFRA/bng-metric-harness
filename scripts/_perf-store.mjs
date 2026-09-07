/**
 * The perf-run store: a SQLite database of every JMeter sample ever fetched.
 *
 * The CDP portal keeps each run's dashboard in its own S3 prefix, so nothing in
 * the portal can answer "is this slower than last week". Keeping the samples
 * makes that a query rather than a project — which is the whole reason this
 * exists alongside the dashboard rather than replacing it.
 *
 * `node:sqlite` is deliberate. The harness convention is dependency-light
 * scripts, and this ships with Node 24, so the store needs no install step and
 * no native build — unlike better-sqlite3, which is a devDependency here but
 * would make the analysis unusable until someone had run `npm install`.
 *
 * One run is ~8k samples, so a year of daily runs is well under a million rows.
 * That is small enough that the schema stays honest: raw samples, no
 * pre-aggregation, every analysis derived at query time.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { mkdirSync } from "node:fs";

// node:sqlite is only reachable through require() on this Node line.
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");

export const DEFAULT_DB_PATH = "perf-runs.db";

// JMeter's CSV header, mapped to columns. `success` is stored as 0/1 and
// `responseCode` as TEXT — it is not always numeric ("Non HTTP response code:
// java.net.SocketTimeoutException" is a legitimate value).
const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  run_id       TEXT PRIMARY KEY,
  suite        TEXT NOT NULL,
  environment  TEXT NOT NULL,
  version      TEXT,
  started      TEXT,
  started_ms   INTEGER,
  status       TEXT,
  duration     TEXT,
  run_by       TEXT,
  csv_name     TEXT,
  sample_count INTEGER,
  fetched_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS samples (
  run_id       TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  ts           INTEGER NOT NULL,
  elapsed      INTEGER NOT NULL,
  label        TEXT NOT NULL,
  code         TEXT,
  success      INTEGER NOT NULL,
  failure      TEXT,
  bytes        INTEGER,
  sent_bytes   INTEGER,
  grp_threads  INTEGER,
  all_threads  INTEGER,
  latency      INTEGER,
  connect      INTEGER,
  url          TEXT
);

CREATE INDEX IF NOT EXISTS samples_run_label ON samples(run_id, label);
CREATE INDEX IF NOT EXISTS samples_run_ts    ON samples(run_id, ts);
`;

export function openStore(dbPath) {
  mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

export function hasRun(db, runId) {
  return Boolean(db.prepare("SELECT 1 FROM runs WHERE run_id = ?").get(runId));
}

export function deleteRun(db, runId) {
  db.prepare("DELETE FROM samples WHERE run_id = ?").run(runId);
  db.prepare("DELETE FROM runs WHERE run_id = ?").run(runId);
}

/**
 * Parse JMeter's results CSV.
 *
 * This cannot be a line split. JMeter quotes `failureMessage`, and assertion
 * messages routinely contain newlines — a multi-line diff, a stack trace — so
 * splitting on \n shreds those records and silently loses samples. (On the run
 * this was built against, the file has 7,974 lines but 7,950 samples.)
 */
export function parseJmeterCsv(text) {
  const rows = [];
  let field = "";
  let record = [];
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (quoted) {
      if (char !== '"') {
        field += char;
      } else if (text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else {
        quoted = false;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      record.push(field);
      field = "";
    } else if (char === "\n") {
      record.push(field);
      rows.push(record);
      record = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }

  if (field !== "" || record.length > 0) {
    record.push(field);
    rows.push(record);
  }

  const [header, ...body] = rows;
  if (!header) {
    return [];
  }
  const index = Object.fromEntries(header.map((name, at) => [name.trim(), at]));

  // A run killed mid-write leaves a short final record. Drop it rather than
  // storing a half sample.
  return body
    .filter((row) => row.length >= header.length)
    .map((row) => ({
      ts: Number(row[index.timeStamp]),
      elapsed: Number(row[index.elapsed]),
      label: row[index.label],
      code: row[index.responseCode],
      success: row[index.success] === "true" ? 1 : 0,
      failure: row[index.failureMessage] || null,
      bytes: Number(row[index.bytes]) || 0,
      sentBytes: Number(row[index.sentBytes]) || 0,
      grpThreads: Number(row[index.grpThreads]) || 0,
      allThreads: Number(row[index.allThreads]) || 0,
      latency: Number(row[index.Latency]) || 0,
      connect: Number(row[index.Connect]) || 0,
      url: row[index.URL] || null,
    }))
    .filter((sample) => Number.isFinite(sample.ts) && sample.label);
}

const SAMPLE_COLUMNS =
  "run_id, ts, elapsed, label, code, success, failure, bytes, sent_bytes, grp_threads, all_threads, latency, connect, url";

/**
 * Store one run and its samples. Re-ingesting a run replaces it, so a partial
 * or superseded fetch cannot leave duplicate samples behind.
 */
export function ingestRun(db, run, samples) {
  deleteRun(db, run.runId);

  db.prepare(
    `INSERT INTO runs (run_id, suite, environment, version, started, started_ms,
                       status, duration, run_by, csv_name, sample_count, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    run.runId,
    run.suite,
    run.environment,
    run.version ?? null,
    run.started ?? null,
    samples.length ? Math.min(...samples.map((s) => s.ts)) : null,
    run.status ?? null,
    run.duration ?? null,
    run.runBy ?? null,
    run.csvName ?? null,
    samples.length,
    new Date().toISOString(),
  );

  const insert = db.prepare(
    `INSERT INTO samples (${SAMPLE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  db.exec("BEGIN");
  try {
    for (const s of samples) {
      insert.run(
        run.runId,
        s.ts,
        s.elapsed,
        s.label,
        s.code,
        s.success,
        s.failure,
        s.bytes,
        s.sentBytes,
        s.grpThreads,
        s.allThreads,
        s.latency,
        s.connect,
        s.url,
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return samples.length;
}

export function getRun(db, runId) {
  return db.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId) ?? null;
}

export function listRuns(db, suite) {
  const sql = suite
    ? "SELECT * FROM runs WHERE suite = ? ORDER BY started_ms DESC"
    : "SELECT * FROM runs ORDER BY started_ms DESC";
  return suite ? db.prepare(sql).all(suite) : db.prepare(sql).all();
}

/** The run immediately before `runId` in the same suite — the regression baseline. */
export function previousRun(db, run) {
  return (
    db
      .prepare(
        `SELECT * FROM runs
          WHERE suite = ? AND started_ms < ? AND sample_count > 0
          ORDER BY started_ms DESC LIMIT 1`,
      )
      .get(run.suite, run.started_ms) ?? null
  );
}
