"""Redeem a host-ops run's one-time token — the ARGO path's only way in (M28.2, ADR-0054).

In Mode C the orchestrator stages /work/in itself. On an org's Argo Workflows nothing SCP controls
can stage anything, so this script produces the SAME four files from the server instead:

    /work/in/inventory.ini   the server-compiled inventory       (never from the Workflow)
    /work/in/params.json     the role's own arguments, as data   (run.sh marks them !unsafe)
    /work/in/ssh-credential  {privateKeyPem, certificate}        (the key is generated HERE)
    /work/in/role            the catalog role the server resolved

so everything after this in run.sh is the code path Mode C already proved against a real sshd.

What reaches this pod from the Workflow is CIPHERTEXT: the token is sealed (RSA-OAEP-SHA256) to the
operator's key, whose private half is a Secret mounted only into this pod. The keypair the
certificate is issued over is generated in this process and its private half is written only to
/work/in, an emptyDir that dies with the pod — it never exists in SCP, on the wire, or in the
Workflow. Every failure exits non-zero BEFORE Ansible starts.
"""

import base64
import json
import os
import ssl
import sys
import urllib.error
import urllib.request

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ed25519, padding

IN_DIR = "/work/in"
PATH = "/api/v1/ops-run-redemptions"


def die(message):
    sys.exit(f"scp-runner-ops: redemption: {message}")


def env(name):
    value = os.environ.get(name, "")
    if not value:
        die(f"{name} is unset")
    return value


def unseal():
    sealed = env("SCP_OPS_RUN_TOKEN_SEALED")
    with open(env("SCP_OPS_SEALING_KEY_FILE"), "rb") as fh:
        key = serialization.load_pem_private_key(fh.read(), password=None)
    try:
        token = key.decrypt(
            base64.b64decode(sealed, validate=True),
            padding.OAEP(
                mgf=padding.MGF1(algorithm=hashes.SHA256()),
                algorithm=hashes.SHA256(),
                label=None,
            ),
        )
    except Exception:  # noqa: BLE001 — any failure here is the same refusal
        die("the run token does not unseal with this pod's sealing key")
    return token.decode("ascii")


def write_private(name, data):
    # UNLINK FIRST, then O_EXCL at 0600 — the lesson run.sh records for /work/id: a creation mode
    # applies only when the file is CREATED, so reusing a path would keep whatever mode it had.
    path = os.path.join(IN_DIR, name)
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass
    with open(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as fh:
        fh.write(data)


def redeem(token, public_key):
    url = env("SCP_OPS_API_URL").rstrip("/") + PATH
    body = json.dumps({"token": token, "publicKey": public_key}).encode()
    request = urllib.request.Request(
        url, data=body, method="POST", headers={"content-type": "application/json"}
    )
    ca_file = os.environ.get("SCP_OPS_API_CA_FILE") or None
    context = ssl.create_default_context(cafile=ca_file) if url.startswith("https:") else None
    try:
        with urllib.request.urlopen(request, timeout=30, context=context) as response:
            return json.load(response)
    except urllib.error.HTTPError as err:
        # 409 is the one worth reading twice: the RIGHT secret was presented before this pod
        # presented it, so someone else held this run's token. The server has audited it.
        detail = err.read().decode(errors="replace")[:500]
        die(f"the server refused the redemption (HTTP {err.code}): {detail}")
    except (urllib.error.URLError, OSError) as err:
        die(f"could not reach {url}: {err}")


def main():
    token = unseal()

    private_key = ed25519.Ed25519PrivateKey.generate()
    public_openssh = (
        private_key.public_key()
        .public_bytes(serialization.Encoding.OpenSSH, serialization.PublicFormat.OpenSSH)
        .decode()
    )
    private_openssh = private_key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.OpenSSH,
        serialization.NoEncryption(),
    ).decode()

    material = redeem(token, public_openssh)
    required = ("opsRole", "opsInventory", "opsEgressAllowlist", "opsPrincipals", "certificate")
    missing = [k for k in required if not material.get(k)]
    if missing:
        die(f"the server's material is missing {', '.join(missing)} — refusing an incomplete bound")
    args = material.get("roleArguments", {})
    if not isinstance(args, dict):
        die("roleArguments must be an object")

    # DEFENCE IN DEPTH: every inventory host must be in the allowlist. They are one derivation on the
    # server, so a mismatch means the response is not what the server derived.
    allow = set(material["opsEgressAllowlist"])
    for line in material["opsInventory"].splitlines():
        for field in line.split():
            if field.startswith("ansible_host=") and field.split("=", 1)[1] not in allow:
                die(f"inventory host {field} is outside the egress allowlist — refusing")

    os.makedirs(IN_DIR, exist_ok=True)
    write_private("inventory.ini", material["opsInventory"])
    write_private("params.json", json.dumps(args))
    write_private(
        "ssh-credential",
        json.dumps({"privateKeyPem": private_openssh, "certificate": material["certificate"]}),
    )
    write_private("role", material["opsRole"])
    print(
        f"scp-runner-ops: redeemed run {material.get('runId')} — certificate serial "
        f"{material.get('serial')}, {len(allow)} host(s), source-address "
        f"{material.get('sourceAddress') or 'none'}",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
