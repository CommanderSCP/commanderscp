#!/usr/bin/env bash
# M4 Governance Engine golden path (BUILD_AND_TEST.md §8 M4 definition of done — "the full golden
# path becomes CI's flagship E2E"): register -> propose a change -> a REQUIRED gate BLOCKS (a real
# HTTP 4xx carrying decision_id) -> approve via the real `scp` CLI -> promote -> `scp change
# explain` reconstructs the policy version consulted -> `scp audit verify` passes.
#
# Builds the image, brings up the same two-container compose stack e2e-m0.sh uses, then drives it
# with the REAL `scp` CLI binary exactly the way an operator would — plus one direct, unauthenticated-
# by-the-CLI `curl` call at the block step, so the "4xx carries decision_id" assertion is checked
# against the raw wire response rather than through the CLI's own (deliberately terse) error
# formatting (bin.ts only ever prints `err.message` — never the full RFC 9457 problem body).
#
# Scope decision (documented, not an oversight): the REQUIRED gate here is approval-only
# (`requireApprovals`, no `requireControls`). Two reasons: (1) role-binding management has no
# API/CLI surface yet (M1 gap, still open at M4) — the ONLY role this compose stack's single
# bootstrap-admin identity can satisfy an approval "fromRole" as is its own ("Owner"), so a
# control-and-approval HYBRID gate would need a second role-bound identity this script has no way
# to create; (2) reaching a real ControlPlugin (webhook-control) from inside the compose network
# needs either a sidecar container or host.docker.internal wiring — meaningful fragility for a
# property (control outcome + evidence persistence/reconstruction, both pass AND fail, hybrid
# gates) that governance.integration.test.ts already covers exhaustively against a REAL subprocess
# plugin host — a strictly more rigorous environment than a shell script can provide. This E2E's
# job is proving the WHOLE PATH wires together against the real compose-deployed image and the
# real CLI binary, not re-proving individual mechanisms already covered at the integration layer.
#
# A policy scoped directly to a change's own (single) target governs that target's WAVE boundary
# too, not just the validating->promoted lifecycle edge (coordination/gates.ts: every wave
# boundary is real-governance-evaluated in M4) — so this change parks in 'executing' (wave
# blocked, pending the same approval) before it ever reaches 'validating'. That's the genuine,
# correct system behavior for a single-wave change, not a workaround — `scp change explain` shows
# the wave's own blocked gate Decision, and the direct `curl` promote attempt made while still
# parked in 'executing' is what demonstrates the "4xx carries decision_id" contract (DESIGN
# §6/§10.4 promises this even for the underlying "illegal transition" — decisions.ts's guarded
# transition function writes exactly one Decision for every attempted transition, blocked or not).
#
# Never touches the internet beyond what `docker build`/`pnpm install` already needed.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

COMPOSE_FILE="deploy/compose/docker-compose.yml"
COMPOSE=(docker compose -f "$COMPOSE_FILE")
BASE_URL="http://localhost:8080"
API_URL="$BASE_URL/api/v1"
CLI_CONFIG_DIR="$(mktemp -d)"
CLI_BIN=(node "$ROOT_DIR/packages/cli/dist/bin.js")

cleanup() {
  local status=$?
  if [ "$status" -ne 0 ]; then
    echo "--- e2e-m4.sh FAILED (exit $status) — dumping 'scp' service logs ---"
    "${COMPOSE[@]}" logs scp || true
  fi
  echo "--- tearing down compose stack ---"
  "${COMPOSE[@]}" down -v --remove-orphans || true
  rm -rf "$CLI_CONFIG_DIR"
  exit "$status"
}
trap cleanup EXIT

# Extracts one JSON field from stdin (dot-path, e.g. "id" or "state") — used throughout instead of
# grep so this script never depends on JSON key ORDER or formatting, only the parsed value.
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

echo "==> ensuring the workspace (incl. @scp/cli) is built"
pnpm build

echo "==> building the scp image and starting the compose stack"
"${COMPOSE[@]}" build
"${COMPOSE[@]}" up -d

echo "==> waiting for the scp service to become healthy"
for i in $(seq 1 60); do
  if curl -fsS "$BASE_URL/healthz" >/dev/null 2>&1; then
    echo "scp is up (after ${i}s)"
    break
  fi
  if [ "$i" -eq 60 ]; then
    echo "scp did not become healthy in time" >&2
    exit 1
  fi
  sleep 1
done

echo "==> extracting the bootstrap admin one-time password from server logs"
BOOTSTRAP_LOG_LINE="$("${COMPOSE[@]}" logs scp 2>/dev/null | grep -i "one-time password" | tail -n1)"
if [ -z "$BOOTSTRAP_LOG_LINE" ]; then
  echo "could not find the bootstrap admin log line" >&2
  exit 1
fi
ADMIN_PASSWORD="$(node -e '
  const line = process.argv[1];
  const jsonStart = line.indexOf("{");
  const record = JSON.parse(line.slice(jsonStart));
  const match = /shown once\): (\S+)/.exec(record.msg);
  if (!match) process.exit(1);
  console.log(match[1]);
' "$BOOTSTRAP_LOG_LINE")"
if [ -z "$ADMIN_PASSWORD" ]; then
  echo "could not parse the bootstrap admin password out of: $BOOTSTRAP_LOG_LINE" >&2
  exit 1
fi
echo "bootstrap admin password extracted (redacted)"

export SCP_CONFIG_DIR="$CLI_CONFIG_DIR"
export SCP_API_URL="$API_URL"

echo "==> scp login"
"${CLI_BIN[@]}" login --username admin --password "$ADMIN_PASSWORD"
TOKEN="$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.env.SCP_CONFIG_DIR + '/credentials.json', 'utf8')).token)")"

echo "==> register: scp service register --name payments-api"
SERVICE_JSON="$("${CLI_BIN[@]}" service register --name payments-api --output json)"
SERVICE_ID="$(echo "$SERVICE_JSON" | json_field id)"
echo "service id: $SERVICE_ID"

echo "==> scp policy register --name prod-approval (required, requireApprovals fromRole=Owner)"
# fromRole is "Owner" (not "Approver") deliberately — see this script's header comment: the
# bootstrap admin is the ONLY identity this stack has, and it holds "Owner", not "Approver" (no
# role-binding-management API/CLI exists yet to create a second identity with a different role).
POLICY_PROPERTIES="$(node -e '
  console.log(JSON.stringify({
    scope: { objectRef: process.argv[1] },
    enforcement: "required",
    effects: [{ requireApprovals: { count: 1, fromRole: "Owner", scope: process.argv[1] } }]
  }));
' "$SERVICE_ID")"
POLICY_JSON="$("${CLI_BIN[@]}" policy register --name prod-approval --properties "$POLICY_PROPERTIES" --output json)"
POLICY_ID="$(echo "$POLICY_JSON" | json_field id)"
echo "policy id: $POLICY_ID (version $(echo "$POLICY_JSON" | json_field version))"

echo "==> propose: scp change propose --name 'ship payments-api' --targets \$SERVICE_ID"
CHANGE_JSON="$("${CLI_BIN[@]}" change propose --name "ship payments-api" --targets "$SERVICE_ID" --output json)"
CHANGE_ID="$(echo "$CHANGE_JSON" | json_field id)"
echo "change id: $CHANGE_ID"

echo "==> waiting for the required gate to block this change's wave (a real Decision, not a fixed engine outcome)"
GATE_BLOCKED=""
for i in $(seq 1 60); do
  EXPLAIN_JSON="$("${CLI_BIN[@]}" change explain "$CHANGE_ID" --output json)"
  GATE_BLOCKED="$(node -e '
    const data = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const blocked = data.decisions.find((d) => d.kind === "gate" && d.verdict === "block");
    if (blocked) console.log(JSON.stringify(blocked));
  ' <<<"$EXPLAIN_JSON")"
  if [ -n "$GATE_BLOCKED" ]; then
    echo "PASS: required gate blocked (decision_id $(echo "$GATE_BLOCKED" | json_field id))"
    break
  fi
  if [ "$i" -eq 60 ]; then
    echo "FAIL: required gate never blocked this change's wave within 60s" >&2
    echo "$EXPLAIN_JSON" >&2
    exit 1
  fi
  sleep 1
done

echo "==> asserting the blocked 4xx carries decision_id (direct API call, bypassing the CLI's own terse error formatting)"
PROMOTE_HTTP_CODE_AND_BODY="$(curl -sS -w '\n%{http_code}' -X POST \
  -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{}' "$API_URL/changes/$CHANGE_ID/promote")"
PROMOTE_HTTP_CODE="$(echo "$PROMOTE_HTTP_CODE_AND_BODY" | tail -n1)"
PROMOTE_BODY="$(echo "$PROMOTE_HTTP_CODE_AND_BODY" | sed '$d')"
if [ "$PROMOTE_HTTP_CODE" -lt 400 ] || [ "$PROMOTE_HTTP_CODE" -ge 500 ]; then
  echo "FAIL: expected a 4xx from the blocked promote attempt, got $PROMOTE_HTTP_CODE" >&2
  echo "$PROMOTE_BODY" >&2
  exit 1
fi
PROMOTE_DECISION_ID="$(echo "$PROMOTE_BODY" | json_field decision_id || true)"
if [ -z "$PROMOTE_DECISION_ID" ]; then
  echo "FAIL: blocked promote response (HTTP $PROMOTE_HTTP_CODE) carries no decision_id" >&2
  echo "$PROMOTE_BODY" >&2
  exit 1
fi
echo "PASS: blocked promote returned HTTP $PROMOTE_HTTP_CODE with decision_id $PROMOTE_DECISION_ID"

echo "==> approve via the real scp CLI: scp approval list / scp approval approve"
APPROVALS_JSON="$("${CLI_BIN[@]}" approval list --change-id "$CHANGE_ID" --output json)"
APPROVAL_ID="$(echo "$APPROVALS_JSON" | json_field 0.id)"
if [ -z "$APPROVAL_ID" ]; then
  echo "FAIL: no approval request materialized for change $CHANGE_ID" >&2
  echo "$APPROVALS_JSON" >&2
  exit 1
fi
echo "approval request id: $APPROVAL_ID"
"${CLI_BIN[@]}" approval approve "$APPROVAL_ID" --output json
VOTE_STATUS_JSON="$("${CLI_BIN[@]}" approval get "$APPROVAL_ID" --output json)"
if [ "$(echo "$VOTE_STATUS_JSON" | json_field status)" != "satisfied" ]; then
  echo "FAIL: approval request $APPROVAL_ID not satisfied after voting" >&2
  echo "$VOTE_STATUS_JSON" >&2
  exit 1
fi
echo "PASS: approval quorum satisfied"

echo "==> waiting for the change to reach 'validating' (the wave unblocks now that the required approval is satisfied)"
for i in $(seq 1 60); do
  STATE="$("${CLI_BIN[@]}" change get "$CHANGE_ID" --output json | json_field state)"
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

echo "==> promote: scp change promote \$CHANGE_ID"
PROMOTED_JSON="$("${CLI_BIN[@]}" change promote "$CHANGE_ID" --output json)"
PROMOTED_STATE="$(echo "$PROMOTED_JSON" | json_field state)"
if [ "$PROMOTED_STATE" != "promoted" ]; then
  echo "FAIL: expected state 'promoted' after promote, got '$PROMOTED_STATE'" >&2
  exit 1
fi
echo "PASS: change promoted"

echo "==> scp change explain: reconstructing the policy version consulted"
FINAL_EXPLAIN_JSON="$("${CLI_BIN[@]}" change explain "$CHANGE_ID" --output json)"
POLICY_VERSION_RECONSTRUCTED="$(node -e '
  const data = JSON.parse(require("fs").readFileSync(0, "utf8"));
  for (const decision of data.decisions) {
    const gate = decision.reasonTree && decision.reasonTree.gate;
    const policies = gate && gate.policies;
    if (!Array.isArray(policies)) continue;
    const entry = policies.find((p) => p.name === "prod-approval");
    if (!entry) continue;
    const versions = entry.contributingPolicyVersions;
    if (Array.isArray(versions) && versions.length > 0 && versions[0].policyObjectId === process.argv[1]) {
      console.log(versions[0].policyVersion);
      process.exit(0);
    }
  }
' <<<"$FINAL_EXPLAIN_JSON" "$POLICY_ID")"
if [ -z "$POLICY_VERSION_RECONSTRUCTED" ]; then
  echo "FAIL: scp change explain does not reconstruct the 'prod-approval' policy version consulted" >&2
  echo "$FINAL_EXPLAIN_JSON" >&2
  exit 1
fi
echo "PASS: scp change explain reconstructs policy '$POLICY_ID' version $POLICY_VERSION_RECONSTRUCTED"

echo "==> scp audit verify"
"${CLI_BIN[@]}" audit verify

echo "==> M4 golden path e2e: ALL CHECKS PASSED"
