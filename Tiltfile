# Backend docker compose stack (localstack, redis, postgres, caddy, cdp-uploader)
docker_compose('../bng-metric-backend/compose.yml')

# Source nvm so serve_cmd picks up the right Node version from .nvmrc
nvm_prefix = '. "$NVM_DIR/nvm.sh" && nvm use --silent &&'

# Frontend Node app (port 3000)
local_resource(
    'frontend',
    serve_cmd=nvm_prefix + ' CDP_UPLOADER_URL=http://localhost:7337 npm run dev',
    serve_dir='../bng-metric-frontend',
    deps=['../bng-metric-frontend/src'],
    resource_deps=['localstack', 'redis'],
    links=['http://localhost:3000'],
    labels=['apps'],
)

# Database migrations (Liquibase)
local_resource(
    'db-migrate',
    cmd=nvm_prefix + ' npm run db:update',
    dir='../bng-metric-backend',
    resource_deps=['postgres'],
    labels=['infra'],
)

# Backend Node app (port 3001)
local_resource(
    'backend',
    serve_cmd=nvm_prefix + ' npm run dev',
    serve_dir='../bng-metric-backend',
    deps=['../bng-metric-backend/src'],
    resource_deps=['localstack', 'redis', 'postgres', 'db-migrate'],
    links=['http://localhost:3001'],
    labels=['apps'],
)

# Journey tests — manual one-shot trigger. Runs the full Playwright suite
# against the locally-running frontend/backend. Click the button in the
# Tilt UI to start a run.
#
# Pre-flight checks that the Node version pinned in journey-tests/.nvmrc is
# actually installed in nvm; otherwise nvm fails silently (exit 3) and the
# Tilt log shows nothing useful.
journey_tests_cmd = '''
. "$NVM_DIR/nvm.sh"
REQUIRED=$(tr -d '[:space:]' < .nvmrc)
if ! nvm which "$REQUIRED" >/dev/null 2>&1; then
  echo ""
  echo "Node $REQUIRED (from bng-metric-journey-tests/.nvmrc) is not installed in nvm."
  echo "Install it with:"
  echo "  (cd ../bng-metric-journey-tests && nvm install)"
  echo ""
  exit 1
fi
nvm use --silent
exec npm run test:local
'''

local_resource(
    'journey-tests',
    cmd=journey_tests_cmd,
    dir='../bng-metric-journey-tests',
    auto_init=False,
    trigger_mode=TRIGGER_MODE_MANUAL,
    resource_deps=['frontend', 'backend'],
    labels=['tests'],
)