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
# BUILD_AND_TEST.md §1's "OpenTofu 1.12.x pinned") rather than hand-downloading/verifying a release
# binary — the upstream image already owns that supply chain; this Dockerfile only adds the run
# shim and drops every credential the run shim's ENTRYPOINT loads to environment variables that
# never leave this container (see run.sh's own doc comment for the credential-confinement
# contract the managed-iac orchestrator plugin relies on).
# (1.8.5 -> 1.12.6, 2026-08-31 CVE sweep: the 1.8 line stopped receiving upstream image rebuilds —
# its image scanned 3 CRITICAL / 55 HIGH, ancient git/musl included — and 1.12.6 is the newest
# supported patch release, scanning 1 CRITICAL / 10 HIGH, all of which are Go-module advisories
# already fixed upstream awaiting the next OpenTofu release. State written by a newer tofu upgrades
# the state format irreversibly, so this bump is forward-only for managed-iac workspaces.)
FROM ghcr.io/opentofu/opentofu:1.12.6

# The upstream image already provides `tofu`; add only the run shim on top. No package manager
# calls, no extra tooling — every extra byte here is extra attack surface in a container that,
# for the duration of one run, holds real (scoped, vaulted) infrastructure credentials.
COPY run.sh /run.sh
RUN chmod +x /run.sh

WORKDIR /workspace
ENTRYPOINT ["/run.sh"]
