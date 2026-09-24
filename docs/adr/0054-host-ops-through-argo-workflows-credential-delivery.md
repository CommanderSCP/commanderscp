# ADR-0054: Host ops through Argo Workflows — SCP's CA serves the run, through a sealed one-time redemption

**Status:** Accepted (owner decision 2026-09-23, Option 2 below; charter amendment "Managed Execution
Exception — Amendment approved 2026-09-23 (owner decision, M28.2)" lands in the same change).
**Revised 2026-09-24** (owner decision "honest wording + pin", after #414's adversarial round): D2's
and D3's claims about what redeems are withdrawn; **D9** pins the endpoint, sealing key, template ref
and runner digest; refusals are terminal; see "What the adversarial round found".
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

**D2 — The Argo path is gated on SCP's own catalog template REF.** `isOpsLane` derives material for
`managed-ops`, or for `argo-workflows` **only** when the binding's `externalRef` names an SCP ops
catalog template (`scp-ops-v1`), and D9 requires it to equal the domain's pinned ref. An
`argo-workflows` binding to any other template derives nothing. **This is a claim about what SCP
submits, not about what runs**: SCP cannot attest the template, image or pod behind that name in a
cluster it reaches only through an Argo token (the original wording, "SCP's CA never serves code SCP
did not review", claimed more than the product enforces and is withdrawn).

**D3 — The Workflow carries ciphertext and a run id, nothing else.** At reconcile time, in the
trigger's transaction, SCP stores the bound in `ops_run_redemptions` with the sha256 of a fresh 32-byte
secret, and hands `argo-workflows` exactly two parameters: `opsRunId` and `opsRunTokenSealed` — the
token `scpops1.<org>.<run>.<secret>` encrypted RSA-OAEP(SHA-256) to the RSA key (≥ 3072 bits)
**pinned for the domain** (D9 — not binding config). The private half is an operator-created Secret
the `scp-ops-v1` template mounts. **Reading Workflows yields ciphertext.** A domain with no pin is
refused before any row is written, rather than falling back to a plaintext token.

**D4 — Redemption is single-use, windowed, bound to one run, and yields only that run's bound.**
`POST /api/v1/ops-run-redemptions` takes `{token, publicKey}`: the pod's own freshly generated
ed25519 public key — **the per-run private key never exists in SCP**, on the wire, or in the Workflow.
The door opens a tenant transaction from the ids in the token and locks the row. It checks the secret
first (constant-time), and only then the row's state, so a caller without the secret learns nothing.
It refuses:
a burned row (≥ 3 wrong secrets); a replay (the stolen-token signal); a row past its window, which is
**equal to the certificate TTL, never longer** (600 s — the same constant as Mode C); a wave target
not in flight (`triggering`/`triggered`/`observing` only — probe B redeemed for an aborted target) or
a row that is not the target's NEWEST (a retried trigger makes every older row dead); a pod key
already certified for another run; a change that
is no longer `executing` (cancelled, rolled back or deleted after its Workflow was submitted — the
operator who stopped it believes no host will be touched); and a domain whose active CA changed
since derivation. On success it issues the certificate over the pod's key
with the same TTL, principals and key-id scheme as Mode C (plus `:run=<id>`), writes the issuance
row, marks the redemption, and appends the audit event — **one transaction** (ADR-0051 D5).

**D5 — `source-address` is MANDATORY on this path.** The pin's `sourceAddresses` (the cluster's
egress addresses; a pin without them is refused at write time) becomes every certificate's OpenSSH
`source-address` critical option, and is recorded on both the redemption and the issuance row
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
spam any org's chain. Those are bounded by a per-address rate limit (10 per 6 s, at most 10 000
addresses held) instead. **A ceiling on a burned row:** after the third wrong secret burns it, further
wrong guesses are neither counted nor audited (probe C appended one event per guess without bound).
**Every 401 is padded to a common floor** (250 ms), so latency does not distinguish an unknown run
from a wrong secret. **The DoS that remains:** the run id is a Workflow parameter, so anyone who can
read Workflows can burn a run with three guesses. It kills that one run, loudly (the pod's 409 and
the audited burn), and the change is re-proposed; it yields no certificate.

**D7 — The runner is the same image.** `apps/runner-ops/redeem.py` (stdlib + `cryptography`, already
an ansible-core dependency — no new package) unseals, generates the keypair, redeems and writes the
**same four `/work/in` files** Mode C's orchestrator stages; `run.sh` then runs the identical code
path. Redemption happens after catalog verification (a tampered catalog refuses before a certificate
is minted for it), **verification cannot be disabled on this path** (`run.sh` refuses
`SCP_OPS_CATALOG_VERIFY` other than `required` when `SCP_OPS_API_URL` is set — the pod's environment
is the Workflow's to write), and the role is taken from the redemption — an `SCP_OPS_ROLE` in the
pod's environment is ignored.

**D8 — The template is off by default and hardened with no relaxation.** `scp-ops-v1` ships in
`deploy/helm-bundled/templates/argo-workflows-ops-catalog.yaml` behind
`bundledExecutor.argoWorkflows.catalog.ops.enabled`: read-only root, no privilege escalation, every
capability dropped, seccomp RuntimeDefault, a ServiceAccount whose Role is the executor floor
(`workflowtaskresults: create, patch`), `activeDeadlineSeconds` ≤ 600 (the certificate's TTL — the
chart refuses more), and a NetworkPolicy of four rules, each with a destination: DNS to `kube-system`
only; SCP's API pods; the Kubernetes API at the operator's `kubeApiCidrs` (required, **no default** —
the main chart's RFC1918 default is tolerable for `scpd` but would mean 443/6443 to every private
address for a pod holding a root certificate); and SSH to `targetCidrs`. `tools/helm-verify` checks
each property on the render and self-tests the checker against planted defects; `install.sh`
retargets the runner image to the bundle registry (proved by `bundle-images.test.ts`).

**D9 — The pin (owner ruling 2026-09-24, "honest wording + pin").** `ssh_ca_argo_ops_pins`
(migration 0122), one row per trust domain: the Argo `serverUrl` and `namespace`, the `templateRef`,
the `sealingPublicKey`, the mandatory `sourceAddresses`, and the `runnerImageDigest`. Written only by
`PUT /api/v1/trust-domains/{id}/ssh-ca/argo-ops-pin` (SDK `sshCa.pinArgoOps`, CLI
`scp ssh-ca pin-argo-ops`), authorized **`secret:write` at the org root** — the enrolment door's own
permission, so no new permission and no role-model change — and validated at write time (key strength,
addresses, digest format, SCP template, URL); audited as `ssh_ca.argo_ops_pin.put`. On the Argo lane:
the binding's normalised `serverUrl`, its `namespace` and its `externalRef` must equal the pin or the
run is refused (`binding_off_pin`); the sealing key and source addresses are read from the pin and
**never** from binding config (the argo-workflows manifest no longer declares them). Before submit,
`@scp/plugin-argo-workflows` reads the template back from the pinned server and refuses unless every
container names the pinned digest and sets `SCP_OPS_CATALOG_VERIFY=required` as a literal, and no
`podSpecPatch`, `templateDefaults` or script/resource/http/plugin/containerSet/data template exists;
the pins reach it as server-injected `opsTemplatePins` — every pin in the org, stably ordered, always
set (`[]` without pins) so tenant config cannot stand in for them — and the plugin first refuses
unless ITS OWN running `serverUrl`/`namespace` is a pinned endpoint for the template. The read-back is
an **exact allowlist** of the chart's shape (`opsTemplateShapeProblems` in
`@scp/plugin-argo-workflows`): one container template that is the entrypoint and nothing else (no
`steps`/`dag`/`templateRef`/`onExit`/`hooks`/`initContainers`/`sidecars`/`podSpecPatch`); the pinned
digest; `command` exactly `/usr/local/bin/run.sh` and no `args`; exactly the chart's env names with
fixed values (catalog verification `required`, the fixed key and catalog paths, the pinned SCP API
URL, which the pin door requires to be https — the pin gained `redeemUrl` for this); exactly the chart's volume NAMES and KINDS with read-only mounts at the chart's paths — **the Secret names those volumes reference and the pod's `serviceAccountName` are the operator's and are not checked** (#414 final re-verification, probe N8, swapped the `api-ca` Secret; with `redeemUrl` https-only, supplying an attacker CA that way needs write access to Secrets or WorkflowTemplates in the namespace, which is inside the residual trust set); the
hardened container and pod security contexts; `podMetadata` labels only. `tools/helm-verify` asks the
SAME function about the actual chart render, so the chart and the runtime check cannot drift. A
refusal carries a marker the server recognises and terminalises the target with a Decision
(`template_readback_refused`); an HTTP 5xx on the read-back is the Argo server being unwell and takes
the ordinary retry path. **This read-back is defence in depth, not
attestation:** a cluster admin can change the template between the read and the pod's start (TOCTOU).
**Key rotation:** re-`PUT` the pin with the new public key and roll the Secret; a token sealed to the
old key and still in flight fails to unseal in the pod (it fails, loudly, and is re-proposed) — so
rotate between runs, or accept those in flight failing.

**D10 — Every refusal on this lane is TERMINAL, with a Decision and an audit event.**
`OpsMaterialUnavailable` (not enrolled, no active CA, CA key unresolved), `OpsSealingKeyRefused` (no
pin, binding off the pin, weak key, no source addresses) and `OpsRecipeRefused` (a recipe restating a
reserved key) are `TriggerParameterRefusal`s with status `ops_material_refused` (joined to
`REFUSED_WAVE_TARGET_STATUSES`) and an `inputContext` of `{ gate: "ops_material", reason }` from a
closed set. None is transient: each needs a person (enrol, restore the key, pin, fix the recipe),
after which the change is re-proposed — so re-firing every tick with only a log line was the wrong
shape, as ADR-0053 found for the build lane. A template read-back failure is the executor refusing at
trigger time and keeps the ordinary trigger-failure backoff.

**API parity.** Zod contract → OpenAPI → `pnpm gen` → `ScpClient.opsRuns.redeem`. **CLI, IaC and UI
are N/A by design:** the only legitimate caller is the runner, which speaks HTTP directly; a CLI verb
would be a way for a human to spend a run's token, which is the theft this door exists to make loud;
a redemption is not desired state, so IaC has nothing to declare; the UI's read side is the issuance
list and the audit chain, both already surfaced. The endpoint is bearer-less by construction — a PAT
in the org's namespace would be a standing credential readable by the same people D3 keeps the token
away from. `ops_run_redemptions` has GRANT SELECT/INSERT/UPDATE (no DELETE — a redemption is the
attribution of an issued serial) and the standard `org_isolation` RLS policy. **The pin door (D9)** has API →
SDK (`sshCa.pinArgoOps` / `sshCa.argoOpsPin`) → CLI (`scp ssh-ca pin-argo-ops` / `argo-ops-pin`);
IaC and UI are N/A for the same reason enrolment has neither: it is a credential-custody act at the
org root, not graph state a plan should reconcile, and the read side is the CLI and API.
`ssh_ca_argo_ops_pins` has GRANT SELECT/INSERT/UPDATE (no DELETE — an unpinned domain is simply
refused, and a deletable pin would hide which endpoint a past token was sealed for) and
`org_isolation` RLS.

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
- **THE RESIDUAL TRUST SET, named:** the cluster's **administrators**, anyone who can **read the
  sealing Secret**, anyone who can **create a pod** (or submit an ad-hoc Workflow) in the Argo
  namespace, and anyone who can **edit WorkflowTemplates** there (they can change `scp-ops-v1` after
  SCP's read-back). Any of them can obtain a certificate within its TTL — by unsealing a token in flight, or
  by changing what runs under the pinned template name after SCP's read-back. They cannot choose the
  hosts or principals a run's material names (those come from redemption), and a certificate they
  obtain carries the pinned `source-address`; but the certificate is usable against every host
  trusting the domain's CA. This is what the owner accepted in choosing Option 2 over Option 1.

## What the adversarial round found (2026-09-24) and how each was closed

- **BLOCKING — the grant was not enforced (probe A).** `serverUrl`, `allowedHosts` and the sealing
  key were binding config under `object:write`: an Operator scoped to one product repointed them at
  their own server and key, an admin proposed a legitimate change, and the Operator unsealed and
  redeemed a `root` certificate. Closed by D9; `ops-argo-lane.integration.test.ts` › "PROBE A,
  PERMANENT" proves the Operator cannot write the pin (403), a repointed binding is refused
  terminally with nothing sent to the other server, and a planted key in binding config changes
  nothing.
- **Refusals retried every tick with no Decision** — D10.
- **An aborted target still redeemed (probe B)** — D4's in-flight + newest-row checks.
- **Burn/refusal auditing had no ceiling (probe C)**; **one pod key could be certified for many runs
  (probe D)** — D6's ceiling, D4's key-reuse refusal.
- **The reachability census matched raw text**, so a commented-out caller stayed green — it now reads
  comment-stripped source (`stripComments`) and carries a control case.
- **Egress text said "nothing else" over DNS-to-anywhere and an RFC1918 API default** — D8.

## What the second verification round found (2026-09-24) and how each was closed

- **BLOCKING — the read-back was a denylist, and four bypasses went through it**, each keeping the
  pinned image and `SCP_OPS_CATALOG_VERIFY=required`: T1 a `command` override (`python -c`); T2 a
  `steps` entrypoint calling an external `templateRef`; T3 `SCP_OPS_CATALOG_PUBKEY`/`_DIR` redirected
  to an attacker volume; T4 an `onExit` `dag` with an external `templateRef`. The charter clause
  claiming "every step names the pinned digest and requires verification" was therefore false. Closed
  by the exact allowlist above; T1–T4 are permanent cases in `ops-template.test.ts` (with 21 more
  allowlist edges) and T1–T4 again through the real reconcile loop in
  `ops-argo-lane.integration.test.ts`, each ending terminal with a Decision. The clause was reworded
  to what the allowlist checks.
- **SHOULD-FIX — a stale plugin instance.** `PluginHost.start()` skipped any id already running, so an
  editor could start an instance under their own server and keep it running after re-pointing the
  binding at the pin with the same id. `start()` now fingerprints the config (module, config, secrets,
  egress allowlist, internal-egress grant) and respawns an instance whose fingerprint changed; the one
  caller that only needs the shared default alive (`ensureAliveOnly`) never reconfigures it. Proved
  over the REAL subprocess host (`host-config-refresh.test.ts`). **Census** of callers that assumed a
  started instance's config was current: reconcile, observe, the continuous-probe driver,
  pipeline-hook runs, control-runner, notify dispatch, the discovery route, managed-dep and the
  version index all call `start()` with the config they are about to act on — each is now correct by
  the host's change rather than by its own code. **Two findings the census surfaced and this PR does
  NOT fix, stated so they are not lost:** (i) `executor_bindings.plugin_instance_id` is not unique, so
  two bindings (in one org or, because host instance ids are global, in two orgs) naming one id with
  different configs now alternate restarts where before the first-started config silently served
  both; (ii) a caller between `start()` and its call can have the instance reconfigured under it by a
  concurrent `start()` with the other config. Both are the same property (instance identity is a
  tenant-chosen string, not org- or config-scoped); the ops path is protected against it by the
  plugin's own-endpoint check, the rest is a plugin-host contract change for its own increment.
- **Final round (2026-09-24).** (1) The ops read-back refusal was recognised in reconcile by a TEXT
  marker in the error message — and the host's message embeds the instance id, whose charset (#413)
  admits every character of the marker, so an instance named after it could turn a network failure
  into a template verdict. It is now `OpsTemplateRefused` (a `TriggerRefused` subclass) travelling
  under its own JSON-RPC code, -32011, read by `opsTemplateRefusalOf` off `rpcCode` as data; a
  permanent forge probe runs over the real subprocess host. Census of message-text matching in
  reconcile, plugin-api and the plugins: this was the only one; `graph/containment.ts`'s
  `isWalkDepthExceeded` matches a phrase too, but on a server-authored in-process error no tenant
  string reaches and no plugin boundary crosses, so it is not the same property. (2) The amendment's
  "fixed volumes" overstated the check — reworded as above. (3) `redeemUrl` must be https at the pin
  door (plain http only behind `SCP_OPS_ALLOW_INSECURE_REDEEM_URL=true`, for tests), and the chart's
  example is https.
- **NITs** — the enrolment and pin doors answered 500 where they meant 404/409 (a plain `Error` with
  `statusCode` is honoured only for framework errors); all five sites in `routes/ssh-ca.ts` now throw
  `notFound`/`conflict`. `normalizeServerUrl`'s comment now says what it does (the path is kept: a
  reverse-proxied prefix is a different endpoint), and the plugin's copy is asserted equal to it.

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
- **Derivation refusals terminalise the wave target on both paths** (D10; `ops_declaration_refused`
  for a bad declaration, `ops_material_refused` for everything this ADR adds), identically — the same
  functions refuse for both executors.
- **A host-reaching run is never recipe-driven, on either executor.** `argo-workflows` is not in
  `RECIPE_FORBIDDEN_EXECUTOR_MODULES`, and a change's `properties.recipe.trigger.parameters` flows
  verbatim into `TriggerIntent.parameters` (the campaign recipe guard does not see directly proposed
  changes). So on the Argo ops lane a recipe is refused **outright** at the recipe door, exactly as
  for `managed-ops`: the wave target terminalises with a Decision (`hostReachingLane: true`) and
  nothing is submitted. Behind it, the claim-time layer still refuses any recipe naming a reserved
  key (`assertNoRecipeOverride`, which had no production caller before this path), and ops
  parameters are spread last.
- **The server-reserved trigger-parameter keys of this lane**, for any shared registry of such keys
  (M28.4 is adding one; register these there when it lands):
  - the ADR-0052 bound — `opsRole`, `opsInventory`, `opsEgressAllowlist`, `opsPrincipals`,
    `opsCredentialSecretKey` (`SERVER_DERIVED_OPS_KEYS`);
  - the Argo delivery keys — `opsRunTokenSealed`, `opsRunId` (`ARGO_OPS_DELIVERY_KEYS`).
  Each is covered by its own case in `ops-argo-lane.integration.test.ts`, enumerated from those
  constants.
