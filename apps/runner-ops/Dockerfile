# syntax=docker/dockerfile:1.7
#
# scp-runner-ops — the SEPARATE image the scp-managed-ops executor launches per run (M27,
# DESIGN.md §12, the charter's Managed Execution Exception 2026-07-12 host-reaching amendment).
# Ansible plus a run shim, pruned to a charter-derived allowlist, and NOTHING else. No Node app
# code lives here (docs/DESIGN.md §3) — `packages/plugins/managed-ops` is the thin ORCHESTRATOR
# that runs inside scpd and launches this image as an ephemeral container per run; this image is
# the ISOLATED TOOLCHAIN it launches.
#
# `docker build -t scp-runner-ops:dev apps/runner-ops` is the only build command for this image.
#
# THE SECURITY CONTROL IS THE `prune.py` LAYER, NOT THE CONFIG (ADR-0050). ADR-0002 originally
# specified a lockdown `ansible.cfg` disabling six named things. Censusing ansible-core 2.18.6
# showed those six are a minority of the reachable code-execution paths — `lines` executes commands
# exactly as `pipe` does; `expect`/`pip`/`git`/`subversion` all reach execution; and the
# `include_*`/`import_*` family turns tenant-influenced DATA into TASKS, defeating "no shell module
# reachable" without touching a shell module. So the image ships an ALLOWLIST derived from the
# charter's three enumerated classes and DELETES the rest. Configuration is overridable
# (`ANSIBLE_CONFIG`, a cwd `ansible.cfg`, per-play settings); a file that is not present is not.
#
# WHY ALPINE: consistency with `apps/runner-iac` (see its own measured base-distro comparison) and
# because this image needs `openssh-client` and a Python interpreter and nothing else — Alpine's
# openssh-client carries no perl chain. Re-measure before changing base distros; the deciding
# factor is the dependency shape of the packages actually installed, not distro reputation.
# The vendored cosign pin (tools/cosign/pin.env) — the catalog's signature is verified INSIDE the
# runner, before any role is parsed, so cosign has to be here rather than on the orchestrator side.
ARG COSIGN_IMAGE=ghcr.io/sigstore/cosign/cosign@sha256:bea051df6a6d3bc84288b6db098df38a81d87b7ed226f34d22aaae1bc329c2b7
FROM ${COSIGN_IMAGE} AS cosign

FROM python:3.12-alpine3.21

# PINNED, and the pin is load-bearing twice over: `upstream-inventory.json` records the exact
# module/lookup/action surface of THIS version, and `lockdown.test.ts` fails if the real surface
# drifts from that record. A bump is therefore a deliberate review of what upstream added, which is
# the trade ADR-0050 chose over an unreviewed surface change riding a patch bump.
ARG ANSIBLE_CORE_VERSION=2.18.6

# `openssh-client` is the only reason this image can reach a host at all; `ca-certificates` backs
# the BYO credential authority path (ADR-0051 D1), which speaks HTTPS to Vault/Teleport.
RUN apk add --no-cache openssh-client ca-certificates \
 && pip install --no-cache-dir "ansible-core==${ANSIBLE_CORE_VERSION}"

COPY allowlist.json /tmp/allowlist.json
COPY prune.py /tmp/prune.py
# The deletion layer. Fails the build if the allowlist names anything absent upstream, so a stale
# allowlist surfaces here rather than as a missing capability at run time.
RUN python /tmp/prune.py /tmp/allowlist.json \
 && rm -f /tmp/prune.py /tmp/allowlist.json \
 # Ansible ships `ansible-connection`/`ansible-console`/`ansible-pull` etc.; `ansible-pull` fetches
 # and runs a playbook from a URL, which is task injection by design, and the console is an
 # interactive shell onto the fleet. Neither belongs in a single-shot catalog runner.
 && rm -f /usr/local/bin/ansible-pull /usr/local/bin/ansible-console

COPY --from=cosign /ko-app/cosign /usr/local/bin/cosign
COPY params_to_vars.py /usr/local/bin/params_to_vars.py
COPY verify_catalog_digests.py /usr/local/bin/verify_catalog_digests.py
# The catalog SCP ships. An operator may mount their own over /catalog; either way run.sh verifies
# the signature and the per-role digests before anything is parsed.
COPY catalog /catalog
COPY ansible.cfg /etc/ansible/ansible.cfg
COPY run.sh /usr/local/bin/run.sh
RUN chmod 0755 /usr/local/bin/run.sh

# Non-root by construction. The runner's authority on a TARGET comes from its SSH certificate and
# the target's restricted sudoers (ADR-0051 D4) — never from being root inside this container.
RUN adduser -D -u 1000 runner
USER runner
WORKDIR /work

ENTRYPOINT ["/usr/local/bin/run.sh"]
