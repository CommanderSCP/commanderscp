# Dependency subscriptions — subscribe to a major line, receive the bump automatically

**Status:** Proposed (2026-08-13) — five of six decision points settled with the owner on 2026-08-13
(§10 Q1–Q5); **Q6 open** (federation-importer tolerance as a possible prerequisite).
**Relates to:** [ADR-0002](../adr/0002-execution-strategy.md) (four-arm ownership test + six-gate boundary test — the router this feature must pass); [ADR-0013](../adr/0013-supply-chain-scan-sbom-manifest.md) (SCP stores no SBOM bytes); [ADR-0022](../adr/0022-outpost-config-authority-split.md) (commander-declared config must be a graph object to reach an outpost); [ADR-0028](../adr/0028-stage-scoped-component-coupling.md) (`provides`/`requires` coupling — prior art for the wait predicate); [ADR-0031](../adr/0031-domain-local-objects-never-federate.md) (domain-local visibility)
**Proposed ADR:** ADR-0032 *(provisional number; 0031 is currently the highest on disk)*
**Proposed milestone:** M21 *(provisional; M20 is currently the last milestone in BUILD_AND_TEST.md §8)*

---

## 1. What was asked for

A component team selects a **major version** of one or more of its dependencies and *subscribes* to it.
Whenever that major line publishes (1.0.0 → 1.0.1), the subscriber **receives that update as an
automatic code change**. Teams choose the **granularity** of what they accept: minor-and-patch, or
patch-only.

All dependencies — **internal and third-party** — are captured in a database, ideally **derived from
the users' own code**. Internal dependencies refresh the database once they are **updated and released
to production**. Third-party dependencies are **checked once per day**.

Enablement is a **chain**, not a switch:

- the feature must be enabled at the **CommanderSCP instance** level, and that only **unlocks** it;
- each **component team** flips their own component-level switch;
- inside an enabled component, **individual dependencies can be opted out**, because one bad
  dependency should not force a team to hand-manage all of them.

**Ingestion must run only for components and services that have it enabled** — otherwise the platform
is fetching latest-versions for dependencies nobody subscribed to.

UI work is deliberately **last**, handed to the UI agent once the API/SDK/CLI layers are real.

---

## 2. Measured at HEAD (2026-08-13)

Every claim below was read at HEAD, not inferred from docs. These are the facts the design has to
survive; several of them contradict the obvious design.

**The graph is generic, and `depends_on` is already taken.**

- Two tables hold every node and edge: `objects` + `relationships`, with `object_types` /
  `relationship_types` as runtime registries (`apps/server/src/db/schema.ts:140-260`).
- `depends_on` exists as a built-in but is endpoint-constrained to `service|component →
  service|component` (`apps/server/drizzle/0002_rls_rbac_seed.sql:181-183`) — it **cannot** point at a
  third-party package.
- More decisively, `depends_on` is **simultaneously** the wave-plan toposort input, the default
  `relType` of the `impact-of`/`blast-radius` named queries, and the materialisation target for
  CI-declared `stageDependencies` (`drizzle/0054:9,27`; `drizzle/0055:92` — "LEFT ALONE, deliberately.
  These are COMPONENT-topology edges"). A **cycle among co-placed targets is a hard plan-compile
  error**, and package dependency graphs routinely contain cycles. Writing package edges as
  `depends_on` would inject cycles into the plan compiler.
- `relationships` is unique on `(org_id, type_id, from_id, to_id)` with **soft delete**, and the unique
  index does **not** exclude deleted rows (`schema.ts:249-254`) — re-creating a soft-deleted edge
  collides. Dependency edges churn.

**SCP has no name for anything, and cannot slug a package coordinate.**

- `ArtifactRef` is `{type, digest}`. There is **no artifact name anywhere**, and **no `purl` string in
  the tree**.
- URN derivation is `urn:scp:{org}:{type}:{slug}` with a lowercase-and-hyphenate slug
  (`apps/server/src/graph/urn.ts:1-18`), which collapses `@acme/lib`, `acme/lib` and `acme-lib` into
  **one URN**; a collision is a 409 with no auto-suffix and no upsert-by-coordinate. **Package
  coordinates are not safely sluggable into the existing URN scheme.**
- The only universal name→component join that exists is `source_mappings.repo_pattern`, a glob over a
  **repository** name — not a package coordinate.

**SCP never reads or writes file bytes in a user repo.**

- Discovery detects that `package.json` exists by testing **directory-entry names** against a 5-entry
  marker list; it never fetches or decodes a file body
  (`packages/plugins/github/src/index.ts:718,749-753`).
- `GitProviderAdapter` is a fixed 12-hook interface with **no hook to read a file at a ref** and **no
  hook to create a branch, commit, or PR**.
- The only repo write in the entire tree is `postCommitStatus`
  (`packages/plugins/github/src/index.ts:679-699`) — a **commit status**, not code — and it is **not
  wired into any server path**; its only callers are its own unit tests.
- There is no git client dependency anywhere (no isomorphic-git, simple-git, nodegit, no `git`
  subprocess).
- `ExecutorPlugin` is exactly four verbs — observe / trigger / status / abort — and the interface
  comment states the coordination boundary "is enforced structurally: no execute()/deploy() verb
  exists" (`packages/plugin-api/src/index.ts:86-90,234-242`).

**There is no scheduler, and no feature-flag substrate.**

- `grep 'boss.schedule|cron'` over `apps/server/src` returns **zero hits**. Every loop (reconcile,
  observe, watchdog, auto-relay, inbox, federation-sync) re-sends itself with `startAfter` +
  `singletonKey`. A daily cadence is net-new.
- There is **no feature-flag or instance-settings table**. Instance-level precedents are env vars and
  operator-token-gated singleton tables (`scan_requirement_floors`, migrations 0029/0035/0036);
  per-component state lives in object `properties`.

**Federation constrains this harder than anything else.**

- ADR-0022 clause 2: commander-declared config that must reach an outpost **must be a graph object
  riding `object_upsert`** — the journal has nine entry kinds and **nothing table-shaped can travel**.
  So an enablement bit in a `scan_requirement_floors`-style table can **never** reach an outpost.
- But a new **built-in** object/relationship type is **not a safe migration in a running fleet**: the
  importer's `object_upsert` branch has **no try/catch** (`apps/server/src/federation/import-repo.ts:189-215`)
  and `createObject` 404s on a type not registered locally, so the first such object journaled to a
  not-yet-migrated outpost **aborts the whole signed bundle and wedges that channel**.
- And a **runtime** custom type via `POST /type-registry` **federates to nobody** — there is no
  `object_type_upsert` journal kind.
- The charter requires a disconnected domain to keep operating, so a **commander-only dependency
  database is a charter conflict**, not merely an availability concern.

**Bulk graph writes are measured to be expensive.**

- Every object/relationship write takes **two per-org `pg_advisory_xact_lock`s** held to commit (audit
  chain + sync journal) plus an **Ed25519 signature per journal row**. Bulk dependency ingestion as
  graph objects serialises every other write in that org, and neither chain has a prune.
- The repo's own load test records the `impact-of` recursive CTE at **7+ minutes then disk exhaustion**
  at fan-out 8–14, and a 30s blowout at fan-out 2–4 over 12 layers; production caps graph queries at a
  **5s statement_timeout** and returns 408.

**Two shipped subsystems already implement half of this feature.**

- **Campaigns/Initiatives (M5, shipped)** already fan one intent out to N target components, one member
  Change each, in waves, with gates and rollback (`campaign-reconcile.ts:319`). That is exactly the
  broadcast shape "bump every subscriber to acme-lib" needs.
- **`provides`/`requires` coupling (ADR-0028, shipped)** is a working publish/subscribe: a change parks
  in a real `waiting` state until some **other** change is in `validating|accepted` and `provides` that
  key at that object, evaluated by a jsonb-containment probe with **no new index and no new column**
  (`apps/server/src/coordination/coupling.ts:38-50`). It is fail-closed on a malformed `provides`.

**Detecting "released to production" is harder than it looks.**

- There are exactly **six** event types server-wide. The only change event is `scp.change.transitioned`
  carrying `{fromState, toState, trigger}` — **no component, no target, no environment, no version or
  digest** (`apps/server/src/coordination/transition.ts:361-368`).
- Per-place success is `change_wave_targets.status='succeeded'`, a plain UPDATE with **no event and no
  audit row** (`apps/server/src/coordination/reconcile.ts:1098-1101`).
- `validating → accepted` is **human-only** for forward changes (`reconcile.ts:1893-1948`).
- "prod" is a jsonb property on a `deployment-target`: `properties.environment`
  (`coordination/regional-executors.ts:94,196-214`). There is no `environments` or `stages` table.

**Egress is default-deny, and there is no precedent for polling a public registry.**

- No code anywhere references npmjs, PyPI, or Maven Central. No HTTP client, credential model,
  rate-limit budget, or cache for public package registries exists.
- Redirects are **hard-disabled** on the plugin HTTP client (`subprocess-entry.ts:285,295`); public
  registries redirect routinely.
- The Helm chart's NetworkPolicy is **default-deny egress** with only DNS + postgres/nats
  (`deploy/helm/templates/networkpolicy.yaml:233-238`).
- Both managed runners default to `--network none`.
- The **one** shipped external-feed pattern is the Trivy DB: **operator-invoked** refresh,
  cosign-signed **operator-load** for air gaps, and a **fail-closed staleness policy** — never a
  scheduled poll.

**One thing SCP already receives and throws away.**

- `parseTrivyResult` (`apps/server/src/federation/promotion-scan-step.ts:687`) walks
  `Results[].Vulnerabilities[]` and reads **only `Severity`**, distilling everything to four integers.
  The `PkgName` / `InstalledVersion` / `FixedVersion` / `PURL` fields on each entry are **discarded**.
  *Correction to an earlier reading: this is the **vulnerable** package set, not a complete dependency
  inventory — Trivy only lists all packages under `--list-all-pkgs`. It is a real and nearly-free
  ingress, but it is partial, and it only covers artifacts that pass a managed promotion scan.*

---

## 3. The feature is four separable pieces

Keeping these apart is what makes the charter question tractable — only the fourth touches it.

| # | Piece | Charter status |
|---|---|---|
| 1 | **Inventory** — which component declares which dependency at which version | Clean |
| 2 | **Subscription + enablement** — the major line, the granularity, the three-level chain | Clean |
| 3 | **Detection** — a new version exists on a subscribed line | Clean (with an air-gap shape) |
| 4 | **Actuator** — the code change that bumps it | **Needs a charter amendment** |

Pieces 1–3 are buildable and useful under any actuator decision. Only piece 4 is gated.

> **A note I owe you up front.** Detection without an actuator is the exact failure mode that cost
> `rollout-step-coupling` v0.1 — a design that verified the *signal* was readable and never checked an
> *actuator* existed. The headline requirement here **is** the code change. Pieces 1–3 must not be
> shipped and called done.

---

## 4. Piece 1 — the inventory

### 4.1 Direct declared dependencies only

The inventory is **what a component's own manifests declare** — not the transitive closure.

This is not a scoping convenience; it is what keeps the feature charter-coherent. ADR-0013 and
`packages/schemas/src/supply-chain.ts:277-342` establish deliberately that **SCP stores no SBOM
bytes**, only an `SbomRef`. A stored transitive closure is an SBOM by another name, and it is also the
high-convergence graph shape the load test measured as non-viable. Direct-only keeps row counts at
roughly *components × direct deps* and keeps every query a **single-hop index lookup**, never a
recursive CTE.

The two questions this feature must answer are both single-hop:

- *"which components subscribe to package P?"* → reverse index lookup;
- *"what does component C declare?"* → forward index lookup.

Neither is `impact-of`. The measured CTE blowup does not apply, **provided** we never expose a
transitive dependency traversal.

### 4.2 Where it is stored — a projection table, not graph objects

**Decided (owner, 2026-08-13): a `component_dependencies` projection table keyed by component object
id**, in the shape `changes` already uses (a projection row keyed by `object_id`), plus a
`dependency_lines` table for the identity of a package's major line.

This deliberately does **not** materialise packages as graph objects, for four measured reasons:

1. **URNs cannot represent package coordinates** — `@acme/lib`, `acme/lib` and `acme-lib` collapse to
   one slug and collide with a 409 (§2).
2. **Write amplification** — two per-org advisory locks + an Ed25519 signature per row would serialise
   the org's writes during ingestion (§2).
3. **New built-in types can wedge a federation channel** on a fleet mid-upgrade (§2).
4. Charter principle 2 says new concepts arrive as relationship/policy/**registry** data. A dependency
   inventory is **derived, per-domain, high-churn observation data** — the same category as
   `change_source_events` and `object_health`, both of which are tables, not graph objects.

**This is a deliberate, scoped bend of charter principle 2, not an oversight** — DESIGN §5 anticipated a
closure-table escape hatch and this is the case it anticipated (§10 Q2). Its boundary is load-bearing:
**nothing in the dependency path may expose a transitive traversal**, because that is exactly what would
make the graph representation necessary again.

The *subscription* is a different matter — see §5.3.

### 4.3 Where the data comes from

Three ingresses, in increasing cost:

- **(a) Manifest read (primary — "formulated via the users' code").** Fetch the declared manifests
  (`package.json`, `go.mod`, `pom.xml`, `requirements.txt`/`pyproject.toml`, and **`Dockerfile`**) at a
  ref and parse the **direct** dependency block. This needs **one new `GitProviderAdapter` hook**
  (`readFileAtRef`) plus three adapter implementations. It is a new hook, not a small delta: the
  existing contents calls return **directory listings** and the code touches nothing but
  `entry.name`/`entry.type`.
- **(b) Trivy harvest (nearly free, partial).** Stop discarding `PkgName`/`InstalledVersion`/`PURL` at
  `promotion-scan-step.ts:687`. No new egress, no new credential, no air-gap story. But it covers only
  **vulnerable** packages of artifacts that pass a **managed promotion scan** (§2) — a useful
  cross-check, not the primary source.
- **(c) Operator declaration.** The escape hatch for ecosystems we do not parse.

All three land through the **existing propose→accept doctrine**: discovery "NEVER auto-commits, only
proposes" and writes only on explicit acceptance (`packages/plugins/github/src/index.ts:701-706`).

### 4.4 Internal vs third-party is a property of the *package*, and it is declared

A dependency line may be linked to the component/service that produces it. That link makes it
"internal"; its absence makes it third-party.

**That link is declared, never inferred from a repo or package name.** This is the ADR-0030 §2 lesson
("read, never inferred from a repo name, a target label or a branch string") and the
provenance-label lesson: a label named after *what matched* goes false the moment the matcher covers a
second case. Discovery may **propose** the link; an operator accepts it.

There is no material to infer it from anyway — SCP has no artifact name (§2).

---

## 5. Piece 2 — subscription and the enablement chain

### 5.1 The chain is a monotone AND

```
effective_enabled(component, dependency) =
      instance_unlocked          -- unlocks only; never activates
  AND component_enabled          -- the team's own switch
  AND NOT dependency_opted_out   -- may only ever turn OFF
```

This is the same algebra the codebase already proved in
`apps/server/src/governance/scan-requirements.ts`: a top-down tier chain where **a child may only ever
tighten**, the merge is **pure, commutative, associative and order-independent**, and **absent never
means zero**. Here the analogue of "absent never means zero" is **absent never means enabled**.

Two properties fall out that the requirement asks for explicitly:

- an instance-level ON that **silently activated authoring on every component** would violate
  ADR-0006's "managed execution is never a default" — the AND makes that structurally impossible;
- the deepest level can only subtract, so a team can opt out one bad dependency without losing the rest.

Each level's contribution is carried for explainability, exactly like `ScanThresholdContribution`, so a
Decision can answer *"which level turned this off?"* (charter principle 6).

### 5.2 Ingestion reads the same resolution

The ingestion work-list is **derived from** `effective_enabled`, so a disabled component is never
queried and a opted-out dependency is never polled. This is the requirement's "otherwise we're
unnecessarily getting the latest for dependencies", and it is free once §5.1 exists.

### 5.3 The enablement bit has to be a graph object

By ADR-0022 clause 2, config that must reach an outpost **must ride `object_upsert`** — and every
table-shaped precedent (`scan_requirement_floors`, `executor_bindings`, `source_mappings`) is
**provably unable to travel**.

So the split is:

- **inventory** (derived, per-domain, high-churn) → **projection table**, does not federate, each
  domain derives its own;
- **subscription + enablement** (declared config, low-churn, must reach outposts) → **graph object**,
  federates.

This split is what lets a disconnected domain keep operating (§2's charter conflict) while keeping the
commander the source of truth for the policy.

The instance-level unlock is the exception: it is instance-scoped, not org-scoped, so it follows the
existing singleton-table precedent (migrations 0029/0035/0036) with operator-token-gated writes.

### 5.4 Vocabulary

"Subscription" collides with the existing `notification_bindings` vocabulary. Per CLAUDE.md,
`docs/GLOSSARY.md` is authoritative and new vocabulary belongs there with the reasoning in a
terminology ADR — **not defined ad hoc in this proposal**. See §10 Q5.

---

## 6. Piece 3 — detection

### 6.1 Internal — "released to production"

There is no event to subscribe to (§2). The signal has to be **derived**:

`scp.change.transitioned` (`toState = accepted`) → the change's wave targets → each target's
`deployment-target.properties.environment === 'prod'` → the component placed there → the dependency
lines that component **declares it publishes** (§4.4) → record a new version observation on those lines.

Three properties of that path matter:

- `accepted` is **human-gated** for forward changes, so "released to production" means a human accepted
  it — which is the right meaning;
- rollback changes **auto-accept**, so the derivation must not treat a rollback as a release;
- the transition is journaled as `entryKind: 'change_status'` **except when the change is domain-local**
  (`transition.ts:337-360`), so a commander learns of an outpost's prod acceptance — but **never for
  domain-local work**, by ADR-0031's design. Domain-local internal dependencies are therefore
  domain-visible only. That is correct, and it must be stated rather than discovered later.

### 6.2 Third-party — the daily check, and the air-gap shape

The requirement says once per day. The charter says no runtime network calls to the outside world, and
the chart ships default-deny egress. Both can hold, because they are different domains:

- **Connected domains:** a daily job resolves versions through a **`PackageIndexPlugin`** (one per
  ecosystem), so the existing egress guard, host allowlist and SSRF controls apply unchanged. Two
  traps: redirects are hard-disabled on the plugin HTTP client and registries redirect routinely; and
  the chart's `networkPolicy.executorEgress` is **empty by default**, so this fails as a plugin HTTP
  error rather than a config error unless the operator allowlists the host.
- **Air-gapped domains:** copy the **Trivy DB shape**, which is the only shipped external-feed pattern —
  an operator-loaded, cosign-signed feed with a **fail-closed staleness policy**. Not a poll.
- **Neither available:** third-party detection is simply **unavailable** and the feature degrades to
  internal dependencies. Stated, not silently degraded.

**The daily job must not run everywhere.** There is no trustworthy runtime commander/outpost predicate
— `config.federationRole` is install-time and `self_domain.role` is per-org and advisory — so a job
dropped into `main.ts`'s background block **runs on air-gapped outposts too**. The job needs an
explicit guard, and the guard needs a test.

Cadence follows the shipped idiom: a self-rescheduling pg-boss tick with `startAfter` + `singletonKey`
(there is no `boss.schedule` usage to copy), and it must run under `SCP_ROLE=all|worker`.

### 6.3 Container images — the fifth ecosystem, and the best-fitting one

**Owner direction, 2026-08-13: base images are in scope alongside the four language ecosystems.**

**The case, concretely (owner's framing):** a component's container is built `FROM alpine:1.0`. Alpine
publishes `1.1`. The component team subscribed to that image's `1.x` line, so the subscription **applies
the bump** — the `FROM` line becomes `alpine:1.1` — by the same actuator, gates and enablement chain as
a library bump. A base image is a dependency in exactly the sense this feature means, and images fit the
existing machinery better than any language ecosystem does:

- **The version index already exists.** An OCI registry is the index, and SCP already reaches registries
  with skopeo under `SCP_ARTIFACT_OCI_REGISTRY_HOSTS`, plus a Harbor plugin (ADR-0012). No new egress
  class, no new credential model.
- **Air-gap solves itself.** In an air-gapped domain the org's **own** Harbor/registry *is* the index.
  This is the only one of the five ecosystems that needs no operator-loaded feed and no degradation —
  the mirror is not a fallback, it is the normal answer.
- **Identity is already digest-shaped.** `ArtifactRef {type, digest}` is how SCP already names artifacts,
  and a bumped base image flows into the existing promotion **scan** gate naturally: the new image is
  scanned before it can cross a boundary, by machinery that is already built.
- **The internal case is strongest here.** "Team A published a new base image; every component built on
  it should pick it up" is precisely the internal-dependency story, and the publishing team is already
  modelled.

Two cautions specific to images:

- **Image tags are not semver.** `1.2.3`, `1.2.3-alpine`, `1.2`, `latest` and date stamps all coexist,
  and a registry has no notion of a "major line". A dependency-subscription line for an image therefore
  needs a **tag pattern plus a parsed-version extractor**, not bare semver comparison — and tags that do
  not parse must be **skipped, not guessed**.
- **Tag ≠ identity.** A mutable tag can be repointed at new bytes. The subscription must record the
  **digest** it bumped to, so "we are on 1.2.3" is a statement about bytes rather than about a label.

Scope for the manifest source is the component's **own build input** (`Dockerfile` `FROM`), not its
deployment manifests — a Helm values image tag is a *placement* concern and belongs to the promotion
path that already exists, not to this feature.

### 6.4 Persist on change

Any per-tick verdict must use the **persist-on-change** guard (`insertDecisionIfChanged`) added after a
measured **1.44 GB/day** Decision write-amplification incident. A daily poll that re-writes a
byte-identical "no new version" Decision per dependency per tick would reproduce it exactly.

---

## 7. Piece 4 — the actuator

### 7.1 The six-gate test, run honestly

Run per (class-of-change, layer, domain), default verdict COORDINATE (ADR-0002 §3):

| Gate | Verdict for "bump a dependency version in a source repo" |
|---|---|
| 1 — no existing executor | **FAILS wherever Renovate/Dependabot exists** — that *is* the execution system for this class |
| 2 — declarative + idempotent | Holds — desired state is "version X in the manifest"; re-running converges |
| 3 — plannable | Holds — the diff **is** the reviewable evidence |
| 4 — reversible | Holds — revert, expressed as the same trigger verb with `rollback` intent |
| 5 — single-shot ephemeral runner | Holds — **only if the design does not resolve lockfiles** (§7.3) |
| 6 — narrowly-scoped short-lived creds | Holds — a per-run, per-repo, short-lived token |

**Gate 1 is the one that fails**, and ADR-0002's router is explicit: "If yes — coordinate, full stop."

### 7.2 Owner direction, and what it costs

**The owner selected Mode C — SCP authors the commit itself — on 2026-08-13**, after this gate-1
analysis was put to them. Recorded as a decision, with its costs stated rather than softened:

- It requires a **charter amendment** adding a new enumerated managed class. Repo-**write** credentials
  are a credential class SCP has never held; the existing enumerated class "operating-system package
  install, upgrade, and version pinning" is **host** packages, not source manifests, and does not cover
  this.
- To keep gate 1 coherent, **opting a component in must itself be the gate-1 flip** — enabling
  subscriptions for a component *declares SCP the execution system for that class in that domain*.
  This mirrors ADR-0002 §4's "bundling flips gate 1", in the opposite direction.
- That makes **conflict detection load-bearing, not a nicety**: if the repo still carries
  `renovate.json` or `dependabot.yml` covering the same manifests, two bots fight over the same file.
  Enablement must refuse, or at minimum warn loudly, when a competing bot config is present.
- ADR-0002 rejects tenant-authored scripts in the managed tier "unconditionally", with the closed
  signed catalog as "the load-bearing line". A version bump is a **parameterised catalog operation**
  (set field *F* in manifest *M* to value *V*), not arbitrary authored content — that argument must be
  made explicitly in the ADR rather than assumed.

### 7.3 The lockfile is where this becomes CI

ADR-0002's **anti-CI corollary**: a class needing artifact build, compile, or test orchestration is
"CI/CD by definition — coordinate, never manage".

A manifest-only edit (bump the version string, let the org's CI resolve the lock) stays inside the
managed tier and keeps gate 5. **Running `npm install` to regenerate a lockfile is running the package
manager**, which is tooling execution, breaks gate 5's "no build farm, no compilation", and trips the
anti-CI corollary directly.

**Recommendation: manifest-only edits. No lockfile resolution.** This is a real functional limit —
ecosystems with committed lockfiles will need their CI to resolve — and it must be stated in the ADR as
a scope boundary, not discovered during implementation.

### 7.4 Delivery — PR or auto-merge, per subscription

**The owner selected per-subscription choice on 2026-08-13.** PR-mode needs no merge credential and
matches the propose-only doctrine. Auto-merge additionally needs a merge credential and a CI-green
gate, and it must be expressible as a governed control so the existing gate machinery — not new code —
decides whether a bump may merge.

### 7.5 Shape

`scp-managed-dep` follows the two shipped managed executors exactly: a plugin behind the standard
executor interface (`packages/plugins/managed-iac/src/index.ts` is the template), server-injected and
never tenant-supplied runner settings (`coordination/executor-bindings-repo.ts:455-550`), single-shot
ephemeral runners from a separate pinned image, scoped vaulted credentials from the existing
AES-256-GCM `secrets` table.

Two structural cautions:

- **Do not add a fifth executor verb.** The four-verb set **is** the structural enforcement of charter
  principle 1; a `write` verb removes the enforcement mechanism rather than extending it.
- **Do not thread authored content through `TriggerIntent.parameters`.** Nothing on the server
  populates `parameters` today, and `managed-iac`'s `intent.parameters.sourceFiles` **looks** like a
  precedent for "SCP writes code" but is not one — nothing ever populates it and it writes into an
  ephemeral workspace, never a repo. Citing it would be wrong.

### 7.6 Provenance loop

Every `change` today correlates to an **observed external event** via `source_mappings`. A commit SCP
authored will be observed back in as if externally sourced. The bump change must be recorded such that
the returning webhook **correlates to it** rather than minting a second, unrelated change.

---

## 8. What this reuses rather than reinvents

- **Fan-out → campaigns.** "Bump every subscriber of acme-lib" is one intent fanned to N components,
  one member change each, in waves, with gates and rollback — a **shipped** engine
  (`campaign-reconcile.ts:319`). A second fan-out engine would duplicate it. Its three documented
  limits (cannot adopt an arrived change, single-purpose, ships past a failed wave) must be confronted.
- **Wait predicate → `provides`/`requires`.** An internal bump that must wait for the provider to reach
  production is precisely the shipped coupling: park in `waiting` until some change `provides` that key
  at that object (`coupling.ts:38-50`). Its owner-settled rulings (keys are never derived; `at` must
  resolve to a real object; the predicate is `validating|accepted`; wait forever + 24h warn) are prior
  art to adopt or explicitly argue against.
- **Multi-level resolution → `scan-requirements.ts`** (§5.1).
- **External feed → the Trivy DB shape** (§6.2).

**Do not reuse `correlation_key`** as the subscription key: it is already populated org-wide with
colliding values (`refs/heads/main`) by the github plugin, so the first satisfied release would satisfy
every waiter.

---

## 9. Proposed milestone — M21

**Goal:** a component team can subscribe to a dependency's major line, at a chosen granularity, and
receive the bump as an automatic code change — with a three-level enablement chain that keeps ingestion
scoped to what is actually subscribed.

**Contents:**

- **M21.1 — Vocabulary + governing docs.** GLOSSARY entries settling `subscription` against
  `notification_bindings`; ADR-0032; the charter amendment for the new managed class; this proposal.
- **M21.2 — Inventory substrate.** Migration 0061: `dependency_lines` + `component_dependencies`
  projection tables. The `readFileAtRef` `GitProviderAdapter` hook + three adapter implementations.
  Manifest parsers for all five ecosystems, in the §10 Q3 order (Go → images → npm → Python → Maven).
  Propose→accept wiring.
- **M21.3 — Enablement chain.** The instance singleton, the component-level graph object, the
  per-dependency opt-out, and `resolveEffectiveSubscription` with per-level contributions. Ingestion
  work-list derived from it.
- **M21.4 — Detection.** The internal derivation (§6.1) and the daily third-party job (§6.2), with the
  role guard, the persist-on-change guard, and the air-gap operator-load path. Five version indexes:
  the Go module proxy, an OCI registry index reusing the existing skopeo/Harbor reach (§6.3), the npm
  registry, PyPI, and Maven Central.
- **M21.5 — Actuator.** `scp-managed-dep`: the plugin, the runner image, credential scoping, conflict
  detection against `renovate.json`/`dependabot.yml`, manifest-only edits, PR and auto-merge modes,
  provenance-loop correlation.
- **M21.6 — UI.** Deferred to the end and handed to the UI agent, per the owner's instruction.

### Definition of done

Each item names the test file, is mutation-proven, and carries a negative control.

- **Enablement is a monotone AND** — `subscription-enablement.test.ts`: instance-off forces off at every
  level; instance-on alone activates **nothing**; a per-dependency opt-out subtracts exactly one line.
  Negative control: with all three on, a bump **is** proposed (a test proving nothing happened is
  vacuous unless it also proves something did). Mutation: flipping the AND to an OR fails the suite.
- **Ingestion is scoped** — `dependency-ingestion.integration.test.ts`: a disabled component and an
  opted-out dependency are **never** fetched, asserted against a recording fake index. Negative
  control: an enabled one **is** fetched. Mutation: removing the work-list filter fails it.
- **No transitive traversal** — a test asserting the inventory queries are single-hop and that no
  recursive CTE is reachable from the dependency path (the measured 5s/408 hazard).
- **`depends_on` is untouched** — a test asserting package dependencies mint **no** `depends_on` edge,
  so the plan compiler's toposort and cycle check cannot see them.
- **Daily job does not run on outposts** — an explicit role-guard test; negative control that it **does**
  run on a commander.
- **No Decision write amplification** — a two-tick test asserting the second identical poll writes **zero**
  new Decision rows (`insertDecisionIfChanged`).
- **Air-gap** — a test that with no index plugin and no operator-loaded feed, third-party detection
  reports unavailable and **does not** attempt egress.
- **Actuator authors manifest-only** — a test that no lockfile is regenerated and no package manager is
  invoked; and a conflict test that enablement refuses when `renovate.json`/`dependabot.yml` covers the
  same manifest.
- **Provenance loop** — the returning webhook for an SCP-authored commit correlates to the originating
  change rather than minting a second one.
- **Unparseable image tags are skipped, never guessed** — `image-line.test.ts`: a line whose registry
  returns `latest`, `1.2`, `1.2.3-alpine` and a date stamp bumps **only** on the tags its extractor
  actually parses, and records the **digest** it moved to. Negative control: a well-formed `1.2.4` on
  the subscribed line **does** bump. Mutation: making the extractor fall back to string ordering fails it.
- **Image lines need no external feed in an air-gapped domain** — a test that with only an org-local
  registry configured, image detection works fully while the four language ecosystems report
  unavailable. This is the §6.3 claim, and it is the one that would otherwise be assumed rather than
  proven.

---

## 10. Decision points

### Q1 — Actuator mode. **DECIDED (owner, 2026-08-13): Mode C.**

SCP authors the commit itself, over Mode A (coordinate the org's existing bot) and Mode B (bundle
Renovate). Gate 1 of the six-gate test fails wherever a bot exists, so this needs the charter amendment
in §7.2 and the gate-1-flip framing to stay coherent.

### Q2 — Does the inventory live in the graph or in a projection table? **DECIDED (owner, 2026-08-13): projection table, subscription as a graph object.**

Charter principle 2 says graph-native. §2 measured four reasons the *inventory* cannot be: URN collision
on package coordinates, write amplification, the federation type hazard, and the CTE blowup. The
**inventory** is derived, per-domain, high-churn observation data and lands in a projection table
alongside `change_source_events` and `object_health`; the **dependency subscription** is declared config
and lands as a graph object so it federates under ADR-0022 clause 2 (§5.3).

This is DESIGN §5's closure-table escape hatch used for the case it anticipated. The ADR must record it
as a **deliberate, scoped bend of principle 2** with the four measurements as its justification — not as
an oversight — and must state the boundary: nothing in the dependency path may expose a transitive
traversal, because that is what would make the graph representation necessary again.

### Q3 — Which ecosystems ship in M21? **DECIDED (owner, 2026-08-13): all five — npm, Go, Maven/Java, Python, and container images.**

Each is a manifest parser plus a version index. Images were added by the owner and are covered in §6.3;
they are the best-fitting of the five (existing OCI identity, existing registry reach, and an air-gap
story that needs no operator-loaded feed).

**Sequencing recommendation within M21.2/M21.4** — this is five parsers and five indexes, so build them
in an order that surfaces the hard problems early rather than last:

1. **Go** — trivial parse, clean module-proxy index, no lockfile. Proves the whole path end-to-end.
2. **Images** — proves the air-gap shape and the tag-is-not-semver problem (§6.3).
3. **npm** — the repo's own ecosystem, so fixtures are real; first ecosystem where the manifest-only
   lockfile limit (§7.3) actually bites.
4. **Python** — declared-vs-pinned messiness.
5. **Maven** — XML plus parent-POM inheritance, the most work; last deliberately.

### Q4 — Delivery mode. **DECIDED (owner, 2026-08-13): per-subscription choice of PR or auto-merge.**

Auto-merge needs a merge credential and must express its CI-green condition as a governed control.

### Q5 — What do we call it? **DECIDED (owner, 2026-08-13): "dependency subscription", always qualified.**

Never bare *subscription*, which stays with `notification_bindings`. Lands as a GLOSSARY.md entry in
M21.1 before any code, per CLAUDE.md, with the reasoning recorded on ADR-0032.

### Q6 — Does the importer get a tolerance clause first? **NO LONGER A PREREQUISITE (resolved 2026-08-13 by [ADR-0032 §3a](../adr/0032-dependency-subscriptions.md)); still open as general hardening.**

M21 ships **no new built-in object or relationship type**: a dependency subscription is a
`dependencySubscription` effect on an ordinary `policy` object, mirroring `scanThreshold` (ADR-0016).
`policy` exists on every instance and `policy_upsert` shares the importer's `object_upsert` case, so
nothing in this feature can wedge an outpost's channel. The question below is now decoupled from M21.

**Two corrections to it, measured while settling §3a.** The failure mode is a Postgres **foreign-key
violation (23503)**, not a 404: `objects.type_id` references `object_types.id` and `objects-repo.ts`
performs no type-existence check, so the constraint is what fires. Consequently the fix **cannot** be a
copy of `relationship_upsert`'s skip-on-400 (`import-repo.ts:283`) — that catch tests
`err instanceof ProblemError && err.status === 400`, and an FK violation is neither. Anyone picking
this up should start from `isForeignKeyViolation` (`db/pg-errors.ts:45`), and should decide
deliberately whether skipping is even the right behaviour: unlike a one-sided edge, a skipped **object**
leaves every edge referencing it dangling — which is the shape [ADR-0026](../adr/0026-placements-and-derived-stage-names.md)
measured silently disabling 11 required prod-gate policies.

*Original question, retained:* if anything in this feature adds a built-in object type, the importer's
`object_upsert` branch needs a tolerance clause **shipped and fleet-deployed first**, or the first
journaled object wedges a not-yet-migrated outpost's channel.

---

## 11. A security finding, independent of this feature

SCP's github plugin authenticates as a **GitHub App installation token**
(`packages/plugins/github/src/index.ts:160-182`). The App's granted permissions are configured **on
GitHub, outside SCP**. SCP's code never uses write scopes — but "SCP holds no repo-write credential" is
a statement about the *code*, not about the *installation*.

**If the live installation has been granted `contents:write`, that authority exists today**, unused and
ungoverned, regardless of whether this feature ships. That should be checked against the real
installation and, if present and unneeded, revoked — separately from M21.
