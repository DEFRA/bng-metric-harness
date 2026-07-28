/**
 * Shared engine discovery for the rules-engine explainer scripts.
 *
 * The engine is expected to move out of the backend at some point (see
 * docs/move-engine-into-bng-lib.md), so discovery is deliberately path-agnostic
 * rather than hardcoded: each candidate directory is checked for a package.json
 * with the right name, most-likely location first.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

export const HARNESS_ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..')
export const WORKSPACE_ROOT = path.resolve(HARNESS_ROOT, '..')
export const PACKAGE_NAME = 'bng-metric-engine'

const CANDIDATE_DIRS = [
  process.env.BNG_ENGINE_DIR,
  path.join(WORKSPACE_ROOT, 'bng-metric-backend', PACKAGE_NAME),
  path.join(WORKSPACE_ROOT, 'bng-library', 'packages', PACKAGE_NAME),
  path.join(WORKSPACE_ROOT, 'bng-library', PACKAGE_NAME),
  path.join(WORKSPACE_ROOT, PACKAGE_NAME),
  path.join(HARNESS_ROOT, 'packages', PACKAGE_NAME)
].filter(Boolean)

function isEnginePackage(dir) {
  const manifest = path.join(dir, 'package.json')
  if (!existsSync(manifest)) {
    return false
  }
  try {
    return JSON.parse(readFileSync(manifest, 'utf8')).name === PACKAGE_NAME
  } catch {
    return false
  }
}

/** Find the engine package on disk, or exit 1 with guidance. */
export function locateEngine() {
  const found = CANDIDATE_DIRS.find(isEnginePackage)
  if (!found) {
    console.error(
      `Could not find the ${PACKAGE_NAME} package. Looked in:\n` +
        CANDIDATE_DIRS.map((d) => `  - ${d}`).join('\n') +
        `\n\nSet BNG_ENGINE_DIR to its location, or run 'npm run bootstrap' in the harness.`
    )
    process.exit(1)
  }
  return found
}

/** Import the engine's public API from a located package directory. */
export function importEngine(engineDir) {
  return import(`file://${path.join(engineDir, 'src', 'index.js')}`)
}
