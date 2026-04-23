# Plan — HKDF-derived signed user-context header

## Overview

Add a signed `x-user-context` header on every FE → BE HTTP call. The signing key is derived per time-epoch from a long-lived root secret held by both services via `config.js`. Rotation is automatic: keys change every epoch with no deploy, no coordination, no shared storage. Only the root needs manual rotation.

---

## 1. Config additions

Add a `userContext` section to **both** `config.js` files. Human-readable defaults so local dev works out of the box; environments override via env vars.

**`backend/src/config.js`:**

```js
userContext: {
  rootSecret: {
    doc: 'Root secret (base64) for deriving per-epoch HMAC signing keys used to authenticate FE→BE calls. MUST be overridden per environment.',
    format: String,
    default: 'local-dev-only-root-secret-change-me-per-environment',
    env: 'USER_CONTEXT_ROOT_SECRET',
    sensitive: true
  },
  rotationPeriodSeconds: {
    doc: 'How often the derived signing key rotates. Both services must agree.',
    format: Number,
    default: 3600,
    env: 'USER_CONTEXT_ROTATION_PERIOD_SECONDS'
  },
  tokenTtlSeconds: {
    doc: 'Maximum lifetime of an individual signed header.',
    format: Number,
    default: 60,
    env: 'USER_CONTEXT_TOKEN_TTL_SECONDS'
  },
  clockSkewEpochs: {
    doc: 'Neighbouring epochs to accept on verify, for clock skew and boundary crossings.',
    format: Number,
    default: 1,
    env: 'USER_CONTEXT_CLOCK_SKEW_EPOCHS'
  }
}
```

**`frontend/src/config/config.js`:** same four entries, identical defaults. Only `rootSecret`, `rotationPeriodSeconds`, `tokenTtlSeconds` are used on the FE side — `clockSkewEpochs` is BE-only but duplicate for parity and to keep the shape identical.

Update `config.test.js` in each project to cover the new entries.

---

## 2. Backend changes

**New file: `backend/src/common/helpers/user-context/derive-key.js`**

- Exports `deriveKey(rootSecret, epoch)` using `hkdfSync('sha256', root, salt=empty, info=\`bng-ctx-v1:${epoch}\`, 32)`.
- Exports `currentEpoch(periodSeconds, now = Date.now())`.
- Pure functions, no config reads — keeps them unit-testable.

**New file: `backend/src/common/helpers/user-context/verify.js`**

- Exports `verifyUserContextToken(token, { rootSecret, periodSeconds, clockSkewEpochs, now })`.
- Parses `body.sig`, base64url-decodes body, parses JSON.
- Rejects if `|payload.epoch - currentEpoch()| > clockSkewEpochs`.
- Derives `K = deriveKey(root, payload.epoch)`, recomputes HMAC-SHA256 over `body`, compares with `timingSafeEqual`.
- Rejects if `payload.exp < now` or `payload.iat > now + 30` (future-dated tolerance).
- Returns `{ userId, sid, iat, exp, epoch }` or throws a typed error (`InvalidSignatureError`, `ExpiredTokenError`, `MalformedTokenError`).

**New file: `backend/src/plugins/user-context.js`**

- Hapi plugin registered in `src/index.js` after `postgres` and before `router`.
- `server.ext('onPreHandler', …)`:
  - Reads `request.headers['x-user-context']`.
  - Skips enforcement for a small allowlist of unauthenticated routes (`/health`, `/db-info` — confirm during implementation).
  - Calls `verifyUserContextToken`, attaches result to `request.app.userContext`.
  - On failure throws `Boom.unauthorized()` with no detail in the response body; logs the specific reason server-side.

**Update: `backend/src/routes/users.js`**

- Add guard: `if (request.app.userContext.userId !== userId) throw Boom.forbidden()`.
- Add Joi validation on the path param (separate from this concern but should land together — per review).

**Update: `backend/src/routes/projects.js`**

- `createProject`: assert `request.app.userContext.userId === request.payload.userId`.
- `getProject`, `getProjects`: enforce ownership in the query (`where userId = request.app.userContext.userId`) or add post-query check.

**Update: `backend/src/plugins/router.js`**

- No change required beyond the order in which `user-context` is registered relative to routes (must be before).

**Tests:**

- `derive-key.test.js` — same root + same epoch → same key; different epoch → different key.
- `verify.test.js` — valid token round-trip; rejects bad sig, expired, future, wrong epoch, malformed.
- `user-context.test.js` (plugin) — injects a request with header, asserts `request.app.userContext`; missing header → 401; bad header → 401.
- Update `projects.test.js` and `users.test.js` to seed `request.app.userContext` in handler-level tests.

---

## 3. Frontend changes

**New file: `frontend/src/server/common/helpers/user-context/sign.js`**

- Exports `signUserContext(userId, sid, { rootSecret, periodSeconds, tokenTtlSeconds, now })`.
- Mirrors BE derivation (copy of `derive-key.js` logic — deliberately duplicated, both projects own their copy; see docs for why).
- Builds payload `{ userId, sid, iat, exp, epoch }`, base64url-encodes, HMACs with derived key, returns `body.sig`.

**New file: `frontend/src/server/common/helpers/user-context/derive-key.js`**

- Same pure functions as BE copy.

**New file: `frontend/src/server/common/services/backend-client.js`**

- Thin wrapper around Wreck that all backend calls go through.
- Signature: `backendClient(request).get(path, opts)` / `.post(path, opts)` / `.put(path, opts)`.
- Pulls `userId` and `sid` from `request.auth.credentials` (or wherever the session-cached identity lives — confirm during implementation against `src/server/auth/`).
- Calls `signUserContext(...)` and adds `x-user-context` to the outgoing headers.
- Uses `config.get('backend').url` as base URL.

**Update: `frontend/src/server/common/services/baseline.js`**

- Change signature from `validateBaseline(uploadId)` to `validateBaseline(request, uploadId)`.
- Replace `Wreck.post(url, { json: true })` with `backendClient(request).post('/baseline/validate/' + uploadId, { json: true })`.
- Propagate the `request` argument at all call sites (search: `grep -rn validateBaseline src/`).

**Update: `frontend/src/server/common/services/uploader.js`**

- Same pattern — route the `request` through, call via `backendClient`.

**Update: any other BE call sites** — sweep with `grep -rn backendUrl src/server/`; expect only `baseline.js` and `uploader.js` but verify.

**Tests:**

- `sign.test.js` — deterministic output given fixed inputs; token parses; epoch matches expected.
- `derive-key.test.js` — parity test with BE copy (can duplicate the test).
- `backend-client.test.js` — mocks Wreck, asserts the `x-user-context` header is present and well-formed.
- Update service-level tests to thread through a fake `request` with `auth.credentials`.

---

## 4. Cross-project parity test

Add `bng-metric-harness/tests/user-context-roundtrip.test.js` (or equivalent — confirm harness structure):

- Imports FE `signUserContext` and BE `verifyUserContextToken`.
- Signs with root `R`, verifies with root `R` → succeeds.
- Signs with `R`, verifies with `R'` → fails.
- Signs in epoch N, verifies in epoch N+2 → fails.

This is the single most important regression test because the two sides' crypto must stay in lockstep through future refactors.

---

## 5. Documentation

**New file: `backend/docs/user-context-auth.md`**

Sections:

- **Purpose** — why we sign: reinforces the "FE is the only caller" architectural assumption with a cryptographic check, gives attributable identity for audit logs, bounds the compromise window of any derived key.
- **Flow** — diagram-in-words: FE derives key from root+epoch → signs payload → BE derives same key from epoch embedded in payload → verifies.
- **Token format** — `base64url(payload).base64url(hmac)`, payload fields.
- **Key derivation** — HKDF-SHA256, info string `bng-ctx-v1:<epoch>`, epoch = `floor(unixSeconds / rotationPeriodSeconds)`.
- **Rotation** — automatic per-epoch; root rotation procedure (deploy new `USER_CONTEXT_ROOT_SECRET` to both services in a synchronised release, accept brief verification failures in the overlap window, or ship a multi-root verifier in a later iteration).
- **Configuration** — table of the four config keys with their env vars, defaults, and what to override per environment.
- **Failure modes** — missing header (401), bad sig (401), expired (401), epoch drift beyond tolerance (401), userId mismatch in handler (403). What each looks like in logs.
- **What this does not protect against** — full FE compromise, replay within TTL window, root secret leak.
- **Bootstrapping local dev** — the human-readable default is intentionally identical between projects so `docker compose up` works with no setup; production MUST override.

**New file: `frontend/docs/user-context-auth.md`**

Same content, framed from the signing side:

- **Purpose** — identical.
- **When it's applied** — every call made via `backend-client.js`. Any direct `Wreck` call to the backend is a bug.
- **How userId is sourced** — from `request.auth.credentials` (session-cached identity), never from request input. This is the load-bearing invariant.
- **Flow, token format, derivation, rotation, configuration, failure modes, local dev** — same as BE doc.
- **Code guide** — where to put new backend calls; the `backendClient(request).xxx` pattern.

Link both docs from the respective `README.md` under a "Security" or "Architecture" heading (check existing README for the right spot).

---

## 6. Rollout

1. Land the plan in two PRs per project _or_ one coordinated PR pair:
   - **PR 1 (BE):** helpers + plugin registered but **not enforcing** — logs verification attempts, never rejects. Handler guards off behind a `userContext.enforce` config flag (default `false` in this PR).
   - **PR 2 (FE):** sign and send on every backend call.
   - Observe logs for a deploy cycle to confirm all BE routes are receiving valid tokens.
   - **PR 3 (BE):** flip `userContext.enforce` to `true` by default.
2. Root secret is generated per-environment via whatever secret-management flow is available (GitHub secret, CDP secret, tfvars — confirm during implementation). Local dev uses the baked-in default.

---

## 7. Open questions to resolve during implementation

- Where exactly does the FE store the session userId post-OIDC (`request.auth.credentials.profile.sub`? something else)? Determined by reading `src/server/auth/`.
- Which BE routes are intentionally unauthenticated and belong on the plugin allowlist? Likely `/health` and `/db-info`.
- Does `bng-metric-harness` already run cross-project tests, or do we add the harness test to BE instead?
- Is there a pre-existing outbound HTTP wrapper we missed? `grep -rn Wreck src/` on FE to confirm only the two known call sites.
