// Local-only auth material for the perf-test Tilt trigger.
//
// The backend verifies every request's Bearer token against a key set. In a
// normal `tilt up` that key set is the cdp-defra-id-stub's, reached through an
// interactive browser login — which a headless JMeter run cannot perform. In
// perf mode (BNG_PERF_AUTH=1) the Tiltfile instead starts the backend with
// OIDC_LOCAL_JWKS pointing at the key this script generates, so we can mint our
// own tokens the backend will accept. Everything here is DEV-ONLY and lives in
// the gitignored .perf/ dir; it never ships and must never point at a real env.
//
// Zero dependencies — node:crypto generates the RSA key, exports the public half
// as a JWK, and signs an RS256 JWT by hand (header.payload.signature, base64url).
//
// Commands:
//   ensure   generate the keypair + write jwks.json / backend.env if missing
//            (idempotent — the backend loads this ONCE at start, so regenerating
//            after it is running would invalidate every token; only creates)
//   mint     print a signed Bearer token to stdout (keys must already exist)
//   print-jwks   print the public JWKS to stdout
import {
  createPrivateKey,
  createSign,
  generateKeyPairSync,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { error, HARNESS_ROOT, info } from "./_lib.mjs";

const KID = "bng-perf-local";
const ISSUER = "https://perf.bng.local";
export const PERF_SUB = "bng-perf-local";
const TOKEN_TTL_SECONDS = 12 * 60 * 60;
const RSA_MODULUS_BITS = 2048;

const PERF_DIR = path.join(HARNESS_ROOT, ".perf");
const PEM_PATH = path.join(PERF_DIR, "private-key.pem");
const JWKS_PATH = path.join(PERF_DIR, "jwks.json");
const ENV_PATH = path.join(PERF_DIR, "backend.env");

const b64url = (input) => Buffer.from(input).toString("base64url");

function ensure() {
  if (existsSync(PEM_PATH) && existsSync(JWKS_PATH) && existsSync(ENV_PATH)) {
    info(`▸ perf-auth: reusing existing dev key in ${PERF_DIR}`);
    return;
  }
  mkdirSync(PERF_DIR, { recursive: true });

  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: RSA_MODULUS_BITS,
  });
  const jwk = publicKey.export({ format: "jwk" });
  jwk.kid = KID;
  jwk.alg = "RS256";
  jwk.use = "sig";
  const jwks = { keys: [jwk] };

  writeFileSync(PEM_PATH, privateKey.export({ type: "pkcs8", format: "pem" }));
  writeFileSync(JWKS_PATH, JSON.stringify(jwks));
  // The backend reads OIDC_LOCAL_JWKS as the raw JWKS string (auth-jwt.js
  // JSON.parses it) and enforces OIDC_ISSUER when set — mint() stamps the same
  // issuer, so the two always agree. No audience: the stub sets none either, so
  // the backend leaves audience unenforced.
  writeFileSync(
    ENV_PATH,
    `OIDC_LOCAL_JWKS=${JSON.stringify(jwks)}\nOIDC_ISSUER=${ISSUER}\n`,
  );
  info(`▸ perf-auth: generated dev key (kid=${KID}) in ${PERF_DIR}`);
}

function mint(sub = PERF_SUB) {
  if (!existsSync(PEM_PATH)) {
    error(
      "perf-auth: no dev key found — start Tilt with BNG_PERF_AUTH=1 (or run `node scripts/perf-auth.mjs ensure`) first.",
    );
    process.exit(1);
  }
  const key = createPrivateKey(readFileSync(PEM_PATH));
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: KID }));
  const payload = b64url(
    JSON.stringify({
      sub,
      iss: ISSUER,
      iat: now,
      exp: now + TOKEN_TTL_SECONDS,
    }),
  );
  const signingInput = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256")
    .update(signingInput)
    .end()
    .sign(key);
  return `${signingInput}.${b64url(signature)}`;
}

// Only dispatch the CLI when run directly — importing this module (e.g. from
// run-perf-tests.mjs to reuse mint/PERF_SUB) must not trigger a command.
const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const command = process.argv[2];
  switch (command) {
    case "ensure":
      ensure();
      break;
    case "mint":
      process.stdout.write(mint(process.argv[3]));
      break;
    case "print-jwks":
      ensure();
      process.stdout.write(readFileSync(JWKS_PATH, "utf8"));
      break;
    default:
      error(`Usage: perf-auth.mjs <ensure|mint [sub]|print-jwks>`);
      process.exit(1);
  }
}

export { ensure, mint, ENV_PATH, ISSUER, JWKS_PATH, KID, PEM_PATH, PERF_DIR };
