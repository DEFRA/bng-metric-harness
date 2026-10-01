import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const ansi = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
};

export const color = (name, text) => `${ansi[name] ?? ""}${text}${ansi.reset}`;

export const REPOS = [
  {
    key: "fe",
    name: "bng-metric-frontend",
    remote: "git@github.com:DEFRA/bng-metric-frontend.git",
    color: "cyan",
  },
  {
    key: "be",
    name: "bng-metric-backend",
    remote: "git@github.com:DEFRA/bng-metric-backend.git",
    color: "magenta",
  },
];

export const HARNESS_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const WORKSPACE_ROOT = path.resolve(HARNESS_ROOT, "..");

export const repoPath = (name) => path.resolve(WORKSPACE_ROOT, name);

export const exists = (name) => existsSync(repoPath(name));

export const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";

export function header(label, colorName = "blue") {
  const line = "─".repeat(Math.max(0, 60 - label.length - 3));
  console.log(
    color(colorName, `\n${color("bold", `▸ ${label}`)} ${color("dim", line)}`),
  );
}

export function warn(msg) {
  console.log(color("yellow", `⚠ ${msg}`));
}

export function info(msg) {
  console.log(color("dim", msg));
}

export function error(msg) {
  console.error(color("red", `✖ ${msg}`));
}

export function run(
  cmd,
  args,
  { cwd = process.cwd(), env = process.env } = {},
) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, stdio: "inherit" });
    child.on("close", (code) => resolve(code ?? 0));
    child.on("error", (err) => {
      error(`Failed to spawn ${cmd}: ${err.message}`);
      resolve(1);
    });
  });
}

export function runCapture(cmd, args, { cwd = process.cwd() } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
    child.on("error", () => resolve({ code: 1, stdout, stderr }));
  });
}

// Compact local timestamp (YYYYMMDD-HHMM-SS) used to keep generated filenames
// unique per run.
export function timestampSuffix(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

// Reads a .env file and returns its parsed key/value pairs, or null if the file
// is absent or unreadable. Uses node:util's built-in parseEnv (Node 20.12+) so
// the harness stays dependency-free — the siblings use `dotenv`, but the harness
// only needs to hand values to a child process, not populate its own process.env.
export function loadEnvFile(filePath) {
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    return parseEnv(readFileSync(filePath, "utf8"));
  } catch (err) {
    warn(`Could not read ${filePath}: ${err.message}`);
    return null;
  }
}

export function requireSibling(name) {
  if (!exists(name)) {
    error(`Sibling "${name}" not found at ${repoPath(name)}`);
    info("  → Run `npm run bootstrap` to clone it.");
    process.exit(1);
  }
}

/**
 * Resolve a user-supplied path, throwing unless it lies inside the harness:
 * the generators read templates from it, write into it and clear parts of
 * it. Symlinks in the part that already exists are resolved first, so none
 * can lead out.
 */
export function resolveInsideHarness(target, flag) {
  const baseDir = realpathSync(HARNESS_ROOT);
  let existing = path.resolve(baseDir, target);
  while (!existsSync(existing)) {
    existing = path.dirname(existing);
  }
  const resolved = path.join(
    realpathSync(existing),
    path.relative(existing, path.resolve(baseDir, target)),
  );
  if (!resolved.startsWith(baseDir + path.sep)) {
    throw new Error(
      `${flag} must be inside the harness (${baseDir}), got: ${target}`,
    );
  }
  return resolved;
}

export function parseTarget(argv, { allowAll = true, fallback = "all" } = {}) {
  const raw = argv[0];
  const valid = allowAll ? ["fe", "be", "all"] : ["fe", "be"];
  if (!raw) return fallback;
  if (!valid.includes(raw)) {
    error(`Unknown target "${raw}". Expected one of: ${valid.join(", ")}.`);
    process.exit(1);
  }
  return raw;
}

export function reposForTarget(target) {
  if (target === "all") return REPOS;
  return REPOS.filter((r) => r.key === target);
}

/**
 * Run `step` on each item in turn, each waiting for the one before, and
 * resolve to their results in order. For work that must not overlap: steps
 * that share state, or whose output should read in order. Recursive rather
 * than a loop, so the one-at-a-time intent lives here, named, instead of in
 * an `await` inside each caller's loop.
 *
 * @template T, R
 * @param {T[]} items
 * @param {(item: T, index: number) => Promise<R> | R} step
 * @returns {Promise<R[]>}
 */
export async function mapInSequence(items, step) {
  const results = [];
  const next = async (index) => {
    if (index >= items.length) {
      return results;
    }
    results.push(await step(items[index], index));
    return next(index + 1);
  };
  return next(0);
}

/**
 * Call `probe` until it resolves truthy, waiting `intervalMs` between tries,
 * for at most `attempts` tries. A probe that throws counts as a failed try.
 *
 * @param {() => Promise<unknown>} probe
 * @param {{ attempts: number, intervalMs: number }} options
 * @returns {Promise<boolean>} whether the probe ever succeeded
 */
export async function pollUntil(probe, { attempts, intervalMs }) {
  const succeeded = await probe().then(Boolean, () => false);
  if (succeeded) {
    return true;
  }
  if (attempts <= 1) {
    return false;
  }
  await new Promise((resolve) => setTimeout(resolve, intervalMs));
  return pollUntil(probe, { attempts: attempts - 1, intervalMs });
}
