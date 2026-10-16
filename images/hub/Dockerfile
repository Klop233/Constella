# constella-hub: management service + PWA. Build from the repo root:
#   docker compose -f deploy/docker-compose.yml build hub
FROM node:22-bookworm-slim AS build
ARG NPM_REGISTRY=https://registry.npmmirror.com
RUN npm i -g pnpm@12.11.2 --registry="$NPM_REGISTRY" && pnpm config set registry "$NPM_REGISTRY"
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/
COPY apps/hub/package.json apps/hub/
COPY apps/web/package.json apps/web/
COPY apps/runner/package.json apps/runner/
RUN pnpm install --frozen-lockfile
COPY packages packages
COPY apps/hub apps/hub
COPY apps/web apps/web
RUN pnpm --filter @constella/web build && pnpm prune --prod 2>/dev/null || true

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git tar ca-certificates curl p7zip-full xz-utils bzip2 zstd \
    libreoffice-writer-nogui libreoffice-calc-nogui libreoffice-impress-nogui fonts-noto-cjk \
 && rm -rf /var/lib/apt/lists/*
ARG BITWARDEN_CLI_VERSION=2026.9.1
RUN npm install --global "@bitwarden/cli@${BITWARDEN_CLI_VERSION}" --registry=https://registry.npmjs.org && npm cache clean --force
COPY --from=build /app /app
WORKDIR /app/apps/hub
ENV NODE_ENV=production NODE_NO_WARNINGS=1 CONSTELLA_WEB_DIST=/app/apps/web/dist
EXPOSE 8780
HEALTHCHECK --interval=20s --timeout=5s --start-period=20s CMD curl -fs http://127.0.0.1:8780/api/health || exit 1
CMD ["node", "src/index.ts"]
