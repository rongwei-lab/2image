# syntax=docker/dockerfile:1.7
FROM node:22-alpine

WORKDIR /app

ARG NPM_REGISTRY=https://registry.npmmirror.com

COPY server/package.json server/package-lock.json ./
RUN --mount=type=bind,source=.docker-npm-cache/server,target=/opt/npm-cache,readonly \
    --mount=type=cache,target=/root/.npm,sharing=locked \
    cp -a /opt/npm-cache/. /root/.npm/ 2>/dev/null || true; \
    npm config set registry "$NPM_REGISTRY"; \
    npm config set replace-registry-host always; \
    npm config set maxsockets 3; \
    npm config set fetch-timeout 300000; \
    npm ci --omit=dev --offline --no-audit --no-fund --progress=false

COPY server-dist ./server-dist

EXPOSE 8788

CMD ["npm", "run", "server:start"]
