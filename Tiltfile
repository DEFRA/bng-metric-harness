# Backend docker compose stack (localstack, redis, postgres, caddy, cdp-uploader)
docker_compose('../bng-metric-backend/compose.yml')

# Bootstrap LocalStack buckets/queues on every Tilt start (idempotent).
local_resource(
    'localstack-bootstrap',
    cmd='docker compose run --rm localstack-init',
    dir='../bng-metric-backend',
    resource_deps=['localstack'],
    labels=['infra'],
)

dc_resource('cdp-uploader', resource_deps=['localstack-bootstrap'])

# Use the pinned Node runtime directly to avoid shell/nvm drift inside containers.
node24_prefix = 'PATH="/usr/local/share/nvm/versions/node/v24.14.1/bin:$PATH"'

# Frontend Node app (port 3000)
local_resource(
    'frontend',
    serve_cmd=node24_prefix + ' CDP_UPLOADER_URL=http://localhost:7337 npm run dev',
    serve_dir='../bng-metric-frontend',
    deps=['../bng-metric-frontend/src'],
    resource_deps=['localstack', 'redis'],
    links=['http://localhost:3000'],
    labels=['apps'],
)

# Database migrations (Liquibase)
local_resource(
    'db-migrate',
    cmd=node24_prefix + ' npm run db:update',
    dir='../bng-metric-backend',
    resource_deps=['postgres'],
    labels=['infra'],
)

# Backend Node app (port 3001)
local_resource(
    'backend',
    # In devcontainer mode, backend talks to host-published compose ports.
    serve_cmd=node24_prefix + ' DB_HOST=172.17.0.1 S3_ENDPOINT=http://172.17.0.1:4566 npm run dev',
    serve_dir='../bng-metric-backend',
    deps=['../bng-metric-backend/src'],
    resource_deps=['localstack', 'redis', 'postgres', 'db-migrate'],
    links=['http://localhost:3001'],
    labels=['apps'],
)