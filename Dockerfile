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

# Vendored, DIGEST-PINNED skopeo (M15.5 c1 — provenance: tools/skopeo/README.md, pin source of
# truth: tools/skopeo/pin.env). Same shape as the cosign pin above: the linux/amd64 PLATFORM
# manifest digest of the upstream project's own official image (skopeo publishes NO release
# binaries at all — the image IS the official binary distribution). Keep in sync with
# tools/skopeo/pin.env — deploy/airgap/src/skopeo-bin.test.ts fails if they drift.
# (Both ARGs sit above the first FROM: an ARG consumed by a FROM must be declared in the global
# scope before any stage begins — the classic builder hard-errors otherwise.)
ARG SKOPEO_IMAGE=quay.io/skopeo/stable@sha256:8b23fe434af822adf71bc7c8674a8dfab379771aa1400fb81ff655a5cecfca87

FROM ${COSIGN_IMAGE} AS cosign

FROM ${SKOPEO_IMAGE} AS skopeo

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
# The pinned skopeo (M15.5 c1), beside cosign under /opt/scp — same reasoning: a path that cannot
# collide with an operator-installed skopeo, so packages/cosign/src/skopeo-bin.ts can tell the
# vetted pin (static behavior + fail-closed version assertion) apart from somebody else's build.
#
# DEVIATION from the cosign pin: cosign's ko-built binary is static; skopeo's is DYNAMICALLY
# linked against Fedora sonames (libgpgme.so.45, libsubid.so.5, …) that Debian does not ship. So
# we vendor the binary PLUS its closed shared-library closure PLUS Fedora's own ELF loader under
# /opt/scp/libexec/skopeo, and /opt/scp/bin/skopeo is a wrapper that runs the binary against
# exactly those vendored libraries (never the host's — host glibc version is irrelevant). The
# library list below is the full `ldd` closure of the pinned binary, verified closed (each lib's
# own deps are already in the list). If an upstream update renames a soname, this COPY fails the
# build loudly — see tools/skopeo/README.md "Updating the pin" for how to regenerate the list.
COPY --from=skopeo /usr/bin/skopeo /opt/scp/libexec/skopeo/skopeo
COPY --from=skopeo \
  /lib64/ld-linux-x86-64.so.2 \
  /lib64/libacl.so.1 \
  /lib64/libassuan.so.0 \
  /lib64/libattr.so.1 \
  /lib64/libaudit.so.1 \
  /lib64/libbz2.so.1 \
  /lib64/libc.so.6 \
  /lib64/libcap-ng.so.0 \
  /lib64/libcrypt.so.2 \
  /lib64/libeconf.so.0 \
  /lib64/libgpg-error.so.0 \
  /lib64/libgpgme.so.45 \
  /lib64/libm.so.6 \
  /lib64/libpam.so.0 \
  /lib64/libpam_misc.so.0 \
  /lib64/libpcre2-8.so.0 \
  /lib64/libresolv.so.2 \
  /lib64/libselinux.so.1 \
  /lib64/libsemanage.so.2 \
  /lib64/libsepol.so.2 \
  /lib64/libsqlite3.so.0 \
  /lib64/libsubid.so.5 \
  /opt/scp/libexec/skopeo/lib/
# Wrapper (mode +x is preserved from git) and the minimal containers-policy. The policy is
# insecureAcceptAnything — skopeo here is a byte mover; artifact trust is enforced by cosign
# manifest verification at promotion import (M17.4a), not by skopeo's simple-signing/GPG policy
# engine. See tools/skopeo/README.md "The policy.json choice".
COPY tools/skopeo/skopeo-wrapper.sh /opt/scp/bin/skopeo
COPY tools/skopeo/policy.json /etc/containers/policy.json
WORKDIR /app/apps/server
EXPOSE 8080
CMD ["node", "dist/main.js"]
