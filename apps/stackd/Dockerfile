# scp-stackd — the Standard Stack controller (M29.4, ADR-0058). Build from the REPO ROOT:
#
#     docker build -f apps/stackd/Dockerfile -t scp-stackd:dev .
#
# NO `# syntax=` directive, for the root Dockerfile's reason: it would make BuildKit pull a frontend
# from Docker Hub on every cold build. Nothing below needs one.
#
# WHAT THE IMAGE CARRIES IS WHAT THE STACK IS (E4). One SCP release = this image = the vendored
# deploy/helm-bundled chart it copies + the pinned helm that renders it. There is no chart repo, no
# `helm pull`, and no network at runtime; upgrading SCP replaces this image, and the controller
# rolls the backends onto what the new one carries.
#
# The controller is ONE bundled file (esbuild) on a bare Node runtime: no node_modules, no npm, no
# package manager — the same CVE posture the root Dockerfile reaches by deletion, reached here by
# never copying them in.

# Keep in sync with tools/node/pin.env (the root Dockerfile's base) and tools/helm/pin.env —
# apps/stackd/src/helm-pin.test.ts fails if they drift.
ARG NODE_IMAGE=docker.io/library/node@sha256:7b8a0c89c54499bee567618f96578e1a12a800f062fbdbfd1fb6a443fa6f6284
ARG HELM_PINNED_VERSION=v3.20.2
ARG HELM_TARBALL_SHA256=258e830a9e613c8a7a302d6059b4bb3b9758f2f3e1bb8ea0d707ce10a9a72fea

FROM ${NODE_IMAGE} AS build
RUN corepack enable && corepack prepare pnpm@10.12.1 --activate
WORKDIR /app
COPY pnpm-lock.yaml ./
RUN pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile
RUN pnpm --filter "@scp/stackd..." build && pnpm --filter @scp/stackd bundle

# The pinned helm: the official release tarball, checked against the pin's sha256 before it is
# unpacked. (The Helm project publishes no container image to take it from by digest.)
FROM ${NODE_IMAGE} AS helm
ARG HELM_PINNED_VERSION
ARG HELM_TARBALL_SHA256
ADD https://get.helm.sh/helm-${HELM_PINNED_VERSION}-linux-amd64.tar.gz /tmp/helm.tgz
RUN echo "${HELM_TARBALL_SHA256}  /tmp/helm.tgz" | sha256sum -c - \
  && tar -xzf /tmp/helm.tgz -C /tmp linux-amd64/helm \
  && /tmp/linux-amd64/helm version --template '{{.Version}}' | grep -qx "${HELM_PINNED_VERSION}"

FROM ${NODE_IMAGE} AS runtime
# Same hardening as the root Dockerfile's runtime stage: Debian security fixes folded in, npm /
# corepack / npx deleted (nothing here runs a package manager), perl-base removed.
RUN apt-get update \
  && apt-get upgrade -y \
  && rm -rf /var/lib/apt/lists/* \
  && rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
  && dpkg --purge --force-remove-essential --force-depends perl-base
ENV NODE_ENV=production
COPY --from=helm /tmp/linux-amd64/helm /opt/scp/bin/helm
COPY tools/helm/pin.env /opt/scp/stack/helm.pin.env
COPY deploy/helm-bundled /opt/scp/stack/helm-bundled
COPY --from=build /app/apps/stackd/bundle/stackd.mjs /opt/scp/stackd/stackd.mjs
# helm needs a writable HOME for its (unused) cache/config dirs; /tmp is the only writable path
# under the chart's readOnlyRootFilesystem.
ENV HOME=/tmp
USER 1000:1000
ENTRYPOINT ["node", "/opt/scp/stackd/stackd.mjs"]
