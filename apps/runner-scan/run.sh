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
#   argv:  $1 = method (trivy|trivy-vm|openscap)
#          $2 = profile     (openscap only — an xccdf_..._profile_* id; ignored by trivy/trivy-vm)
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
# OFFLINE AT RUNTIME (charter principle 5): the Trivy DB is baked at BUILD time (Dockerfile) OR
# pre-loaded via SCP_SCAN_DB_DIR (M13.3b-ii — the commander's server-maintained cache, `docker cp`'d
# in), and this script runs Trivy with `--skip-db-update --offline-scan` EITHER WAY; oscap evaluates a
# LOCAL datastream against a LOCALLY-extracted rootfs (OSCAP_PROBE_ROOT) with NO network. The pre-load
# seam (below) only changes WHICH already-downloaded DB Trivy reads — never whether it dials out.
#
# Methods (proposal §13.3 "Increment order: Trivy first, OpenSCAP second"):
#   trivy    — scan the local OCI image layout at /work/image, emit Trivy's native JSON result to
#              /work/out/result.json. The commander distills Results[].Vulnerabilities[].Severity into
#              the four ScanSeverityCounts and binds the promoted digest (parseTrivyResult).
#   trivy-vm — THE MACHINE-IMAGE ARM (13.3a, owner decision D2: "image-only for M13, where image
#              INCLUDES machine images"). Resolve the DISK IMAGE carried by the OCI layout at
#              /work/image, then `trivy vm` it. Emits the SAME native Trivy JSON to
#              /work/out/result.json, so the commander parses it with the SAME parseTrivyResult —
#              only the subject model differs (partition table -> filesystem -> OS package DB,
#              instead of a container layer stack).
#
#              SUBJECT FORMS THIS ARM SUPPORTS, and the honest bounds (proposal §13.3):
#                * DISK FORMATS — raw disk images and streamOptimized VMDK, over MBR/GPT partition
#                  tables with ext2/3/4 or XFS filesystems. OVA/VHD/VHDX/QCOW2 and LVM/ZFS are NOT
#                  supported upstream, so they are NOT recognized here: an unrecognized subject
#                  FAILS CLOSED (no result, no evidence, E6 refuses) rather than being handed to
#                  trivy to mis-parse into a spuriously clean scan.
#                * `ami:<id>` / `ebs:<snapshot-id>` (Trivy's AWS API forms) are NOT reachable from
#                  this runner and never will be: the runner is `--network none`, and reaching the
#                  EBS direct APIs would require SCP to hold CLOUD-PROVIDER credentials — which is
#                  the thing charter principle 1 forbids (the ADR-0019 §3 artifact-store credential
#                  class covers registry read/push, not cloud IAM). The connected AWS form is
#                  therefore deferred as an owner-level charter question, not a missing feature;
#                  see apps/runner-scan/README.md.
#
#              PACKAGING CONVENTION — how a machine image reaches /work/image (declared here,
#              normatively, because the server pulls it over the SAME allowlisted OCI channel as a
#              container image; nothing else about the pull path changes). Two forms, resolved in
#              this order, both FAIL CLOSED on zero or ambiguous matches:
#                (1) OCI ARTIFACT — the manifest carries exactly ONE layer descriptor that IS the
#                    disk: `mediaType: application/vnd.scp.machine-image.disk.v1+{raw,vmdk}` (an
#                    optional trailing `+gzip`), or any layer whose
#                    `annotations["org.opencontainers.image.title"]` ends in .raw/.img/.vmdk
#                    (optionally .gz). The blob is used IN PLACE (hardlinked, copied only if the
#                    link fails) — a multi-GiB disk is never duplicated needlessly.
#                (2) TAR-LAYER FALLBACK — no such descriptor: the layers are ordinary image tars
#                    (the `FROM scratch; COPY disk.raw /` shape a plain `docker build` produces),
#                    so extract them and find exactly one file with a recognized disk extension.
#              The materialized path is ALWAYS `/work/disk/disk.<ext>` — derived from the RECOGNIZED
#              EXTENSION, never from the annotation text. A registry annotation is attacker-adjacent
#              data; it selects a FORMAT here, never a filesystem path.
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

# ------------------------------------------------------------------------------------------------
# M13.3b-ii — OFFLINE DB PRE-LOAD SEAM (proposal §13.3b, owner decisions 2026-07-24).
#
# The Trivy vulnerability DB is BAKED into this image at build time (the fail-closed fallback, as
# stale as the image). When the commander maintains a fresher server-side DB cache it `docker cp`s
# that cache into this container and sets SCP_SCAN_DB_DIR — this shim then points Trivy at the
# PRE-LOADED DB instead of the baked default. UNCONDITIONALLY offline either way: `--skip-db-update
# --offline-scan` and `--network none` never change; the ONLY thing the pre-load changes is WHICH
# already-downloaded DB Trivy reads.
#
# FAIL CLOSED (owner 2026-07-24): if SCP_SCAN_DB_DIR is set but the pre-loaded DB is EMPTY/missing
# (no `<dir>/db/trivy.db`), we exit non-zero WITHOUT scanning — a configured-but-broken cache must
# never silently fall back to the (possibly very stale) baked DB and masquerade as a fresh scan. The
# commander already classifies staleness before dispatch; this is the second, in-container barrier.
if [ -n "${SCP_SCAN_DB_DIR:-}" ]; then
  if [ ! -f "$SCP_SCAN_DB_DIR/db/trivy.db" ]; then
    echo "scp-runner-scan: SCP_SCAN_DB_DIR is set ($SCP_SCAN_DB_DIR) but has no db/trivy.db — fail-closed (no scan)" >&2
    exit 5
  fi
  # TRIVY_CACHE_DIR is Trivy's own env for --cache-dir; exporting it points every `trivy` call in
  # this shim at the pre-loaded DB with no fragile argv construction. Trivy looks for the DB at
  # $TRIVY_CACHE_DIR/db/trivy.db — exactly the layout we validated above.
  export TRIVY_CACHE_DIR="$SCP_SCAN_DB_DIR"
fi

# SSG/OpenSCAP asymmetry (proposal §13.3b): SSG datastreams have NO OCI upstream to skopeo-refresh,
# so they stay BAKED. We still honor an OPTIONAL operator-supplied SCAP override dir: if
# SCP_SCAN_SCAP_DIR is set and carries a datastream of the requested basename, evaluate against that
# instead of the baked copy. Absent the override, the baked datastream (resolved in the openscap case
# below) is used unchanged.
if [ -n "${SCP_SCAN_SCAP_DIR:-}" ] && [ "$METHOD" = "openscap" ]; then
  _ds_base="$(basename "$DATASTREAM")"
  if [ -f "$SCP_SCAN_SCAP_DIR/$_ds_base" ]; then
    DATASTREAM="$SCP_SCAN_SCAP_DIR/$_ds_base"
  fi
fi

# ------------------------------------------------------------------------------------------------
# SHARED OCI-LAYOUT HELPERS — used by BOTH subject-materializing arms (`trivy-vm` resolves a disk
# blob out of the layout; `openscap` extracts a rootfs out of it). Defined once at top level rather
# than inside one `case` arm, so the two arms provably agree on how a layout is read.
# ------------------------------------------------------------------------------------------------

# Resolve the image-manifest blob digest (the one that HAS .layers) reachable from $1.
#   $1 = a manifest blob digest (sha256:hex). Prints the digest of a blob carrying .layers, or empty.
# Descends ONE level of index nesting, preferring linux/amd64 for a multi-arch layout (the server
# pulls with `skopeo copy --all`).
resolve_manifest() {
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

# Print the path of the resolved image-manifest blob, or exit 4 (fail-closed) if the layout carries
# none. Shared by both arms so "the subject was not copied in" reads identically in either.
resolve_manifest_blob() {
  if [ ! -f "$INPUT/index.json" ]; then
    echo "scp-runner-scan: $METHOD — no OCI index.json at $INPUT (subject not copied in?)" >&2
    exit 4
  fi
  _top="$(jq -r '.manifests[0].digest' "$INPUT/index.json")"
  _man="$(resolve_manifest "$_top")"
  if [ -z "$_man" ]; then
    echo "scp-runner-scan: $METHOD — could not resolve an image manifest from the OCI layout" >&2
    exit 4
  fi
  echo "$INPUT/blobs/sha256/${_man#sha256:}"
}

# Untar every layer of the manifest blob $1 into the directory $2 (in manifest order). GNU tar
# auto-detects gzip/uncompressed layers; a layer that fails to extract must not abort the whole scan
# (a single corrupt aux layer should not fail-open OR crash) — callers check the result is non-empty.
# Whiteouts are not replayed (a documented first-increment limitation).
extract_layers() {
  for _layer in $(jq -r '.layers[].digest' "$1"); do
    tar -xf "$INPUT/blobs/sha256/${_layer#sha256:}" -C "$2" 2>/dev/null || true
  done
}

# The RECOGNIZED machine-image disk extension for a file name, or "" (see the `trivy-vm` bounds in
# the header). A trailing `.gz` is stripped first — a gzip-compressed disk is still a disk.
disk_ext_of_name() {
  _n="$1"
  case "$_n" in *.gz) _n="${_n%.gz}" ;; esac
  case "$_n" in
    *.raw) echo raw ;;
    *.img) echo img ;;
    *.vmdk) echo vmdk ;;
    *) echo "" ;;
  esac
}

# The RECOGNIZED machine-image disk extension for an OCI layer mediaType, or "". Deliberately an
# EXACT match against the declared SCP machine-image media types — not a substring/wildcard test —
# so an arbitrary vendor mediaType can never be mistaken for a declared disk.
disk_ext_of_media_type() {
  case "$1" in
    application/vnd.scp.machine-image.disk.v1+raw|application/vnd.scp.machine-image.disk.v1+raw+gzip) echo raw ;;
    application/vnd.scp.machine-image.disk.v1+vmdk|application/vnd.scp.machine-image.disk.v1+vmdk+gzip) echo vmdk ;;
    *) echo "" ;;
  esac
}

case "$METHOD" in
  trivy)
    # --input scans the LOCAL OCI layout (no registry dial); --skip-db-update + --offline-scan pin
    # the run to the build-time-baked DB (no network). --format json emits the native result the
    # commander parses. --exit-code 0 unconditionally: this runner REPORTS findings, it does not gate
    # — the commander evaluates the counts against the resolved M17.5 threshold.
    # TRIVY_CACHE_DIR (exported above when SCP_SCAN_DB_DIR is set) points Trivy at the PRE-LOADED DB;
    # otherwise Trivy uses its baked default ($HOME/.cache/trivy). --skip-db-update + --offline-scan
    # hold UNCONDITIONALLY in both cases (no network, ever).
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

  trivy-vm)
    # THE MACHINE-IMAGE ARM (13.3a, D2). Resolve the disk carried by the OCI layout, then `trivy vm`
    # it. See the header for the two packaging forms and the supported-format bounds.
    DISKDIR=/work/disk
    mkdir -p "$DISKDIR"
    MAN_BLOB="$(resolve_manifest_blob)"

    DISK_COUNT=0
    DISK_BLOB=""
    DISK_EXT=""
    DISK_GZIP=0
    TAB="$(printf '\t')"

    # FORM 1 — a layer descriptor that IS the disk. The loop reads from a HERE-DOC (not a pipe) on
    # purpose: a POSIX `while` fed by a pipe runs in a SUBSHELL, and every assignment below would be
    # discarded — the resolution would silently see zero disks and fall through to form 2.
    while IFS="$TAB" read -r _dg _mt _title; do
      [ -n "$_dg" ] || continue
      _ext="$(disk_ext_of_media_type "$_mt")"
      _gz=0
      if [ -n "$_ext" ]; then
        case "$_mt" in *+gzip) _gz=1 ;; esac
      else
        # No declared machine-image mediaType — fall back to the descriptor's title annotation.
        _ext="$(disk_ext_of_name "$_title")"
        [ -n "$_ext" ] || continue
        case "$_title" in *.gz) _gz=1 ;; esac
      fi
      DISK_COUNT=$((DISK_COUNT + 1))
      DISK_BLOB="$INPUT/blobs/sha256/${_dg#sha256:}"
      DISK_EXT="$_ext"
      DISK_GZIP="$_gz"
    done <<EOF
$(jq -r '.layers[]? | [.digest, .mediaType, (.annotations["org.opencontainers.image.title"] // "")] | @tsv' "$MAN_BLOB")
EOF

    if [ "$DISK_COUNT" -gt 1 ]; then
      echo "scp-runner-scan: trivy-vm — AMBIGUOUS subject: $DISK_COUNT layers look like machine-image disks; refusing to guess (fail-closed)" >&2
      exit 4
    fi

    if [ "$DISK_COUNT" -eq 1 ]; then
      DISK="$DISKDIR/disk.$DISK_EXT"
      if [ "$DISK_GZIP" -eq 1 ]; then
        gzip -dc "$DISK_BLOB" > "$DISK"
      else
        # Hardlink the blob in place — a multi-GiB disk is never copied when the link succeeds.
        ln "$DISK_BLOB" "$DISK" 2>/dev/null || cp "$DISK_BLOB" "$DISK"
      fi
    else
      # FORM 2 — no disk descriptor: treat the layers as ordinary image tars and look inside.
      ROOTFS=/work/rootfs
      mkdir -p "$ROOTFS"
      extract_layers "$MAN_BLOB" "$ROOTFS"
      if [ -z "$(ls -A "$ROOTFS" 2>/dev/null)" ]; then
        echo "scp-runner-scan: trivy-vm — no machine-image disk layer, and no layer unpacked as a tar (fail-closed)" >&2
        exit 4
      fi
      FOUND="$(find "$ROOTFS" -type f \( -name '*.raw' -o -name '*.img' -o -name '*.vmdk' \
                 -o -name '*.raw.gz' -o -name '*.img.gz' -o -name '*.vmdk.gz' \) 2>/dev/null)"
      FOUND_COUNT="$(printf '%s\n' "$FOUND" | grep -c . || true)"
      if [ "$FOUND_COUNT" -ne 1 ]; then
        echo "scp-runner-scan: trivy-vm — expected exactly ONE machine-image disk file in the extracted layers, found $FOUND_COUNT (fail-closed)" >&2
        exit 4
      fi
      SRC="$(printf '%s\n' "$FOUND" | head -n1)"
      DISK_EXT="$(disk_ext_of_name "$(basename "$SRC")")"
      DISK="$DISKDIR/disk.$DISK_EXT"
      case "$SRC" in
        *.gz) gzip -dc "$SRC" > "$DISK" ;;
        *) ln "$SRC" "$DISK" 2>/dev/null || cp "$SRC" "$DISK" ;;
      esac
    fi

    if [ ! -s "$DISK" ]; then
      echo "scp-runner-scan: trivy-vm — resolved disk '$DISK' is empty (fail-closed)" >&2
      exit 4
    fi
    echo "scp-runner-scan: trivy-vm — scanning machine image $DISK"

    # `trivy vm` takes the disk POSITIONALLY (there is no --input for this subcommand). Same offline
    # discipline and same non-gating exit code as the `trivy` arm: --skip-db-update + --offline-scan
    # pin the run to the baked-or-pre-loaded DB (TRIVY_CACHE_DIR, exported above), and --exit-code 0
    # means this runner REPORTS findings — the commander evaluates them against the M17.5 threshold.
    trivy vm \
      --format json \
      --skip-db-update \
      --offline-scan \
      --scanners vuln \
      --exit-code 0 \
      --output "$OUTDIR/result.json" \
      "$DISK"
    trivy version > "$OUTDIR/scanner-version.txt" 2>/dev/null || true
    echo "scp-runner-scan: trivy-vm scan complete — result at /work/out/result.json"
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

    MAN_BLOB="$(resolve_manifest_blob)"
    extract_layers "$MAN_BLOB" "$ROOTFS"

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
    echo "scp-runner-scan: unknown method '$METHOD' (expected trivy|trivy-vm|openscap)" >&2
    exit 2
    ;;
esac
