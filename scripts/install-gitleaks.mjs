import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'

// Pinned gitleaks release. Bump GITLEAKS_VERSION and PINNED_CHECKSUMS together —
// copy the per-asset sha256 values verbatim from the release's *_checksums.txt.
// Pinning digests in-repo (rather than trusting a checksums file fetched at
// install time from the same origin as the binary) means a tampered release is
// rejected, not just a corrupted download. Dependabot does not track this binary,
// so the version is bumped by hand: https://github.com/gitleaks/gitleaks/releases
const GITLEAKS_VERSION = '8.21.2'
const PINNED_CHECKSUMS = {
  'gitleaks_8.21.2_darwin_x64.tar.gz':
    '5b42c6e4b1fd693eaeb2b5b7faa5f17a1434299d4deb2de63d4b2efd7c753128',
  'gitleaks_8.21.2_darwin_arm64.tar.gz':
    'cad3de5dc9a4d5447d967a70a4d49499c557f04db028274cc324f9ff983f6502',
  'gitleaks_8.21.2_linux_x64.tar.gz':
    '5bc41815076e6ed6ef8fbecc9d9b75bcae31f39029ceb55da08086315316e3ba',
  'gitleaks_8.21.2_linux_arm64.tar.gz':
    '654c935542c89f565aabe7bf7c6c500830f116c114f0aeb509d2460c1ac2e6da',
  'gitleaks_8.21.2_windows_x64.zip':
    'f238c85e5f47e18fac779ce71ee11091cf70a0a8fb4415f165efba2800eef133'
}
const DOWNLOAD_TIMEOUT_MS = 60_000
const EXECUTABLE_PERMS = 0o755
const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const INSTALL_DIR = path.join(REPO_ROOT, 'node_modules', '.gitleaks', 'bin')
const BIN_NAME = process.platform === 'win32' ? 'gitleaks.exe' : 'gitleaks'
const TARGET = path.join(INSTALL_DIR, BIN_NAME)

const log = (msg) => console.log(`[install-gitleaks] ${msg}`)
const warn = (msg) => console.warn(`[install-gitleaks] ${msg}`)

function detectAsset() {
  const archMap = { x64: 'x64', arm64: 'arm64' }
  const platformMap = { darwin: 'darwin', linux: 'linux', win32: 'windows' }
  const a = archMap[process.arch]
  const p = platformMap[process.platform]
  if (!a || !p) {
    return null
  }
  const ext = process.platform === 'win32' ? 'zip' : 'tar.gz'
  return `gitleaks_${GITLEAKS_VERSION}_${p}_${a}.${ext}`
}

function systemGitleaksOnPath() {
  const r = spawnSync(BIN_NAME, ['version'], { stdio: 'ignore' })
  return r.status === 0
}

async function download(url, dest) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal
    })
    if (!res.ok || !res.body) {
      throw new Error(`HTTP ${res.status} for ${url}`)
    }
    await pipeline(res.body, createWriteStream(dest))
  } finally {
    clearTimeout(timeout)
  }
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function extract(archive, cwd) {
  return new Promise((resolve, reject) => {
    const args =
      process.platform === 'win32'
        ? ['-xf', archive, '-C', cwd]
        : ['-xzf', archive, '-C', cwd]
    const child = spawn('tar', args, { stdio: 'inherit' })
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`tar exited ${code}`))
    )
    child.on('error', reject)
  })
}

async function main() {
  if (process.env.SKIP_GITLEAKS_INSTALL === '1') {
    log('SKIP_GITLEAKS_INSTALL=1, skipping')
    return
  }
  if (existsSync(TARGET)) {
    log(`already installed at ${TARGET}`)
    return
  }
  if (systemGitleaksOnPath()) {
    log('system gitleaks found on PATH, skipping bundled install')
    return
  }

  const asset = detectAsset()
  if (!asset) {
    warn(
      `unsupported platform ${process.platform}/${process.arch} — install manually: https://github.com/gitleaks/gitleaks`
    )
    return
  }

  const expected = PINNED_CHECKSUMS[asset]
  if (!expected) {
    warn(
      `no pinned checksum for ${asset} — install manually: https://github.com/gitleaks/gitleaks`
    )
    return
  }

  mkdirSync(INSTALL_DIR, { recursive: true })
  const base = `https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}`
  const workDir = mkdtempSync(path.join(tmpdir(), 'install-gitleaks-'))
  const archivePath = path.join(workDir, asset)

  try {
    log(`downloading ${asset}`)
    await download(`${base}/${asset}`, archivePath)
    const actual = sha256(archivePath)
    if (actual !== expected) {
      throw new Error(`checksum mismatch: expected ${expected}, got ${actual}`)
    }
    log('checksum OK, extracting')
    await extract(archivePath, INSTALL_DIR)
    if (process.platform !== 'win32') {
      chmodSync(TARGET, EXECUTABLE_PERMS)
    }
    log(`installed at ${TARGET}`)
  } catch (err) {
    warn(`failed: ${err.message}`)
    warn(
      'fallback: brew install gitleaks  |  apt install gitleaks  |  choco install gitleaks'
    )
    warn('pre-commit hook will still try PATH.')
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}

await main()
