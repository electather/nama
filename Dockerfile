# syntax=docker/dockerfile:1

FROM node:24.19.0-bookworm-slim AS workspace

ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"
WORKDIR /workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches/ ./patches/
COPY apps/server/package.json apps/server/.npmignore ./apps/server/
COPY plugins/jellyfin/package.json plugins/jellyfin/.npmignore ./plugins/jellyfin/
COPY gen/ts/package.json gen/ts/.npmignore ./gen/ts/

RUN corepack enable && pnpm install --prod --frozen-lockfile --ignore-scripts

COPY apps/server/src/ ./apps/server/src/
COPY apps/server/drizzle/ ./apps/server/drizzle/
COPY plugins/jellyfin/src/ ./plugins/jellyfin/src/
COPY gen/ts/src/ ./gen/ts/src/

RUN pnpm --config.inject-workspace-packages=true --filter @nama/server deploy --prod --ignore-scripts /output/apps/server \
  && pnpm --config.inject-workspace-packages=true --filter @nama/jellyfin deploy --prod --ignore-scripts /output/plugins/jellyfin \
  && pnpm --config.inject-workspace-packages=true --filter @nama/api deploy --prod --ignore-scripts /output/gen/ts

FROM node:24.19.0-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

RUN groupadd --gid 10001 nama \
  && useradd --uid 10001 --gid 10001 --no-create-home --no-log-init --shell /usr/sbin/nologin nama

COPY --from=workspace --chown=10001:10001 /output/apps/server/ ./apps/server/
COPY --from=workspace --chown=10001:10001 /output/plugins/jellyfin/ ./plugins/jellyfin/
COPY --from=workspace --chown=10001:10001 /output/gen/ts/ ./gen/ts/

USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["node", "apps/server/src/main.ts"]
