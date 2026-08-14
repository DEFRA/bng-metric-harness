/**
 * Locate and load the BNG metric engine (`bng-metric-engine`).
 *
 * The engine is a zero-dependency ESM package that lives inside the backend
 * sibling at `bng-metric-backend/bng-metric-engine`. The permutations runner
 * uses it to compute engine-accurate baseline / post-intervention unit totals,
 * so the "Met / Unmet 10% net gain" scenarios can be verified against the same
 * arithmetic the service itself runs — not a re-implementation that could
 * drift.
 *
 * We resolve it by path (the harness convention for reaching siblings) rather
 * than adding a package dependency, because the engine is nested inside another
 * repo and carries no dependencies of its own.
 */

import path from "node:path";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { error, repoPath } from "../_lib.mjs";

const BACKEND_SIBLING = "bng-metric-backend";
const ENGINE_ENTRY = path.join("bng-metric-engine", "src", "index.js");

/**
 * Dynamically import the engine's public API. Exits with a helpful message if
 * the backend sibling (and therefore the engine) is not checked out.
 *
 * @returns {Promise<object>} the engine's module namespace
 */
export async function loadEngine() {
  const entry = path.join(repoPath(BACKEND_SIBLING), ENGINE_ENTRY);
  if (!existsSync(entry)) {
    error(`bng-metric-engine not found at ${entry}`);
    error("  → Run `npm run bootstrap` to clone the backend sibling.");
    process.exit(1);
  }
  return import(pathToFileURL(entry).href);
}
