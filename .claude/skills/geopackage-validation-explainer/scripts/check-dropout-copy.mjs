#!/usr/bin/env node
/**
 * Check that the frontend's drop-out page copy (dropout-copy.yaml) and the
 * backend's error codes agree, and exit 1 when they do not.
 *
 * Neither repository's CI can see the other, so a refusal added to the
 * backend with no copy reaches users as the catch-all ("The layer names and
 * column names do not match…") or the backend's technical message, and an
 * entry left behind for a code the backend no longer raises is copy nobody
 * sees. This is the one place both are compared; the harness runs it nightly
 * (.github/workflows/dropout-copy-check.yml).
 *
 * Reads only the backend and the frontend, and needs no installs in either.
 *
 * Usage:
 *   node check-dropout-copy.mjs
 */
import { existsSync } from 'node:fs'
import path from 'node:path'

import { isMain, locateSource, readTextFile } from './_lib.mjs'
import {
  DROPOUT_COPY_FILE,
  copyStatusFromCopyFile,
  extractRegistry
} from './validation-facts.mjs'

/**
 * The backend codes the copy file has no entry for, and the entries it has for
 * codes the backend does not define.
 *
 * @param {Iterable<string>} backendCodes
 * @param {Set<string>} copyCodes
 */
export function compareCodes(backendCodes, copyCodes) {
  const backend = new Set(backendCodes)
  return {
    missing: [...backend].filter((code) => !copyCodes.has(code)).sort(),
    stale: [...copyCodes].filter((code) => !backend.has(code)).sort()
  }
}

function report({ missing, stale }) {
  if (missing.length > 0) {
    console.error(
      `Backend codes with no entry in the frontend's ${DROPOUT_COPY_FILE}, so a user who meets one sees the catch-all or the service's technical message:`
    )
    for (const code of missing) {
      console.error(`  - ${code}`)
    }
  }
  if (stale.length > 0) {
    console.error(
      `Entries in ${DROPOUT_COPY_FILE} for codes the backend no longer defines, so no user sees them:`
    )
    for (const code of stale) {
      console.error(`  - ${code}`)
    }
  }
}

function main() {
  const backendDir = locateSource('backend')
  const frontendDir = locateSource('frontend')
  const copyFile = path.join(frontendDir, DROPOUT_COPY_FILE)
  console.log(`Backend:  ${backendDir}`)
  console.log(`Frontend: ${frontendDir}`)

  if (!existsSync(copyFile)) {
    console.error(`The frontend has no ${DROPOUT_COPY_FILE}.`)
    process.exit(1)
  }

  const backendCodes = Object.keys(extractRegistry(backendDir))
  const { inCopyFile } = copyStatusFromCopyFile(readTextFile(copyFile))
  const result = compareCodes(backendCodes, inCopyFile)

  if (result.missing.length === 0 && result.stale.length === 0) {
    console.log(
      `All ${backendCodes.length} backend error codes have an entry in ${DROPOUT_COPY_FILE}, and it has none for any other code.`
    )
    return
  }
  report(result)
  process.exit(1)
}

if (isMain(import.meta.url)) {
  main()
}
