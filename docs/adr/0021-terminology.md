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

### 1. "Domain" has six live senses — four from the industry, plus two of our own

**The accounting, stated once so both documents can agree on it: four industry senses plus SCP's own two.** The four industry senses are a **DNS** domain, a **Windows/Active Directory** domain, a **DDD bounded context**, and an **identity realm** — NIST's own federation literature speaks of a collection of realms (domains). On top of those, **CommanderSCP itself uses the word for two different things**:

- the **federation/trust tier** (commercial / GovCloud / IL5 / air-gapped), owner-framed as an AWS *partition*: ambient, above org, nothing crosses it silently — the **security domain**;
- the **`domain` graph object type** — an ordinary intra-org grouping *below* org in the containment chain — the **containment domain**.

Four plus two is six. [docs/GLOSSARY.md](../GLOSSARY.md) uses the identical accounting; if either is ever revised, revise both.

**The docs already solved this; the code did not.** [ADR-0016 §Terminology](0016-scoped-scan-requirement-policies.md) mandates the full forms and bans bare "domain" even as a stored value ("the floor table's tier literal is `trust_domain`, never bare `domain`"); DESIGN.md does the same for policy resolution. But in the code, `domainId` carries **both** SCP senses with **zero type-level separation**: `federation_self.domainId` (trust) and `objects.domainId` (containment) are both declared in `apps/server/src/db/schema.ts`, and **both are plain `uuid`**. Nothing stops one being passed where the other is expected. The trust-sense uses concentrate in `apps/server/src/federation/` and the containment-sense uses in `apps/server/src/graph/`; how many lines and files that is, measured reproducibly, is in the [census snapshot](#census-snapshot) below.

### 2. "Promote" has three in-tree senses

1. **The artifact advance** — the same built bits move to the next environment. This is what the UI means: `apps/web/src/components/pipeline/PromotionArrow.tsx` paints the gate/approval state of a promotion between two successive pipeline cards. **State the claim precisely** — the file is *"purely presentational"* (its own docblock), its parent computes the state from real change data, and the cards on either side are `StageCard`s, i.e. compiled **waves**. It is not drawing "Gamma → Prod": there is no `environment` table and no `stage` entity, so there is no Gamma and no Prod for it to draw between.
2. **The cross-domain hop** — a promotion that crosses a security-domain boundary and must pass the CDS supply-chain gate. `scp federation promote` and `importPromotionBundle` carry this.
3. **The change-lifecycle approval gate** — `validating → promoted`, a *human decision on a change*, entirely domain-agnostic, applying to intra-domain changes that move nothing anywhere new.

Sense 3 is the odd one out and it is also, by a wide margin, the most expensive to rename (see the cost table).

### 3. "Release" means something different in the code than in the owner's original framing

The code is explicit: *"a change IS a release, and a release comes from ONE source per pipeline"* (the docblock on the change-input `type?: ExecutorType` field in `apps/server/src/coordination/changes-repo.ts`). That is the *whole versioned unit moving through its pipeline*. An earlier proposal framing used "release" for a single push into a single stage — which is a **deployment**. Left unreconciled, the same word denotes a journey in one document and a step in another.

Worse, in this product's market **"release" is a compliance landmine**. In DoD/IC usage "release" and "releasability" denote a **disclosure determination** (REL TO markings, foreign disclosure review), and cross-domain filters exist precisely to enforce security *and releasability* policies. A cross-domain product that uses "release" to mean "deploy" invites an accreditation reader to see a disclosure determination where a software deployment was meant.

---

## Census snapshot

**Every measured number in this ADR and in [docs/GLOSSARY.md](../GLOSSARY.md) comes from this block, and from nowhere else.** It is stated once — with the exact command, the commit it was run against, and the figure that command actually returns — so it can be re-run and refreshed in one edit. Nothing else in either document restates a figure; they point here instead. A number repeated in five places is a number that drifts, and these already had.

**Measured at commit `da9e92c` (2026-07-24 — then the tip of `origin/main`).** The commands below pin that commit explicitly rather than naming a branch, so they stay reproducible after `main` moves.

Both greps pass **`-I`**. That flag matters and is not cosmetic: without it, git's binary heuristics emit a `Binary file … matches` pseudo-line for a handful of source files, which both inflates a line count and collapses those files into one unusable path — so a command run without `-I` cannot reproduce a line figure and a file figure at the same time. The affected files are named under each result rather than silently dropped.

### A. `domainId` — the two senses, undifferentiated

```sh
git grep -I -n domainId da9e92c -- 'apps/**' 'packages/**' \
  | grep -v -E '\.test\.|__tests__|\.spec\.' | wc -l     # 365
git grep -I -l domainId da9e92c -- 'apps/**' 'packages/**' \
  | grep -v -E '\.test\.|__tests__|\.spec\.' | wc -l     # 73
```

- **365** non-test source lines, in **73** files.
- Narrowing the first command by path: **51** of those lines are under `apps/server/src/federation/` (the **trust** sense, `federation_self.domainId`) and **45** under `apps/server/src/graph/` (the **containment** sense, `objects.domainId`).
- **Two further files match but contribute no counted lines:** `apps/server/src/iac/plan-diff.ts` and `packages/iac/src/construct.ts`. Git classifies both as binary, so `-I` skips them — which is why `git grep -l` *without* `-I` reports **75** files. Both figures are defensible; they simply come from different invocations. **Quote the `-I` pair — 365 lines in 73 files — and name those two files separately. Do not mix figures across invocations**, which is exactly how an unreproducible "365 lines in 75 files" was produced in an earlier draft.

### B. `stage` — the whole-word census

```sh
git grep -I -in stage da9e92c -- 'apps/**' 'packages/**' 'tools/openapi/**' \
  | grep -v -E '\.test\.|__tests__|\.spec\.' | wc -l     # 156
git grep -I -il stage da9e92c -- 'apps/**' 'packages/**' 'tools/openapi/**' \
  | grep -v -E '\.test\.|__tests__|\.spec\.' | wc -l     # 47
```

- **156** non-test matching lines, in **47** files. Every one is accounted for in Consequences (iii) below — under (iii-a), under (iii-b), or in the explicitly-out-of-scope list.
- `-I` also excludes the vendored `tools/openapi/bin/oasdiff-*` binaries, which match on byte content only and are not source; without `-I` the file figure is 48 for that reason alone.
- The `M<n> stage` milestone-sub-step form is **37** lines in **18** files — `git grep -I -inE "M[0-9]+(\.[0-9]+)? stage"` over the same paths and filter — plus **3** prefix-less variants that regex misses. Both rosters are in (iii-a).

**Refreshing this block.** Re-run the commands against a newer commit and update the figures **and the commit stamp together**. Change nothing elsewhere: the rest of this ADR and the whole glossary point here rather than carrying their own copies, which is the property that keeps them from disagreeing.

---

## Decisions

### D1. The cross-domain hop is **"cross-domain promotion"**, always qualified

The hop that crosses a **security-domain** boundary is called a **cross-domain promotion**, written in full. Bare "promotion" is **never** used when the security-domain boundary is what is meant.

**Rationale.** The existing federation vocabulary already says "promotion" everywhere — Promotion Bundle, `importPromotionBundle`, `PromotionManifestSchema`, `scp federation promote`, "federated change promotion" in DESIGN.md §13. Qualifying it costs one adjective and no code. The qualifier is what does the work: it names the boundary explicitly at every use site, which is exactly the property that was missing.

### D2. The env-to-env hop is **"promotion"** (bare)

The dominant industry meaning: **the same already-built artifact advances to the next environment or stage without being rebuilt** — "build once, deploy many". Promotion is defined by *artifact identity*, not by the kind of boundary crossed.

**Rationale.** This is what the industry means, without meaningful dissent. Kargo frames a promotion as a request to move a piece of freight into a specified stage; `argoproj-labs/gitops-promoter` describes itself as a GitOps-first **environment** promotion tool; JFrog's "build promotion" moves or copies build artifacts to a target repository; Harness and Octopus use the word the same way. In GitOps specifically, promotion means updating desired state in Git for the next environment — which is very close to what SCP actually does. And it is already what our own UI means: `PromotionArrow.tsx` renders the step from one pipeline card to the next as a promotion. **This rationale does not rest on more than that** — the component is purely presentational, and what it draws between are compiled **waves**, not named environments (there is no `environment` table and no `stage` entity to supply a "Gamma" or a "Prod"). The support D2 takes from it is that the UI already calls a step-to-next-step advance a *promotion*, which is exactly the genus.

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

**Stage** means **one named deployment place**, spelled with a canonical grammar (owner-specified 2026-07-24, completed by the owner's optional-location decision of the same date) whose **middle segment is optional**:

```
<domain>[-<location>]-<env>        lowercase, hyphen-separated, fixed order
```

- **domain** — the **security domain** (`commercial`, `govcloud`, `il5`, `airgap`) — always present;
- **location** — the geographic locality/region *within* that domain (`amer`, `apac`, `emea`) — **optional**;
- **env** — the environment tier (`dev`, `gamma`, `prod`) — always present.

**Both forms are canonical.** `commercial-apac-prod` (with location) and `commercial-gamma` (without) are equally valid stage names. The word is **not** spent on ordering and **not** on pipeline phases.

**When to include the location segment.** Include it when the place is one of several geographic peers that must be told apart — `commercial-amer-prod` versus `commercial-apac-prod`. Omit it when the place has no meaningful geographic split: a single-region stage, or a genuinely global one. The segment disambiguates; where nothing needs disambiguating it is noise.

**Naming rule, and the reason optionality forces it: segment values must be hyphen-free.** With an optional middle segment, a name is parsed **by segment count** — 2 segments = `<domain>-<env>`, 3 = `<domain>-<location>-<env>`. That is only decidable if no segment value contains a hyphen of its own. So `us-east` is **not** a legal location value: `govcloud-us-east-prod` is four tokens and irresolvably ambiguous. Use single hyphen-free tokens — `useast`, `use1`, `usgovwest1`, `il5`, `preprod`. This is a naming rule of the grammar, on the same footing as the fixed order and the lowercase requirement.

**The segment order is fixed, and so is the case.** Domain, then location (where present), then env — `commercial-amer-prod`, never `commercial-prod-amer`. All segments are lowercase. This is a rule about what to write going forward; it supersedes nothing, because no other order has ever been committed to this repository.

**Wave and stage are containment, not rivalry.** A **wave** is one ordered step of a compiled plan = **the set of one-or-more stages advanced at once**. A wave therefore **contains** stages. The apparent "stage vs wave" collision was never two words competing for one meaning — "stage" was being used *for* the wave sense by mistake. Owner's worked example, in canonical form:

| Wave | Stages advanced |
|---|---|
| Wave 1 | `commercial-amer-gamma` |
| Wave 2 | `commercial-amer-prod` |
| Wave 3 | `commercial-apac-prod` **+** `govcloud-amer-prod` |

**Consequence — the CDS supply-chain gate applies per crossing, not per wave.** Wave 3 holds two stages in two *different* security domains. Advancing it is an ordinary promotion for `commercial-apac-prod` and a **cross-domain promotion** for `govcloud-amer-prod`. The gate (digest-bound scan + cosign-signed manifest + verify at every hop) is therefore evaluated **once per boundary crossing**, on the stage that crosses — never once for the wave, and never skipped because the wave "mostly" stays inside one domain. This is a real design clarification, recorded here so it is not rediscovered later.

**Settled: the location segment is optional** (owner decision, 2026-07-24). An earlier draft of this ADR left this open. It is now closed in favour of optionality: earlier location-less examples such as `commercial-gamma` and `govcloud-prod` are **valid canonical stage names**, not defects to be back-filled with a region. The whole grammar is now settled, and the hyphen-free-segment rule above is its one downstream obligation.

**Rationale and precedent — and the limit of that precedent.** The **majority** CD sense of "stage" is a pipeline *phase* — Jenkins `stage()`, GitLab CI `stages:`, Spinnaker pipeline stages — and we deliberately do not use that sense. **Kargo's `Stage` CRD is the precedent for spending the word on a promotion-target node rather than a pipeline phase** ("a stage is a promotion target that represents some desired state"). That precedent is real and it is the whole of what Kargo supports here.

**Kargo does not support the place definition, and this ADR does not claim it does.** Kargo has no security-domain axis, and its docs state that a Stage's name denotes an application instance's **purpose** "and not necessarily its location" — Kargo deliberately declines to bind a Stage to a place. The `<domain>[-<location>]-<env>` definition is **ours**: SCP-specific, not inherited. An earlier draft of this ADR called the reservation "standards-defensible" on Kargo's authority; that was an overclaim and is corrected here. The glossary marks the term **QUALIFIED-STANDARD (word-sense precedent only)** accordingly.

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

Rejected because it has already been tried. ADR-0016 and DESIGN.md both mandate the full forms, and the code is still full of undifferentiated `domainId` uses carrying two different meanings, with no type-level separation at all (scale: [census snapshot §A](#a-domainid--the-two-senses-undifferentiated)). A convention that two documents already mandate and the code still violates is not a control. D4 makes it a compiler error instead.

### Rejected: introduce a `stage` entity now

Rejected as premature. D6 reserves the *word* and settles its grammar; building the entity is a separate design question (what a stage owns, how it relates to `deployment-target`, and whether it subsumes the missing `environment` concept). The grammar itself is no longer open — the location segment is optional, and a future parser must key on segment count.

**Reserving the word is free; reclaiming it is not.** The word has *already* been spent on waves, including in the shipped `/v1` service-board response — see Consequences (iii-b), which is a breaking change. So the honest statement is that reserving now costs nothing further and stops the spend growing, not that the reservation is cost-free in aggregate.

---

## Cost table — which paths were cheap and which were deliberately paid for

| Term | Surface it touches | Cost | Decision |
|---|---|---|---|
| **cross-domain promotion** (D1) | Prose only — the qualifier is additive | **Zero.** No code, no schema, no API. | Adopted; "transfer" rejected to keep this at zero |
| **promotion** (D2) | Already the meaning in `PromotionArrow.tsx`, `promotion-repo.ts`, `PromotionManifestSchema` | **Zero.** Ratifies existing usage. | Adopted |
| **release** (D3) | **No release table, entity, or API resource** — it is a gloss on `change` living in comments. | **Near-zero.** One exception: **`release-topology`** is a real object type whose slug leaks into URNs (`urn:scp:{org}:release-topology:{slug}`) — untouched by this ADR. | Adopted |
| **security domain / containment domain** (D4, prose) | ADR-0016 and DESIGN.md already mandate the full forms | **Zero** for the prose convention | Adopted |
| **branded `TrustDomainId` / `ContainmentDomainId`** (D4, code) | Every non-test `domainId` use across `apps/` and `packages/` — trust-sense concentrated in `apps/server/src/federation/`, containment-sense in `apps/server/src/graph/`, both plain `uuid` today (scale: [census snapshot §A](#a-domainid--the-two-senses-undifferentiated)) | **Moderate.** Type-only — no runtime behaviour, no schema, no API. Mechanical but wide. | Tracked follow-on PR (i) |
| **`promote` → `accept`** (D5) | `changes.state='promoted'` (**DB value**); `POST /v1/changes/{id}/promote` (**a `/v1` path**); `promoted` in the `ChangeState` enum on **every change response**; `scp change promote`; the seeded `state_transitions` rows; `transitions.ts` `LEGAL_TRANSITIONS` | **Highest in the system — BREAKING.** `/v1` contract change + data migration. Paid because pre-1.0, single deployment, and ADR-0004 precedent. | Tracked follow-on PR (ii) |
| **`stage`** (D6) — cheap half | UI labels/test hooks (`StageCard.tsx`, `change-pipeline.tsx`, `PromotionArrow.tsx`, `change-detail.tsx`, `query-client.ts`) + comments, docblocks and prose — including the `M<n> stage N` milestone comments and the CI-phase references under `tools/openapi/`. Full file rosters in Consequences (iii-a). | **Cheap.** UI + docs only — no API, no schema, no migration. One caveat: the `tools/openapi/` sites cite "BUILD_AND_TEST.md §6 stage 3" by name, so fixing them means renaming that section too. | Tracked follow-on PR (iii-a) |
| **`stage`** (D6) — breaking half | **The `/v1` contract.** `ServiceBoardStageSchema` / `ServiceBoardStage` / `ServiceBoardRow.currentStage` / `.stages` in `packages/schemas/src/services.ts`, shipped on `GET /api/v1/services/{idOrUrn}/board` (`apps/server/src/routes/services.ts`), exported from `packages/sdk/src/index.ts` and regenerated into **both** `packages/sdk/src/generated/types.gen.ts` (the field pair) and `packages/sdk/src/generated/sdk.gen.ts` (the operation docstring), committed in `tools/openapi/openapi.v1.json` (route `summary`, both fields, and the `required` list), plus the server projection `apps/server/src/coordination/service-board.ts` and the consuming UI `apps/web/src/routes/service-board.tsx` (including its `@scp/sdk` type import). Full site roster at Consequences (iii-b). | **BREAKING.** A `/v1` **response-shape** change: trips the oasdiff additive-only gate and requires `pnpm gen` + SDK regeneration. **No `stage` table and no `environment` table exist** — but the *word* is in the contract in the wave sense. | Tracked follow-on PR (iii-b) |
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
Introduce branded TypeScript types so the trust-tier id and the containment-domain id are not interchangeable. Thread them from `apps/server/src/db/schema.ts` (`federation_self.domainId` = trust; `objects.domainId` = containment) outward through `apps/server/src/federation/`, `apps/server/src/graph/` and `packages/schemas`. The scope is every non-test `domainId` use under `apps/` and `packages/`; its size is in the [census snapshot §A](#a-domainid--the-two-senses-undifferentiated), including the two binary-detected files a plain `git grep` will not show you. **Type-only** — no runtime behaviour change, no schema change, no API change. Not started.

**(ii) The D5 `promote` → `accept` rename — BREAKING.**
- `ChangeStateSchema`: `promoted` → `accepted` (`packages/schemas/src/changes.ts:22`).
- `LEGAL_TRANSITIONS`: `{ validating → promoted, trigger: "promote" }` → `{ validating → accepted, trigger: "accept" }`, plus the `promoted → rolled_back` edge and the `validating|promoted` coupling predicates (`apps/server/src/coordination/transitions.ts`, `packages/schemas/src/changes.ts:86,235`).
- Route: `POST /api/v1/changes/:id/promote` → `.../accept`, `operationId: promoteChange` → `acceptChange` (`apps/server/src/routes/changes.ts`). **This is a breaking `/v1` change** and will trip the oasdiff additive-only gate — an explicit, ADR-authorized exception, exactly as ADR-0004's rename was.
- CLI: `scp change promote` → `scp change accept` (`packages/cli/src/cli.ts`). `scp federation promote` is **untouched**.
- **Data migration** over `changes.state` (`'promoted'` → `'accepted'`) plus the seeded `state_transitions` rows (`apps/server/drizzle/0007_change_coordination.sql`), whose set-equality integration test must be updated in the same PR.
- SDK/OpenAPI regeneration (`pnpm gen`) and every doc/test string.
Not started.

**(iii) The D6 `stage` cleanup — SPLIT, because it is not all cheap.**

An earlier draft of this ADR named only two misuse sites (`StageCard.tsx`, `change-pipeline.tsx`) and priced the whole cleanup as "cheap — UI and docs only, no API, no schema, no migration". **That census was incomplete and that cost claim was false.** Successive review passes each found further misses, so the census is now stated with its **method** attached — the re-runnable command and its figures are in the [census snapshot §B](#b-stage--the-whole-word-census) — rather than merely asserted to be complete.

**How the sites below are cited.** They are the scoping input for two real PRs, so the rosters are **file paths**, deliberately: line numbers move with every rebase and these lists must survive one. A line number appears only where the exact line *is* the evidence — a verbatim quoted comment, a named symbol definition, a specific enum value. For everything else, the path plus the symbol or hook name is what you grep for. [docs/GLOSSARY.md](../GLOSSARY.md)'s `stage` entry describes the same five senses in prose; the roster and the figures live **here only**, so there is one copy to correct.

**(iii-a) The cheap half — UI labels, test hooks, comments and prose. No API, no schema, no migration. Not started.**

- `apps/web/src/components/pipeline/StageCard.tsx` — **the whole component**; not enumerated line-by-line because the file itself is the misuse. Its docblock (`:90`) reads *"One pipeline stage = one compiled wave"*; it takes a `ChangeWave` plus a `stageNumber` prop, renders the visible label `Stage {stageNumber}`, and carries `data-stage` plus nine distinct `data-testid="stage-*"` hooks.
- `apps/web/src/routes/change-pipeline.tsx` — wave-sense labels and the `data-testid="pipeline-stages"` hooks throughout.
- `apps/web/src/components/pipeline/PromotionArrow.tsx:4, 26` — its **own docblock** reads *"The gate/approval state of a promotion between two pipeline stages"* and *"two vertically-stacked stage cards"*. This is the file D2's rationale cites; what it draws is a promotion, what it calls the cards it draws between is this misuse.
- `apps/web/src/routes/change-detail.tsx`; `apps/web/src/lib/query-client.ts` (query-key strings).
- "per-stage version" (wave sense) in comments and docblocks: `packages/schemas/src/changes.ts`; `apps/server/src/coordination/plan-service.ts`; `apps/server/src/coordination/wave-targets-repo.ts`; `apps/server/drizzle/0027_wave_target_observed_state.sql`; `packages/schemas/src/services.ts`; `packages/sdk/src/client.ts`; `apps/web/src/routes/service-board.tsx`.
- "stage" for a pipeline **phase**: `apps/server/src/coordination/change-coordination-lock.ts` (*"one pipeline stage earlier"*); `tools/openapi/check.sh` and `tools/openapi/README.md`, which name "BUILD_AND_TEST.md §6 stage 3" — fixing those means renaming that section in BUILD_AND_TEST.md too, so they are not free the way a comment is; and prose such as the execution map in `docs/proposals/promotion-and-execution-model.md` §1. Say **phase** or **step**.
- "stage" for a **milestone sub-step** — two variants, listed separately because they need different greps:
  - the **`M<n> stage` form** — complete file roster, not a sample: `apps/server/drizzle/0004_auth_expansion.sql`, `apps/server/drizzle/0005_plans.sql`, `apps/server/src/app.ts`, `apps/server/src/auth/device-flow.ts`, `apps/server/src/auth/local-auth.ts`, `apps/server/src/auth/oidc.ts`, `apps/server/src/auth/pat.ts`, `apps/server/src/config.ts`, `apps/server/src/db/schema.ts`, `apps/server/src/routes/auth.ts`, `apps/server/src/routes/device-flow.ts`, `apps/server/src/routes/oidc.ts`, `apps/server/src/routes/pats.ts`, `apps/web/vite.config.ts`, `packages/schemas/src/auth.ts`, `packages/schemas/src/graph.ts`, `packages/sdk/src/client.ts`, `packages/sdk/src/index.ts`;
  - **prefix-less variants** that the `M<n> stage` regex misses, complete: `apps/web/src/routes/device.tsx` (*"stage 2's server-side integration test"*), `apps/web/src/routes/pats.tsx` (*"stage 2's PAT API"*), `apps/web/vitest.config.ts` (*"before this stage's changes"*).

  A third distinct sense; every site in both variants should say **part** or **step**.

**(iii-b) The breaking half — the service-board `stage` = wave chain is in the shipped `/v1` contract. BREAKING. Not started.**

- `packages/schemas/src/services.ts` — the contract source: `ServiceBoardStageSchema`, the exported `ServiceBoardStage` type, and `ServiceBoardRowSchema`'s `currentStage` and `stages` fields. Its docblock (`:25`) is explicit: *"One pipeline stage of a component's latest change = one compiled wave"*, and the row docblock defines `currentStage` as *"the running (or last non-pending) wave's display name"*.
- `apps/server/src/routes/services.ts` — shipped on `GET /api/v1/services/:idOrUrn/board`; the route's leading comment says "per-stage status" and so does its OpenAPI `summary`.
- `packages/sdk/src/index.ts` (the `ServiceBoardStage` re-export); `packages/sdk/src/generated/types.gen.ts` (the generated `currentStage`/`stages` field pair); `packages/sdk/src/generated/sdk.gen.ts` (the same route summary as the generated operation docstring). All three regenerate from the contract.
- `tools/openapi/openapi.v1.json` — the route `summary`, the `currentStage` and `stages` properties, and both of those names in the schema's **required** list. The document is committed, so the change is visible to the oasdiff gate.
- `apps/server/src/coordination/service-board.ts` — the server-side projection that builds the field.
- `apps/web/src/routes/service-board.tsx` — the `import type { ServiceBoardRow, ServiceBoardStage } from "@scp/sdk"` the rename breaks; the `StageStrip` component, whose `board-stage-badge` is captioned from the **wave** index (`Wave ${s.waveIndex}` in the tooltip, `W${s.waveIndex}` in the label — the same object labelled both ways inside one function); the `<TableHead>Current stage</TableHead>` / `<TableHead>Stages</TableHead>` headers; and the `row.currentStage` / `row.stages` reads.

Renaming these is a **breaking `/v1` response-shape change**: it will **trip the oasdiff additive-only gate** — an explicit, ADR-authorized exception on the same footing as (ii) — and requires `pnpm gen` plus SDK regeneration. It should be sequenced with, or after, (ii) so `/v1` takes one authorized break rather than two.

**Explicitly out of scope (not misuses) — listed in full, because a reader re-running the grep hits these first.**

- Docker's own multi-stage-build term: `apps/runner-scan/Dockerfile` — a genuine multi-stage Docker build (`STAGE 1 — Trivy`, `STAGE 2 (FINAL) — OpenSCAP`), not a misuse; `apps/runner-scan/README.md`, which describes that build (*"`COPY --from` a digest-pinned Trivy stage"*); `packages/cosign/src/cosign-bin.ts`; `packages/cosign/src/skopeo-bin.ts`; `packages/plugin-testkit/src/runner-image.ts`.
- The unrelated verb "staged": `apps/server/src/governance/scan-db.ts` ("staged payload", "staged metadata").
- `apps/server/src/graph/named-queries.ts`, whose hypothetical "stage-domain" is consistent with the reserved place sense.
- The vendored `tools/openapi/bin/oasdiff-*` binaries, which match on byte content only.

### Ongoing

- New docs and ADRs use the glossary's terms. Where a term's preferred form does not yet match the code, the doc says so rather than describing an aspirational codebase.
- "Stage" stays reserved. If a stage entity is later built, it must mean one named deployment place under the `<domain>[-<location>]-<env>` grammar — contained by a wave, never a synonym for one — or supersede this ADR explicitly. Its name parser must key on **segment count** (2 or 3) and must reject any segment value containing a hyphen, per the naming rule in D6.
- The per-org-vs-per-deployment federation identity question flagged in ADR-0016 remains **open** and is not resolved here.
- **Citation discipline, adopted after four review passes found roughly thirty defects in these two documents — and not one of them was a wrong idea.** Every single one was a number, a ranking, a superlative, a line reference or a provenance claim. The model, the definitions, the standards citations and the cost analysis survived every pass unchanged. That is not bad luck; it is a signal about which parts of a glossary carry risk. The three rules that follow from it, binding on this ADR and on [docs/GLOSSARY.md](../GLOSSARY.md):
  1. **No per-file rankings and no superlatives.** Not "the largest concentration", not "joint-Nth", not "the most". A glossary fixes vocabulary; vocabulary does not need occurrence rankings to be authoritative, and every ranking is a claim that silently goes wrong the next time anyone edits a file.
  2. **Measurements live in exactly one place** — the [census snapshot](#census-snapshot) — with the command, the commit, and the figure that command actually returns. Everything else points at that block. If a figure cannot be reproduced by running the command printed beside it, it does not go in; a number a reader cannot check is worse than no number.
  3. **A line number appears only where the exact line *is* the evidence** — a verbatim quoted comment, a named symbol definition, a specific enum value. Every other reference cites the **file path alone** and names the symbol, because paths and symbols survive a rebase and line numbers do not.
- **Never assert history that is not in the repository.** An earlier draft of D6 claimed the project had previously used a different stage-name segment order and cited example strings for it; no such string had ever been committed. If a form was only ever discussed, it was never superseded — state the rule going forward and leave the history out.
