/**
 * Load a local `.env`, so the OS key does not have to be typed on every run.
 *
 * Uses Node's built-in `process.loadEnvFile` (Node >= 20.12) rather than
 * `dotenv`, which keeps the spike's dependency list at pdfkit. The built-in
 * gives the precedence we want for free: a real environment variable BEATS the
 * file, so `OS_MAPS_MAX_ZOOM=13 node src/cli.mjs --os` still overrides a 9 in
 * the `.env` without editing it.
 *
 * Two locations are tried, nearest first:
 *
 *   1. spikes/bmd-984-pdf-export/.env   spike-local, the usual case
 *   2. <harness root>/.env              the harness's existing convention for
 *                                       secrets (see the root CLAUDE.md)
 *
 * Both are covered by the root `.gitignore` (`.env`, `.env.*`). A missing file
 * is not an error — `--proxy` and the default build need no key at all.
 *
 * Logs which file was used and WHICH KEYS it set, never the values. That is
 * the same rule `scripts/dev.mjs` follows in the harness.
 */

import fs from 'node:fs'
import path from 'node:path'

const SPIKE_ROOT = path.resolve(import.meta.dirname, '..')
const HARNESS_ROOT = path.resolve(SPIKE_ROOT, '..', '..')

const CANDIDATES = [path.join(SPIKE_ROOT, '.env'), path.join(HARNESS_ROOT, '.env')]

/**
 * @returns {{ file: string|null, keys: string[] }} what was loaded, for logging
 */
let loaded = null

export function loadEnv({ log = console.log } = {}) {
  // Idempotent: the CLI loads, then imports the server, which may load again.
  // Loading twice is harmless but logging twice is noise.
  if (loaded) {
    return loaded
  }

  const file = CANDIDATES.find((candidate) => fs.existsSync(candidate))
  if (!file) {
    loaded = { file: null, keys: [] }
    return loaded
  }

  const before = new Set(Object.keys(process.env))
  process.loadEnvFile(file)
  const keys = Object.keys(process.env).filter((key) => !before.has(key))

  // Names only. A value here would defeat the point of the file.
  log(`Env        : ${path.relative(HARNESS_ROOT, file)} → ${keys.join(', ') || '(nothing new)'}`)
  loaded = { file, keys }
  return loaded
}
