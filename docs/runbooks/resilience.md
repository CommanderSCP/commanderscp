# Runbook — instance resilience: multi-cluster, failover, and backup/PITR (M26, D7)

**Status:** normative operator documentation for the design accepted in
[docs/proposals/multi-region-instance-resilience.md](../proposals/multi-region-instance-resilience.md)
(v0.3, all seven owner decisions settled in its §11). This runbook does not re-argue that design —
see the proposal for the evidence, the review findings, and the rejected alternatives (§10). It
**subsumes [ADR-0024](../adr/0024-decision-and-audit-retention.md) F9** ("a DB growth/sizing/backup
runbook under `docs/runbooks/` — none exists"): §8 below is that runbook. [DESIGN.md](../DESIGN.md)
§17's Availability and Upgradeability rows point here.

Some of the mechanisms named below (the divergence rails, the resync operation, the audit witness,
the instance-doctor route, the chart's multi-cluster values contract) land across the M26 milestone
sketch (proposal §12, M26.1–M26.4). Where a mechanism has not yet shipped, this runbook still states
its target operational contract as designed and accepted — treat commands and routes named here as
the destination, and check the installed version's `scp doctor`/`scp federation doctor` output for
what a given deployment actually enforces today.

## 1. Who this is for, and the one sentence that matters

You are an operator standing up, running, or recovering an SCP instance that must survive losing a
Kubernetes cluster (or region, or availability zone). Read this before you provision anything, not
after something falls over.

**The one sentence:** multi-cluster is a property of *one instance*, never a multiplication of
instances — one instance is one PostgreSQL database, api/worker compute may span several member
clusters around it, and there is no second commander, no shadow instance, no second database
anywhere in this design (proposal §10). Everything below follows from that.

## 2. The member-cluster model

### 2.1 Vocabulary you need before anything else makes sense

- **Instance** — one running deployment of SCP: one PostgreSQL database, one per-org federation
  identity/journal/cursor/peer set. Multi-tenant: an instance hosts many orgs, and federation role
  (commander/outpost/retrans) is set **per org**, not per instance — so a single instance can be a
  commander for one tenant and an outpost for another (§4's "multi-tenant coupling" covers why that
  matters).
- **Member cluster** — one Kubernetes cluster (or compose/VM site) running some of an instance's
  api/worker compute. An instance *spans* one or more member clusters; a member cluster is never
  itself an instance.
- **XO** — the designated *standby* member cluster: it holds the synchronous Postgres standby, warm
  api/worker capacity, and a pre-provisioned fallback dial entry. Same command structure as every
  other member cluster, not a second captain — it is a designation, not a second instance. §7 is the
  runbook for what happens when the XO takes command.
- **Infrastructure region** — where *SCP's own compute* sits. Deliberately not called "region": that
  word is reserved for where the org's coordinated workloads run (`amer`/`apac`/`emea`,
  [GLOSSARY.md](../GLOSSARY.md) "region"). Do not conflate the two when talking to anyone outside
  this runbook.

### 2.2 The four invariants, in operator terms

| # | Invariant | What you must do | What you must never do |
|---|---|---|---|
| **I1** | Exactly one writable Postgres primary at any moment, for the whole instance. | Run a real Postgres HA layer (Patroni, CloudNativePG, or a managed service) with **working fencing**. This is your responsibility — SCP does not ship it. | Assume SCP will detect or protect you from split brain. It cannot (§3). |
| **I2** | Compute is symmetric and stateless across member clusters, and every worker reads/writes the *primary* — never a read replica. | Point every member cluster's Helm release at the same logical DSN; run the bulk of worker capacity near the primary for latency; treat a distant member cluster as a survival organ, not a speed-up. | Offload any correctness-bearing read (policy gates, freeze admission) to a replica. A worker that did would evaluate a freeze against lagged state and silently ship into it. |
| **I3** | One dial address per instance, with a provisioned fallback list. | Prefer operator DNS/VIP/GSLB on the commander's base URL first. Where that is unavailable (air-gapped/enclave networks), provision the ordered per-peer dial-URL list *before* you need it, with SAN coverage and per-URL timeouts (§7 preconditions). | Let a scheme-downgrade fallback (`https` primary, `http` fallback) into the list — SCP refuses this at write time as a 400, and you should not want it anyway. |
| **I4** | RPO > 0 (async replication) must be **loud**, never silent. | Run sync-quorum for any commander-hosting instance (the only posture where §4's B1/B2 hazards cannot occur); for async postures, rely on the divergence rails (§7.2 of the proposal) to turn a lost tail into a named, Decision-recorded refusal instead of quiet data loss. | Treat a green `scp audit verify` or a "confirmed" bundle transfer as proof nothing was lost after an async restore — see §3 and §7.2 step 5 below (the peers-witness comparison, proposal §7.2.7). |

## 3. The Postgres HA requirement — the load-bearing part

**SCP requires exactly one writable Postgres primary for the instance, at all times, and SCP does
not build or ship the mechanism that guarantees it.** That mechanism — streaming replication with
automatic promotion and **fencing** of the old primary — is the operator's Postgres HA layer:
Patroni, CloudNativePG, or a cloud-managed HA Postgres service. All of these are fine, and all are
air-gap-compatible in their self-hosted forms (charter principle 5). SCP adds no second consensus
store to arbitrate this itself — that would be a second required stateful dependency, barred by
charter principle 4 without owner sign-off, and nothing in this design needs one.

State the requirement to whoever runs your Postgres HA layer, in these terms:

- Exactly one primary must accept writes at any moment, instance-wide.
- On any failover, the demoted node **must** be fenced — stopped, network-isolated, or otherwise
  made incapable of accepting writes — before or as part of promoting the new primary.
- The fencing mechanism must be tested, not assumed. "The old primary usually shuts down" is not a
  fencing guarantee.

**The teeth, stated once, in bold, because this is the sentence that matters most in this whole
document: if fencing fails and a demoted primary keeps taking writes, SCP silently loses those
writes.** Every serialization primitive SCP relies on — session-scoped advisory locks, sequence
uniqueness, the outbox's `FOR UPDATE SKIP LOCKED` claims — is a **per-database** guarantee. A
demoted primary that is still accepting writes is a second, independent database as far as any of
SCP's own machinery is concerned; each side enforces its own invariants correctly and in complete
ignorance of the other. Nothing in SCP detects the split, and nothing in SCP can, by construction —
detecting it would require exactly the second consensus mechanism principle 4 rules out.

This residual risk is accepted, not eliminated (proposal §10, "named residual risk — unfenced split
brain"). Two things narrow its consequences without removing it:

- **The generation stamp** — a per-org counter, bumped by the resync operation (§7.2.6 of the
  proposal) and by the promotion runbook below (§7). It is a **post-hoc forensic identifier**, not a
  prevention mechanism: it lets someone reading the record later attribute which journal/audit
  entries pre-date and post-date a given failover or resync event. It does not stop a split-brain
  write from being lost; it stops the loss from being *unattributable*.
- **The divergence rails** (§4, §7.2 of the proposal) — they cannot prevent a fencing failure, but
  they do catch its most common downstream symptom: a restored-from-async-lag primary silently
  serving a stale tail to peers. That is a narrower problem than fencing failure and the rails solve
  it directly (§7.2 step 5 below — the peers-witness comparison, proposal §7.2.7 — is the detection
  step).

If your HA layer's fencing story is "best effort" rather than tested, say so in your own runbook and
treat every promotion as a possible silent-loss event until the peers-witness comparison (§7.2 step
5 below; proposal §7.2.7) and a manual audit-chain spot check clear it.

## 4. Sync vs. async: the decision table

Sync-quorum replication (RPO = 0) is the only posture in which the B1/B2 hazards below **cannot**
occur at all — there is no lost tail to serve, because the standby that would be promoted already
has every committed write. Async replication is a legitimate, supported choice for outpost and
retrans instances, on the condition that the divergence rails (§7.2 of the proposal) are running as
the compensation.

| Instance role | Supported posture | RPO | Can B1 (lost-tail journal divergence) or B2 (audit-chain fork) occur? | Required compensation |
|---|---|---|---|---|
| **Commander-hosting** | **Sync-quorum** (the supported posture — proposal D2) | 0 | No, if sync quorum is real and fencing holds. | None beyond I1's fencing. |
| **Commander-hosting**, run async anyway | Acceptable only under duress; not the supported posture | > 0 | Yes | Full §7.2 rail set + the resync operation + the peers-witness comparison (proposal §7.2.7) on every failover. |
| **Outpost-hosting** | Async acceptable | > 0 (operator's replication lag) | Yes | §7.2 rails; §5.2's bold-faced consequence still applies regardless of posture. |
| **Retrans** | Async acceptable | > 0 for metadata; separately bounded for in-flight bytes (§5.3) | Yes (metadata only) | §7.2 rails + byte-channel durability (§5.3). |

**Multi-tenant coupling, stated plainly:** posture is set **per instance**, not per org, because it
rides the single underlying Postgres database. If one tenant org on a shared instance holds the
commander role and another holds outpost, the **strictest role governs the whole instance** — you
cannot run async for the outpost tenant and sync for the commander tenant on the same database. Plan
tenant placement with this in mind before you mix roles on one install.

**D2's condition — read this before assuming this section changes anything about federation
transport:** this decision is **database-replication-only**. It does not enforce poke mode on any
outpost or retrans, and it does not alter federation transport in any way. Outposts and retrans keep
working in isolation and, when connected (non-air-gapped), keep polling the commander on their own
cadence regardless of this instance's replication posture. Poke mode remains strictly opt-in per
[ADR-0009](../adr/0009-optional-poke-mode-federation.md), on both ends independently. Do not read
"sync-quorum recommended" as license to also flip on poke mode, and do not read "async acceptable"
as a reason to disable it — the two decisions are orthogonal.

## 5. Per-role recipes

Every role runs the common pattern (§2.2's four invariants). What differs is what each role needs on
top of it.

### 5.1 Commander-hosting instance

The full pattern, with sync-quorum as the recommended (and only B1/B2-immune) posture, and the
divergence rails **mandatory** regardless of posture — an outpost pulling from you may still hit a
narrow-scope path, and rail 4's tail attestation is scope-independent by design (proposal §7.2 item
4), so it is worth running even when you believe you are sync. Remember the multi-tenant coupling
from §4: if this instance also hosts an outpost-role tenant, the commander's posture requirement
governs the whole database.

A multi-tenant commander's failover moves the dial address for **every** tenant org's peers at once
— plan the fallback dial list (§7 preconditions) with that blast radius in mind, not per-org.

### 5.2 Outpost-hosting instance

The same pattern, at whatever tier the domain warrants. But say the consequence plainly, because
assuming otherwise is the single most dangerous misreading of this whole design:

**An outpost's self-authored state has no off-site copy. There is no upward push of an outpost's own
audit trail or sync journal to the commander today (B7 in the proposal) — the commander holds only
what it has pulled, filtered to the peer scope. An outpost's own Postgres replication IS its entire
DR story.** Do not assume "the commander has a copy" for anything an outpost authored locally
(changes, control outcomes, approvals, local audit segments). If your outpost's Postgres is not
independently backed up and/or HA-replicated, that data has exactly one copy in the world.

### 5.3 Retrans instance

The same pattern, plus byte-channel durability, because a retrans's job-relevant state is split
between Postgres (ledger rows, lease fencing) and whatever holds the actual relay bytes:

- **Either** S3-compatible delivery targets — already built in the delivery path
  ([delivery-s3.ts](../../apps/server/src/federation/delivery-s3.ts)); a self-hosted MinIO in the
  enclave keeps this air-gap-legal and principle-4-legal (S3 is never *required*, it is one of two
  acceptable delivery substrates) — **or** an operator-replicated RWX volume for the drop
  directories. Pod-local filesystem drop directories with no replication is the one configuration
  this design does not support for a multi-member retrans; the chart refuses to render that
  combination (proposal §7.4).
- **One retrans instance = one Postgres.** The lease fencing that prevents two workers from
  double-relaying the same change (`claimRelayBuild`) is scoped to one database. A "standby retrans"
  with its **own** database is not a supported HA pattern for retrans — it is exactly the rejected
  second-instance pattern (§10 of the proposal): it would fork the ledger, not protect it. If you
  need retrans HA, add member clusters to the *same* retrans instance, sharing the *same* Postgres —
  never stand up a second retrans instance as a "backup."

## 6. State survivability census

What survives losing the cluster that holds the Postgres primary, and what does not, because it is
per-cluster Kubernetes Secret material that Postgres replication never touches:

| Material | Lives in | Survives Postgres replication? | What you must do |
|---|---|---|---|
| Graph, changes, campaigns, policies, Decisions, audit chains, sync journals, cursors, peers (all per-org) | Postgres | **Yes** | Nothing beyond §3's HA requirement. |
| pg-boss job state, outbox | Postgres | **Yes** — in lockstep with everything else (§8's restore-re-executes section explains why that is a hazard, not only a convenience). | Nothing extra; read §8 before your first restore. |
| Per-org federation Ed25519 + cosign keys | Postgres | **Yes** | Note: plaintext columns — DB encryption-at-rest is your control, not SCP's. |
| Secrets-vault ciphertext | Postgres | Yes — **but unreadable without the KEK below** | See the next row; without it the ciphertext survives and is useless. |
| `SCP_SECRETS_MASTER_KEY`, `SCP_COOKIE_SECRET` | Kubernetes Secret, **per cluster** | **No** | Set `appSecrets.existingSecret` in every member cluster's Helm release, pointing at the **identical** Secret content everywhere. A cluster promoted without the matching key holds every plugin/managed-IaC credential permanently undecryptable, discovered at first use — and if the key is unset entirely, the fallback is an ephemeral per-boot random key with only a warning. Production mode (D6) refuses to boot on an ephemeral key; do not rely on that refusal as your only safeguard — provision the Secret correctly in the first place. |
| Database role credentials (`scp_app`/`scp_pgboss` passwords) | Kubernetes Secret, **per cluster**; the migrations Job resets roles from it | **No** | Set `postgres.existingSecret` identically in every member cluster. Chart-generated credentials are single-cluster-only by construction (Helm's `lookup` persists per-cluster, not cross-cluster) — a second member cluster installed with generated credentials does not just fail to connect, it **clobbers the first cluster's live credentials** on the shared database. The migrations Job's provisioning guard now refuses a mismatched reset unless `migrations.allowPasswordReset: true` is set deliberately for an intentional rotation. |
| mTLS CA/cert/key/CRL | Kubernetes Secret, **per cluster**, mounted as files | **No** | Replicate the Secret to every member cluster. SANs must cover every dial name (§7 preconditions) — checked by `scp federation doctor` / the instance doctor route. |
| Object storage (filesystem provider) | RWO PVC | **No** | Use a replicated RWX volume, or the S3 provider (proposal D7 — being built alongside this runbook). Filesystem-provider object storage is single-node state; plan accordingly for multi-cluster. |
| Retrans drop directories | Pod-local filesystem, or S3 delivery targets | **No** (filesystem) / **Yes** (S3) | See §5.3 — recommend S3-compatible targets. |
| `SCP_DELIVERY_S3_ENDPOINTS` allowlist | Env var, per cluster | **No** | Must be identical in every member cluster; doctor-checked. |
| Scan-db cache | RWO PVC | **No — and that is acceptable.** | A rebuildable cache, not evidence. Document it as sacrificial; do not spend replication effort on it. |
| NATS JetStream (optional event bus) | Operator-managed | n/a | Remains optional. The Postgres bus is always the correctness path regardless of whether NATS is enabled — losing NATS state is a latency event, never a correctness one. |

**The pattern across every "No" row:** it is Kubernetes Secret or per-cluster-volume material, never
Postgres. Postgres replication is comprehensive for everything that determines *correctness*; it is
comprehensive for *nothing* that determines *access to that correctness* (keys, credentials, TLS
identity). Provisioning every "No" row identically across every member cluster, before you need it,
is the entire multi-cluster values contract (proposal §7.4).

## 7. The promotion runbook — "the XO takes command"

This is what you do when the member cluster holding the Postgres primary is gone and the XO (§2.1) —
the designated standby member cluster — is taking over.

### 7.1 Preconditions — verify these *before* you need this runbook, not during

Do this at provisioning time and re-verify it as part of routine operational review, because none of
it can be fixed quickly mid-incident:

- **SAN coverage.** The commander's federation server certificate must carry **every** dial name as a
  Subject Alternative Name: the VIP, the GSLB name if you use one, and every entry in the fallback
  dial-URL list, including the XO's own dial entry. A cert missing a SAN for the name a peer is about
  to try means that peer fails TLS verification at exactly the moment it needs the fallback to work.
- **The ordered dial-URL list is provisioned, not improvised.** Every outpost/retrans peer that needs
  a fallback beyond DNS/VIP/GSLB has its dial-URL list set through the same door as any peer-config
  change (`ADR-0022`: peer rows are local, per-side, never journaled) — **before** the failover, with
  the XO's entry labeled as such. A list assembled during the incident is a list assembled under
  pressure with no chance to test it.
- **XO readiness is green.** Check `scp doctor` / the XO-readiness check for: `appSecrets` and
  `postgres` existingSecrets present and correct on the XO cluster, mTLS Secrets present with full SAN
  coverage, the synchronous standby connected and current, and the fallback dial entry actually
  published to peers. Do not discover a missing Secret during the incident.

### 7.2 The procedure

1. **The operator's Postgres HA layer promotes and fences** (§3, invariant I1). This step is not
   SCP's — it is Patroni's, CloudNativePG's, or your managed service's job, and it must have already
   happened, or be actively happening, before the rest of this procedure has anything to act on.
2. **Surviving/XO compute reconnects to the new primary.** With the pool-timeout fix in place
   (proposal A6), connections fast-fail onto the promoted primary rather than hanging at OS TCP
   patience. If DNS/VIP/GSLB fronts the primary, this is largely automatic; if not, this is where the
   pre-provisioned dial-URL list earns its keep.
3. **Peers reach the new address.** A commander failover moves the dial address for **every** tenant
   org's peers at once (§5.1) — outposts/retrans either follow the (now-repointed) DNS/VIP, or work
   through the ordered dial-URL fallback list, each entry tried under its own explicit timeout, never
   the platform-wide connect default.
4. **Divergence check runs on the next pulls, automatically.** Any peer whose cursor is ahead of what
   the (possibly lag-restored) primary can currently prove gets a `journal_divergence` refusal instead
   of a silently stale bundle. If you see these refusals, that is the rails working exactly as
   designed — resolve with the resync operation (`scp federation resync --peer <name>`), which is a
   deliberately net-new, security-sensitive, mutually-authorized operation: it resets the importing
   side's cursor and imports in a forced-overwrite mode that bypasses the normal revision-staleness
   guard, **only** under that permit, Decision-recorded on both sides. Do not attempt to route around
   a standing `journal_divergence` verdict via `scp federation pair … --sync-scope full` — that command
   issues `permitCursorReanchor`, which adopts the forked chain, and is refused while a divergence
   verdict is standing for that peer precisely to stop that shortcut.
5. **Peers-witness comparison.** Compare your restored instance's local audit-chain head against what
   every peer has recorded as your journal's attested tail — each importer persists your exported
   `audit_segment` entries' content hash as a passive witness of your audit-chain head. Do this
   explicitly: `scp audit verify` alone is structurally unable to see truncation, because **any prefix
   of a valid hash chain verifies as valid**. A green `scp audit verify` after a restore is not
   evidence of anything; the peers-witness comparison is what actually detects a truncated or forked
   chain. Peers are witnesses here, never a restoration source (proposal §10 — federation is not
   backup); if the comparison finds a mismatch, that is forensic evidence for §8's restore procedure,
   not a signal to pull state from a peer.
6. **Run `scp federation doctor`.** Have it re-run the divergence rails proactively against every
   peer, rather than waiting for the next scheduled pull to surface a problem passively.
7. **Bump and record the generation stamp.** The promotion itself bumps the per-org generation stamp
   (§3) and records it with a Decision, alongside anything the divergence rails or the resync
   operation surfaced. This is the forensic marker a later reader uses to attribute which entries
   pre-date and post-date this event — it does not undo anything that was lost; it makes the loss
   attributable.

## 8. Backup, PITR, and the restore-re-executes procedure (subsumes ADR-0024 F9)

### 8.1 Baseline: every production instance runs WAL archiving + PITR

There is no built-in backup mechanism in SCP itself — like Postgres HA (§3), backup and
point-in-time-recovery tooling is the operator's Postgres tooling, chosen and run by the operator.
Every production instance needs, at minimum:

- **Continuous WAL archiving** to durable storage, plus periodic base backups, giving you
  point-in-time recovery to any moment covered by the retained WAL — not merely "restore the last
  nightly dump."
- **Air-gap-compatible tooling only** (charter principle 5). This rules out any backup product whose
  normal operation requires phoning a vendor's cloud service — it does not rule out self-hosted,
  vendorable open-source tooling (a self-hosted WAL-archiving setup driven by `archive_command`, a
  self-hosted backup manager such as pgBackRest or WAL-G run entirely inside your own network, or the
  backup mechanism your HA layer already ships, e.g. CloudNativePG's built-in `Backup`/`ScheduledBackup`
  objects against an in-cluster or self-hosted object store). Whatever you choose, it must run and be
  restorable with zero outbound network calls, exactly like everything else in this platform.
- **This replaces the bundled eval Postgres for anything production.** The chart's
  `postgres.evalInCluster` path is explicitly marked evaluation-only in `deploy/helm/values.yaml` —
  "NOT for production (no HA, no backups, no tuning)." If your instance is still running on it, that
  is the first thing to fix, not a footnote.

### 8.2 RPO/RTO worksheet, per role

Work this arithmetic per peer, not once for the whole instance — different peers have different
cadences and different dial-list depths.

| Role / posture | RPO (data loss window) | RTO (recovery time) — the components to sum |
|---|---|---|
| **Commander-hosting, sync-quorum** | 0 (by construction, if fencing held) | HA layer promotion+fencing time + pool fast-fail (A6) + DNS/VIP propagation (or dial-list walk if no DNS failover) |
| **Commander-hosting, async (not the supported posture)** | Bounded by replication lag at time of loss | As above, **plus** the divergence-rail detection + resync-operation time on every affected peer |
| **Outpost-hosting** | Bounded by the outpost's own replication lag — this is the outpost's *entire* DR story (§5.2) | Outpost's own HA layer promotion time; nothing about the commander side helps you here |
| **Retrans — metadata (ledger, lease state)** | Bounded by the retrans's own replication lag | Retrans's own HA layer promotion time |
| **Retrans — in-flight artifact bytes** | 0 with S3-compatible/replicated-RWX delivery targets; **unbounded loss (the in-flight artifact) with unreplicated pod-local filesystem drops** | N/A once lost — the walkthrough in §9.4 covers the reopen path for the pre-commit case; there is no reopen path for the post-commit, unreplicated case |
| **A peer's staleness after any commander-side promotion** | — | Worst case ≈ effective pull cadence (60s frequent / up to 900s sparse / 12h ceiling for a poke-mode peer's sparse safety-net) + (number of dial-list entries actually tried) × per-URL dial timeout + DNS TTL if DNS-fronted. A poke-mode peer's failover recovery is bounded by its *sparse* interval specifically — a deliberate, accepted cost of running poke mode, not a defect. |

### 8.3 "A restore re-executes" — the section review demanded

**Restoring SCP from a backup does not merely roll back state — it re-executes work, because two
kinds of state that ride along with everything else are not safe to treat as inert history:**

- **pg-boss job state rolls back in the same transaction boundary as everything else**, because it
  lives in the same database (schema `pgboss`). A restore to an earlier point does not just roll back
  your graph and Decisions — it un-completes whatever jobs had run between the restore point and the
  moment of loss. Those jobs **will run again** once workers resume, because from pg-boss's
  perspective they are simply queued and not yet done.
- **Executor idempotency keys are minted fresh on every plan compile, not derived deterministically.**
  `idempotencyKey = waveTargetId`
  ([reconcile.ts:1771](../../apps/server/src/coordination/reconcile.ts)) — the wave target's own row
  id, which is a **fresh UUID every time a plan is recompiled**. A restore that rolls back past a compile and then
  triggers a recompile produces **new** wave targets with **new** idempotency keys. Any executor call
  gated on that key (a triggered pipeline, an opened PR) therefore sees a request it has never seen
  before — not a replay it can dedupe. **A restore can and will re-trigger external side effects, with
  new keys, on external systems SCP does not control.**

**The procedure, in order:**

1. **Quiesce workers before restoring.** Scale every worker-capable process down, or set
   `SCP_ROLE=api` on every replica, so nothing is claiming jobs, running reconcile ticks, or calling
   out to an executor while the database underneath it is being swapped for a restored copy.
2. **Restore the database** to the chosen point-in-time.
3. **Reconcile executor/PR state against the restored SCP state before re-enabling workers.** Walk
   whatever the restored state believes is in flight (open PRs, triggered pipeline runs, pending
   deploys) against what actually exists on the executor side, and manually close, merge, or cancel
   anything that is now a duplicate of work the executor already completed between the restore point
   and the moment of loss. This step exists because step 4 will otherwise re-trigger it.
4. **Re-enable workers** (`SCP_ROLE=all`/`worker` again) only after step 3. Expect a burst of
   re-executed work as queued pg-boss jobs and re-compiled wave targets fire — this is normal, not a
   sign the restore went wrong, and is exactly what "a restore re-executes" means.

**Name both halves of the bump-gate behavior explicitly, because a partial mental model here causes
real duplicate work:** M25.8's freeze-gates refuse dependency **auto-merges** during a freeze —
that half still holds after a restore, and a restore does not reopen it. But **D8 explicitly permits
PR *authoring* to continue** — a dependency-bump job can still open a new PR even while merges are
gated. That means **duplicate PRs are possible after a restore**: a bump PR opened before the restore
point, rolled back by the restore, can be re-opened by the re-executed job in step 4, sitting
alongside (or in place of) whatever a human already did with the original. Check for duplicates in
step 3, not just triggered pipeline runs.

## 9. Failure walkthroughs

Four cases, read as "what actually happens," not as architecture.

### 9.1 A member cluster without the primary dies

The load balancer/GSLB drains it. Every other member cluster's api/worker compute continues against
the unchanged Postgres primary — nothing about the primary's location changed, so this is the cheap
case. SSE clients on the dead cluster's api pods reconnect onto surviving api pods; per
[ADR-0025](../adr/0025-sse-contract-parity.md) there is **no replay** — live events during the
reconnect window are dropped by design, and the client resyncs through a cache-invalidation signal on
reconnect, not by replaying missed events. No persisted data is lost. **Operator action: none** —
this case is designed to require none.

### 9.2 The cluster holding the Postgres primary dies

This is §7's promotion runbook, end to end: the HA layer promotes and fences (§3); surviving/XO
compute fast-fails onto the new primary; sync-quorum means RPO = 0 and you are simply done; async
means the divergence rails turn any lost tail into named `journal_divergence` refusals on the next
pulls, which the resync operation converges, with the event recorded in the audit trail and the
generation stamp bumped. Recovery time is computable per peer using §8.2's worksheet.

### 9.3 An outpost's cluster dies

The same pattern one tier down, at the outpost's own scale. The commander's view of that outpost
degrades **honestly** — freshness reporting, anchored to confirmed transfers, reports staleness or
unknown, never a fabricated "still live" signal. But the ceiling on what the commander's copy can
give back is exactly the peer-scoped subset it already had: the outpost's self-authored state
survives only as far as **the outpost's own replication** reaches (§5.2, B7) — say this out loud to
whoever is worried, because "the commander probably has a copy" is the wrong intuition here.

### 9.4 A retrans cluster dies

Two genuinely different cases, and the difference is whether the relay's ledger row had committed
before the cluster went down:

- **Crash before the ledger commit.** The row is still `pending`; the claim's lease lapses, and the
  next tick's claim picks it back up and rebuilds the tarball from scratch. This is already the
  system's normal crash-recovery path — no operator action needed beyond letting the tick loop run.
- **Crash — or cluster loss — after the ledger commit.** The row is now `submitted`, and the built
  artifact's actual bytes are wherever they were written. With an S3-compatible delivery target (or a
  replicated RWX volume), the artifact survives and the downstream hop can still read it. With
  unreplicated pod-local filesystem drops, **the artifact is gone, and the auto-relay loop will not
  retry it** — a `submitted` row is no longer `pending`, so nothing re-claims it automatically.
  Reopening it today is a manual operator action: identify the affected change, confirm the artifact
  is genuinely unreadable (the readable-artifact verification rail added alongside this design will
  do this check before treating a build as terminal, and reopen it automatically when it is not
  readable — but a fully manual environment still needs an operator to notice and re-trigger
  `scp federation relay --change <id>`). This asymmetry is exactly why §5.3 makes byte-channel
  durability part of the retrans recipe rather than an optional hardening step.

## 10. Quick reference

- **Before you provision anything:** §7.1's preconditions (SAN coverage, dial-URL list, XO readiness)
  and §8.1's WAL archiving/PITR baseline. These are not incident-time fixes.
- **On any failover:** §7.2, in order — HA layer promotes/fences, compute reconnects, peers reach the
  new address, divergence check runs, peers-witness comparison, `scp federation doctor`, bump the
  generation stamp.
- **On any restore:** §8.3, in order — quiesce (`SCP_ROLE=api` only), restore, reconcile
  executor/PR state (check for duplicate bump PRs — M25.8 refuses auto-merge, not authoring), then
  re-enable workers.
- **Never assume:** an outpost's or retrans's Postgres replication is optional (§5.2, §5.3); a green
  `scp audit verify` proves nothing after an async restore (§7.2 step 5); federation is a backup
  (proposal §10) — peers are witnesses, never a restoration source.
