#!/usr/bin/env bash
# scp-bundled — RENDER a CommanderSCP Standard Stack backend (diagnostics only).
#
# INSTALLING AND WIRING A BUNDLED BACKEND IS THE STACK CONTROLLER'S JOB (M29.4 ADR-0058, M29.2
# ADR-0061), through SCP itself:
#
#     scp stack enable argocd          # or Admin › Stack in the web UI
#
# The controller installs the backend from the deploy/helm-bundled chart its image carries, then, in
# the same reconcile, wires it into SCP: the scoped account's token, the TLS trust, both egress
# layers and the execution-system registration. There is no hook Job to wait for, no `helm upgrade`
# flag to flip and no bind command to copy from a log — which is everything this script's old
# `enable` verb did by hand, and why it is gone (it now refuses, naming the command above).
#
#     scripts/scp-bundled.sh render gitea   # print what the chart renders for one backend
#
# `render` stays because it is still useful: it prints the manifest a backend renders to, with the
# chart's defaults or your --set/--values, and applies nothing.
#
# Requires: helm.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHART_DIR="${SCP_BUNDLED_CHART_DIR:-${ROOT_DIR}/deploy/helm-bundled}"
SCP_NAMESPACE="default"
declare -a HELM_EXTRA=()

usage() {
  cat >&2 <<EOF
Usage: scp-bundled.sh render <argocd|argo-workflows|argo-rollouts|argo-events|gitea> [options]

  render   print the rendered manifest to stdout and exit (apply nothing)

  (enable is retired: the stack controller installs and wires backends — \`scp stack enable <backend>\`)

Options:
  --scp-namespace <ns>     namespace of the SCP release (the backends' ingress policies admit it)
  --values <file>          extra Helm values file (repeatable)
  --set <key=value>        extra Helm --set (repeatable)
  --chart <dir>            bundled chart dir (default: deploy/helm-bundled)
EOF
  exit "${1:-2}"
}

fail() { echo "scp-bundled: $*" >&2; exit 1; }

[ $# -ge 2 ] || usage 2
VERB="$1"; BACKEND="$2"; shift 2
case "$VERB" in
  render) : ;;
  enable)
    echo "scp-bundled: 'enable' is retired (M29.2, ADR-0061). The stack controller installs AND wires" >&2
    echo "  bundled backends through SCP — run:  scp stack enable ${BACKEND}   (or Admin › Stack)." >&2
    echo "  It registers the execution system, its token, TLS trust and egress with no further step." >&2
    exit 2 ;;
  *) usage 2 ;;
esac

case "$BACKEND" in
  argocd)         KEY="argocd" ;;
  argo-workflows) KEY="argoWorkflows" ;;
  argo-rollouts)  KEY="argoRollouts" ;;
  argo-events)    KEY="argoEvents" ;;
  gitea)          KEY="gitea" ;;
  *) echo "scp-bundled: unknown backend '$BACKEND'" >&2; usage 2 ;;
esac

while [ $# -gt 0 ]; do
  case "$1" in
    --scp-namespace) SCP_NAMESPACE="$2"; shift 2 ;;
    --chart)         CHART_DIR="$2"; shift 2 ;;
    --values)        HELM_EXTRA+=(--values "$2"); shift 2 ;;
    --set)           HELM_EXTRA+=(--set "$2"); shift 2 ;;
    -h|--help)       usage 0 ;;
    *) echo "scp-bundled: unknown option '$1'" >&2; usage 2 ;;
  esac
done

command -v helm >/dev/null 2>&1 || fail "helm not found on PATH"
[ -f "${CHART_DIR}/Chart.yaml" ] || fail "bundled chart not found at ${CHART_DIR} (pass --chart)"

MANIFEST="$(helm template scp-bundled "$CHART_DIR" \
  --set "bundledExecutor.${KEY}.enabled=true" \
  --set "bundledExecutor.scpNamespace=${SCP_NAMESPACE}" \
  ${HELM_EXTRA[@]+"${HELM_EXTRA[@]}"})"
[ -n "$MANIFEST" ] || fail "render produced an empty manifest for '${BACKEND}'"
printf '%s\n' "$MANIFEST"
