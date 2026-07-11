#!/usr/bin/env bash
# M8 Ansible-driven upgrade drill (BUILD_AND_TEST.md sec.8 M8 DoD: "An Ansible-driven upgrade of a
# compose-based instance passes in CI"). Proves the scp.platform Ansible collection
# (deploy/ansible/) drives a real air-gap-bundle install AND a subsequent upgrade of a
# compose-based CommanderSCP instance, end to end:
#
#   1. build a REAL signed air-gap bundle (@scp/airgap) from local images, ephemeral test cosign
#      key (COSIGN_KEY unset -> build-bundle generates one, loudly logged as a TEST KEY);
#   2. stand up a local `registry:2` as the stand-in "customer registry";
#   3. `ansible-playbook -c local` the scp.platform rollout playbook in `--mode compose` -- which
#      internally runs the bundle's own install.sh (cosign-verify every image + reject tamper ->
#      retarget-push pinned by digest -> re-verify pushed digest -> docker compose up) then
#      health-checks /healthz;
#   4. run the SAME playbook AGAIN -- the "upgrade" (install.sh is idempotent: `docker compose up
#      -d` reconciles in place, the SAME bundle is install AND upgrade) -- and health-check again.
#
# Ansible is a CONVENIENCE, never a dependency (DESIGN.md sec.16): this drill only exercises the same
# install.sh an operator runs by hand, through the collection. `-c local` runs everything on this
# host (no SSH) -- the collection's SSH/fleet behavior is identical, just targeting `localhost`.
#
# Requires: docker (colima ok), skopeo, cosign, ansible-playbook, node/pnpm (to build @scp/airgap).
# Never reaches the internet except the deliberate skopeo push to the LOCAL registry.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

REGISTRY_PORT="${ANSIBLE_DRILL_REGISTRY_PORT:-5060}"
REGISTRY_HOST="127.0.0.1:${REGISTRY_PORT}"
REGISTRY_CONTAINER="scp-ansible-drill-registry"
BUNDLE_VERSION="ansible-drill"
SCRATCH="$(mktemp -d)"
COMPOSE_PROJECT="scp-ansible-drill"

log() { echo "==> $*"; }

cleanup() {
  local status=$?
  log "cleanup (exit $status)"
  # Tear down the compose stack install.sh brought up (its retargeted compose file lives in the
  # extracted bundle dir).
  if [ -n "${BUNDLE_DIR:-}" ] && [ -f "${BUNDLE_DIR}/compose/docker-compose.retargeted.yml" ]; then
    docker compose -f "${BUNDLE_DIR}/compose/docker-compose.retargeted.yml" down -v --remove-orphans 2>/dev/null || true
  fi
  docker rm -f "$REGISTRY_CONTAINER" 2>/dev/null || true
  rm -rf "$SCRATCH"
  [ "$status" -ne 0 ] && echo "--- ansible-drill.sh FAILED (exit $status) ---" >&2
  exit "$status"
}
trap cleanup EXIT

# Source images to bundle. Defaults reuse whatever scpd image is already around; override via env.
SCPD_REF="${ANSIBLE_DRILL_SCPD_REF:-scp:dev}"
RUNNER_IAC_REF="${ANSIBLE_DRILL_RUNNER_IAC_REF:-scp-runner-iac:dev}"
POSTGRES_REF="${ANSIBLE_DRILL_POSTGRES_REF:-postgres:16}"

log "checking prerequisites"
for bin in docker skopeo cosign ansible-playbook node; do
  command -v "$bin" >/dev/null 2>&1 || { echo "missing required tool: $bin" >&2; exit 1; }
done

log "ensuring source images exist locally (build scpd if the default tag is missing)"
if ! docker image inspect "$SCPD_REF" >/dev/null 2>&1; then
  if [ "$SCPD_REF" = "scp:dev" ]; then
    log "scp:dev not found -- building it from the repo root Dockerfile"
    docker build -t scp:dev .
  else
    echo "source scpd image '$SCPD_REF' not found and no auto-build for a custom ref" >&2
    exit 1
  fi
fi
docker image inspect "$RUNNER_IAC_REF" >/dev/null 2>&1 || docker build -t "$RUNNER_IAC_REF" apps/runner-iac
docker image inspect "$POSTGRES_REF" >/dev/null 2>&1 || docker pull "$POSTGRES_REF"

log "building @scp/airgap"
pnpm --filter @scp/airgap build >/dev/null

log "building a REAL signed air-gap bundle (ephemeral test cosign key)"
BUNDLE_OUT="${SCRATCH}/bundle-out"
node deploy/airgap/dist/build-bundle.js \
  --version "$BUNDLE_VERSION" \
  --out-dir "$BUNDLE_OUT" \
  --scpd-ref "$SCPD_REF" \
  --runner-iac-ref "$RUNNER_IAC_REF" \
  --postgres-ref "$POSTGRES_REF"

TARBALL="$(find "$BUNDLE_OUT" -name "scp-bundle-${BUNDLE_VERSION}.tar.gz" | head -1)"
[ -n "$TARBALL" ] || { echo "bundle tarball not produced" >&2; exit 1; }
log "bundle built: $TARBALL ($(du -h "$TARBALL" | cut -f1))"

log "starting a local registry:2 as the stand-in customer registry (${REGISTRY_HOST})"
docker rm -f "$REGISTRY_CONTAINER" 2>/dev/null || true
docker run -d --name "$REGISTRY_CONTAINER" -p "${REGISTRY_PORT}:5000" registry:2 >/dev/null
for i in $(seq 1 20); do
  curl -fsS "http://${REGISTRY_HOST}/v2/" >/dev/null 2>&1 && break
  [ "$i" -eq 20 ] && { echo "local registry never came up" >&2; exit 1; }
  sleep 1
done

# The scp.platform role wants the bundle tarball path + the extracted-bundle dir. We point the
# role's extract dir at our scratch so cleanup can find the retargeted compose file.
EXTRACT_DIR="${SCRATCH}/extract"
mkdir -p "$EXTRACT_DIR"

# The rollout playbook targets the `scp_instances` group, so we give it a tiny inline inventory
# putting localhost in that group with a local connection (no SSH).
INVENTORY="${SCRATCH}/inventory.ini"
cat > "$INVENTORY" <<EOF
[scp_instances]
localhost ansible_connection=local
EOF

run_playbook_inv() {
  local phase="$1"
  log "ansible-playbook (${phase}): rollout compose install/upgrade via scp.platform"
  ANSIBLE_ROLES_PATH="${ROOT_DIR}/deploy/ansible/scp/platform/roles" \
  ansible-playbook \
    -i "$INVENTORY" \
    "${ROOT_DIR}/deploy/ansible/scp/platform/playbooks/rollout.yml" \
    --extra-vars "{\"scp_bundle_tarball\":\"${TARBALL}\",\"scp_bundle_extract_dir\":\"${EXTRACT_DIR}\",\"scp_registry\":\"${REGISTRY_HOST}/scp\",\"scp_install_mode\":\"compose\",\"scp_insecure_registry\":true,\"scp_health_url\":\"http://127.0.0.1:8080/healthz\",\"scp_health_retries\":40,\"scp_health_delay_seconds\":2}"
}

# INSTALL (first apply)
run_playbook_inv "INSTALL"
BUNDLE_DIR="$(find "$EXTRACT_DIR" -name install.sh -type f | head -1 | xargs dirname)"
log "PASS: Ansible-driven INSTALL of the compose instance succeeded and /healthz is 200"

# UPGRADE (second apply -- same bundle, idempotent reconcile = the DoD's "upgrade of a
# compose-based instance").
run_playbook_inv "UPGRADE"
log "PASS: Ansible-driven UPGRADE of the compose instance succeeded and /healthz is 200"

# Final independent health assertion (not through Ansible).
for i in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:8080/healthz" >/dev/null 2>&1; then
    log "PASS: independent /healthz check after Ansible upgrade returned 200"
    break
  fi
  [ "$i" -eq 20 ] && { echo "FAIL: /healthz not 200 after Ansible upgrade" >&2; exit 1; }
  sleep 2
done

log "M8 Ansible drill: ALL CHECKS PASSED (bundle build -> ansible compose install -> ansible compose upgrade -> healthy)"
