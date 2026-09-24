#!/usr/bin/env bash
#
# scp-infra.sh — the ONE script behind scp-infra-plan-v1 and scp-infra-apply-v1 (M28.3, ADR-0056).
#
# Shipped in the bundled chart as a ConfigMap and run by the org's Argo Workflows in the
# scp-runner-iac image (tofu + git + jq). CommanderSCP never runs it: SCP triggers the template,
# observes its outputs, and decides whether an apply may be triggered at all. The same file is what
# `infra-lane.integration.test.ts` runs in the same pinned image, so the script under test is the
# script that ships.
#
#   scp-infra.sh plan  <environment> <workspace> <sourceRepo> <sourceCommit> <infraPath>
#   scp-infra.sh apply <environment> <workspace> <sourceRepo> <sourceCommit> <infraPath> <planDigest>
#
# THE PLAN IDENTITY (`planDigest`). sha256 over the plan's CHANGE SET — `resource_changes` and
# `output_changes` of `tofu show -json`, keys sorted by jq — never over the whole document, which
# carries a timestamp and would differ between two plans of the same thing. Two plans with the same
# digest make the same changes, before and after values included, which is exactly what an
# approval approved.
#
# WHY APPLY RE-PLANS rather than applying a stored plan file. There is nowhere to store one that
# every organization has: an Argo artifact repository is optional (the build template's header says
# why the catalog must not assume one), and SCP must not hold a plan file — it carries state and,
# routinely, secret values. So apply plans again at the SAME commit against the SAME state and
# applies that plan ONLY IF its digest is the approved one. A plan that has drifted since approval
# is refused (exit 3), never applied "close enough". A re-plan with NOTHING to do is a no-op
# success — applying nothing cannot exceed what was approved, and it is what a re-apply of an
# already-applied plan looks like from here.
#
# THE STATE BACKEND IS THE OPERATOR'S (D2, the ADR-0049 precedent): `SCP_STATE_BACKEND_TYPE` and
# the non-secret `SCP_BACKEND_CONFIG_FILE` come from chart values, any backend credential from the
# operator's own Secret. The org's configuration does not get to choose where state lives — an
# override file replaces whatever backend block it declares, because a config with no backend would
# otherwise keep its state in this pod's emptyDir and lose it when the pod exits.
#
# Never `set -x`: argv carries nothing secret, but provider credentials are in the environment and a
# tracing habit is how that changes by accident.

set -euo pipefail

action="${1:-}"
environment="${2:-}"
workspace="${3:-}"
repo="${4:-}"
commit="${5:-}"
infra_path="${6:-.}"
approved="${7:-}"

work="${SCP_WORK_DIR:-/work}"
out="${SCP_OUTPUT_DIR:-$work/out}"

refuse() {
  echo "scp-infra: $*" >&2
  exit 2
}

case "$action" in
  plan | apply) : ;;
  *) refuse "unknown action '$action' (expected plan|apply)" ;;
esac

# The same shape SCP validates before it triggers — checked again here because this script is also
# runnable by anything that can submit the template.
name_shape='^[A-Za-z0-9][A-Za-z0-9_.-]{0,89}$'
[[ "$environment" =~ $name_shape ]] || refuse "environment '$environment' is not a plain name"
[[ "$workspace" =~ $name_shape ]] || refuse "state workspace '$workspace' is not a plain name"
[[ "$repo" =~ ^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)+$ ]] || refuse "sourceRepo '$repo' is not owner/name"
[[ "$commit" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]] ||
  refuse "sourceCommit '$commit' is not a full commit id — a plan is pinned to one revision, never a branch"
case "/$infra_path/" in
  //* | */../*) refuse "infraPath '$infra_path' must be relative and stay inside the repository" ;;
esac
[[ "${SCP_STATE_BACKEND_TYPE:-}" =~ ^[a-z][a-z0-9_]*$ ]] ||
  refuse "no state backend is configured (bundledExecutor.argoWorkflows.catalog.infra.stateBackend.type) — refusing to keep state in a pod that is about to exit"
if [ "$action" = apply ]; then
  [[ "$approved" =~ ^[0-9a-f]{64}$ ]] ||
    refuse "apply needs the approved plan's digest; CommanderSCP sends it only for a plan that was accepted"
fi

mkdir -p "$out" "$work/src" "${HOME:-$work/home}"

# ---- 1. SOURCE, PINNED TO THE COMMIT ------------------------------------------------------------
# By commit, never by branch, for the build template's reason: what was planned has to be what is
# applied, and a branch can move between the two. The token travels in git's environment config,
# not in the remote URL or argv.
cd "$work/src"
git init -q .
remote="${SCP_SOURCE_BASE_URL:-https://github.com}"
remote="${remote%/}/${repo}.git"
if [ -n "${GIT_TOKEN:-}" ]; then
  export GIT_CONFIG_COUNT=1
  export GIT_CONFIG_KEY_0=http.extraHeader
  GIT_CONFIG_VALUE_0="Authorization: Basic $(printf 'x-access-token:%s' "$GIT_TOKEN" | base64 -w0)"
  export GIT_CONFIG_VALUE_0
fi
git fetch -q --depth 1 "$remote" "$commit"
git checkout -q FETCH_HEAD
fetched="$(git rev-parse HEAD)"
[ "$fetched" = "$commit" ] || refuse "fetched $fetched, which is not the requested $commit"
echo "scp-infra: fetched $fetched from $repo"

cd "$work/src/$infra_path" 2>/dev/null || refuse "no directory '$infra_path' in $repo at $commit"
compgen -G '*.tf' >/dev/null || refuse "no .tf files in '$infra_path' of $repo at $commit"

# ---- 2. THE OPERATOR'S STATE BACKEND, ONE WORKSPACE PER ENVIRONMENT -----------------------------
printf 'terraform {\n  backend "%s" {}\n}\n' "$SCP_STATE_BACKEND_TYPE" >_scp_state_backend_override.tf
init_args=(-input=false -no-color)
if [ -n "${SCP_BACKEND_CONFIG_FILE:-}" ] && [ -s "$SCP_BACKEND_CONFIG_FILE" ]; then
  init_args+=("-backend-config=$SCP_BACKEND_CONFIG_FILE")
fi
tofu init "${init_args[@]}"
tofu workspace select -or-create=true "$workspace"
export TF_VAR_environment="$environment"

# ---- 3. PLAN, AND ITS IDENTITY ------------------------------------------------------------------
# `-detailed-exitcode` is tofu's own answer to "is there anything to do": 0 none, 2 some, 1 error.
set +e
tofu plan -input=false -no-color -lock-timeout=120s -detailed-exitcode -out="$work/plan.tfplan"
rc=$?
set -e
case "$rc" in
  0) has_changes=false ;;
  2) has_changes=true ;;
  *)
    echo "scp-infra: tofu plan failed (exit $rc)" >&2
    exit 1
    ;;
esac
tofu show -json "$work/plan.tfplan" >"$work/plan.json"

digest="$(jq -cS '{resource_changes: (.resource_changes // []), output_changes: (.output_changes // {})}' "$work/plan.json" | sha256sum | cut -c1-64)"
# The tally rule managed-iac's plan-summary.ts uses, so the chip never disagrees between lanes: a
# replace (create+delete) counts in ADD and DESTROY, never CHANGE.
tally="$(jq -c '[.resource_changes[]? | (.change.actions // [])] | {
  add: (map(select(any(.[]; . == "create"))) | length),
  destroy: (map(select(any(.[]; . == "delete"))) | length),
  change: (map(select(any(.[]; . == "update") and (any(.[]; . == "create") | not) and (any(.[]; . == "delete") | not))) | length)
}' "$work/plan.json")"

# Argo reads these files as the workflow's global outputs; the argo-workflows plugin reads them back
# as `observed.plan`. Written before the apply decision so a refused apply still reports what it saw.
printf '%s' "$digest" >"$out/planDigest"
printf '%s' "$(jq -r .add <<<"$tally")" >"$out/planAdd"
printf '%s' "$(jq -r .change <<<"$tally")" >"$out/planChange"
printf '%s' "$(jq -r .destroy <<<"$tally")" >"$out/planDestroy"
printf 'false' >"$out/applied"

summary="$(jq -r '"\(.add) add / \(.change) change / \(.destroy) destroy"' <<<"$tally")"
echo "scp-infra: plan ${digest} — ${summary} (environment ${environment}, workspace ${workspace})"

if [ "$action" = plan ]; then
  exit 0
fi

# ---- 4. APPLY ONLY THE APPROVED PLAN ------------------------------------------------------------
if [ "$has_changes" = false ]; then
  echo "scp-infra: no-op — nothing to apply at ${commit}; the approved plan ${approved} is already in effect"
  exit 0
fi
if [ "$digest" != "$approved" ]; then
  echo "scp-infra: REFUSING to apply — the plan at ${commit} is now ${digest}, not the approved ${approved}." >&2
  echo "scp-infra: state or inputs changed since approval. Plan again and approve that plan." >&2
  exit 3
fi
tofu apply -input=false -no-color -lock-timeout=120s -auto-approve "$work/plan.tfplan"
printf 'true' >"$out/applied"
echo "scp-infra: applied plan ${digest}"
