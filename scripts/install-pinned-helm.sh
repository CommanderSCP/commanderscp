#!/usr/bin/env bash
# Install THE pinned helm (tools/helm/pin.env) — the binary the scp-stackd image vendors — onto the
# current machine, so CI renders the Standard Stack with exactly what production renders it with
# (M29.4, ADR-0058). Same reasoning as install-pinned-{skopeo,cosign}.sh: a job that validates the
# stack controller against `helm: latest` validates a render production never performs, and the
# controller refuses any helm but the pin, so it would not even start.
#
# Source: the official get.helm.sh release tarball, verified against the sha256 in the pin file
# BEFORE anything is extracted. SCP_HELM_TARBALL_URL points it at a mirror; the checksum is what
# decides which bytes are accepted, never the URL.
#
# Usage: scripts/install-pinned-helm.sh [dest-dir]   (default: /usr/local/bin)
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../tools/helm/pin.env
. "${repo_root}/tools/helm/pin.env"

dest="${1:-/usr/local/bin}"
url="${SCP_HELM_TARBALL_URL:-https://get.helm.sh/helm-${HELM_PINNED_VERSION}-linux-amd64.tar.gz}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo "installing pinned helm ${HELM_PINNED_VERSION} from ${url} -> ${dest}/helm"
curl -fsSL --retry 3 -o "${work}/helm.tgz" "$url"
echo "${HELM_TARBALL_SHA256}  ${work}/helm.tgz" | sha256sum -c -
tar -xzf "${work}/helm.tgz" -C "$work" linux-amd64/helm

if install -m 0755 "${work}/linux-amd64/helm" "${dest}/helm" 2>/dev/null; then :; else
  sudo install -m 0755 "${work}/linux-amd64/helm" "${dest}/helm"
fi

# FAIL-CLOSED: whatever landed must report the pinned version.
got="$("${dest}/helm" version --template '{{.Version}}')"
if [ "$got" != "$HELM_PINNED_VERSION" ]; then
  echo "install-pinned-helm: installed helm reports '${got}', pin is '${HELM_PINNED_VERSION}'" >&2
  exit 1
fi
echo "helm ${got} installed at ${dest}/helm"
