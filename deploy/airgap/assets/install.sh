#!/usr/bin/env bash
#
# install.sh — CommanderSCP air-gap bundle install/upgrade script (DESIGN.md §16 "Air-gapped
# bundle": "an install/upgrade script that retargets image references to the customer's
# registry"). The SAME script is used for a first install and for every subsequent upgrade —
# there is no separate upgrade artifact (docs/OFFLINE_INSTALL.md explains why).
#
# SECURITY MODEL — read this before running it against anything you care about:
#
#   1. EVERY bundled image and the bundle's CHECKSUMS.txt are cosign-verified against the
#      bundled `cosign.pub`, and the OCI-layout images are independently re-hashed (content-
#      addressed blob filenames must match their own content — see step 1 below), BEFORE this
#      script does anything else. Any failure here aborts immediately (`set -euo pipefail` plus
#      explicit checks) — a tampered bundle is REJECTED, not silently installed. This is the
#      single most adversarially-reviewed property of this whole package; if you are auditing
#      this script, start here.
#   2. Only after (1) passes does this script push images into YOUR registry
#      (`skopeo copy oci:... docker://<registry>/...`) — the one deliberate, documented,
#      operator-controlled network action this bundle ever performs. This script does not manage
#      registry credentials; authenticate to your registry yourself first (`skopeo login
#      <registry>` or equivalent) — see docs/OFFLINE_INSTALL.md.
#   3. Immediately after each push, this script re-resolves the pushed image's digest FROM YOUR
#      REGISTRY (`skopeo inspect --format '{{.Digest}}'`) and aborts if it differs from the
#      digest verified in step 1. A registry push cannot silently substitute a different image
#      without this catching it.
#   4. Helm/compose are driven with the retargeted images pinned by DIGEST
#      (`<registry>/<name>:<version>@sha256:<digest>` — valid Docker/OCI reference syntax: tag
#      AND digest can both be present, and the digest — not the mutable tag — is what the
#      runtime actually resolves and pulls). This means "registry-retarget must not introduce an
#      image-substitution vector" holds even if the tag ever got reused for something else later:
#      what gets deployed is exactly the digest that was verified in step 1 and re-confirmed in
#      step 3, never "whatever the tag currently points at."
#
# No dependency on this project's own Node/pnpm toolchain — this script only needs bash, skopeo,
# cosign, a sha256 tool (sha256sum or shasum, whichever the host has), and helm or docker
# compose, matching BUILD_AND_TEST.md §1's documented prerequisites. `grep`/`sed` are used for
# the small amount of JSON field extraction needed (index.json's manifest digest) instead of a
# JSON parser dependency — deliberately tuned to skopeo's actual (compact, single-line, one-entry)
# `oci:` index.json output shape; see the extract_index_digest() comment below if skopeo's output
# format ever changes shape.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

MODE=helm
NAMESPACE=""
RELEASE_NAME=scp
DRY_RUN=0
REGISTRY=""
INSECURE_REGISTRY=0

usage() {
  cat <<'EOF'
Usage: install.sh --registry <host>/<path> [options]

Required:
  --registry <ref>       Target registry + path prefix, e.g. myregistry.example.com/scp
                          Images are pushed to <registry>/<image-name>:<version>@<digest>.

Options:
  --mode helm|compose     Install mode (default: helm)
  --namespace <ns>        Kubernetes namespace (helm mode only; default: helm's current context default)
  --release-name <name>   Helm release name (helm mode only; default: scp)
  --insecure-registry      Allow plain-HTTP/self-signed-TLS registries (skopeo --dest-tls-verify=false).
                            Only for a registry you control on a trusted network (e.g. an internal
                            air-gapped registry with a self-signed cert, or a local test registry) —
                            never point this at anything reachable by an untrusted network path.
  --dry-run               Verify + retarget-push, but skip the final helm upgrade / compose up
  -h, --help              Show this help

This script must be run from inside an extracted bundle directory (it cds to its own location,
so `./scp-bundle-<version>/install.sh ...` works from anywhere). It never touches the network
except the deliberate `skopeo copy ... docker://<registry>/...` push to YOUR OWN registry.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --registry) REGISTRY="${2:?--registry requires a value}"; shift 2 ;;
    --namespace) NAMESPACE="${2:?--namespace requires a value}"; shift 2 ;;
    --release-name) RELEASE_NAME="${2:?--release-name requires a value}"; shift 2 ;;
    --mode) MODE="${2:?--mode requires a value}"; shift 2 ;;
    --insecure-registry) INSECURE_REGISTRY=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "install.sh: unknown argument '$1'" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ -z "$REGISTRY" ]]; then
  echo "install.sh: --registry is required" >&2
  usage >&2
  exit 2
fi
if [[ "$MODE" != "helm" && "$MODE" != "compose" ]]; then
  echo "install.sh: --mode must be 'helm' or 'compose' (got '$MODE')" >&2
  exit 2
fi

for bin in skopeo cosign; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "install.sh: required tool '$bin' not found on PATH" >&2
    exit 2
  fi
done
if [[ "$MODE" == "helm" ]] && ! command -v helm >/dev/null 2>&1; then
  echo "install.sh: --mode helm requires 'helm' on PATH" >&2
  exit 2
fi
if [[ "$MODE" == "compose" ]] && ! command -v docker >/dev/null 2>&1; then
  echo "install.sh: --mode compose requires 'docker' (with the compose plugin) on PATH" >&2
  exit 2
fi

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

# Extracts the single manifest digest from a skopeo-produced OCI-layout `index.json`
# (`{"schemaVersion":2,...,"manifests":[{"mediaType":"...","digest":"sha256:<hex>",...}]}`) with
# grep/sed rather than a JSON parser — see the file header comment for why.
extract_index_digest() {
  local index_json="$1"
  local digest
  digest="$(grep -o '"digest":"sha256:[a-f0-9]\{64\}"' "$index_json" | head -n1 | sed -E 's/.*"(sha256:[a-f0-9]+)".*/\1/')"
  if [[ -z "$digest" ]]; then
    echo "install.sh: could not extract a manifest digest from $index_json" >&2
    exit 1
  fi
  echo "$digest"
}

verify_blob() {
  local file="$1" sig="$2" out
  # Capture cosign's output rather than discarding it: cosign prints deprecation-flag notices +
  # a tlog-skip warning on every call (even successful ones — see cosign.ts's module comment for
  # why those specific flags are required for air-gap correctness), so success is silenced by
  # default, but a FAILURE's actual reason is shown to stderr — "signature invalid" alone isn't
  # enough for an operator to tell a corrupted bundle apart from e.g. a cosign version mismatch.
  if out="$(cosign verify-blob --key cosign.pub --signature "$sig" --insecure-ignore-tlog=true "$file" 2>&1)"; then
    return 0
  else
    echo "$out" >&2
    return 1
  fi
}

fail() {
  echo "install.sh: FAIL — $*" >&2
  exit 1
}

echo "== step 1/4: verifying bundle signatures (fail-closed — any problem aborts) =="

[[ -f cosign.pub ]] || fail "cosign.pub missing from bundle"
[[ -f CHECKSUMS.txt && -f CHECKSUMS.txt.sig ]] || fail "CHECKSUMS.txt or its signature missing"
verify_blob CHECKSUMS.txt CHECKSUMS.txt.sig || fail "CHECKSUMS.txt signature does not verify against cosign.pub — bundle is not authentic or has been tampered with"

# Recompute every checksum CHECKSUMS.txt lists and compare — this is what actually detects a
# modified/added/removed file; the signature above only proves CHECKSUMS.txt ITSELF is authentic.
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  expected="${line%%  *}"
  relpath="${line#*  }"
  [[ -f "$relpath" ]] || fail "file listed in CHECKSUMS.txt is missing: $relpath"
  actual="$(sha256_of "$relpath")"
  [[ "$expected" == "$actual" ]] || fail "checksum mismatch for $relpath (expected $expected, got $actual)"
done < CHECKSUMS.txt
echo "   CHECKSUMS.txt: OK ($(wc -l < CHECKSUMS.txt | tr -d ' ') files)"

[[ -f manifest.sh ]] || fail "manifest.sh missing from bundle"
# shellcheck disable=SC1091
source manifest.sh

for name in $BUNDLE_IMAGE_NAMES; do
  # printf, not echo: echo appends a trailing newline, which `tr -c 'A-Z0-9' '_'` then converts
  # to a trailing underscore (verified empirically on this machine's BSD tr) — printf with no
  # format-string newline avoids that, matching manifest.ts's shellVarStem() exactly (no
  # trailing separator for a plain name like "scpd"/"postgres-eval").
  stem="$(printf '%s' "$name" | tr '[:lower:]' '[:upper:]' | tr -c 'A-Z0-9' '_')"
  digest_var="${stem}_DIGEST"
  ocipath_var="${stem}_OCI_PATH"
  ocitag_var="${stem}_OCI_TAG"
  digest="${!digest_var:?manifest.sh has no $digest_var}"
  ocipath="${!ocipath_var:?manifest.sh has no $ocipath_var}"
  ocitag="${!ocitag_var:?manifest.sh has no $ocitag_var}"

  # (a) per-image digest file's cosign signature
  verify_blob "images/${name}.digest" "images/${name}.digest.sig" || fail "signature invalid for images/${name}.digest ($name)"
  file_digest="$(cat "images/${name}.digest")"
  [[ "$file_digest" == "$digest" ]] || fail "images/${name}.digest content ($file_digest) does not match manifest.sh ($digest) for $name"

  # (b) the OCI layout's index.json really points at that digest...
  index_digest="$(extract_index_digest "${ocipath}/index.json")"
  [[ "$index_digest" == "$digest" ]] || fail "$ocipath/index.json points at $index_digest, expected $digest (image: $name)"

  # (c) ...and the manifest BLOB it points at really hashes to that digest — catches a swapped
  # image body left under an untouched, validly-signed digest file/index.json.
  hex="${digest#sha256:}"
  blob_path="${ocipath}/blobs/sha256/${hex}"
  [[ -f "$blob_path" ]] || fail "$ocipath has no blob for $digest (expected $blob_path)"
  blob_actual="sha256:$(sha256_of "$blob_path")"
  [[ "$blob_actual" == "$digest" ]] || fail "$ocipath manifest blob content hashes to $blob_actual, expected $digest"

  echo "   $name: OK ($digest)"
done

echo "== all signatures verified — proceeding =="
echo

echo "== step 2/4: pushing images to ${REGISTRY} =="
# Deliberately NOT `declare -A` (associative arrays) — this script targets bash 3.2 (the stock
# `/bin/bash` on macOS, still common on minimal/older Linux install targets too), which predates
# bash 4's associative arrays. Each image's retargeted ref is instead stashed in a
# dynamically-named variable (`printf -v "${stem}_RETARGETED_REF" ...`, bash 3.1+) and read back
# via indirect expansion (`${!varname}`, bash 2.0+) — both supported since well before 3.2.
for name in $BUNDLE_IMAGE_NAMES; do
  # printf, not echo: echo appends a trailing newline, which `tr -c 'A-Z0-9' '_'` then converts
  # to a trailing underscore (verified empirically on this machine's BSD tr) — printf with no
  # format-string newline avoids that, matching manifest.ts's shellVarStem() exactly (no
  # trailing separator for a plain name like "scpd"/"postgres-eval").
  stem="$(printf '%s' "$name" | tr '[:lower:]' '[:upper:]' | tr -c 'A-Z0-9' '_')"
  digest_var="${stem}_DIGEST"
  ocipath_var="${stem}_OCI_PATH"
  ocitag_var="${stem}_OCI_TAG"
  digest="${!digest_var}"
  ocipath="${!ocipath_var}"
  ocitag="${!ocitag_var}"

  dest_ref="${REGISTRY}/${name}:${BUNDLE_VERSION}"
  pinned_ref="${dest_ref}@${digest}"
  printf -v "${stem}_RETARGETED_REF" '%s' "$pinned_ref"

  SKOPEO_TLS_ARGS=()
  if [[ $INSECURE_REGISTRY -eq 1 ]]; then
    SKOPEO_TLS_ARGS=(--dest-tls-verify=false)
  fi

  if [[ $DRY_RUN -eq 1 ]]; then
    echo "   [dry-run] skopeo copy ${SKOPEO_TLS_ARGS[@]+"${SKOPEO_TLS_ARGS[*]}"} oci:${ocipath}:${ocitag} docker://${dest_ref}"
    continue
  fi

  echo "   pushing $name -> ${dest_ref}"
  # "${ARR[@]+"${ARR[@]}"}" not "${ARR[@]}": bash 3.2 (this script's floor — see the
  # `declare -A` comment above) treats expanding an EMPTY array under `set -u` as an unbound-
  # variable error (fixed in bash 4.4+, but 3.2 is still stock `/bin/bash` on macOS and plenty of
  # minimal Linux install targets) — the `+` alternate-value form sidesteps that entirely.
  # Verified interactively against this machine's /bin/bash 3.2.57 during manual testing.
  skopeo copy "${SKOPEO_TLS_ARGS[@]+"${SKOPEO_TLS_ARGS[@]}"}" "oci:${ocipath}:${ocitag}" "docker://${dest_ref}"

  echo "== step 3/4: re-verifying $name in ${REGISTRY} matches the digest verified in step 1 =="
  INSPECT_TLS_ARGS=()
  if [[ $INSECURE_REGISTRY -eq 1 ]]; then
    INSPECT_TLS_ARGS=(--tls-verify=false)
  fi
  pushed_digest="$(skopeo inspect "${INSPECT_TLS_ARGS[@]+"${INSPECT_TLS_ARGS[@]}"}" --format '{{.Digest}}' "docker://${dest_ref}")"
  [[ "$pushed_digest" == "$digest" ]] || fail "pushed $name resolved to $pushed_digest in the registry, expected $digest — refusing to deploy (possible image-substitution during push)"
  echo "   $name: OK — registry digest matches ($pushed_digest)"
done
echo

echo "== step 4/4: deploying (mode: $MODE) =="
if [[ "$MODE" == "helm" ]]; then
  # Built directly from REGISTRY/name/BUNDLE_VERSION/digest — NOT by re-splitting the combined
  # "<registry>/<name>:<version>@<digest>" ref string on ':'. A naive split on the first/last ':'
  # breaks the moment the registry host itself contains a port (e.g. "127.0.0.1:5050",
  # "myregistry.example.com:5000" — both entirely normal registry refs): the port's ':' and the
  # tag's ':' are indistinguishable by position alone without also parsing '/' boundaries. Found
  # by actually running this script against a real `registry:2` on a non-default port during this
  # package's own manual verification — see README.md's "what was actually run" section. Building
  # repository/tag from the known parts instead sidesteps the ambiguity entirely.
  SCPD_REPOSITORY="${REGISTRY}/scpd"
  SCPD_TAG="${BUNDLE_VERSION}@${SCPD_DIGEST}"
  RUNNER_IAC_REF="${SCP_RUNNER_IAC_RETARGETED_REF:-${REGISTRY}/scp-runner-iac:${BUNDLE_VERSION}@${SCP_RUNNER_IAC_DIGEST}}"
  # helm/values.yaml's `commanderscp.image` helper does `printf "%s:%s" repository tag`, so
  # tag="<version>@<digest>" (both a tag AND a digest suffix — valid reference syntax) reproduces
  # exactly this pinned reference without any chart template change.

  HELM_ARGS=(upgrade --install "$RELEASE_NAME" "${SCRIPT_DIR}/helm"
    --set "image.repository=${SCPD_REPOSITORY}"
    --set "image.tag=${SCPD_TAG}"
    --set "managedIac.runnerImage=${RUNNER_IAC_REF}")
  if [[ -n "$NAMESPACE" ]]; then
    HELM_ARGS+=(--namespace "$NAMESPACE" --create-namespace)
  fi

  echo "   KNOWN GAP (see helm/README.md): the eval in-cluster postgres template hardcodes"
  echo "   'image: postgres:16' and is not retargetable via values — if you enable"
  echo "   postgres.evalInCluster.enabled=true in an air-gapped cluster, that image must be"
  echo "   reachable some other way (e.g. mirrored under the same registry with that literal"
  echo "   tag). This bundle still ships the eval postgres image (${POSTGRES_EVAL_RETARGETED_REF:-n/a})"
  echo "   in case you wire that up yourself; install.sh does not do it for you."

  echo "   helm ${HELM_ARGS[*]}"
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "   [dry-run] not running helm upgrade --install"
  else
    helm "${HELM_ARGS[@]}"
  fi
else
  SCPD_REF="${SCPD_RETARGETED_REF:-${REGISTRY}/scpd:${BUNDLE_VERSION}@${SCPD_DIGEST}}"
  POSTGRES_REF="${POSTGRES_EVAL_RETARGETED_REF:-${REGISTRY}/postgres-eval:${BUNDLE_VERSION}@${POSTGRES_EVAL_DIGEST}}"
  OUT_COMPOSE="${SCRIPT_DIR}/compose/docker-compose.retargeted.yml"
  sed \
    -e "s#__SCPD_IMAGE_REF__#${SCPD_REF}#g" \
    -e "s#__POSTGRES_IMAGE_REF__#${POSTGRES_REF}#g" \
    "${SCRIPT_DIR}/compose/docker-compose.airgap.yml" > "$OUT_COMPOSE"
  echo "   wrote $OUT_COMPOSE"
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "   [dry-run] not running docker compose up"
  else
    docker compose -f "$OUT_COMPOSE" up -d
  fi
fi

echo
echo "== done =="
