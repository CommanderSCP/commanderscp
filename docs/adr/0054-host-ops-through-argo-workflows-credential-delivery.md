# ADR-0054: Host ops through Argo Workflows — whose credential reaches the host

**Status:** **Proposed — blocked on an owner decision** (2026-09-23). Nothing in M28.2 that depends on
this has been built. The analysis below is why the builder stopped rather than picking.
**Relates to:** [PROJECT_CHARTER.md](../../PROJECT_CHARTER.md) principle 1, "Managed Execution
Exception" (2026-07-12 host-reaching amendment) and "Bundled Executor Backends";
[ADR-0051](0051-ssh-credential-authority-and-ca-custody.md) (SSH credential authority and CA custody,
and its blast-radius analysis); [ADR-0052](0052-server-derived-run-material-wins-for-host-reaching.md)
(server-derived material wins); [ADR-0050](0050-runner-ops-lockdown-is-an-allowlist.md);
BUILD_AND_TEST.md §M28.2

## Context

M28.2 asks for the same Ansible catalog and "the same `deriveOpsRunMaterial` output M27.9 produces"
to run as an Argo Workflow (catalog template `scp-ops-v1`) when a domain runs Argo, rather than as a
container `scpd` launches through `@scp/runner-launcher`. `managed-ops` (Mode C) stays the fallback
for a domain with no execution system.

`deriveOpsRunMaterial` returns five keys. Four of them are **the bound**, and none of those is a
secret: `opsRole`, `opsInventory`, `opsEgressAllowlist`, `opsPrincipals`. The fifth,
`opsCredentialSecretKey`, names a secret-store entry holding a private key and a certificate that
**SCP's own per-domain CA minted** for this run (ADR-0051 D2/D3), with the issuance recorded for
D5's serial reconciliation. In Mode C `managed-ops` resolves that entry inside `scpd` and writes it
into a container SCP launched. The fifth key is the only one this ADR is about.

### The finding that stopped the build: SCP-minted credentials on the Argo path conflict with the charter

The DoD handed to M28.2 assumes the SCP CA serves the Argo path too — "refusals (no declared op,
**unenrolled domain**) behave identically on both paths", and the milestone's own wording, "the same
`deriveOpsRunMaterial` output". Read against the charter, that is not an implementation detail:

1. **Principle 1** (CLAUDE.md digest): *"the platform does not hold credentials to the
   infrastructure that execution systems manage."* An SSH user CA that every enrolled host trusts
   for `root` is exactly such a credential, and on this path the hosts' changes are made by the
   org's execution system (Argo Workflows), not by a managed executor.
2. **Managed Execution Exception, 2026-07-12:** *"a **managed executor** may hold host login-grade
   credentials."* The grant is scoped to the managed executor. An Argo Workflow in the org's
   cluster is not one.
3. **Bundled Executor Backends:** *"Bundled backends keep their own infrastructure credentials …
   CommanderSCP holds only a scoped API token to a bundled backend"* and *"Opting into a bundled
   backend ends managed-execution eligibility for the classes it covers."* Binding host ops to a
   bundled Argo is opting in for that class — which ends precisely the eligibility under which SCP
   holds a host CA.
4. The M28 kickoff (`docs/proposals/m28-kickoff-prompt.md`) says the same thing from the other side:
   *"M28 is mostly outside the exception — it is the coordinate-don't-execute default."*

The shipped build catalog already follows the charter's reading: `scp-build-image-v1` pushes with a
credential the **operator** provisions in the backend's namespace (`catalog.credentialsSecret`,
"NOT created by this chart: minting a forge credential is an operator act"). SCP never holds it.

So every design in which SCP's CA mints the certificate an Argo pod uses — including both candidate
shapes the milestone brief proposed — **extends the host-reaching credential grant beyond the
managed executor**, which is a charter amendment. The design that needs no amendment changes the
security posture SCP offers an Argo-bound estate (no per-run SCP-minted certificate, no D5 serial
coverage, no enrolment/break-glass gate). Both are the owner's call; neither is a builder's.

## What does NOT depend on the answer (and will be built the same way either way)

- **One derivation of the bound.** The four bound keys are derived once, by the same code, for
  both executors; a test asserts the Argo run's bound equals Mode C's for the same change, and
  deleting the Argo-path wiring turns a test red.
- **The Mode A/B path never launches a container from `scpd`**, asserted by a launcher double that
  throws if touched, mutation-proved.
- **The runner is the same `scp-runner-ops` image** with its signed closed catalog, deleted module
  set and `!unsafe` parameters (ADR-0050, M27.2/M27.3). The bound reaches it as files at the same
  `/work/in` paths Mode C uses (Argo `raw` input artifacts), so one reader reads one shape.
- **ADR-0052 still holds on this path:** server-derived keys are spread last, a recipe carrying one
  is refused, and rollback derives nothing.
- **The per-run egress allowlist cannot be enforced by SCP in the org's cluster** under any option:
  SCP holds only an Argo API token there (charter) and does not create NetworkPolicies. The runner's
  inventory still bounds what Ansible connects to; network-layer enforcement is the backend's, via a
  chart-shipped policy for `scp-ops` pods scoped to an operator-set target CIDR set (the ADR-0049
  precedent the M28 section already cites for D2). This is stated as a real difference from Mode C,
  not smoothed over.

## Options

### Option 1 — the credential is the backend's own (charter as written) — RECOMMENDED

The Argo path derives and delivers **only the bound**. The `scp-ops-v1` runner step reads its SSH
credential from what the operator provisions in the Argo namespace — a Secret (the
`scp-build-registry` precedent), or the org's own authority (e.g. Vault's SSH engine via Kubernetes
auth, from inside the pod). SCP mints nothing, holds nothing and records no issuance on this path.

- *No new endpoint, no callback* from the org's cluster into SCP, and nothing secret in Workflow
  parameters because nothing secret is sent.
- *Blast radius (ADR-0051 terms):* SCP's CA is not involved, so a compromise of SCP cannot reach an
  Argo-bound estate's hosts through this path at all. The org's credential's blast radius is the
  org's, exactly as for every other bundled or BYO backend.
- *What changes vs Mode C, said plainly:* per-run minutes-TTL certificates, D5 serial
  reconciliation and the enrolment/break-glass refusal are **Mode C properties** and do not carry
  over. An estate that stores a static key in a Secret gets a standing credential; one that uses its
  own Vault gets per-run certificates from its own authority. "Unenrolled domain" is not a refusal
  on this path — its replacement is the runner refusing, before Ansible starts, when no credential
  is mounted (the same fail-closed position `run.sh` takes today).
- *DoD impact:* "one derivation" holds for the bound; the "unenrolled domain behaves identically"
  line is replaced as above; `run.sh` gains a key-with-optional-certificate credential shape.

### Option 2 — SCP's CA serves the Argo path: pod-generated key, one-time token, redemption endpoint — needs a charter amendment

The pod generates an ephemeral keypair and redeems a single-use, per-run token (carried as a
Workflow parameter, TTL ≤ the certificate's 10 minutes) at a new machine-to-machine endpoint for a
certificate over its **public** key plus the derived bound. Issuance and its D5 serial are written
in the redemption transaction. The per-run private key never exists in SCP.

- *Requires* amending the Managed Execution Exception to extend the host-login grant to SCP-catalog
  templates run on an org's Argo, and qualifying "opting into a bundled backend ends
  managed-execution eligibility" for this class.
- *Blast radius — the part that must be read:* a Workflow's `spec.arguments` is persisted in the
  Workflow object, shown in the Argo UI, held in etcd and its backups, and in the workflow archive
  if enabled. **Anyone who can read Workflows in that namespace during the pre-redemption window can
  redeem the token first** and receive a certificate for `root` that is valid on **every host
  trusting the domain's CA**, not only the inventory: the certificate carries no host binding
  (`targetHosts` is recorded, never enforced by `sshd`), and no OpenSSH certificate field can bind
  one. Single-use makes the theft **loud** — the legitimate run then fails — but not impossible.
  Binding redemption to the pod's projected ServiceAccount token (audience `scp`, verified offline
  against the cluster's issuer keys registered on the binding) raises the bar from "can read
  Workflows" to "can create a pod as that ServiceAccount" — which anyone able to *submit* a Workflow
  in the namespace can do. Short TTL bounds a leaked certificate, not a stolen redemption.
- *New inbound network path:* the org's cluster must reach SCP's API. Mode A has only ever needed
  SCP → executor; in a Mode A estate across a segment boundary this path may not exist.
- *Build cost:* endpoint with full API parity (Zod → OpenAPI → `pnpm gen` → `ScpClient`; CLI/IaC/UI
  N/A as machine-to-machine), a token table with GRANT + RLS, replay and rate limits, an audit
  event per redemption.

### Option 3 — Argo as a *launcher* for `managed-ops` (stay inside the exception) — not recommended

Treat Argo as a sibling of the Kubernetes runner launcher: the run remains a managed-ops run, SCP
still mints, and Argo only schedules the pod. This keeps the grant nominally within "a managed
executor", but it is Option 2's delivery problem unchanged (the credential must still reach a pod in
a cluster SCP does not control), it contradicts "opting into a bundled backend ends managed-execution
eligibility" in substance, and it makes M28.2 a Mode C feature rather than the coordinate-default
the milestone exists to deliver.

### Option 4 — server-minted keypair, fetched by token — rejected

`deriveOpsRunMaterial` unchanged; the pod redeems a token for the stored private key and
certificate. Strictly dominated by Option 2: identical token-theft exposure, plus the per-run
private key is generated in `scpd`, stored in SCP's database and sent across the network.

## Recommendation

**Option 1.** It is what the charter already says, what the shipped build catalog already does, and
it is the only option whose worst case does not route an org's Argo read permissions into a
domain-wide root credential. The cost is real and belongs in the product's description: an
Argo-bound estate's host credential is its own, with the strength the org gives it. If the owner
wants SCP's per-run CA available to Argo estates that have no SSH authority, Option 2 is buildable,
but it is a charter amendment with the token-theft exposure above written into it — not a wiring
change.
