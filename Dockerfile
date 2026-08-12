FROM node:24.14.1-slim
WORKDIR /app
# git + CA certs are needed for the `github:` bng-library dependency that `npm ci` fetches.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json .npmrc ./
# --ignore-scripts blocks preinstall/install/postinstall/prepare for this package and
# every dependency (belt-and-braces with .npmrc's ignore-scripts=true) — the mechanism
# behind npm supply-chain worms (e.g. Shai-Hulud) that execute code at install time.
RUN npm ci --ignore-scripts
COPY scripts ./scripts
USER node
ENTRYPOINT ["node", "scripts/gen-gpkg.mjs"]
