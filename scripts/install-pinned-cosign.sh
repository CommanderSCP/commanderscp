#!/usr/bin/env bash
# Install THE pinned cosign — the exact same digest-pinned binary the SCP runtime image ships
# (Dockerfile's `cosign` stage) — onto the current machine's PATH.
#
# Why this exists (M17.3 E1): CI used to install cosign with `sigstore/cosign-installer@v3`,
# deliberately UNPINNED. That meant (a) CI validated a different cosign binary than production
# runs, and (b) every CI run reached out to the internet for a tool whose version nobody had
# vetted — awkward against charter principle 5 ("everything, CI included, must run offline").
# Extracting the binary from the pinned image keeps a single vetted artifact across CI and prod.
# The image pull is still a network fetch on a connected CI runner, but it is a DIGEST-pinned,
# content-addressed one that a local registry mirror can serve air-gapped.
#
# Trust-model note: this binary is a RUNTIME signing/verification tool. It is NOT — and must
# never become — the verifier of an air-gap bundle that carries it. `deploy/airgap/assets/install.sh`
# still requires an EXTERNAL cosign on the operator's PATH plus an EXTERNAL `--pubkey`; a bundle
# that verifies itself with material it ships is the self-verification hole an adversarial review
# already caught as CRITICAL. Nothing here changes install.sh.
#
# Usage: scripts/install-pinned-cosign.sh [dest-dir]   (default: /usr/local/bin)
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../tools/cosign/pin.env
. "${repo_root}/tools/cosign/pin.env"

dest_dir="${1:-/usr/local/bin}"
dest="${dest_dir}/cosign"

# WHERE THE PINNED IMAGE IS PULLED FROM (charter principle 5 — see the note above about "the image
# pull is still a network fetch on a connected CI runner"). CI now closes that: it points this at the
# GHCR mirror of EXACTLY `COSIGN_PINNED_IMAGE` (tools/ci-mirror/images.list, mirrored by digest in
# workflow job 4d), because a `docker create` of a `repo@sha256:…` ref cannot be served by a locally
# re-tagged image the way a tag can. The fail-closed `cosign version` assertion at the bottom of this
# script is unchanged and still runs, so the override changes WHERE the bytes come from, never WHICH
# bytes are accepted.
cosign_image="${SCP_COSIGN_IMAGE_REF:-${COSIGN_PINNED_IMAGE}}"

sudo_if_needed() {
  if [ -w "${dest_dir}" ]; then "$@"; else sudo "$@"; fi
}

echo "installing pinned cosign ${COSIGN_PINNED_VERSION} from ${cosign_image} -> ${dest}"

cid="$(docker create "${cosign_image}")"
trap 'docker rm -f "${cid}" >/dev/null 2>&1 || true' EXIT

tmp="$(mktemp -d)"
docker cp "${cid}:${COSIGN_UPSTREAM_PATH}" "${tmp}/cosign"
chmod 0755 "${tmp}/cosign"
sudo_if_needed mkdir -p "${dest_dir}"
sudo_if_needed cp "${tmp}/cosign" "${dest}"
rm -rf "${tmp}"

# Fail closed here too: if the extracted binary does not report the pinned version, this machine
# must not be used to sign or verify anything. Mirrors assertPinnedCosignVersion() in
# deploy/airgap/src/cosign-bin.ts.
reported="$("${dest}" version 2>&1 | sed -n 's/^GitVersion:[[:space:]]*//p' | head -n1)"
if [ "${reported}" != "${COSIGN_PINNED_VERSION}" ]; then
  echo "FATAL: pinned cosign reported '${reported}', expected '${COSIGN_PINNED_VERSION}'" >&2
  exit 1
fi
echo "pinned cosign ${reported} installed at ${dest}"
