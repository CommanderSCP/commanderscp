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

cat > /work/play.yml <<PLAY
- hosts: all
  gather_facts: true
  roles:
    - $ROLE
PLAY

exec ansible-playbook \
  -i /work/in/inventory.ini \
  -e @/work/vars.yml \
  /work/play.yml
