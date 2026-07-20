# ADR-0016: Scoped scan-requirement policies (platform / trust domain / org / containment domain / service / component), most-restrictive-wins

**Status:** Accepted (owner-decided 2026-07-19; **tier model corrected by the owner 2026-07-20** — see §1)
**Context doc:** [docs/proposals/promotion-and-execution-model.md](../proposals/promotion-and-execution-model.md)
**Relates to:** [ADR-0013](0013-supply-chain-scan-sbom-manifest.md) (scan as a boundary-authorization gate); [ADR-0015](0015-cosign-cross-boundary-signing.md) (the sibling cosign-verify gate); charter principle 2 (graph-native), principle 4 (PostgreSQL-only), principle 6 (explainability)

## Terminology — two different things both called "domain"

This ADR uses two tiers whose names collide in the codebase. They are **never** the same thing:

- **trust domain (partition)** — the federation/trust boundary a *deployment* lives in. Owner framing (2026-07-20): *"a domain represents something similar to an AWS **partition**. Multiple orgs and their services build within a partition."* Like `aws` / `aws-us-gov` / `aws-cn`, a partition is **ambient**: every resource is born in exactly one, nothing crosses it, and it is **not** modelled as a row that groups accounts. It sits **above** org.
- **containment domain** — the `domain` **object type** seeded at `apps/server/drizzle/0002_rls_rbac_seed.sql:152` (`objects.domain_id`, `containment.ts`), an ordinary intra-org grouping that sits **below** org. `schema.ts:944-947` explicitly records that these are different concepts.

Wherever this document (or any doc it touches) needs one of them, it says **"trust domain (partition)"** or **"containment domain"** in full. Bare "domain" is not used for a tier — in prose *or* as a stored value: the floor table's tier literal is `trust_domain` (§3), never bare `domain`.

## Context

ADR-0013 made scanning a **boundary-crossing authorization gate**. But the pass-criteria is fixed too coarsely today: the scan control reads a **flat per-binding** `config.threshold` (`scan-result-control/src/index.ts` `resolveThreshold`; `ScanThresholdSchema` = `maxCritical`/`maxHigh`/`maxMedium`/`maxLow` in `supply-chain.ts`). One threshold per binding cannot express "the platform floor is *maxCritical: 0*, this org tightens *maxHigh* to 0, and this component tightens *maxMedium* to 5."

The policy engine **already** does exactly the right kind of resolution for other controls: `policy-resolve.ts` `matchPoliciesForTargets` matches org → containment domain → service → component containment, and `policy-model.ts` `resolvePolicies` **unions** `requireControls` with **stricter-wins** semantics — a child scope can only **ADD** controls, never drop one. Scan pass-criteria should reuse this resolver rather than invent a parallel one.

### What exists today (grounded — do not overstate)

1. **There is no instance-wide *policy* scope today.** Policy matching is org-rooted (`policy-resolve.ts:40-49`), and `containmentChain` (`containment.ts:79-115`) is **org-filtered on every join and rooted at the org root** — it *structurally cannot* express any tier above org. Two tiers above org are therefore genuinely new.
   The earlier draft of this ADR said "there is no instance-wide (cross-org) scope today; everything is org-rooted under RLS; every table carries `orgId`." **That was wrong as written**: `orgs` and `state_transitions` carry no `orgId` at all, and `object_types` / `relationship_types` / `roles` carry a **nullable** `orgId` whose NULL rows are exactly an instance-wide, operator-set, tenant-read primitive (`apps/server/drizzle/0002_rls_rbac_seed.sql:44-70`). That nullable-orgId global-row pattern is the **closest structural precedent** for what this ADR needs.
2. **The precedent does not generalise to `objects`.** The `objects` RLS policy has **no `OR org_id IS NULL` escape** (`apps/server/drizzle/0002_rls_rbac_seed.sql:73-77`), so policies — which are graph objects — **cannot** use the nullable-orgId pattern without schema + RLS surgery.
3. **The gate context already threads a digest.** The gate passes `{changeId, targetObjectIds, gateRef}` **plus a conditional `artifactDigest`**: `gate-orchestrator.ts` `buildControlContext` includes `artifactDigest` only when the change tracks one, and `scan-result-control` reads `req.context.artifactDigest`. Both shipped in M17.1 (#92) and are on `main`. That conditional-context threading is the pattern a resolved effective threshold **reuses** — it is not future work.
4. **Containment ordering has a documented tie.** `containment.ts:60-73` records that containment-domain-vs-service is **not** a strict ordering (a genuine tie at equal depth). Any design relying on "most specific wins" override semantics would be undefined at that tie. See §4.

## Decision

Make scan pass-criteria **scoped, most-restrictive-wins** criteria over a **six-tier chain**.

### 1. The tier chain (corrected, owner 2026-07-20)

Top-down:

```
platform → trust domain (partition) → org → containment domain → service → component
```

- **Most-restrictive-wins at every tier.** The **effective threshold is the per-severity MIN** across every applicable scoped scan-requirement:
  `effective.maxCritical = MIN(platform, trustDomain, org, containmentDomain, service, component).maxCritical` — likewise `maxHigh` / `maxMedium` / `maxLow`. A child may only **TIGHTEN**, never loosen.
- This mirrors the existing stricter-wins `requireControls` union (`resolvePolicies`): a child scope can make the gate harder to pass, never easier. A tenant cannot loosen the platform or trust-domain floor; an org cannot loosen below its own service/component floors.
- **Why `platform` sits above the trust domain.** One commander federates **across** partitions (reaching air-gapped ones via retrans), so a platform-wide floor spanning partitions is meaningful. The owner's framing put the trust domain "at the top" *relative to org* — this chain preserves exactly that, and adds the cross-partition tier above it.

### 2. Org-and-below tiers reuse existing machinery, unchanged

**org / containment domain / service / component** scan-requirements are ordinary **policy/graph data**, matched and resolved by the **existing** `matchPoliciesForTargets` / `resolvePolicies` + `containmentChain` seam — no new resolution engine, no new table, no RLS change. New pass-criteria arrive as relationship/policy data, exactly as charter principle 2 requires.

### 3. The two above-org tiers — ONE instance-scoped floor table

`containmentChain` cannot reach above org, and the nullable-orgId escape is unavailable on `objects` (Context 2). So the two above-org tiers get **one** new structure — not two:

- **A single instance-scoped floor table with no `orgId`.** It carries **both** above-org tiers through two discriminator columns:
  - `tier`: `platform | trust_domain` — the literal is spelled `trust_domain`, **never** bare `domain`, so the column value cannot be confused with the `domain` object type (the containment domain) that already exists in the schema.
  - `origin`: `local | federated` — locally set by this deployment's operator, or arrived over federation.
- **Tenant-READ / operator-WRITE**, following the **pattern** of the nullable-orgId global rows on `object_types` / `relationship_types` / `roles` (`apps/server/drizzle/0002_rls_rbac_seed.sql:44-70`): operator-set, tenant-readable, never tenant-writable. It follows that pattern as its **own table** precisely because the pattern cannot be applied in place (the `objects` policy has no NULL-org escape).
- **Why one table covers both tiers.** A deployment **is** in exactly one partition — ambient, like AWS. So the trust-domain floor applies to **every** org hosted on that deployment; it needs no per-org row and no org column. Platform floors arrive **federated-in** from the commander (`origin: 'federated'`), consistent with "the commander is the source of truth for global config; outposts hold it read-only" (DESIGN §13).
- It is a **Postgres table, not a service** (principle 4). No authz service, no external policy engine.

**Explicitly rejected mechanisms** (considered, and why not):

- **(a) Surgery on the `objects` RLS policy to add an `OR org_id IS NULL` escape.** Rejected: it would widen the tenant-isolation blast radius of *every* graph object — the one table where a policy bug is maximally costly — to buy a floor that a purpose-built table gives with none of that risk. Cross-tenant leakage on `objects` is precisely the failure mode §4.2 of DESIGN is built to make require two independent failures.
- **(b) A privileged table living *outside* tenant RLS, read over the privileged connection.** This was the earlier draft of this ADR, which described itself as "the sharp edge." Rejected: routing a tenant-request read through the privileged connection means every read path must hand-guarantee what RLS would have guaranteed structurally. The tenant-read/operator-write pattern above keeps the read inside ordinary tenant-scoped access with a read-only policy, so no request path needs the privileged connection to *evaluate* a gate.

### 4. Resolution — design (A), recommended, and why order-independence matters

- **(A, recommended):** **ONE** scan control whose **effective threshold** is the per-severity MIN across all applicable scoped scan-requirements. Requirements resolve from graph-native policy data for org-and-below, with the instance-scoped floors (platform + trust domain) merged in as always-present contributors; the resolved effective threshold is **threaded to the control via the gate context** — reusing the shipped conditional-`artifactDigest` threading pattern (Context 3). One Trivy verdict is evaluated once against the merged floor.

**Robustness property — the resolution is order-independent.** Because the merge is a per-severity **MIN** over a set, it is commutative and associative: the result does not depend on the order in which tiers are visited. This matters concretely. `containment.ts:60-73` documents that containment-domain-vs-service is **not** a strict ordering (a genuine tie at equal depth), which would leave "most specific wins" **override** semantics undefined at that tie. Most-restrictive-wins has no such failure mode — and that is precisely **why most-restrictive-wins was the safe choice**, not merely a policy preference.

### 5. Charter alignment

- **Graph-native (principle 2):** OK — org / containment domain / service / component requirements are policy/graph data on the existing resolver; only the two above-org tiers are new structure, and they share **one** table.
- **PostgreSQL-only (principle 4):** OK — the floor tier is a **Postgres table**, not a service; no new required stateful dependency.
- **Explainability (principle 6):** the effective threshold and its contributing scopes persist in the scan gate's Decision record, so a blocked promotion can show *which* tier set the binding severity floor.
- **Multi-tenancy invariant (DESIGN §4.2):** the floor table is the **documented exception** to "`org_id NOT NULL` on every tenant-scoped table" — it is not tenant-scoped. It is operator-write / tenant-read, exposes no cross-tenant visibility (it holds no per-tenant rows at all), and contributes to resolution read-only. Recorded in DESIGN §4.2 (tenancy exception) and §10.1 (policy resolution).

## Known follow-up (out of scope here) — the trust-domain identity inconsistency

The owner's partition model makes the trust domain a property of the **deployment**. But `federation_self` has `orgId` as **PRIMARY KEY** and `domainId` **UNIQUE** — a strict 1:1 org ↔ federation-domain (`apps/server/src/db/schema.ts:940-972`, which explains that federation identity is org-scoped because the sync journal derives from the per-org outbox, and that "one org per instance is the expected shape"). So a deployment hosting **N** orgs today mints **N** trust-domain identities, and "multiple orgs in one federation domain" is **not representable**.

That is a genuine federation-model inconsistency with the partition framing. It is **explicitly not resolved here** — it needs its own ADR/milestone. **M17.5 is unaffected either way**: an *instance-scoped* floor with no `orgId` applies to every org on the deployment regardless of how many federation identities that deployment happens to mint.

## Alternatives considered

- **(B) N conjoined scan controls (considered, not chosen).** Each applicable tier contributes **its own** scan control, conjoined through the existing `requireControls` **union** + all-pass gate. Most-restrictive falls out for free (all must pass ⇒ the tightest dominates) with **zero new resolution code**. **Rejected as the primary design because:** it re-evaluates the scan gate **N times** — N redundant Trivy-result fetches/evaluations for the same artifact — and produces N Decisions for one logical criterion, muddying explainability. Design (A) evaluates once against a single merged floor. (B) remains a viable fallback if (A)'s context-threading proves awkward, since it needs no new resolver.
- **Flat per-binding threshold only (status quo, rejected).** Cannot express layered floors; the owner explicitly wants scoped, tightening-only criteria.
- **Two separate tables, one per above-org tier (rejected).** The `tier`/`origin` discriminators express both in one table with identical access semantics; two tables would duplicate the RLS/read path for no gain.
- **`objects` RLS NULL-org escape (rejected)** and **outside-tenant-RLS privileged table (rejected)** — see §3.
- **Trust-domain floor as per-org rows (rejected).** A partition is ambient: the deployment is in exactly one, so per-org rows would encode a fact that is already true of the whole deployment, and would invite a tenant-writable surface.

## Consequences

**Positive**
- Layered, tightening-only scan criteria at six tiers, reusing the proven stricter-wins resolver for four of them; only **one** new table.
- One control, one Trivy evaluation, one Decision per artifact (design A) — clean explainability.
- Order-independent resolution sidesteps the documented containment-ordering tie (`containment.ts:60-73`) entirely.
- Independent of the signing track (ADR-0015): M17.5 can proceed in parallel with M17.3/M17.4.

**Costs / honesty**
- One new instance-scoped table (no `orgId`) is a documented exception to the DESIGN §4.2 tenancy invariant; its read policy must be written as tenant-read/operator-write and covered by a test that proves a tenant can neither write it nor loosen the resolved floor.
- `ScanThresholdSchema` gains a scoped-requirement representation and the gate context carries a resolved effective threshold (additive schema/codegen work).
- The trust-domain-identity inconsistency above remains open and will need its own ADR.
- The `platform` tier's `origin: 'federated'` rows depend on the federation config channel carrying them — additive federation-config work, alongside the cosign pubkey field (ADR-0015 §4).
