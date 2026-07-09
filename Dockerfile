# syntax=docker/dockerfile:1.7
#
# Single multi-stage image for the "scp" binary — server + worker + UI stub, local auth
# (BUILD_AND_TEST.md §3.3, §5.2). `docker build -t scp:dev .` is the only server image build
# command in the project; `docker compose -f deploy/compose/docker-compose.yml up` is the
# two-container evaluation stack (postgres:16 + this image, SCP_ROLE=all).
#
# M0 simplification (recorded deviation): copies the whole pruned workspace into the runtime
# stage rather than selectively copying per-package dist/ output — apps/web has no real bundle
# to serve yet (M0's UI stub is server-rendered directly by apps/server; the real SPA lands in
# M2). Slimming this further (pnpm deploy / per-package dist copies) is good follow-up work, not
# required for the walking skeleton.

FROM node:22-bookworm-slim AS base
RUN corepack enable && corepack prepare pnpm@10.12.1 --activate
WORKDIR /app

# Lockfile-cached dependency fetch layer — invalidated only when the lockfile changes.
FROM base AS fetch
COPY pnpm-lock.yaml ./
RUN pnpm fetch

FROM fetch AS build
COPY . .
RUN pnpm install --offline --frozen-lockfile
RUN pnpm build
# Drop devDependencies now that everything is compiled to dist/ — nothing at runtime needs tsc,
# tsx, vitest, drizzle-kit, etc.
RUN pnpm prune --prod

FROM base AS runtime
ENV NODE_ENV=production
ENV SCP_ROLE=all
ENV PORT=8080
COPY --from=build /app /app
WORKDIR /app/apps/server
EXPOSE 8080
CMD ["node", "dist/main.js"]
