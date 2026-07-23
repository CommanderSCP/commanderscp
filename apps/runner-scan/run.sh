#!/bin/sh
#
# scp-runner-scan's run shim (ADR-0020 §1, proposal §13.3, charter's Managed Execution Exception
# 2026-07-23 amendment). The ENTRYPOINT of an image that carries nothing but a pinned scanner
# toolchain — deliberately a small, auditable shell script, not a Node app, in the same spirit as
# apps/runner-iac/run.sh. Uses `#!/bin/sh` (POSIX, busybox ash) rather than run-iac's `#!/usr/bin/env
# bash` because the pinned Trivy base image is Alpine and ships NO bash — only busybox sh (which
# supports the `set -euo pipefail` and `case` constructs below). This container is launched
# `--network none` (no egress at all) by the
# `scp-managed-scan` orchestrator plugin (packages/plugins/managed-scan) as the commander's
# promotion scan step, one ephemeral single-shot container per artifact per method.
#
# `set -euo pipefail`: any failed step aborts rather than emitting a partial/empty result that a
# downstream parser might read as "clean" — a broken scan must FAIL the run, never silently pass
# (fail-closed, proposal §13.3). Never `set -x` — the discipline is identical to run-iac's: no
# argv tracing habit, even though no secret is passed on argv here.
#
# Contract with the orchestrator (packages/plugins/managed-scan/src/index.ts):
#   - /work/image   — the scan SUBJECT, an OCI image layout the SERVER pulled by digest over the
#                     allowlisted skopeo channel (ADR-0019 §4) and `docker cp`'d IN. The runner
#                     itself has NO network and pulls nothing.
#   - /work/out     — where this script writes its result; the orchestrator `docker cp`s it back OUT
#                     and the commander parses it into ScanEvidence (the container is `rm -f`'d the
#                     moment it exits, so the ORCHESTRATOR persists the evidence, never this
#                     container — same split as scp-runner-iac's /workspace evidence).
#
# OFFLINE AT RUNTIME (charter principle 5): the Trivy vulnerability DB is baked into the image at
# BUILD time (Dockerfile `trivy image --download-db-only`), and this script runs with
# `--skip-db-update --offline-scan` so the scanner never phones home. (Cross-air-gap DB TRANSPORT —
# refreshing the baked DB on a disconnected commander via the `type: "blob"` channel — is increment
# 13.3b; this increment relies on the build-time-baked DB only.)
#
# Methods (proposal §13.3 "Increment order: Trivy first, OpenSCAP second"):
#   trivy    — scan the local OCI image layout at /work/image, emit Trivy's native JSON result to
#              /work/out/result.json. The commander distills Results[].Vulnerabilities[].Severity
#              into the four ScanSeverityCounts and binds Metadata.RepoDigests/ImageID to the
#              promoted digest.
#   openscap — NOT in this increment (13.3a follow-on). `tools/openscap/pin.env` is a documented
#              stub; the `oscap` binary, the XCCDF-rule-results -> four-severity-count mapping, and
#              this dispatch arm land with the second half of 13.3a. Fail LOUDLY, never silently.

set -euo pipefail

METHOD="${1:-}"
INPUT=/work/image
OUTDIR=/work/out
mkdir -p "$OUTDIR"

case "$METHOD" in
  trivy)
    # --input scans the LOCAL OCI layout (no registry dial); --skip-db-update + --offline-scan pin
    # the run to the build-time-baked DB (no network). --format json emits the native result the
    # commander parses. --exit-code 0 unconditionally: this runner REPORTS findings, it does not
    # gate — the commander evaluates the counts against the resolved M17.5 threshold (fail-closed
    # gating is the commander's job, not this container's).
    trivy image \
      --input "$INPUT" \
      --format json \
      --skip-db-update \
      --offline-scan \
      --scanners vuln \
      --exit-code 0 \
      --output "$OUTDIR/result.json"
    trivy version > "$OUTDIR/scanner-version.txt" 2>/dev/null || true
    echo "scp-runner-scan: trivy scan complete — result at /work/out/result.json"
    ;;

  openscap)
    echo "scp-runner-scan: method 'openscap' is not implemented in this increment (13.3a Trivy-first; OpenSCAP is the 13.3a follow-on — see tools/openscap/pin.env)" >&2
    exit 3
    ;;

  *)
    echo "scp-runner-scan: unknown method '$METHOD' (expected trivy)" >&2
    exit 2
    ;;
esac
