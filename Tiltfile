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

def _truthy_env(name):
    value = os.getenv(name, '')
    if value == None or value == '':
        return False
    return value.lower() in ('1', 'true', 'yes', 'on')

def in_devcontainer():
    """True in VS Code Dev Containers / GitHub Codespaces (see .devcontainer/)."""
    for name in (
        'BNG_METRIC_DEVCONTAINER',
        'REMOTE_CONTAINERS',
        'REMOTE_CONTAINERS_SESSION',
        'CODESPACES',
    ):
        if _truthy_env(name):
            return True
    return False

# Devcontainer-only: pin Node 24 and reach Docker services via the host gateway IP.
# Outside devcontainer, use whatever Node is on PATH (run `nvm use` per .nvmrc first).
if in_devcontainer():
    node_cmd_prefix = 'PATH="/usr/local/share/nvm/versions/node/v24.14.1/bin:$PATH" '
    backend_host_env = 'DB_HOST=172.17.0.1 S3_ENDPOINT=http://172.17.0.1:4566 '
else:
    node_cmd_prefix = ''
    backend_host_env = ''

# Frontend Node app (port 3000)
local_resource(
    'frontend',
    serve_cmd=node_cmd_prefix + 'CDP_UPLOADER_URL=http://localhost:7337 npm run dev',
    serve_dir='../bng-metric-frontend',
    deps=['../bng-metric-frontend/src'],
    resource_deps=['localstack', 'redis'],
    links=['http://localhost:3000'],
    labels=['apps'],
)

# Database migrations (Liquibase)
local_resource(
    'db-migrate',
    cmd=node_cmd_prefix + 'npm run db:update',
    dir='../bng-metric-backend',
    resource_deps=['postgres'],
    labels=['infra'],
)

# Backend Node app (port 3001)
local_resource(
    'backend',
    serve_cmd=node_cmd_prefix + backend_host_env + 'npm run dev',
    serve_dir='../bng-metric-backend',
    deps=['../bng-metric-backend/src'],
    resource_deps=['localstack', 'redis', 'postgres', 'db-migrate'],
    links=['http://localhost:3001'],
    labels=['apps'],
)
