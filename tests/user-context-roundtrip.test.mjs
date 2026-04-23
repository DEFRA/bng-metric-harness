import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const fePath = path.resolve(
  here,
  '..',
  '..',
  'bng-metric-frontend',
  'src',
  'server',
  'common',
  'helpers',
  'user-context'
)
const bePath = path.resolve(
  here,
  '..',
  '..',
  'bng-metric-backend',
  'src',
  'common',
  'helpers',
  'user-context'
)

const { signUserContext } = await import(`${fePath}/sign.js`)
const { verifyUserContextToken } = await import(`${bePath}/verify.js`)
const {
  ExpiredTokenError,
  InvalidSignatureError
} = await import(`${bePath}/errors.js`)

const ROOT = 'cross-project-root-secret'
const PERIOD = 3600
const TTL = 60
const NOW = 1_700_000_000_000

test('FE sign → BE verify with the same root secret round-trips', () => {
  const token = signUserContext('user-1', 'sid-1', {
    rootSecret: ROOT,
    periodSeconds: PERIOD,
    tokenTtlSeconds: TTL,
    now: NOW
  })

  const claims = verifyUserContextToken(token, {
    rootSecret: ROOT,
    periodSeconds: PERIOD,
    clockSkewEpochs: 1,
    now: NOW
  })

  assert.equal(claims.userId, 'user-1')
  assert.equal(claims.sid, 'sid-1')
})

test('Verify fails when the root secret on the BE differs from the FE', () => {
  const token = signUserContext('user-1', 'sid-1', {
    rootSecret: ROOT,
    periodSeconds: PERIOD,
    tokenTtlSeconds: TTL,
    now: NOW
  })

  assert.throws(
    () =>
      verifyUserContextToken(token, {
        rootSecret: 'different-root',
        periodSeconds: PERIOD,
        clockSkewEpochs: 1,
        now: NOW
      }),
    InvalidSignatureError
  )
})

test('Verify fails when more than clockSkewEpochs have passed since signing', () => {
  const token = signUserContext('user-1', 'sid-1', {
    rootSecret: ROOT,
    periodSeconds: PERIOD,
    tokenTtlSeconds: TTL,
    now: NOW
  })

  // Verify two epochs later (skew=1 only allows ±1)
  const futureNow = NOW + 2 * PERIOD * 1000

  assert.throws(
    () =>
      verifyUserContextToken(token, {
        rootSecret: ROOT,
        periodSeconds: PERIOD,
        clockSkewEpochs: 1,
        now: futureNow
      }),
    ExpiredTokenError
  )
})

test('Verify accepts a token issued in the previous epoch (within skew)', () => {
  const token = signUserContext('user-1', 'sid-1', {
    rootSecret: ROOT,
    periodSeconds: PERIOD,
    tokenTtlSeconds: PERIOD * 2, // make sure exp is still in the future
    now: NOW
  })

  // One epoch later — still inside the skew window
  const laterNow = NOW + PERIOD * 1000 + 1000

  const claims = verifyUserContextToken(token, {
    rootSecret: ROOT,
    periodSeconds: PERIOD,
    clockSkewEpochs: 1,
    now: laterNow
  })

  assert.equal(claims.userId, 'user-1')
})
