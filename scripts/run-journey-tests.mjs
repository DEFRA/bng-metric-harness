import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { error, info, repoPath, requireSibling } from "./_lib.mjs";

requireSibling("bng-metric-journey-tests");

const journeyDir = repoPath("bng-metric-journey-tests");
const required = readFileSync(path.join(journeyDir, ".nvmrc"), "utf8").trim();
const version = required.replace(/^v/, "");
const isWin = process.platform === "win32";

info(`▸ journey-tests using Node v${version} (via nvm)`);

// nvm-windows is a binary on PATH; Unix nvm is a shell function that must
// be sourced first. Either way: switch to the .nvmrc version, then run.
const [cmd, args] = isWin
  ? ["nvm", ["exec", version, "npm", "run", "test:local"]]
  : [
      "bash",
      [
        "-c",
        `. "$NVM_DIR/nvm.sh" && nvm use --silent ${version} && npm run test:local`,
      ],
    ];

const child = spawn(cmd, args, { cwd: journeyDir, stdio: "inherit" });

child.on("error", (err) => {
  error(`Failed to spawn ${cmd}: ${err.message}`);
  info(
    isWin
      ? "  Install nvm-windows: https://github.com/coreybutler/nvm-windows"
      : "  Install nvm: https://github.com/nvm-sh/nvm",
  );
  process.exit(1);
});

child.on("exit", (code) => process.exit(code ?? 1));
