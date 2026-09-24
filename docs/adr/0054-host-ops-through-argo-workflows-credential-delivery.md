# ADR-0054: Host ops through Argo Workflows — SCP's CA serves the run, through a sealed one-time redemption

**Status:** Accepted (owner decision 2026-09-23, Option 2 below; charter amendment "Managed Execution
Exception — Amendment approved 2026-09-23 (owner decision, M28.2)" lands in the same change)
**Relates to:** [PROJECT_CHARTER.md](../../PROJECT_CHARTER.md) principle 1, "Managed Execution
Exception" (2026-07-12 and 2026-09-23 amendments) and "Bundled Executor Backends";
[ADR-0051](0051-ssh-credential-authority-and-ca-custody.md) (credential authority, CA custody and its
blast-radius analysis — **unchanged** by this ADR); [ADR-0052](0052-server-derived-run-material-wins-for-host-reaching.md)
(server-derived material wins); [ADR-0050](0050-runner-ops-lockdown-is-an-allowlist.md);
BUILD_AND_TEST.md §M28.2

## Context

M28.2 runs the same Ansible catalog and the same server-derived material M27.9 produces as an Argo
Workflow (catalog template `scp-ops-v1`) when a domain's ops target is bound to `argo-workflows`,
instead of a container `scpd` launches through `@scp/runner-launcher`. `managed-ops` (Mode C) stays
the fallback for a domain with no execution system.

The material has two halves. **The bound** — `opsRole`, `opsInventory`, `opsEgressAllowlist`,
`opsPrincipals` — is not secret. **The credential** is: in Mode C, `scpd` mints a keypair and a
certificate from the domain's CA and stages both into a container it launched. On the Argo path the
runner pod is in a cluster SCP does not control and reaches only through an Argo API token, so the
credential cannot be staged.

### The finding that made this the owner's call

Delivering an SCP-CA certificate to an Argo pod conflicted with the charter as it stood: the host-login
grant (2026-07-12) was scoped to *a managed executor*; "Bundled backends keep their own infrastructure
credentials"; and "Opting into a bundled backend ends managed-execution eligibility for the classes it
covers". The builder stopped and put four options to the owner (recorded below). The owner chose
**Option 2** and required the charter amendment, and the token-theft exposure, to be handled in the
same change rather than documented.

## Decision

**D1 — One derivation feeds both executors.** `deriveOpsBound` (enrolment check, active CA, CA key
resolves, inventory and allowlist from ONE read of observed membership, principals) is the shared
half of `deriveOpsRunMaterial`. Mode C adds its credential on top; the Argo path stores the bound
beside a redemption. Every refusal lives in the shared half, so "no declared op" and "unenrolled
domain" refuse identically on both paths by construction.

**D2 — The Argo path is gated on SCP's own catalog template.** `isOpsLane` derives material for
`managed-ops`, or for `argo-workflows` **only** when the binding's `externalRef` is an SCP ops catalog
template (`scp-ops-v1`). An `argo-workflows` binding to any other template derives nothing: an
org-authored template is the org's executor with its own credentials, and SCP's CA never serves code
SCP did not review.

**D3 — The Workflow carries ciphertext and a run id, nothing else.** At reconcile time, in the
trigger's transaction, SCP stores the bound in `ops_run_redemptions` with the sha256 of a fresh 32-byte
secret, and hands `argo-workflows` exactly two parameters: `opsRunId` and `opsRunTokenSealed` — the
token `scpops1.<org>.<run>.<secret>` encrypted RSA-OAEP(SHA-256) to an RSA key (≥ 3072 bits) the
operator registers on the binding as `opsSealingPublicKey`. The private half is an operator-created
Secret mounted only into the `scp-ops-v1` pod. **Reading Workflows yields ciphertext.** A binding with
no sealing key is refused before any row is written, rather than falling back to a plaintext token.

**D4 — Redemption is single-use, windowed, bound to one run, and yields only that run's bound.**
`POST /api/v1/ops-run-redemptions` takes `{token, publicKey}`: the pod's own freshly generated
ed25519 public key — **the per-run private key never exists in SCP**, on the wire, or in the Workflow.
The door opens a tenant transaction from the ids in the token and locks the row. It checks the secret
first (constant-time), and only then the row's state, so a caller without the secret learns nothing.
It refuses:
a burned row (≥ 3 wrong secrets); a replay (the stolen-token signal); a row past its window, which is
**equal to the certificate TTL, never longer** (600 s — the same constant as Mode C); and a domain
whose active CA changed since derivation. On success it issues the certificate over the pod's key
with the same TTL, principals and key-id scheme as Mode C (plus `:run=<id>`), writes the issuance
row, marks the redemption, and appends the audit event — **one transaction** (ADR-0051 D5).

**D5 — `source-address` when the binding declares the cluster's egress addresses.** An optional
`opsSourceAddresses` on the binding becomes the certificate's OpenSSH `source-address` critical
option, and is recorded on both the redemption and the issuance row
(`ssh_certificate_issuances.source_address`, surfaced by `listSshCertificateIssuances`). Measured
against a real `sshd`: accepted from the declared address, refused from any other.

**D6 — Every redemption and every attributable refusal is audited and reconciles.**
`ops.run_redemption.redeemed` / `ops.run_redemption.refused`, in the hash chain, naming the run,
wave target, serial and caller address. A refusal's side effects (failed-attempt count, burn, audit
event) **commit**: the door returns a result instead of throwing, because a thrown refusal would roll
back the very record that makes a stolen-token race visible. Redeemed certificates sit in the same
issuance ledger as Mode C's, so `reconcileSerials` covers them unchanged — proved by reading the
serial back out of a real host's sshd log. Unattributable attempts (malformed token, unknown run) are
**not** audited: the org id in a forged token is attacker-chosen, and auditing it would let anyone
spam any org's chain. Those are bounded by a per-address rate limit (10 per 6 s) instead.

**D7 — The runner is the same image.** `apps/runner-ops/redeem.py` (stdlib + `cryptography`, already
an ansible-core dependency — no new package) unseals, generates the keypair, redeems and writes the
**same four `/work/in` files** Mode C's orchestrator stages; `run.sh` then runs the identical code
path. Redemption happens after catalog verification (a tampered catalog refuses before a certificate
is minted for it), and the role is taken from the redemption — an `SCP_OPS_ROLE` in the pod's
environment, which a Workflow editor controls, is ignored.

**D8 — The template is off by default and hardened with no relaxation.** `scp-ops-v1` ships in
`deploy/helm-bundled/templates/argo-workflows-ops-catalog.yaml` behind
`bundledExecutor.argoWorkflows.catalog.ops.enabled`: read-only root, no privilege escalation, every
capability dropped, seccomp RuntimeDefault, a ServiceAccount whose Role is the executor floor
(`workflowtaskresults: create, patch`), and a NetworkPolicy admitting DNS, SCP's API, the Kubernetes
API (for the emissary executor) and SSH to the operator's `targetCidrs` only. `tools/helm-verify`
checks each property on the render; `install.sh` retargets the runner image to the bundle registry.

**API parity.** Zod contract → OpenAPI → `pnpm gen` → `ScpClient.opsRuns.redeem`. **CLI, IaC and UI
are N/A by design:** the only legitimate caller is the runner, which speaks HTTP directly; a CLI verb
would be a way for a human to spend a run's token, which is the theft this door exists to make loud;
a redemption is not desired state, so IaC has nothing to declare; the UI's read side is the issuance
list and the audit chain, both already surfaced. The endpoint is bearer-less by construction — a PAT
in the org's namespace would be a standing credential readable by the same people D3 keeps the token
away from. `ops_run_redemptions` has GRANT SELECT/INSERT/UPDATE (no DELETE — a redemption is the
attribution of an issued serial) and the standard `org_isolation` RLS policy.

## Blast radius (ADR-0051's terms) — what this closes and what stays exposed

ADR-0051's analysis is unchanged in substance: the CA key's custody, D2's per-domain scope, and the
fact that TTL bounds a *leaked certificate* and not a *compromised CA* all carry over. What this path
adds is a second way for a certificate to come to exist, and its exposure is:

- **Workflow readers — closed.** Before sealing, anyone who could read Workflows in the namespace
  (Argo UI, etcd and its backups, the workflow archive) could redeem first. With D3 they hold
  ciphertext.
- **Sealing-Secret readers — REMAINS EXPOSED, and the set is larger than it looks.** Anyone who can
  read the sealing Secret can unseal a token in flight — and a pod may mount any Secret in its own
  namespace, so this includes **anyone who can create a pod (or submit an ad-hoc Workflow) in the
  Argo namespace**. Such a party can race the legitimate pod. The race is **loud, not prevented**:
  the legitimate run then fails with a 409 that SCP has audited with the thief's certificate serial
  on the row. Mitigation is the operator's: restrict pod creation in that namespace and set Argo's
  `workflowRestrictions.templateReferencing: Strict`. Binding redemption to the pod's projected
  ServiceAccount token was considered and not built: anyone able to submit a Workflow can run a pod
  as that ServiceAccount, so it raises the bar only to the same set.
- **The certificate is not host-bound — REMAINS EXPOSED.** It authorizes `root` on **every** host
  trusting the domain's CA for its TTL, not only the inventory: `targetHosts` is recorded, never
  enforced by `sshd`, and no OpenSSH certificate field can bind a target host. D5's `source-address`
  narrows **where it can be used from** when the operator declares it; nothing narrows where it can
  be used **against**.
- **Network egress is per deployment, not per run.** Mode C's kubernetes launcher builds a
  NetworkPolicy from the run's own allowlist. SCP holds only an Argo API token in the org's cluster
  and creates no NetworkPolicy there, so `scp-ops-egress` bounds SSH to the operator's `targetCidrs`
  for every run. The run's inventory still bounds which hosts Ansible connects to, and
  `redeem.py` refuses an inventory host outside the allowlist. The charter amendment states this
  plainly rather than claiming the per-run precondition is met unchanged.
- **The org's cluster admins are inside the trust boundary**, as they are for every executor: they
  can replace `scp-ops-v1` in their own namespace. They still cannot choose hosts or principals —
  those come from redemption — but they can use a redeemed certificate within its TTL against the
  domain's hosts.

## Options that were put to the owner (for the record)

1. **The backend's own credential (the charter as it stood).** SCP sends only the bound; the pod uses
   a credential the operator provisions (a Secret, or the org's own Vault). No new endpoint; loses
   SCP's per-run certificate, D5 coverage and the enrolment gate on this path. *Builder's
   recommendation at the time.*
2. **SCP's CA via a pod-generated key, a one-time token and a redemption endpoint — CHOSEN**, with
   the charter amended and the token-theft exposure hardened (D3–D6) rather than documented.
3. **Argo as a launcher for `managed-ops`** — the same delivery problem as 2 while contradicting the
   bundled-backend eligibility clause in substance; rejected.
4. **A server-minted keypair fetched by token** — strictly dominated by 2 (the private key generated
   in `scpd`, stored in SCP's database and sent over the network); rejected.

## Consequences

- **Two issuance paths share one ledger.** Mode C issues at derivation time; the Argo path at
  redemption time. Both write `ssh_certificate_issuances`, and only the Argo path writes
  `source_address`.
- **An unredeemed token simply expires.** A trigger that is retried after a failed submit derives a
  new redemption; the old row expires unused, and is visible as never redeemed.
- **Refusals leave the wave target pending with backoff**, as Mode C's already did. Neither path
  terminalises on a derivation refusal; that is unchanged and identical.
- **ADR-0052 is now wired on this path.** `argo-workflows` is not recipe-forbidden, so a recipe can
  reach the ops lane here; `assertNoRecipeOverride` (which had no production caller) now refuses a
  recipe naming a bound key or a delivery key.
