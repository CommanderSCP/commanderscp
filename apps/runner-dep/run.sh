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
# ...OR, when the orchestrator supplies an ANCHOR (argv[6]/argv[7], M21.7): edit the line the anchor
# ADDRESSES, provided the file's own bytes on that line still equal the anchor text, that line
# carries the version to replace, and the coordinate rule above does not disagree — meaning no line
# names both, or the only one that does IS the anchor line. That widening exists because Helm's
# commonest image spelling puts the coordinate and the version on different lines
# (`repository: acme/api` above `tag: 1.2.3`), and for `{registry, repository, tag}` the coordinate
# is a construction that appears nowhere in the file at all. The anchor SELECTS; the coordinate rule
# keeps a VETO, so the anchored mode can only widen where the textual rule was silent.
#
# THE ANCHOR TEXT IS COMPARED, NEVER EMITTED. The output line is always rebuilt from lines[] by
# substr() out of the file's own bytes, so a wrong anchor can only make this script REFUSE.
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
#          $6 = anchorLine   (OPTIONAL, 1-based; the line to edit when the coordinate is not on it)
#          $7 = anchorText   (OPTIONAL, required with $6; that line's bytes, compared not written)
#   /work/in/manifest  — the ONE file, `docker cp`'d in. Nothing else is read.
#   /work/out/manifest — the edited copy, `docker cp`'d back out. Nothing else is written.
#
# VERSION SKEW IS FAIL-CLOSED IN BOTH DIRECTIONS, and that is why the anchor is a trailing OPTIONAL
# pair rather than a change to the existing five:
#
#   old image + new orchestrator (7 operands) — $6/$7 are ignored, the coordinate rule runs, and the
#     bytes are IDENTICAL for every contiguous shape. A split shape gets exit 3 (a refusal), which is
#     what this image did for it before the anchor existed.
#   new image + old orchestrator (5 operands) — $6 is unset, so no anchor is supplied and the
#     coordinate rule runs unchanged.
#
# A missing $6 therefore has to mean NOT SUPPLIED and never line 0: `${6:-}` guards it exactly as the
# five required arguments are guarded, and an empty value takes the unanchored path.
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
# OPTIONAL, and absence is not an error — see "VERSION SKEW" above. Guarded with `${n:-}` so an
# unset positional is the empty string rather than an unbound-variable abort under `set -u`.
ANCHOR_LINE="${6:-}"
ANCHOR_TEXT="${7:-}"

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

# THE ANCHOR IS ALL OR NOTHING. Half an anchor is a caller defect, and proceeding on one would mean
# either editing a line whose bytes nobody checked ($6 alone) or silently discarding an address the
# caller believed it had sent ($7 alone). A line number is validated as DIGITS ONLY with no leading
# zero, which refuses `0`, `-1`, `1.5`, `1e9` and ` 7` without any arithmetic — busybox `test -ge`
# on a caller-supplied 30-digit string is its own hazard, and there is nothing here that needs it.
if [ -n "$ANCHOR_LINE" ] || [ -n "$ANCHOR_TEXT" ]; then
  [ -n "$ANCHOR_LINE" ] ||
    fail "argv[7] (anchorText) was given without argv[6] (anchorLine) — half an anchor is refused"
  [ -n "$ANCHOR_TEXT" ] ||
    fail "argv[6] (anchorLine) was given without argv[7] (anchorText) — half an anchor is refused"
  case "$ANCHOR_LINE" in
    0* | *[!0-9]*)
      fail "argv[6] (anchorLine) '$ANCHOR_LINE' is not a 1-based line number"
      ;;
  esac
fi

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

# THE EDIT. The FIVE tenant-supplied strings are passed as awk OPERANDS rather than through `-v`,
# deliberately: `-v` processes escape sequences in the value, so a coordinate, a version or an
# anchor text containing a backslash would arrive as something other than what the manifest holds.
# Operands are taken verbatim. They are blanked in BEGIN so awk does not then try to read them as
# input files — which is ALSO what immunises them against awk's `name=value` operand-assignment
# rule, since operand processing happens after BEGIN runs and by then they are all empty. The anchor
# text goes through the same door for the same reason: it is compared byte-for-byte against a line
# of somebody else's manifest, so any transformation of it on the way in is a false refusal.
#
# Matching and replacement are by index()/substr() — never by regex and never by sub() — because a
# coordinate is arbitrary tenant text (`@acme/lib`, `github.com/acme/lib`, `com.acme:lib`) and a
# declared version is too (`^1.2.3`, `~=1.4`, `3.18-alpine`). Treating either as a pattern is how a
# `.` or a `+` silently matches a line this bump was never about.
awk '
BEGIN {
  coordinate = ARGV[1]; from = ARGV[2]; to = ARGV[3];
  anchor_line = ARGV[4]; anchor_text = ARGV[5];
  ARGV[1] = ""; ARGV[2] = ""; ARGV[3] = ""; ARGV[4] = ""; ARGV[5] = "";
  # AN EMPTY anchor_line MEANS NOT SUPPLIED, NEVER LINE 0. The shell already refused a `0`, a
  # non-digit and a leading zero, so anything non-empty here is a 1-based line number.
  anchored = (anchor_line != "");
  anchor_nr = anchor_line + 0;
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
  if (anchored) {
    # (a) THE ANCHOR ADDRESSES THE BYTES IT WAS DERIVED FROM. A line number alone would be a
    # confidently wrong edit the moment the file moved under it; the text equality is what makes a
    # stale anchor a refusal instead.
    #
    # THIS ONE COMPARISON IS ALSO THE RANGE CHECK, and that is worth stating because a separate
    # `anchor_nr > NR` guard stood here and was DEAD CODE — no mutation killed it, on either awk.
    # An out-of-range subscript reads as the empty string, and anchor_text is guaranteed non-empty
    # by the all-or-nothing check in the shell above, so `lines[999] != anchor_text` is already
    # false for the right reason. Measured rather than reasoned about: with the guard removed, both
    # a 4 on a 3-line file and a 20-digit line number refuse identically under the host awk AND
    # under the BusyBox awk this image actually runs (which clamps `%d` at 2147483647 where the host
    # clamps at 2^63-1 — neither WRAPS, so neither can land on a line the file has). run.sh is small
    # enough to audit by reading, and a guard that reads as protection while protecting nothing is
    # worse here than none. runner-shim.test.ts pins both cases against the reference edit: a
    # shim that folded an out-of-range anchor back into the file with a modulo reddens the line-99
    # case, and the 20-digit case keeps the clamp measurement rather than leaving it in a comment.
    #
    # NOTE FOR ANY FUTURE EDIT OF THIS BLOCK: the awk program is a single-quoted shell string, so an
    # apostrophe anywhere in these comments ends it. That is why they read a little stiffly.
    if (lines[anchor_nr] != anchor_text) {
      # NR is named here so an out-of-range anchor still reads as one: "line 999 of a 12-line
      # manifest" is the diagnosis the deleted range guard used to print, kept without the branch.
      printf("scp-runner-dep: line %d of the manifest (%d lines) is not the anchor text the descriptor carries\n", anchor_nr, NR) > "/dev/stderr";
      exit 3;
    }
    # (b) ...and it carries the version this bump replaces.
    if (index(lines[anchor_nr], from) == 0) {
      printf("scp-runner-dep: line %d does not carry the declared version this bump replaces\n", anchor_nr) > "/dev/stderr";
      exit 3;
    }
    # (c) THE COORDINATE RULE KEEPS A VETO. Where NO line names both the coordinate and the declared
    # version the rule is silent and the anchor fills the gap — that is the whole widening. Where it
    # DOES speak, the anchor must agree with it, so every refusal the unanchored rule fires still
    # fires and nothing that worked before gets weaker.
    if (candidates > 1 || (candidates == 1 && target != anchor_nr)) {
      printf("scp-runner-dep: %d line(s) name both the coordinate and its declared version and the anchor (line %d) is not the one\n", candidates, anchor_nr) > "/dev/stderr";
      exit 3;
    }
    target = anchor_nr;
  } else {
    # EXACTLY ONE line must both name the coordinate and carry the declared version. Zero means the
    # manifest disagrees with the inventory the descriptor was built from; more than one means the
    # edit target is ambiguous, and choosing here would be a guess about which declaration the
    # subscriber meant. Both are refusals, and both are the same rule `applyManifestBump` applies.
    if (candidates != 1) {
      printf("scp-runner-dep: %d lines in the manifest name both the coordinate and its declared version (exactly 1 required)\n", candidates) > "/dev/stderr";
      exit 3;
    }
  }
  at = index(lines[target], from);
  lines[target] = substr(lines[target], 1, at - 1) to substr(lines[target], at + length(from));
  for (i = 1; i <= NR; i++) printf("%s\n", lines[i]);
}
' "$COORDINATE" "$FROM_VERSION" "$TO_VERSION" "$ANCHOR_LINE" "$ANCHOR_TEXT" "$IN" > "$OUT.tmp" ||
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
