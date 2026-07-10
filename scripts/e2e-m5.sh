#!/usr/bin/env bash
# M5 Campaigns & Initiatives golden path (BUILD_AND_TEST.md §8 M5 definition of done — flagship
# E2E): a "patch 3 services" campaign compiles to per-target member changes with correct wave
# ordering -> wave 1 promotes -> wave 2 is blocked by a required gate on one of its targets
# (fan-in/fan-out semantics reused from M3, gate reused from M4) -> campaign status aggregates
# correctly -> an initiative grouping the campaign reflects the roll-up -> campaign-level rollback
# reverts the promoted target, each rollback producing a Decision -> `scp audit verify` passes.
#
# Builds the image, brings up the same two-container compose stack e2e-m0.sh/e2e-m4.sh use, then
# drives it with the REAL `scp` CLI binary exactly the way an operator would.
#
# Scope decision (documented, same reasoning as e2e-m4.sh's own header comment): the required gate
# that blocks wave 2 here is approval-only (`requireApprovals`), not a real `requireControls`
# webhook-control binding. e2e-m4.sh already explains why: (1) this compose stack's single
# bootstrap-admin identity can only satisfy an approval `fromRole` matching its OWN role ("Owner"),
# since no role-binding-management API/CLI exists yet to create a second identity with a different
# role; (2) reaching a real ControlPlugin (webhook-control) from inside the compose network needs
# either a sidecar container or host.docker.internal wiring — meaningful fragility for a property
# (a real webhook-control run, real subprocess plugin host, real HTTP POST, blocking a campaign
# wave boundary exactly like a change's own wave boundary) that
# apps/server/src/coordination/campaign.integration.test.ts already covers exhaustively with a REAL
# subprocess plugin host and a REAL webhook fixture server — a strictly more rigorous environment
# than a shell script can provide. This E2E's job is proving the WHOLE PATH (campaign compile ->
# per-target member Changes -> wave-boundary gate reusing coordination/gates.ts's evaluateWaveGate
# -> campaign status aggregation -> initiative roll-up -> campaign-scoped rollback -> audit
# integrity) wires together against the real compose-deployed image and the real CLI binary, not
# re-proving individual mechanisms already covered at the integration layer.
#
# The required policy is scoped to exactly ONE of wave 2's two targets (svc-b, not svc-c) — DoD's
# "wave 2 is blocked by one target's failing [gate]" made concrete: a policy matched against ANY
# target in a wave's target set blocks the WHOLE wave (coordination/gates.ts's evaluateWaveGate is
# evaluated once per wave, over every target in it), so svc-c's own innocence doesn't save the wave.
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
    echo "--- e2e-m5.sh FAILED (exit $status) — dumping 'scp' service logs ---"
    "${COMPOSE[@]}" logs scp || true
  fi
  echo "--- tearing down compose stack ---"
  "${COMPOSE[@]}" down -v --remove-orphans || true
  rm -rf "$CLI_CONFIG_DIR"
  exit "$status"
}
trap cleanup EXIT

# Extracts one JSON field from stdin (dot-path, e.g. "id" or "status") — never depends on JSON key
# order/formatting, only the parsed value (same helper as e2e-m4.sh).
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

echo "==> register 3 services: svc-a (wave 0), svc-b + svc-c (wave 1, both depend on svc-a)"
SVC_A_JSON="$("${CLI_BIN[@]}" service register --name svc-a --output json)"
SVC_A_ID="$(echo "$SVC_A_JSON" | json_field id)"
SVC_B_JSON="$("${CLI_BIN[@]}" service register --name svc-b --output json)"
SVC_B_ID="$(echo "$SVC_B_JSON" | json_field id)"
SVC_C_JSON="$("${CLI_BIN[@]}" service register --name svc-c --output json)"
SVC_C_ID="$(echo "$SVC_C_JSON" | json_field id)"
echo "svc-a=$SVC_A_ID svc-b=$SVC_B_ID svc-c=$SVC_C_ID"

"${CLI_BIN[@]}" service add-depends-on "$SVC_B_ID" --target "$SVC_A_ID" >/dev/null
"${CLI_BIN[@]}" service add-depends-on "$SVC_C_ID" --target "$SVC_A_ID" >/dev/null
echo "svc-b and svc-c both depends_on svc-a"

echo "==> scp policy register --name wave2-approval (required, requireApprovals fromRole=Owner, scoped to svc-b ONLY)"
# fromRole is "Owner" deliberately — see this script's header comment (same constraint e2e-m4.sh
# documents: no role-binding-management API/CLI exists yet to create a second identity with a
# different role, so the bootstrap admin — who holds "Owner" — is the only satisfiable approver).
POLICY_PROPERTIES="$(node -e '
  console.log(JSON.stringify({
    scope: { objectRef: process.argv[1] },
    enforcement: "required",
    effects: [{ requireApprovals: { count: 1, fromRole: "Owner", scope: process.argv[1] } }]
  }));
' "$SVC_B_ID")"
POLICY_JSON="$("${CLI_BIN[@]}" policy register --name wave2-approval --properties "$POLICY_PROPERTIES" --output json)"
POLICY_ID="$(echo "$POLICY_JSON" | json_field id)"
echo "policy id: $POLICY_ID (scoped to svc-b only)"

echo "==> scp campaign create --name 'patch 3 services' --targets svc-a,svc-b,svc-c"
CAMPAIGN_JSON="$("${CLI_BIN[@]}" campaign create --name "patch 3 services" --targets "$SVC_A_ID,$SVC_B_ID,$SVC_C_ID" --output json)"
CAMPAIGN_ID="$(echo "$CAMPAIGN_JSON" | json_field id)"
echo "campaign id: $CAMPAIGN_ID"

echo "==> waiting for the campaign's plan to compile with correct wave ordering (svc-a alone in wave 0)"
WAVE0_TARGET=""
for i in $(seq 1 60); do
  EXPLAIN_JSON="$("${CLI_BIN[@]}" campaign explain "$CAMPAIGN_ID" --output json)"
  WAVE0_TARGET="$(node -e '
    const data = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const plan = data.plan;
    if (!plan || plan.waves.length < 2) process.exit(1);
    const wave0 = plan.waves.find((w) => w.waveIndex === 0);
    const wave1 = plan.waves.find((w) => w.waveIndex === 1);
    if (!wave0 || wave0.targets.length !== 1 || wave0.targets[0].targetObjectId !== process.argv[1]) process.exit(1);
    if (!wave1 || wave1.targets.length !== 2) process.exit(1);
    const ids = wave1.targets.map((t) => t.targetObjectId).sort();
    const expected = [process.argv[2], process.argv[3]].sort();
    if (JSON.stringify(ids) !== JSON.stringify(expected)) process.exit(1);
    console.log(wave0.targets[0].id);
  ' "$SVC_A_ID" "$SVC_B_ID" "$SVC_C_ID" <<<"$EXPLAIN_JSON" || true)"
  if [ -n "$WAVE0_TARGET" ]; then
    echo "PASS: wave 0 = [svc-a], wave 1 = [svc-b, svc-c]"
    break
  fi
  if [ "$i" -eq 60 ]; then
    echo "FAIL: campaign plan never compiled with the expected wave shape within 60s" >&2
    echo "$EXPLAIN_JSON" >&2
    exit 1
  fi
  sleep 1
done

echo "==> waiting for wave 0's member Change (svc-a) to be proposed"
WAVE0_CHANGE_ID=""
for i in $(seq 1 60); do
  EXPLAIN_JSON="$("${CLI_BIN[@]}" campaign explain "$CAMPAIGN_ID" --output json)"
  WAVE0_CHANGE_ID="$(node -e '
    const data = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const wave0 = data.plan.waves.find((w) => w.waveIndex === 0);
    const id = wave0.targets[0].memberChangeObjectId;
    if (id) console.log(id);
  ' <<<"$EXPLAIN_JSON")"
  if [ -n "$WAVE0_CHANGE_ID" ]; then
    echo "wave 0 member change id: $WAVE0_CHANGE_ID"
    break
  fi
  if [ "$i" -eq 60 ]; then
    echo "FAIL: wave 0's member change was never proposed within 60s" >&2
    exit 1
  fi
  sleep 1
done

echo "==> waiting for the member change to reach 'validating', then promoting it via scp change promote"
for i in $(seq 1 60); do
  STATE="$("${CLI_BIN[@]}" change get "$WAVE0_CHANGE_ID" --output json | json_field state)"
  if [ "$STATE" = "validating" ]; then
    echo "PASS: member change reached 'validating' (after ${i}s)"
    break
  fi
  if [ "$i" -eq 60 ]; then
    echo "FAIL: member change never reached 'validating' within 60s (last state: $STATE)" >&2
    exit 1
  fi
  sleep 1
done
"${CLI_BIN[@]}" change promote "$WAVE0_CHANGE_ID" >/dev/null
echo "PASS: wave 0's member change promoted"

echo "==> waiting for the campaign to aggregate to status 'blocked' (wave 0 succeeded, wave 1 blocked by svc-b's required approval)"
GATE_BLOCK_DECISION_ID=""
for i in $(seq 1 90); do
  STATUS="$("${CLI_BIN[@]}" campaign status "$CAMPAIGN_ID" --output json | json_field status)"
  if [ "$STATUS" = "blocked" ]; then
    EXPLAIN_JSON="$("${CLI_BIN[@]}" campaign explain "$CAMPAIGN_ID" --output json)"
    GATE_BLOCK_DECISION_ID="$(node -e '
      const data = JSON.parse(require("fs").readFileSync(0, "utf8"));
      const d = data.decisions.find((x) => x.kind === "gate" && x.verdict === "block");
      if (d) console.log(d.id);
    ' <<<"$EXPLAIN_JSON")"
    if [ -n "$GATE_BLOCK_DECISION_ID" ]; then
      echo "PASS: campaign status is 'blocked' (decision_id $GATE_BLOCK_DECISION_ID resolvable)"
      break
    fi
  fi
  if [ "$i" -eq 90 ]; then
    echo "FAIL: campaign never reached status 'blocked' with a resolvable gate-block decision within 90s (last status: $STATUS)" >&2
    exit 1
  fi
  sleep 1
done

echo "==> scp decision get \$GATE_BLOCK_DECISION_ID — explainability: every blocked verdict resolves"
"${CLI_BIN[@]}" decision get "$GATE_BLOCK_DECISION_ID" >/dev/null
echo "PASS: gate-block Decision resolves via scp decision get"

echo "==> wave 1's targets must NOT have had member Changes proposed yet (a campaign wave gate blocks progress, not just approval)"
STILL_BLOCKED_JSON="$("${CLI_BIN[@]}" campaign explain "$CAMPAIGN_ID" --output json)"
WAVE1_UNPROPOSED="$(node -e '
  const data = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const wave1 = data.plan.waves.find((w) => w.waveIndex === 1);
  const anyProposed = wave1.targets.some((t) => t.memberChangeObjectId);
  console.log(anyProposed ? "false" : "true");
' <<<"$STILL_BLOCKED_JSON")"
if [ "$WAVE1_UNPROPOSED" != "true" ]; then
  echo "FAIL: wave 1 has a member change proposed despite being blocked" >&2
  exit 1
fi
echo "PASS: wave 1 has no member changes proposed while blocked"

echo "==> scp initiative create --name 'M5 flagship initiative' --campaigns \$CAMPAIGN_ID"
INITIATIVE_JSON="$("${CLI_BIN[@]}" initiative create --name "M5 flagship initiative" --campaigns "$CAMPAIGN_ID" --output json)"
INITIATIVE_ID="$(echo "$INITIATIVE_JSON" | json_field id)"
echo "initiative id: $INITIATIVE_ID"

echo "==> scp initiative status \$INITIATIVE_ID — roll-up must reflect the campaign's 'blocked' status"
ROLLUP_JSON="$("${CLI_BIN[@]}" initiative status "$INITIATIVE_ID" --output json)"
ROLLUP_STATUS="$(echo "$ROLLUP_JSON" | json_field rollupStatus)"
if [ "$ROLLUP_STATUS" != "blocked" ]; then
  echo "FAIL: expected initiative rollupStatus 'blocked', got '$ROLLUP_STATUS'" >&2
  echo "$ROLLUP_JSON" >&2
  exit 1
fi
echo "PASS: initiative roll-up reflects the campaign's 'blocked' status"

echo "==> scp campaign rollback \$CAMPAIGN_ID — reverts only the promoted target (svc-a)"
ROLLBACK_JSON="$("${CLI_BIN[@]}" campaign rollback "$CAMPAIGN_ID" --reason "M5 flagship e2e: revert wave 0 while wave 1 is blocked" --output json)"
ROLLED_BACK_COUNT="$(node -e '
  const data = JSON.parse(require("fs").readFileSync(0, "utf8"));
  console.log(data.rolledBack.length);
' <<<"$ROLLBACK_JSON")"
if [ "$ROLLED_BACK_COUNT" != "1" ]; then
  echo "FAIL: expected exactly 1 member change rolled back, got $ROLLED_BACK_COUNT" >&2
  echo "$ROLLBACK_JSON" >&2
  exit 1
fi
ROLLED_BACK_ORIGINAL="$(node -e '
  const data = JSON.parse(require("fs").readFileSync(0, "utf8"));
  console.log(data.rolledBack[0].originalChangeObjectId);
' <<<"$ROLLBACK_JSON")"
if [ "$ROLLED_BACK_ORIGINAL" != "$WAVE0_CHANGE_ID" ]; then
  echo "FAIL: rolled back the wrong change — expected $WAVE0_CHANGE_ID, got $ROLLED_BACK_ORIGINAL" >&2
  exit 1
fi
echo "PASS: campaign rollback reverted exactly svc-a's promoted member change ($WAVE0_CHANGE_ID)"

echo "==> waiting for the rollback to complete (\$WAVE0_CHANGE_ID reaches 'rolled_back')"
for i in $(seq 1 60); do
  STATE="$("${CLI_BIN[@]}" change get "$WAVE0_CHANGE_ID" --output json | json_field state)"
  if [ "$STATE" = "rolled_back" ]; then
    echo "PASS: svc-a's member change reached 'rolled_back' (after ${i}s)"
    break
  fi
  if [ "$i" -eq 60 ]; then
    echo "FAIL: svc-a's member change never reached 'rolled_back' within 60s (last state: $STATE)" >&2
    exit 1
  fi
  sleep 1
done

echo "==> each rollback produced its own Decision — campaign-level AND member-change-level (DESIGN §9.4)"
FINAL_CAMPAIGN_EXPLAIN="$("${CLI_BIN[@]}" campaign explain "$CAMPAIGN_ID" --output json)"
CAMPAIGN_ROLLBACK_DECISION="$(node -e '
  const data = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const d = data.decisions.find((x) => x.kind === "rollback_trigger");
  if (d) console.log(d.id);
' <<<"$FINAL_CAMPAIGN_EXPLAIN")"
if [ -z "$CAMPAIGN_ROLLBACK_DECISION" ]; then
  echo "FAIL: no campaign-level rollback_trigger Decision found" >&2
  exit 1
fi
MEMBER_CHANGE_EXPLAIN="$("${CLI_BIN[@]}" change explain "$WAVE0_CHANGE_ID" --output json)"
MEMBER_ROLLBACK_DECISION="$(node -e '
  const data = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const d = data.decisions.find((x) => x.kind === "rollback_trigger");
  if (d) console.log(d.id);
' <<<"$MEMBER_CHANGE_EXPLAIN")"
if [ -z "$MEMBER_ROLLBACK_DECISION" ]; then
  echo "FAIL: no member-change-level rollback_trigger Decision found" >&2
  exit 1
fi
echo "PASS: both the campaign-level ($CAMPAIGN_ROLLBACK_DECISION) and member-change-level ($MEMBER_ROLLBACK_DECISION) rollback Decisions exist"

echo "==> campaign status re-aggregates to 'rolled_back'"
FINAL_STATUS="$("${CLI_BIN[@]}" campaign status "$CAMPAIGN_ID" --output json | json_field status)"
if [ "$FINAL_STATUS" != "rolled_back" ]; then
  echo "FAIL: expected campaign status 'rolled_back', got '$FINAL_STATUS'" >&2
  exit 1
fi
echo "PASS: campaign status aggregates to 'rolled_back'"

echo "==> scp audit verify"
"${CLI_BIN[@]}" audit verify

echo "==> M5 campaigns & initiatives golden path e2e: ALL CHECKS PASSED"
