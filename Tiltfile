# Backend docker compose stack (localstack, redis, postgres, caddy, cdp-uploader)
docker_compose('../bng-metric-backend/compose.yml')

# All resources route through scripts/run-with-nodejs.mjs so each sibling's
# .nvmrc Node version is selected via nvm — same code path on macOS/Linux
# (nvm) and Windows (nvm-windows). No inline shell in the Tiltfile.

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

# Backend Node app (port 3001)
local_resource(
    'backend',
    serve_cmd='node ./scripts/run-with-nodejs.mjs bng-metric-backend run dev',
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
