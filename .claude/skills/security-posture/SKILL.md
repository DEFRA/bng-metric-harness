---
description: Sweep the frontend, backend, and harness repos for every security control, hardening measure, and defensive practice — then either produce a security-posture inventory (title / description / status) or verify an existing inventory still holds (drift detection). Use to brief a security team or to re-check coverage over time.
userInvocable: true
arguments: [gather|verify] [path-to-existing-inventory]   — mode optional (defaults to gather); inventory path only needed for verify
---

# Security posture sweep & verification

This skill inventories the security features across the three sibling repos and lets you re-check them later. It runs in one of two modes:

- **gather** (default) — sweep the repos and produce a fresh security-posture inventory as a markdown table.
- **verify** — take an existing inventory and confirm each row still holds in the current code (drift detection): what's still there, what regressed or disappeared, what's newly added, what's still outstanding.

The repos to sweep (resolve by name, reachable from the harness via symlinks `./frontend`, `./backend`, plus the harness itself):

- `bng-metric-frontend` — Hapi + Nunjucks + GOV.UK, port 3000
- `bng-metric-backend` — Hapi API, port 3001 (Postgres, Redis, LocalStack, CDP Defra ID stub)
- `bng-metric-harness` — orchestration / CI / supply-chain config

## Step 0 — Resolve mode and confirm the output target

- First argument: `gather` or `verify`. If absent, default to **gather**.
- For **verify**, the second argument is the path to the existing inventory markdown. If it's missing, ask the user where the inventory lives (it is intentionally *not* pinned to a fixed location — see below). Read it before sweeping so you know what to check against.

**Do not hardcode or assume an output directory for the generated markdown.** When you have an inventory to write (gather mode, or a verify-mode delta report), ask the user where to write it — offer a sensible suggestion (e.g. the workspace root above the repos, or alongside the existing inventory in verify mode) but let them decide. Never silently pick a path.

## Step 1 — Fan out the sweep across the three repos

Spawn three `Explore` agents **in parallel** (one message, three tool calls), one per repo. Each agent returns a categorised list of security-relevant findings with concrete `file:line` citations — not generic best-practice prose. Give each agent the category checklist below and tell it to:

- cite real file paths and config values, never describe controls in the abstract;
- separate **implemented** from **planned/spec'd/partial**;
- report gaps and absences too (a missing control is a finding);
- read `package.json` deps, `.npmrc`, `.nvmrc`, server/plugin setup, route definitions (auth + validate options), config schema (`convict`), `.github/workflows/`, Dockerfiles, eslint config, `.gitleaks.toml`, husky hooks, `sonar-project.properties`, and any `docs/` / ADRs.

**Category checklist (each agent covers all that apply to its repo):**

1. **Auth & authorisation** — OIDC/Defra ID flow, PKCE, state/nonce, session scheme, role checks (RBAC), token validation/signature/audience/issuer, redirect allow-lists, route `auth` options, JWT user-action tokens (FE↔BE shared secret).
2. **CSRF & session/cookie** — `@hapi/crumb`, cookie flags (Secure/HttpOnly/SameSite), `@hapi/yar` server-side store, cookie encryption, session TTL.
3. **HTTP security headers** — `routes.security` (hsts/xss/noSniff/xframe), Blankie/CSP (nonces vs hashes), frame-ancestors, Referrer-Policy, Permissions-Policy.
4. **Input validation & file upload** — Joi on params/query/payload, `failAction`, allow-lists, filename validation (traversal/spoof/bidi/control chars), magic-byte/file-signature checks, SRID/format allow-lists, size/timeout limits, virus scanning (CDP uploader / ClamAV).
5. **Database** — parameterized queries / ORM (Drizzle/knex/pg), persistence choke-points + lint rules enforcing them, IAM DB auth, TLS to DB, pool hardening, error-code mapping (no raw DB errors to clients).
6. **Output encoding / XSS** — Nunjucks autoescaping, `| safe` audit, CSP nonces in templates.
7. **Secrets & config** — `convict` schema validation (`allowed: 'strict'`), `sensitive` fields, env-scoped log redaction (pino), `.gitignore` for keys, gitleaks/trufflehog, `.npmrc` min-age + save-exact.
8. **Logging, audit & observability** — ECS/pino structured logs, correlation IDs (`x-cdp-request-id`), audit tables, health-endpoint info-hiding, security metrics, Grafana dashboards/alerts.
9. **Error handling** — Boom errors, generic client messages, server-only stack traces, custom error pages.
10. **Dependency & supply chain** — min-package-age, save-exact, `npm ci`, `npm audit` in CI/hooks, Node pinning, Dependabot/renovate (active vs example), dependency-review, SBOM, license scanning, npm provenance.
11. **CI/CD & container** — action SHA/version pinning, OIDC to cloud (no long-lived creds), least-privilege `permissions:`, multi-stage/non-root/pinned-base Dockerfiles, postinstall stripped in prod, Docker-build-as-CI-gate, integration tests vs real services, SonarCloud SAST, CodeQL, Trivy, branch protection, CODEOWNERS.
12. **Transport & network** — HTTPS enforcement, secure context / mTLS / custom CA, egress proxy, CORS, rate limiting / throttling.
13. **Documentation & governance** — architecture docs (cookiecutter), auth/CSRF docs, data-dictionary-as-contract + drift gate, Liquibase migration checksums, SECURITY.md, threat model (note: a high-level threat model is maintained **outside the repos** — treat its existence as known, don't flag it as missing just because it's absent from the tree), Claude review skills.

The agents read excerpts, not whole files — they locate and summarise controls; they don't audit code correctness.

## Step 2 — Consolidate findings

Merge the three agents' output. De-duplicate controls that span repos (e.g. secret scanning, action pinning) into one row, noting which repos have them. Assign each a status from this taxonomy:

- ✅ **Implemented**
- 🟡 **Partial / example-only** (e.g. Dependabot present as `example.dependabot.yml`, default payload limits)
- 📋 **Planned / spec'd** (designed but not built — e.g. the JWT user-action tokens)
- ❌ **Not implemented (remediation needed)**

## Step 3a — gather mode: write the inventory

Produce a markdown document grouped by the categories in Step 1, each section a table with columns **Title | Description | Status**. Lead with a short status key and a compiled date. Keep descriptions concrete and one line; cite the mechanism, not the abstraction.

Write it to the path the user chose in Step 0 (never a hardcoded directory). After writing, give the user a one-line tally (e.g. "47 implemented / 6 partial-or-planned / 11 remediation needed") and offer to split the remediation rows into a prioritised backlog.

## Step 3b — verify mode: diff against the existing inventory

For each row in the supplied inventory, decide from the fresh sweep:

- **Still holds** — control found, status unchanged.
- **Regressed** — was ✅, now missing or weakened (e.g. a header removed, a hook deleted, a validation dropped). Flag prominently with the evidence (`file:line` that changed or the absence).
- **Advanced** — was ❌/🟡/📋, now ✅ (remediation landed). Celebrate it and suggest updating the inventory.
- **Still outstanding** — was ❌/🟡/📋 and still is.
- **New (undocumented)** — a control or gap found in the sweep that isn't in the inventory yet.

Present this as a delta report (markdown table or grouped list). The headline is **regressions** and **newly-undocumented gaps** — those are what a security team acts on. Offer to update the inventory file in place to reflect the current state, writing only where the user directs.

## Common gotchas

- **Symlinks vs canonical paths**: `./frontend` and `./backend` resolve to the siblings, but agents should cite the real repo-relative paths so findings are unambiguous.
- **Absence is a finding**: "no rate limiting on backend routes" is as reportable as a control that exists. Don't pad, but don't omit gaps — a security team trusts a list more when it names its holes.
- **High-level threat model lives outside the repos**: don't list it as a missing artifact just because there's no doc in the tree; its in-repo footprint is the `securityFlow.png` diagram.
- **Don't re-run a control's code to "test" it** — this is an inventory/coverage sweep, not a penetration test. Verify presence and configuration, not exploitability.
- **Output location is the user's call**: every write in this skill goes where the user says. The default suggestion may be the workspace root, but confirm — do not assume.
