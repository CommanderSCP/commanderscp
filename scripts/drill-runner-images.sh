#!/usr/bin/env bash
# Shared by scripts/airgap-drill.sh and scripts/ansible-drill.sh — SOURCED, never executed.
#
# WHY THIS FILE EXISTS. `build-bundle` copies every image in its canonical list
# (deploy/airgap/src/bundle-images.ts) from the LOCAL DOCKER DAEMON, so each drill has to make sure
# a source image exists under each runner name before it builds a bundle. Both drills need the
# identical preparation, and until M21.7 both had their own copy of it — which is precisely the
# restated-list shape that let `scp-runner-scan` and `scp-runner-dep` go unbundled for two
# releases. One copy, so the next runner is added in one place.
#
# Sets BUNDLE_RUNNER_ARGS (an array of `--runner-*-ref` flags) for the caller to splat into its
# `node deploy/airgap/dist/build-bundle.js` invocation.
#
# ---------------------------------------------------------------------------------------------
# THE STAND-IN FOR scp-runner-scan, AND WHY IT IS NOT A CHEAT
# ---------------------------------------------------------------------------------------------
# `scp-runner-iac` and `scp-runner-dep` are BUILT here, for real: both are small and both build
# from a pinned base with no package installs (see their Dockerfiles), so the drill exercises the
# genuine artifact at negligible cost.
#
# `scp-runner-scan` is not. It is a Fedora base carrying `oscap` + the SSG datastreams + `trivy` +
# a baked vulnerability DB — GB-scale, and its build DNF-installs from a Fedora repo. The drills
# already run under a "Reclaim disk" step because the hosted runner's ~14 GB is the binding
# constraint (see .github/workflows/deploy-drills.yml's DISK note), and the bundle would hold it
# three times over (OCI layout + tarball + local registry).
#
# What these drills actually exercise for an image is CONTENT-AGNOSTIC: cosign-sign the digest,
# verify it, re-hash the OCI layout, `skopeo copy` into the stand-in customer registry, re-resolve
# the pushed digest, and pin the deployment to it. None of that reads a byte of the scanner. So the
# default is a tiny stand-in under a name that says so — `scp-runner-scan-drill-standin` is what
# lands in manifest.json's `sourceRef`, so a drill log can never be mistaken for evidence that the
# real scanner image was bundled. Set AIRGAP_DRILL_RUNNER_SCAN_REF / ANSIBLE_DRILL_RUNNER_SCAN_REF
# to a real `scp-runner-scan` image for a full-fidelity run.
#
# THE SAME, FOR scp-builder-rpm. An AlmaLinux 9 base that dnf-installs rpmbuild — a network fetch
# from an EL mirror at build time, and nothing the drills read: the bundle only signs, copies and
# pins it. So it gets the same named stand-in (`scp-builder-rpm-drill-standin`); set
# BUILDER_RPM_REF to a real image for a full-fidelity run.
#
# EVERY IMAGE THE BUNDLE COPIES FROM THE LOCAL DAEMON IS PREPARED HERE (or passed by the drill
# itself: scpd, postgres) — deploy/airgap `drill-images.test.ts` reads this file against the
# canonical list, so the next daemon-sourced image cannot be missed the way scp-runner-ops and
# scp-builder-rpm were (review of #421: neither was ever built nor passed, so `build-bundle` looked
# for `:dev` tags that no drill had made).
#
# Callers set these first (any may be empty -> defaulted here):
#   RUNNER_IAC_REF, RUNNER_SCAN_REF, RUNNER_DEP_REF, RUNNER_DEP_VENDOR_REF, RUNNER_OPS_REF,
#   STACKD_REF, BUILDER_RPM_REF

# Tag the drill stand-in carries. Deliberately NOT `scp-runner-scan:dev` — a stand-in must never be
# addressable by the name of the thing it stands in for.
DRILL_SCAN_STANDIN_TAG="scp-runner-scan-drill-standin:dev"
DRILL_BUILDER_RPM_STANDIN_TAG="scp-builder-rpm-drill-standin:dev"

ensure_runner_source_images() {
  RUNNER_IAC_REF="${RUNNER_IAC_REF:-scp-runner-iac:dev}"
  RUNNER_DEP_REF="${RUNNER_DEP_REF:-scp-runner-dep:dev}"

  echo "==> ensuring a local source image for each bundled managed-execution runner"

  docker image inspect "$RUNNER_IAC_REF" >/dev/null 2>&1 ||
    docker build -t "$RUNNER_IAC_REF" apps/runner-iac

  # scp-runner-dep: `scratch` + one pinned BusyBox layer, no RUN that installs anything.
  docker image inspect "$RUNNER_DEP_REF" >/dev/null 2>&1 ||
    docker build -t "$RUNNER_DEP_REF" apps/runner-dep

  if [ -z "${RUNNER_SCAN_REF:-}" ]; then
    RUNNER_SCAN_REF="$DRILL_SCAN_STANDIN_TAG"
    echo "    scp-runner-scan: using the drill STAND-IN ($RUNNER_SCAN_REF) — see" \
      "scripts/drill-runner-images.sh for why; override with *_DRILL_RUNNER_SCAN_REF"
    if ! docker image inspect "$RUNNER_SCAN_REF" >/dev/null 2>&1; then
      # The same digest-pinned BusyBox apps/runner-dep is built from — already vendored, already
      # content-addressed, and nothing else needs pulling.
      # shellcheck disable=SC1091
      . tools/busybox/pin.env
      docker pull "$BUSYBOX_PINNED_IMAGE"
      docker tag "$BUSYBOX_PINNED_IMAGE" "$RUNNER_SCAN_REF"
    fi
  else
    docker image inspect "$RUNNER_SCAN_REF" >/dev/null 2>&1 || {
      echo "runner-scan image '$RUNNER_SCAN_REF' not found locally (no auto-build: see this file)" >&2
      return 1
    }
  fi

  # scp-runner-ops (M27.1): a pinned python-alpine base plus a pinned ansible-core and the vendored
  # catalog — small, so built for real.
  RUNNER_OPS_REF="${RUNNER_OPS_REF:-scp-runner-ops:dev}"
  docker image inspect "$RUNNER_OPS_REF" >/dev/null 2>&1 ||
    docker build -t "$RUNNER_OPS_REF" apps/runner-ops

  if [ -z "${BUILDER_RPM_REF:-}" ]; then
    BUILDER_RPM_REF="$DRILL_BUILDER_RPM_STANDIN_TAG"
    echo "    scp-builder-rpm: using the drill STAND-IN ($BUILDER_RPM_REF) — see" \
      "scripts/drill-runner-images.sh for why; override with BUILDER_RPM_REF"
    if ! docker image inspect "$BUILDER_RPM_REF" >/dev/null 2>&1; then
      # shellcheck disable=SC1091
      . tools/busybox/pin.env
      docker pull "$BUSYBOX_PINNED_IMAGE"
      docker tag "$BUSYBOX_PINNED_IMAGE" "$BUILDER_RPM_REF"
    fi
  else
    docker image inspect "$BUILDER_RPM_REF" >/dev/null 2>&1 || {
      echo "builder-rpm image '$BUILDER_RPM_REF' not found locally" >&2
      return 1
    }
  fi

  # scp-stackd (M29.4): the Standard Stack controller, built for real — a bundled Node file on the
  # pinned Node base plus the pinned helm. Built from the REPO ROOT (it bundles workspace packages).
  STACKD_REF="${STACKD_REF:-scp-stackd:dev}"
  docker image inspect "$STACKD_REF" >/dev/null 2>&1 ||
    docker build -f apps/stackd/Dockerfile -t "$STACKD_REF" .

  # scp-runner-dep-vendor (M29.8a): the credential-free, `--network none`-at-RUN-time re-vendor
  # sandbox, built for real — same shape as scp-stackd (a bundled Node app plus the pinned helm),
  # and the same REPO-ROOT-context deviation its own Dockerfile documents.
  RUNNER_DEP_VENDOR_REF="${RUNNER_DEP_VENDOR_REF:-scp-runner-dep-vendor:dev}"
  docker image inspect "$RUNNER_DEP_VENDOR_REF" >/dev/null 2>&1 ||
    docker build -f apps/runner-dep-vendor/Dockerfile -t "$RUNNER_DEP_VENDOR_REF" .

  BUNDLE_RUNNER_ARGS=(
    --runner-iac-ref "$RUNNER_IAC_REF"
    --runner-scan-ref "$RUNNER_SCAN_REF"
    --runner-dep-ref "$RUNNER_DEP_REF"
    --runner-dep-vendor-ref "$RUNNER_DEP_VENDOR_REF"
    --runner-ops-ref "$RUNNER_OPS_REF"
    --stackd-ref "$STACKD_REF"
    --builder-rpm-ref "$BUILDER_RPM_REF"
  )
}
