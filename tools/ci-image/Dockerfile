# syntax=docker/dockerfile:1.7
#
# tools/ci-image/Dockerfile — versioned CI runner image (BUILD_AND_TEST.md §1, §6: "Required
# tooling (Node, pnpm store, Playwright browsers, oasdiff) is baked into a versioned CI runner
# image built from tools/ci-image/Dockerfile"). Bakes in everything CI jobs need so that, once
# THIS IMAGE has been built and is available to a CI job, running that job requires ZERO network
# access — the air-gap principle (CLAUDE.md #5: "No runtime network calls to the outside world...
# Everything (CI included) must run offline").
#
# IMPORTANT DISTINCTION — read this before assuming anything here contradicts the air-gap rule:
#   "baked in" / "vendored" always means "fetched ONCE, at IMAGE BUILD time, by whoever builds
#   this image" — never "magically present with no origin." Every RUN step below that reaches the
#   network (apt-get, npx playwright install) runs ONLY when this Dockerfile is built, producing a
#   self-contained image afterwards. Once built (and, in a real deployment, pushed to a registry —
#   see tools/ci-image/README.md for what this repo does today vs. what a full production setup
#   needs), CI JOBS THAT RUN INSIDE IT make no network calls of their own for the tooling it bakes
#   in. This is the same posture as OpenTofu's official image apps/runner-iac/Dockerfile builds
#   FROM, and as this repo's own root Dockerfile's `pnpm fetch` layer.
#
# Build context MUST be the repo root (not this directory) — this Dockerfile reads the root
# pnpm-lock.yaml both to warm the pnpm store and to resolve the exact @playwright/test version to
# install a matching Chromium build for, and reads the vendored oasdiff binary from
# tools/openapi/bin/. Build with (from repo root):
#   docker build -f tools/ci-image/Dockerfile -t scp-ci-image:dev .
# This mirrors how the root Dockerfile itself is built (`docker build -t scp:dev .`) — see that
# file's own header comment for the `pnpm fetch` idiom this Dockerfile reuses. (Note: this is a
# deliberate deviation from the simpler `docker build tools/ci-image` shorthand one might expect
# by analogy with apps/runner-iac's self-contained Dockerfile — apps/runner-iac needs nothing
# outside its own directory, this image genuinely needs the root lockfile and the vendored
# oasdiff binary, so its context has to be the repo root. Documented here and in
# tools/ci-image/README.md so it isn't a surprise.)
#
# What's baked in:
#   - Node 22 (from the base image, matching .nvmrc) + corepack-pinned pnpm (packageManager field
#     in package.json — 10.12.1)
#   - A warm pnpm store (`pnpm fetch` against the committed lockfile) so `pnpm install --offline
#     --frozen-lockfile` never touches the network at CI run time (assumes the CI job runs as the
#     same user/HOME as this build — root — so pnpm's default store path lines up; see README)
#   - Playwright's Chromium + its Debian OS-level deps, version-matched to the EXACT
#     @playwright/test version resolved in pnpm-lock.yaml (not just apps/web/package.json's
#     semver range) — so apps/web's e2e suite never fetches a browser at test time
#   - git (needed by tools/openapi/check.sh's merge-base diffing, and generally useful for any CI
#     step that shells out to git) + ca-certificates (needed for the build-time fetches below)
#   - The vendored oasdiff binary — copied in from tools/openapi/bin/oasdiff-linux-amd64, which is
#     committed to the repo separately, at REPO-VENDORING time, NOT downloaded by this Dockerfile;
#     see tools/openapi/README.md for why that's a distinct concern (reproducibility/audit of a
#     release binary) from the build-time tool-baking this Dockerfile otherwise does.
#
# What's intentionally NOT baked in: application source/dist. This is a TOOLING image — CI jobs
# still `actions/checkout` the actual commit under test and mount/copy it in at run time, then
# build against it using the pre-warmed store and browsers baked in here. Baking commit-specific
# build output into a "versioned" (i.e. long-lived, rebuilt only on toolchain/lockfile changes)
# image would make it stale the moment a second commit landed.

FROM node:22-bookworm-slim

# Matches .nvmrc's "22" / BUILD_AND_TEST.md §1's Node 22.17.x line (inherited from the base
# image's own pinned Node 22 build) and the root Dockerfile's `node:22-bookworm-slim` convention —
# kept in sync deliberately so CI's toolchain matches what the shipped image builds with.
RUN corepack enable && corepack prepare pnpm@10.12.1 --activate

# Pin pnpm's content-addressable store to a fixed, explicit path rather than letting pnpm
# auto-select one. This matters more than it looks: pnpm silently RELOCATES the store to a
# project-local `.pnpm-store/` (empty, unwarmed) whenever it detects the target checkout lives on
# a different filesystem device than the configured/default store dir — which is exactly what
# happens when a CI job bind-mounts a fresh checkout into a container built from this image (a
# bind-mounted host directory reports a different `st_dev` than the image's own overlay
# filesystem; confirmed locally via `stat -c %d`). Without this pin, `pnpm install --offline`
# silently stops seeing the store this Dockerfile just warmed and fails with
# ERR_PNPM_NO_OFFLINE_TARBALL on the very first package pnpm would otherwise have had to hard-link
# across devices. Setting store-dir explicitly (env var, not just default) makes pnpm copy instead
# of hard-link when devices differ — slower, but still 100% offline, which is what we need. Any
# `pnpm` invocation inside a container FROM this image inherits this automatically; no CI caller
# needs to remember a flag.
ENV npm_config_store_dir=/root/.local/share/pnpm/store

# git: required by tools/openapi/check.sh (git merge-base / git show against the committed spec)
# and generally by any CI step that shells out to git from inside a container built FROM this
# image. ca-certificates/curl/gnupg: needed for the build-time network fetches below (apt-get,
# npx, the Docker apt repo added next) to validate TLS certs — ca-certificates stays in the final
# image too since some downstream CI steps may make their own (documented, separately-justified)
# network calls, e.g. `pnpm audit` in the release pipeline against a mirrored advisory DB.
RUN apt-get update -qq \
    && apt-get install -y -qq --no-install-recommends git ca-certificates curl gnupg \
    && rm -rf /var/lib/apt/lists/*

# Docker CLI + the `docker compose` (v2, plugin form — NOT the legacy hyphenated
# `docker-compose` python script Debian's own repo would give you, which scripts/e2e-web.sh does
# not use) v2 plugin. This does NOT install or run a Docker daemon inside the image — CI jobs run
# this image as a sibling container with the HOST's Docker socket bind-mounted in
# (`-v /var/run/docker.sock:/var/run/docker.sock`, standard "Docker-outside-of-Docker" pattern),
# so `docker compose build/up` invoked from inside a container FROM this image controls the same
# Docker daemon the CI runner itself uses — needed because scripts/e2e-web.sh (which this image
# is built to run end-to-end, see .github/workflows/ci.yml's e2e-web job) both builds the `scpd`
# app image and drives Playwright against it. Installed from Docker's own official apt repo
# (not Debian's) so the compose plugin version actually matches what `docker compose` (space
# form) needs; `$(dpkg --print-architecture)` makes this resolve the right package for either
# linux/amd64 or linux/arm64 automatically, same as apt already does for every other package here.
RUN install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
       > /etc/apt/sources.list.d/docker.list \
    && apt-get update -qq \
    && apt-get install -y -qq --no-install-recommends docker-ce-cli docker-compose-plugin \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /ci

# --- Warm pnpm store -------------------------------------------------------------------------
# Lockfile-only layer, same idiom as the root Dockerfile's `fetch` stage: invalidated only when
# pnpm-lock.yaml changes, not on every source edit. `pnpm fetch` populates pnpm's content-addressed
# global store (NOT node_modules — no workspace/package.json needed for this step) from the
# lockfile, so a later `pnpm install --offline --frozen-lockfile` — run by CI jobs against their
# own fresh checkout, using this same store — resolves and links entirely from disk, no network.
COPY pnpm-lock.yaml ./pnpm-lock.yaml
RUN pnpm fetch

# --- Playwright's Chromium, version-matched to the lockfile ----------------------------------
# Resolve the exact @playwright/test version pnpm-lock.yaml resolved to (not apps/web/package.json's
# "^1.48.0" range — the lockfile has the real pinned version, e.g. 1.61.1) and install that exact
# `playwright` CLI + its matching Chromium build + Debian OS-level deps (`--with-deps`).
# NETWORK ACCESS HAPPENS HERE, at image build time only — see the file-level comment above for why
# that's expected and fine, and distinct from the "no runtime network calls" guarantee this image
# gives to the CI jobs that later run inside it.
# cdn.playwright.dev can be slow or briefly unreachable from a self-hosted runner. Playwright
# retries internally, but back-to-back at a 30s timeout; a longer connection timeout plus a few
# spaced outer attempts survives a slow / briefly-down CDN. This build is now OCCASIONAL — it runs
# only on a cache miss, when tools/ci-image/Dockerfile or pnpm-lock.yaml changes (see
# .github/workflows/ci.yml's ci-image job, which pulls the pre-built image from GHCR and rebuilds
# only then) — so spending a few minutes retrying here is cheap insurance, not a per-push cost.
ENV PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT=180000
RUN set -eux; \
    PLAYWRIGHT_VERSION="$(grep -m1 "@playwright/test@" pnpm-lock.yaml \
        | sed -E "s/.*@playwright\/test@([0-9][^:(',]*).*/\1/")"; \
    if [ -z "$PLAYWRIGHT_VERSION" ]; then \
        echo "tools/ci-image/Dockerfile: could not resolve @playwright/test version from pnpm-lock.yaml" >&2; \
        exit 1; \
    fi; \
    echo "Baking in Playwright Chromium for @playwright/test@${PLAYWRIGHT_VERSION} (resolved from pnpm-lock.yaml)"; \
    for attempt in 1 2 3 4 5; do \
        echo "playwright chromium install attempt ${attempt}/5"; \
        if npx --yes "playwright@${PLAYWRIGHT_VERSION}" install --with-deps chromium; then \
            echo "chromium installed on attempt ${attempt}"; break; \
        fi; \
        if [ "${attempt}" = "5" ]; then \
            echo "tools/ci-image/Dockerfile: chromium download failed after 5 attempts (cdn.playwright.dev unreachable?)" >&2; \
            exit 1; \
        fi; \
        s=$((attempt * 20)); echo "download failed; sleeping ${s}s then retrying"; sleep "${s}"; \
    done

# --- oasdiff -----------------------------------------------------------------------------------
# NOT downloaded here — a plain file copy of the binary vendored/committed under
# tools/openapi/bin/ (repo-level supply-chain concern: reproducibility + auditability of a
# release binary, distinct from the build-time tool-baking above). See tools/openapi/README.md
# for provenance (release version, checksum, license).
COPY tools/openapi/bin/oasdiff-linux-amd64 /usr/local/bin/oasdiff
RUN chmod +x /usr/local/bin/oasdiff

# CI jobs mount or copy the actual commit under test into the container at run time (e.g.
# `docker run --rm -v "$(pwd):/workspace" -w /workspace scp-ci-image:<tag> <command>`, or via
# GitHub Actions' job-level `container:` directive once this image is published to a registry —
# see tools/ci-image/README.md for the honest gap between that and what this change actually
# wires up). No ENTRYPOINT/CMD: this image is a toolchain, not a runnable service.
