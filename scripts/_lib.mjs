import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

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

export const HARNESS_ROOT = path.resolve(import.meta.dirname, "..");
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

export function requireSibling(name) {
  if (!exists(name)) {
    error(`Sibling "${name}" not found at ${repoPath(name)}`);
    info("  → Run `npm run bootstrap` to clone it.");
    process.exit(1);
  }
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
