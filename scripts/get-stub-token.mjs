// Obtain a REAL Defra ID token from the local cdp-defra-id-stub, headlessly, so
// the perf suite can call the authenticated backend endpoints without a browser
// login and without the backend having to trust any special key. This replays
// the same flow the journey-tests drive via Playwright — register -> finish ->
// login -> code -> token — but over plain HTTP.
//
// The token is a genuine stub-issued id_token, so the normal `tilt up` backend
// accepts it as-is: no perf mode, no OIDC_LOCAL_JWKS, no backend change.
//
// We register a fresh user each run (the stub pre-generates its `userId`, which
// becomes the token `sub`); the caller seeds a project for that sub. We add no
// relationships (enrolmentCount=0), so the token carries no org context and the
// backend's visibility check matches a legacy (relationship-less) project — the
// simplest thing to seed.
//
// NOTE: coupled to the stub's shape (same coupling the journey-tests already
// carry). Each step logs what it did so a mismatch is easy to pinpoint.
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { error, info } from "./_lib.mjs";

const STUB = process.env.STUB_BASE_URL ?? "http://localhost:3200/cdp-defra-id-stub";
const CLIENT_ID = process.env.OIDC_CLIENT_ID ?? "63983fc2-cfff-45bb-8ec2-959e21062b9a";
const CLIENT_SECRET = process.env.OIDC_CLIENT_SECRET ?? "test_value";
const REDIRECT_URI = process.env.OIDC_REDIRECT_URI ?? "http://localhost:3000/auth/callback";
const SCOPE = process.env.OIDC_SCOPES ?? "openid profile email offline_access";
const MAX_REDIRECTS = 10;

const b64url = (buf) => Buffer.from(buf).toString("base64url");
const rand = () => b64url(randomBytes(32));

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

async function postForm(url, jar, fields) {
  const res = await fetch(url, {
    method: "POST",
    redirect: "manual",
    headers: {
      cookie: jar.header(),
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(fields).toString(),
  });
  jar.absorb(res);
  return res;
}

// ── HTML scraping helpers (best-effort, both attribute orders) ───────────────
function inputValue(html, name) {
  const a = html.match(new RegExp(`name="${name}"[^>]*value="([^"]*)"`, "i"));
  if (a) {
    return a[1];
  }
  const b = html.match(new RegExp(`value="([^"]*)"[^>]*name="${name}"`, "i"));
  return b ? b[1] : null;
}

function linkHref(html, text) {
  const m = html.match(
    new RegExp(`<a\\b[^>]*href="([^"]*)"[^>]*>[^<]*${text}[^<]*</a>`, "i"),
  );
  return m ? m[1] : null;
}

function abs(location, base) {
  return new URL(location, base).href;
}

function buildAuthorizeUrl(challenge, state, nonce) {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    nonce,
  });
  return `${STUB}/authorize?${q.toString()}`;
}

// Follow redirects (carrying cookies) until one lands back on our redirect_uri
// carrying the authorization code.
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
    throw new Error(`Token endpoint returned HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return JSON.parse(text);
}

function decodeSub(idToken) {
  const payload = idToken.split(".")[1];
  const json = Buffer.from(payload, "base64url").toString("utf8");
  return JSON.parse(json).sub;
}

/**
 * Register a throwaway user against the stub and complete the OIDC flow.
 * @returns {Promise<{ idToken: string, sub: string }>}
 */
export async function getStubToken() {
  const jar = makeJar();
  const verifier = rand();
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = rand();
  const nonce = rand();
  const authorizeUrl = buildAuthorizeUrl(challenge, state, nonce);

  // 1. Load the register page (seeds cookie + csrfToken + the pre-generated ids).
  info("▸ stub-token: loading register form");
  const regPage = await get(
    `${STUB}/register?redirect_uri=${encodeURIComponent(authorizeUrl)}`,
    jar,
  );
  const html = await regPage.text();
  const csrfToken = inputValue(html, "csrfToken");
  const userId = inputValue(html, "userId");
  const contactId = inputValue(html, "contactId");
  const uniqueReference = inputValue(html, "uniqueReference");
  if (!csrfToken || !userId) {
    throw new Error(
      "Could not scrape csrfToken/userId from the register form — the stub's form shape may have changed.",
    );
  }

  // 2. Submit the registration (no enrolments -> no org context in the token).
  info(`▸ stub-token: registering user ${userId}`);
  const reg = await postForm(`${STUB}/register`, jar, {
    csrfToken,
    redirect_uri: authorizeUrl,
    userId,
    contactId: contactId ?? "",
    email: `bng-perf-${Date.now()}@example.com`,
    firstName: "BNG",
    lastName: "Perf",
    uniqueReference: uniqueReference ?? "",
    loa: "1",
    aal: "1",
    enrolmentCount: "0",
    enrolmentRequestCount: "0",
  });
  if (reg.status >= 400) {
    throw new Error(`Register POST failed: HTTP ${reg.status}`);
  }

  // 3. Walk register -> Finish -> Login by following the on-page links.
  let pageUrl = abs(reg.headers.get("location") ?? `${STUB}/relationship`, `${STUB}/register`);
  let loginHref = null;
  for (let step = 0; step < MAX_REDIRECTS && !loginHref; step += 1) {
    const page = await get(pageUrl, jar);
    const body = await page.text();
    loginHref =
      linkHref(body, "Login") ?? linkHref(body, "Sign in") ?? linkHref(body, "Continue");
    if (loginHref) {
      break;
    }
    const finishHref = linkHref(body, "Finish") ?? linkHref(body, "Continue");
    if (!finishHref) {
      throw new Error(
        `No Finish/Login link on ${pageUrl} — the stub's post-register pages may differ.`,
      );
    }
    pageUrl = abs(finishHref, pageUrl);
  }
  if (!loginHref) {
    throw new Error("Never found the Login link in the stub flow.");
  }

  // 4. Follow Login -> authorize -> callback, capture the code, exchange it.
  info("▸ stub-token: completing login and exchanging the code");
  const code = await followToCode(abs(loginHref, pageUrl), jar, state);
  const tokens = await exchangeCode(code, verifier);
  const idToken = tokens.id_token ?? tokens.access_token;
  if (!idToken) {
    throw new Error(`Token response had no id_token: ${JSON.stringify(tokens).slice(0, 200)}`);
  }
  return { idToken, sub: decodeSub(idToken) };
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  getStubToken()
    .then(({ idToken, sub }) => {
      // Token to stdout (for piping); sub to stderr so it doesn't pollute stdout.
      process.stderr.write(`sub=${sub}\n`);
      process.stdout.write(idToken);
    })
    .catch((err) => {
      error(`stub-token: ${err.message}`);
      process.exit(1);
    });
}
