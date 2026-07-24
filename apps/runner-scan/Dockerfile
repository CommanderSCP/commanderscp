# syntax=docker/dockerfile:1.7
#
# scp-runner-scan — the SEPARATE image the `scp-managed-scan` promotion scan step launches per scan
# (ADR-0020 §1, charter's Managed Execution Exception 2026-07-23 amendment, proposal §13.3). It
# mirrors apps/runner-iac EXACTLY in shape: a pinned scanner toolchain + a minimal run shim, NOTHING
# else. No Node app code lives here (docs/DESIGN.md §3) — `packages/plugins/managed-scan` is the thin
# ORCHESTRATOR (launches this image as an ephemeral, single-shot `--network none` container per scan);
# this image is the ISOLATED TOOLCHAIN it launches. The scpd image (root Dockerfile) carries no
# scanner at all — this is the ONLY place `trivy` and `oscap` exist in the whole system, exactly as
# `tofu` exists only in scp-runner-iac (apps/runner-iac/README.md).
#
# `docker build -t scp-runner-scan:dev apps/runner-scan` is the only build command for this image.
#
# TWO SCANNERS, TWO SUPPLY CHAINS (M13.3b part 1 — OpenSCAP the second managed-scan method):
#   - Trivy   — vendored from Trivy's OWN official image (digest-pinned via tools/trivy/pin.env). We
#               do NOT `FROM` it anymore (that made this image Alpine, and `oscap` on Alpine is an ldd
#               nightmare — the SSG/OVAL probe binaries are glibc). Instead we COPY the static `trivy`
#               binary + the build-time-baked vulnerability DB OUT of a pinned Trivy stage into the
#               final image — the same "copy the vetted binary out of an image that is never executed"
#               discipline tools/cosign + tools/skopeo already use.
#   - OpenSCAP — the FINAL base is a digest-pinned Fedora image (tools/openscap/pin.env) onto which
#               `oscap` (openscap-scanner) + the SCAP Security Guide datastreams (scap-security-guide)
#               are installed at BUILD time FROM THE FROZEN GA RELEASE REPO ONLY (not the rolling
#               `updates` repo) at the pinned, fail-closed-asserted version. SCAP content lands at
#               /usr/share/xml/scap/ssg/content/ (ssg-<os>-ds.xml — e.g. ssg-debian11-ds.xml,
#               ssg-ol8-ds.xml, ssg-fedora-ds.xml).
#
# OFFLINE AT RUNTIME (charter principle 5): both scanners' data is pre-loaded at BUILD time (the one
# place network is used — the same place cosign/skopeo/trivy-DB are vendored). At RUNTIME the runner is
# launched `--network none`: run.sh passes `--skip-db-update --offline-scan` to Trivy, and `oscap`
# evaluates a LOCAL datastream against a LOCALLY-extracted rootfs (OSCAP_PROBE_ROOT) — neither phones
# home. (Cross-air-gap TRANSPORT of the baked Trivy DB / SCAP content onto a disconnected commander —
# the `type: "blob"` channel + refresh runbook — is increment 13.3b PART 2; this increment keeps the
# build-time bake, so a disconnected build host needs a local mirror of the fedora + trivy sources.)
#
# CONTENT-ADDRESSED, NOT FLOATING (this is the whole point — mirrors the trivy/cosign/skopeo pin
# discipline). `oscap` + SSG are installed ONLY from the FROZEN Fedora GA release repo
# (`--disablerepo=* --enablerepo=fedora`), an immutable snapshot Fedora never republishes into — NOT
# the rolling `updates`/`updates-testing` repos (which is what made the exact tool version float at
# build time). So the running oscap + the SSG datastreams are reproducible from the pin: the base is
# digest-pinned AND its GA release tree is frozen, and the build ASSERTS the exact version fail-closed
# (`oscap --version | grep -qF "(oscap) ${OPENSCAP_PINNED_VERSION}"` — the build FAILS LOUDLY on any
# drift from tools/openscap/pin.env's OPENSCAP_PINNED_VERSION, never merely that oscap "runs"). The
# drift test (packages/plugins/managed-scan/src/pin.test.ts) enforces that the pinned version + the
# fail-closed assertion + the no-floating repo scoping all stay in the Dockerfile.

# Both base-image pins are declared as GLOBAL build args BEFORE the first FROM — a build arg used in a
# `FROM` must precede the first stage (an ARG declared inside a stage is blank at the next FROM). The
# drift test (packages/plugins/managed-scan/src/pin.test.ts) asserts each default matches its pin.env
# byte-for-byte:
#   TRIVY_IMAGE    — tools/trivy/pin.env    TRIVY_PINNED_IMAGE    (multi-arch index digest; see that file)
#   OPENSCAP_IMAGE — tools/openscap/pin.env OPENSCAP_PINNED_IMAGE (fedora multi-arch index digest)
ARG TRIVY_IMAGE=aquasec/trivy@sha256:ab70a02200597efa04748f210f793936eb647cbcdb0ea69cc30b226d6f5a22c7
ARG OPENSCAP_IMAGE=fedora@sha256:f1a3fab47bcb3c3ddf3135d5ee7ba8b7b25f2e809a47440936212a3a50957f3d

# ---------------------------------------------------------------------------------------------------
# STAGE 1 — Trivy: bake the vulnerability DB, then hand the static binary + DB to the final stage.
# This stage is NEVER executed as the runner; only COPY'd out of.
# ---------------------------------------------------------------------------------------------------
FROM ${TRIVY_IMAGE} AS trivy

# Pre-load the vulnerability DB into a KNOWN cache dir (not $HOME/.cache) so the COPY into the final
# stage is a fixed path. `trivy version` right after fails the build loudly if the pinned binary is broken.
RUN trivy --cache-dir /trivy-cache image --download-db-only && trivy version

# ---------------------------------------------------------------------------------------------------
# STAGE 2 (FINAL) — OpenSCAP: a digest-pinned Fedora carrying oscap + SSG content, plus the copied-in
# Trivy binary + baked DB.
# ---------------------------------------------------------------------------------------------------
FROM ${OPENSCAP_IMAGE}

# The exact oscap version this image is PINNED to (tools/openscap/pin.env OPENSCAP_PINNED_VERSION).
# Re-declared here inside the final stage so the RUN below can read it (a global ARG is only in scope
# for FROM lines). The drift test asserts this default matches pin.env byte-for-byte.
ARG OPENSCAP_PINNED_VERSION=1.4.0

# oscap (openscap-scanner) + the SCAP Security Guide datastreams, plus jq/tar for extracting the
# docker-cp'd OCI layout into a rootfs (run.sh). `--setopt=install_weak_deps=False` keeps the image
# lean (every extra byte is attack surface in a container the promotion scan step launches per
# artifact).
#
# NO FLOATING INSTALL: `--disablerepo=* --enablerepo=fedora` installs ONLY from the FROZEN Fedora GA
# release repo — an immutable snapshot, NOT the rolling `updates` repo — so the oscap + SSG versions
# are reproducible from the pinned base's frozen release tree (see the header comment). FAIL-CLOSED
# VERSION ASSERTION: `oscap --version | grep -qF "(oscap) ${OPENSCAP_PINNED_VERSION}"` FAILS THE
# BUILD LOUDLY unless the running oscap is EXACTLY the pinned version (not merely "runs") — the same
# content-addressed discipline the Trivy/cosign/skopeo pins already enforce.
RUN dnf install -y --setopt=install_weak_deps=False --disablerepo="*" --enablerepo=fedora \
      openscap-scanner scap-security-guide jq tar gzip \
  && oscap --version | grep -qF "(oscap) ${OPENSCAP_PINNED_VERSION}" \
  && ls /usr/share/xml/scap/ssg/content/ssg-fedora-ds.xml \
  && dnf clean all

# Trivy: the static binary + the build-time-baked DB, copied OUT of the pinned Trivy stage. Trivy's
# default cache dir is $HOME/.cache/trivy (HOME=/root here), so the DB lands where `trivy image
# --input --skip-db-update` finds it with no --cache-dir flag. `trivy version` confirms the static
# binary runs on the glibc (Fedora) base — fails the build loudly if it does not.
COPY --from=trivy /usr/local/bin/trivy /usr/local/bin/trivy
COPY --from=trivy /trivy-cache /root/.cache/trivy
RUN trivy version && { trivy --cache-dir /root/.cache/trivy image --download-db-only --skip-db-update >/dev/null 2>&1 || true; }

# The scanners are provided above; add only the run shim on top. No further package-manager calls.
COPY run.sh /run.sh
RUN chmod +x /run.sh

WORKDIR /work
ENTRYPOINT ["/run.sh"]
