#!/bin/sh
#
# scp-runner-dep's run shim (charter `scp-managed-dep` amendment 2026-08-13, qualified 2026-08-15;
# ADR-0032 §8). The ENTRYPOINT of an image that carries nothing but BusyBox — deliberately a small,
# auditable shell script and not a Node app, in the same spirit as apps/runner-iac/run.sh and
# apps/runner-scan/run.sh.
#
# `set -eu`: any failed step aborts rather than emitting a partial file a caller might push. There
# is no `pipefail` in POSIX sh, and there are no pipelines below whose failure could be swallowed.
# Never `set -x` — no argv-tracing habit, even though nothing secret is ever passed here (this
# container holds NO credential at all; the orchestrator holds it and reaches the git host).
#
# ============================================================================================
# WHAT THIS DOES, AND WHY IT IS ALLOWED TO BE THIS SMALL
# ============================================================================================
# The charter defines the class as "editing the declared version of an already-declared dependency
# in a manifest the component already contains", and forbids resolving anything. So the edit is not
# a package-manager operation and does not need one:
#
#   find the ONE line that names the coordinate AND carries the version the manifest declares
#   today, and replace the FIRST occurrence of that version token on that line.
#
# That is the whole transform, it is ecosystem-agnostic, and it is byte-for-byte the reference edit
# `packages/plugins/managed-dep/src/bump-edit.ts`'s `applyManifestBump` performs — which is what the
# orchestrator's own tests use as a stand-in for this container, and what
# `packages/plugins/managed-dep/src/runner-shim.test.ts` pins this file against by running BOTH over
# the same fixtures. A divergence between them is a test failure, not a surprise in production.
#
# $1 (ecosystem) IS DELIBERATELY NOT BRANCHED ON. It is validated (so an unknown value fails loudly
# rather than being ignored) and then unused: the transform above is identical for all five, and a
# per-ecosystem arm here would be a second, drifting parser of somebody else's manifest format
# living in the one component that must be small enough to audit by reading. The ecosystem-specific
# knowledge lives where it is already needed — the server composes `toVersion` in the declaration's
# own grammar, and the orchestrator's two verifiers (`verifyManifestBump`, `verifyManifestOnlyEdit`)
# re-check the returned bytes against the descriptor AND against a parse of the document before
# anything is pushed.
#
# $2 (the repo-relative manifest path) IS NEVER OPENED. It is carried for the error messages only —
# the subject is always /work/in/manifest, which is what the orchestrator `docker cp`'d in. This
# container has no repository, so a path here could only ever address the container's own
# filesystem, and refusing to treat it as a path is what keeps that true.
#
# ============================================================================================
# THE CONTRACT WITH THE ORCHESTRATOR (packages/plugins/managed-dep/src/index.ts)
# ============================================================================================
#   argv:  $1 = ecosystem (go|oci|npm|python|maven — validated, not branched on)
#          $2 = manifestPath (repo-relative, for messages only — never opened)
#          $3 = coordinate   (the ecosystem-native coordinate, verbatim)
#          $4 = fromVersion  (what the manifest literally says today)
#          $5 = toVersion    (what it must say afterwards)
#   /work/in/manifest  — the ONE file, `docker cp`'d in. Nothing else is read.
#   /work/out/manifest — the edited copy, `docker cp`'d back out. Nothing else is written.
#
# The container is launched `--network none` with no environment, no bind mount and no docker
# socket, and is `rm -f`'d the moment it exits. It therefore cannot fetch a dependency graph, cannot
# reach a host, and cannot persist anything: the ORCHESTRATOR is what writes to the repository, and
# only after its verifiers agree with these bytes.

set -eu

ECOSYSTEM="${1:-}"
MANIFEST_PATH="${2:-}"
COORDINATE="${3:-}"
FROM_VERSION="${4:-}"
TO_VERSION="${5:-}"

# THE SUBJECT AND THE RESULT, RESOLVED AGAINST THE WORKING DIRECTORY — which the Dockerfile fixes as
# `WORKDIR /work`, so in the container these are exactly /work/in/manifest and /work/out/manifest.
#
# Written relative rather than absolute for one reason and it is a testing one worth stating: it lets
# `packages/plugins/managed-dep/src/runner-shim.test.ts` run THIS FILE — not a copy of it, and not a
# reimplementation — over the same fixtures as `bump-edit.ts`'s reference edit and require identical
# bytes. Every other test in that package uses the reference as a stand-in for this container, so
# without that comparison the whole orchestrator suite rests on an unchecked claim that the two agree.
# It is NOT an operator seam: nothing sets the working directory but the image's own WORKDIR, and no
# environment variable is read here at all.
IN=in/manifest
OUT=out/manifest

fail() {
  echo "scp-runner-dep: $1" >&2
  exit 1
}

# Every argument is REQUIRED. A missing one is a caller defect, and defaulting any of them would
# turn it into a silent edit of the wrong thing.
[ -n "$ECOSYSTEM" ] || fail "argv[1] (ecosystem) is required"
[ -n "$MANIFEST_PATH" ] || fail "argv[2] (manifestPath) is required"
[ -n "$COORDINATE" ] || fail "argv[3] (coordinate) is required"
[ -n "$FROM_VERSION" ] || fail "argv[4] (fromVersion) is required"
[ -n "$TO_VERSION" ] || fail "argv[5] (toVersion) is required"

# Validated so an unrecognised value fails LOUDLY here rather than being silently accepted by a
# transform that happens not to read it — see "$1 IS DELIBERATELY NOT BRANCHED ON" above.
case "$ECOSYSTEM" in
  go|oci|npm|python|maven) : ;;
  *) fail "unknown ecosystem '$ECOSYSTEM' (expected go|oci|npm|python|maven)" ;;
esac

[ "$FROM_VERSION" != "$TO_VERSION" ] ||
  fail "fromVersion and toVersion are both '$FROM_VERSION' — there is no bump to author"

[ -f "$IN" ] || fail "no manifest was copied in at $IN (subject: '$MANIFEST_PATH')"

# DOES THE INPUT END IN A NEWLINE? `$(...)` strips every trailing newline, so an empty result means
# the last byte was one. This is recorded BEFORE the edit and restored after it, because awk always
# terminates its last output record with a newline — and a manifest that gained or lost a trailing
# newline is a LINE-COUNT change, which the orchestrator's verifier refuses outright
# (`line_count_changed`). Byte-exactness here is not tidiness: it is the difference between a bump
# that is delivered and one that is refused for a reason nobody could act on.
if [ -n "$(tail -c 1 "$IN")" ]; then
  TRAILING_NEWLINE=0
else
  TRAILING_NEWLINE=1
fi

# THE EDIT. The three tenant-supplied strings are passed as awk OPERANDS rather than through `-v`,
# deliberately: `-v` processes escape sequences in the value, so a coordinate or version containing
# a backslash would arrive as something other than what the manifest holds. Operands are taken
# verbatim. They are blanked in BEGIN so awk does not then try to read them as input files.
#
# Matching and replacement are by index()/substr() — never by regex and never by sub() — because a
# coordinate is arbitrary tenant text (`@acme/lib`, `github.com/acme/lib`, `com.acme:lib`) and a
# declared version is too (`^1.2.3`, `~=1.4`, `3.18-alpine`). Treating either as a pattern is how a
# `.` or a `+` silently matches a line this bump was never about.
awk '
BEGIN {
  coordinate = ARGV[1]; from = ARGV[2]; to = ARGV[3];
  ARGV[1] = ""; ARGV[2] = ""; ARGV[3] = "";
  candidates = 0;
}
{
  lines[NR] = $0;
  if (index($0, coordinate) > 0 && index($0, from) > 0) {
    candidates++;
    target = NR;
  }
}
END {
  # EXACTLY ONE line must both name the coordinate and carry the declared version. Zero means the
  # manifest disagrees with the inventory the descriptor was built from; more than one means the
  # edit target is ambiguous, and choosing here would be a guess about which declaration the
  # subscriber meant. Both are refusals, and both are the same rule `applyManifestBump` applies.
  if (candidates != 1) {
    printf("scp-runner-dep: %d lines in the manifest name both the coordinate and its declared version (exactly 1 required)\n", candidates) > "/dev/stderr";
    exit 3;
  }
  at = index(lines[target], from);
  lines[target] = substr(lines[target], 1, at - 1) to substr(lines[target], at + length(from));
  for (i = 1; i <= NR; i++) printf("%s\n", lines[i]);
}
' "$COORDINATE" "$FROM_VERSION" "$TO_VERSION" "$IN" > "$OUT.tmp" ||
  fail "could not apply the bump to '$MANIFEST_PATH'"

if [ "$TRAILING_NEWLINE" = "0" ]; then
  # Drop the newline awk added after the final record, restoring the input's own byte shape.
  SIZE=$(wc -c < "$OUT.tmp")
  head -c "$((SIZE - 1))" "$OUT.tmp" > "$OUT"
  rm -f "$OUT.tmp"
else
  mv "$OUT.tmp" "$OUT"
fi

echo "scp-runner-dep: edited '$MANIFEST_PATH' — $COORDINATE $FROM_VERSION -> $TO_VERSION"
