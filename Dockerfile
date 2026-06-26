FROM node:26.4.0-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY scripts ./scripts
COPY packages ./packages
USER node
ENTRYPOINT ["node", "scripts/gen-gpkg.mjs"]
