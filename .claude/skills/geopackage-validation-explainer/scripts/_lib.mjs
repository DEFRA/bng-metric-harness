/**
 * Shared source discovery for the GeoPackage validation explainer scripts.
 *
 * Three repos feed this skill: the backend owns the rules, the frontend owns the
 * message the user actually reads, and the library owns the fixtures that
 * exercise them. Each is located by probing for the specific file the skill
 * needs rather than by package name, so a repo that has been renamed or moved
 * still resolves as long as the file is where we expect it.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

export const HARNESS_ROOT = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..'
)
export const WORKSPACE_ROOT = path.resolve(HARNESS_ROOT, '..')

/** Directories that never contain source worth scanning. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'coverage',
  'dist',
  '_site',
  '.next'
])

export const SOURCES = Object.freeze({
  backend: {
    label: 'bng-metric-backend',
    dirName: 'bng-metric-backend',
    env: 'BNG_BACKEND_DIR',
    marker: path.join('src', 'validation', 'geopackage', 'errors.js')
  },
  frontend: {
    label: 'bng-metric-frontend',
    dirName: 'bng-metric-frontend',
    env: 'BNG_FRONTEND_DIR',
    marker: path.join('src', 'server', 'error-file', 'single-error-copy.js')
  },
  library: {
    label: 'bng-library',
    dirName: 'bng-library',
    env: 'BNG_LIBRARY_DIR',
    marker: path.join('src', 'synthetic', 'flaws.mjs')
  }
})

function candidateDirs(source) {
  return [
    process.env[source.env],
    path.join(WORKSPACE_ROOT, source.dirName),
    path.join(HARNESS_ROOT, source.dirName)
  ].filter(Boolean)
}

/**
 * Find one of the three source repos on disk, or exit 1 with guidance.
 * @param {keyof typeof SOURCES} key
 */
export function locateSource(key) {
  const source = SOURCES[key]
  const found = candidateDirs(source).find((dir) =>
    existsSync(path.join(dir, source.marker))
  )
  if (!found) {
    console.error(
      `Could not find ${source.label} (looking for ${source.marker}). Looked in:\n` +
        candidateDirs(source)
          .map((dir) => `  - ${dir}`)
          .join('\n') +
        `\n\nSet ${source.env} to its location, or run 'npm run bootstrap' in the harness.`
    )
    process.exit(1)
  }
  return found
}

/** Absolute path to a file inside a located source repo. */
export function sourceFile(key, relativePath) {
  return path.join(locateSource(key), relativePath)
}

export function readTextFile(filePath) {
  return readFileSync(filePath, 'utf8')
}

/**
 * Directories in which `git` may live. Inherited PATH is not used: a writable
 * directory on PATH would let an attacker substitute the binary (javascript:S4036).
 */
const GIT_SEARCH_PATH = '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin'

/**
 * Run git with a fixed PATH. Encoding is always utf8 so callers get a string.
 * @param {string[]} args
 * @param {string} cwd
 */
export function runGit(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { PATH: GIT_SEARCH_PATH, GIT_TERMINAL_PROMPT: '0' }
  })
}

/** Commit, commit date and branch for a repo, or nulls when git is unavailable. */
export function gitProvenance(dir) {
  const run = (args) => runGit(args, dir).trim()
  try {
    return {
      commit: run(['rev-parse', 'HEAD']),
      committedAt: run(['log', '-1', '--format=%cI']),
      branch: run(['rev-parse', '--abbrev-ref', 'HEAD'])
    }
  } catch {
    return { commit: null, committedAt: null, branch: null }
  }
}

/** Every file under `dir` with one of `extensions`, skipping tests and build output. */
export function walkSourceFiles(
  dir,
  extensions,
  { includeTests = false } = {}
) {
  const results = []
  const visit = (current) => {
    for (const entry of readdirSync(current)) {
      if (SKIP_DIRS.has(entry)) {
        continue
      }
      const full = path.join(current, entry)
      if (statSync(full).isDirectory()) {
        visit(full)
        continue
      }
      if (!extensions.includes(path.extname(entry))) {
        continue
      }
      if (!includeTests && /\.test\.[mc]?js$/.test(entry)) {
        continue
      }
      results.push(full)
    }
  }
  visit(dir)
  return results
}

/**
 * Slice the balanced `{...}` block that starts at or after `fromIndex`.
 * Brace counting only — good enough for the object literals this skill reads,
 * and it fails loudly (returns null) rather than guessing.
 */
export function balancedBraceBlock(text, fromIndex) {
  const start = text.indexOf('{', fromIndex)
  if (start === -1) {
    return null
  }
  let depth = 0
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === '{') {
      depth += 1
    } else if (text[i] === '}') {
      depth -= 1
      if (depth === 0) {
        return text.slice(start, i + 1)
      }
    }
  }
  return null
}

/** 1-based line number of a character offset. */
export function lineOf(text, index) {
  const NEWLINES_BEFORE_FIRST_LINE = 1
  return (
    text.slice(0, index).split('\n').length - NEWLINES_BEFORE_FIRST_LINE + 1
  )
}

/** Read `--flag value` from argv, or a default. */
export function argValue(flag, fallback = null) {
  const index = process.argv.indexOf(flag)
  const NOT_FOUND = -1
  if (index === NOT_FOUND || index === process.argv.length - 1) {
    return fallback
  }
  return process.argv[index + 1]
}

export function hasFlag(flag) {
  return process.argv.includes(flag)
}
