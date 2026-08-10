import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { error, info, loadEnvFile, repoPath, requireSibling } from "./_lib.mjs";

const USAGE =
  "Usage: run-with-nodejs.mjs <sibling> [--env KEY=VAL]... [--env-file PATH]... <npm-args...>";

const argv = process.argv.slice(2);
const sibling = argv.shift();
if (!sibling) {
  error(USAGE);
  process.exit(1);
}
requireSibling(sibling);

const env = { ...process.env };
// Two ways to hand extra env to the child: inline `--env KEY=VAL` (small, visible
// values) and `--env-file PATH` (a dotenv file — used for large/awkward values
// like a JWKS JSON that would need fragile shell-quoting inline). File values are
// merged in the order given; a later --env of the same key still wins.
while (argv[0] === "--env" || argv[0] === "--env-file") {
  if (argv[0] === "--env-file") {
    const file = argv[1];
    if (!file) {
      error("Missing path after --env-file");
      process.exit(1);
    }
    const vars = loadEnvFile(path.resolve(file));
    if (!vars) {
      error(`Env file not found or unreadable: ${file}`);
      process.exit(1);
    }
    Object.assign(env, vars);
    argv.splice(0, 2);
    continue;
  }
  const [k, ...v] = (argv[1] ?? "").split("=");
  if (!k || v.length === 0) {
    error(`Invalid --env value: ${argv[1]}`);
    process.exit(1);
  }
  env[k] = v.join("=");
  argv.splice(0, 2);
}

if (argv.length === 0) {
  error(USAGE);
  process.exit(1);
}

const siblingDir = repoPath(sibling);
const version = readFileSync(path.join(siblingDir, ".nvmrc"), "utf8")
  .trim()
  .replace(/^v/, "");
const isWin = process.platform === "win32";

info(`▸ ${sibling}: Node v${version} | npm ${argv.join(" ")}`);

// nvm-windows is a binary; Unix nvm is a shell function that must be sourced.
const [cmd, args] = isWin
  ? ["nvm", ["exec", version, "npm", ...argv]]
  : [
      "bash",
      [
        "-c",
        `. "$NVM_DIR/nvm.sh" && nvm use ${version} >/dev/null && exec npm "$@"`,
        "run-with-nodejs",
        ...argv,
      ],
    ];

const child = spawn(cmd, args, { cwd: siblingDir, stdio: "inherit", env });

process.on("SIGTERM", () => child.kill("SIGTERM"));
process.on("SIGINT", () => child.kill("SIGINT"));

child.on("error", (err) => {
  error(
    `Failed to spawn ${cmd}: ${err.message} — is ${isWin ? "nvm-windows" : "nvm"} installed?`,
  );
  process.exit(1);
});
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
