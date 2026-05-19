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

const GITLEAKS_VERSION = '8.21.2'
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
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status} for ${url}`)
  }
  await pipeline(res.body, createWriteStream(dest))
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

  mkdirSync(INSTALL_DIR, { recursive: true })
  const base = `https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}`
  const workDir = mkdtempSync(path.join(tmpdir(), 'install-gitleaks-'))
  const archivePath = path.join(workDir, asset)
  const sumsPath = path.join(
    workDir,
    `gitleaks_${GITLEAKS_VERSION}_checksums.txt`
  )

  try {
    log(`downloading ${asset}`)
    await download(`${base}/${asset}`, archivePath)
    await download(
      `${base}/gitleaks_${GITLEAKS_VERSION}_checksums.txt`,
      sumsPath
    )
    const expected = readFileSync(sumsPath, 'utf8')
      .split('\n')
      .map((line) => line.trim().split(/\s+/))
      .find(([, name]) => name === asset)?.[0]
    if (!expected) {
      throw new Error(`no checksum entry for ${asset}`)
    }
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
