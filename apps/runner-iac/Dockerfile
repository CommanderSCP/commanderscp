# syntax=docker/dockerfile:1.7
#
# scp-runner-iac — the SEPARATE image the scp-managed-iac executor launches per run (DESIGN.md
# §12 Mode 2, charter's Managed Execution Exception, BUILD_AND_TEST.md §8 M7 item 3): pinned
# OpenTofu + a minimal run shim, NOTHING ELSE. No Node app code lives here (docs/DESIGN.md §3) —
# `packages/plugins/managed-iac` is the thin ORCHESTRATOR (runs inside scpd, launches this image
# as an ephemeral container per run); this image is the ISOLATED TOOLCHAIN it launches. The scpd
# image (root Dockerfile) carries no IaC toolchain at all — this is the only place `tofu` exists
# in the whole system.
#
# `docker build -t scp-runner-iac:dev apps/runner-iac` is the only build command for this image
# (BUILD_AND_TEST.md §3.3). Built FROM OpenTofu's own official image (pinned tag, matching
# BUILD_AND_TEST.md §1's "OpenTofu 1.8.x pinned") rather than hand-downloading/verifying a release
# binary — the upstream image already owns that supply chain; this Dockerfile only adds the run
# shim and drops every credential the run shim's ENTRYPOINT loads to environment variables that
# never leave this container (see run.sh's own doc comment for the credential-confinement
# contract the managed-iac orchestrator plugin relies on).
#
# CVE SWEEP 2026-08-31 — WHY THIS PIN IS STUCK AT 1.8.5 (trivy flags ~3 CRITICAL / 55 HIGH in this
# image: its Alpine git/musl userland plus tofu's own Go stdlib). OpenTofu 1.10+ DELIBERATELY BLOCKS
# being used as a base image: `docker inspect ghcr.io/opentofu/opentofu:1.12.6` carries an
# `ONBUILD RUN exit 1` (plus a WARNING banner) that fails ANY downstream `FROM`, so a straight tag
# bump breaks `docker build apps/runner-iac` — which CI job 4c builds on every PR. See
# https://github.com/opentofu/opentofu/issues/1931. `tofu` IS a static Go binary, so the supported
# path is `COPY --from=ghcr.io/opentofu/opentofu:<ver> /usr/local/bin/tofu` (a `COPY --from` image
# ref does NOT trigger ONBUILD, unlike `FROM`) onto a maintained base carrying bash + git (module
# fetch) + ca-certificates (provider HTTPS). That reworks this credential-handling execution runner
# and MUST be validated by the managed-iac drill/fixture before shipping — a flagged follow-up, not
# a same-PR change. Until then this stays on 1.8.5, the last `FROM`-able release.
FROM ghcr.io/opentofu/opentofu:1.8.5

# The upstream image already provides `tofu`; add only the run shim on top. No package manager
# calls, no extra tooling — every extra byte here is extra attack surface in a container that,
# for the duration of one run, holds real (scoped, vaulted) infrastructure credentials.
COPY run.sh /run.sh
RUN chmod +x /run.sh

WORKDIR /workspace
ENTRYPOINT ["/run.sh"]
