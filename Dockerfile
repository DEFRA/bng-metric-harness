FROM node:24.14.1-slim
WORKDIR /app
# git + CA certs are needed for the `github:` bng-library dependency that `npm ci` fetches.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY scripts ./scripts
USER node
ENTRYPOINT ["node", "scripts/gen-gpkg.mjs"]
