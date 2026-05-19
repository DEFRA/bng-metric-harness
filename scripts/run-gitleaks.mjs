import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const BIN_NAME = process.platform === 'win32' ? 'gitleaks.exe' : 'gitleaks'
const BUNDLED = path.join(
  REPO_ROOT,
  'node_modules',
  '.gitleaks',
  'bin',
  BIN_NAME
)
const CONFIG = path.join(REPO_ROOT, '.gitleaks.toml')
const RANGE_FALLBACK_DEPTH = 20

function resolveBinary() {
  if (existsSync(BUNDLED)) {
    return BUNDLED
  }
  const probe = spawnSync(BIN_NAME, ['version'], { stdio: 'ignore' })
  if (probe.status === 0) {
    return BIN_NAME
  }
  return null
}

function fail(msg) {
  console.error(`[run-gitleaks] ${msg}`)
  process.exit(1)
}

const mode = process.argv[2] === '--range' ? 'range' : 'staged'
const bin = resolveBinary()
if (!bin) {
  fail(
    'gitleaks not found. Run `npm install` to fetch the bundled binary, ' +
      'or install manually (brew install gitleaks). To skip in an emergency: ' +
      'git commit --no-verify (CI will still block).'
  )
}

const common = ['--redact', '-v']
if (existsSync(CONFIG)) {
  common.push('--config', CONFIG)
}

let args
if (mode === 'staged') {
  args = ['protect', '--staged', ...common]
} else {
  const upstream = spawnSync(
    'git',
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
    { encoding: 'utf8' }
  )
  const range =
    upstream.status === 0
      ? `${upstream.stdout.trim()}..HEAD`
      : `HEAD~${RANGE_FALLBACK_DEPTH}..HEAD`
  args = ['detect', `--log-opts=${range}`, ...common]
}

const r = spawnSync(bin, args, { stdio: 'inherit', cwd: REPO_ROOT })
if (r.status !== 0) {
  console.error(
    `[run-gitleaks] secrets detected (mode=${mode}). Fix or allowlist in .gitleaks.toml.`
  )
  process.exit(r.status ?? 1)
}
