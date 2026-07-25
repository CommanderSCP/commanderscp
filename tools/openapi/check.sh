#!/usr/bin/env bash
# tools/openapi/check.sh — API breaking-change gate (BUILD_AND_TEST.md §4.3 "Spec stability",
# §6 stage 3 "Codegen drift", §7 "API breaking change" row).
#
# Runs the vendored `oasdiff breaking` between:
#   BASE  — tools/openapi/openapi.v1.json as committed at the merge base with main (i.e. the
#           spec as it stood before this branch/PR's changes)
#   HEAD  — tools/openapi/openapi.v1.json as it exists in the working tree right now
#
# Run `pnpm gen` first so HEAD reflects the freshly emitted spec for the current routes (stage 3
# already does `pnpm gen && git diff --exit-code` before this script runs — by the time this
# script runs, the working-tree spec is both freshly emitted AND identical to what's committed on
# this branch, since the drift check would already have failed otherwise).
#
# Exit non-zero iff oasdiff reports an ERR-level (breaking) change within /v1. The API is
# additive-only within /v1 (CLAUDE.md "Codegen outputs are committed" / DESIGN.md); an intentional
# breaking change requires an explicit `api-v2-exception` label + an entry in OASDIFF-EXCEPTIONS.md
# per §6's merge policy — that is a human decision recorded on the PR, not something this script
# grants itself.
#
# SEPARATION OF CONCERNS: this SCRIPT is pure analysis and always exits non-zero on a breaking
# change — it knows nothing about labels, so it behaves identically in CI, on a workstation, and on
# an air-gapped machine. The POLICY lives in the workflow: job 3b reads the `api-v2-exception` label
# and, when it is present AND this PR adds an entry to OASDIFF-EXCEPTIONS.md, downgrades the failure
# to a warning. Both conditions are required, so the label cannot become a rubber stamp with no
# durable record of what broke. Labels are read from the event payload at run start — label first,
# then trigger a FRESH run (push a commit, or close+reopen the PR). A re-run does NOT pick up a label
# added after the run started — GitHub replays the original event payload.
#
# 3b is deliberately NOT a required status check on `main` (that is what lets an approved break land
# without an admin override), and it sits in no `needs:` chain. `main` DOES require
# "5z. Integration (aggregation gate)" and "3. Codegen drift", so a break can never skip tests or
# ship an unregenerated spec. Earlier revisions of this header described a branch-protection
# override; there was no branch protection at all before 2026-07-24.
#
# oasdiff is vendored at tools/openapi/bin/oasdiff-linux-amd64 (Apache-2.0, see bin/LICENSE-oasdiff)
# so this runs fully air-gapped — no network call anywhere in this script. Only linux/amd64 is
# vendored today, matching the CI runners in .github/workflows/ci.yml (GitHub-hosted `ubuntu-latest`,
# linux/amd64; previously the homelab `homelab-commanderscp-linux-*` self-hosted labels, also
# linux/amd64 — the swap did not change the vendored architecture) and tools/ci-image, where this
# script is intended to run. Running it on another host architecture requires vendoring a matching
# oasdiff-<os>-<arch> binary under tools/openapi/bin/ first and pointing OASDIFF_BIN at it (see
# tools/openapi/README.md).
#
# Usage:
#   pnpm gen && tools/openapi/check.sh
#   OASDIFF_BASE_REF=origin/main tools/openapi/check.sh   # explicit base (default: auto-detect)

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

SPEC_PATH="tools/openapi/openapi.v1.json"
OASDIFF_BIN="${OASDIFF_BIN:-tools/openapi/bin/oasdiff-linux-amd64}"

if [ ! -x "$OASDIFF_BIN" ]; then
  echo "tools/openapi/check.sh: vendored oasdiff binary not found or not executable at $OASDIFF_BIN" >&2
  echo "  (only linux/amd64 is vendored — see tools/openapi/README.md; set OASDIFF_BIN to use a different one)" >&2
  exit 1
fi

if [ ! -f "$SPEC_PATH" ]; then
  echo "tools/openapi/check.sh: $SPEC_PATH not found in working tree — run 'pnpm gen' first" >&2
  exit 1
fi

# Resolve the ref to diff against. Callers on a shallow checkout (actions/checkout default) must
# have fetched enough history for `git merge-base` to succeed — tools/ci-image based CI jobs
# should use `actions/checkout@v4` with `fetch-depth: 0` (or at least fetch origin/main) ahead of
# calling this script; this script does not fetch over the network itself.
BASE_REF="${OASDIFF_BASE_REF:-}"
if [ -z "$BASE_REF" ]; then
  if git rev-parse --verify --quiet origin/main >/dev/null; then
    BASE_REF="origin/main"
  elif git rev-parse --verify --quiet main >/dev/null; then
    BASE_REF="main"
  else
    echo "tools/openapi/check.sh: could not resolve a 'main' ref to diff against (tried origin/main, main)" >&2
    echo "  set OASDIFF_BASE_REF to an explicit ref/sha to compare against" >&2
    exit 1
  fi
fi

if ! MERGE_BASE="$(git merge-base "$BASE_REF" HEAD 2>/dev/null)"; then
  echo "tools/openapi/check.sh: 'git merge-base $BASE_REF HEAD' failed — is history deep enough (fetch-depth: 0)?" >&2
  exit 1
fi

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

BASE_SPEC="$WORK_DIR/base.openapi.v1.json"
if ! git show "${MERGE_BASE}:${SPEC_PATH}" > "$BASE_SPEC" 2>/dev/null; then
  echo "tools/openapi/check.sh: no $SPEC_PATH at merge-base $MERGE_BASE — nothing to compare against (new spec), skipping"
  exit 0
fi

echo "==> oasdiff breaking: merge-base ($BASE_REF @ $MERGE_BASE) -> working tree ($SPEC_PATH)"
"$OASDIFF_BIN" breaking "$BASE_SPEC" "$SPEC_PATH" --fail-on ERR
