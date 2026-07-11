# scp.platform — Ansible collection for CommanderSCP fleet rollout

Wraps the signed air-gap bundle's own install/upgrade script
(`deploy/airgap/assets/install.sh`) for inventory-driven fleet rollout across VM/compose/on-prem
instances (DESIGN.md §16). **Ansible is a packaging convenience, never a platform dependency** —
this collection only shells out to the same `install.sh` an operator can run by hand; the script
stays directly runnable without Ansible.

Everything security-critical (cosign-verify every image + `CHECKSUMS.txt` against the bundled
public key, **reject a tampered bundle**, retarget-push pinned by digest, re-verify the pushed
digest against your registry) happens INSIDE `install.sh` and runs identically whether invoked by
hand or by this role — see `deploy/airgap/assets/install.sh`'s own security-model header.

## What it does, per host

`scp_instances` inventory group, one host at a time (`serial: 1`):

1. copy the signed bundle tarball to the host and extract it;
2. run `install.sh --registry <your-registry> --mode <helm|compose> …` — which cosign-verifies,
   registry-retargets, applies (helm upgrade --install / docker compose up -d), and would abort on
   any verification/digest failure;
3. health-check the running instance (`/healthz` == 200).

Because the same bundle+script is install AND upgrade, this ONE playbook is both a first install
and every subsequent fleet-wide upgrade.

## Usage

```bash
# inventory.ini:
#   [scp_instances]
#   host1.internal
#   host2.internal

ansible-galaxy collection install deploy/ansible/scp/platform   # or build+install the tarball
ansible-playbook -i inventory.ini scp/platform/playbooks/rollout.yml \
  -e scp_bundle_tarball=/path/to/scp-bundle-1.0.0-rc.0.tar.gz \
  -e scp_registry=registry.internal:5000/scp \
  -e scp_install_mode=compose
```

See `roles/bundle_install/defaults/main.yml` for every variable (mode, namespace, release name,
insecure-registry, dry-run, health-check tuning).

## CI / verification

`scripts/ansible-drill.sh` runs an end-to-end Ansible-driven **upgrade of a compose-based
instance** against a local registry with `ansible-playbook -c local` (the M8 DoD item) — see that
script and the m8-hardening-packaging-rc PR for exactly what is CI-gated vs. run manually/nightly.
