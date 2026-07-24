# ADR-0021: Terminology — promotion vs cross-domain promotion, accept, release, and the "domain" collision

| | |
|---|---|
| **Status** | **Accepted** — owner decision, 2026-07-24 |
| **Date** | 2026-07-24 |
| **Deciders** | Owner (jag8765) |
| **Delivers** | [docs/GLOSSARY.md](../GLOSSARY.md) |
| **Relates to** | [ADR-0004](0004-service-naming-commander-outpost-retrans.md) (the breaking pre-1.0 enum-rename precedent), [ADR-0016 §Terminology](0016-scoped-scan-requirement-policies.md) (the trust/containment domain split this generalizes), [ADR-0009](0009-optional-poke-mode-federation.md), [ADR-0013](0013-supply-chain-scan-sbom-manifest.md), [ADR-0015](0015-cosign-cross-boundary-signing.md), [ADR-0019](0019-artifact-byte-channel.md), [DESIGN.md §9/§13](../DESIGN.md), [docs/proposals/promotion-and-execution-model.md](../proposals/promotion-and-execution-model.md), [docs/proposals/coordination-ui-views.md](../proposals/coordination-ui-views.md) |

**ADR number.** `0020-first-class-commander-scanning.md` is the highest ADR currently on `main`; `0021` is the next free number and is the one taken here.

---

## Context

CommanderSCP coordinates other people's tools, and those tools arrived with vocabulary attached. Three specific collisions had reached the point of costing review time and producing genuine misreads.

### 1. "Domain" has five live rival senses, plus two of our own

Bare "domain" can mean a DNS domain, a Windows/Active Directory domain, a DDD bounded context, or an identity realm — NIST's own federation literature speaks of a collection of realms (domains). On top of those four industry senses, **CommanderSCP itself uses the word for two different things**:

- the **federation/trust tier** (commercial / GovCloud / IL5 / air-gapped), owner-framed as an AWS *partition*: ambient, above org, nothing crosses it silently;
- the **`domain` graph object type** — an ordinary intra-org grouping *below* org in the containment chain.

**The docs already solved this; the code did not.** [ADR-0016 §Terminology](0016-scoped-scan-requirement-policies.md) mandates the full forms and bans bare "domain" even as a stored value ("the floor table's tier literal is `trust_domain`, never bare `domain`"); `DESIGN.md:481` does the same for policy resolution. But in the code, counted on `origin/main` at `da9e92c` (2026-07-24), there are **376** non-test source lines mentioning `domainId` across `apps/` and `packages/`, in 75 files — about **51** in `apps/server/src/federation` meaning the **trust** sense (`federation_self.domainId`, `apps/server/src/db/schema.ts:1011`) and about **45** in `apps/server/src/graph` meaning the **containment** sense (`objects.domainId`, `apps/server/src/db/schema.ts:169`) — with **zero type-level separation**. Both are plain `uuid`. Nothing stops one being passed where the other is expected.

### 2. "Promote" has three in-tree senses

1. **The artifact advance** — the same built bits move to the next environment. This is what the UI means: `apps/web/src/components/pipeline/PromotionArrow.tsx` draws Gamma → Prod as a promotion.
2. **The cross-domain hop** — a promotion that crosses a security-domain boundary and must pass the CDS supply-chain gate. `scp federation promote` and `importPromotionBundle` carry this.
3. **The change-lifecycle approval gate** — `validating → promoted`, a *human decision on a change*, entirely domain-agnostic, applying to intra-domain changes that move nothing anywhere new.

Sense 3 is the odd one out and it is also, by a wide margin, the most expensive to rename (see the cost table).

### 3. "Release" means something different in the code than in the owner's original framing

The code is explicit: *"a change IS a release, and a release comes from ONE source per pipeline"* (`apps/server/src/coordination/changes-repo.ts` ~:74). That is the *whole versioned unit moving through its pipeline*. An earlier proposal framing used "release" for a single push into a single stage — which is a **deployment**. Left unreconciled, the same word denotes a journey in one document and a step in another.

Worse, in this product's market **"release" is a compliance landmine**. In DoD/IC usage "release" and "releasability" denote a **disclosure determination** (REL TO markings, foreign disclosure review), and cross-domain filters exist precisely to enforce security *and releasability* policies. A cross-domain product that uses "release" to mean "deploy" invites an accreditation reader to see a disclosure determination where a software deployment was meant.

---

## Decisions

### D1. The cross-domain hop is **"cross-domain promotion"**, always qualified

The hop that crosses a **security-domain** boundary is called a **cross-domain promotion**, written in full. Bare "promotion" is **never** used when the security-domain boundary is what is meant.

**Rationale.** The existing federation vocabulary already says "promotion" everywhere — Promotion Bundle, `importPromotionBundle`, `PromotionManifestSchema`, `scp federation promote`, "federated change promotion" in DESIGN.md §13. Qualifying it costs one adjective and no code. The qualifier is what does the work: it names the boundary explicitly at every use site, which is exactly the property that was missing.

### D2. The env-to-env hop is **"promotion"** (bare)

The dominant industry meaning: **the same already-built artifact advances to the next environment or stage without being rebuilt** — "build once, deploy many". Promotion is defined by *artifact identity*, not by the kind of boundary crossed.

**Rationale.** This is what the industry means, without meaningful dissent. Kargo frames a promotion as a request to move a piece of freight into a specified stage; `argoproj-labs/gitops-promoter` describes itself as a GitOps-first **environment** promotion tool; JFrog's "build promotion" moves or copies build artifacts to a target repository; Harness and Octopus use the word the same way. In GitOps specifically, promotion means updating desired state in Git for the next environment — which is very close to what SCP actually does. And it is already what our own UI means (`PromotionArrow.tsx` renders Gamma → Prod as a promotion).

### D1 + D2 together: the genus/species model

This is the organizing idea of the whole glossary and is stated as such:

> **PROMOTION is the genus** — the same artifact advances to the next step.
> **CROSS-DOMAIN PROMOTION is the species** — that step crosses a security-domain boundary and must therefore pass the CDS supply-chain gate (scan + cosign-signed manifest + verify-at-every-hop).

**Bare "promotion" never implies a domain crossing.** The species inherits everything the genus means and adds the gate.

### D3. **Release** = a change *is* a release

Keep the codebase's existing meaning. A release is the **versioned unit of change moving through its whole pipeline**. It MAY span many waves and MAY cross security domains. It is **not** "one push into one stage" — that is a **deployment**.

**Rationale.** It matches the code as written (`changes-repo.ts`), and it matches the two most entrenched industry senses simultaneously: "the versioned bundle" and "the release train". The per-environment push has an unambiguous industry word already — *deployment* — and DORA measures deployment frequency, not release frequency. Three further senses are explicitly **not** adopted and are named in the glossary so a reader can rule them out: Humble & Farley's strict "make available to users" sense; **Helm's** sense (an installed instance of a chart — a hard collision, since SCP ships a Helm chart); and Linux packaging's `release` field.

### D4. **Security domain** for the trust tier; **containment domain** for the object type; branded types to enforce it

- Adopt **"security domain"** — the NIST/CNSSI term — as the preferred name for the trust tier. CNSSI-4009-2015 (also carried in NIST SP 800-137) defines it as *"a domain that implements a security policy and is administered by a single authority"*; NIST SP 800-53 Rev. 5 gives an equivalent resources/entities/common-policy formulation; NIST SP 800-57 Part 1 Rev. 5 adds composability — *"a system or subsystem that is under the authority of a single trusted authority. Security domains may be organized (e.g., hierarchically) to form larger domains."*
- Keep **"containment domain"** for the org-internal `domain` object type, unchanged.
- The existing phrase **"trust domain (partition)"** from ADR-0016 remains valid and is **not** being rewritten; "security domain" is preferred going forward because it is the term an accreditation reader already knows.
- **Add branded TypeScript types — `TrustDomainId` vs `ContainmentDomainId`** — so the collision becomes **uncompilable** rather than a naming convention someone has to remember.

**Also recorded as deliberate:** SPIFFE's "trust domain" *corresponds to the trust root of a system* — it is defined by a shared trust root/PKI, whereas a **security** domain is defined by common security **policy** under one administering authority. These are different concepts that cross-cut. SCP uses `urn:scp:domain:<domainId>` in the certificate SAN URI (`apps/server/src/federation/mtls-enforcement.ts`) — deliberately an RFC 8141 URN, **not** `spiffe://`, to avoid taking a SPIFFE dependency. That choice is correct and is recorded here as intentional.

**The branded-types work is NOT done.** It is tracked follow-on PR (i) below. Nothing in the tree today has type-level separation.

### D5. The change-lifecycle `promote` is renamed to **`accept` / `accepted`**

The change-lifecycle approval gate becomes **`accept`**, and its terminal success state becomes **`accepted`**. Specifically:

- the `validating → promoted` edge becomes `validating → accepted` (trigger `accept`);
- `POST /api/v1/changes/{id}/promote` becomes `.../accept`;
- `scp change promote` becomes `scp change accept`;
- the `promoted` value in the `ChangeState` enum becomes `accepted`.

**This supersedes any earlier framing that documented sense 3 as a permanent third meaning of "promote".** It is not staying.

**Rationale — why rename.** The gate is a **human approval** and a **terminal success state**, not an artifact advancing. Under D2, calling it "promote" actively fights the glossary: every reader who learns that promotion means "the same bits advance without rebuilding" then hits `validating → promoted` and must unlearn it. It is also domain-agnostic — it applies to purely intra-domain changes that move nothing anywhere new — so it is neither the genus (D2) nor the species (D1).

**Rationale — why pay for it now.** The cost is real (see the cost table): a **breaking `/v1`** path change, a **data migration** over `changes.state`, the seeded `state_transitions` rows, the CLI verb, and the enum on every change response. It is payable because:

- the project is **pre-1.0 with a single deployment** (the homelab install), so there is no fleet of already-configured consumers to break;
- **[ADR-0004](0004-service-naming-commander-outpost-retrans.md) set the direct precedent** — it removed `parent`/`child` **outright**, explicitly rejecting deprecated aliases, on exactly this reasoning ("pre-1.0", "single deployment", "zero legacy vocabulary to carry"). Taking a breaking federation-role enum rename there and refusing a breaking change-state enum rename here would be incoherent;
- the cost only grows. Every additional SDK consumer, every additional deployment, and every additional month of documentation saying "promoted" makes it more expensive, never less.

**Scope note.** `scp federation promote` — the Promotion Bundle export verb — **keeps its name**. That one *is* a promotion in the D1/D2 sense.

**This PR is docs-only.** The glossary defines `accept`/`accepted` as the vocabulary and states plainly that **the code still spells it `promote`/`promoted`** until follow-on PR (ii) lands.

### D6. **Stage** is reserved for one named deployment place; a **wave contains stages**

**Stage** means **one named deployment place**, spelled with a canonical three-segment grammar (owner-specified, 2026-07-24):

```
<domain>-<location>-<env>          lowercase, hyphen-separated
```

- **domain** — the **security domain** (`commercial`, `govcloud`, `il5`, `airgap`);
- **location** — the geographic locality/region *within* that domain (`amer`, `apac`, `emea`);
- **env** — the environment tier (`dev`, `gamma`, `prod`).

Canonical examples: **`commercial-apac-prod`**, **`govcloud-amer-gamma`**. The word is **not** spent on ordering and **not** on pipeline phases.

**Supersedes the earlier segment order.** Earlier ad-hoc examples in this project used `<domain>-<env>-<location>` and mixed case (`commercial-prod-AMER`, `commercial-prod-APAC`). Those are superseded: write `commercial-amer-prod` and `commercial-apac-prod`. The old order must not be reproduced in docs.

**Wave and stage are containment, not rivalry.** A **wave** is one ordered step of a compiled plan = **the set of one-or-more stages advanced at once**. A wave therefore **contains** stages. The apparent "stage vs wave" collision was never two words competing for one meaning — "stage" was being used *for* the wave sense by mistake. Owner's worked example, in canonical form:

| Wave | Stages advanced |
|---|---|
| Wave 1 | `commercial-amer-gamma` |
| Wave 2 | `commercial-amer-prod` |
| Wave 3 | `commercial-apac-prod` **+** `govcloud-amer-prod` |

**Consequence — the CDS supply-chain gate applies per crossing, not per wave.** Wave 3 holds two stages in two *different* security domains. Advancing it is an ordinary promotion for `commercial-apac-prod` and a **cross-domain promotion** for `govcloud-amer-prod`. The gate (digest-bound scan + cosign-signed manifest + verify at every hop) is therefore evaluated **once per boundary crossing**, on the stage that crosses — never once for the wave, and never skipped because the wave "mostly" stays inside one domain. This is a real design clarification, recorded here so it is not rediscovered later.

**Open question, deliberately left open.** Earlier examples included location-less stages (`commercial-gamma`, `govcloud-prod`). Whether the **location** segment is mandatory for a stage with no meaningful geographic split — a single-region or genuinely global place — or whether a two-segment name is legitimate there, is **not decided**. It is recorded in the glossary's `stage` entry as an open question for the owner rather than resolved by inference. Everything else about the grammar is settled.

**Rationale and precedent — and the limit of that precedent.** The **majority** CD sense of "stage" is a pipeline *phase* — Jenkins `stage()`, GitLab CI `stages:`, Spinnaker pipeline stages — and we deliberately do not use that sense. **Kargo's `Stage` CRD is the precedent for spending the word on a promotion-target node rather than a pipeline phase** ("a stage is a promotion target that represents some desired state"). That precedent is real and it is the whole of what Kargo supports here.

**Kargo does not support the place definition, and this ADR does not claim it does.** Kargo has no security-domain axis, and its docs state that a Stage's name denotes an application instance's **purpose** "and not necessarily its location" — Kargo deliberately declines to bind a Stage to a place. The `<domain>-<location>-<env>` definition is **ours**: SCP-specific, not inherited. An earlier draft of this ADR called the reservation "standards-defensible" on Kargo's authority; that was an overclaim and is corrected here. The glossary marks the term **QUALIFIED-STANDARD (word-sense precedent only)** accordingly.

**Honest status — no stage entity exists.** There is **no `stage` table and no `environment` table** in the schema, and **no stage-grammar compound name such as `commercial-amer-gamma` appears anywhere in the code** — scoped that way deliberately, because this ADR and the glossary both use such names as illustrative examples, so an unscoped "zero hits in the repository" claim would falsify itself the moment this branch merges. "Stage" is *reserved vocabulary a future entity may fill*. This ADR reserves the word; it does not build the thing.

**This model confirms the misuse diagnosis.** The `/v1` `stages[]` / `currentStage` / `ServiceBoardStageSchema` fields genuinely *are* the wave sense wearing the wrong name — `packages/schemas/src/services.ts:25` documents `ServiceBoardStageSchema` as *"One pipeline stage of a component's latest change = one compiled wave"*. The full census and the corrected cost are in Consequences (iii) below; the earlier "two in-tree misuses, cheap, UI and docs only" framing was wrong on both counts and is superseded.

---

## Rejected alternatives

### Rejected: rename the cross-domain hop to **"transfer"** (the literal CDS-standard verb)

**This was the strongest alternative and it is rejected on cost, not on correctness.**

By the letter of the standards, "transfer" is right. **CNSSI-4009** frames a cross-domain solution in terms of exactly two verbs — *access* and *transfer* information between different security domains — and **NCDSMO's accredited-product taxonomy splits transfer-CDS from access-CDS** accordingly. An accreditation reviewer reading "cross-domain promotion" will mentally translate it to "transfer" anyway.

It was rejected because the existing federation vocabulary is saturated with "promotion" — Promotion Bundle, `importPromotionBundle`, `PromotionManifestSchema`, `promotion-repo.ts`, `promotion-scan-step.ts`, `scp federation promote`, "federated change promotion" in DESIGN.md §13, plus the M14–M17 milestone language. Renaming would touch schema field names, an ADR chain, a CLI verb, and the entire proposal corpus, to buy a word an accreditation audience can already map. The qualified form "cross-domain promotion" costs **zero rename** and carries the boundary explicitly.

**Mitigation, recorded so this is not lost:** when writing for an accreditation audience, the glossary directs authors to say "cross-domain promotion (a CDS *transfer* in CNSSI-4009 terms)". The standards vocabulary is acknowledged, not hidden.

### Rejected: keep `promote`/`promoted` as the change-approval gate and document it as a permanent third sense

The earlier draft framing. Rejected under D5: a glossary that has to say "and also, in this one place, promote means something unrelated" is a glossary that will not be followed. The rename is breaking but bounded, the project is pre-1.0, and ADR-0004 already established the precedent.

### Rejected: `approved` instead of `accepted`

Rejected because `requireApprovals` and the `approves` relationship already denote a *policy effect producing approval tasks* (DESIGN.md §10.2). An approval is **evidence a gate consumes**; the lifecycle transition is a different thing that a gate guards. Reusing "approved" for the terminal state would create the same class of collision D5 is removing. A change may require several approvals and still be **accepted** exactly once.

### Rejected: rename "release" to avoid the DoD/IC "releasability" collision

Considered because the collision is real and consequential. Rejected because "release" is nearly free to redefine (there is no release entity — see the cost table) and because the two industry senses we adopt are overwhelmingly the most common. The mitigation is **precision plus an explicit warning** in the glossary's `release` entry, not avoidance: define release as the versioned unit moving through its pipeline, define deployment as the per-environment push, and state the disclosure-determination hazard as the reason the distinction matters.

### Rejected: keep bare "domain" and rely on convention

Rejected because it has already been tried. ADR-0016 and DESIGN.md:481 both mandate the full forms, and the code still has 376 undifferentiated `domainId` lines carrying two different meanings. A convention that two documents already mandate and the code still violates is not a control. D4 makes it a compiler error instead.

### Rejected: introduce a `stage` entity now

Rejected as premature. D6 reserves the *word*; building the entity is a separate design question (what a stage owns, how it relates to `deployment-target`, whether it subsumes the missing `environment` concept, and whether the `location` segment is mandatory — the open question above).

**Reserving the word is free; reclaiming it is not.** The word has *already* been spent on waves, including in the shipped `/v1` service-board response — see Consequences (iii-b), which is a breaking change. So the honest statement is that reserving now costs nothing further and stops the spend growing, not that the reservation is cost-free in aggregate.

---

## Cost table — which paths were cheap and which were deliberately paid for

| Term | Surface it touches | Cost | Decision |
|---|---|---|---|
| **cross-domain promotion** (D1) | Prose only — the qualifier is additive | **Zero.** No code, no schema, no API. | Adopted; "transfer" rejected to keep this at zero |
| **promotion** (D2) | Already the meaning in `PromotionArrow.tsx`, `promotion-repo.ts`, `PromotionManifestSchema` | **Zero.** Ratifies existing usage. | Adopted |
| **release** (D3) | **No release table, entity, or API resource** — it is a gloss on `change` living in comments. | **Near-zero.** One exception: **`release-topology`** is a real object type whose slug leaks into URNs (`urn:scp:{org}:release-topology:{slug}`) — untouched by this ADR. | Adopted |
| **security domain / containment domain** (D4, prose) | ADR-0016 and DESIGN.md:481 already mandate the full forms | **Zero** for the prose convention | Adopted |
| **branded `TrustDomainId` / `ContainmentDomainId`** (D4, code) | 376 non-test `domainId` lines across 75 files (`origin/main` @ `da9e92c`); 51 federation (trust), 45 graph (containment); both plain `uuid` | **Moderate.** Type-only — no runtime behaviour, no schema, no API. Mechanical but wide. | Tracked follow-on PR (i) |
| **`promote` → `accept`** (D5) | `changes.state='promoted'` (**DB value**); `POST /v1/changes/{id}/promote` (**a `/v1` path**); `promoted` in the `ChangeState` enum on **every change response**; `scp change promote`; the seeded `state_transitions` rows; `transitions.ts` `LEGAL_TRANSITIONS` | **Highest in the system — BREAKING.** `/v1` contract change + data migration. Paid because pre-1.0, single deployment, and ADR-0004 precedent. | Tracked follow-on PR (ii) |
| **`stage`** (D6) — cheap half | UI labels/test hooks (`StageCard.tsx`, `change-pipeline.tsx`, `PromotionArrow.tsx`, `change-detail.tsx`, `query-client.ts`) + comments, docblocks and prose (incl. 37 non-test `M2 stage N` milestone comments). | **Cheap.** UI + docs only — no API, no schema, no migration. | Tracked follow-on PR (iii-a) |
| **`stage`** (D6) — breaking half | **The `/v1` contract.** `ServiceBoardStageSchema` / `ServiceBoardStage` / `ServiceBoardRow.currentStage` / `.stages` (`packages/schemas/src/services.ts:29,37,72,73`), shipped on `GET /api/v1/services/{idOrUrn}/board` (`apps/server/src/routes/services.ts:28`), exported from `packages/sdk/src/index.ts:68` and `packages/sdk/src/generated/types.gen.ts:6158`, committed in `tools/openapi/openapi.v1.json:23236,23246` and its **required** list at `:23393–23394`, plus the server projection `apps/server/src/coordination/service-board.ts:6,110–111,126,138,141,157–158` and the consuming UI `apps/web/src/routes/service-board.tsx`. | **BREAKING.** A `/v1` **response-shape** change: trips the oasdiff additive-only gate and requires `pnpm gen` + SDK regeneration. **No `stage` table and no `environment` table exist** — but the *word* is in the contract in the wave sense. | Tracked follow-on PR (iii-b) |
| **`scp federation promote`** | CLI verb for Promotion Bundle export | **Zero — unchanged.** It is a genuine promotion. | Kept |
| **`parent`/`child`** | — | Already paid, [ADR-0004](0004-service-naming-commander-outpost-retrans.md) | Precedent |

---

## Consequences

### Immediate (this PR — docs only)

- [docs/GLOSSARY.md](../GLOSSARY.md) lands as the authoritative vocabulary reference, structured for a new engineer and an operator: preamble, quick-reference table with an INDUSTRY-STANDARD / QUALIFIED-STANDARD / SCP-SPECIFIC marker per term, one entry per term (Definition / industry-standard with citation / Not to be confused with / In the code), and a "Deprecated / avoid" table.
- Cross-links added: a row in the CLAUDE.md "Key documents" table, and one-line pointers from `DESIGN.md`'s domain-disambiguation note and from ADR-0016's terminology section. **Existing wording in those documents is not rewritten** — pointers only.
- **No code, schema, or test changes.** Every place the glossary's preferred term differs from the code says so in the entry.

### Four tracked follow-on code PRs this ADR creates

(i) branded domain-id types; (ii) the `promote` → `accept` rename — **breaking**; (iii-a) the cheap `stage` cleanup; (iii-b) the `stage` cleanup's `/v1` half — **breaking**. Two of the four are breaking `/v1` changes; none is started.

**(i) Branded types — `TrustDomainId` / `ContainmentDomainId`.**
Introduce branded TypeScript types so the trust-tier id and the containment-domain id are not interchangeable. Thread them from `apps/server/src/db/schema.ts` (`federation_self.domainId` ~:1011 = trust; `objects.domainId` ~:169 = containment) outward through `apps/server/src/federation/` (51 non-test lines) and `apps/server/src/graph/` (45), and through `packages/schemas` — 376 non-test lines in 75 files in total (`origin/main` @ `da9e92c`). **Type-only** — no runtime behaviour change, no schema change, no API change. Not started.

**(ii) The D5 `promote` → `accept` rename — BREAKING.**
- `ChangeStateSchema`: `promoted` → `accepted` (`packages/schemas/src/changes.ts:22`).
- `LEGAL_TRANSITIONS`: `{ validating → promoted, trigger: "promote" }` → `{ validating → accepted, trigger: "accept" }`, plus the `promoted → rolled_back` edge and the `validating|promoted` coupling predicates (`apps/server/src/coordination/transitions.ts`, `packages/schemas/src/changes.ts:86,235`).
- Route: `POST /api/v1/changes/:id/promote` → `.../accept`, `operationId: promoteChange` → `acceptChange` (`apps/server/src/routes/changes.ts:344`). **This is a breaking `/v1` change** and will trip the oasdiff additive-only gate — an explicit, ADR-authorized exception, exactly as ADR-0004's rename was.
- CLI: `scp change promote` → `scp change accept` (`packages/cli/src/cli.ts:1664`). `scp federation promote` is **untouched**.
- **Data migration** over `changes.state` (`'promoted'` → `'accepted'`) plus the seeded `state_transitions` rows (`apps/server/drizzle/0007_change_coordination.sql`), whose set-equality integration test must be updated in the same PR.
- SDK/OpenAPI regeneration (`pnpm gen`) and every doc/test string.
Not started.

**(iii) The D6 `stage` cleanup — SPLIT, because it is not all cheap.**

An earlier draft of this ADR named only two misuse sites (`StageCard.tsx`, `change-pipeline.tsx`) and priced the whole cleanup as "cheap — UI and docs only, no API, no schema, no migration". **That census was incomplete and that cost claim was false.** The corrected, exhaustive census over non-test files follows; the glossary's `stage` entry carries the same list.

**(iii-a) The cheap half — UI labels, test hooks, comments and prose. No API, no schema, no migration. Not started.**

- `apps/web/src/components/pipeline/StageCard.tsx` — the whole component: docblock `:90` (*"One pipeline stage = one compiled wave"*), `stageNumber` prop (`:99, :103`), the visible label `Stage {stageNumber}` (`:116`), `data-stage` (`:111`) and nine distinct `data-testid="stage-*"` hooks (ten occurrences).
- `apps/web/src/routes/change-pipeline.tsx:26, 206, 398, 406` (`data-testid="pipeline-stages"`), `:407, :420`.
- `apps/web/src/components/pipeline/PromotionArrow.tsx:4, 26` — its **own docblock** reads *"The gate/approval state of a promotion between two pipeline stages"*. This is the file D2's rationale cites as rendering promotion correctly; the drawing is right, the naming is not.
- `apps/web/src/routes/change-detail.tsx:51`; `apps/web/src/lib/query-client.ts:48, 61`.
- "per-stage version" (wave sense) in comments and docblocks: `packages/schemas/src/changes.ts:164, 168`; `apps/server/src/coordination/plan-service.ts:156`; `apps/server/src/coordination/wave-targets-repo.ts:160`; `apps/server/drizzle/0027_wave_target_observed_state.sql:8–9`; `packages/schemas/src/services.ts:7, 14, 18, 28`; `packages/sdk/src/client.ts:919`; `apps/web/src/routes/service-board.tsx:97, 101, 194, 273`.
- "stage" for a pipeline **phase**: `apps/server/src/coordination/change-coordination-lock.ts:6`, and prose such as the execution map in `docs/proposals/promotion-and-execution-model.md` §1 — say **phase** or **step**.
- "stage" for a **milestone sub-step**: 37 non-test `M2 stage 2/3/4` comments (`apps/server/src/app.ts`, `apps/server/src/auth/*`, `apps/server/src/routes/*`, `packages/sdk/src/client.ts`, `packages/schemas/src/auth.ts`, `apps/server/src/db/schema.ts`, migrations `0004`/`0005`) — a third distinct sense; say **part** or **step**.

**(iii-b) The breaking half — the service-board `stage` = wave chain is in the shipped `/v1` contract. BREAKING. Not started.**

- `packages/schemas/src/services.ts` — `ServiceBoardStageSchema` (`:29`), the exported `ServiceBoardStage` type (`:37`), and `ServiceBoardRowSchema`'s `currentStage` (`:72`) and `stages` (`:73`). The docblock at `:25` is explicit: *"One pipeline stage of a component's latest change = one compiled wave"*.
- `apps/server/src/routes/services.ts:28` — shipped on `GET /api/v1/services/:idOrUrn/board`; the OpenAPI `summary` at `:36` also says "per-stage status".
- `packages/sdk/src/index.ts:68` (re-export) and `packages/sdk/src/generated/types.gen.ts:6158–6159`.
- `tools/openapi/openapi.v1.json:23236` (`currentStage`), `:23246` (`stages`), and both in the **required** list at `:23393–23394` — the document is committed, so the change is visible to the gate.
- `apps/server/src/coordination/service-board.ts:6, 110–111, 126, 138, 141, 157–158` — the server-side projection.
- `apps/web/src/routes/service-board.tsx:38–59` (`StageStrip`; its `board-stage-badge` at `:51` is captioned from the **wave** index — `Wave ${s.waveIndex}` at `:50`, `W${s.waveIndex}` at `:53`), `:190–191` (`<TableHead>Current stage</TableHead>`, `<TableHead>Stages</TableHead>`), `:248` (`row.currentStage`), `:255` (`row.stages`).

Renaming these is a **breaking `/v1` response-shape change**: it will **trip the oasdiff additive-only gate** — an explicit, ADR-authorized exception on the same footing as (ii) — and requires `pnpm gen` plus SDK regeneration. It should be sequenced with, or after, (ii) so `/v1` takes one authorized break rather than two.

**Explicitly out of scope (not misuses).** Docker's own multi-stage-build term (`packages/cosign/src/cosign-bin.ts:5`, `packages/cosign/src/skopeo-bin.ts:5`, `packages/plugin-testkit/src/runner-image.ts:36`); the unrelated verb "staged" in `apps/server/src/governance/scan-db.ts:399, 404, 409`; and `apps/server/src/graph/named-queries.ts:279`, whose hypothetical "stage-domain" is consistent with the reserved place sense.

### Ongoing

- New docs and ADRs use the glossary's terms. Where a term's preferred form does not yet match the code, the doc says so rather than describing an aspirational codebase.
- "Stage" stays reserved. If a stage entity is later built, it must mean one named deployment place under the `<domain>-<location>-<env>` grammar — contained by a wave, never a synonym for one — or supersede this ADR explicitly. The open question about whether the `location` segment is mandatory must be answered by the owner before that entity is designed.
- The per-org-vs-per-deployment federation identity question flagged in ADR-0016 remains **open** and is not resolved here.
