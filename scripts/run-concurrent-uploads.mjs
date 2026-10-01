// Fire N concurrent baseline uploads at a deployed BNG Metric service and watch
// them in tiled browser windows (`npm run uploads:burst -- --url ... --user ...`).
//
// The tool itself lives in bng-perf-tests, alongside the JMeter plan and the
// size-labelled baseline fixtures it uploads — so a window sends exactly the
// file a JMeter phase would. This wrapper exists so it can be reached from the
// harness like every other cross-repo command.
//
// Unlike run-journey-tests.mjs there is no nvm step: that suite pins an exact
// Node in .nvmrc, where bng-perf-tests only asks for a floor in `engines`. So
// the check here is that the Node already in hand clears that floor, which is
// both what the repo actually requires and one less thing to have installed.
//
// Every argument after `--` is passed straight through; this file deliberately
// knows nothing about them, so adding an option to the script does not mean
// editing two places. Run `npm run uploads:burst -- --help` for the list.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { error, info, repoPath, requireSibling } from "./_lib.mjs";

requireSibling("bng-perf-tests");

const perfDir = repoPath("bng-perf-tests");
const script = path.join("scripts", "concurrent-uploads.mjs");

if (!existsSync(path.join(perfDir, script))) {
  error(`${script} is missing from bng-perf-tests`);
  info("  Update that repo (npm run pull) and try again.");
  process.exit(1);
}

if (!existsSync(path.join(perfDir, "node_modules", "@playwright"))) {
  error("Playwright is not installed in bng-perf-tests.");
  info("  cd ../bng-perf-tests && npm install && npx playwright install chromium");
  process.exit(1);
}

const pkg = JSON.parse(
  readFileSync(path.join(perfDir, "package.json"), "utf8"),
);
// `engines.node` is a floor (">=22.11"), not a pin — take the digits.
const required = (pkg.engines?.node ?? "").replace(/[^0-9.]/g, "") || "22.11";

const toParts = (v) => v.replace(/^v/, "").split(".").map(Number);

/** Is `have` at least `want`, comparing major.minor.patch? */
function satisfies(have, want) {
  const a = toParts(have);
  const b = toParts(want);
  for (let i = 0; i < b.length; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) {
      return (a[i] ?? 0) > (b[i] ?? 0);
    }
  }
  return true;
}

if (!satisfies(process.version, required)) {
  error(
    `bng-perf-tests needs Node >=${required}; this shell has ${process.version}.`,
  );
  info(`  nvm install ${required}`);
  process.exit(1);
}

// stdio inherit: the script prompts for a password when one is not supplied,
// and streams progress per window as it goes.
const child = spawn(process.execPath, [script, ...process.argv.slice(2)], {
  cwd: perfDir,
  stdio: "inherit",
});

child.on("error", (err) => {
  error(`Failed to run ${script}: ${err.message}`);
  process.exit(1);
});

child.on("exit", (code) => process.exit(code ?? 1));
