FROM node:24.14.1-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY scripts ./scripts
USER node
ENTRYPOINT ["node", "scripts/gen-gpkg.mjs"]
