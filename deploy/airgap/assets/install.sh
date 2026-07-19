#!/usr/bin/env bash
#
# install.sh — CommanderSCP air-gap bundle install/upgrade script (DESIGN.md §16 "Air-gapped
# bundle": "an install/upgrade script that retargets image references to the customer's
# registry"). The SAME script is used for a first install and for every subsequent upgrade —
# there is no separate upgrade artifact (docs/OFFLINE_INSTALL.md explains why).
#
# SECURITY MODEL — read this before running it against anything you care about:
#
#   0. Trust root: an EXTERNAL public key YOU supply (`--pubkey <path>` or `SCP_COSIGN_PUBKEY`),
#      obtained out-of-band from this bundle (the project's release page, a prior trusted install,
#      etc.) — NEVER the `cosign.pub` shipped INSIDE the bundle (adversarial review CRITICAL #1:
#      an attacker who substitutes the whole bundle can just re-sign everything with their own key
#      and ship their own `cosign.pub` alongside it — a bundle verifying itself against a key it
#      also ships proves nothing about authenticity, only that the bundle is internally
#      self-consistent). This script REFUSES to run any signature verification without an
#      external key — see the check right after argument parsing below. The bundled `cosign.pub`
#      is shipped for operator convenience only (e.g. comparing it by hand against a known-good
#      value) and is never read by this script as a trust root.
#   1. EVERY bundled image and the bundle's CHECKSUMS.txt are cosign-verified against that
#      EXTERNAL key, and the OCI-layout images are independently re-hashed (content-addressed
#      blob filenames must match their own content — see step 1 below), BEFORE this script does
#      anything else. Any failure here aborts immediately (`set -euo pipefail` plus explicit
#      checks) — a tampered bundle (including a wholesale-resigned one) is REJECTED, not silently
#      installed. This is the single most adversarially-reviewed property of this whole package;
#      if you are auditing this script, start here.
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
PUBKEY="${SCP_COSIGN_PUBKEY:-}"

usage() {
  cat <<'EOF'
Usage: install.sh --registry <host>/<path> --pubkey <path> [options]

Required:
  --registry <ref>       Target registry + path prefix, e.g. myregistry.example.com/scp
                          Images are pushed to <registry>/<image-name>:<version>@<digest>.
  --pubkey <path>         EXTERNAL cosign public key to verify this bundle against — obtained
                          out-of-band from the bundle itself (project release page, a prior
                          trusted install, etc.), NEVER the `cosign.pub` shipped inside the
                          bundle (that proves nothing: an attacker who substitutes the whole
                          bundle can resign it and ship their own key alongside it). May also be
                          set via the SCP_COSIGN_PUBKEY environment variable.

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
    --pubkey) PUBKEY="${2:?--pubkey requires a value}"; shift 2 ;;
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
# CRITICAL #1 fix (adversarial review of PR #15): fail closed rather than fall back to the
# in-bundle `cosign.pub` — see the SECURITY MODEL header comment (step 0) for why that fallback
# would defeat code-signing entirely (a substituted bundle can ship its own matching key).
if [[ -z "$PUBKEY" ]]; then
  echo "install.sh: FAIL — no external public key supplied." >&2
  echo "  Pass --pubkey <path> (or set SCP_COSIGN_PUBKEY) pointing at a cosign public key you" >&2
  echo "  obtained OUT-OF-BAND from this bundle (the project's release page, a prior trusted" >&2
  echo "  install, etc.) — never the cosign.pub shipped inside this bundle. This script refuses" >&2
  echo "  to verify a bundle's signature against a key that same bundle also ships; that key" >&2
  echo "  proves nothing about authenticity." >&2
  exit 2
fi
if [[ ! -f "$PUBKEY" ]]; then
  echo "install.sh: FAIL — --pubkey/SCP_COSIGN_PUBKEY points at a file that does not exist: $PUBKEY" >&2
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
  # `--key "$PUBKEY"` — the EXTERNAL, operator-supplied key validated above, NEVER the in-bundle
  # `cosign.pub` (CRITICAL #1 fix — see the SECURITY MODEL header comment).
  if out="$(cosign verify-blob --key "$PUBKEY" --signature "$sig" --insecure-ignore-tlog=true "$file" 2>&1)"; then
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

echo "== step 1/4: verifying bundle signatures against the EXTERNAL --pubkey (fail-closed — any problem aborts) =="
echo "   trust root: $PUBKEY"

# The in-bundle cosign.pub is NOT checked/used here at all — see the SECURITY MODEL header
# comment (step 0). It is shipped purely for operator convenience (e.g. eyeballing it against a
# known-good value); trusting it as this script's own verification key is exactly the
# self-referential hole CRITICAL #1 closed.
[[ -f CHECKSUMS.txt && -f CHECKSUMS.txt.sig ]] || fail "CHECKSUMS.txt or its signature missing"
verify_blob CHECKSUMS.txt CHECKSUMS.txt.sig || fail "CHECKSUMS.txt signature does not verify against --pubkey ($PUBKEY) — bundle is not authentic or has been tampered with"

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
  # Bundled executor backends (Mode B) are delivered SEPARATELY from the SCP release — via the
  # deploy/helm-bundled chart + scp-bundled.sh, applied AFTER the SCP install below — NOT the main
  # chart: their vendored manifests exceed Helm's 1 MB release-Secret limit (packaging them into the
  # SCP release breaks `helm install` outright). Here we only record which backends THIS bundle
  # carries and each one's retargeted, digest-pinned image --set args (values-driven, never a
  # hardcoded template ref — avoiding the eval-postgres air-gap trap noted below).
  BUNDLED_APPLY=()
  BUNDLED_SET_ARGOCD=(); BUNDLED_SET_WORKFLOWS=(); BUNDLED_SET_EVENTS=(); BUNDLED_SET_GITEA=()
  if [[ -n "${ARGOCD_DIGEST:-}" ]]; then
    BUNDLED_SET_ARGOCD=(--set "bundledExecutor.argocd.image=${ARGOCD_RETARGETED_REF:-${REGISTRY}/argocd:${BUNDLE_VERSION}@${ARGOCD_DIGEST}}"
      --set "bundledExecutor.argocd.valkeyImage=${VALKEY_RETARGETED_REF:-${REGISTRY}/valkey:${BUNDLE_VERSION}@${VALKEY_DIGEST}}")
    BUNDLED_APPLY+=(argocd)
  fi
  if [[ -n "${ARGO_WORKFLOWS_CLI_DIGEST:-}" ]]; then
    BUNDLED_SET_WORKFLOWS=(--set "bundledExecutor.argoWorkflows.serverImage=${ARGO_WORKFLOWS_CLI_RETARGETED_REF:-${REGISTRY}/argo-workflows-cli:${BUNDLE_VERSION}@${ARGO_WORKFLOWS_CLI_DIGEST}}"
      --set "bundledExecutor.argoWorkflows.controllerImage=${ARGO_WORKFLOWS_CONTROLLER_RETARGETED_REF:-${REGISTRY}/argo-workflows-controller:${BUNDLE_VERSION}@${ARGO_WORKFLOWS_CONTROLLER_DIGEST}}")
    BUNDLED_APPLY+=(argo-workflows)
  fi
  if [[ -n "${ARGO_EVENTS_DIGEST:-}" ]]; then
    BUNDLED_SET_EVENTS=(--set "bundledExecutor.argoEvents.image=${ARGO_EVENTS_RETARGETED_REF:-${REGISTRY}/argo-events:${BUNDLE_VERSION}@${ARGO_EVENTS_DIGEST}}")
    BUNDLED_APPLY+=(argo-events)
  fi
  if [[ -n "${GITEA_DIGEST:-}" ]]; then
    # Single image — Gitea runs self-contained on SQLite (see build-bundle.ts). Digest-pinned like
    # every other bundled image.
    BUNDLED_SET_GITEA=(--set "bundledExecutor.gitea.image=${GITEA_RETARGETED_REF:-${REGISTRY}/gitea:${BUNDLE_VERSION}@${GITEA_DIGEST}}")
    BUNDLED_APPLY+=(gitea)
  fi
  # NOTE: Harbor is REMOVED from the bundled stack (Gitea is the default registry, ADR-0012); an
  # existing Harbor is served via the import path (coordinated as an execution system), not bundled.
  if [[ -n "$NAMESPACE" ]]; then
    HELM_ARGS+=(--namespace "$NAMESPACE" --create-namespace)
  fi
  # Optional operator pass-through: any extra `helm --set` values (space-separated
  # key=value pairs) via SCP_EXTRA_HELM_SET — e.g. enabling the eval in-cluster postgres, an
  # ingress host, a serviceMonitor, or a real external-postgres existingSecret. Purely additive;
  # unset by default, so this changes nothing for callers that don't use it. Deliberately kept out
  # of the retarget/verify path — these are plain chart values, not image references.
  if [[ -n "${SCP_EXTRA_HELM_SET:-}" ]]; then
    for kv in ${SCP_EXTRA_HELM_SET}; do
      HELM_ARGS+=(--set "$kv")
    done
  fi

  echo "   KNOWN GAP (see helm/README.md): the eval in-cluster postgres template hardcodes"
  echo "   'image: postgres:16' and is not retargetable via values — if you enable"
  echo "   postgres.evalInCluster.enabled=true in an air-gapped cluster, that image must be"
  echo "   reachable some other way (e.g. mirrored under the same registry with that literal"
  echo "   tag). This bundle still ships the eval postgres image (${POSTGRES_EVAL_RETARGETED_REF:-n/a})"
  echo "   in case you wire that up yourself; install.sh does not do it for you."

  echo "   helm ${HELM_ARGS[*]}"
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "   [dry-run] not running helm upgrade --install (bundled backends this bundle would enable: ${#BUNDLED_APPLY[@]})"
  else
    helm "${HELM_ARGS[@]}"
    # Apply each bundled backend THIS bundle carries, via the one-command wrapper: deploy/helm-bundled
    # rendered + `kubectl apply --server-side` (the vendored manifests exceed Helm's 1 MB release-
    # Secret limit, so they are NEVER part of the SCP release), and for argocd the wrapper also
    # flips the SCP release's auto-wire hook + NetworkPolicy. This deploys the Standard Stack the only
    # way that fits under Kubernetes' Secret limit.
    NS_ARGS=(); [[ -n "$NAMESPACE" ]] && NS_ARGS=(--scp-namespace "$NAMESPACE")
    for be in ${BUNDLED_APPLY[@]+"${BUNDLED_APPLY[@]}"}; do
      echo "   == enabling bundled backend: ${be} =="
      BSET=()
      case "$be" in
        argocd)         BSET=(${BUNDLED_SET_ARGOCD[@]+"${BUNDLED_SET_ARGOCD[@]}"}) ;;
        argo-workflows) BSET=(${BUNDLED_SET_WORKFLOWS[@]+"${BUNDLED_SET_WORKFLOWS[@]}"}) ;;
        argo-events)    BSET=(${BUNDLED_SET_EVENTS[@]+"${BUNDLED_SET_EVENTS[@]}"}) ;;
        gitea)          BSET=(${BUNDLED_SET_GITEA[@]+"${BUNDLED_SET_GITEA[@]}"}) ;;
      esac
      bash "${SCRIPT_DIR}/scp-bundled.sh" enable "$be" \
        --chart "${SCRIPT_DIR}/helm-bundled" --scp-chart "${SCRIPT_DIR}/helm" \
        --scp-release "$RELEASE_NAME" \
        ${NS_ARGS[@]+"${NS_ARGS[@]}"} ${BSET[@]+"${BSET[@]}"}
    done
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
