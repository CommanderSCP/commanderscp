#!/bin/sh
# scp-runner-ops run shim. Single-shot: verify the catalog, validate what was handed in, run exactly
# one catalog role against the server-compiled inventory, exit. See apps/runner-ops/README.md.
#
# EVERY FAILURE PATH HERE EXITS NON-ZERO BEFORE ANSIBLE STARTS. The orchestrator treats that as a
# refused run; there is no "partially applied" outcome reachable from a validation failure.
set -eu

CATALOG_DIR="${SCP_OPS_CATALOG_DIR:-/catalog}"
# The three classes the charter's 2026-07-12 host-reaching amendment enumerates. A literal, never a
# config read: a knob here would be an operator-facing way to widen the charter.
CHARTER_CLASSES="osPackage configRenderPush cronSystemd"

if [ "${1:-}" = "--lockdown-inventory" ]; then
  # The gate's read path (lockdown.integration.test.ts). Emits the module/lookup/action surface
  # actually present, so the assertion is made against the BUILT ARTIFACT rather than the
  # Dockerfile's intent.
  exec python - <<'PY'
import ansible, os, glob, json
p = os.path.dirname(ansible.__file__)
def names(sub):
    return sorted(
        os.path.basename(f)[:-3]
        for f in glob.glob(os.path.join(p, sub, "*.py"))
        if not f.endswith("__init__.py")
    )
print(json.dumps({
    "modules": names("modules"),
    "lookup": names("plugins/lookup"),
    "action": names("plugins/action"),
}))
PY
fi

die() { echo "scp-runner-ops: $1" >&2; exit "${2:-2}"; }

# ---- 1. THE CATALOG IS VERIFIED BEFORE IT IS READ -------------------------------------------
# cosign verify-blob over catalog.json, against a public key the OPERATOR supplies out of band.
# Unsigned, mis-signed or tampered => refuse. This runs before any role is parsed, so a tampered
# catalog never reaches Ansible's loader.
[ -f "$CATALOG_DIR/catalog.json" ] || die "no catalog at $CATALOG_DIR/catalog.json"

if [ "${SCP_OPS_CATALOG_VERIFY:-required}" = "required" ]; then
  [ -n "${SCP_OPS_CATALOG_PUBKEY:-}" ] || die "SCP_OPS_CATALOG_PUBKEY is unset and catalog verification is required"
  [ -f "$CATALOG_DIR/catalog.json.sig" ] || die "catalog is unsigned (no catalog.json.sig) — refusing"
  # FLAGS MATCH packages/cosign/src/cosign.ts `verifyBlobDetached`, which is the canonical
  # definition — this is a shell re-statement because verification happens INSIDE the runner,
  # where no TypeScript runs. `--insecure-ignore-tlog=true` is required for air-gap correctness
  # and is not a weakening: the trust anchor here is the operator's public key, not Rekor, and a
  # transparency-log lookup is a network call an air-gapped domain cannot make (principle 5).
  cosign verify-blob \
    --key "$SCP_OPS_CATALOG_PUBKEY" \
    --signature "$CATALOG_DIR/catalog.json.sig" \
    --insecure-ignore-tlog=true \
    "$CATALOG_DIR/catalog.json" >/dev/null 2>&1 \
    || die "catalog signature does not verify — refusing"
  # The signature covers catalog.json, which pins each role by content digest. Verifying the
  # manifest alone would leave the ROLES unsigned, so the digests are checked too.
  python /usr/local/bin/verify_catalog_digests.py "$CATALOG_DIR" \
    || die "a catalog role does not match its pinned digest — refusing"
fi

# ---- 1b. THE ARGO PATH: REDEEM, AFTER THE CATALOG IS TRUSTED (M28.2, ADR-0054) ---------------
# On an org's Argo Workflows (`scp-ops-v1`) nothing SCP controls stages /work/in, so the pod redeems
# its sealed one-time token for the SAME files Mode C's orchestrator writes. Placed after catalog
# verification on purpose: a tampered catalog must refuse before a credential is ever minted for it.
# From here on both paths run identical code. The role is the SERVER's — an `SCP_OPS_ROLE` a
# Workflow editor set is ignored rather than trusted, because on this path the environment is the
# Workflow's to write.
if [ -n "${SCP_OPS_API_URL:-}" ]; then
  python /usr/local/bin/redeem.py || die "redemption refused"
  SCP_OPS_ROLE=$(cat /work/in/role) || die "redemption wrote no role"
fi

# ---- 2. THE REQUESTED ROLE MUST BE IN THE CATALOG, IN AN ADMITTED CLASS ----------------------
ROLE="${SCP_OPS_ROLE:-}"
[ -n "$ROLE" ] || die "SCP_OPS_ROLE is unset"

ROLE_CLASS=$(python - "$CATALOG_DIR/catalog.json" "$ROLE" <<'PY'
import json, sys
catalog = json.load(open(sys.argv[1]))
match = [r for r in catalog["roles"] if r["name"] == sys.argv[2]]
print(match[0]["charterClass"] if match else "")
PY
) || die "could not read the catalog"
[ -n "$ROLE_CLASS" ] || die "role '$ROLE' is not in the catalog — refusing"

admitted=0
for c in $CHARTER_CLASSES; do
  [ "$c" = "$ROLE_CLASS" ] && admitted=1
done
[ "$admitted" = "1" ] || die "role '$ROLE' declares class '$ROLE_CLASS', which the charter does not enumerate — refusing"

# ---- 3. TENANT PARAMETERS BECOME DATA ---------------------------------------------------------
[ -f /work/in/params.json ] || die "no parameters at /work/in/params.json"
python /usr/local/bin/params_to_vars.py /work/in/params.json > /work/vars.yml \
  || die "parameters refused"

# ---- 4. INVENTORY IS THE SERVER'S, NEVER THE TENANT'S -----------------------------------------
# Compiled from the resolved plan and copied in (M27.6). A tenant `hosts` value has no path here:
# this file is the only inventory, and params.json cannot name one.
[ -f /work/in/inventory.ini ] || die "no server-compiled inventory at /work/in/inventory.ini"

# ---- 5. THE PER-RUN CERTIFICATE ----------------------------------------------------------------
# The orchestrator stages the credential the server minted; until M27.9 this file was WRITTEN and
# never read, so ansible-playbook ran with no key at all and could not have authenticated to any
# host. The whole host-reaching path was unreachable in a way no test noticed, because every test
# either stopped before the connection or asserted a refusal.
#
# The file is JSON — the private key and the certificate TOGETHER, because splitting them across
# two secrets would let a run start holding one half.
[ -f /work/in/ssh-credential ] || die "no per-run credential at /work/in/ssh-credential"
python - <<'PYKEY' || die "credential refused"
import json, os, sys
with open("/work/in/ssh-credential") as fh:
    cred = json.load(fh)
key, cert = cred.get("privateKeyPem"), cred.get("certificate")
if not key or not cert:
    sys.exit("credential must carry both privateKeyPem and certificate")
# 0600, and UNLINK FIRST rather than trusting the creation mode. `os.open`'s mode argument applies
# only when the file is CREATED — reopening an existing path with O_CREAT|O_TRUNC keeps whatever
# mode it already had. A workspace reused across runs therefore kept a world-readable key from the
# previous one and OpenSSH refused it ("Permissions 0666 for '/work/id' are too open ... This
# private key will be ignored"), which surfaces as `Permission denied (publickey)` and reads like a
# bad certificate. Unlinking makes the mode a fact about THIS run rather than about the workspace's
# history, and it closes the window a post-hoc chmod would leave open.
for path, data in (("/work/id", key), ("/work/id-cert.pub", cert)):
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass
    with open(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as fh:
        fh.write(data if data.endswith("\n") else data + "\n")
PYKEY

# HOST KEY POLICY. `ansible.cfg` sets `host_key_checking = True` and that stays true: the named
# file below is the trust anchor when the server supplies one.
#
# KNOWN GAP, stated rather than hidden: observed membership (M27.6a) records addresses, not host
# keys, so there is usually nothing to supply and the first connection is trust-on-first-use.
# Closing it needs host keys in the membership report — a change to what an infrastructure
# pipeline pushes, not something this script can invent. Until then TOFU is the honest description,
# and it is logged so a run cannot quietly look stronger than it is.
if [ -f /work/in/known_hosts ]; then
  SSH_HOST_ARGS="-o StrictHostKeyChecking=yes -o UserKnownHostsFile=/work/in/known_hosts"
else
  echo "scp-runner-ops: no server-supplied known_hosts — first contact is TRUST-ON-FIRST-USE." >&2
  SSH_HOST_ARGS="-o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/work/known_hosts"
fi

cat > /work/play.yml <<PLAY
- hosts: all
  gather_facts: true
  roles:
    - $ROLE
PLAY

# `root` is the principal the certificate authorizes (ADR-0051 D4 as amended 2026-09-23) and the
# roles carry no `become:`, so the connection user IS the privileged one and no sudo step exists.
# THE VERIFIED CATALOG IS THE ONLY ROLE SOURCE. Until M27.9 this was unset, so the catalog was
# signature-checked, digest-checked, charter-class-checked — and then never placed where
# ansible-playbook looks, which failed with "the role '...' was not found". Exported rather than
# passed as a flag because `ansible-playbook` has no --roles-path.
#
# A SINGLE path, not a list: Ansible searches every entry in order, so appending the catalog to the
# default set would leave `/work/roles` ahead of it — a directory inside the copy-in area, which is
# the one place a caller can put files.
export ANSIBLE_ROLES_PATH="$CATALOG_DIR/roles"

# NO TTY. Ansible allocates one by default (`-tt`) because `become` normally needs somewhere to
# answer a sudo prompt — and this catalog has no `become` at all (ADR-0051 D4 as amended: the
# certificate authorizes root directly). Two reasons to turn it off rather than leave the default:
# a tty MERGES the target's stderr into stdout, so every diagnostic a run collects as evidence
# would be interleaved and unattributable; and requesting one makes the run depend on the target
# having working pty allocation, which is a capability it does not need. Measured: with `-tt` the
# run failed at "PTY allocation request failed on channel 0" having already authenticated.
export ANSIBLE_SSH_USETTY=False

exec ansible-playbook \
  -i /work/in/inventory.ini \
  -e @/work/vars.yml \
  --user root \
  --private-key /work/id \
  --ssh-extra-args "-o CertificateFile=/work/id-cert.pub -o IdentitiesOnly=yes $SSH_HOST_ARGS" \
  /work/play.yml
