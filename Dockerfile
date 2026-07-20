# syntax=docker/dockerfile:1.7
#
# Single multi-stage image for the "scp" binary — server + worker + Web UI v1 (React SPA, served
# as static assets by apps/server — DESIGN.md §14), local auth (BUILD_AND_TEST.md §3.3, §5.2).
# `docker build -t scp:dev .` is the only server image build command in the project;
# `docker compose -f deploy/compose/docker-compose.yml up` is the two-container evaluation stack
# (postgres:16 + this image, SCP_ROLE=all).
#
# Simplification (recorded deviation): copies the whole pruned workspace into the runtime stage
# rather than selectively copying per-package dist/ output. `pnpm build` (turbo) builds every
# workspace package including apps/web (`vite build` -> apps/web/dist, M2 stage 4), and the
# `COPY --from=build /app /app` below picks that up along with every other package's dist/ —
# apps/server's static mount (app.ts) then serves it directly from the copied
# apps/web/dist. Slimming this further (pnpm deploy / per-package dist copies) is good follow-up
# work, not required here.

# Vendored, DIGEST-PINNED cosign (M17.3 E1 — provenance: tools/cosign/README.md, pin source of
# truth: tools/cosign/pin.env). Same precedent as apps/runner-iac/Dockerfile's pinned OpenTofu
# image: take the binary from the upstream project's OWN published image rather than
# hand-downloading a release asset + checksum, and pin it by DIGEST (stronger than a tag or a
# URL+sha256 — the digest IS the content hash of the whole image, and it cannot be re-pointed).
#
# The ref below is the linux/amd64 PLATFORM manifest digest, not the multi-arch index digest, so
# it resolves to exactly one architecture regardless of the build host (this repo builds
# linux/amd64 only — .github/workflows/publish-images.yml uses plain `docker build`, no buildx;
# arm64 is deliberately out of scope). Keep in sync with tools/cosign/pin.env — the test at
# deploy/airgap/src/cosign-bin.test.ts fails if they drift.
ARG COSIGN_IMAGE=ghcr.io/sigstore/cosign/cosign@sha256:bea051df6a6d3bc84288b6db098df38a81d87b7ed226f34d22aaae1bc329c2b7
FROM ${COSIGN_IMAGE} AS cosign

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
# The pinned cosign, at a path that CANNOT collide with an operator-supplied cosign on PATH —
# that separation is what lets deploy/airgap/src/cosign-bin.ts tell "this is the pinned binary,
# use the static known-good flags and assert the version" apart from "this is somebody else's
# cosign, keep probing".
#
# No `RUN chmod` follows deliberately: the upstream file is already mode 0555 and COPY preserves
# it, whereas a chmod layer over a ~135 MiB binary would DOUBLE its contribution to the image.
# (`COPY --chmod=` is BuildKit-only and this repo builds with the classic builder — plain
# `docker build`, no buildx — so it isn't an option either.) The executable bit is asserted for
# real by the CI step that runs `cosign version` out of this path.
COPY --from=cosign /ko-app/cosign /opt/scp/bin/cosign
WORKDIR /app/apps/server
EXPOSE 8080
CMD ["node", "dist/main.js"]
