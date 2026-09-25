# scp-runner-dep-vendor — the credential-free, `--network none` SANDBOX the `re-vendor` bump
# strategy launches per run (M29.8a, ADR-0059, charter `scp-managed-dep` amendment 2026-09-25). It
# is the OWNER-MANDATED SPLIT (2026-09-25 review of PR #420): untrusted upstream bytes never reach
# the repository-write credential. `packages/plugins/managed-dep`'s orchestrator holds that
# credential and reaches the network (fetch by commit SHA, cosign/checksum verification, image
# digest resolution); THIS image receives only the bytes the orchestrator already fetched and
# verified, parses/splits/rewrites them, runs `helm template` for Gitea (local chart dir, no
# network), classifies the diff (`@scp/vendor-refresh`'s `classifyRevendorDiff`), and returns files
# — it reaches no host and holds no credential of any kind.
#
# BUILD: `docker build -f apps/runner-dep-vendor/Dockerfile -t scp-runner-dep-vendor:dev .` — THE
# CONTEXT IS THE REPO ROOT (`.`), a DELIBERATE DEVIATION from every sibling runner
# (`apps/runner-dep`, `apps/runner-iac`, `apps/runner-scan`, each built with ITS OWN directory as
# context). Those runners carry no Node app code at all (docs/DESIGN.md §3's own rule) — this one
# is the sole, narrow exception the split forces: `@scp/vendor-refresh`'s planner (the SAME code
# every human `vendor-refresh refresh` run and every existing unit test already exercises — nothing
# about the planner changes for the split, only WHERE it runs) is real TypeScript that resolves
# `workspace:*` dependencies (`@scp/dependency-manifests`, the `yaml` package) through pnpm's
# workspace store, which only exists with the whole monorepo as build context. `scripts/runner-
# image-tags.sh` and `.github/workflows/ci.yml`'s runner-images job both know about this deviation
# — see their own comments before changing either.
#
# NO `# syntax=` directive, same reason as the root Dockerfile: BuildKit would PULL that frontend
# from Docker Hub on a cache miss (charter principle 5, air-gap CI). No feature here needs it.

ARG NODE_IMAGE=docker.io/library/node@sha256:7b8a0c89c54499bee567618f96578e1a12a800f062fbdbfd1fb6a443fa6f6284
ARG HELM_PINNED_ARCHIVE=helm-v3.16.4-linux-amd64.tar.gz
ARG HELM_PINNED_SHA256=fc307327959aa38ed8f9f7e66d45492bb022a66c3e5da6063958254b9767d179

# ---------------------------------------------------------------------------------------------
# THE PINNED HELM BINARY (tools/helm/pin.env). Fetched by ARCHIVE NAME + verified against the
# CHECKSUM below BEFORE extraction — Helm publishes no first-party container image to `COPY
# --from=` the way cosign/skopeo/OpenTofu's pins do (see tools/helm/pin.env's own header for why
# this is a tarball+checksum pin rather than a digest-pinned image). This stage is the ONLY place
# in the whole build that reaches the network — the runtime stage below never does.
# ---------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS helm-fetch
ARG HELM_PINNED_ARCHIVE
ARG HELM_PINNED_SHA256
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
    curl -fsSL -o /tmp/helm.tgz "https://get.helm.sh/${HELM_PINNED_ARCHIVE}"; \
    echo "${HELM_PINNED_SHA256}  /tmp/helm.tgz" | sha256sum -c -; \
    tar -xzf /tmp/helm.tgz -C /tmp; \
    mkdir -p /helm-bin; \
    mv /tmp/linux-amd64/helm /helm-bin/helm; \
    chmod +x /helm-bin/helm

# ---------------------------------------------------------------------------------------------
# BUILD @scp/vendor-refresh (+ its workspace deps: @scp/dependency-manifests) — the SAME `pnpm
# fetch` -> `pnpm install --offline` -> build shape the root Dockerfile uses, scoped with `--filter
# ...` to just this package's own dependency graph rather than the whole monorepo (`...` pulls in
# its workspace deps; turbo then only builds what that graph actually needs) — this image's CI
# rebuild should track vendor-refresh/dependency-manifests changes, not an unrelated app's.
# ---------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS base
RUN corepack enable && corepack prepare pnpm@10.12.1 --activate
WORKDIR /app

FROM base AS fetch
COPY pnpm-lock.yaml ./
RUN pnpm fetch

FROM fetch AS build
COPY . .
RUN pnpm install --offline --frozen-lockfile
RUN pnpm --filter @scp/vendor-refresh... build

# ---------------------------------------------------------------------------------------------
# THE RUNTIME IMAGE. Reuses the pinned Node base (unlike apps/runner-dep's `scratch`/BusyBox image
# — this sandbox runs real compiled JS, so it needs a Node runtime; ADR-0059 §"why a sibling image"
# weighs this against extending scp-runner-dep itself). devDependencies are DELIBERATELY NOT
# pruned here (a deviation from the root Dockerfile's `pnpm prune --prod`): this image already
# carries `--network none` + no credential of any kind as its actual containment, or so ADR-0059
# argues; pruning a filtered `/app` tree correctly is real, separate engineering (a scoped follow-
# up, not attempted here) and an unpruned devDependency tree is a strictly smaller risk increase
# for an image that reaches nothing than it would be for the always-on server image.
# ---------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
RUN apt-get update \
  && apt-get upgrade -y \
  && rm -rf /var/lib/apt/lists/* \
  && rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
  && dpkg --purge --force-remove-essential --force-depends perl-base \
  && mkdir -p /work/in /work/out
COPY --from=build /app /app
COPY --from=helm-fetch /helm-bin/helm /usr/local/bin/helm

WORKDIR /work
ENTRYPOINT ["node", "/app/tools/vendor-refresh/dist/sandbox-main.js"]
