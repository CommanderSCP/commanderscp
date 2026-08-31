# syntax=docker/dockerfile:1.7
#
# scp-runner-iac — the SEPARATE image the scp-managed-iac executor launches per run (DESIGN.md
# §12 Mode 2, charter's Managed Execution Exception, BUILD_AND_TEST.md §8 M7 item 3): a current
# OpenTofu binary + a minimal run shim on a maintained slim base, NOTHING ELSE. No Node app code
# lives here (docs/DESIGN.md §3) — `packages/plugins/managed-iac` is the thin ORCHESTRATOR (runs
# inside scpd, launches this image as an ephemeral container per run); this image is the ISOLATED
# TOOLCHAIN it launches. The scpd image (root Dockerfile) carries no IaC toolchain at all — this
# is the only place `tofu` exists in the whole system.
#
# `docker build -t scp-runner-iac:dev apps/runner-iac` is the only build command for this image
# (BUILD_AND_TEST.md §3.3).
#
# CVE SWEEP 2026-08-31 — WHY THIS IS NO LONGER `FROM ghcr.io/opentofu/opentofu:<ver>`. OpenTofu
# 1.10+ deliberately blocks being used as a base image: `docker inspect
# ghcr.io/opentofu/opentofu:1.12.6 --format '{{.Config.OnBuild}}'` carries an `ONBUILD RUN exit 1`
# (plus a WARNING banner) that fails ANY downstream `FROM` — see
# https://github.com/opentofu/opentofu/issues/1931 — so a straight tag bump on the old `FROM`
# broke `docker build apps/runner-iac`, which CI job 4c builds on every PR. `tofu` IS a static Go
# binary though (`ldd /usr/local/bin/tofu` reports "Not a valid dynamic program" on 1.12.6), and
# `COPY --from=<image-ref>` — unlike `FROM` — does NOT trigger a source image's ONBUILD. So this
# Dockerfile takes its base from a maintained distro and copies ONLY the `tofu` binary out of the
# upstream OpenTofu image on top of it.
#
# WHY ALPINE, NOT DEBIAN (measured, not assumed — re-check before "fixing" this to match the root
# Dockerfile's Debian family for consistency): `git` is a hard requirement (run.sh's own doc
# comment — `tofu init` shells out to it for git-sourced modules), and on `debian:trixie-slim`
# apt's `git` package hard-Depends on FULL `perl` + `perl-modules` (`apt-cache depends git` shows
# `Depends: perl`, not `Recommends:` — `--no-install-recommends` cannot drop it). A same-day,
# same-vuln-DB scan of that build came back 13 CRITICAL / 43 HIGH / 264 total, MOST of the
# CRITICALs newly introduced by perl/libperl/perl-modules CVEs with no fix yet published
# (CVE-2026-13221, CVE-2026-42496, CVE-2026-8376) — worse on CRITICAL than the 1.8.5 baseline this
# sweep set out to improve (3 CRIT / 55 HIGH / 140 total, same-day scan). Alpine's `git` package is
# built WITHOUT a perl dependency at all (`apk info -a git` on the old 1.8.5 base image lists only
# musl/libcurl/libexpat/libpcre2/libz — no perl anywhere in the chain), so the identical
# bash+git+ca-certificates requirement on `alpine:3.24` (latest stable —
# `skopeo list-tags docker://docker.io/library/alpine`) scanned at 1 CRITICAL / 12 HIGH / 41 total,
# nearly all of it in tofu's OWN vendored Go dependencies (golang.org/x/crypto, x/net, x/mod,
# x/text, grpc — upstream OpenTofu's pins, not anything this Dockerfile controls; identical
# regardless of base distro) rather than the OS layer. Also the smallest image of the three
# measured (187MB vs. 424MB for the Debian build vs. 147MB for the 1.8.5 baseline). Re-run this
# comparison before changing base distros again — `apt`/`apk` dependency shapes for `git`
# specifically are the deciding factor, not general distro reputation.
#
# Packages installed on top of the slim base are exactly what run.sh (see its own doc comment for
# the credential-confinement contract this depends on) needs at runtime: `bash` (run.sh's
# shebang), `git` (module fetch), `ca-certificates` (provider HTTPS — OpenTofu registry + provider
# downloads over TLS). No compilers, no package-manager cache, no extra tooling — every extra byte
# here is extra attack surface in a container that, for the duration of one run, holds real
# (scoped, vaulted) infrastructure credentials. Re-pin the `ghcr.io/opentofu/opentofu:<ver>` tag
# below to the newest 1.x release as new patches ship.
#
# USER stays root (unchanged from the old opentofu-base image, which also defaulted to root):
# `/workspace` is populated by `docker cp` from the host BEFORE the container starts (run.sh's own
# comment — @scp/runner-launcher's `docker create` / `docker cp in` / `docker start` / `docker cp
# out` / `docker rm` contract), and `docker cp`-written files land with whatever ownership the
# copied tar stream carries. Pinning a non-root USER here would risk that copied-in tree (and the
# state-history/plan.json this shim writes back into it) landing UID-mismatched and unwritable —
# a correctness regression, not just a hardening nicety — for a container whose entire lifetime is
# one supervised run. Revisit only alongside a matching change to the launcher's copy-in step.
FROM alpine:3.24

RUN apk add --no-cache bash git ca-certificates

# The upstream OpenTofu image's only contribution here is its statically-linked `tofu` binary.
# `COPY --from` an image reference (unlike `FROM`) does not trigger that image's ONBUILD, so this
# is safe against the 1.10+ base-image block described above.
COPY --from=ghcr.io/opentofu/opentofu:1.12.6 /usr/local/bin/tofu /usr/local/bin/tofu

COPY run.sh /run.sh
RUN chmod +x /run.sh

WORKDIR /workspace
ENTRYPOINT ["/run.sh"]
