# HYDRA-UMC-SERVER - scripts/Dockerfile
# Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
# GPL-3.0 - see LICENSE
#
# The image of the server for the container bench of HYDRA-UMC-DEV-SERVER (and for anybody who wants the server in a container). It is NOT how the server is installed on
# the CM5 (systemd, see systemd/): nothing here changes that. Build it from the root of the repository: docker build -f scripts/Dockerfile .
#
# - Two stages: the build (all the dependencies, the bundle of esbuild) and the run (production dependencies and the bundle only).
# - It runs as the user node, never as root; its data folder /app/data is the only place it writes.
# - No secret is in the image: the signing key of the tokens (JWT_SECRET) and the first administrator (HYDRA_UMC_BOOTSTRAP_ADMIN_USERNAME and
#   HYDRA_UMC_BOOTSTRAP_ADMIN_PASSWORD) are given when the container starts, and nothing of the local data folder is copied in (see .dockerignore).
# - The health check reads GET /api/hydra-info, which answers without a token.

FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:20-bookworm-slim
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node scripts ./scripts
RUN mkdir -p /app/data && chown node:node /app/data
USER node
VOLUME ["/app/data"]
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/hydra-info').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "dist/server.cjs"]
