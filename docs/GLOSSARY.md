# CommanderSCP Terminology Glossary

**Status:** Authoritative for vocabulary. Owner-decided 2026-07-24 — the reasoning, the rejected alternatives, and the cost table live in [ADR-0021](adr/0021-terminology.md).

## Why this document exists

CommanderSCP **coordinates other people's tools**, and those tools arrived with vocabulary already attached. Argo CD, Kargo, JFrog, Helm, GitHub Actions and Terraform all use words like *promotion*, *release*, *stage* and *environment* — and they do not all mean the same thing by them. On top of that, the product ships into regulated and cross-domain environments where NIST and CNSSI have already defined *security domain*, *authorization boundary* and *cross-domain solution* precisely, and where a word like *release* carries a **disclosure** meaning that has nothing to do with software delivery.

The rule this glossary follows:

1. **Where a clear industry standard exists, use it** — and cite it, so a new engineer can go read the source.
2. **Where standards collide or the concept is genuinely ours, the owner decided** — and [ADR-0021](adr/0021-terminology.md) records why, including the alternatives that were considered and rejected.
3. **Where the glossary's preferred word does not match the code today, this document says so in the entry.** Nothing here describes an aspirational codebase as if it already exists. Four code changes are tracked as follow-on PRs — branded domain-id types (i), the `promote` → `accept` rename (ii), and the `stage` cleanup split into a cheap half (iii-a) and a **breaking `/v1`** half (iii-b). Each is flagged where it bites, with its real cost.

Audience: a new engineer trying to read the code, and an operator trying to read the UI. It is not a research dump — the research is in the ADR.

**How code is cited here (read this before adding a citation).** Line numbers rot the moment `main` moves; file paths and symbol names do not. So this document cites a **line number only where the exact line *is* the evidence** — a verbatim quoted comment, a specific enum value, a schema field definition, or an entry in the `stage` census below, which is a census *of lines*. Everywhere else — the "In the code" pointers at the end of each entry, file rosters, "see also" links — it cites the **file path alone**, and names the symbol so `grep` can finish the job. Every **count** in this document states the commit it was measured at, inline, so a future reader can tell a stale number from a wrong one. Keep both conventions when editing.

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
| **stage** | **Reserved:** one named deployment **place**, spelled `<domain>[-<location>]-<env>`. No such entity exists yet | QUALIFIED-STANDARD *(word-sense precedent only; the definition is ours)* |
| **wave** | One ordered step of a compiled plan — the **set of one-or-more stages** advanced at once | SCP-SPECIFIC |
| **change** | The coordinated unit of work; a graph object with a lifecycle state machine | SCP-SPECIFIC |
| **pipeline** | The ordered path a release travels for one executor **Type** | INDUSTRY-STANDARD |
| **artifact** | The immutable built thing identified by digest (image, rpm, npm, config bundle, plan) | INDUSTRY-STANDARD |
| **bundle** | Three distinct things — see the entry; always qualify | SCP-SPECIFIC |
| **security domain** | A domain implementing one security policy under a single administering authority | INDUSTRY-STANDARD (CNSSI-4009) |
| **containment domain** | The intra-org `domain` graph object type — an ordinary grouping below org | SCP-SPECIFIC |
| **authorization boundary** | The components authorized for operation by one authorizing official, excluding separately authorized connected systems | INDUSTRY-STANDARD (NIST SP 800-37) |
| **CDS / cross-domain solution** | The accredited mechanism that transfers information between security domains | INDUSTRY-STANDARD (CNSSI-4009) |
| **retrans** | The SCP federation role that sits at a CDS boundary and validate-then-relays | SCP-SPECIFIC |
| **commander** | The federation role that is the source of truth for global config | SCP-SPECIFIC |
| **outpost** | The federation role for a per-domain/per-environment instance | SCP-SPECIFIC |
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
- **`accept` / `accepted`** — the change-lifecycle approval gate. That is a human decision about a change, not an artifact advancing. It used to be spelled `promote`, which is exactly why it is being renamed (see the `accept` entry).
- **Argo Rollouts' "Promote"** — the progressive-delivery sub-step inside a canary analysis. SCP observes it; SCP does not own it (`docs/proposals/coordination-ui-views.md` §2).
- **`scp federation promote`** — the CLI verb that exports a **Promotion Bundle**. That is a real promotion (the genus), and it is often but not always cross-domain.

**In the code.** `apps/web/src/components/pipeline/PromotionArrow.tsx` is the UI expression of this sense: a wide top-to-bottom arrow drawn between two vertically-stacked cards, painted from a `PromotionState` (`open` / `blocked` / `approval` / `pending`). Read its own docblock before citing it, because two things about it are commonly overstated:

- **It is "purely presentational"** (its words) — *"the parent computes `state`/`label`/`detail`/`why` from real change data … this component only paints it"*. It decides nothing and evaluates no gate.
- **It draws between compiled *waves*, not between named environments.** The cards on either side are `StageCard`s, one per compiled wave. There is no `environment` table and no `stage` entity, so it cannot be drawing "Gamma → Prod" — there is no Gamma and no Prod for it to draw between. Its docblock's own phrase *"between two pipeline stages"* is itself one of the wave-sense misuses catalogued in the `stage` entry's census.

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

**In the code — the code still spells it `promote`/`promoted`.** As of this document the rename has not landed:

- `apps/server/src/coordination/transitions.ts` — the edge is `{ from: "validating", to: "promoted", trigger: "promote" }`
- `packages/schemas/src/changes.ts:22` — `"promoted"` is a `ChangeState` enum value, returned on every change response
- `apps/server/src/routes/changes.ts` — `POST /api/v1/changes/:id/promote` (`operationId: promoteChange`)
- `packages/cli/src/cli.ts` — `scp change promote <id>`
- `apps/server/drizzle/0007_change_coordination.sql` seeds the `state_transitions` rows

The rename is a **tracked follow-on PR** ([ADR-0021](adr/0021-terminology.md) Consequences, item ii). It is genuinely breaking: a `/v1` path change, a data migration over `changes.state`, the seeded `state_transitions` rows, the CLI verb, and the enum in every change response. It is judged payable now because the project is pre-1.0 with a single deployment, and because [ADR-0004](adr/0004-service-naming-commander-outpost-retrans.md) set the direct precedent — it removed `parent`/`child` outright in favour of `commander`/`outpost`/`retrans`, a breaking federation-role enum rename taken for exactly this class of reason.

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

---

### environment

**Definition.** A named operational tier within one security domain — dev, beta, gamma, prod. Environments are ordered within a domain and a promotion typically advances an artifact from one to the next.

**Industry-standard?** Yes. GitHub Actions environments and Argo CD's app-per-environment convention both use it this way. Kargo models the same node but deliberately spells it **Stage** — its docs avoid "environment" precisely *because* the word is perspective-dependent, and note that a Stage's name denotes an application instance's **purpose** "and not necessarily its location". Kargo is therefore a witness to the ambiguity, not a citation for the word; see the `stage` entry.

**Not to be confused with:** *stage* — under D6 (below), "stage" is reserved for a named deployment **place** spelled `<domain>[-<location>]-<env>`, so `gamma` is an environment while `commercial-amer-gamma` and `commercial-gamma` are both stages. Environment is the **last segment** of a stage name — the one segment that is always present — not a synonym for the name. And *deployment target*, which may happen to model an environment but may equally model a single cluster or host.

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

The grammar is lowercase and the segment **order** is fixed. Earlier ad-hoc examples in this project used a different order and mixed case (`commercial-prod-AMER`); **that form is superseded** — write `commercial-amer-prod`.

**A stage is a place; a wave is a step.** These are a **containment** relationship, not two names for one thing: **a wave contains one or more stages.** The apparent "stage vs wave" collision was never a rivalry — "stage" was simply being used *for* the wave sense by mistake. See the `wave` entry, which states the same relationship from the other side.

**Industry-standard?** Qualified, and narrowly so — the precedent covers the *word-sense*, not the definition.

- The **majority** CD sense of "stage" is a **pipeline phase** — Jenkins `stage()`, GitLab CI `stages:`, Spinnaker pipeline stages. We do **not** use it that way.
- The **minority** sense — and ours — has a real precedent: **Kargo's `Stage` CRD** spends the word on a **promotion-target node** ("a stage is a promotion target that represents some desired state") rather than on a pipeline phase. That is genuine support for *what we spend the word on*.
- **It is not support for our definition.** Kargo has no security-domain axis, and its docs state that a Stage's name denotes an application instance's **purpose** "and not necessarily its location" — i.e. Kargo deliberately declines to bind a Stage to a place. The `<domain>[-<location>]-<env>` place definition is **ours**: SCP-specific, not inherited from Kargo. Do not cite Kargo for it.

**Honest status: no stage entity exists in the schema today.** There is no `stage` table and no `environment` table, and **no stage-grammar compound name such as `commercial-amer-gamma` appears anywhere in the code** (this glossary's and ADR-0021's own illustrative examples aside). "Stage" is *reserved vocabulary that a future entity may fill*, not a description of something built.

#### The in-tree misuses — a full census

The word is currently used for the **wave** sense in the shipped `/v1` contract, not only in UI labels. **Scope and method, stated so the census is re-runnable:** case-insensitive `stage` across `apps/`, `packages/` and `tools/openapi`, excluding `*.test.*`, `*.spec.*` and `__tests__`, measured on `origin/main` at **`da9e92c`** (2026-07-24). This is the *whole* of that grep, sorted into five senses plus an out-of-scope set; where a group cannot practically be enumerated line-by-line it says so rather than implying completeness ([ADR-0021](adr/0021-terminology.md) Consequences, item iii). **Nothing here has been changed yet.**

**(a) The service-board `stage` = wave chain — this is in the `/v1` contract.** `packages/schemas/src/services.ts:25` says it outright: *"One pipeline stage of a component's latest change = one compiled wave"*.

- `packages/schemas/src/services.ts` — `ServiceBoardStageSchema` (`:29`), the exported type (`:37`), `ServiceBoardRowSchema`'s `currentStage` (`:72`) and `stages` (`:73`), and the row docblock defining `currentStage` as *"the running (or last non-pending) wave's display name"* (`:62`)
- `apps/server/src/routes/services.ts` — these ship on `GET /api/v1/services/:idOrUrn/board`; the route's leading comment says "per-stage status" (`:25`) and so does its OpenAPI `summary` (`:36`)
- `packages/sdk/src/index.ts:68` re-exports `ServiceBoardStage`; `packages/sdk/src/generated/types.gen.ts:6158–6159` carries the generated field pair, and `packages/sdk/src/generated/sdk.gen.ts:876` carries the same route summary as the generated operation docstring — both regenerate from the contract, so both are part of the (iii-b) surface
- `tools/openapi/openapi.v1.json:23130` (the route `summary`), `:23236` (`currentStage`) and `:23246` (`stages`) — the latter two also in the **required** list at `:23393–23394`
- `apps/server/src/coordination/service-board.ts:6, 110–111, 126, 138, 141, 157–158` — the server-side projection
- `apps/web/src/routes/service-board.tsx:3` (`import type { ServiceBoardRow, ServiceBoardStage } from "@scp/sdk"` — the line the (iii-b) rename breaks) and `:38–59`, the `StageStrip` component, whose `data-testid`s are `board-stage-strip` (`:45`) / `board-stage-badge` (`:51`) while the badge it renders is captioned from the **wave** index — `Wave ${s.waveIndex}` in the tooltip (`:50`) and `W${s.waveIndex}` in the label (`:53`). The same object is labelled both ways inside one function. Also `:190–191` (`<TableHead>Current stage</TableHead>`, `<TableHead>Stages</TableHead>`), `:248–249` (`row.currentStage`), `:255` (`row.stages`)

**(b) The change-pipeline UI — labels and test hooks only.**

- `apps/web/src/components/pipeline/StageCard.tsx` — **the whole component**, 28 matching lines (30 occurrences) — the largest concentration in the census; it is not enumerated line-by-line because the file is the misuse. Its docblock at `:90` reads *"One pipeline stage = one compiled wave"*; it takes a `ChangeWave` plus a `stageNumber` prop (`:99, :103`), renders the visible label `Stage {stageNumber}` (`:116`), and carries `data-stage` (`:111`) plus nine distinct `data-testid="stage-*"` hooks (ten occurrences)
- `apps/web/src/routes/change-pipeline.tsx:26, 206, 208, 237, 310, 314, 398, 406` (`data-testid="pipeline-stages"`), `:407, :420` — all ten wave-sense lines in the file (13 occurrences)
- `apps/web/src/components/pipeline/PromotionArrow.tsx:4` — its **own docblock** says *"The gate/approval state of a promotion between two pipeline stages"*, and `:26` says "stage cards". The `promotion` entry cites this file for what it *draws*; what it *calls* the cards it draws between is this misuse
- `apps/web/src/routes/change-detail.tsx:51`; `apps/web/src/lib/query-client.ts:48, 61`

**(c) "per-stage version" — the same wave sense, spread across comments and schema docblocks.** `packages/schemas/src/changes.ts:164, 168`; `apps/server/src/coordination/plan-service.ts:156`; `apps/server/src/coordination/wave-targets-repo.ts:160`; `apps/server/drizzle/0027_wave_target_observed_state.sql:8–9`; `packages/schemas/src/services.ts:7, 14, 18, 28`; `packages/sdk/src/client.ts:919`; `apps/web/src/routes/service-board.tsx:97, 101, 194, 273`.

**(d) "stage" for a pipeline phase.** `apps/server/src/coordination/change-coordination-lock.ts:6` ("one pipeline stage earlier"); `tools/openapi/check.sh:3, 10` and `tools/openapi/README.md:9`, which cite "BUILD_AND_TEST.md §6 stage 3" — the CI-pipeline sense, and note that fixing those means renaming the section in BUILD_AND_TEST.md too, so they are not free the way a comment is; and prose such as the execution map in `docs/proposals/promotion-and-execution-model.md` §1. These should say **phase** or **step**.

**(e) "stage" for a milestone sub-step.** Two variants, counted separately because they need different greps:

- **`M<n> stage` form — 37 sites in 18 files**, spelling milestone increments `M2 stage 1` … `M2 stage 4`. The complete file roster: `apps/server/drizzle/0004_auth_expansion.sql`, `apps/server/drizzle/0005_plans.sql`, `apps/server/src/app.ts`, `apps/server/src/auth/device-flow.ts`, `apps/server/src/auth/local-auth.ts`, `apps/server/src/auth/oidc.ts`, `apps/server/src/auth/pat.ts`, `apps/server/src/config.ts`, `apps/server/src/db/schema.ts`, `apps/server/src/routes/auth.ts`, `apps/server/src/routes/device-flow.ts`, `apps/server/src/routes/oidc.ts`, `apps/server/src/routes/pats.ts`, `apps/web/vite.config.ts`, `packages/schemas/src/auth.ts`, `packages/schemas/src/graph.ts`, `packages/sdk/src/client.ts`, `packages/sdk/src/index.ts`.
- **Prefix-less variants — same sense, three sites** that an `M<n> stage` grep misses: `apps/web/src/routes/device.tsx:12` ("stage 2's server-side integration test"), `apps/web/src/routes/pats.tsx:26` ("stage 2's PAT API"), `apps/web/vitest.config.ts:14` ("before this stage's changes").

A third distinct sense; all forty should say **part** or **step**.

#### What the cleanup actually costs

**It is not "UI and docs only."** Group (a) is a **shipped `/v1` response shape**. Renaming `currentStage` / `stages` / `ServiceBoardStage` to their wave-sense names is a **breaking `/v1` change**: it alters a response body already in `tools/openapi/openapi.v1.json`, it will **trip the oasdiff additive-only gate**, and it requires `pnpm gen` plus an SDK regeneration. That puts it in the same cost class as the D5 `promote` → `accept` rename, not in the free tier.

The follow-on work is therefore **split in two** ([ADR-0021](adr/0021-terminology.md) Consequences, item iii):

- **(iii-a) the cheap half** — groups (b), (c), (d), (e): UI labels, `data-testid` hooks, comments and docblocks. No API, no schema, no migration. Genuinely cheap.
- **(iii-b) the breaking half** — group (a): the service-board field and type names in `packages/schemas`, the `/v1` response body, the committed OpenAPI document, the generated SDK, and the server projection. **Breaking, oasdiff-gated, needs `pnpm gen`.** It also confirms D6's premise from the other direction: the `/v1` `stages[]` / `currentStage` / `ServiceBoardStageSchema` fields genuinely *are* the wave sense wearing the wrong name.

**Deliberately *not* misuses — leave them alone.** Anyone re-running the grep hits these first, so they are listed in full:

- **Docker's own multi-stage-build term.** `apps/runner-scan/Dockerfile` — **eight matching lines (ten occurrences), the largest concentration among the non-misuses** (it is joint-seventh in the census as a whole; `StageCard.tsx`'s 28 lines lead it) — and a genuine two-stage build (`STAGE 1 — Trivy`, `STAGE 2 (FINAL) — OpenSCAP`); `apps/runner-scan/README.md:19` describes that same build (*"`COPY --from` a digest-pinned Trivy stage"*); `packages/cosign/src/cosign-bin.ts:5`; `packages/cosign/src/skopeo-bin.ts:5`; `packages/plugin-testkit/src/runner-image.ts:36`.
- **The unrelated verb "staged"** — `apps/server/src/governance/scan-db.ts:399, 404, 409` ("staged payload", "staged metadata").
- **`apps/server/src/graph/named-queries.ts:279`**, whose hypothetical "stage-domain" is actually *consistent* with the reserved place sense.
- **The vendored `tools/openapi/bin/oasdiff-*` binaries**, which match on byte content only.

**Not to be confused with:** *wave* (the ordering step that **contains** stages), *environment* and *region* (the env and location segments of a stage name), *phase*/*step* (what other CD tools call a stage).

---

### wave

**Definition.** One ordered step of a **compiled plan**: **the set of one-or-more stages advanced at once**, and the targets within them. Wave order is computed from graph `depends_on` edges (topological sort with cycle rejection) plus explicit coordination rules such as "infrastructure before application". Waves sharing an index run in parallel (fan-out); a fan-in gate requires every target of the previous wave to have succeeded.

**A wave contains stages.** This is the load-bearing relationship, and it is **containment, not rivalry** — a wave is a *step*, a stage is a *place*, and one step advances one or more places. The two words were never competing for the same meaning; "stage" was simply being used *for* the wave sense by mistake (see the `stage` entry's census).

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

**Not to be confused with:** *stage* (a place, which a wave **contains** — per D6). The UI and the service-board `/v1` response currently mislabel waves as stages — see the `stage` entry's census.

**In the code.** The `change_waves`, `change_wave_targets` and `campaign_waves` tables in `apps/server/src/db/schema.ts`; compiled by `apps/server/src/coordination/plan-compiler.ts`; DESIGN.md §9.3. There is **no stage table** — a wave's "stages" are implicit in its targets today.

---

### change

**Definition.** The coordinated unit of work — a graph object with a projection row carrying an explicit, table-driven lifecycle state machine. A change targets objects, compiles into a plan of waves, passes gates, and terminates in success (`accepted`), `cancelled`, or `rolled_back`.

**A change is also a release** (see `release`) — same thing, two vocabularies for two audiences: *change* is what the engine calls it, *release* is what a delivery engineer calls it.

**Lifecycle.** `proposed → evaluated → coordinated → executing → validating → accepted`, with an optional `coordinated → waiting → executing` detour when cross-change prerequisites are outstanding, `cancel` legal from every pre-acceptance state, and `rollback` legal once something has actually executed. **In the code the terminal state is still spelled `promoted`** — see the `accept` entry.

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

**Not to be confused with — five rival senses of bare "domain":**
- a **DNS** domain;
- a **Windows/Active Directory** domain;
- a **DDD bounded context** ("the domain model");
- an **identity realm** — NIST's own federation literature speaks of a collection of realms (domains);
- SCP's own **containment domain** object type (next entry).

Also distinct: **SPIFFE's "trust domain"**, which corresponds to the **trust root** of a system — i.e. it is defined by a shared PKI root, whereas a *security* domain is defined by common security **policy** under one administering authority. These are different concepts and they cross-cut: two security domains can share a trust root, and one security domain can contain several. SCP deliberately does **not** use `spiffe://` identifiers; it uses `urn:scp:domain:<domainId>` in the certificate SAN URI (RFC 8141 URN, `apps/server/src/federation/mtls-enforcement.ts`), precisely to avoid taking a SPIFFE dependency. That was a deliberate choice, not an oversight.

**Bare "domain" is banned as a tier name** — in prose *and* as a stored value. [ADR-0016](adr/0016-scoped-scan-requirement-policies.md) §Terminology mandates the full forms and specifies that the floor table's tier literal is `trust_domain`, never bare `domain`; DESIGN.md does the same for the policy-resolution chain.

**In the code — the docs solved this; the code did not.** Counted on `origin/main` at **`da9e92c`** (2026-07-24), with the same test exclusions as the `stage` census, there are **365** non-test source lines mentioning `domainId` across `apps/` and `packages/`, in **75** files. About **51** live in `apps/server/src/federation` and mean the **security/trust** sense (`federation_self.domainId` in `apps/server/src/db/schema.ts`). About **45** live in `apps/server/src/graph` and mean the **containment** sense (`objects.domainId`, same file). **Both are plain `uuid` with zero type-level separation**, so nothing today stops one being passed where the other is expected.

Re-run it with `git grep -n domainId origin/main -- 'apps/**' 'packages/**' | grep -v -E '\.test\.|__tests__|\.spec\.'`, and update the commit stamp above along with the number.

**The fix is a tracked follow-on PR, not something already done:** branded TypeScript types `TrustDomainId` vs `ContainmentDomainId`, so the collision becomes **uncompilable** rather than a naming convention ([ADR-0021](adr/0021-terminology.md) Consequences, item i).

---

### containment domain

**Definition.** The `domain` **object type** in the graph — an ordinary intra-org grouping that sits **below** org in the containment chain: org → containment domain → service → component. It is the "domain" in policy resolution and in the scan-requirement scope chain.

**Industry-standard?** No — SCP-specific. It is closest to a folder/organizational-unit concept.

**Not to be confused with:** the **security domain** (the trust tier above org). They are never the same thing. The `scan_requirement_floors` header comment in `apps/server/src/db/schema.ts` records the distinction explicitly — the `tier` literal is spelled `trust_domain`, *never* bare `domain`, "while the `domain` OBJECT TYPE (the containment domain…)" is the below-org grouping — and [ADR-0016](adr/0016-scoped-scan-requirement-policies.md) §Terminology exists solely to keep them apart.

**In the code.** Object type `domain`, seeded in `apps/server/drizzle/0002_rls_rbac_seed.sql`; the column is `objects.domain_id` (`apps/server/src/db/schema.ts`); the walk is `apps/server/src/graph/containment.ts` (`containmentChain`), which is org-filtered on every join and rooted at the org root — it **structurally cannot** express any tier above org, which is exactly why the security-domain tier needed a separate instance-scoped table.

**Same branded-types caveat as above:** `objects.domainId` and `federation_self.domainId` are both bare `uuid` today.

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

**Definition.** The federation role designating the single instance that is the **source of truth for global configuration** — the domain registry, org structure, global policies, release topologies, campaign and initiative definitions. The charter's Global Coordination Layer. It also owns the **cross-boundary gate**: it consumes the scan verdict and cosign-signs its own promotion manifest.

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

**In the code.** Object type `execution-system`, seeded in `apps/server/drizzle/0019_execution_system.sql`; its `serverUrl` is the deep-link base the UI uses (`apps/web/src/components/pipeline/StageCard.tsx`).

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

**Not to be confused with:** an **OCI image manifest** (the registry's own descriptor document — a real collision, since SCP handles both), a Kubernetes manifest (a YAML resource file), or an **SBOM** (a component inventory, not an authorization).

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

## Deprecated / avoid

| Don't say | Say instead | Why |
|---|---|---|
| bare **"domain"** as a tier name | **"security domain"** (the trust tier) or **"containment domain"** (the intra-org object type) | Five live rival senses — DNS, Windows/AD, DDD bounded context, identity realm, and our own object type. Banned in prose *and* as a stored value: the floor table's tier literal is `trust_domain`, never `domain` ([ADR-0016](adr/0016-scoped-scan-requirement-policies.md) §Terminology; DESIGN.md's policy-resolution chain). |
| **"promotion"** unqualified when a security-domain crossing is meant | **"cross-domain promotion"** | Bare promotion is the genus and carries no boundary implication. Dropping the qualifier silently claims a CDS gate ran when it may not have. |
| **"promote" / "promoted"** for the change approval gate | **"accept" / "accepted"** | It is a human approval and a terminal success state, not an artifact advancing — the collision fights the genus/species model (D5). **The code still spells it `promote`/`promoted`**; the rename is a tracked follow-on PR ([ADR-0021](adr/0021-terminology.md) Consequences ii). |
| **"release"** meaning a single push into one environment | **"deployment"** | A release is the whole versioned unit moving through its pipeline; a change *is* a release. Also: in DoD/IC usage "release" means a **disclosure determination**, which is the last thing you want an accreditation reader to infer. |
| **"stage"** meaning a pipeline **phase** | **"phase"** or **"step"** | "Stage" is reserved for a named deployment place spelled `<domain>[-<location>]-<env>` (D6). Code comments currently misuse it — including 37 `M<n> stage N` milestone-substep comments plus 3 prefix-less variants (`da9e92c`); cleanup is tracked ([ADR-0021](adr/0021-terminology.md) Consequences iii-a). |
| **"stage"** meaning a **wave** | **"wave"** | Same reservation — and a wave *contains* stages, so the two are not interchangeable in either direction. The misuse reaches the shipped `/v1` contract (`ServiceBoardStageSchema`, `currentStage`, `stages[]`), not just UI labels; see the `stage` entry's full census. Cleanup is split into a cheap half (iii-a) and a **breaking, oasdiff-gated** half (iii-b). Not done. |
| **"bundle"** unqualified | **"promotion bundle"** / **"air-gap federation bundle"** / **"relay tarball"** | Three different things, only one of which carries artifact bytes. |
| **"parent" / "child"** for federation roles | **"commander" / "outpost" / "retrans"** | Removed outright, not aliased, by [ADR-0004](adr/0004-service-naming-commander-outpost-retrans.md). (The words remain correct for *process* supervision and RBAC containment walks — that is a different concept.) |

**Note on `stage`:** no `stage` entity exists in the schema today, and no stage-grammar compound name such as `commercial-amer-gamma` appears anywhere in the **code** (this glossary's and ADR-0021's own illustrative examples aside — scope the claim that way so it stays checkable after this branch merges). "Stage" is reserved vocabulary a future entity may fill — the reservation is a decision about what the word will mean, not a claim that the thing is built. The word is, however, *actively in use for the wave sense* in the `/v1` contract today; the `stage` entry enumerates every site as of `da9e92c`. The grammar's **location segment is optional** (owner decision, 2026-07-24), which makes segment count the disambiguator and therefore makes **hyphen-free segment values** a naming rule — see the `stage` entry.

---

## See also

- [ADR-0021 — Terminology](adr/0021-terminology.md) — the six decisions, the rejected alternatives, the cost table, and the four tracked follow-on code PRs.
- [ADR-0016 §Terminology](adr/0016-scoped-scan-requirement-policies.md) — the trust-domain / containment-domain split this glossary generalizes.
- [ADR-0004](adr/0004-service-naming-commander-outpost-retrans.md) — commander / outpost / retrans, and the precedent for a breaking pre-1.0 enum rename.
- [docs/proposals/promotion-and-execution-model.md](proposals/promotion-and-execution-model.md) — the authoritative end-to-end workflow these words describe.
- [DESIGN.md §9](DESIGN.md) (change lifecycle, plans, waves, gates) and [§13](DESIGN.md) (federation).
