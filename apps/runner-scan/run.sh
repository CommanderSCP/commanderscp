#!/bin/sh
#
# scp-runner-scan's run shim (ADR-0020 §1, proposal §13.3, charter's Managed Execution Exception
# 2026-07-23 amendment). The ENTRYPOINT of an image that carries nothing but a pinned scanner
# toolchain (Trivy + OpenSCAP) — deliberately a small, auditable shell script, not a Node app, in the
# same spirit as apps/runner-iac/run.sh. Uses `#!/bin/sh` (POSIX) — the final base is Fedora, which
# ships a POSIX /bin/sh (bash-as-sh); the constructs below (`set -eu`, `case`) are POSIX. This
# container is launched `--network none` (no egress at all) by the `scp-managed-scan` orchestrator
# plugin (packages/plugins/managed-scan) as the commander's promotion scan step, one ephemeral
# single-shot container per artifact per method.
#
# `set -eu`: any failed step aborts rather than emitting a partial/empty result that a downstream
# parser might read as "clean" — a broken scan must FAIL the run, never silently pass (fail-closed,
# proposal §13.3). Never `set -x` — no argv tracing habit, even though no secret is passed on argv.
# (POSIX sh has no `pipefail`; the pipelines below are guarded explicitly.)
#
# Contract with the orchestrator (packages/plugins/managed-scan/src/index.ts):
#   argv:  $1 = method (trivy|openscap)
#          $2 = profile     (openscap only — an xccdf_..._profile_* id; ignored by trivy)
#          $3 = datastream  (openscap only — an ABSOLUTE path to an SSG datastream baked into this
#                            image, e.g. /usr/share/xml/scap/ssg/content/ssg-debian11-ds.xml)
#   /work/image  — the scan SUBJECT, an OCI image layout the SERVER pulled by digest over the
#                  allowlisted skopeo channel (ADR-0019 §4) and `docker cp`'d IN. The runner itself
#                  has NO network and pulls nothing.
#   /work/out    — where this script writes its result; the orchestrator `docker cp`s it back OUT and
#                  the commander parses it (Trivy JSON -> ScanEvidence, or the oscap ARF -> ScanEvidence
#                  via parseOscapResult). The container is `rm -f`'d the moment it exits, so the
#                  ORCHESTRATOR persists the evidence, never this container.
#
# OFFLINE AT RUNTIME (charter principle 5): the Trivy DB is baked at BUILD time (Dockerfile) and this
# script runs Trivy with `--skip-db-update --offline-scan`; oscap evaluates a LOCAL datastream against
# a LOCALLY-extracted rootfs (OSCAP_PROBE_ROOT) with NO network. (Cross-air-gap TRANSPORT of the baked
# DB / SCAP content is increment 13.3b part 2; this increment relies on the build-time bake only.)
#
# Methods (proposal §13.3 "Increment order: Trivy first, OpenSCAP second"):
#   trivy    — scan the local OCI image layout at /work/image, emit Trivy's native JSON result to
#              /work/out/result.json. The commander distills Results[].Vulnerabilities[].Severity into
#              the four ScanSeverityCounts and binds the promoted digest (parseTrivyResult).
#   openscap — extract /work/image (the OCI layout) into a rootfs, then `oscap xccdf eval` that rootfs
#              (OSCAP_PROBE_ROOT) against the selected SSG datastream+profile, writing the ARF result to
#              /work/out/arf.xml. The commander counts FAILED rule-results by XCCDF severity into the
#              four ScanSeverityCounts (parseOscapResult). XCCDF has no `critical` severity, so critical
#              stays 0 (operators gate OpenSCAP findings on `high`); `unknown`/`info`/unset fold away.

set -eu

METHOD="${1:-}"
PROFILE="${2:-xccdf_org.ssgproject.content_profile_standard}"
DATASTREAM="${3:-/usr/share/xml/scap/ssg/content/ssg-fedora-ds.xml}"
INPUT=/work/image
OUTDIR=/work/out
mkdir -p "$OUTDIR"

case "$METHOD" in
  trivy)
    # --input scans the LOCAL OCI layout (no registry dial); --skip-db-update + --offline-scan pin
    # the run to the build-time-baked DB (no network). --format json emits the native result the
    # commander parses. --exit-code 0 unconditionally: this runner REPORTS findings, it does not gate
    # — the commander evaluates the counts against the resolved M17.5 threshold.
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
    # (1) EXTRACT the docker-cp'd OCI layout into a rootfs. oscap cannot read an OCI layout directly;
    #     the standard offline mechanism (what oscap-podman/oscap-docker do under the hood) is to
    #     materialize the image's filesystem and point the probes at it via OSCAP_PROBE_ROOT. We
    #     resolve the image manifest from index.json (descending ONE level of index nesting and
    #     preferring linux/amd64 for a multi-arch layout — the server pulls with `skopeo copy --all`),
    #     then untar its layers in order into $ROOTFS. Whiteouts are not replayed (a documented first-
    #     increment limitation — OS package/config rules read the union fs fine for the D2 image scope).
    ROOTFS=/work/rootfs
    mkdir -p "$ROOTFS"

    if [ ! -f "$INPUT/index.json" ]; then
      echo "scp-runner-scan: openscap — no OCI index.json at $INPUT (subject not copied in?)" >&2
      exit 4
    fi

    # Resolve the image-manifest blob digest (the one that HAS .layers).
    resolve_manifest() {
      # $1 = manifest blob digest (sha256:hex). Prints the digest of a blob carrying .layers, or empty.
      _d="${1#sha256:}"
      _blob="$INPUT/blobs/sha256/$_d"
      [ -f "$_blob" ] || { echo ""; return; }
      if [ "$(jq 'has("layers")' "$_blob")" = "true" ]; then
        echo "sha256:$_d"
        return
      fi
      if [ "$(jq 'has("manifests")' "$_blob")" = "true" ]; then
        # An image index — prefer linux/amd64, else the first entry that resolves to an image manifest.
        _pref="$(jq -r '(.manifests[] | select(.platform.os=="linux" and .platform.architecture=="amd64") | .digest) // empty' "$_blob" | head -n1)"
        if [ -n "$_pref" ]; then resolve_manifest "$_pref"; return; fi
        for _m in $(jq -r '.manifests[].digest' "$_blob"); do
          _r="$(resolve_manifest "$_m")"
          if [ -n "$_r" ]; then echo "$_r"; return; fi
        done
      fi
      echo ""
    }

    TOP="$(jq -r '.manifests[0].digest' "$INPUT/index.json")"
    MANIFEST="$(resolve_manifest "$TOP")"
    if [ -z "$MANIFEST" ]; then
      echo "scp-runner-scan: openscap — could not resolve an image manifest from the OCI layout" >&2
      exit 4
    fi

    MAN_BLOB="$INPUT/blobs/sha256/${MANIFEST#sha256:}"
    for LAYER in $(jq -r '.layers[].digest' "$MAN_BLOB"); do
      LAYER_BLOB="$INPUT/blobs/sha256/${LAYER#sha256:}"
      # GNU tar auto-detects gzip/uncompressed layers; a layer that fails to extract must not abort
      # the whole scan (a single corrupt aux layer should not fail-open OR crash) — but a totally
      # empty rootfs is caught below.
      tar -xf "$LAYER_BLOB" -C "$ROOTFS" 2>/dev/null || true
    done

    if [ -z "$(ls -A "$ROOTFS" 2>/dev/null)" ]; then
      echo "scp-runner-scan: openscap — extracted rootfs is EMPTY (no layers unpacked)" >&2
      exit 4
    fi

    if [ ! -f "$DATASTREAM" ]; then
      echo "scp-runner-scan: openscap — datastream '$DATASTREAM' is not present in the runner image" >&2
      exit 4
    fi

    # (2) EVALUATE. oscap exit codes: 0 = all rules pass, 2 = at least one rule failed (NORMAL — this
    #     runner reports, it does not gate), 1 = ERROR. We must NOT abort on exit 2 (findings are the
    #     product); only a real error (1, or a missing ARF) fails the run fail-closed. Runs with NO
    #     network — a local datastream against the locally-extracted rootfs.
    RC=0
    OSCAP_PROBE_ROOT="$ROOTFS" oscap xccdf eval \
      --profile "$PROFILE" \
      --results-arf "$OUTDIR/arf.xml" \
      "$DATASTREAM" || RC=$?

    oscap --version > "$OUTDIR/scanner-version.txt" 2>/dev/null || true

    if [ "$RC" != "0" ] && [ "$RC" != "2" ]; then
      echo "scp-runner-scan: openscap — oscap errored (exit $RC)" >&2
      exit "$RC"
    fi
    if [ ! -s "$OUTDIR/arf.xml" ]; then
      echo "scp-runner-scan: openscap — oscap produced no ARF result (fail-closed)" >&2
      exit 4
    fi
    echo "scp-runner-scan: openscap scan complete — ARF at /work/out/arf.xml (profile=$PROFILE)"
    ;;

  *)
    echo "scp-runner-scan: unknown method '$METHOD' (expected trivy|openscap)" >&2
    exit 2
    ;;
esac
