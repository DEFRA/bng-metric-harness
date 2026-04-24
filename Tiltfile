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