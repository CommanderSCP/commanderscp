#!/usr/bin/env bash
# Install THE pinned skopeo — the exact same digest-pinned binary + shared-library closure the
# SCP runtime image vendors (Dockerfile's `skopeo` stage; pin: tools/skopeo/pin.env) — onto the
# current machine, at the runtime image's own layout:
#
#   <prefix>/libexec/skopeo/skopeo      the pinned binary (dynamically linked, Fedora sonames)
#   <prefix>/libexec/skopeo/lib/        its closed shared-library closure + Fedora's ELF loader
#   <prefix>/bin/skopeo                 the checked-in wrapper (tools/skopeo/skopeo-wrapper.sh)
#
# Why this exists (M15.5 c3 — the M17.3 E1 argument, now for skopeo): CI's integration job used
# to take skopeo from apt, which on the Ubuntu 24.04 runner is 1.13.3 — BELOW the documented
# toolchain floor (BUILD_AND_TEST.md §1: 1.16+) and not the 1.22.2 the runtime image vendors.
# That drift broke the retrans-relay suite for real: cosign v3 attaches image signatures under
# the OCI 1.1 referrers-FALLBACK tag (an image index with artifactType children), which skopeo
# 1.13.3 cannot copy with --preserve-digests ("Manifest list must be converted … cannot modify
# it"), so the relay's signature discovery found nothing and correctly fail-closed. CI must
# validate the binary production runs — same reasoning as scripts/install-pinned-cosign.sh.
#
# With the default prefix (/opt/scp) the install lands at VENDORED_SKOPEO_PATH, so
# packages/cosign/src/skopeo-bin.ts resolves it as the VENDORED pin — static known-good flags +
# the fail-closed version assertion — exactly the resolution branch the runtime image takes.
#
# DEVIATION from the cosign installer: cosign's ko-built binary is static, so one `docker cp`
# suffices. Skopeo's is dynamically linked against Fedora sonames the host does not ship, so we
# vendor the binary PLUS its `ldd` closure PLUS Fedora's own ELF loader, and run it through the
# same wrapper the runtime image uses (host glibc is irrelevant to it). The closure is computed
# from the pinned image itself at install time — it cannot drift from the binary's real needs.
#
# Usage: scripts/install-pinned-skopeo.sh [prefix]   (default: /opt/scp)
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../tools/skopeo/pin.env
. "${repo_root}/tools/skopeo/pin.env"

prefix="${1:-/opt/scp}"
libexec_dir="${prefix}/libexec/skopeo"
bin_dir="${prefix}/bin"

sudo_if_needed() {
  if "$@" 2>/dev/null; then return 0; fi
  sudo "$@"
}

echo "installing pinned skopeo ${SKOPEO_PINNED_VERSION} from ${SKOPEO_PINNED_IMAGE} -> ${bin_dir}/skopeo"

cid="$(docker create "${SKOPEO_PINNED_IMAGE}")"
trap 'docker rm -f "${cid}" >/dev/null 2>&1 || true' EXIT

tmp="$(mktemp -d)"
mkdir -p "${tmp}/lib"
docker cp -L "${cid}:${SKOPEO_UPSTREAM_PATH}" "${tmp}/skopeo"
chmod 0755 "${tmp}/skopeo"

# The shared-library closure + ELF loader, computed with the image's own ldd — the same closed
# list the Dockerfile's COPY block pins (each lib's own deps are already in ldd's output; the
# loader line has no "=>"). linux-vdso is kernel-provided, never a file — skip it.
closure="$(docker run --rm --entrypoint /usr/bin/ldd "${SKOPEO_PINNED_IMAGE}" "${SKOPEO_UPSTREAM_PATH}" \
  | awk '/=>/ { print $3 } !/=>/ && $1 ~ /^\// { print $1 }')"
if [ -z "${closure}" ]; then
  echo "FATAL: could not compute the pinned skopeo's library closure from ${SKOPEO_PINNED_IMAGE}" >&2
  exit 1
fi
for lib in ${closure}; do
  # -L: sonames in the image are symlinks into versioned files — vendor the real bytes.
  docker cp -L "${cid}:${lib}" "${tmp}/lib/"
done

# The wrapper is the CHECKED-IN one (tools/skopeo/skopeo-wrapper.sh) — single source of truth for
# how the vendored binary is launched. Its libexec path is rewritten only when a non-default
# prefix asks for a relocated install (with the default /opt/scp prefix this is a no-op).
sed "s|^d=.*|d=${libexec_dir}|" "${repo_root}/tools/skopeo/skopeo-wrapper.sh" > "${tmp}/wrapper"
chmod 0755 "${tmp}/wrapper"

sudo_if_needed mkdir -p "${libexec_dir}/lib" "${bin_dir}"
sudo_if_needed cp "${tmp}/skopeo" "${libexec_dir}/skopeo"
for lib in "${tmp}/lib/"*; do
  sudo_if_needed cp "${lib}" "${libexec_dir}/lib/$(basename "${lib}")"
done
sudo_if_needed cp "${tmp}/wrapper" "${bin_dir}/skopeo"
rm -rf "${tmp}"

# Skopeo refuses to run without a containers policy. The runtime image ships the repo's minimal
# insecureAcceptAnything policy (skopeo is a byte mover; artifact trust is cosign's job — see
# tools/skopeo/README.md "The policy.json choice"). Install it ONLY if the machine has none — an
# operator's existing policy is never overwritten.
if [ ! -f /etc/containers/policy.json ]; then
  sudo_if_needed mkdir -p /etc/containers
  sudo_if_needed cp "${repo_root}/tools/skopeo/policy.json" /etc/containers/policy.json
fi

# Fail closed here too: if the vendored binary does not report the pinned version, this machine
# must not move artifact bytes. Mirrors assertPinnedSkopeoVersion() in
# packages/cosign/src/skopeo-bin.ts (note upstream reports the version WITHOUT a leading `v`).
reported="$("${bin_dir}/skopeo" --version 2>&1 | sed -n 's/^skopeo version[[:space:]]*\([^[:space:]]*\).*/\1/p' | head -n1)"
if [ "${reported}" != "${SKOPEO_PINNED_VERSION}" ]; then
  echo "FATAL: pinned skopeo reported '${reported}', expected '${SKOPEO_PINNED_VERSION}'" >&2
  exit 1
fi
echo "pinned skopeo ${reported} installed at ${bin_dir}/skopeo"
