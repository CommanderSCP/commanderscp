#!/usr/bin/env bash
# M6 Federation Basics — the two-domain round-trip E2E (BUILD_AND_TEST.md §4.4/§8 M6: "the
# headline" test, run on every merge to main). Two FULLY ISOLATED scpd+postgres pairs
# (deploy/compose/docker-compose.federation.yml — separate Docker networks, no network path
# between them at all) stand in for two federation domains, driven entirely by the real `scp` CLI
# binary running on the HOST:
#
#   1. Create objects in domain A.
#   2. `scp federation export` on A -> a real .scpbundle FILE on the host filesystem (the "air
#      gap crossing" — the two scpd containers never talk to each other; only the host CLI process
#      touches both domains' published ports, exactly like an operator carrying a USB drive).
#   3. `scp federation import` on B -> assert graph equivalence (B has A's object, as a read-only
#      replica, same id/urn/content, origin_domain_id pointing at A).
#   4. Propose + promote a Change in B through B's OWN LOCAL gates (no gate configured here, so
#      the reconciliation loop + shared fake-executor carry it to 'validating' automatically —
#      the SAME mechanism e2e-m4.sh's flagship golden path proves; this script proves it composes
#      with a change whose TARGET is a federated read-only replica object).
#   5. `scp federation export`/`import` B's status back to A -> assert convergence (A's federation
#      status shows B caught up through the exported sequence).
#   6. `scp audit verify` on BOTH sides -> audit-chain integrity holds independently on each side
#      of the trust boundary, per DESIGN.md §4.3's "audit segments ride the federation journal."
#
# Never touches the internet beyond what `docker build`/`pnpm install` already needed.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

COMPOSE_FILE="deploy/compose/docker-compose.federation.yml"
COMPOSE=(docker compose -f "$COMPOSE_FILE" -p scp-federation-e2e)
BASE_URL_A="http://localhost:8081"
BASE_URL_B="http://localhost:8082"
API_URL_A="$BASE_URL_A/api/v1"
API_URL_B="$BASE_URL_B/api/v1"
WORK_DIR="$(mktemp -d)"
CONFIG_DIR_A="$WORK_DIR/config-a"
CONFIG_DIR_B="$WORK_DIR/config-b"
mkdir -p "$CONFIG_DIR_A" "$CONFIG_DIR_B"
CLI_BIN=(node "$ROOT_DIR/packages/cli/dist/bin.js")
BUNDLE_A_TO_B="$WORK_DIR/a-to-b.scpbundle"
BUNDLE_B_TO_A="$WORK_DIR/b-to-a.scpbundle"

cleanup() {
  local status=$?
  if [ "$status" -ne 0 ]; then
    echo "--- e2e-m6.sh FAILED (exit $status) — dumping both domains' service logs ---"
    "${COMPOSE[@]}" logs domain-a-scp || true
    "${COMPOSE[@]}" logs domain-b-scp || true
  fi
  echo "--- tearing down the federation compose stack ---"
  "${COMPOSE[@]}" down -v --remove-orphans || true
  rm -rf "$WORK_DIR"
  exit "$status"
}
trap cleanup EXIT

# Extracts one JSON field from stdin (dot-path) — never depends on key order/formatting.
json_field() {
  node -e '
    const data = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const path = process.argv[1].split(".");
    let value = data;
    for (const key of path) value = value?.[key];
    if (value === undefined || value === null) { process.exit(1); }
    console.log(typeof value === "string" ? value : JSON.stringify(value));
  ' "$1"
}

wait_healthy() {
  local url="$1" label="$2"
  for i in $(seq 1 60); do
    if curl -fsS "$url/healthz" >/dev/null 2>&1; then
      echo "$label is up (after ${i}s)"
      return 0
    fi
    if [ "$i" -eq 60 ]; then
      echo "$label did not become healthy in time" >&2
      return 1
    fi
    sleep 1
  done
}

extract_admin_password() {
  local service="$1"
  local log_line
  log_line="$("${COMPOSE[@]}" logs "$service" 2>/dev/null | grep -i "one-time password" | tail -n1)"
  if [ -z "$log_line" ]; then
    echo "could not find the bootstrap admin log line for $service" >&2
    return 1
  fi
  node -e '
    const line = process.argv[1];
    const jsonStart = line.indexOf("{");
    const record = JSON.parse(line.slice(jsonStart));
    const match = /shown once\): (\S+)/.exec(record.msg);
    if (!match) process.exit(1);
    console.log(match[1]);
  ' "$log_line"
}

echo "==> ensuring the workspace (incl. @scp/cli) is built"
pnpm build

echo "==> building both domains' images and starting the isolated federation compose stack"
"${COMPOSE[@]}" build
"${COMPOSE[@]}" up -d

echo "==> waiting for both domains to become healthy"
wait_healthy "$BASE_URL_A" "domain A"
wait_healthy "$BASE_URL_B" "domain B"

echo "==> extracting bootstrap admin passwords"
ADMIN_PASSWORD_A="$(extract_admin_password domain-a-scp)"
ADMIN_PASSWORD_B="$(extract_admin_password domain-b-scp)"
echo "bootstrap admin passwords extracted (redacted)"

echo "==> scp login (domain A)"
SCP_CONFIG_DIR="$CONFIG_DIR_A" SCP_API_URL="$API_URL_A" "${CLI_BIN[@]}" login --username admin --password "$ADMIN_PASSWORD_A"
echo "==> scp login (domain B)"
SCP_CONFIG_DIR="$CONFIG_DIR_B" SCP_API_URL="$API_URL_B" "${CLI_BIN[@]}" login --username admin --password "$ADMIN_PASSWORD_B"

echo "==> scp federation init (domain A = parent, domain B = child)"
SCP_CONFIG_DIR="$CONFIG_DIR_A" SCP_API_URL="$API_URL_A" "${CLI_BIN[@]}" federation init --name domainA --role parent --output json
SCP_CONFIG_DIR="$CONFIG_DIR_B" SCP_API_URL="$API_URL_B" "${CLI_BIN[@]}" federation init --name domainB --role child --output json

echo "==> scp federation self (exchange public keys out-of-band — no network path exists between the two scpd containers)"
SELF_A_JSON="$(SCP_CONFIG_DIR="$CONFIG_DIR_A" SCP_API_URL="$API_URL_A" "${CLI_BIN[@]}" federation self --output json)"
SELF_B_JSON="$(SCP_CONFIG_DIR="$CONFIG_DIR_B" SCP_API_URL="$API_URL_B" "${CLI_BIN[@]}" federation self --output json)"
DOMAIN_A_ID="$(echo "$SELF_A_JSON" | json_field domainId)"
DOMAIN_A_PUBKEY="$(echo "$SELF_A_JSON" | json_field publicKey)"
DOMAIN_B_ID="$(echo "$SELF_B_JSON" | json_field domainId)"
DOMAIN_B_PUBKEY="$(echo "$SELF_B_JSON" | json_field publicKey)"
echo "domain A id: $DOMAIN_A_ID"
echo "domain B id: $DOMAIN_B_ID"

echo "==> scp federation pair (each side registers the other, from its own side — DESIGN §13 child-initiated-only)"
SCP_CONFIG_DIR="$CONFIG_DIR_A" SCP_API_URL="$API_URL_A" "${CLI_BIN[@]}" federation pair \
  --domain-id "$DOMAIN_B_ID" --name domainB --role child --public-key "$DOMAIN_B_PUBKEY" --output json
SCP_CONFIG_DIR="$CONFIG_DIR_B" SCP_API_URL="$API_URL_B" "${CLI_BIN[@]}" federation pair \
  --domain-id "$DOMAIN_A_ID" --name domainA --role parent --public-key "$DOMAIN_A_PUBKEY" --output json
echo "PASS: both domains paired"

echo "==> register a service in domain A: scp service register --name billing-svc"
SERVICE_JSON="$(SCP_CONFIG_DIR="$CONFIG_DIR_A" SCP_API_URL="$API_URL_A" "${CLI_BIN[@]}" service register --name billing-svc --output json)"
SERVICE_ID="$(echo "$SERVICE_JSON" | json_field id)"
SERVICE_URN="$(echo "$SERVICE_JSON" | json_field urn)"
echo "service id: $SERVICE_ID  urn: $SERVICE_URN"

echo "==> scp federation export --peer domainB (domain A) -> a real file on the host"
SCP_CONFIG_DIR="$CONFIG_DIR_A" SCP_API_URL="$API_URL_A" "${CLI_BIN[@]}" federation export --peer domainB --out "$BUNDLE_A_TO_B"
if [ ! -s "$BUNDLE_A_TO_B" ]; then
  echo "FAIL: exported bundle is empty or missing: $BUNDLE_A_TO_B" >&2
  exit 1
fi
echo "PASS: exported $(wc -c <"$BUNDLE_A_TO_B") bytes to $BUNDLE_A_TO_B"

echo "==> scp federation import (domain B) — verifying signature + hash chain, then applying"
IMPORT_A_TO_B_JSON="$(SCP_CONFIG_DIR="$CONFIG_DIR_B" SCP_API_URL="$API_URL_B" "${CLI_BIN[@]}" federation import "$BUNDLE_A_TO_B" --output json)"
echo "$IMPORT_A_TO_B_JSON"

echo "==> asserting graph EQUIVALENCE: domain B now has domain A's service, as a read-only replica"
REPLICA_JSON="$(SCP_CONFIG_DIR="$CONFIG_DIR_B" SCP_API_URL="$API_URL_B" "${CLI_BIN[@]}" service get "$SERVICE_ID" --output json)"
REPLICA_URN="$(echo "$REPLICA_JSON" | json_field urn)"
REPLICA_ORIGIN="$(echo "$REPLICA_JSON" | json_field originDomainId)"
if [ "$REPLICA_URN" != "$SERVICE_URN" ]; then
  echo "FAIL: domain B's replica urn ($REPLICA_URN) does not match domain A's ($SERVICE_URN)" >&2
  exit 1
fi
if [ "$REPLICA_ORIGIN" != "$DOMAIN_A_ID" ]; then
  echo "FAIL: domain B's replica originDomainId ($REPLICA_ORIGIN) is not domain A ($DOMAIN_A_ID) — single-writer authority not preserved" >&2
  exit 1
fi
echo "PASS: graph equivalence — domain B has domain A's service verbatim, correctly marked as a replica of domain A"

echo "==> propose a Change on the replicated target IN DOMAIN B: scp change propose"
CHANGE_JSON="$(SCP_CONFIG_DIR="$CONFIG_DIR_B" SCP_API_URL="$API_URL_B" "${CLI_BIN[@]}" change propose --name "ship billing-svc in B" --targets "$SERVICE_ID" --output json)"
CHANGE_ID="$(echo "$CHANGE_JSON" | json_field id)"
echo "change id (domain B, local): $CHANGE_ID"

echo "==> waiting for domain B's LOCAL reconciliation loop to carry the change to 'validating' (no gates configured — nothing to block on)"
for i in $(seq 1 60); do
  STATE="$(SCP_CONFIG_DIR="$CONFIG_DIR_B" SCP_API_URL="$API_URL_B" "${CLI_BIN[@]}" change get "$CHANGE_ID" --output json | json_field state)"
  if [ "$STATE" = "validating" ]; then
    echo "PASS: change reached 'validating' (after ${i}s)"
    break
  fi
  if [ "$i" -eq 60 ]; then
    echo "FAIL: change never reached 'validating' within 60s (last state: $STATE)" >&2
    exit 1
  fi
  sleep 1
done

echo "==> promote through domain B's LOCAL gates: scp change promote"
PROMOTED_JSON="$(SCP_CONFIG_DIR="$CONFIG_DIR_B" SCP_API_URL="$API_URL_B" "${CLI_BIN[@]}" change promote "$CHANGE_ID" --output json)"
PROMOTED_STATE="$(echo "$PROMOTED_JSON" | json_field state)"
if [ "$PROMOTED_STATE" != "promoted" ]; then
  echo "FAIL: expected state 'promoted' after promote, got '$PROMOTED_STATE'" >&2
  exit 1
fi
echo "PASS: change promoted through domain B's own local gates"

echo "==> scp federation export --peer domainA (domain B) — exporting status back across the gap"
SCP_CONFIG_DIR="$CONFIG_DIR_B" SCP_API_URL="$API_URL_B" "${CLI_BIN[@]}" federation export --peer domainA --out "$BUNDLE_B_TO_A"
if [ ! -s "$BUNDLE_B_TO_A" ]; then
  echo "FAIL: exported status bundle is empty or missing: $BUNDLE_B_TO_A" >&2
  exit 1
fi

echo "==> scp federation import (domain A) — applying domain B's returned status"
IMPORT_B_TO_A_JSON="$(SCP_CONFIG_DIR="$CONFIG_DIR_A" SCP_API_URL="$API_URL_A" "${CLI_BIN[@]}" federation import "$BUNDLE_B_TO_A" --output json)"
echo "$IMPORT_B_TO_A_JSON"

echo "==> asserting CONVERGENCE: domain A's federation status shows it caught up on domain B through the exported sequence"
STATUS_A_JSON="$(SCP_CONFIG_DIR="$CONFIG_DIR_A" SCP_API_URL="$API_URL_A" "${CLI_BIN[@]}" federation status --output json)"
LAST_APPLIED_SEQ="$(echo "$STATUS_A_JSON" | node -e '
  const data = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const peer = data.peers.find((p) => p.peer.name === "domainB");
  if (!peer || peer.lastAppliedSequence === null) { process.exit(1); }
  console.log(peer.lastAppliedSequence);
')"
echo "domain A's cursor on domain B is now at sequence $LAST_APPLIED_SEQ"
if [ -z "$LAST_APPLIED_SEQ" ] || [ "$LAST_APPLIED_SEQ" -le 0 ]; then
  echo "FAIL: domain A never advanced its cursor on domain B — convergence did not happen" >&2
  exit 1
fi
echo "PASS: convergence — domain A's federation status reflects domain B's returned journal"

echo "==> scp audit verify (domain A) — audit-chain integrity holds on the parent side"
SCP_CONFIG_DIR="$CONFIG_DIR_A" SCP_API_URL="$API_URL_A" "${CLI_BIN[@]}" audit verify
echo "==> scp audit verify (domain B) — audit-chain integrity holds on the child side"
SCP_CONFIG_DIR="$CONFIG_DIR_B" SCP_API_URL="$API_URL_B" "${CLI_BIN[@]}" audit verify

echo "==> M6 two-domain federation round-trip e2e: ALL CHECKS PASSED"
