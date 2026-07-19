#!/usr/bin/env bash
# scp-bundled — enable a CommanderSCP Standard Stack backend in ONE command.
#
# The bundled executor backends (Argo CD + Valkey, Argo Workflows, Argo Events, Gitea) live in the
# `deploy/helm-bundled` chart, NOT the main `commanderscp` chart: their vendored upstream manifests
# (Argo Workflows alone is 11 MB) far exceed Helm's 1 MB release-Secret limit, so they cannot ride a
# `helm install`. This wrapper renders the chart and delivers it the way upstream intends — with
# `kubectl apply --server-side` (no stored release ⇒ no 1 MB ceiling; server-side ⇒ the large CRDs
# don't overflow the client-side last-applied annotation) — then, for Argo CD / Gitea, flips the
# matching flag on the main SCP release so its auto-wire hook + NetworkPolicy egress turn on. All of
# that is hidden behind a single verb:
#
#     scripts/scp-bundled.sh enable argocd
#     scripts/scp-bundled.sh enable gitea --scp-release scp --scp-namespace scp
#     scripts/scp-bundled.sh enable argo-workflows --set bundledExecutor.argoWorkflows.serverImage=myreg/argocli:v4.0.7 ...
#     scripts/scp-bundled.sh render gitea   # print the manifest, apply nothing
#
# NOTE: Harbor is REMOVED from the bundled stack (Gitea is the default registry, ADR-0012); an
# existing Harbor is served via the import path (coordinated as an execution system), not bundled.
#
# Connected installs need zero image flags (the chart defaults to the upstream refs). The air-gap
# install.sh calls this with --set/--values carrying the retargeted, digest-pinned images.
#
# Requires: helm, kubectl. Does NOT require the SCP release to be Helm-managed — if it isn't (e.g.
# GitOps/ArgoCD-managed), the backend is still applied and the wrapper prints the one flag to set in
# your SCP values instead of running `helm upgrade`.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHART_DIR="${SCP_BUNDLED_CHART_DIR:-${ROOT_DIR}/deploy/helm-bundled}"
SCP_CHART_DIR="${SCP_MAIN_CHART_DIR:-${ROOT_DIR}/deploy/helm}"
SCP_RELEASE="scp"
SCP_NAMESPACE="default"
WAIT_TIMEOUT="600s"
DRY_RUN=0
declare -a HELM_EXTRA=()

usage() {
  cat >&2 <<EOF
Usage: scp-bundled.sh <enable|render> <argocd|argo-workflows|argo-events|gitea> [options]

  enable   render the backend, kubectl apply --server-side, wait for readiness, and (argocd/gitea)
           turn on the SCP release's auto-wire hook + NetworkPolicy
  render   print the rendered manifest to stdout and exit (apply nothing)

Options:
  --scp-release <name>     SCP Helm release name (default: scp)
  --scp-namespace <ns>     namespace of the SCP release + its bundled-backend NetworkPolicy (default: default)
  --values <file>          extra Helm values file (repeatable) — e.g. air-gap retargeted images
  --set <key=value>        extra Helm --set (repeatable) — e.g. a retargeted image ref
  --wait-timeout <dur>     readiness wait per backend (default: 600s)
  --chart <dir>            bundled chart dir (default: deploy/helm-bundled)
  --scp-chart <dir>        main SCP chart dir for the hook/NetworkPolicy upgrade (default: deploy/helm)
  --dry-run                same as 'render' — print, apply nothing
EOF
  exit "${1:-2}"
}

# Progress goes to STDERR — STDOUT is reserved for the rendered manifest (the `render` verb prints
# it, and even in `enable` mode keeping STDOUT clean means `scp-bundled.sh render X | kubectl ...`
# and future pipes never ingest a progress line.
log() { echo "==> $*" >&2; }
fail() { echo "scp-bundled: $*" >&2; exit 1; }

[ $# -ge 2 ] || usage 2
VERB="$1"; BACKEND="$2"; shift 2
case "$VERB" in enable|render) : ;; *) usage 2 ;; esac
[ "$VERB" = "render" ] && DRY_RUN=1

# backend name -> (values key, namespace, main-chart flag it flips on the SCP release or "")
case "$BACKEND" in
  argocd)         KEY="argocd";        NS="scp-argocd";         SCP_FLAG="bundledExecutor.argocd.enabled" ;;
  argo-workflows) KEY="argoWorkflows"; NS="scp-argo-workflows"; SCP_FLAG="" ;;
  argo-events)    KEY="argoEvents";    NS="scp-argo-events";    SCP_FLAG="" ;;
  gitea)          KEY="gitea";         NS="scp-gitea";          SCP_FLAG="bundledExecutor.gitea.enabled" ;;
  *) echo "scp-bundled: unknown backend '$BACKEND'" >&2; usage 2 ;;
esac

while [ $# -gt 0 ]; do
  case "$1" in
    --scp-release)   SCP_RELEASE="$2"; shift 2 ;;
    --scp-namespace) SCP_NAMESPACE="$2"; shift 2 ;;
    --wait-timeout)  WAIT_TIMEOUT="$2"; shift 2 ;;
    --chart)         CHART_DIR="$2"; shift 2 ;;
    --scp-chart)     SCP_CHART_DIR="$2"; shift 2 ;;
    --values)        HELM_EXTRA+=(--values "$2"); shift 2 ;;
    --set)           HELM_EXTRA+=(--set "$2"); shift 2 ;;
    --dry-run)       DRY_RUN=1; shift ;;
    -h|--help)       usage 0 ;;
    *) echo "scp-bundled: unknown option '$1'" >&2; usage 2 ;;
  esac
done

command -v helm >/dev/null 2>&1 || fail "helm not found on PATH"
command -v kubectl >/dev/null 2>&1 || fail "kubectl not found on PATH"
[ -f "${CHART_DIR}/Chart.yaml" ] || fail "bundled chart not found at ${CHART_DIR} (pass --chart)"

# ---- 1. Render just this backend from the bundled chart --------------------------------------
log "rendering ${BACKEND} from ${CHART_DIR}"
MANIFEST="$(helm template scp-bundled "$CHART_DIR" \
  --set "bundledExecutor.${KEY}.enabled=true" \
  ${HELM_EXTRA[@]+"${HELM_EXTRA[@]}"})"
[ -n "$MANIFEST" ] || fail "render produced an empty manifest for '${BACKEND}' — is the backend name correct?"

if [ "$DRY_RUN" -eq 1 ]; then
  printf '%s\n' "$MANIFEST"
  exit 0
fi

# ---- 2. Apply server-side (required: large CRDs overflow client-side apply's annotation) -----
log "applying ${BACKEND} to the cluster (kubectl apply --server-side) → namespace ${NS}"
printf '%s\n' "$MANIFEST" | kubectl apply --server-side --force-conflicts -f -

# ---- 3. Wait for the backend's workloads to become ready ------------------------------------
log "waiting for ${BACKEND} workloads in ${NS} to become ready (timeout ${WAIT_TIMEOUT})"
kubectl rollout status --namespace "$NS" --timeout "$WAIT_TIMEOUT" \
  $(kubectl get deploy,statefulset -n "$NS" -o name 2>/dev/null) 2>/dev/null || {
    echo "scp-bundled: WARNING — not all ${BACKEND} workloads reported ready within ${WAIT_TIMEOUT}; check: kubectl get pods -n ${NS}" >&2
  }

# ---- 4. For argocd: flip the flag on the SCP release (auto-wire hook + NetworkPolicy) --
if [ -n "$SCP_FLAG" ]; then
  if helm status "$SCP_RELEASE" --namespace "$SCP_NAMESPACE" >/dev/null 2>&1; then
    log "enabling ${SCP_FLAG} on SCP release '${SCP_RELEASE}' (auto-wire hook + NetworkPolicy egress)"
    [ -f "${SCP_CHART_DIR}/Chart.yaml" ] || fail "main SCP chart not found at ${SCP_CHART_DIR} (pass --scp-chart)"
    helm upgrade "$SCP_RELEASE" "$SCP_CHART_DIR" \
      --namespace "$SCP_NAMESPACE" --reuse-values \
      --set "${SCP_FLAG}=true" --wait --timeout "$WAIT_TIMEOUT"
  else
    echo "scp-bundled: SCP Helm release '${SCP_RELEASE}' not found in namespace '${SCP_NAMESPACE}'." >&2
    echo "  ${BACKEND} is applied. To finish wiring it, set '${SCP_FLAG}=true' in your SCP deployment:" >&2
    echo "    - Helm-managed:  helm upgrade ${SCP_RELEASE} deploy/helm --reuse-values --set ${SCP_FLAG}=true" >&2
    echo "    - GitOps-managed: set ${SCP_FLAG}: true in the SCP values your GitOps tool renders" >&2
  fi
fi

log "done — ${BACKEND} enabled."
