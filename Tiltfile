# Backend docker compose stack (localstack, redis, postgres, caddy, cdp-uploader)
docker_compose('../bng-metric-backend/compose.yml')

# All resources route through scripts/run-with-nodejs.mjs so each sibling's
# .nvmrc Node version is selected via nvm — same code path on macOS/Linux
# (nvm) and Windows (nvm-windows). No inline shell in the Tiltfile.

# Perf mode — opt in with `BNG_PERF_AUTH=1 tilt up`. The perf suite hits the
# backend directly, but JMeter can't perform the interactive Defra ID login the
# stub normally requires. In perf mode we start the backend with a generated
# local dev JWKS (scripts/perf-auth.mjs) so the perf trigger can mint tokens the
# backend accepts. This BYPASSES the stub, so interactive login won't work while
# perf mode is on — leave it off for normal frontend/journey work.
perf_mode = os.getenv('BNG_PERF_AUTH', '') not in ('', '0', 'false')
backend_env_args = ''
if perf_mode:
    # Generate the keypair (idempotent) before the backend starts, so the JWKS it
    # loads matches the tokens the trigger will mint.
    local('node ./scripts/perf-auth.mjs ensure', quiet=True)
    backend_env_args = ' --env-file ./.perf/backend.env'
    warn('PERF MODE: backend trusts a local dev key (OIDC_LOCAL_JWKS); stub login is bypassed.')

# Frontend Node app (port 3000)
local_resource(
    'frontend',
    serve_cmd='node ./scripts/run-with-nodejs.mjs bng-metric-frontend --env CDP_UPLOADER_URL=http://localhost:7337 run dev',
    deps=['../bng-metric-frontend/src'],
    resource_deps=['localstack', 'redis'],
    links=['http://localhost:3000'],
    labels=['apps'],
)

# Database migrations (Liquibase)
local_resource(
    'db-migrate',
    cmd='node ./scripts/run-with-nodejs.mjs bng-metric-backend run db:update',
    resource_deps=['postgres'],
    labels=['infra'],
)

# Backend Node app (port 3001). In perf mode the serve command gains
# `--env-file ./.perf/backend.env`, injecting OIDC_LOCAL_JWKS + OIDC_ISSUER.
local_resource(
    'backend',
    serve_cmd='node ./scripts/run-with-nodejs.mjs bng-metric-backend' + backend_env_args + ' run dev',
    deps=['../bng-metric-backend/src'],
    resource_deps=['localstack', 'redis', 'postgres', 'db-migrate'],
    links=['http://localhost:3001'],
    labels=['apps'],
)

# Journey tests — manual one-shot trigger. Runs the full Playwright suite
# against the locally-running frontend/backend. Click the button in the
# Tilt UI to start a run.
local_resource(
    'journey-tests',
    cmd='node ./scripts/run-with-nodejs.mjs bng-metric-journey-tests run test:local',
    auto_init=False,
    trigger_mode=TRIGGER_MODE_MANUAL,
    resource_deps=['frontend', 'backend'],
    labels=['tests'],
)

# Perf tests — manual one-shot trigger. Mints a dev token, seeds a big-baseline
# project, and runs the JMeter BMD-933 suite against the local backend. Requires
# perf mode: start the stack with `BNG_PERF_AUTH=1 tilt up`, then click the
# button. Pre-fix the assertions fail by design (they encode the acceptance
# criteria); the run reports them but stays green unless PERF_FAIL_ON_ASSERT=1.
local_resource(
    'perf-tests',
    cmd='node ./scripts/run-perf-tests.mjs',
    auto_init=False,
    trigger_mode=TRIGGER_MODE_MANUAL,
    resource_deps=['backend'],
    labels=['tests'],
)
