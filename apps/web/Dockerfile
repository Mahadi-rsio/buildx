# syntax=docker/dockerfile:1

# Build context is the repository root, because this is a pnpm workspace and
# @buildx/web depends on the local packages (agent, db, sandbox, shared, storage).

FROM node:22-alpine AS base
RUN npm install -g pnpm@12.3.4
WORKDIR /repo
ENV NEXT_TELEMETRY_DISABLED=1

# ---- Builder ---------------------------------------------------------------
FROM base AS builder

# Manifests first so the dependency install layer stays cacheable.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY packages/agent/package.json packages/agent/
COPY packages/db/package.json packages/db/
COPY packages/sandbox/package.json packages/sandbox/
COPY packages/shared/package.json packages/shared/
COPY packages/storage/package.json packages/storage/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# Full sources (node_modules / .next are excluded via .dockerignore and survive
# the merge, so the install above is preserved).
COPY tsconfig.base.json ./
COPY apps/web apps/web
COPY packages packages

# Better Auth and the DB client validate their env at import time, and Next
# evaluates route modules during page-data collection. The build only needs
# placeholders (not the real secrets); the runner is a fresh FROM stage, so real
# values are supplied at runtime via `docker run -e ...`.
RUN --mount=type=cache,id=nextjs,target=/repo/apps/web/.next/cache \
    BETTER_AUTH_SECRET=build-time-placeholder \
    DATABASE_URL=postgres://buildx:buildx@localhost:5432/buildx \
    pnpm --filter @buildx/web build

# ---- Runner ----------------------------------------------------------------
FROM node:22-alpine AS runner

WORKDIR /repo

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

RUN addgroup -S -g 1001 nodejs && adduser -S -u 1001 -G nodejs nextjs

# `output: "standalone"` emits a self-contained server under .next/standalone
# that mirrors the repo layout, so the entrypoint is apps/web/server.js.
COPY --from=builder --chown=nextjs:nodejs /repo/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=nextjs:nodejs /repo/apps/web/public ./apps/web/public

USER nextjs

EXPOSE 3000

CMD ["node", "apps/web/server.js"]
