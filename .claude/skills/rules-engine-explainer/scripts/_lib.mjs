/**
 * Shared engine discovery for the rules-engine explainer scripts.
 *
 * The statutory calculations used to be a standalone `bng-metric-engine`
 * package nested inside the backend. They now live in bng-library, as the
 * `bng-library/metric` subpath export backed by `src/metric/`, so discovery
 * looks for that directory rather than for a package manifest with a
 * particular name.
 *
 * Discovery stays path-based rather than importing the package: the explainer
 * reads the reference JSON and the source files themselves, and reports the
 * git provenance of the repo they sit in, none of which a bare import exposes.
 * Candidates are checked most-likely location first, and `BNG_ENGINE_DIR` still
 * overrides — pointing at the `src/metric` directory, or at a bng-library
 * checkout, either works.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

export const HARNESS_ROOT = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..'
)
export const WORKSPACE_ROOT = path.resolve(HARNESS_ROOT, '..')

/** The npm package that now publishes the engine, and its subpath export. */
export const PACKAGE_NAME = 'bng-library'
export const ENTRY_POINT = 'bng-library/metric'

/** Where the engine sits inside a bng-library checkout. */
const METRIC_SUBDIR = path.join('src', 'metric')

/** Named in the recovery advice, since `npm run bootstrap` does not clone it. */
const LIBRARY_REMOTE = 'git@github.com:DEFRA/bng-library.git'

/** Source files are .mjs here, and the entry point is index.mjs. */
export const SOURCE_EXTENSION = '.mjs'
const ENGINE_INDEX = 'index.mjs'

const LIBRARY_ROOTS = [
  path.join(WORKSPACE_ROOT, 'bng-library'),
  path.join(HARNESS_ROOT, 'library'),
  path.join(HARNESS_ROOT, 'node_modules', 'bng-library')
]

const CANDIDATE_DIRS = [
  // An explicit override may name the metric directory itself or the library
  // checkout that contains it; accept both.
  process.env.BNG_ENGINE_DIR,
  process.env.BNG_ENGINE_DIR &&
    path.join(process.env.BNG_ENGINE_DIR, METRIC_SUBDIR),
  ...LIBRARY_ROOTS.map((root) => path.join(root, METRIC_SUBDIR))
].filter(Boolean)

/**
 * A directory is the engine when it holds the module entry point and the
 * reference tables the explainer reads.
 */
function isEngineDir(dir) {
  return (
    existsSync(path.join(dir, ENGINE_INDEX)) &&
    existsSync(path.join(dir, 'reference'))
  )
}

/**
 * Find the engine sources on disk, or exit 1 with guidance.
 *
 * The advice deliberately does not mention `npm run bootstrap`: that clones the
 * frontend and backend siblings only, so for every candidate below it would
 * report success and leave this failing identically. {@link PACKAGE_NAME} is a
 * dependency of the harness, satisfied by installing it or by checking it out.
 */
export function locateEngine() {
  const found = CANDIDATE_DIRS.find(isEngineDir)
  if (!found) {
    console.error(
      `Could not find the ${ENTRY_POINT} sources. Looked in:\n` +
        CANDIDATE_DIRS.map((d) => `  - ${d}`).join('\n') +
        `\n\n${PACKAGE_NAME} is a dependency of this harness, not a sibling` +
        ` that 'npm run bootstrap' clones. Install it with 'npm install' (or` +
        ` 'npm ci') in the harness, or check it out beside the harness:\n` +
        `  git clone ${LIBRARY_REMOTE}\n\n` +
        `Set BNG_ENGINE_DIR to override discovery — it may name the bng-library` +
        ` checkout or its ${METRIC_SUBDIR} directory.`
    )
    process.exit(1)
  }
  return found
}

/**
 * The bng-library checkout containing a located engine directory — where the
 * package manifest and the git history live.
 *
 * @param {string} engineDir as returned by {@link locateEngine}
 */
export function libraryRoot(engineDir) {
  return path.resolve(engineDir, '..', '..')
}

/** Read the bng-library package manifest for a located engine directory. */
export function readPackageManifest(engineDir) {
  return JSON.parse(
    readFileSync(path.join(libraryRoot(engineDir), 'package.json'), 'utf8')
  )
}

/** Import the engine's public API from a located engine directory. */
export function importEngine(engineDir) {
  return import(`file://${path.join(engineDir, ENGINE_INDEX)}`)
}
