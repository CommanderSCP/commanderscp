# CommanderSCP Terminology Glossary

**Status:** Authoritative for vocabulary. Owner-decided 2026-07-24 — the reasoning, the rejected alternatives, and the cost table live in [ADR-0021](adr/0021-terminology.md).

## Why this document exists

CommanderSCP **coordinates other people's tools**, and those tools arrived with vocabulary already attached. Argo CD, Kargo, JFrog, Helm, GitHub Actions and Terraform all use words like *promotion*, *release*, *stage* and *environment* — and they do not all mean the same thing by them. On top of that, the product ships into regulated and cross-domain environments where NIST and CNSSI have already defined *security domain*, *authorization boundary* and *cross-domain solution* precisely, and where a word like *release* carries a **disclosure** meaning that has nothing to do with software delivery.

The rule this glossary follows:

1. **Where a clear industry standard exists, use it** — and cite it, so a new engineer can go read the source.
2. **Where standards collide or the concept is genuinely ours, the owner decided** — and [ADR-0021](adr/0021-terminology.md) records why, including the alternatives that were considered and rejected.
3. **Where the glossary's preferred word does not match the code today, this document says so in the entry.** Nothing here describes an aspirational codebase as if it already exists. Four code changes were tracked as follow-on PRs — branded domain-id types (i), the `promote` → `accept` rename (ii), and the `stage` cleanup split into a cheap half (iii-a) and a **breaking `/v1`** half (iii-b). **All four have landed**, so the entries below describe the code as it is, not as it was promised.

Audience: a new engineer trying to read the code, and an operator trying to read the UI. It is not a research dump — the research is in the ADR.

**How code is cited here (read this before adding a citation).** Line numbers rot the moment `main` moves; file paths and symbol names do not. So this document cites a **line number only where the exact line *is* the evidence** — a verbatim quoted comment, a specific enum value, a schema field definition. Everywhere else — the "In the code" pointers at the end of each entry, file rosters, "see also" links — it cites the **file path alone**, and names the symbol so `grep` can finish the job.

**This glossary carries no measured counts and no per-file rankings.** The rule is about *claims a reader would have to re-measure to trust* — occurrence counts, "N files", "the largest concentration", "joint-Nth". It is not a ban on ordinary comparative English ("the most prevalent sense" of a word, "the most overloaded object type"), which is judgement a reader can weigh from the surrounding text. Every measurement lives in one place — [ADR-0021's census snapshot](adr/0021-terminology.md#census-snapshot), stamped with the exact command and the commit it was run against — and the entries below point at it rather than restating a figure. That is deliberate: a glossary's job is to fix **vocabulary**, which needs no occurrence counts to be authoritative, and the same number restated in several documents is a number that will drift apart. Keep all three conventions when editing.

---

## Quick reference

| Term | One-line meaning | Standard? |
|---|---|---|
| **promotion** | The same already-built artifact advances to the next step without being rebuilt | INDUSTRY-STANDARD |
| **cross-domain promotion** | A promotion whose next step crosses a **security-domain** boundary, and therefore must pass the CDS supply-chain gate | QUALIFIED-STANDARD |
| **accept / accepted** | The human approval gate that terminates a change's lifecycle in success | SCP-SPECIFIC |
| **release** | The versioned unit of change moving through its whole pipeline — a change **is** a release | QUALIFIED-STANDARD |
| **release topology** | A versioned declarative document describing a release's waves, target groups and gates | SCP-SPECIFIC |
| **deploy / deployment** | The push of an artifact into one environment so it runs there | INDUSTRY-STANDARD |
| **deployment target** | The graph object type an executor acts on (cluster, host, environment, region) — deliberately broad | SCP-SPECIFIC |
| **environment** | A named operational tier (dev / gamma / prod) within one security domain | INDUSTRY-STANDARD |
| **stage** | **Reserved:** one named deployment **place**, spelled `<domain>[-<location>]-<env>`. A **derived name**, never a row — [ADR-0026](adr/0026-placements-and-derived-stage-names.md) | QUALIFIED-STANDARD *(word-sense precedent only; the definition is ours)* |
| **placement** | One component **at** one deployment target — the pair an executor binding attaches to | SCP-SPECIFIC |
| **wave** | One ordered step of a compiled plan — the **set of one-or-more stages** advanced at once | SCP-SPECIFIC |
| **change** | The coordinated unit of work; a graph object with a lifecycle state machine | SCP-SPECIFIC |
| **pipeline** | The ordered path a release travels for one executor **Type** | INDUSTRY-STANDARD |
| **artifact** | The immutable built thing identified by digest (image, rpm, npm, config bundle, plan) | INDUSTRY-STANDARD |
| **configuration as code** | Declarative config/infra released from a git repo like any other artifact — often, **not always**, domain-local | INDUSTRY-STANDARD |
| **bundle** | Three distinct things — see the entry; always qualify | SCP-SPECIFIC |
| **security domain** | A domain implementing one security policy under a single administering authority | INDUSTRY-STANDARD (CNSSI-4009) |
| **containment domain** | The intra-org `domain` graph object type — an ordinary grouping below org | SCP-SPECIFIC |
| **assembly** | The OPTIONAL grouping level between service and component — a macro-component | SCP-SPECIFIC |
| **authorization boundary** | The components authorized for operation by one authorizing official, excluding separately authorized connected systems | INDUSTRY-STANDARD (NIST SP 800-37) |
| **CDS / cross-domain solution** | The accredited mechanism that transfers information between security domains | INDUSTRY-STANDARD (CNSSI-4009) |
| **retrans** | The SCP federation role that sits at a CDS boundary and validate-then-relays | SCP-SPECIFIC |
| **commander** | The federation role that is the source of truth for global config | SCP-SPECIFIC |
| **outpost** | The federation role for a per-domain/per-environment instance | SCP-SPECIFIC |
| **HQ outpost** | The outpost in the commander's **own** trust domain — the record whose `peerDomainId` is this instance's own domain | SCP-SPECIFIC |
| **field outpost** | Any outpost in **another** trust domain — every paired outpost peer that is not the HQ one, whatever its connectivity | SCP-SPECIFIC |
| **federation** | Hash-chained, signed journal exchange between SCP instances | QUALIFIED-STANDARD |
| **org / tenant** | The top-level tenancy unit; one org is one federation identity | SCP-SPECIFIC |
| **instance** | One running deployment of the SCP binary; multi-tenant | SCP-SPECIFIC |
| **region** | A geographic locality *within* a security domain | INDUSTRY-STANDARD |
| **executor** | A plugin implementing the observe/trigger/status/abort verbs against an execution system | SCP-SPECIFIC |
| **execution system** | The registered external system an executor talks to (an Argo CD, a GitHub) | SCP-SPECIFIC |
| **coordination, not execution** | The charter invariant: SCP triggers/observes/gates; it does not build, test, scan or deploy | SCP-SPECIFIC |
| **scan gate** | A boundary-crossing **authorization** gate whose evidence is a vulnerability scan verdict | SCP-SPECIFIC |
| **manifest** | The commander-signed enumeration of exactly the artifacts authorized to cross | SCP-SPECIFIC |
| **control** | An abstract graph object declaring a check; plugins are its bindings | SCP-SPECIFIC |
| **decision** | The persisted, explainable verdict record every engine judgement writes | SCP-SPECIFIC |
| **poke / poke-mode** | An optional contentless commander→outpost wake signal | SCP-SPECIFIC |
| **scan exclusion** | A finding that does not count toward the ceiling, applied before counting — never a waiver on the verdict | QUALIFIED-STANDARD |
| **exclusion admission** | A tier's declaration that a class of exclusion may have effect at or below it | SCP-SPECIFIC |
| **scan override request** | An owner-raised request for a standing, expiring exclusion, approved at the tier that set the rule | SCP-SPECIFIC |

---

## The organizing idea: promotion is a genus, cross-domain promotion is a species

Everything about *promotion* in this system follows from one relationship:

> **PROMOTION is the genus.** The same already-built artifact advances to the next step in its pipeline, without being rebuilt.
>
> **CROSS-DOMAIN PROMOTION is the species.** It is a promotion whose next step happens to cross a **security-domain** boundary — and *because* of that crossing it must additionally pass the CDS supply-chain gate: scan, a cosign-signed promotion manifest, and cosign-verify at every hop.

Two consequences worth internalising:

- **Bare "promotion" never implies a domain crossing.** Gamma → Prod inside one domain is a promotion, full stop.
- **"Cross-domain promotion" is always written in full.** When the security-domain boundary is what you mean, the qualifier is not optional — it is the only thing distinguishing the species from the genus.

---

## Entries

### promotion

**Definition.** The same already-built artifact advances to the next step of its pipeline **without being rebuilt** — "build once, deploy many". Promotion is defined by *artifact identity*: the bits that arrive are the bits that were built. It is **not** defined by what kind of boundary is crossed.

In GitOps terms — which is what SCP actually coordinates — a promotion is the act of updating the desired state in Git so the next environment picks up the already-built artifact.

**Industry-standard?** Yes. Kargo's documentation frames a promotion as a request to move a piece of freight into a specified stage. The `argoproj-labs/gitops-promoter` project describes itself as a GitOps-first **environment** promotion tool. JFrog's "build promotion" moves or copies build artifacts to a target repository. In none of these does "promotion" imply crossing a *security* boundary; it implies advancing without rebuilding.

**Not to be confused with:**
- **cross-domain promotion** — the species below, which additionally crosses a security domain. Never say bare "promotion" when you mean that.
- **`accept` / `accepted`** — the change-lifecycle approval gate. That is a human decision about a change, not an artifact advancing. It used to be spelled `promote`, which is exactly why it was renamed (see the `accept` entry).
- **Argo Rollouts' "Promote"** — the progressive-delivery sub-step inside a canary analysis. SCP observes it; SCP does not own it (`docs/proposals/coordination-ui-views.md` §2).
- **`scp federation promote`** — the CLI verb that exports a **Promotion Bundle**. That is a real promotion (the genus), and it is often but not always cross-domain.

**In the code.** `apps/web/src/components/pipeline/PromotionArrow.tsx` is the UI expression of this sense: a wide top-to-bottom arrow drawn between two vertically-stacked cards, painted from a `PromotionState` (`open` / `blocked` / `approval` / `pending`). Read its own docblock before citing it, because two things about it are commonly overstated:

- **It is "purely presentational"** (its words) — *"the parent computes `state`/`label`/`detail`/`why` from real change data … this component only paints it"*. It decides nothing and evaluates no gate.
- **It draws between compiled *waves*, not between named environments.** The cards on either side are `PipelineWaveCard`s, one per compiled wave. There is no `environment` table and no `stage` entity, so it cannot be drawing "Gamma → Prod" — there is no Gamma and no Prod for it to draw between. Its docblock formerly said *"between two pipeline stages"*, one of the wave-sense misuses catalogued in the `stage` entry's misuse breakdown; ADR-0021 follow-on (iii-a) corrected it to *"between two consecutive waves"*.

`apps/server/src/federation/promotion-repo.ts` carries Promotion Bundles; `PromotionManifestSchema` in `packages/schemas/src/federation.ts` carries the signed manifest that authorizes a cross-domain one.

---

### cross-domain promotion

**Definition.** A promotion whose next step crosses a **security-domain** boundary — commercial → GovCloud → IL5 → air-gapped. Because the crossing is a boundary-authorization event, a cross-domain promotion must additionally satisfy the CDS supply-chain gate:

1. a passing, **digest-bound** scan verdict against the effective scoped pass-criteria ([ADR-0016](adr/0016-scoped-scan-requirement-policies.md));
2. a **cosign-signed promotion manifest** enumerating exactly the authorized artifact set ([ADR-0015](adr/0015-cosign-cross-boundary-signing.md));
3. **cosign-verify at every hop** — the retrans verifies before letting anything cross the CDS, and the receiving outpost verifies again inside the domain before deploy ([ADR-0011](adr/0011-universal-outpost-validation.md)).

What crosses is **metadata** — change objects, digests, signatures, SBOM references, the signed manifest. Artifact bytes travel on a separate channel ([ADR-0019](adr/0019-artifact-byte-channel.md)).

**Always qualified.** Write "cross-domain promotion" in full. Bare "promotion" is the genus and carries no boundary implication.

**The gate is per crossing, not per wave.** A single wave may advance stages sitting in *different* security domains — the `wave` entry's Wave 3 advances `commercial-apac-prod` and `govcloud-amer-prod` together. That wave is an ordinary promotion for the first stage and a cross-domain promotion for the second. The CDS supply-chain gate above is therefore evaluated **once per boundary crossing**, on the stage that crosses — never once for the wave as a whole, and never skipped for a wave that "mostly" stays inside one domain.

**Industry-standard?** Qualified. The concept is standard; the *word* is ours. CNSSI-4009 defines a cross-domain solution using two verbs — **access** and **transfer** — of information between different security domains, and NCDSMO's accredited-product taxonomy splits transfer-CDS from access-CDS. By the letter of those standards, the correct verb for this hop is **transfer**. The owner considered renaming it and **rejected** that in favour of keeping the existing federation vocabulary at zero rename cost; [ADR-0021](adr/0021-terminology.md) records the rejection honestly, including that "transfer" is the literal CDS-standard verb.

**Not to be confused with:**
- **promotion (bare)** — the genus. Env-to-env, no boundary.
- **transfer** — the CDS-standard word for this. We do not use it as our name for the hop, but when writing for an accreditation audience it is the word they will expect; say "cross-domain promotion (a CDS *transfer* in CNSSI-4009 terms)".
- **relay** — what the retrans does mechanically (validate then forward). Relaying is a step *inside* a cross-domain promotion, not a synonym for it.

**In the code.** `apps/server/src/federation/promotion-repo.ts` (`importPromotionBundle`), `apps/server/src/federation/retrans-relay.ts`, `apps/server/src/federation/artifact-verify.ts`, and the export-time gate that hard-refuses any digest lacking a passing digest-bound scan.

---

### accept / accepted

**Definition.** The **human approval gate** that terminates a change's lifecycle in success. A change that has finished executing and validating is *accepted* by a person, and `accepted` is a terminal success state (a rollback is still possible afterwards; nothing else is).

`accept` is **domain-agnostic**. It applies to every change, including purely intra-domain ones that never cross any boundary and never move any artifact anywhere new.

**Formerly spelled `promote` / `promoted`.** This is the owner's 2026-07-24 rename decision (D5 in [ADR-0021](adr/0021-terminology.md)). The rationale: the approval gate is a *human decision on a change*, not *an artifact advancing* — so under the genus/species model above, calling it "promote" actively fights the glossary. Every reader who learns that promotion means "the same bits advance" then hits `validating → promoted` and has to unlearn it.

It is **not** an artifact promotion (the genus) and **not** a cross-domain promotion (the species). It is a third thing that happened to share a word.

**In the code — LANDED.** The rename shipped as follow-on PR (ii); the code and the vocabulary now agree:

- `apps/server/src/coordination/transitions.ts` — the edge is `{ from: "validating", to: "accepted", trigger: "accept" }`
- `packages/schemas/src/changes.ts` — `"accepted"` is the `ChangeState` enum value, returned on every change response
- `apps/server/src/routes/changes.ts` — `POST /api/v1/changes/:id/accept` (`operationId: acceptChange`)
- `packages/cli/src/cli.ts` — `scp change accept <id>`
- `apps/server/drizzle/0039_change_state_accepted.sql` migrates `changes.state`, the `state_transitions` seed rows, operator gate bindings, and the Decision/control-run explainability records. `audit_events` (hash-chained) and `federation_journal` payloads (signed) are deliberately **not** rewritten — that migration's header says why.

It was genuinely breaking — a `/v1` path change, a data migration over `changes.state`, the seeded `state_transitions` rows, the CLI verb, and the enum in every change response — and was taken as an authorized oasdiff exception recorded in [`tools/openapi/OASDIFF-EXCEPTIONS.md`](../tools/openapi/OASDIFF-EXCEPTIONS.md). It was judged payable because the project is pre-1.0 with a single deployment, and because [ADR-0004](adr/0004-service-naming-commander-outpost-retrans.md) set the direct precedent — it removed `parent`/`child` outright in favour of `commander`/`outpost`/`retrans`, a breaking federation-role enum rename taken for exactly this class of reason.

**Not to be confused with:**
- **`scp federation promote`** (`packages/cli/src/cli.ts`) — the Promotion Bundle export verb. That one is a real promotion and keeps its name.
- **an approval** — `requireApprovals` is a *policy effect* producing approval tasks and `approves` relationships (DESIGN.md §10.2). An approval is evidence a gate consumes; `accept` is the lifecycle transition the gate guards. A change can require several approvals and still be accepted once.

---

### release

**Definition.** **A change *is* a release.** A release is the versioned unit of change moving through its **whole** pipeline. It may span many waves, may touch many targets, and may cross security domains. A release comes from exactly **one source per pipeline** — a release needing both a software and an infrastructure source is two releases.

A release is emphatically **not** "one push into one stage". That push is a **deployment**.

**Industry-standard?** Qualified. The word has at least five entrenched senses in the wider industry, and we adopt a blend of the first two:

1. **the versioned artifact bundle / named version** — the most prevalent sense, and half of ours;
2. **the process or event of shipping** ("release train", "release management") — the other half;
3. **Humble & Farley's strict sense** in *Continuous Delivery*: *deploy* means install into an environment, *release* means make available to **users** (feature flags, dark launch). We do **not** use this sense — SCP has no user-exposure primitive;
4. **Helm's sense**: an installed instance of a chart in a cluster. This is a hard collision — SCP ships a Helm chart, so "the release" in a `helm list` output is a completely different object;
5. **Linux packaging's `release` field** (the `-1` in `1.2.3-1`).

Note that DORA measures **deployment** frequency, not release frequency — further evidence that "deployment" is the word for the per-environment push.

**Why the precision matters here — a compliance landmine.** In DoD/IC usage, **"release" and "releasability" mean a disclosure determination** (REL TO markings, foreign disclosure review). Cross-domain filters exist precisely to enforce security *and releasability* policies. A cross-domain product that uses "release" loosely to mean "deploy" invites an accreditation reader to see a **disclosure determination** where a software deployment was meant. That is the single strongest reason this glossary insists on the distinction between *release* (the unit moving through the pipeline) and *deployment* (the push into one environment).

**Not to be confused with:** a Helm release; a deployment; a GitHub Release object; a releasability determination.

**In the code.** There is **no** release table, entity, or API resource — "release" is a gloss on `change`. It is stated most directly in the docblock on the change-input `type?: ExecutorType` field in `apps/server/src/coordination/changes-repo.ts`: *"a change IS a release, and a release comes from ONE source per pipeline, so one change drives one pipeline. A release needing both is two releases."* The one place the word is load-bearing in an identifier is **`release-topology`** (below), whose slug leaks into URNs.

---

### release topology

**Definition.** A versioned declarative JSON document (a registry graph object, IaC-manageable) describing how a release progresses: waves with sequential or parallel target groups, per-wave gates, and fan-in gates. Single, canary, blue/green, rolling, regional, domain-based, federated and custom topologies are all **data**, not workflow code (DESIGN.md §9.3).

A change compiles against a release topology into `plan → waves → wave_targets` rows.

**Industry-standard?** No — SCP-specific. The nearest analogues are Spinnaker's deployment strategies and Argo Rollouts' strategy specs, but neither is a first-class versioned registry object the way this is.

**Not to be confused with:** the *graph* topology (`depends_on` / `consumes` edges between services and components), which is a different structure entirely and is what the two-layer graph explorer renders.

**In the code.** Object type `release-topology`, seeded in `apps/server/drizzle/0002_rls_rbac_seed.sql`; resolved in `apps/server/src/coordination/plan-service.ts` and `apps/server/src/coordination/campaign-repo.ts`. **Its slug leaks into URNs** (`urn:scp:{org}:release-topology:{slug}`), so unlike the rest of "release" this identifier is not free to redefine.

---

### deploy / deployment

**Definition.** The push of an already-built artifact into **one** environment so that it runs there. A deployment is the per-environment event; a release is the whole journey.

**Industry-standard?** Yes, and unambiguously so — this is the least contested word in the delivery vocabulary. GitHub Actions mints a `deployment` object per environment-scoped job. DORA's headline metric is deployment frequency. Humble & Farley define deploy as installing into an environment (reserving *release* for user exposure).

**Not to be confused with:** *release* (the whole unit moving through the pipeline); *promotion* (the advance from one step to the next, of which a deployment is often the effect); Kubernetes' `Deployment` resource (a workload controller — a completely different noun that happens to share the word, and which SCP coordinates Argo CD to manage).

**In the code.** Deploys are coordinated, never executed by SCP: Argo CD for Kubernetes (`packages/plugins/argocd`), Ansible via `scp-runner-ops` for hosts (proposed), Argo Workflows or `scp-managed-iac` for cloud infrastructure (`packages/plugins/managed-iac`).

---

### deployment target

**Definition.** The graph object type an executor acts on. Deliberately broad: a `deployment-target` may model a **cluster**, a **host**, an **environment**, or a **region**.

**Industry-standard?** No — SCP-specific, and honestly the most overloaded object type in the model. That breadth is a deliberate simplicity trade (charter priority 1), not an oversight: rather than three near-identical tables, one object type carries the "place an executor points at" role, and executor bindings disambiguate by Type and scope.

**Not to be confused with:** *environment* (a tier concept a deployment target may or may not represent) and *stage* (a reserved deployment **place** — see below). If you need to know *which* sense a given `deployment-target` row carries, read its bindings; the type alone does not tell you.

**In the code.** Object type `deployment-target`, seeded in `apps/server/drizzle/0002_rls_rbac_seed.sql`. The two relationship types that point at it are seeded alongside in the same file: `hosted_on` (from `service`/`component`) and `deploys_to` (from `service`/`component`/`change`/`campaign`). Per-region deploy-target bindings are what [ADR-0017](adr/0017-ownership-refinement.md) §3's multi-region Argo CD setting builds on.

**Its properties — six well-known keys, all optional strings, all read verbatim (never derived from `name`).** `environment` and `region` are the two load-bearing ones: together they derive the stage name (`<domain>-[<region>-]<environment>`, [ADR-0026](adr/0026-placements-and-derived-stage-names.md) D1), and a target with BOTH non-empty is a *declared region target* whose deploys the M15.6 regional gate refuses without a region binding. Beside them sits the **substrate facet** ([pipeline-substrate-registry-scan.md](proposals/pipeline-substrate-registry-scan.md) §9.1, migration `0069_target_facet_and_publishes_to.sql`), which says what the target physically *is*: `substrate` (well-known values `aws` · `gcp` · `azure` · `kubernetes` · `vm` · `bare-metal` · `other` — vocabulary, rendered as-is, **never enforced** on the wire, because a closed enum on a journaled type is a fail-closed version-skew hazard for every older peer), `account` (the provider account / project / subscription id), `region` (the same key as above — one key, both roles) and `cluster` (the cluster name inside that account/region). The registered property schema types `substrate`/`account`/`region`/`cluster` as optional strings and stays open (`environment` is deliberately undeclared: it is a gate input). The component pipeline projects the facet on every stage's `deploymentTarget` — placed and unplaced alike — with `null` meaning *not declared*, an absence rather than an unknown, so a client renders nothing for it.

---

### environment

**Definition.** A named operational tier within one security domain — dev, beta, gamma, prod. Environments are ordered within a domain and a promotion typically advances an artifact from one to the next.

**Industry-standard?** Yes. GitHub Actions environments and Argo CD's app-per-environment convention both use it this way. Kargo models the same node but deliberately spells it **Stage** — its docs avoid "environment" precisely *because* the word is perspective-dependent, and note that a Stage's name denotes an application instance's **purpose** "and not necessarily its location". Kargo is therefore a witness to the ambiguity, not a citation for the word; see the `stage` entry.

**Not to be confused with:** *stage* — under D6 (below), "stage" is reserved for a named deployment **place** spelled `<domain>[-<location>]-<env>`, so `gamma` is an environment while `commercial-amer-gamma` and `commercial-gamma` are both stages. Environment is the **last segment** of a stage name — one of the two segments (with domain) that are always present, location being the optional one — not a synonym for the name. And *deployment target*, which may happen to model an environment but may equally model a single cluster or host.

**In the code — there is no `environment` table.** Environments are expressed as labels, deployment-target properties, and wave structure. That is a real gap, not a hidden feature; see the `stage` entry for what a future entity would need to carry.

`environment` is **not** purely informal, though: it is a live `/v1` **path segment**. `GET /api/v1/environments/{environment}/regional-executors` (`operationId: getRegionalExecutors`, response `RegionalExecutorViewSchema`, registered in `apps/server/src/routes/executors.ts` and committed to `tools/openapi/openapi.v1.json`) reads one prod environment's per-region Argo CD set. It is backed not by an entity but by deployment-target `properties.environment` / `properties.region` (the M15.6 / [ADR-0017](adr/0017-ownership-refinement.md) §3 comment above that route). So the *concept* has an API surface while the *entity* does not.

---

### stage

**Definition — RESERVED VOCABULARY.** In CommanderSCP, **stage** means **one named deployment place**. The word is spent on *place*, and on nothing else. It is **not** spent on ordering, and **not** on pipeline phases.

**The canonical naming grammar** (owner-specified 2026-07-24, completed by the owner's optional-location decision of the same date) is lowercase hyphen-separated segments in a fixed order, with the **middle segment optional**:

```
<domain>[-<location>]-<env>
```

| Segment | Required? | Meaning | Examples |
|---|---|---|---|
| **domain** | always | the **security domain** — the trust tier the place sits in | `commercial`, `govcloud`, `il5`, `airgap` |
| **location** | **optional** | the geographic locality or **region** *within* that domain | `amer`, `apac`, `emea` |
| **env** | always | the **environment** tier | `dev`, `gamma`, `prod` |

**Both forms are canonical.** `commercial-apac-prod` (three segments, with location) and `commercial-gamma` (two segments, no location) are equally correct stage names. So are `govcloud-amer-gamma` and `govcloud-prod`.

**When to include a location.** Include it when the place is **one of several geographic peers that must be told apart** — `commercial-amer-prod` versus `commercial-apac-prod`. Omit it when the place has **no meaningful geographic split**: a single-region stage, or a genuinely global one. The segment exists to disambiguate; where there is nothing to disambiguate, adding it is noise.

**Naming rule — segment values must be hyphen-free.** This is the practical consequence of making the middle segment optional, and it is a rule, not a footnote. With an optional middle segment, a name is disambiguated **by segment count**:

- **2 segments** → `<domain>-<env>`
- **3 segments** → `<domain>-<location>-<env>`

That only works if **no segment value itself contains a hyphen**. `us-east` is therefore **not a valid location value**: `govcloud-us-east-prod` is four tokens and cannot be parsed — is `us` the location and `east-prod` the env, or is it a three-segment name at all? Use a single hyphen-free token instead: `useast`, `use1`, `usgovwest1`. The same applies to every segment — no `il-5`, no `pre-prod`; write `il5` and `preprod`.

**The segment order is fixed, and so is the case.** Domain, then location (where present), then env. Do not write the env before the location — `commercial-amer-prod`, never `commercial-prod-amer` — and do not use uppercase in any segment.

**A stage is a place; a wave is a step.** These are a **containment** relationship, not two names for one thing: **a wave contains one or more stages.** The apparent "stage vs wave" collision was never a rivalry — "stage" was simply being used *for* the wave sense by mistake. See the `wave` entry, which states the same relationship from the other side.

**Industry-standard?** Qualified, and narrowly so — the precedent covers the *word-sense*, not the definition.

- The **majority** CD sense of "stage" is a **pipeline phase** — Jenkins `stage()`, GitLab CI `stages:`, Spinnaker pipeline stages. We do **not** use it that way.
- The **minority** sense — and ours — has a real precedent: **Kargo's `Stage` CRD** spends the word on a **promotion-target node** ("a stage is a promotion target that represents some desired state") rather than on a pipeline phase. That is genuine support for *what we spend the word on*.
- **It is not support for our definition.** Kargo has no security-domain axis, and its docs state that a Stage's name denotes an application instance's **purpose** "and not necessarily its location" — i.e. Kargo deliberately declines to bind a Stage to a place. The `<domain>[-<location>]-<env>` place definition is **ours**: SCP-specific, not inherited from Kargo. Do not cite Kargo for it.

**Honest status: no stage entity exists in the schema today.** There is no `stage` table and no `environment` table, and **no stage-grammar compound name such as `commercial-amer-gamma` appears anywhere in the code** (this glossary's and ADR-0021's own illustrative examples aside).

**The deferred entity question is now answered — there will be no stage entity** ([ADR-0026](adr/0026-placements-and-derived-stage-names.md)). ADR-0021 reserved the word and left "a future entity may fill it" open; that is superseded. A stage is a **derived name**, not a row: computed as `<origin domain>-[<region>-]<environment>` from a `deployment-target` carrying [ADR-0017](adr/0017-ownership-refinement.md) §3's `environment` and optional `region` properties, with the domain segment read from the object's `origin_domain_id` — never from the local instance, or a replicated target would derive two different names. The domain segment is not stored anywhere because a security domain is **ambient** (see that entry). Nothing about the D6 grammar changes; what changes is that the thing filling it is a computation over an existing type rather than a new one.

Two consequences worth stating plainly. **`environment` is not subsumed** — it remains a property on the place-role deployment-target, and is the last segment of the derived name; the missing `environment` entity stays missing, but now has a de facto home. And **not every deployment-target is a stage**: only those carrying `environment` derive a name, exactly the membership convention `regional-executors.ts` already uses to leave plain targets alone.

#### The in-tree misuses, by sense

The word **was** used for the **wave** sense in the shipped `/v1` contract (both halves have since landed; the names below are the pre-rename ones, kept so the history is legible), not only in UI labels. The misuses sort into five groups — (a), (b) and (c) are three different surfaces of the same **wave** sense, and (d) and (e) are two further senses entirely. They are described below so a reader knows what to expect on opening a file; the **complete site roster** and the **re-runnable measurement behind it** live in [ADR-0021](adr/0021-terminology.md) — [census snapshot §B](adr/0021-terminology.md#b-stage--the-whole-word-census) for the command, the commit and the figures, Consequences (iii) for the file-by-file scope of the two follow-on PRs. The ADR is authoritative: where a roster appears in both documents, correct it there first and mirror it here. **Status: follow-on (iii-a) has landed** — groups (b), (c) and (e) are fixed, group (d) is fixed except the CI-pipeline-phase sites (see (d) below), and group (a) was the breaking `/v1` half, (iii-b) — now landed.

**(a) The service-board `stage` = wave chain — was in the `/v1` contract; RENAMED by (iii-b).** `packages/schemas/src/services.ts:25` says it outright: *"One pipeline stage of a component's latest change = one compiled wave"*. The names are `ServiceBoardStageSchema` and `ServiceBoardRow`'s `currentStage` / `stages`, shipped on `GET /api/v1/services/:idOrUrn/board` (`apps/server/src/routes/services.ts`), re-exported from `packages/sdk/src/index.ts`, regenerated into `packages/sdk/src/generated/types.gen.ts` and `sdk.gen.ts`, committed in `tools/openapi/openapi.v1.json` (including its `required` list), projected by `apps/server/src/coordination/service-board.ts` and consumed by `apps/web/src/routes/service-board.tsx`. That last file is where the mislabelling shows most plainly: its `StageStrip` gives the badge a `board-stage-badge` test id while captioning it from the **wave** index — `Wave ${s.waveIndex}` in the tooltip, `W${s.waveIndex}` in the label. The same object is named both ways inside one function.

**(b) The change-pipeline UI — labels and test hooks only. FIXED by (iii-a).** `apps/web/src/components/pipeline/StageCard.tsx` was the misuse *as a whole file*: its docblock read *"One pipeline stage = one compiled wave"*, it took a `ChangeWave` plus a `stageNumber` prop, rendered the visible label `Stage {stageNumber}`, and carried `data-stage` plus a set of `data-testid="stage-*"` hooks. It is now `apps/web/src/components/pipeline/PipelineWaveCard.tsx` — `PipelineWaveCard` / `PipelineWaveTargetLinks` / `waveNumber` / `data-wave` / `data-testid="pipeline-wave-*"`, label `Wave {waveNumber}`. It is named `PipelineWaveCard`, not `WaveCard`, because `apps/web/src/routes/change-detail.tsx` already has a correct module-local `WaveCard` with a `wave-card` test id; the prefix keeps the two components and their test hooks distinct. Alongside it: `apps/web/src/routes/change-pipeline.tsx` (`data-testid="pipeline-stages"` → `pipeline-waves`); `apps/web/src/components/pipeline/PromotionArrow.tsx`, whose own docblock now says *"between two consecutive waves"*; `apps/web/src/routes/change-detail.tsx`; and `apps/web/src/lib/query-client.ts`. The `promotion` entry cites `PromotionArrow.tsx` for what it *draws*; what it *called* the cards it draws between was this misuse.

**(c) "per-stage version" — the same wave sense, in comments and schema docblocks only. FIXED by (iii-a), with one deliberate boundary.** Two of these files also appear under (a); there it is their *field and type names* that are in the `/v1` contract, here it is only their prose, which is why the same file can sit on both sides of the cheap/breaking split. Now "per-wave version" in `packages/schemas/src/changes.ts`, `apps/server/src/coordination/plan-service.ts`, `apps/server/src/coordination/wave-targets-repo.ts` and `apps/server/drizzle/0027_wave_target_observed_state.sql`; "per-wave image version" in `packages/schemas/src/services.ts` and `apps/web/src/routes/service-board.tsx`. **The boundary (iii-a) deliberately did not cross:** prose that *captions a `/v1` field name* — `stages`, `currentStage`, `ServiceBoardStage` — was left alone in `packages/schemas/src/services.ts`, `apps/server/src/routes/services.ts`, `apps/server/src/coordination/service-board.ts`, `packages/sdk/src/client.ts` and `apps/web/src/lib/query-client.ts`, so the prose and the field it describes never disagree. Those move with (iii-b), in the same commit as the field rename.

**(d) "stage" for a pipeline phase. PARTLY FIXED by (iii-a).** `apps/server/src/coordination/change-coordination-lock.ts` now says *"one pipeline phase earlier"*. **The CI-pipeline sites were deliberately left as they are:** `tools/openapi/check.sh` and `tools/openapi/README.md` cite "BUILD_AND_TEST.md §6 stage 3" **by name**, and that section is a table of CI *jobs* whose column header, merge policy and further citations in `.github/workflows/ci.yml` and `.github/actions/setup/action.yml` would all have to move with it. Renaming only the two `tools/openapi/` files would leave dangling citations to a section that still says "Stage 3" — strictly worse than leaving them. It is a genuinely distinct, industry-standard sense (GitLab `stages:`, Jenkins `stage()`) applied to CI jobs, where nothing can be confused with the reserved deployment-place sense. Same reasoning for the execution map in `docs/proposals/promotion-and-execution-model.md` §1. If they are ever renamed it must be one docs+CI change that moves the section heading and every citation together.

**(e) "stage" for a milestone sub-step. FIXED by (iii-a).** A third distinct sense, in two variants that needed different greps: the `M<n> stage N` form (`M2 stage 1` … `M2 stage 4`), spread across `apps/server`, `apps/web`, `packages/schemas` and `packages/sdk`; and prefix-less variants that an `M<n> stage` grep missed — `apps/web/src/routes/device.tsx`, `apps/web/src/routes/pats.tsx`, `apps/web/vitest.config.ts`. Both rosters are complete in [ADR-0021](adr/0021-terminology.md) Consequences (iii-a). All of them now say **step** (`M2 step 2`, and so on), including the three test files the non-test census filter hid. **Step, not part**, because `M2 stage 2 Part A/B/C` already spent "part" on the level below.

#### What the cleanup actually costs

**It was not "UI and docs only."** Group (a) is a **shipped `/v1` response shape**. Renaming `currentStage` / `stages` / `ServiceBoardStage` to their wave-sense names was a **breaking `/v1` change**: it altered a response body already in `tools/openapi/openapi.v1.json`, it **tripped the oasdiff additive-only gate**, and it required `pnpm gen` plus an SDK regeneration. That put it in the same cost class as the D5 `promote` → `accept` rename, not in the free tier — which is why the two were batched into one PR and one authorized exception.

The follow-on work is therefore **split in two** ([ADR-0021](adr/0021-terminology.md) Consequences, item iii):

- **(iii-a) the cheap half — LANDED** — groups (b), (c), (e) and the non-CI part of (d): UI labels, `data-testid` hooks, comments and docblocks. No API, no schema, no migration; `pnpm gen` showed no drift, which is the machine proof the contract was not touched. Genuinely cheap, as priced.
- **(iii-b) the breaking half — LANDED** — group (a): the service-board field and type names in `packages/schemas`, the `/v1` response body, the committed OpenAPI document, the generated SDK, and the server projection. `currentStage` → `currentWave`, `stages` → `waves`, `ServiceBoardStageSchema` → `ServiceBoardWaveSchema`. Breaking and oasdiff-gated, taken as an authorized exception recorded in [`tools/openapi/OASDIFF-EXCEPTIONS.md`](../tools/openapi/OASDIFF-EXCEPTIONS.md), batched with the D5 rename so one vocabulary decision cost one exception rather than two. It also confirmed D6's premise from the other direction: those fields genuinely *were* the wave sense wearing the wrong name.

**Deliberately *not* misuses — leave them alone.** Anyone re-running the grep hits these first, so they are listed in full:

- **Docker's own multi-stage-build term.** `apps/runner-scan/Dockerfile` is a genuine multi-stage Docker build (`STAGE 1 — Trivy`, `STAGE 2 (FINAL) — OpenSCAP`) — not a misuse; `apps/runner-scan/README.md` describes that same build (*"`COPY --from` a digest-pinned Trivy stage"*); likewise `packages/cosign/src/cosign-bin.ts`, `packages/cosign/src/skopeo-bin.ts`, `packages/plugin-testkit/src/runner-image.ts`.
- **The unrelated verb "staged"** — `apps/server/src/governance/scan-db.ts` ("staged payload", "staged metadata").
- **`apps/server/src/graph/named-queries.ts`**, whose hypothetical "stage-domain" is actually *consistent* with the reserved place sense.
- **The vendored `tools/openapi/bin/oasdiff-linux-amd64` binary**, which matches on byte content only.

**Not to be confused with:** *wave* (the ordering step that **contains** stages), *placement* (a component **at** a stage — the pair, not the place), *environment* and *region* (the env and location segments of a stage name), *phase*/*step* (what other CD tools call a stage).

---

### placement

**Definition.** **One component at one deployment target** — the pair that is actually deployed, observed, gated and rolled back. `agentkit-keycloak` at `prod (DOKS hosted)` is one placement; the same component at `gamma (self-host canary)` is another. A component says *what* the software is, a deployment target says *where*, and a placement is the intersection. It is what an executor binding attaches to, and what a wave target names.

A component may have many placements; a deployment target may hold many. **Neither endpoint alone can identify a deployment**, which is the whole reason the type exists — a binding must resolve both which execution system to call and which application inside it, and those are functions of different axes.

**Industry-standard?** No — SCP-specific. The *concept* is not novel: Argo CD's `Application` is the same intersection, an app bound to a destination, and an SCP binding's `external_ref` names one. The *word* is ours. "Application" was unusable because it would collide with both `component` and `service`; "instance" was the first candidate and is reserved (below).

**Not to be confused with:**

- ***instance*** — one running deployment of the SCP binary. Reserved, and the term the federation model rests on (`commander instance`, `outpost instance`). It reads naturally for this concept and must still not be used for it.
- ***stage*** — the place **alone**. A placement is a component *at* a stage.
- ***deploy / deployment*** — the per-environment **event**. A placement is the standing thing that event acts on; it exists between deployments and outlives any single change.
- ***deployment target*** — the place as an executor sees it. A placement pairs a component with one.
- **the casual sense in `apps/server/src/federation/import-repo.ts:163`**, where *"`domainId` is LOCAL PLACEMENT, not authority"* means an imported object's containment parent. Different axis entirely: where an object sits in the org tree, not where software runs.

**In the code — built.** Reserved by [ADR-0026](adr/0026-placements-and-derived-stage-names.md) D3, specified in [post-import-configuration.md](proposals/post-import-configuration.md), and shipped as object type `placement`, named `<component>@<deployment-target>`, unique on `(org_id, component, deployment_target)`, and the referent of both `executor_bindings.target_object_id` and `change_wave_targets.target_object_id` (migration 0051; `graph/placements-repo.ts`).

Today the same information is carried by **env-suffixed component pairs** — `agentkit-keycloak` and `agentkit-keycloak-prod`, which hold identical `external_ref`s and differ only in which Argo CD they point at. Those are placements wearing a component costume, and they are what the proposal's §6 migrates. Read them as evidence the concept is already load-bearing, not as a naming accident.

---

### freeze

**Definition.** A **time-windowed refusal to start work** under a scope. A freeze has a window (`startsAt`/`endsAt`), a scope, a mandatory reason, and nothing else — it holds no state machine and evaluates no expression.

**Not a policy effect.** A freeze is a first-class mechanism with its own table, its own scope column and its own override permission, *not* a species of the CEL policy model. DESIGN.md §10.4's Decision `kind` enum lists `policy` and `freeze` as coordinate kinds. (Text in §10.3 called it "a built-in policy effect" until 2026-08-23; that contradicted the enum nine lines below it.)

**Six scope tiers**, in order: **platform (instance) → org → containment domain → service → component → deployment target**. The five org-and-below tiers are graph objects resolved over the containment chain. The platform tier is instance-scoped and addressed differently — see `platform-tier freeze`.

**It refuses to start; it cannot stop.** `ExecutorPlugin` is exactly `observe`/`trigger`/`status`/`abort`/`describeCapabilities` and [ADR-0008](adr/0008-observe-enrichment-signals.md) forbids adding a pause verb, so the finest grain enforceable is *"is this triggered at this place at all"*. **A freeze declared while a target is already executing does not pause it** — SCP watches it finish. Any copy promising otherwise is promising something the interface cannot express.

**Per target, not per wave.** A freeze covering one of four regions holds that region and admits the other three, unless declared `atomic` (see `per-target admission`).

**Override** needs `freeze:override` **at that freeze's own scope**, held individually for *every* active freeze covering the target, plus a mandatory reason. Checking only the first match was a shipped bug.

**Not to be confused with:** a *campaign deadline lock* (scoped to one campaign's own targets, not a scope-wide refusal); a *pinned* or *frozen* dependency version (an unrelated sense of the word); a *hold* from a stage dependency (same per-target mechanism, different cause).

**In the code.** `freezes` and `instance_freezes` in `apps/server/src/db/schema.ts`; resolved by `governance/freeze-scope.ts`'s `freezesByTarget`; enforced at `governance/gate-orchestrator.ts`'s `checkFreeze` and, per target, at `coordination/freeze-hold.ts` + the reconciler's trigger loop. DESIGN.md §10.3.

---

### platform-tier freeze

**Definition.** A freeze declared by the **deployment's operator**, binding **every organization** hosted on that instance. Stored in `instance_freezes` — no `org_id`, operator-write / tenant-read (the DESIGN.md §4.2 exception).

**Addressed by stage coordinate, never by object id.** It matches `properties.environment` and optionally `properties.region` on a deployment target, because no object id exists across organizations. Deployment-wide is an explicit flag: leaving the environment unset does **not** mean "everywhere", so the widest blast radius cannot be reached by omitting a field.

**Not overridable by any tenant role**, however privileged — that asymmetry is the point of the tier. The authoring operator may mark one `overridable`, admitting override at the org root under the same mandatory-reason rule.

**Merges by UNION, not MIN.** Unlike ADR-0016's scan floors (a threshold, merged per-severity minimum), a freeze is a predicate: the verdict is the OR of every applicable window. Hence one above-org rung here where scan requirements have two — a second rung would be indistinguishable.

**Does not federate, under any decision.** The sync journal is org-scoped at every layer and a platform freeze has no `org_id`. It is per-instance operator config, distributed by deployment tooling.

**In the code.** `instance_freezes` (`drizzle/0086`), `governance/instance-freezes-repo.ts`, `routes/instance-freezes.ts`. [ADR-0040](adr/0040-platform-tier-freezes.md).

---

### per-target admission

**Definition.** The wave-boundary property that a freeze covering **one** target holds that target and **admits its siblings** — a wave deploys to three of four regions when only one is frozen.

**A granularity, not a scope model.** Nothing about *what* a freeze covers changed; what changed is whether the answer is computed once for a whole wave or once per target.

**Why it could not be the wave gate.** `evaluateWaveGate` issues one verdict for the whole wave with no target dimension, and fires exactly once on `pending → running`, so it could not re-evaluate a freeze declared mid-wave even if it were per-target. Enforcement is therefore a refusal to trigger in the reconciler's per-target loop, following [ADR-0028](adr/0028-stage-scoped-component-coupling.md)'s stage-dependency hold. The whole-wave block survives for the all-frozen case.

**`atomic` opts out.** A freeze declared atomic holds every target in any wave it touches. It **defaults to false**, so per-target admission is the default behaviour — which means shipping it *loosened* every freeze already authored on an estate.

**In the code.** `coordination/freeze-hold.ts` (the predicate), the `continue` before `triggerWaveTarget` in `coordination/reconcile.ts` (the actuator), and the `partiallyFrozen` guard in `governance/gate-orchestrator.ts`. [ADR-0039](adr/0039-per-target-freeze-admission.md).

---

### campaign

**Definition.** A graph object that `coordinates` many member Changes across many targets, with its own plan and waves over the same machinery a Change uses. One intent, many targets.

**Its status is derived, never stored.** There is no campaign state machine mirroring `ChangeState`; status is aggregated from its waves and member changes on read.

**Fan-out mints real Changes.** Each campaign wave target becomes an ordinary Change with exactly one target, linked by a `coordinates` relationship, which then runs the completely unmodified change lifecycle — so per-target governance works after fan-out as a side effect of one-target-per-change.

**Not to be confused with:** an *initiative* (a grouping above campaigns, removed 2026-08-10); a *change* (a campaign's member, not a synonym).

**In the code.** Object type `campaign`; `campaign_plans` / `campaign_waves` / `campaign_wave_targets`; `coordination/campaign-reconcile.ts`. DESIGN.md §9.5.

---

### coordination lever

**Definition.** A campaign **recipe**: *one* authored trigger intent, fanned across N components, wave-ordered, gated, with per-component binding resolution, explainability and rollback. It is what "1-click migration" means here.

**It is not an authoring lever, and that is the whole distinction.** **CommanderSCP never writes the patch.** The recipe *triggers*; the tenant's own workflow performs the edit. A tenant with no such workflow has nothing to trigger, and the honest outcome is a refusal rather than a managed migration. No charter amendment was sought for it, because none is needed — this is charter principle 1 unchanged (owner decision D3, 2026-08-23).

**What crosses to the executor.** The recipe's `trigger.parameters` bag, **verbatim**, through `TriggerIntent.parameters` — a channel that was already on the executor interface and already read by every adapter, and which the generic release path had simply never populated. There is **no cross-provider translation**: a recipe written in `github` keys is never guessed into `gitlab` shape, because a wrong guess does not fail — it triggers the *wrong automation* in the tenant's own repository.

**Three refusals, and `trigger()` is never called on any of them:** the bound executor cannot serve the recipe's kind; the recipe does not parse (a malformed recipe is a **refusal, never an absence** — degrading to "no recipe" would roll a bare sync at every target and report a migration that never happened); or the target is bound to one of CommanderSCP's **own** managed actuators, which a recipe may not drive while OQ-5 is unruled.

**Not to be confused with:** a **campaign deadline lock** (a per-target admission gate, not a trigger); the dependency-subscription actuator (which *does* write to tenant repositories, under a separate and narrower charter grant).

**In the code.** `campaign.properties.recipe`; `packages/schemas/src/campaigns.ts`; `coordination/campaign-recipe.ts` (the read side); `governance/campaign-recipe-guard.ts` (the author's door, installed at the `graph/objects-repo.ts` choke point so it covers all three write doors, not just the typed route). [ADR-0041](adr/0041-campaign-recipes.md).

---

### adoption evidence

**Definition.** The source a campaign recipe **names** for the question *"has this component migrated yet?"*. Three kinds ship: `delivered` (this campaign's own wave target succeeded), `dependency` (the component's ingested manifests place it at or above a version floor), `control` (a governed control run passed).

**Absent evidence is `unknown`, never `adopted`.** This is the whole point of the term, and it is `boundary-segment.ts`'s honesty rule R3 — *silence is never a pass* — applied to migration. CommanderSCP cannot know in general whether a component has been migrated; a recipe that names no evidence gets `unknown`, and so does one whose evidence cannot be read.

**The distinction that carries the rule.** A component with **no dependency inventory rows at all** is `unknown` — never ingested is a fact about *CommanderSCP*, not about the component. A component whose manifests **have** been ingested and simply do not declare the coordinate is `adopted`. Collapsing those two is precisely the silence-as-pass failure, and they are the two cases most easily conflated.

**`delivered` is not `migrated`.** It means SCP triggered the tenant's pipeline and the change was accepted — not that the code changed. The verdict string says `delivered` for that reason.

**Positive evidence of non-adoption outranks an indeterminate sibling.** One manifest pinning below the floor and another declaring an open range reads `not_adopted`: the range tells us nothing, the pin tells us something, and *"we cannot tell"* must not dilute a fact we can.

**`declared` is deliberately not shipped.** A fourth, self-attested kind is designed and withheld pending an owner ruling (OQ-6): the beneficiary of *"I have migrated"* is exactly the party a deadline exists to coerce, writing at plain `object:write` on their own component. Its absence is a decision, not an omission.

**In the code.** `coordination/campaign-adoption.ts` — read-time, no stored status column, no scheduler. `GET /api/v1/campaigns/{id}/adoption`. [ADR-0041](adr/0041-campaign-recipes.md).

---

### campaign deadline lock

**Definition.** A per-(campaign × target) admission gate. Past a date, a target this campaign cannot observe as migrated stops receiving **this campaign's** changes.

**Its radius is the campaign, and that is the whole distinction.** Unrelated releases — **including security fixes** — keep flowing to that component. It is **not** a freeze on the component, and it is not a pipeline lock: a freeze at that component's scope would stop the laggard shipping *anything*, which turns a migration deadline into an outage of that team's ability to patch. Owner decision D4 excludes it explicitly.

**Nothing is ever written to mean "locked".** The lock is a read-time predicate re-derived every tick from `(deadline.at, adoption)`, which is what lets a late adoption, a moved deadline or a cleared one release it **with no unlock verb**. The deadline itself is *configuration*, not status — campaign status stays derived.

**`unknown` locks.** Only `adopted` releases a target. That is the mirror of **[adoption evidence](#adoption-evidence)**'s rule: if silence is never a pass, then a target whose migration cannot be observed is still one the deadline applies to — otherwise the deadline evaporates for exactly the components least visible to the platform.

**Call it a tripwire, not a lock.** Under the `delivered` signal it is very nearly a no-op, because a target is only a candidate while `pending` — meaning the campaign never reached it. It acquires force with evidence observed *outside* the campaign's own fan-out, or as the durable signed record that "component X missed campaign Y's deadline on date Z".

**Not to be confused with:** a **[freeze](#freeze)** (scope-based, time-windowed, blocks everything in scope); a **coordination lever** (the recipe that triggers, not a gate that refuses).

**In the code.** `coordination/campaign-deadline-lock.ts` (the predicate), the `continue` before `proposeChange` in `coordination/campaign-reconcile.ts` (the actuator), `POST /api/v1/campaigns/{id}/deadline` and `scp campaign deadline` (set / move / clear — the exit). [ADR-0042](adr/0042-deadline-triggered-campaign-lock.md).

---

### wave

**Definition.** One ordered step of a **compiled plan**: **the set of one-or-more stages advanced at once**, and the targets within them. Wave order is computed from graph `depends_on` edges (topological sort with cycle rejection) plus explicit coordination rules such as "infrastructure before application". Waves sharing an index run in parallel (fan-out); a fan-in gate requires every target of the previous wave to have succeeded.

**A wave contains stages.** This is the load-bearing relationship, and it is **containment, not rivalry** — a wave is a *step*, a stage is a *place*, and one step advances one or more places. The two words were never competing for the same meaning; "stage" was simply being used *for* the wave sense by mistake (see the `stage` entry's misuse breakdown).

The owner's worked example, in the canonical stage grammar:

| Wave | Stages advanced |
|---|---|
| Wave 1 | `commercial-amer-gamma` |
| Wave 2 | `commercial-amer-prod` |
| Wave 3 | `commercial-apac-prod` **+** `govcloud-amer-prod` |

Wave 3 is the important row: **one wave, two stages, two different security domains.**

**Consequence — the CDS gate applies per crossing, not per wave.** Because a single wave may hold stages in *different* security domains, advancing one wave can be an ordinary promotion for one of its stages and a **cross-domain promotion** for another. In Wave 3 above, `commercial-apac-prod` is an ordinary intra-domain promotion while `govcloud-amer-prod` crosses `commercial → govcloud` and must therefore satisfy the full CDS supply-chain gate (digest-bound scan, cosign-signed promotion manifest, verify at every hop). **The gate is evaluated per boundary crossing, not once for the wave.** A wave is not "cross-domain" or "not cross-domain" as a unit; each stage in it is judged on its own crossing. See `cross-domain promotion`.

Waves are the ordering primitive SCP actually has. In a federated release topology, the waves are commonly aligned with domains — commercial → FedRAMP → IL5 → air-gapped — and each wave's gate is the target domain's own local gate outcome, reported back via the journal (DESIGN.md §13). Note that this alignment is a common *shape*, not a rule: as Wave 3 shows, a wave may straddle domains.

**Industry-standard?** No — SCP-specific, though the shape rhymes with a Spinnaker deployment stage sequence or an Argo Rollouts step list.

**Not to be confused with:** *stage* (a place, which a wave **contains** — per D6). The UI and the service-board `/v1` response currently mislabel waves as stages — see the `stage` entry's misuse breakdown.

**In the code.** The `change_waves`, `change_wave_targets` and `campaign_waves` tables in `apps/server/src/db/schema.ts`; compiled by `apps/server/src/coordination/plan-compiler.ts`; DESIGN.md §9.3. There is **no stage table** — a wave's "stages" are implicit in its targets today.

---

### change

**Definition.** The coordinated unit of work — a graph object with a projection row carrying an explicit, table-driven lifecycle state machine. A change targets objects, compiles into a plan of waves, passes gates, and terminates in success (`accepted`), `cancelled`, or `rolled_back`.

**A change is also a release** (see `release`) — same thing, two vocabularies for two audiences: *change* is what the engine calls it, *release* is what a delivery engineer calls it.

**Lifecycle.** `proposed → evaluated → coordinated → executing → validating → accepted`, with an optional `coordinated → waiting → executing` detour when cross-change prerequisites are outstanding, `cancel` legal from every pre-acceptance state, and `rollback` legal once something has actually executed. The code spells the terminal state `accepted` — see the `accept` entry.

Every transition goes through **one guarded transition function** that atomically checks the gates bound to that edge, writes the audit event, and writes the Decision record. That single funnel is what makes explainability cheap rather than aspirational (DESIGN.md §9.1).

**Industry-standard?** SCP-specific in this precise form. The ITIL sense of "change" (a change request under change management) is the closest cousin and is not wrong — but SCP's change is a coordination object with a compiled plan, not a ticket.

**In the code.** `apps/server/src/coordination/changes-repo.ts`, `apps/server/src/coordination/transitions.ts`, `packages/schemas/src/changes.ts`, `apps/server/src/routes/changes.ts`.

---

### pipeline

**Definition.** The ordered path a release travels for **one executor Type** — build → registry → config → gamma → prod for a software pipeline; plan → gate → apply for an infrastructure pipeline. Because a change carries exactly one Type ([ADR-0007](adr/0007-executor-binding-type-taxonomy.md)), **one change drives one pipeline**; work spanning two pipelines is two changes, chained with `provides`/`requires`.

**Industry-standard?** Yes, in the ordinary CI/CD sense. What is SCP-specific is the one-change-one-pipeline rule and the Type-based routing.

**Not to be confused with:** a Jenkins/GitLab pipeline *definition file* — SCP does not own or author pipeline definitions; it coordinates the execution systems that do. Coupled pipelines (build → config → deploy across changes) are a **chain** of pipelines, not one pipeline.

**In the code.** `type?: ExecutorType` on the change (`apps/server/src/coordination/changes-repo.ts`), `apps/server/src/coordination/coupling.ts` for the cross-change chain, and the pipeline views under `apps/web/src/components/pipeline/`.

---

### artifact

**Definition.** The immutable built thing, identified by **digest**: an OCI image, an rpm/deb/npm/Maven/Helm package, a config bundle, an infrastructure plan, or an SBOM. Promotion is defined by artifact identity — the same digest advances.

**Industry-standard?** Yes; digest-addressed artifacts are the shared vocabulary of OCI, JFrog, and every SLSA-aligned supply chain.

**Not to be confused with:** a **bundle** (see below — a bundle is a transport container, not a built thing); a CI "build artifact" in the loose sense of any file a job uploads.

**In the code.** Digests thread through the gate context as `artifactDigest` (`apps/server/src/governance/gate-orchestrator.ts` `buildControlContext`); bytes travel on the channel designed in [ADR-0019](adr/0019-artifact-byte-channel.md); verification is `apps/server/src/federation/artifact-verify.ts`.

---

### configuration as code

**Definition.** Declarative configuration and infrastructure kept in a **git repository** and released through a
pipeline like any other artifact, rather than applied by hand to a running system. In SCP it names a **class of
release content**, not a mechanism — the same waves, gates, controls, Decisions and executor bindings apply to it
as to an image.

The term matters here because a large share of it is **domain-local**: a security domain's VPC layout, route
tables, transit-gateway attachments, security-group rules and per-domain Kubernetes configuration have **no
upstream original to promote from** — they are authored, reviewed and deployed inside one domain, and that domain
is their source of truth ([ADR-0031](adr/0031-domain-local-objects-never-federate.md)). Configuration as code is
**not** inherently domain-local, though: shared configuration promoted from a commander-hosted repo is the same
class of content travelling the ordinary cross-boundary path.

**Scanning — state the reason precisely.** Domain-local configuration as code is not subject to the **scan gate**,
and the reason is the **path, never the location**: it crosses no security-domain boundary, so there is no
crossing to authorize (see **scan gate**). *"It is at an outpost"* is **not** the reason and must never be written
as one — an outpost builds and promotes plenty that **does** require a passing, digest-bound scan, since build
devolves to the **originating** outpost ([ADR-0017](adr/0017-ownership-refinement.md) §2). The separate, optional
**local** scan Control ([ADR-0016](adr/0016-scoped-scan-requirement-policies.md)) is **off by default** and stays
available: a domain that wants its own network configuration scanned locally can attach one, and that is a quality
choice, not an authorization one.

**Industry-standard?** Yes as a term (alongside infrastructure as code / GitOps). What is SCP-specific is the
observation that a large part of it has **no single upstream source of truth** and is therefore modelled as
domain-local.

**Not to be confused with:** **IaC** in the SCP-internal sense — `scp plan`/`apply` over SCP's *own* registry
objects (`apps/server/src/iac/`), i.e. SCP's configuration managed as code, which is a different subject from a
tenant's configuration travelling a pipeline. Also not the **managed IaC executor** (`scp-managed-iac`), which is
an execution mechanism, not a content class.

**In the code.** An ordinary component whose executor binding carries a `configuration` or `infrastructure`
routing Type ([ADR-0007](adr/0007-executor-binding-type-taxonomy.md)); `executor_bindings` is unique on
`(org_id, target_object_id, type_id)`, so one component may own both at once.

---

### bundle — always qualify

"Bundle" alone is ambiguous in this repository. There are **three** distinct things:

1. **Promotion bundle** — the metadata-only export of a change toward another domain: the change object, provenance, control outcomes with evidence, artifact digests, SBOM references, and the cosign-signed promotion manifest. **It carries no artifact bytes.** The importing domain instantiates its *own* local change (state `proposed`, `imported_from_domain` set) which must pass **local** policy. Approvals travel as **evidence, never as authority**. → `apps/server/src/federation/promotion-repo.ts`, `packages/schemas/src/federation.ts`.
2. **Air-gap federation bundle** (`.scpbundle`) — the signed, checksummed tarball of hash-chained journal segments walked across an air gap by `scp federation export` / `scp federation import`. Also metadata. → `apps/server/src/federation/export-repo.ts`, `import-repo.ts`.
3. **Relay tarball** (`*-relay.tar.gz`) — the **artifact-byte** container the retrans validates and forwards across a CDS. This is the only one of the three that carries bytes. → `apps/server/src/federation/retrans-relay.ts`, [ADR-0019](adr/0019-artifact-byte-channel.md).

A fourth, unrelated sense exists in the deployment story: the **air-gapped release bundle** built by `deploy/airgap` (the installable product tarball). Say which one you mean.

**Not to be confused with:** Helm chart packaging, or "bundle" in the JavaScript build sense.

---

### security domain

**Definition.** *A domain that implements a security policy and is administered by a single authority.* Commercial, GovCloud, FedRAMP, IL5 and air-gapped are each a security domain. In CommanderSCP this is the **trust tier** — the ambient boundary a deployment lives in, above org.

The owner's framing is an AWS **partition**: like `aws` / `aws-us-gov` / `aws-cn`, a partition is ambient — every resource is born in exactly one, nothing silently crosses it, and it is not modelled as a row that groups accounts ([ADR-0016](adr/0016-scoped-scan-requirement-policies.md) §Terminology).

**Industry-standard?** Yes. The definition above is CNSSI-4009-2015's, also carried in NIST SP 800-137. NIST SP 800-53 Rev. 5 gives an equivalent resources/entities/common-policy formulation. NIST SP 800-57 Part 1 Rev. 5 adds **composability** — a security domain is a system or subsystem under a single trusted authority, and security domains may be organised (for example hierarchically) into larger domains.

**Read that composability narrowly.** SP 800-57's hierarchy is explicitly about domains *each under a single trusted authority* combining into a larger one. SCP's **commander → outpost → retrans** hierarchy is a hierarchy of **instances and roles**, and is *not* a claim that the security domains those instances sit in share a single trusted authority — they do not. The `authorization boundary` entry below depends on exactly the opposite premise: the security domains SCP federates across are **separately authorized systems by construction**, with different authorizing officials and different ATOs. Domains with different AOs are precisely the case SP 800-57 composability does **not** cover. Cite it for what it says (security domains *may* be organised hierarchically), not as a warrant for the federation role hierarchy.

**Terminology adopted 2026-07-24 (D4).** Use **"security domain"** — the NIST/CNSSI term — for the trust tier. Existing docs also say **"trust domain (partition)"**; that phrase remains valid and is not being rewritten, but "security domain" is the preferred term going forward because it is the term an accreditation reader already knows.

**Not to be confused with — bare "domain" carries six live senses: four industry ones, plus SCP's own two.** The four industry senses:

- a **DNS** domain;
- a **Windows/Active Directory** domain;
- a **DDD bounded context** ("the domain model");
- an **identity realm** — NIST's own federation literature speaks of a collection of realms (domains).

SCP adds two more of its own: the **security domain** defined in this entry (the trust tier *above* org) and the **containment domain** object type (next entry — an ordinary intra-org grouping *below* org). Four plus two is six, and that is the whole accounting; [ADR-0021 §Context 1](adr/0021-terminology.md) states it identically, so revise both together if it ever changes.

Also distinct: **SPIFFE's "trust domain"**, which corresponds to the **trust root** of a system — i.e. it is defined by a shared PKI root, whereas a *security* domain is defined by common security **policy** under one administering authority. These are different concepts and they cross-cut: two security domains can share a trust root, and one security domain can contain several. SCP deliberately does **not** use `spiffe://` identifiers; it uses `urn:scp:domain:<domainId>` in the certificate SAN URI (RFC 8141 URN, `apps/server/src/federation/mtls-enforcement.ts`), precisely to avoid taking a SPIFFE dependency. That was a deliberate choice, not an oversight.

**Bare "domain" is banned as a tier name** — in prose *and* as a stored value. [ADR-0016](adr/0016-scoped-scan-requirement-policies.md) §Terminology mandates the full forms and specifies that the floor table's tier literal is `trust_domain`, never bare `domain`; DESIGN.md does the same for the policy-resolution chain.

**In the code.** `domainId` carries **both** senses, historically with zero type-level separation. The **security/trust** sense is `federation_self.domainId`, and its uses concentrate in `apps/server/src/federation/`; the **containment** sense is `objects.domainId`, and its uses concentrate in `apps/server/src/graph/`. Both columns are declared in `apps/server/src/db/schema.ts` and both are stored as plain `uuid`.

How wide that is — how many non-test source lines and files, with the exact command and the commit it was measured at — is in [ADR-0021's census snapshot §A](adr/0021-terminology.md#a-domainid--the-two-senses-undifferentiated). It is stated there once rather than repeated here, so there is a single number to refresh.

**The fix has landed:** branded TypeScript types `TrustDomainId` vs `ContainmentDomainId` (`packages/schemas/src/domain-ids.ts`), so the collision is **uncompilable** rather than a naming convention ([ADR-0021](adr/0021-terminology.md) Consequences, item i). Brands are erased at runtime and stop at the API edge, so `/v1` and the generated SDK are unaffected.

**A third thing wore the name, and was renamed rather than branded.** `PluginContext.domainId` in the public plugin contract (`packages/plugin-api`) was neither of the two senses above — it is an opaque **plugin-host scope key**, a partition label for a plugin instance's logs, secrets and egress accounting, populated with non-uuid literals (`"default"`, `"commander"`, `"shared"`). Since it is not an id, no brand could apply; by owner decision (2026-07-24) it is now **`PluginContext.scopeKey`**, along with `PluginHostInstanceConfig.scopeKey` and the spawn env var `SCP_PLUGIN_SCOPE_KEY`. A breaking plugin-contract change, recorded in [ADR-0021](adr/0021-terminology.md) D4 and Consequences (i-b). If you see `scopeKey`, it has nothing to do with domains.

---

### containment domain

**Definition.** The `domain` **object type** in the graph — an ordinary intra-org grouping that sits **below** org in the containment chain: org → containment domain → service → [assembly] → component (the [**assembly**](#assembly) rung is optional). It is the "domain" in policy resolution and in the scan-requirement scope chain.

**`objects.domain_id` is NOT restricted to this type, and the column name misleads.** The column holds **the containment parent (any object; a domain in the common case)**. It is a bare `uuid` with **no foreign key and no CHECK** (`apps/server/drizzle/0001_graph_core.sql:32`), and `resolveContainmentParent` (`apps/server/src/graph/objects-repo.ts`) validates only that the id names an object in the same org — **no type filter**. Shipped tests deliberately pass a `service.id` and a `component.id` (`apps/server/src/governance/governance.integration.test.ts`, `apps/server/src/dependencies/subscription-authoring-guard.integration.test.ts:263`), and the RBAC / policy / freeze scope walks accept the chain that results. The `domain` object type is the *intended* occupant of the slot, never an enforced one — [ADR-0026](adr/0026-placements-and-derived-stage-names.md) measured **0 `domain`-type objects** on the live estate. Do not write a check, a doc, or a review comment that assumes a `domain` object here.

**Industry-standard?** No — SCP-specific. It is closest to a folder/organizational-unit concept.

**Not to be confused with:** the **security domain** (the trust tier above org). They are never the same thing. The `scan_requirement_floors` header comment in `apps/server/src/db/schema.ts` records the distinction explicitly — the `tier` literal is spelled `trust_domain`, *never* bare `domain`, "while the `domain` OBJECT TYPE (the containment domain…)" is the below-org grouping — and [ADR-0016](adr/0016-scoped-scan-requirement-policies.md) §Terminology exists solely to keep them apart.

**In the code.** Object type `domain`, seeded in `apps/server/drizzle/0002_rls_rbac_seed.sql`; the column a domain occupies when it *is* the containment parent is `objects.domain_id` (`apps/server/src/db/schema.ts`, which holds any object — see above); the walk is `apps/server/src/graph/containment.ts` (`containmentChain`), which is org-filtered on every join and rooted at the org root — it **structurally cannot** express any tier above org, which is exactly why the security-domain tier needed a separate instance-scoped table.

**Same branded-types caveat as above:** `objects.domainId` and `federation_self.domainId` are both bare `uuid` today.

**Owner decision (2026-08-13, [outpost-ui.md](proposals/outpost-ui.md) §5b): containment domains nest.** A **subdomain** is a `domain` object created inside another `domain` — its `domainId` names the parent domain, exactly as a service's or component's does. This was always structurally possible (`resolveDomainId` never constrained the parent's type, and `containmentChain`'s route 1 walks `child.domain_id -> parent` generically at every recursive step, domain rungs included) but unexercised before this decision; it is now first-class rather than an accident of a generic walk. **Locality inherits at create, one hop, across the domain rung like any other container** (M20.5, [ADR-0031](adr/0031-domain-local-objects-never-federate.md) §6a) — a subdomain created under a `domainLocal: true` parent domain is domain-local without saying so, and so is everything created under *it*, by the same one-hop induction the service/component rungs already rely on. Pinned in `apps/server/src/graph/nested-domains.integration.test.ts`. **This does not resolve the stage-vs-domain modeling question** — the reason the deferral existed in the first place ([ADR-0031](adr/0031-domain-local-objects-never-federate.md) parked it, and outpost-ui.md §5's own recommendation was to keep deferring). It **constrains** that question instead: whatever stage-vs-domain answer eventually lands must be compatible with domains nesting. A parent-domain picker on the domains registry's create form (`apps/web/src/routes/registry-list.tsx`) is the only new write surface this adds — an ADR records the decision once the implementation review lands, per this repo's working convention.

**One resolver does NOT walk it, and that is unrelated to nesting.** Executor-binding resolution's ancestor ladder (`apps/server/src/coordination/binding-resolution.ts`) walks the `contains` edge only — a binding declared on a `domain` object was already refused resolution before this decision ([ADR-0029](adr/0029-containment-ancestor-binding-rung.md) D2, "a binding on a containment `domain` does not resolve"), and nesting domains does not change that: there is still no rung for it to resolve through. Policy resolution (`matchPoliciesForTargets`, `containmentChain`'s route 1) and every other `containmentChain`-based walk — RBAC scope expansion, freeze scoping, the scan-requirement tier chain — DO walk the nesting, for free, with no code change, the same way they picked up the optional `assembly` rung.

---

### assembly

**Definition.** The **optional** grouping level between a **service** and its **components**. An assembly is a *macro-component*: a coherent sub-system that is built and released as a set, but is not itself the thing an organization owns end-to-end. A service made of two or three assemblies of dozens of components each is the shape this exists for; a service whose components sit directly under it needs no assembly and gets none.

**Industry-standard?** No — SCP-specific, and deliberately not a borrowed word. The alternatives considered and rejected were **subsystem** (already means a runtime tier in too many estates), **module** (taken by the executor Module axis, [ADR-0007](adr/0007-executor-binding-type-taxonomy.md)), **group** (says nothing about what is grouped), and **macro-component** (accurate but unusable in a URL or a CLI noun). "Assembly" carries the right connotation — parts fitted together into a unit that is itself a part — and collides with nothing already in this glossary.

**Optional, and only one level.** Containment is `service → assembly → component` **or** `service → component`; never `assembly → assembly`. `relationships-repo.ts` refuses the nested case outright rather than bounding it, because a depth limit is a number to argue about and a refusal is a rule. The owner's grouping decision (D2) capped the ladder at **three hops**, which one optional level cannot exceed.

**What it inherits for free — and the two places that claim was too broad.** `containmentChain` (`apps/server/src/graph/containment.ts`) matches on the `contains` **edge**, never on the parent's type, so an assembly rung is genuinely *walked* by policy resolution, RBAC scope expansion and freeze scoping with **no code change** — which is why [migration 0055](../apps/server/drizzle/0055_assembly_object_type.sql) touched no resolver.

> **Corrected 2026-08-17 (measured).** This paragraph previously included **approval scope** and **the scan-requirement tier chain** in that list. Traversal reaches both, but each has a *hardcoded rung list* the edge-generic walk does not feed:
> - **Scan-requirement tier chain.** `tierForObjectType` (`governance/scan-requirements.ts`) switches on `organization`/`domain`/`service` and falls everything else through to `component`. An assembly-anchored ceiling therefore **enforces correctly** (the merge is an order-independent MIN that ignores tier labels) and **misreports its tier**, breaking [ADR-0016](adr/0016-scoped-scan-requirement-policies.md) §5's promise that a block can name the tier that bound it.
> - **Approval scope.** `APPROVAL_SCOPE_KEYWORDS` (`governance/gate-orchestrator.ts`) has no `assembly` case, so `requireApprovals: {scope: "assembly"}` resolves to null and becomes a **permanently unsatisfiable** required approval — fail-closed, but silently inexpressible.
>
> Both are fixed under [ADR-0033](adr/0033-scan-exclusions-and-overrides.md) §5 / M22. The general lesson is the one this glossary should carry: *walking* a rung is edge-generic and free; *naming* it is not, and every hardcoded rung list is a place a new container level has to be added by hand. Binding resolution reaches it explicitly through the nearest-wins ancestor ladder of [ADR-0029](adr/0029-containment-ancestor-binding-rung.md).

**What it is not.** Not a **containment domain** (that sits *above* service and is where policy scoping is normally expressed). Not a deployment unit — an assembly is never a wave target; **placements** are still per-component. Not a release unit either: a change is per-component, and rolling "the assembly is blocked" up out of its children would need a rule nobody has chosen, so the service board shows an assembly with a **component count and a link down**, not a status.

**In the code.** Object type `assembly`, seeded in `apps/server/drizzle/0055_assembly_object_type.sql`, which also widens `contains`, `releases_via`, `owns` and `governed_by` to admit it. The type predicate is `CONTAINER_TYPES` / `isContainerType()` in `apps/server/src/graph/containment.ts` — a single place, so a future third container level lands in one edit rather than at every `typeId === "service"` in the tree. Registry at `/v1/assemblies` (`routes/typed-registries.ts`); decisions in [docs/proposals/intermediate-grouping.md](proposals/intermediate-grouping.md).

---

### authorization boundary

**Definition.** *All components of an information system to be authorized for operation by an authorizing official. This **excludes** separately authorized systems to which the information system is connected.*

**Industry-standard?** Yes — NIST SP 800-37 Rev. 2 and NIST SP 800-53 Rev. 5.

**Why it matters here.** That exclusion clause is the **strongest standards justification for why the retrans role exists**. The security domains SCP federates across are *separately authorized systems by construction* — a commercial domain and an IL5 domain have different authorizing officials and different ATOs. They are therefore outside one another's authorization boundaries, and a connection between them is not an internal system link but a cross-boundary connection requiring its own accredited mechanism. The retrans is that mechanism's SCP-side counterpart: it validates and relays, holds no local authoritative objects, originates no config, and never terminates a promotion.

**Not to be confused with:** a *security domain* (a policy/authority scope, which an authorization boundary usually but not necessarily aligns with) or a *network* boundary (a topology fact — an authorization boundary is an accreditation fact).

**In the code.** Not modelled as an entity. It is the standards rationale behind the `retrans` role (`packages/schemas/src/federation.ts`, `FederationRoleSchema`) and behind the fail-closed import checks.

---

### CDS / cross-domain solution

**Definition.** The accredited mechanism that permits information to move between security domains. CNSSI-4009 frames a CDS in terms of exactly two verbs — **access** and **transfer** — of information between different security domains; NCDSMO's accredited-product taxonomy correspondingly splits **transfer**-CDS from **access**-CDS.

**Industry-standard?** Yes — CNSSI-4009, and the NCDSMO product taxonomy built on it.

**SCP is not a CDS.** SCP coordinates *around* one. The CDS is the customer's accredited guard; SCP's retrans role sits **beside** it, validating what it hands over and what it receives.

**Not to be confused with:** the **retrans** (SCP's own role at the boundary — see next entry) and with **cross-domain promotion** (the SCP operation that traverses a CDS).

**In the code.** `apps/server/src/federation/retrans-relay.ts`; the design is [ADR-0019](adr/0019-artifact-byte-channel.md) §2 and `docs/proposals/airgap-cds-validate-promote.md`.

---

### retrans

**Definition.** The SCP federation role (short for *retransmission*) that sits at a CDS boundary. It deliberately does much **less** than an outpost: it validates — signature and hash-chain verification, cosign-verify of artifacts and manifest, the same fail-closed checks as any import — and then relays onward through the CDS. It **never** originates config, **never** holds local authoritative objects, and **never** terminates a promotion. A store-and-forward validation relay, nothing more.

**Industry-standard?** No — SCP-specific, introduced by [ADR-0004](adr/0004-service-naming-commander-outpost-retrans.md).

**Not to be confused with:** an **outpost** (which does hold local authoritative objects and does terminate promotions), and the **CDS itself** (the customer's accredited guard — the retrans is SCP's counterpart beside it, not the guard).

**In the code.** `FederationRoleSchema` in `packages/schemas/src/federation.ts`; `apps/server/src/federation/retrans-relay.ts`; migration `apps/server/drizzle/0020_commander_outpost_retrans.sql`.

---

### commander

**Definition.** The federation role designating the single instance that is the **source of truth for global configuration** — the domain registry, org structure, global policies, release topologies, and campaign definitions. The charter's Global Coordination Layer. It also owns the **cross-boundary gate**: it consumes the scan verdict and cosign-signs its own promotion manifest.

The commander **never runs build** ([ADR-0017](adr/0017-ownership-refinement.md) §2) and **never dials an outpost** for data (see `poke` for the one narrow, opt-in, contentless exception).

**Industry-standard?** No — SCP-specific. It replaced `parent` in [ADR-0004](adr/0004-service-naming-commander-outpost-retrans.md).

**Not to be confused with:** an "instance" (a commander is a *role* a running instance is configured into — same binary, same image, same chart) and a "control plane" in the Kubernetes sense.

**In the code.** `federation_self.role = 'commander'` (the `federationSelf` table in `apps/server/src/db/schema.ts`); set explicitly by `scp federation init --role commander`, never inferred.

---

### outpost

**Definition.** The federation role for a per-domain / per-environment instance — `commercial-amer`, `commercial-apac`, `federal`, `airgap-1`. An outpost is **authoritative for its own local objects** (local services and components, deployment targets, changes, control outcomes, approvals, audit segments) and holds commander-origin config as a **structurally read-only replica**: it may layer stricter local policy on top, never weaken it. It reports status upward, which is what gives the commander its cross-domain view.

Outposts remain **fully operational when disconnected** — federation enhances operation, it is never required for it. Build execution devolves to the **originating** outpost ([ADR-0017](adr/0017-ownership-refinement.md)), and the receiving outpost **always validates before deploying** — commercial included ([ADR-0011](adr/0011-universal-outpost-validation.md)).

**Industry-standard?** No — SCP-specific. It replaced `child` in [ADR-0004](adr/0004-service-naming-commander-outpost-retrans.md).

**Not to be confused with:** a **region** (an outpost may serve several) and a **containment domain** (an intra-org grouping, nothing to do with deployment topology).

**In the code.** `FederationRoleSchema` in `packages/schemas/src/federation.ts`; `federation_self.role = 'outpost'`.

Every outpost is exactly one of the following two (owner decision, 2026-08-17 — [ADR-0021](adr/0021-terminology.md) D7). The split is **trust-domain topology**, not connectivity: whether the outpost is reachable over mTLS, disconnected, or air-gapped is a separate axis (transport / poke mode) and says nothing about which of the two it is.

**HQ outpost**

**Definition.** The outpost in the **commander's own trust domain** — the "commander and outpost are one and the same" case ([docs/proposals/pipeline-substrate-registry-scan.md §10.5](proposals/pipeline-substrate-registry-scan.md), where it was first called the *co-located outpost*). Every deployment target is part of *some* outpost, and the commander's own targets are part of this one. It is **commander-declared**: an outpost-role instance never authors its own record — it arrives replicated. There is **no peer row** behind it: nothing syncs to or from it, it has no transport and no poke-mode.

**In the code.** The `outpost` object whose `properties.peerDomainId` is this instance's own domain (`federation_self.domainId`); on the wire `OutpostConfig.peerIsSelf === true` and `FederationStatusResponse.selfOutpost` (`packages/schemas/src/federation.ts`); accepted by `apps/server/src/federation/outpost-binding.ts` only when `federation_self.role` is `commander`. The review fixture (`scripts/seed-review-fixture.mjs`) names it `hq-outpost`. Wire field names, code identifiers (`coLocated`, `isSelf`) and test ids (`outpost-detail-co-located`, `config-declare-co-located`) keep their older spelling; only vocabulary and rendered copy changed.

**Not to be confused with:** the poke-mode documents' "co-located" ([ADR-0009](adr/0009-optional-poke-mode-federation.md), [docs/proposals/outpost-poke.md](proposals/outpost-poke.md)), which is the **reachability** sense — same partition, no cross-domain boundary to honor. That is a different axis: a *field* outpost can be reachable that way, and an HQ outpost always is.

**field outpost**

**Definition.** **Any** outpost in **another** trust domain — every paired federation peer of role `outpost` that is not the HQ one, whether it is connected over mTLS, disconnected, or air-gapped. Its record is bound to a paired peer, syncs down as a read-only replica, and carries the peer's transport and poke-mode settings.

**In the code.** An `outpost` object bound to a paired federation peer of role `outpost` (`federation_peers`); on the wire `OutpostConfig.peerIsSelf === false`. The review fixture names it `field-outpost`. In the CLI, `scp federation outpost list`'s `binding` column reads `hq` / `field` (`?` when an older server does not say).

**Not to be confused with:** a **retrans** (a different federation role, also a paired peer) and a **disconnected** or **air-gapped** outpost (a connectivity property some field outposts have, not a third kind).

---

### federation

**Definition.** The exchange of an append-only, hash-chained, **Ed25519-signed** Sync Journal between SCP instances. Each entry is stamped `(origin_domain, sequence, content_hash)`; per-domain monotonic cursors make replication idempotent and resumable. Two transports carry the identical journal format: **mTLS HTTPS** (always outpost-initiated) and **air-gap bundle files** walked across the gap.

**Single-writer authority:** every object has exactly one authoritative origin domain; non-authoritative copies are read-only replicas; conflict resolution is "authority wins" — no merge algorithm exists because none is needed. Where a non-owning domain must contribute, it creates an **overlay** it does own, linked by `annotates`.

**Industry-standard?** Qualified. "Federation" in the identity sense (SAML/OIDC federation between realms) is the dominant industry meaning and is **not** what SCP means — SCP explicitly does *not* do federated identity mapping; each domain keeps its own identities (DESIGN.md §13, Explicitly deferred). SCP's sense is closer to database/data federation: replicating authoritative state between independently governed instances.

**Not to be confused with:** identity federation; a service mesh; "multi-cluster" in the Kubernetes sense.

**In the code.** `apps/server/src/federation/` (journal, cursors, export/import, sync); `packages/schemas/src/federation.ts`; DESIGN.md §13.

---

### org / tenant

**Definition.** The top-level tenancy unit. An SCP **instance is multi-tenant** — one deployment hosts many orgs — and every graph object, policy and audit row carries an `orgId` under row-level security.

**One org is one federation identity.** `federation_self` is keyed per-org (`orgId` primary key, `domainId` unique), so a deployment hosting N orgs mints N domain identities.

**Honest open question.** Whether "one outpost deployment per domain, hosting multiple related orgs" ([ADR-0017](adr/0017-ownership-refinement.md) §1, a *deployment-layer* statement) should collapse to **one federation identity per deployment** is a genuine, **open** federation-model question. It is flagged in [ADR-0016](adr/0016-scoped-scan-requirement-policies.md) and is **not** resolved by ADR-0017 or by this glossary. Federation identity remains **per-org** until an ADR says otherwise.

**Not to be confused with:** an *instance* (the deployment), a *security domain* (the ambient tier above org), a *containment domain* (the grouping below org).

**In the code.** The `orgs` and `federation_self` tables in `apps/server/src/db/schema.ts`. The deliberate exceptions to "every table carries `orgId`" **include**:

- `orgs` itself, and `state_transitions`;
- the nullable-`orgId` rows on `object_types` / `relationship_types` / `roles` — `NULL` marks a built-in shared across every tenant;
- **`scan_requirement_floors` (`apps/server/src/db/schema.ts`) has no `org_id` column at all** — it is the single **instance-scoped** floor table carrying the two scan-requirement tiers *above* org (platform and security domain), operator-write / tenant-read. This is the same table the `scan gate` entry and the `containment domain` entry describe; it necessarily sits outside org scoping because the org-rooted `containmentChain` structurally cannot reach above org;
- **`device_auth_requests.orgId` (`apps/server/src/db/schema.ts`) is nullable** — a device-authorization request exists before any org is known and the column is *"set on approval"*. A partial exception rather than a full one.

This list is the set known at time of writing; treat "every table carries `orgId`" as the rule and check the schema before asserting a given table is or is not an exception.

---

### instance

**Definition.** One running deployment of the SCP binary — API process plus worker, one Postgres. **One binary, roles not products:** an instance becomes a commander, an outpost or a retrans purely by configuration (`scp federation init --role …`). Same image, same Helm chart, same upgrade path.

An instance is **multi-tenant** (many orgs) and lives in exactly **one** security domain.

**Industry-standard?** No — ordinary English, but worth pinning because "instance", "domain", "outpost" and "org" get used interchangeably in conversation and they are four different things.

**Not to be confused with:** an *org* (a tenant inside an instance), a *security domain* (the tier the instance sits in), a role name (`commander` is what an instance *does*, not what it *is*).

---

### region

**Definition.** A geographic locality **within** a security domain — `amer`, `apac`, `emea`. Regions are a deployment/locality axis, entirely orthogonal to trust: `commercial-amer` and `commercial-apac` are two regions of one security domain.

**Industry-standard?** Yes — the cloud-provider sense (AWS/Azure/GCP regions), which is exactly how it is used here.

**Not to be confused with:** a *security domain* (a policy/authority boundary; regions do not cross it) or a *partition* (which in AWS terms is the *domain* analogue, not the region analogue — `aws-us-gov` is a partition; `us-gov-west-1` is a region inside it).

**In the code.** Regions are not a table; they appear as deployment-target attributes and executor bindings. One outpost owns Argo CD per region for a prod environment ([ADR-0017](adr/0017-ownership-refinement.md) §3; `apps/server/src/coordination/multiregion-argocd.integration.test.ts`).

---

### executor

**Definition.** A plugin implementing the executor interface against an execution system. Executors get exactly four verbs — **observe / trigger / status / abort** — and the platform holds no credentials to the infrastructure those systems manage (charter principle 1).

Each executor binding carries a **Type** ([ADR-0007](adr/0007-executor-binding-type-taxonomy.md)) — `build` / `infrastructure` / `configuration` — which is what routes a change to the right pipeline.

**The two scoped exceptions**, both pre-authorized at charter level: `scp-managed-iac` (trivial IaC releases for pipeline-less orgs, ephemeral containers, vaulted scoped credentials) and the proposed `scp-runner-ops` (host-reaching Ansible from a closed, cosign-signed task catalog, never arbitrary shell). A third managed component, `scp-managed-scan`, runs the commander-side promotion scan ([ADR-0020](adr/0020-first-class-commander-scanning.md)).

**Industry-standard?** No — SCP-specific. Closest analogues are Backstage's "actions" and Crossplane's "providers", neither of which is a good match.

**Not to be confused with:** an **execution system** (the external thing itself — see next entry) and a **control plugin** (which produces gate evidence, not execution).

**In the code — read the allowlist, not the directory listing.** The authoritative set is `KNOWN_EXECUTOR_MODULES` in `apps/server/src/coordination/executor-bindings-repo.ts`, which is exactly `fake-executor`, `github`, `gitea`, `gitlab`, `argocd`, `terraform`, `managed-iac`, `managed-scan` — eight modules, and a wave target may not be bound to anything outside it. Bindings live in the same file.

`packages/plugins/` is **not** that list: it also holds control, auth, notify, discovery and change-source plugins (`scan-result-control`, `webhook-control`, `local-auth`, `oidc`, `smtp-notify`, `webhook-notify`, `federation-https`, the shared `git-provider-core`). **`harbor` is one of these non-executors, not an executor** — its own header says so: a container registry is a passive artifact **store** SCP observes, so `@scp/plugin-harbor` is a webhook **change-source** with *"no `ExecutorPlugin`, no `GitProviderAdapter` (no trigger/observe/status/abort/verify), no manifest, no `KNOWN_EXECUTOR_MODULES` entry."* It has none of the four verbs, which is the definition above, so it cannot be an executor.

---

### execution system

**Definition.** The registered **external system** an executor talks to: a specific Argo CD, a specific GitHub org, a specific Argo Workflows. A first-class graph object type, so the graph records *which* Argo CD a binding points at and the UI can deep-link into it.

**Industry-standard?** No — SCP-specific, introduced with the Mode A "import your existing executors" work.

**Not to be confused with:** the **executor** (SCP's plugin *for* that system) and the **deployment target** (the place inside that system an executor acts on).

**In the code.** Object type `execution-system`, seeded in `apps/server/drizzle/0019_execution_system.sql`; its `serverUrl` is the deep-link base the UI uses (`apps/web/src/components/pipeline/PipelineWaveCard.tsx`).

**A registry is an execution system too — reached by an edge, not a binding.** The image registry a component's built artifact lands in (Gitea by default, [ADR-0012](adr/0012-registry-consolidation.md); `harbor`/`ecr` equally) is an `execution-system` object of that `kind`, and the component names it with the built-in relationship type **`publishes_to`** (`component` → `execution-system`, `many_to_many`, edge property `repository` = the path inside the registry, e.g. `acme/checkout-api`; migration `0069_target_facet_and_publishes_to.sql`, [pipeline-substrate-registry-scan.md](proposals/pipeline-substrate-registry-scan.md) §9.2). It is deliberately **not** the `image` executor binding: a binding's Type is *which pipeline it drives* ([ADR-0007](adr/0007-executor-binding-type-taxonomy.md)), so the image binding names what *builds* the artifact, never where it is pushed — and a registry-kind system cannot be bound at all. A registry is created `domainLocal: true` at each site; an edge with a domain-local endpoint never journals (M20.3), so each site's pipeline shows only its own registry — *one registry per domain by construction*, with `>1` edges projected honestly as `ambiguous` rather than picked.

---

### coordination, not execution

**Definition.** The charter's first non-negotiable principle: CommanderSCP **does not** build, test, scan, sign, provision, or deploy anything itself. Every phase runs on a coordinated execution system — bundled or bring-your-own — and SCP triggers it, observes it, gates it, and consumes its results as evidence.

Two scoped execution exceptions exist, both pre-authorized by owner decision and both behind the same executor interface, in ephemeral containers, with vaulted scoped credentials: **`scp-managed-iac`** (2026-07-08) and the proposed **`scp-runner-ops`** (charter amendment 2026-07-12). A third managed component, **`scp-managed-scan`**, runs the commander-side promotion scan step ([ADR-0020](adr/0020-first-class-commander-scanning.md)).

Where this bites the vocabulary: the commander **cosign-signs only its own promotion manifest** — never an origin artifact and never the SBOM. The *executor* signs those, at build ([ADR-0015](adr/0015-cosign-cross-boundary-signing.md) §5).

**Not to be confused with:** "orchestration". SCP deliberately does not orchestrate progressive delivery — canary, analysis and promote happen inside Argo Rollouts, and SCP mirrors them via `observe()`.

**In the code.** `docs/proposals/promotion-and-execution-model.md` §0 is the canonical statement; `apps/server/src/coordination/observe.ts` and `reconcile.ts` are the loop.

---

### scan gate

**Definition.** A **boundary-crossing authorization gate** whose evidence is a vulnerability-scan verdict bound to an artifact **digest**. It exists to authorize a cross-domain promotion — it is deliberately **not** a general code-quality gate.

Two consequences follow directly from that framing and are load-bearing:

- **Domain-local artifacts are never scanned** — they never cross a boundary, so there is nothing to authorize.
- **Receivers never re-scan** — they trust scan-at-source and verify signatures instead. Outposts stay light by design.

Pass-criteria are **scoped, most-restrictive-wins** over six tiers — platform → security domain (trust domain / partition) → org → containment domain → service → component — resolved as a per-severity MIN, which is order-independent. A child scope may only **tighten** ([ADR-0016](adr/0016-scoped-scan-requirement-policies.md)).

**Industry-standard?** SCP-specific as a *gate framing*. The mechanism (Trivy verdicts, severity thresholds) is entirely conventional; what is ours is treating the scan as boundary **authorization** rather than quality.

**Not to be confused with:** a CI security scan (a quality gate inside someone else's pipeline — SCP can consume its evidence, but that is an alternate ingress, not the gate itself).

**In the code.** `packages/plugins/scan-result-control/`, `apps/server/src/federation/promotion-scan-step.ts`, `apps/server/src/governance/gate-orchestrator.ts` (`buildControlContext` threads `artifactDigest`).

---

### manifest

**Definition.** The **promotion manifest**: the commander-signed enumeration of *exactly* the artifacts authorized to cross a boundary. Its job is the "**nothing slipped in**" guarantee — a receiver verifies that the arrived set matches the signed set, with no additions and no substitutions.

The commander cosign-signs **only** this manifest. The executor cosign-signs the artifacts and the SBOM, at build ([ADR-0015](adr/0015-cosign-cross-boundary-signing.md) §5).

**Not to be confused with:** an **OCI image manifest** (the registry's own descriptor document — a real collision, since SCP handles both), a Kubernetes manifest (a YAML resource file), an **SBOM** (a component inventory, not an authorization), or a **dependency manifest** (`package.json`, `go.mod`, a `FROM` line — a declaration of what a component depends on, which authorizes nothing; see that entry).

**In the code.** `PromotionManifestSchema` in `packages/schemas/src/federation.ts`.

---

### control

**Definition.** An abstract **graph object** declaring a category — security / quality / operational / compliance / custom — and a contract. **ControlPlugin implementations are bindings**, which is what makes swapping Trivy for Snyk a binding change and never a policy change.

Outcomes are standardized: `pass | fail | warning | skipped | timed_out | expired`, always with an evidence payload that Decision records reference. **Human controls** materialize as approval tasks with N-of-M quorum; a **hybrid** gate requires both a scan and a human sign-off.

**A gate** is a set of control bindings attached to a wave boundary or a lifecycle edge. A gate is satisfied when its **required** controls pass; advisory and recommended controls annotate without blocking.

**Industry-standard?** "Control" in the NIST SP 800-53 sense (a security control) is the ambient meaning in this market, and SCP's usage is compatible with it but broader — an SCP control is any pluggable check, including purely operational ones.

**In the code.** `apps/server/src/governance/controls-repo.ts`, `control-runner.ts`, `gate-orchestrator.ts`; `apps/server/src/coordination/gates.ts`; plugins `packages/plugins/scan-result-control/`, `webhook-control/`.

---

### decision

**Definition.** The persisted, explainable verdict record every engine judgement writes: kind, subject, verdict, the full **input context** snapshot (policy versions consulted, control outcomes with evidence references, graph facts, actor, time) and a structured **reason tree** rendered to human text.

Charter principle 6 makes two promises here: every engine verdict persists a Decision with its inputs, and **every blocked response carries a `decision_id`**. Because policy evaluation is a pure function (context in → verdict + reason tree out), explainability is literally the return value rather than a logging afterthought.

**Industry-standard?** No — SCP-specific. OPA's "decision logs" are the nearest cousin, but those are a logging feature; this is a first-class record written in the same transaction as the action.

**In the code.** `decisions` table (DESIGN.md §10.4), `apps/server/src/coordination/decisions-repo.ts`; the UI's "Why?" links resolve to it.

---

### poke / poke-mode

**Definition.** An **optional, per-outpost, contentless** wake signal from the commander to an outpost or retrans: *"something is pending, come pull."* The signal carries **no data**. All data continues to flow outpost→commander via pull. When poke-mode is enabled for an outpost, that outpost's frequent interval poll is disabled; it pulls on poke, backed by a sparse safety-net reconcile so a dropped poke self-heals.

**Off by default**, set per outpost (some poll-mode, some poke-mode on the same instance), authenticated by the same enrolled-commander mTLS peer identity the outpost already trusts, idempotent and rate-limited.

**The invariant, precisely restated** ([ADR-0009](adr/0009-optional-poke-mode-federation.md)): the guarantee is no longer "the commander never initiates a connection to an outpost" but rather —

> no **data** flows commander→outpost; the commander MAY send a **contentless, authenticated wake signal** to an outpost — and only where that outpost is explicitly configured for poke-mode and the topology and accreditation permit it.

The data-direction guarantee is **unchanged**; only the *triggering* direction is relaxed, and only opt-in. Regulated partitions (FedRAMP/IL) simply leave it off.

Poke reaches air-gapped domains **via the retrans chain**, hop by hop — the commander never dials the outpost directly.

**Not to be confused with:** a webhook (poke carries no payload and no state), and push-based federation (which does not exist and will not).

**In the code.** `apps/server/src/federation/poke-sender.ts`, `poke-rate-limit.ts`; per-peer flag on `federation_peers`.

---

### dependency subscription — always qualify

**Definition.** A component team's standing declaration that it follows a **major line** of one dependency, and accepts each new release on that line as an automatic code change. Carries a **granularity** (minor-and-patch, or patch-only) and a delivery mode (pull request, or auto-merge behind a governed control).

**Always spelled in full.** Bare **"subscription"** belongs to `notification_bindings` — who gets told when something happens. A dependency subscription is not a notification; it is a standing authorization to change code ([ADR-0032](adr/0032-dependency-subscriptions.md) §2).

**The enablement chain is three levels and monotone**: the instance level **unlocks and never activates**, the component team flips its own switch, and an individual dependency may be **opted out** — so the deepest level can only ever subtract. Absent never means enabled.

**Not to be confused with:** a **dependency** itself (the thing depended on), the **dependency inventory** (what a component declares, derived **on the commander** into a projection table), or `depends_on` (a **component-topology** edge feeding the wave toposort — package dependencies deliberately mint none).

**In the code.** M21 — done, on `main`. The subscription itself is a `dependencySubscription` **effect on an ordinary `policy` object** ([ADR-0032](adr/0032-dependency-subscriptions.md) §3a — amended from an earlier "new built-in object type" reading), not a bespoke object or relationship type; it federates because `policy` already does, needing no new registration (ADR-0022 clause 2). **There is no `subscribe` verb** — a team authors one through the existing policy routes (`POST /api/v1/policies`, `scp policy register`), carrying `effects: [{ dependencySubscription: { enabled: true } }]`. The inventory — `dependency_lines` + `component_dependencies` — is a separate **projection table** and does not federate (§3).

**Where it runs: the commander, only.** All dependency automation — inventory ingestion, internal release detection, the third-party version poll, the bump dispatcher and the auto-merge gate — is **commander-only** and fail-closed on an undeclared `SCP_FEDERATION_ROLE` ([ADR-0032](adr/0032-dependency-subscriptions.md) §7d, owner decision 2026-08-17). **No *field* outpost runs a dependency job or holds a dependency inventory.** The reason is what the feature is *for*: it pulls from **public** repositories (library versions, CDK versions, base-image versions), which a field outpost has no need to do, because the resulting change is **pushed down the global pipeline the commander manages** — a field outpost *receives* a dependency bump through the ordinary promotion path and never originates one. **Consequence, accepted by the owner and stated rather than implied:** dependencies declared in **domain-specific repositories** — field-outpost-only IaC/CaC the commander never sees — are **out of scope** for dependency subscriptions, as are domain-local releases at a field outpost. Note the split: the **subscription** (a `policy` object) still federates and still reaches a field outpost; only the **jobs** and the tables they write are commander-only.

> **"Field" is load-bearing here, not decoration.** This entry said "**an outpost** runs no dependency job and holds no dependency inventory" until 2026-08-17, and that is too wide in the direction that misleads: an **HQ outpost** is the outpost in the **commander's own** trust domain, so its dependency inventory simply *is* the commander's — the same rows, written by the commander's own jobs. Only a **field outpost**, one in another trust domain, is a second deployment with tables of its own, and it is the only thing the rule above is about. The distinction is read out of the code, not out of the names: `SCP_FEDERATION_ROLE` is one value per deployment, set at install, and the commander-only predicate (`apps/server/src/dependencies/commander-only.ts`) reads **that** and never an `outpost` graph object. It cannot read the object, because an `outpost` object **can** name the commander's own trust domain — that record *is* the HQ outpost, commander-declared under [pipeline-substrate-registry-scan.md §10.5](proposals/pipeline-substrate-registry-scan.md) (`peerDomainId` = `federation_self.domainId`, `peerIsSelf === true`, accepted only from a `commander`-role instance, no `federation_peers` row behind it — `federation/outpost-binding.ts`); every other `outpost` object is bound to an already-paired peer of role `outpost` and is a field outpost. So the object tells you which outpost a record describes; only the install-time role tells you what *this deployment* is — and it is the deployment the rule is about. One practical consequence: every deployment whose `SCP_FEDERATION_ROLE` reads `outpost` **is** a field outpost, which is why a refusal addressed to such a deployment says plain "outpost" and is still exact. The full **HQ outpost** / **field outpost** entries are above ([ADR-0021](adr/0021-terminology.md) D7).

---

### dependency manifest — always qualify

**Definition.** The file in a component's **own source** that declares what it depends on: `package.json`, `go.mod`, `pom.xml`, `requirements.txt`/`pyproject.toml`, a container build file's `FROM` line, or — since M21.7 — the image a chart's `values.yaml` pins ([ADR-0032 §4b](adr/0032-dependency-subscriptions.md)). That last one is the SAME `oci` dependency as a `FROM`, read out of a different file: SCP records what the component's own repository **declares**, and a values file the repository owns declares an image in exactly the sense a `FROM` does.

**Always qualify.** Bare **"manifest"** in this codebase means the **promotion manifest** — a commander-signed authorization enumerating exactly which artifacts may cross a boundary. The two have nothing to do with each other, and a dependency manifest authorizes nothing.

**Not to be confused with:** the **promotion manifest** (see `manifest`), an **OCI image manifest**, or an **SBOM** (a full component inventory including the transitive closure — a dependency manifest declares only **direct** dependencies, which is precisely why SCP can store one and deliberately does not store the other, [ADR-0013](adr/0013-supply-chain-scan-sbom-manifest.md)). A **Kubernetes manifest** used to be on this list and no longer is, exactly: a chart's `values.yaml` IS a dependency-manifest source for `oci`, while a raw `deployment.yaml` is not — not because its shape is harder (it is the easiest one) but because SCP cannot address a file whose name it cannot enumerate (ADR-0032 §4b clauses 2–3).

**In the code.** M21 — done, on `main`. Read through the `readFileAtRef` `GitProviderAdapter` hook (`dependencies/manifest-reader.ts`; [ADR-0032](adr/0032-dependency-subscriptions.md) §7a, §7c).

---

## Deprecated / avoid

| Don't say | Say instead | Why |
|---|---|---|
| bare **"domain"** as a tier name | **"security domain"** (the trust tier) or **"containment domain"** (the intra-org object type) | Six live senses: four industry ones — DNS, Windows/AD, DDD bounded context, identity realm — plus SCP's own two, the security-domain trust tier and the `domain` object type. Banned in prose *and* as a stored value: the floor table's tier literal is `trust_domain`, never `domain` ([ADR-0016](adr/0016-scoped-scan-requirement-policies.md) §Terminology; DESIGN.md's policy-resolution chain). |
| **"promotion"** unqualified when a security-domain crossing is meant | **"cross-domain promotion"** | Bare promotion is the genus and carries no boundary implication. Dropping the qualifier silently claims a CDS gate ran when it may not have. |
| **"promote" / "promoted"** for the change approval gate | **"accept" / "accepted"** | It is a human approval and a terminal success state, not an artifact advancing — the collision fights the genus/species model (D5). The code spells it `accept`/`accepted`; follow-on PR (ii) has landed ([ADR-0021](adr/0021-terminology.md) Consequences ii). |
| **"release"** meaning a single push into one environment | **"deployment"** | A release is the whole versioned unit moving through its pipeline; a change *is* a release. Also: in DoD/IC usage "release" means a **disclosure determination**, which is the last thing you want an accreditation reader to infer. |
| **"stage"** meaning a pipeline **phase** | **"phase"** or **"step"** | "Stage" is reserved for a named deployment place spelled `<domain>[-<location>]-<env>` (D6). Code comments currently misuse it, including the `M<n> stage N` milestone-substep comments and their prefix-less variants; the full roster and the cleanup are tracked in [ADR-0021](adr/0021-terminology.md) Consequences iii-a. |
| **"stage"** meaning a **wave** | **"wave"** | Same reservation — and a wave *contains* stages, so the two are not interchangeable in either direction. The misuse formerly reached the shipped `/v1` contract; **both halves have now landed** — the cheap UI/comment half (iii-a) and the breaking, oasdiff-gated `/v1` half (iii-b), which renamed `ServiceBoardStageSchema`/`currentStage`/`stages[]` to their wave-named forms. Done. |
| **"bundle"** unqualified | **"promotion bundle"** / **"air-gap federation bundle"** / **"relay tarball"** | Three different things, only one of which carries artifact bytes. |
| bare **"subscription"** for the dependency sense | **"dependency subscription"** | Bare *subscription* is already `notification_bindings` — who gets told when something happens. A dependency subscription is a standing authorization to **change code**; conflating an alert with a write is the kind of collision that reads as harmless until someone grants the wrong one ([ADR-0032](adr/0032-dependency-subscriptions.md) §2). |
| bare **"manifest"** for `package.json` / `go.mod` / a `FROM` line | **"dependency manifest"** | Bare *manifest* is the **promotion manifest**, a commander-signed authorization for a boundary crossing. A dependency manifest authorizes nothing. Two of the four other live senses (OCI image manifest, Kubernetes manifest) already share the word, so this one must be qualified on sight. |
| **"co-located outpost"** for the outpost in the commander's own trust domain | **"HQ outpost"** (and **"field outpost"** for every other one) | Owner decision 2026-08-17 ([ADR-0021](adr/0021-terminology.md) D7). "Co-located" already means *reachable, same partition* in the poke-mode documents ([ADR-0009](adr/0009-optional-poke-mode-federation.md)) — a connectivity sense, not a topology one. Vocabulary and rendered copy only: wire fields (`peerIsSelf`), code identifiers (`coLocated`) and test ids keep the old spelling. |
| **"parent" / "child"** for federation roles | **"commander" / "outpost" / "retrans"** | Removed outright, not aliased, by [ADR-0004](adr/0004-service-naming-commander-outpost-retrans.md). (The words remain correct for *process* supervision and RBAC containment walks — that is a different concept.) |

**Note on `stage`:** no `stage` entity exists in the schema today, and no stage-grammar compound name such as `commercial-amer-gamma` appears anywhere in the **code** (this glossary's and ADR-0021's own illustrative examples aside — scope the claim that way so it stays checkable after this branch merges). "Stage" is reserved vocabulary a future entity may fill — the reservation is a decision about what the word will mean, not a claim that the thing is built. The word is, however, *actively in use for the wave sense* in the `/v1` contract today; the `stage` entry describes each sense, and [ADR-0021](adr/0021-terminology.md) Consequences (iii) carries the complete site roster. The grammar's **location segment is optional** (owner decision, 2026-07-24), which makes segment count the disambiguator and therefore makes **hyphen-free segment values** a naming rule — see the `stage` entry.

---

### scan exclusion

**Definition.** An individual scan **finding** that does not count toward the severity ceiling, because a rule someone authorized says it should not. Exclusions are applied **before counting**; they never turn a `fail` verdict into a `pass`.

**Industry-standard?** QUALIFIED — the industry word for the artifact that carries this is **VEX** (Vulnerability Exploitability eXchange). SCP does not consume or emit VEX documents today, and "exclusion" names *our* mechanism rather than claiming that interchange format. If VEX ingestion ever lands it should map onto this concept, not beside it.

**Why not "waiver", "suppression" or "exception".** *Waiver* and *exception* both suggest acting on the **verdict** ("this failure is forgiven"), which is precisely the design [ADR-0033](adr/0033-scan-exclusions-and-overrides.md) §2 rejected — a verdict-level waiver hides which finding was tolerated and is invisible at the E6 federation boundary, which identifies a scan outcome purely by shape. *Suppression* implies the finding is hidden; an exclusion is recorded, counted separately, and named in the Decision. The finding still exists and is still reported — it just does not count.

**The two counts.** `severityCounts` continues to mean **what the scanner found**, so every CEL condition already authored against it keeps its meaning. A separate `effectiveSeverityCounts` carries the post-exclusion number, and **only the threshold comparison uses it**.

**Direction, and why it has its own algebra.** A ceiling is *tightening* and merges by per-severity **MIN**; an exclusion is *loosening* and merges by **monotone AND** down the tier chain ([ADR-0033](adr/0033-scan-exclusions-and-overrides.md) §1). Both are order-independent, so the documented containment-domain-vs-service tie stays safe. A matcher miss yields **no** exclusion — the opposite sign from a ceiling, where a miss is already safe.

**In the code — not built yet.** Proposed by [ADR-0033](adr/0033-scan-exclusions-and-overrides.md) and scheduled as M22; nothing in the tree implements it today, and a scan verdict is still four integers with no finding surviving to be excluded.

---

### exclusion admission

**Definition.** A tier's declaration that a **class** of scan exclusion may have effect at or below it. An exclusion clause has effect at tier T only if **every tier from platform down to T** admits its class. Default admission is **empty at every tier**, so with nothing authored the system behaves exactly as it did before exclusions existed.

**Industry-standard?** No — SCP-specific. The nearest neighbours are policy-engine words (*allow-list*, *grant*) that all describe permission given to a **principal**; this describes permission given to a **tier**, which is why neither borrows cleanly.

**Why the word is "admission" and not "permission".** It is a property of a **tier**, not of a person — it says *this kind of loosening is allowed to exist here*, independently of who later authors one. Authority to author the clause is a separate question, answered by `policy:write` at-or-above the scope ([ADR-0033](adr/0033-scan-exclusions-and-overrides.md) §6).

**The invariant it exists for.** A component may author an override it benefits from, at a weaker permission than the one that authored the constraint. Admission is what stops that being a self-grant: the component authors the *override*, never its own *admission*.

**In the code — not built yet.** Proposed by [ADR-0033](adr/0033-scan-exclusions-and-overrides.md) §1 and scheduled as M22.2.

---

### scan override request

**Definition.** A request raised by a **component**, **service** or **assembly** owner for a standing scan exclusion beyond what component-declared facts already produce — granted with an **expiry**, per (component × finding).

**Industry-standard?** No — SCP-specific as a term. The underlying practice is the industry's **risk acceptance** / **exception process**; "override request" is the owner's word and is kept because *exception* and *waiver* are both reserved here for acting on a **verdict**, which this deliberately does not do (see `scan exclusion`).

**Approver standing.** The tier that **set the rule** (owner decision, 2026-08-17). A platform-set floor is waivable only at platform; an assembly-set ceiling is waivable at assembly. This needs no new authority model: a bounded `scope.objectRef` naming the tier's object requires `policy:write` at-or-above **that object**, and authority expands strictly upward, so an assembly binding reaches its components and never its siblings or its parent.

**Not an `approval_request`.** That table is change-keyed (`change_object_id NOT NULL`), two-state (`pending|satisfied` — no deny, no expire, no revoke) and engine-materialized with no create API; it cannot express a standing grant. The shape to copy is the `freeze.override` act — mandatory non-empty reason, one high-severity audit event per use.

**Expiry is a read-time window, never a status column.** There is no sweeper in this tree and no `boss.schedule` usage to build one on, so a grant's validity is evaluated when it is read.

**In the code — not built yet.** Proposed by [ADR-0033](adr/0033-scan-exclusions-and-overrides.md) §6a and scheduled as M22.6. There is no override, waiver or risk-acceptance concept in the tree today.

---

## See also

- [ADR-0021 — Terminology](adr/0021-terminology.md) — the seven decisions, the rejected alternatives, the cost table, and the four tracked follow-on code PRs.
- [ADR-0016 §Terminology](adr/0016-scoped-scan-requirement-policies.md) — the trust-domain / containment-domain split this glossary generalizes.
- [ADR-0004](adr/0004-service-naming-commander-outpost-retrans.md) — commander / outpost / retrans, and the precedent for a breaking pre-1.0 enum rename.
- [docs/proposals/promotion-and-execution-model.md](proposals/promotion-and-execution-model.md) — the authoritative end-to-end workflow these words describe.
- [DESIGN.md §9](DESIGN.md) (change lifecycle, plans, waves, gates) and [§13](DESIGN.md) (federation).
