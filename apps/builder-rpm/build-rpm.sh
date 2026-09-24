#!/bin/sh
# scp-build-rpm <spec> <upload-url> <commit>
#
# THE BUILD STEP OF `scp-build-rpm-v1` (M28.1, ADR-0053): SRPM from the spec, RPM from the SRPM,
# then a PUT of each binary RPM to the package-repo destination SCP derived. Baked into the image
# rather than inlined in the WorkflowTemplate so the script that ships is the script the
# real-counterparty test runs (`rpm-build-lane.integration.test.ts`) — an inlined script can only be
# tested by extracting it from rendered YAML, which is a test of the extraction.
#
# Inputs, all positional so no parameter value is ever parsed as shell source:
#   $1  the spec path, relative to the checkout (the component's `properties.rpmSpec`)
#   $2  the upload URL (`rpmUploadUrl` — assembled by SCP, never here: a template that concatenates
#       one gets a WRONG URL, not an error)
#   $3  the commit the checkout is at, for the log
# Environment: SCP_SOURCE_DIR (default /work/src), SCP_WORK_DIR (default /work), and
# REGISTRY_USERNAME / REGISTRY_PASSWORD from the operator's Secret.
set -eu

spec_rel="${1:?usage: scp-build-rpm <spec> <upload-url> <commit>}"
upload_url="${2:?usage: scp-build-rpm <spec> <upload-url> <commit>}"
commit="${3:-unknown}"
src="${SCP_SOURCE_DIR:-/work/src}"
work="${SCP_WORK_DIR:-/work}"

# CREDENTIALS FIRST, before the expensive step — the image template's rule: refusing to build a
# package that cannot be published beats failing after it is built.
if [ -z "${REGISTRY_USERNAME:-}" ] || [ -z "${REGISTRY_PASSWORD:-}" ]; then
  echo "no package-registry credentials (registryUsername/registryPassword) — refusing to build" >&2
  echo "an RPM that cannot be published, rather than failing after the expensive step" >&2
  exit 2
fi

spec="${src}/${spec_rel}"
[ -f "$spec" ] || {
  echo "no ${spec_rel} in this repository at ${commit}. Set the component's properties.rpmSpec to" >&2
  echo "the spec's path relative to the repository root (a monorepo usually needs to)." >&2
  exit 2
}

# rpmbuild writes its own macros/cache under $HOME and its scriptlets under `_tmppath` (default
# /var/tmp); the root filesystem is read-only, so both are the workspace — found by running it
# read-only and reading what it was denied. `_topdir` keeps every other rpmbuild path there too.
export HOME="${work}/home"
# TMPDIR too: `find-debuginfo` mktemps under it (default /tmp), measured failing read-only without.
export TMPDIR="${work}/tmp"
top="${work}/rpmbuild"
mkdir -p "$HOME" "$work/tmp" "$top/SOURCES" "$top/SPECS" "$top/SRPMS" "$top/RPMS" "$top/BUILD"
set -- --define "_topdir $top" --define "_tmppath $work/tmp"

name=$(rpmspec -q --srpm --qf '%{name}' "$spec")
version=$(rpmspec -q --srpm --qf '%{version}' "$spec")

# SOURCES. Everything beside the spec (patches, extra sources) first; then any `SourceN:` still
# missing is produced from the checked-out tree in the conventional `<name>-<version>/` layout that
# `%setup`/`%autosetup` expect. `rpmspec -P` expands macros, so `%{name}-%{version}.tar.gz` arrives
# as a literal filename. A missing source that is not a tarball cannot be produced, and says so.
spec_dir=$(dirname "$spec")
find "$spec_dir" -maxdepth 1 -type f ! -name '*.spec' -exec cp -p {} "$top/SOURCES/" \;
rpmspec -P "$spec" | sed -n 's/^Source[0-9]*:[[:space:]]*//p' | while read -r source; do
  file=$(basename "$source")
  [ -e "$top/SOURCES/$file" ] && continue
  case "$file" in
    *.tar.gz | *.tgz)
      tar -C "$src" --exclude=.git --transform "s,^\.,${name}-${version}," -czf "$top/SOURCES/$file" .
      echo "produced source $file from the tree at ${commit}"
      ;;
    *)
      echo "source '$file' is neither beside the spec nor a tarball this template can produce" >&2
      exit 2
      ;;
  esac
done

# SRPM, then the RPM FROM THE SRPM rather than from the spec directly. Rebuilding the SRPM proves it
# is self-contained — the artifact a reviewer can rebuild is the one the binary came from.
rpmbuild "$@" -bs "$spec"
srpm=$(find "$top/SRPMS" -name '*.src.rpm' | head -n 1)
[ -n "$srpm" ] || { echo "rpmbuild -bs produced no SRPM" >&2; exit 1; }
echo "built $(basename "$srpm")"
rpmbuild "$@" --rebuild "$srpm"

rpms=$(find "$top/RPMS" -name '*.rpm' | sort)
[ -n "$rpms" ] || { echo "rpmbuild --rebuild produced no binary RPM" >&2; exit 1; }

# PUBLISH. One PUT per binary RPM. `--fail-with-body` so a refusal prints the registry's own reason
# (Gitea answers 409 when that NEVRA already exists — an RPM version is immutable, so a rebuild of
# the same version is a packaging error to fix in the spec's Release, not a retry to swallow).
# The password travels in a netrc file, never on the command line, so it is not in `ps` output.
umask 077
netrc="${HOME}/.netrc"
trap 'rm -f "$netrc"' EXIT
upload_host=$(printf '%s' "$upload_url" | sed -e 's,^[a-zA-Z]*://,,' -e 's,[/:].*$,,')
printf 'machine %s login %s password %s\n' "$upload_host" "$REGISTRY_USERNAME" "$REGISTRY_PASSWORD" > "$netrc"
for rpm in $rpms; do
  if ! curl --fail-with-body --silent --show-error --netrc-file "$netrc" \
    --upload-file "$rpm" "$upload_url"; then
    echo >&2
    echo "the package registry refused $(basename "$rpm") (its reason is above). A 409 means this" >&2
    echo "exact version is already published: bump Release in the spec rather than retrying." >&2
    exit 1
  fi
  echo
  echo "published $(basename "$rpm") to ${upload_url}"
done
