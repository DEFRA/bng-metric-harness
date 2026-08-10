// `npm run perf:up` — start the Tilt stack in perf mode without having to type
// the `BNG_PERF_AUTH=1` prefix (and cross-platform, unlike inline VAR=val).
//
// Perf mode makes the backend trust a local dev key so the perf trigger can mint
// tokens headlessly; it also makes the `perf-tests` button appear in the Tilt UI
// (the button is hidden on a plain `tilt up`, where it could only fail). Any
// extra args are passed through, e.g. `npm run perf:up -- --stream`.
import { spawn } from "node:child_process";
import { error, info } from "./_lib.mjs";

const passthrough = process.argv.slice(2);
const env = { ...process.env, BNG_PERF_AUTH: "1" };

info("▸ starting Tilt in perf mode (BNG_PERF_AUTH=1)");

const child = spawn("tilt", ["up", ...passthrough], { stdio: "inherit", env });

process.on("SIGTERM", () => child.kill("SIGTERM"));
process.on("SIGINT", () => child.kill("SIGINT"));

child.on("error", (err) => {
  error(`Failed to spawn tilt: ${err.message} — is Tilt installed and on PATH?`);
  process.exit(1);
});
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
