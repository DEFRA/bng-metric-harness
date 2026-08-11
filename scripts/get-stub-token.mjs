// Obtain a REAL Defra ID token from the local cdp-defra-id-stub, headlessly, so
// the perf suite can call the authenticated backend endpoints without a browser
// login and without the backend having to trust any special key.
//
// Registration uses the stub's JSON API (`POST <stub>/API/register`) — the same
// endpoint the frontend's scripts/seed-stub-users.mjs uses — rather than
// scraping the HTML registration wizard. The API accepts a user with NO
// relationships (the wizard does not: its Finish link only appears once a
// relationship is added, and it rejects enrolmentCount=0 outright), which is
// exactly what we want: a token with no org context, matching the legacy
// (relationship-less) project the perf runner seeds.
//
// Login is then one GET: the stub's login page links each user as
// `<authorizeUrl>&user=<email>`, which 302s straight back to the redirect_uri
// with the code. We exchange that for tokens at `<stub>/token` (PKCE).
//
// The user id is a deterministic UUIDv5 of the email (same technique as
// seed-stub-users.mjs), so re-runs replace the one perf user in place instead
// of accumulating throwaway registrations.
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { color, error } from "./_lib.mjs";

// Progress goes to stderr, never stdout: in CLI mode stdout carries ONLY the
// token (for piping), and _lib's info() would interleave log lines into it.
const note = (msg) => process.stderr.write(`${color("dim", msg)}\n`);

const STUB = process.env.STUB_BASE_URL ?? "http://localhost:3200/cdp-defra-id-stub";
const CLIENT_ID = process.env.OIDC_CLIENT_ID ?? "63983fc2-cfff-45bb-8ec2-959e21062b9a";
const CLIENT_SECRET = process.env.OIDC_CLIENT_SECRET ?? "test_value";
const REDIRECT_URI = process.env.OIDC_REDIRECT_URI ?? "http://localhost:3000/auth/callback";
const SCOPE = process.env.OIDC_SCOPES ?? "openid profile email offline_access";
const MAX_REDIRECTS = 10;

const PERF_USER_EMAIL = "bng-perf@bng.example.com";

// The stub validates enrolment counts as POSITIVE integers (>= 1), even for a
// user with no relationships — see seed-stub-users.mjs, which hit the same rule.
const MIN_ENROLMENT_COUNT = 1;

// Cap the response-body excerpt quoted in thrown error messages.
const ERROR_SNIPPET_MAX = 200;

const b64url = (buf) => Buffer.from(buf).toString("base64url");
const rand = () => b64url(randomBytes(32));

// ── deterministic UUID (same idea as frontend/scripts/seed-stub-users.mjs) ──
// Not RFC-4122 v5 — that mandates SHA-1, which SonarCloud rejects as a weak
// hash — but the same shape: SHA-256 truncated to 16 bytes with the version
// and variant bits set, so the same name always yields the same UUID-shaped id.
const UUID_NAMESPACE = "1b671a64-40d5-491e-99b0-da01ff1f3341";
const UUID_BYTE_LENGTH = 16;
const UUID_VERSION_INDEX = 6;
const UUID_VERSION_MASK = 0x0f;
const UUID_VERSION_BITS = 0x50;
const UUID_VARIANT_INDEX = 8;
const UUID_VARIANT_MASK = 0x3f;
const UUID_VARIANT_RFC = 0x80;
const UUID_HYPHEN_SHAPE = /^(.{8})(.{4})(.{4})(.{4})(.{12})$/;

function deterministicUuid(name) {
  const namespace = Buffer.from(UUID_NAMESPACE.replaceAll("-", ""), "hex");
  const digest = createHash("sha256").update(namespace).update(name).digest();
  const id = digest.subarray(0, UUID_BYTE_LENGTH);
  id[UUID_VERSION_INDEX] = (id[UUID_VERSION_INDEX] & UUID_VERSION_MASK) | UUID_VERSION_BITS;
  id[UUID_VARIANT_INDEX] = (id[UUID_VARIANT_INDEX] & UUID_VARIANT_MASK) | UUID_VARIANT_RFC;
  return id.toString("hex").replace(UUID_HYPHEN_SHAPE, "$1-$2-$3-$4-$5");
}

// The sub the stub will issue for the perf user.
const PERF_USER_SUB = deterministicUuid(PERF_USER_EMAIL);

// ── tiny cookie jar ────────────────────────────────────────────────────────
function makeJar() {
  const jar = new Map();
  return {
    absorb(response) {
      // getSetCookie() (undici) returns each Set-Cookie separately.
      const cookies = response.headers.getSetCookie?.() ?? [];
      for (const raw of cookies) {
        const [pair] = raw.split(";");
        const eq = pair.indexOf("=");
        if (eq > 0) {
          jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
        }
      }
    },
    header() {
      return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    },
  };
}

async function get(url, jar) {
  const res = await fetch(url, {
    method: "GET",
    redirect: "manual",
    headers: { cookie: jar.header() },
  });
  jar.absorb(res);
  return res;
}

function abs(location, base) {
  return new URL(location, base).href;
}

function buildAuthorizeUrl(challenge, state, nonce, email) {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    nonce,
    // Selects the user directly — the stub's login page links each registered
    // user as this same authorize URL plus `user=<email>`.
    user: email,
  });
  return `${STUB}/authorize?${q.toString()}`;
}

// 1. Register (or replace) the perf user via the stub's JSON API. No
// relationships -> the token carries no org context, so the backend's
// visibility check matches the seeded legacy (relationship-less) project.
async function registerPerfUser() {
  const userId = PERF_USER_SUB;
  note(`▸ stub-token: registering perf user ${userId} via ${STUB}/API/register`);
  const res = await fetch(`${STUB}/API/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      userId,
      email: PERF_USER_EMAIL,
      firstName: "BNG",
      lastName: "Perf",
      loa: "1",
      aal: "1",
      enrolmentCount: MIN_ENROLMENT_COUNT,
      enrolmentRequestCount: MIN_ENROLMENT_COUNT,
      relationships: [],
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `API/register returned HTTP ${res.status}: ${detail.slice(0, ERROR_SNIPPET_MAX)} — is the cdp-defra-id-stub up?`,
    );
  }
  return userId;
}

// 2. Follow authorize -> callback (carrying cookies) until one hop lands back
// on our redirect_uri carrying the authorization code.
async function followToCode(startUrl, jar, expectedState) {
  let url = startUrl;
  for (let hop = 0; hop < MAX_REDIRECTS; hop += 1) {
    const res = await get(url, jar);
    const location = res.headers.get("location");
    if (!location) {
      throw new Error(
        `Expected a redirect toward ${REDIRECT_URI} but got HTTP ${res.status} with no Location (hop ${hop}).`,
      );
    }
    const next = abs(location, url);
    if (next.startsWith(REDIRECT_URI)) {
      const params = new URL(next).searchParams;
      const code = params.get("code");
      if (!code) {
        throw new Error(`Callback redirect had no code: ${next}`);
      }
      if (expectedState && params.get("state") !== expectedState) {
        throw new Error("State mismatch on the authorization callback.");
      }
      return code;
    }
    url = next;
  }
  throw new Error(`Did not reach ${REDIRECT_URI} within ${MAX_REDIRECTS} redirects.`);
}

async function exchangeCode(code, verifier) {
  const res = await fetch(`${STUB}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }).toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `Token endpoint returned HTTP ${res.status}: ${text.slice(0, ERROR_SNIPPET_MAX)}`,
    );
  }
  return JSON.parse(text);
}

function decodeSub(idToken) {
  const payload = idToken.split(".")[1];
  const json = Buffer.from(payload, "base64url").toString("utf8");
  return JSON.parse(json).sub;
}

/**
 * Register (or reuse) the deterministic perf user against the stub and complete
 * the OIDC flow.
 * @returns {Promise<{ idToken: string, sub: string }>}
 */
export async function getStubToken() {
  const jar = makeJar();
  const verifier = rand();
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = rand();
  const nonce = rand();

  await registerPerfUser();

  note("▸ stub-token: logging in and exchanging the code");
  const authorizeUrl = buildAuthorizeUrl(challenge, state, nonce, PERF_USER_EMAIL);
  const code = await followToCode(authorizeUrl, jar, state);
  const tokens = await exchangeCode(code, verifier);
  const idToken = tokens.id_token ?? tokens.access_token;
  if (!idToken) {
    throw new Error(
      `Token response had no id_token: ${JSON.stringify(tokens).slice(0, ERROR_SNIPPET_MAX)}`,
    );
  }
  return { idToken, sub: decodeSub(idToken) };
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  try {
    const { idToken, sub } = await getStubToken();
    // Token to stdout (for piping); sub to stderr so it doesn't pollute stdout.
    process.stderr.write(`sub=${sub}\n`);
    process.stdout.write(idToken);
  } catch (err) {
    error(`stub-token: ${err.message}`);
    process.exit(1);
  }
}
