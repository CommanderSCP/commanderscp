#!/usr/bin/env bash
#
# scp-runner-iac's run shim (DESIGN.md §12 Mode 2). The ENTRYPOINT of an image that carries
# nothing else — deliberately a small, auditable shell script, not a Node app (this image is the
# one place vaulted infrastructure credentials (TF_VAR_*/cloud provider env vars, injected ONLY
# into this ephemeral container's environment by the managed-iac orchestrator plugin, never
# logged, never written to any file this script creates) exist for the duration of exactly one
# run — the smaller and more auditable this file, the smaller that exposure window's attack
# surface. `set -euo pipefail`: any failed step aborts the run rather than silently continuing
# with a plan/state file that doesn't reflect what actually happened. Never `set -x` — command
# tracing would echo argv, and while no secret is ever PASSED as an argv value here (tofu reads
# its credentials from the environment, per provider convention), keeping this file free of any
# tracing habit is a deliberate discipline against that changing by accident later.
#
# Contract with the orchestrator (packages/plugins/managed-iac): `/workspace` is a bind mount
# (or named volume) holding the org's `.tf` configuration; `docker run --rm -v <dir>:/workspace
# -e <vaulted creds> scp-runner-iac <action>` is the whole interface. Every action writes its
# evidence back into `/workspace` (plan.json, state-history/*.tfstate) so the ORCHESTRATOR — not
# this container, which is destroyed with `--rm` the moment it exits — is what persists that
# evidence as the change's record (DESIGN §12: "the plan output is persisted as the change's
# evidence").
#
# Actions:
#   plan     — `tofu init` + `tofu plan`, writes /workspace/.tfplan (binary) and
#              /workspace/plan.json (machine-readable, `tofu show -json`) — the change evidence a
#              gate evaluates BEFORE any apply is allowed to run.
#   apply    — snapshots current state to /workspace/state-history/ (rollback's own "prior known
#              good" trail), then `tofu apply` of the PREVIOUSLY-PLANNED /workspace/.tfplan (never
#              a fresh implicit plan — apply only ever applies what was already reviewed/gated).
#   rollback — restores a PRIOR /workspace/state-history/*.tfstate snapshot as current state
#              (PRIOR_STATE_FILE env var names which one). HONEST SIMPLIFICATION: this restores
#              STATE, not configuration+state — a real rollback that must also revert `.tf` source
#              changes needs the orchestrator to mount the PRIOR commit's config directory for a
#              real re-plan+apply; state-snapshot restore is what DESIGN's "rollback via prior
#              state ref" literally names, and is what this milestone's local-state fixture
#              integration test exercises end to end.

set -euo pipefail

ACTION="${1:-}"
WORKDIR=/workspace
cd "$WORKDIR"

case "$ACTION" in
  plan)
    tofu init -input=false -no-color
    tofu plan -input=false -no-color -out=.tfplan
    tofu show -json .tfplan > plan.json
    echo "scp-runner-iac: plan complete — evidence at /workspace/plan.json"
    ;;

  apply)
    tofu init -input=false -no-color
    if [ ! -f .tfplan ]; then
      echo "scp-runner-iac: apply requires a prior 'plan' run in this same workspace (.tfplan missing)" >&2
      exit 1
    fi
    mkdir -p state-history
    if [ -f terraform.tfstate ]; then
      cp terraform.tfstate "state-history/$(date -u +%Y%m%dT%H%M%SZ)-pre-apply.tfstate"
    fi
    tofu apply -input=false -no-color -auto-approve .tfplan
    cp terraform.tfstate "state-history/$(date -u +%Y%m%dT%H%M%SZ)-post-apply.tfstate"
    echo "scp-runner-iac: apply complete"
    ;;

  rollback)
    if [ -z "${PRIOR_STATE_FILE:-}" ]; then
      echo "scp-runner-iac: rollback requires PRIOR_STATE_FILE (a state-history/*.tfstate path)" >&2
      exit 1
    fi
    # Jail PRIOR_STATE_FILE to the workspace's own state-history/ dir (defence in depth — the
    # managed-iac orchestrator plugin already validates this, this is the container-side backstop):
    # must be a relative path under state-history/, no absolute paths, no `..` traversal.
    case "$PRIOR_STATE_FILE" in
      /*|*..*)
        echo "scp-runner-iac: PRIOR_STATE_FILE '$PRIOR_STATE_FILE' must be a relative state-history/ path (no absolute paths, no '..')" >&2
        exit 1
        ;;
      state-history/*) : ;;
      *)
        echo "scp-runner-iac: PRIOR_STATE_FILE '$PRIOR_STATE_FILE' must be under state-history/" >&2
        exit 1
        ;;
    esac
    if [ ! -f "$PRIOR_STATE_FILE" ]; then
      echo "scp-runner-iac: PRIOR_STATE_FILE '$PRIOR_STATE_FILE' not found under /workspace" >&2
      exit 1
    fi
    tofu init -input=false -no-color
    cp "$PRIOR_STATE_FILE" terraform.tfstate
    tofu show -json terraform.tfstate > plan.json
    echo "scp-runner-iac: rollback complete — restored state from $PRIOR_STATE_FILE"
    ;;

  *)
    echo "scp-runner-iac: unknown action '$ACTION' (expected plan|apply|rollback)" >&2
    exit 2
    ;;
esac
