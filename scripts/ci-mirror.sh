#!/usr/bin/env bash
# ================================================================================================
# THE CI IMAGE MIRROR — one reader for tools/ci-mirror/images.list, used by every job that needs it
# ================================================================================================
#
# Charter principle 5 ("Everything, CI included, must run offline") and the working convention
# "Tests never touch the internet". Read tools/ci-mirror/images.list first — it carries the format,
# the per-consumer reasoning, and the pin-bump procedure. This script is only the mechanism.
#
# MODES
#   push        Mirror every manifest entry into ghcr.io/commanderscp/mirror (workflow job 4d).
#               Idempotent and cache-keyed on the UPSTREAM DIGEST, so a bumped pin re-mirrors and an
#               unchanged one costs one HEAD-shaped `docker pull` of a ref that already exists.
#   seed        Prepare a job to run the suite entirely off the mirror (workflow job 5): pull each
#               mirrored image and `docker tag` it back to the literal alias the tests name, then
#               export the env vars the non-taggable consumers read (see images.list, "HOW EACH
#               CONSUMER REACHES THE MIRROR"). Env exports go to $GITHUB_ENV when set.
#   blackhole   Point every mirrored upstream registry at 127.0.0.1 in /etc/hosts, so a test that
#               reaches Docker Hub or quay.io FAILS LOUDLY AND IMMEDIATELY instead of succeeding on
#               a connected runner and flaking on a bad day. This is what makes "CI runs offline" a
#               checked property rather than an aspiration — see ENFORCEMENT below.
#   print       Dump the resolved (upstream, alias, mirror ref) triples. For humans and for
#               debugging; no daemon or network involved.
#
# ENFORCEMENT, AND ITS LIMITS
#   `blackhole` is deliberately narrow: it denies exactly the registries this manifest mirrors, not
#   "the internet". A CI job legitimately reaches github.com, the npm registry and the Ubuntu
#   archive long before the test step, and severing those would test the runner, not the product.
#   What it does buy is the exact failure this exists to stop: an image pull that silently depends on
#   an outside registry now cannot pass, on any run, rather than passing until Docker Hub 502s.
#   The static half of the gate — "every image a test names is in this manifest" — lives in
#   `deploy/airgap/src/ci-offline-mirror.test.ts` and runs in the unit tier, with no daemon at all.
#
# Usage: scripts/ci-mirror.sh {push|seed|blackhole|print}
set -euo pipefail

MIRROR_NAMESPACE="ghcr.io/commanderscp/mirror"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
manifest="${repo_root}/tools/ci-mirror/images.list"

# The pin files whose variables images.list may reference. Sourced so a pin that already has a
# single source of truth is never re-typed into the manifest (and therefore cannot drift from it).
# shellcheck source=../tools/skopeo/pin.env
. "${repo_root}/tools/skopeo/pin.env"
# shellcheck source=../tools/cosign/pin.env
. "${repo_root}/tools/cosign/pin.env"
# shellcheck source=../tools/node/pin.env
. "${repo_root}/tools/node/pin.env"

# The pin variables images.list is allowed to reference. Listed explicitly rather than expanded
# blindly so a typo in the manifest is a hard failure, not an empty substitution that would mirror
# a ref like `@sha256:` and only be noticed as a confusing registry error much later.
PIN_VARS="SKOPEO_PINNED_IMAGE SKOPEO_PINNED_VERSION COSIGN_PINNED_IMAGE COSIGN_PINNED_VERSION NODE_PINNED_IMAGE NODE_PINNED_VERSION"
for _pin in ${PIN_VARS}; do
  if [ -z "${!_pin-}" ]; then
    echo "FATAL: ${_pin} is not set — a tools/*/pin.env this script sources has changed shape" >&2
    exit 1
  fi
done

expand_pins() {
  local s="$1" name
  for name in ${PIN_VARS}; do
    s="${s//\$\{${name}\}/${!name}}"
  done
  case "${s}" in
    *'${'*)
      echo "FATAL: ${manifest}: unresolved variable reference in '${s}'" >&2
      exit 1
      ;;
  esac
  printf '%s' "${s}"
}

# The alias names the image the way its CONSUMER does, which for a non-Docker-Hub image includes the
# registry host (`quay.io/keycloak/keycloak:26.0`). The mirror repo is that with the host removed —
# a first path component is a host iff it contains a `.` or a `:`, the same rule the OCI
# distribution spec's reference grammar uses.
mirror_repo_of() {
  local alias_repo="$1" first="${1%%/*}"
  case "${first}" in
    *.* | *:*) alias_repo="${alias_repo#*/}" ;;
  esac
  printf '%s/%s' "${MIRROR_NAMESPACE}" "${alias_repo}"
}

# Every host that must be reachable to pull from a given registry — the registry itself plus the
# auth/CDN endpoints its clients follow. Anything unlisted blackholes just its own host.
blackhole_hosts_of() {
  case "$1" in
    docker.io)
      echo "docker.io index.docker.io registry-1.docker.io auth.docker.io production.cloudflare.docker.com"
      ;;
    quay.io) echo "quay.io cdn.quay.io cdn01.quay.io cdn02.quay.io cdn03.quay.io" ;;
    *) echo "$1" ;;
  esac
}

# Walk the manifest, resolving each line, and invoke `handle_entry` with the resolved fields.
# Fields: upstream_ref alias mirror_id_ref mirror_alias_ref upstream_registry
for_each_entry() {
  local upstream alias rest hex alias_repo alias_tag repo id_ref alias_ref registry
  while read -r upstream alias rest || [ -n "${upstream}" ]; do
    case "${upstream}" in "" | \#*) continue ;; esac
    if [ -n "${rest}" ]; then
      echo "FATAL: ${manifest}: expected exactly two fields, got a third ('${rest}')" >&2
      exit 1
    fi
    upstream="$(expand_pins "${upstream}")"
    alias="$(expand_pins "${alias}")"
    case "${upstream}" in
      *@sha256:*) : ;;
      *)
        echo "FATAL: ${manifest}: '${upstream}' is not digest-pinned (a tag is not an identity)" >&2
        exit 1
        ;;
    esac
    hex="${upstream##*@sha256:}"
    registry="${upstream%%/*}"
    alias_repo="${alias%:*}"
    alias_tag="${alias##*:}"
    repo="$(mirror_repo_of "${alias_repo}")"
    id_ref="${repo}:sha256-${hex}"
    alias_ref="${repo}:${alias_tag}"
    handle_entry "${upstream}" "${alias}" "${id_ref}" "${alias_ref}" "${registry}"
  done < "${manifest}"
}

mode="${1:-}"

case "${mode}" in
  push)
    handle_entry() {
      local upstream="$1" id_ref="$3" alias_ref="$4"
      # The cache key is the DIGEST-derived tag, so bumping a pin in images.list is a cache MISS and
      # the new bytes really are fetched. Keying on the upstream tag (as this did before) made a
      # bumped pin a permanent cache HIT that kept serving the old image under the new pin's name.
      if docker pull "${id_ref}" >/dev/null 2>&1; then
        echo "cache hit: ${id_ref}"
      else
        echo "cache miss: mirroring ${upstream} -> ${id_ref}"
        docker pull "${upstream}"
        docker tag "${upstream}" "${id_ref}"
        docker push "${id_ref}"
      fi
      # The human-readable alias tag, refreshed on every run: it is a POINTER to whatever digest the
      # manifest currently pins, which is what makes it safe to consume by tag (skopeo sources read
      # it — see images.list consumer form 2). It cannot move except by a pin bump in this repo.
      # Costs nothing when unchanged: every blob is already in the registry.
      docker tag "${id_ref}" "${alias_ref}"
      docker push "${alias_ref}" >/dev/null
    }
    for_each_entry
    ;;

  seed)
    skopeo_ref=""
    cosign_ref=""
    node_ref=""
    handle_entry() {
      local upstream="$1" alias="$2" id_ref="$3" alias_ref="$4" skip
      # SCP_SEED_SKIP: space-separated aliases (or alias repos, tag omitted) a job declares it will
      # NEVER consume, so it need not spend wall clock pulling them — job 5's shards skip
      # `kindest/node` (~1.27 GB that only job 4e's cluster uses; ~15s/shard measured 2026-08-31).
      # FAIL-CLOSED BY CONSTRUCTION: every job that seeds selectively also runs `blackhole`, so a
      # wrongly-skipped image cannot be quietly pulled upstream — the consumer fails loudly and the
      # fix is to remove the entry from SCP_SEED_SKIP, never to move the blackhole. Skipping an
      # entry whose ref seed must export (the pinned CLI tools, the Node base) trips the FATAL
      # check below rather than exporting an unseeded ref.
      for skip in ${SCP_SEED_SKIP:-}; do
        if [ "${alias}" = "${skip}" ] || [ "${alias%:*}" = "${skip}" ]; then
          echo "seed: skipping ${alias} (SCP_SEED_SKIP)"
          return 0
        fi
      done
      docker pull "${id_ref}"
      # Re-tag to the exact literal the test names. Testcontainers and `docker create` both skip
      # their own pull when the tag already resolves locally, so no test file changes for this form.
      docker tag "${id_ref}" "${alias}"
      # ALSO re-tag to the mirror alias ref itself: the consumers that read an exported ref (the
      # two installer scripts' `docker create`, measured at ~0.8s of redundant manifest-only pull
      # each when only the alias string missed the local store) then find it locally too. The
      # fail-closed `cosign version`/`skopeo --version` assertions in the installers still run, so
      # a mirror alias that had drifted from its digest is still caught at the version gate.
      docker tag "${id_ref}" "${alias_ref}"
      # The pinned images are identified by their PIN, not by a hardcoded repo name here, so
      # renaming a mirror path cannot silently stop pointing the installers at the mirror.
      [ "${upstream}" = "${SKOPEO_PINNED_IMAGE}" ] && skopeo_ref="${alias_ref}"
      [ "${upstream}" = "${COSIGN_PINNED_IMAGE}" ] && cosign_ref="${alias_ref}"
      [ "${upstream}" = "${NODE_PINNED_IMAGE}" ] && node_ref="${alias_ref}"
      return 0
    }
    for_each_entry

    if [ -z "${skopeo_ref}" ] || [ -z "${cosign_ref}" ] || [ -z "${node_ref}" ]; then
      echo "FATAL: images.list no longer mirrors the pinned skopeo, cosign and/or node image (or SCP_SEED_SKIP excluded one of them)" >&2
      exit 1
    fi

    env_out="${GITHUB_ENV:-/dev/stdout}"
    {
      # Consumer form 2: the registry+namespace prefix the scan-subject suites build their skopeo
      # `docker://` sources from. Unset (local dev) they default to docker.io/library.
      echo "SCP_TEST_SUBJECT_REGISTRY=${MIRROR_NAMESPACE}"
      # Consumer form 3: a `docker create <repo>@sha256:…` cannot be served by a local tag, so the
      # installers take their image ref from here. Their fail-closed version assertion still runs.
      echo "SCP_SKOPEO_IMAGE_REF=${skopeo_ref}"
      echo "SCP_COSIGN_IMAGE_REF=${cosign_ref}"
      # Consumer form 4: a DIGEST-PINNED `FROM` in the root Dockerfile. Neither a local re-tag nor a
      # ref an installer reads can serve it — `FROM …@sha256:…` resolves at the registry — so the
      # image build took its bytes from quay.io LIVE until these two were exported. The names are the
      # Dockerfile's own ARGs, and `deploy/compose/docker-compose.yml` declares them in pass-through
      # form so an unset value falls back to the Dockerfile default rather than to an empty string.
      echo "SKOPEO_IMAGE=${skopeo_ref}"
      echo "COSIGN_IMAGE=${cosign_ref}"
      # Same consumer form for the root Dockerfile's Node base (2026-08-31): `FROM ${NODE_IMAGE}`
      # resolves at the registry, so the compose builds take this ARG or pull docker.io live.
      echo "NODE_IMAGE=${node_ref}"
      # skopeo (containers/image) reads Docker's own credential file when pointed at it. The mirror
      # packages are public today, so this is belt-and-braces — it is what keeps the subject pulls
      # working if a mirror package is ever created private.
      echo "REGISTRY_AUTH_FILE=${HOME}/.docker/config.json"
    } >> "${env_out}"
    ;;

  blackhole)
    registries=""
    handle_entry() {
      local registry="$5"
      case " ${registries} " in *" ${registry} "*) return 0 ;; esac
      registries="${registries} ${registry}"
      return 0
    }
    for_each_entry

    hosts=""
    for registry in ${registries}; do
      # NEVER the mirror itself, and never a registry this workflow legitimately reads from.
      [ "${registry}" = "ghcr.io" ] && continue
      hosts="${hosts} $(blackhole_hosts_of "${registry}")"
    done
    if [ -z "${hosts// /}" ]; then
      echo "FATAL: refusing to run with an empty deny list — the manifest resolved no upstream registries" >&2
      exit 1
    fi
    echo "denying the mirrored upstream registries for the rest of this job:${hosts}"
    for host in ${hosts}; do
      echo "127.0.0.1 ${host}" | sudo tee -a /etc/hosts > /dev/null
    done
    ;;

  print)
    handle_entry() {
      printf 'upstream=%s\n  alias=%s\n  mirror=%s\n  alias-ref=%s\n' "$1" "$2" "$3" "$4"
      return 0
    }
    for_each_entry
    ;;

  *)
    echo "usage: scripts/ci-mirror.sh {push|seed|blackhole|print}" >&2
    exit 2
    ;;
esac
