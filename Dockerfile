FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY scripts ./scripts
ENTRYPOINT ["node", "scripts/gen-gpkg.mjs"]
