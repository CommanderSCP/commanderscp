# Dependency subscriptions — subscribe to a major line, receive the bump automatically

**Status:** **Accepted (2026-08-17)** — the feature is built and merged (M21.1–M21.7), which is what
moves this off *Proposed*. Five of six decision points were settled with the owner on 2026-08-13
(§10 Q1–Q5). **Q6 never became a prerequisite** — [ADR-0032](../adr/0032-dependency-subscriptions.md)
§3a made the subscription a `dependencySubscription` effect on an ordinary `policy` object, so M21
ships no new built-in type and can wedge no field outpost's channel; Q6 survives below as general importer
hardening, tracked apart from this proposal rather than as an open decision blocking it.
**Two axes of the reasoning below are superseded, each marked in place:** all dependency automation is
commander-only ([ADR-0032](../adr/0032-dependency-subscriptions.md) §7d, owner decision 2026-08-17),
and the ground for the group-scope authoring refusal is corrected by
[ADR-0032](../adr/0032-dependency-subscriptions.md) §6a-ii (2026-08-17) — the refusal stands in both
directions; its "permanently inert" reasoning does not.
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

- ADR-0022 clause 2: commander-declared config that must reach a **field** outpost **must be a graph
  object riding `object_upsert`** — the journal has nine entry kinds and **nothing table-shaped can
  travel**. So an enablement bit in a `scan_requirement_floors`-style table can **never** reach a
  field outpost. (Nothing has to *reach* the HQ outpost: it is the commander's own domain, so the row
  is already there.)
- But a new **built-in** object/relationship type is **not a safe migration in a running fleet**: the
  importer's `object_upsert` branch has **no try/catch** (`apps/server/src/federation/import-repo.ts:189-215`)
  and `createObject` 404s on a type not registered locally, so the first such object journaled to a
  not-yet-migrated **field** outpost **aborts the whole signed bundle and wedges that channel**.
- And a **runtime** custom type via `POST /type-registry` **federates to nobody** — there is no
  `object_type_upsert` journal kind.
- The charter requires a disconnected domain to keep operating, so a **commander-only dependency
  database is a charter conflict**, not merely an availability concern.
  > **OVERTAKEN 2026-08-17 — [ADR-0032](../adr/0032-dependency-subscriptions.md) §7d, owner
  > decision.** ALL dependency automation is commander-only and no **field** outpost holds a
  > dependency inventory (the HQ outpost is the commander, so its inventory is the commander's —
  > ADR-0032 §7d's vocabulary note). This bullet is preserved because it is the strongest form of the argument that was
  > overturned, and because the clause it produced (ADR-0032 §3's "each domain derives its own") is
  > cited by both loop module docs and by §4a clause 7. What it misreads: a disconnected domain
  > keeps **operating** — it deploys, gates, coordinates and receives promotions exactly as before —
  > it merely never ORIGINATES a dependency bump, which is a capability it does not need, because
  > the resulting change is pushed down the global pipeline the commander manages. Dependency
  > automation exists to pull from **public** repositories, which a disconnected domain cannot reach
  > in any case. The real cost is narrower and §7d states it: dependencies declared in
  > **domain-specific repositories the commander never sees** are out of scope.

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

> **"An operator accepts it" through WHAT? — see [§12](#12-the-producer-declaration-has-no-authoring-surface--design-2026-08-17)
> (added 2026-08-17).** This clause promised an acceptance surface and never named one, and as built
> there is none: `declareDependencyLineProducer` has no non-test caller, so in production the link is
> never set and the internal ingress cannot fire. §12 designs the surface — and finds that the grain
> this clause assumes (per line) is the wrong one: the fact is per *coordinate*, and per-line grain
> silently re-arms dependency confusion at every new major.

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

By ADR-0022 clause 2, config that must reach a **field** outpost **must ride `object_upsert`** — and every
table-shaped precedent (`scan_requirement_floors`, `executor_bindings`, `source_mappings`) is
**provably unable to travel**.

So the split is:

- **inventory** (derived, per-domain, high-churn) → **projection table**, does not federate, each
  domain derives its own;
- **subscription + enablement** (declared config, low-churn, must reach field outposts) → **graph
  object**, federates.

> **Amended 2026-08-17 — [ADR-0032](../adr/0032-dependency-subscriptions.md) §7d, owner decision.**
> The **second** bullet is unchanged: the subscription is a graph object, it federates, and a field
> outpost still receives it. The **first** is half-retired — the inventory is still a projection
> table that does not federate, but it is **not** per-domain and no domain but the commander derives
> one. All dependency automation is commander-only, because the feature pulls from **public**
> repositories and a field outpost never originates a bump — it receives the resulting change down
> the commander's global pipeline. Accepted cost: dependencies declared in field-outpost-only
> repositories are out of scope; a repository specific to the HQ domain is in scope like any other
> the commander can see.

This split is what lets a disconnected domain keep operating (§2's charter conflict) while keeping the
commander the source of truth for the policy.

The instance-level unlock is the exception: it is instance-scoped, not org-scoped, so it follows the
existing singleton-table precedent (migrations 0029/0035/0036) with operator-token-gated writes.

### 5.4 Vocabulary

"Subscription" collides with the existing `notification_bindings` vocabulary. Per CLAUDE.md,
`docs/GLOSSARY.md` is authoritative and new vocabulary belongs there with the reasoning in a
terminology ADR — **not defined ad hoc in this proposal**. See §10 Q5.

### 5.5 How a component team actually turns their own switch on (added 2026-08-17, M21.7)

§5.1 calls `component_enabled` "the team's own switch" and §5.3 says the switch is a graph object.
Neither said what a team **sends**, and the one field that decides whether a component team's request
succeeds — **`domainId`** — appeared **zero times** in this proposal or in ADR-0032 until this
section was written. The capability shipped with M21.3 and has been asserted by a test ever since;
it was simply not written down anywhere a team would look. The full argument is
[ADR-0032 §8g](../adr/0032-dependency-subscriptions.md); this is the short form.

A team owning component `11111111-1111-1111-1111-111111111111` subscribes with:

```http
POST /api/v1/policies

{
  "name": "deps-checkout-api",
  "domainId": "11111111-1111-1111-1111-111111111111",
  "properties": {
    "enforcement": "advisory",
    "scope": { "objectRef": "11111111-1111-1111-1111-111111111111" },
    "effects": [{ "dependencySubscription": { "enabled": true } }]
  }
}
```

The same component id appears twice and answers two different questions: `domainId` is **custody**
(where the row is placed, and therefore who may later edit or delete it), `scope.objectRef` is
**jurisdiction** (what the policy reaches). Placement bounds reach not at all — see
`apps/server/src/governance/policy-scope-authz.ts`, which is the authority for that separation.

**The component's own id is the right value because it is the only one that works for all three
actor shapes.** Authority expands strictly upward from the scope object, so a `domainId` of the
component is accepted whether the author's `policy:write` sits at the component, at its containment
domain, or at the org root. Sending the component's **containment domain** instead — the intuitive
choice — works only for the latter two, and so excludes precisely the component-bound team this flow
exists for.

**Omitting it is the trap.** `domainId` is optional and defaults to **the org root**, so the custody
check runs there and a narrowly-bound author is refused with
`403 subject '<uuid>' lacks 'policy:write' at scope '<org-root-uuid>'` — a bare uuid for a scope they
never asked for, with nothing to suggest that an omitted field is the lever. The natural reading is
"component teams can't do this", which is false. The refusal is correct; the discoverability was
not, which is why the fix is documentation at every authoring surface rather than a change to the
check.

The CLI and IaC surfaces carry the same field with the same default: `scp policy register
--domain-id <component-id> …`, and `domainId` on a manifest object (see ADR-0032 §8g for the literal
manifest).

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
  (`transition.ts:337-360`), so a commander learns of a field outpost's prod acceptance — but **never for
  domain-local work**, by ADR-0031's design. Domain-local internal dependencies are therefore
  domain-visible only. That is correct, and it must be stated rather than discovered later.

> **Amended 2026-08-17 — [ADR-0032](../adr/0032-dependency-subscriptions.md) §7d, owner decision.**
> Internal detection is **commander-only**, so "domain-visible only" is now the weaker statement:
> a domain-local release's head is recorded **nowhere**, and domain-local internal dependencies are
> out of scope. The same reversal costs the ingress its reach into **field** outposts generally — a
> commander receives `change_status` journal entries and **not**
> `change_wave_targets`/`observed_state.images`, so an internal line whose component releases to prod
> only at a field outpost keeps a **NULL** `latest_version`, which is an honest "not observed" rather
> than a wrong version. A component releasing to prod in the HQ domain is unaffected: that evidence
> is written locally. Both are stated costs of the decision, not oversights in it.

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
dropped into `main.ts`'s background block **runs on air-gapped field outposts too**. The job needs an
explicit guard, and the guard needs a test.

> **Widened 2026-08-17 — [ADR-0032](../adr/0032-dependency-subscriptions.md) §7d, owner decision.**
> This is no longer only about "the daily job". **NO dependency job runs anywhere but the
> commander** — inventory ingestion, internal release detection, the poll, the bump dispatcher and
> the auto-merge gate — and every one of them is fail-closed on an undeclared `SCP_FEDERATION_ROLE`.
> The reason above (an unguarded timer dialing the public internet from an air-gapped site) is still
> true of the poll, but it is not the reason for the others: dependency automation exists to pull
> from **public** repositories, which a **field** outpost has no need to do, because the resulting
> change is pushed down the global pipeline the commander manages. The HQ outpost is not an exception
> to this rule and is not exempted by it — it is the commander, so the jobs already run there.

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

~~Scope for the manifest source is the component's **own build input** (`Dockerfile` `FROM`), not its
deployment manifests — a Helm values image tag is a *placement* concern and belongs to the promotion
path that already exists, not to this feature.~~

> **SUPERSEDED (2026-08-17, owner ask in M21.7) — see
> [kubernetes-image-references.md](kubernetes-image-references.md).** The struck sentence reasoned
> about *who owns the change* (promotion owns placement — true) and concluded *therefore SCP does not
> record the declaration*, which does not follow. Most Kubernetes users pin image versions in Helm
> values rather than in a `FROM` line, so under the struck rule such an image did not appear in the
> inventory **at all**: it read as "no dependency" rather than "unsupported", which is the class of
> dishonesty ADR-0032 §4a/§7b exists to prevent. The `oci` ecosystem, the line identity, the version
> comparison, the poll, the subscription model and the bump actuator all carry the widened scope
> unchanged. The same claim is repeated as a code comment in
> `packages/dependency-manifests/src/dockerfile.ts:31–33`; correcting it is a build-round item of the
> superseding proposal.

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
- **NO dependency job runs on a FIELD outpost** ([ADR-0032](../adr/0032-dependency-subscriptions.md)
  §7d, owner decision 2026-08-17; this read "daily job" and covered only the poll) — an explicit
  role-guard test per job, with the negative control that each **does** run on a declared commander.
  There is no HQ-outpost process for such a job to run on, so the guard's non-commander refusal is
  exactly the field case.
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
nothing in this feature can wedge a field outpost's channel. The question below is now decoupled from M21.

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
journaled object wedges a not-yet-migrated field outpost's channel.

---

## 11. A security finding, independent of this feature

SCP's github plugin authenticates as a **GitHub App installation token**
(`packages/plugins/github/src/index.ts:160-182`). The App's granted permissions are configured **on
GitHub, outside SCP**. SCP's code never uses write scopes — but "SCP holds no repo-write credential" is
a statement about the *code*, not about the *installation*.

**If the live installation has been granted `contents:write`, that authority exists today**, unused and
ungoverned, regardless of whether this feature ships. That should be checked against the real
installation and, if present and unneeded, revoked — separately from M21.

---

## 12. The producer declaration has no authoring surface — design (2026-08-17)

**Status: proposed, pending owner review. Design only; nothing here is built.** This section completes
[§4.4](#44-internal-vs-third-party-is-a-property-of-the-package-and-it-is-declared), which said "an
operator accepts it" and never said through what.

### 12.0 The defect, measured

`dependency_lines.produced_by_object_id` is what `isInternalDependencyLine`
(`packages/schemas/src/dependencies.ts:144`) reads to decide a line is internal. It is written by
exactly one function, `declareDependencyLineProducer`
(`apps/server/src/dependencies/dependency-inventory-repo.ts:207`), and a filterless census of that
symbol finds **no non-test caller**: no route, no CLI verb, no job, no IaC construct.

So in production the column is never set, `isInternalDependencyLine` is always false, and **the
internal half of the feature cannot fire at all** — half of what was asked for ("internal
dependencies update the database once released to production"). Third-party polling works; internal
release detection derives lines for the empty set of declared producers. This is the same
built-never-installed shape §8a's own header records for M21.5, one layer down.

**What must NOT be the fix.** `internal-release-detection.ts:747-752` and `schema.ts:1809-1824` state
the property: the producer link is **declared, never inferred**, and the capability is **absent from
the ingestion verb** rather than guarded on it — `UpsertDependencyLineInputSchema` has no producer
field and `upsertDependencyLine`'s `ON CONFLICT` set list cannot reach the column. Wiring the link
into ingestion would delete the property and call it a completion. **The missing piece is an
authoring surface for a deliberately manual declaration.**

### 12.1 The grain — per COORDINATE, in a new table, not per line

**The fact and the row disagree.** A `dependency_lines` row is identified by
`(org_id, ecosystem, coordinate, major)` (`schema.ts`, `dependency_lines_identity`), so a declaration
written onto it is **per major line**. But "component X publishes `@acme/lib`" is a fact about the
coordinate, true across every major X has ever cut.

**How lines come into existence is what settles it.** `upsertDependencyLine` has exactly one
non-test caller — `placeDeclarationOnLine` (`inventory-ingestion.ts:1333`) — and it mints a line
from a **consumer's** `DeclaredDependency`. Nothing mints a line from the package a component
*publishes*: SCP has no artifact name at all (§2), and ingestion reads a manifest's dependencies, not
its own `name` field. Two consequences, and the second is the crux:

1. **A producer with no consumers has nothing to attach to.** Declaring "X produces `@acme/lib`"
   before any component in the org depends on it has no row to write, so a per-line declaration is
   *unrepresentable* until the first consumer's manifest is ingested. The declaration would have to
   be ordered after an event the declarer does not control.

2. **Every new major silently re-arms dependency confusion.** X releases `3.0.0`; the first consumer
   moves to `^3`; ingestion mints a **new row** with `produced_by_object_id = NULL`. That row is now
   third-party *by honest default*, and once any component subscribes to it,
   `buildLineWorkList` (`version-poll.ts:215`) will hand `@acme/lib` to a **public index plugin**.
   That is precisely the failure §7b clause 1 names — "a stranger's package sharing the coordinate
   answers `9.9.9`… every subscriber is bumped onto it… delivered by a background job on a daily
   timer, with no error anywhere."

   The two structural barriers built against that failure do not help here, and understanding why is
   the whole argument. `listThirdPartyDependencyLinesByIds`
   (`dependency-inventory-repo.ts:566`) narrows in SQL on `produced_by_object_id IS NULL`, and
   `asThirdPartyLine` (`line-head.ts:108`) re-reads the same column to mint the brand. **Both
   barriers protect the column's meaning. Neither can protect a column nobody filled in** — and on a
   fresh major nobody has. Per-line grain converts "declare once" into "re-declare at every major
   bump", an obligation that fails silently in the dangerous direction.

**Therefore: per coordinate, and it needs a new table.** There is no existing row keyed by
`(org_id, ecosystem, coordinate)`, and the declaration must be able to exist with **zero** lines, so
it cannot live on a row that ingestion owns.

```
dependency_line_producers
  org_id                  uuid    not null
  ecosystem               text    not null
  coordinate              text    not null   -- verbatim, case-preserved, never slugified (§3)
  producer_object_id      uuid    not null   references objects(id)
  declared_at             timestamptz not null
  declared_by_object_id   uuid    not null   references objects(id)
  unique (org_id, ecosystem, coordinate)
  index  (org_id, producer_object_id)
```

Every column is `NOT NULL`, which **retires** `dependency_lines_internal_is_declared`: that CHECK
exists only because three columns hang off a row that exists for another reason. Here the row's
existence *is* the declaration, so a half-written declaration is not representable rather than
refused.

**What happens to `dependency_lines.produced_by_object_id`.** Drop it, with its two companions, the
`dependency_lines_org_producer` partial index and the CHECK — expand/contract, backfilling the new
table from any non-null rows first (provably none in production, by §12.0; not none in dev and test
fixtures). Readers move as follows, and the important part is that **both barriers keep reading one
thing**:

| reader | today | after |
|---|---|---|
| `listThirdPartyDependencyLinesByIds` | `isNull(produced_by_object_id)` | **anti-join** on `dependency_line_producers` by `(org_id, ecosystem, coordinate)` |
| `asThirdPartyLine` | re-reads the column | constructor takes the joined "no declaration for this coordinate" fact |
| `listProducedLines` (`internal-release-detection.ts:760`) | partial index on the column | X's coordinates from `(org_id, producer_object_id)`, then lines by `(org_id, ecosystem, coordinate)` — a **prefix of the existing `dependency_lines_identity` index**, so no new index is needed |

The rejected alternative deserves naming, because it is the tempting one: **keep the column as a
materialized projection and have `upsertDependencyLine` stamp it at mint time from the declaration
table.** It closes the new-major hole with no human step, and the value it copies is a prior human
declaration rather than anything read out of the manifest. Reject it anyway: it puts a
`produced_by_*` write back inside the ingestion verb, which deletes the "the capability is absent
from ingestion" property and makes `schema.ts:1819`'s comment false. The join makes the projection
unnecessary instead of making it safe — a new major of a declared coordinate is internal **from the
instant it is minted**, because there is no per-major field to populate.

**Per-coordinate is also the safer grain, not merely the tidier one.** Under per-major grain an org
could model "we produce `@acme/lib@2`, upstream produces `@acme/lib@1`" — and that shape means the
same public index legitimately answers for a coordinate the org also publishes, which is
dependency confusion with a data model behind it. Coordinate grain refuses to represent it: once the
org declares it produces a coordinate, **no major of it is ever asked of a public index.**

**The cost of that, stated honestly.** An org that consumes upstream `requests` from PyPI *and*
publishes a private package also called `requests` gets one answer for both, and declaring the
producer stops the upstream one being polled — losing its security-update path, silently. Per-major
grain would not fix this; it would split the wrong answer across majors. The ambiguity is in the line
identity, which carries no registry host, and the real fix is registry-scoped coordinates — a
separate and much larger change. **Accepted limitation, recorded rather than designed around.**

### 12.2 The authority — `policy:write` at the org root, and **this is an owner decision**

**I agree it is an owner decision, and recommend it be taken before the build starts.** Grounds:
it is the same class of question as §6a (who may author an effect with org-wide reach), the owner has
taken every comparable call in this feature directly (§7d, Q1–Q5), and the third option below cannot
be retrofitted cheaply once the second ships and estates are provisioned.

**The blast radius is what forces the question.** Declaring "X produces `@acme/lib`" changes
behaviour for **every other component in the org that depends on that coordinate**, in two directions
at once: their bumps start being triggered by X's production releases, *and* the coordinate stops
being polled against its public index. The declarer is affecting objects they may not own.

- **(a) The producing component's owner** — `object:write` at X, or an `owns` edge to X.
  **Insufficient, on this repo's own precedent.** `policy-scope-authz.ts:12-58` is the authority:
  custody of a row is not jurisdiction over what it reaches, and an actor holding authority at a
  single component "must still be refused an org-wide scope: custody was never evidence of
  jurisdiction". The mechanics agree — `scopeExpandCte` (`authz/resolve.ts:94-126`) expands strictly
  **upward**, so a component-bound principal reaches nothing sideways, and the consumers of
  `@acme/lib` are siblings, not descendants.

- **(b) `policy:write` at the ORG ROOT — recommended.** `policy-scope-authz.ts:107-116` already
  requires exactly this for "anything broader — … which can match objects org-wide … has org-wide
  blast radius". The producer declaration has org-wide blast radius in exactly that sense, so the
  established rule lands on the established answer. It adds no `Permission` union member
  (`authz/resolve.ts:26-43`), no seed change and no new binding to provision, and it is the same
  authority that can already author an org-wide `dependencySubscription` effect.

- **(c) A dedicated `dependency_producer:write`.** Buys real least-privilege: a platform or registry
  team could hold it without holding org-wide `policy:write`. Costs a new permission in the union, in
  the RLS/RBAC seed and in every estate's role bindings — and until those bindings are provisioned
  the surface is open only to principals who already hold (b). Named as the upgrade path; not
  recommended for the first cut.

- **(d) A two-party shape, worth putting in front of the owner as a real option.** The component
  team **proposes** ("X produces `@acme/lib`") and an org-root `policy:write` holder **accepts**.
  This is literally what §4.4 promised — "Discovery may propose the link; an operator accepts it" —
  and it gives the producing team the surface they will naturally reach for without giving them the
  reach. It costs a second state on the declaration row and a second verb.

**One check that is required under every option above.** The FK is `objects(id)` and is
**org-unbound** — stated at `dependency-inventory.integration.test.ts:1101` — so today a write can
name a deployment-target, a user, or another tenant's object. The verb must assert the producer is a
live, non-deleted object in the caller's org whose `type_id` is `component` or `service`.

**And a live half-working state to resolve while doing it.** `listProducedLines`
(`internal-release-detection.ts:754-758`) says "the producer link may name a component OR a service"
and then matches only against component ids taken from placements. **A `service`-valued producer
declaration therefore derives no head at all**, while still (correctly) removing the coordinate from
the third-party poll — the worst of both. Either the verb refuses `service`, or §7 says what a
service declaration derives. Recommend **refusing `service` in the first cut** and recording why.

### 12.3 The shape — a verb, on one of M20.4's three grounds, and honest about the other two

[ADR-0031 §6](../adr/0031-domain-local-objects-never-federate.md) chose
`POST /v1/objects/{type}/{id}/publish` as "a **verb, not a property write** … because it performs the
re-journal and the edge sweep, and an operator must be able to see that publication is an action with
an effect rather than a field edit. It is **one-way**, and the response reports exactly which edges
were published." Three grounds. Tested one at a time:

1. **Work beyond the field write — TRANSFERS, and more strongly than for publish.** The declaration
   removes every major of the coordinate from the poll's work-list and *moves the head-derivation
   ingress* for those lines from a public index to the org's own production releases. It also has to
   clear observation state (§12.3.2). None of that is visible in a field edit.
2. **One-way — DOES NOT TRANSFER.** Retraction is explicitly part of the concept
   (`DeclareLineProducerInputSchema`'s `null`). M20.4's strongest ground is absent here, and the verb
   should not borrow its rhetoric.
3. **A legible report — TRANSFERS, and is where the verb earns its keep.** The response should
   enumerate the lines the declaration now covers, each line's current head, and the count of
   subscribed components per line. **That list is the blast radius, and it is unguessable from the
   request** — the declarer names one coordinate and affects a set of repositories they cannot see.

So: **a verb, on grounds 1 and 3.**

#### 12.3.1 Surface

```
POST   /api/v1/dependencies/producers          { ecosystem, coordinate, producerObjectId, dryRun? }
POST   /api/v1/dependencies/producers/retract  { ecosystem, coordinate }
GET    /api/v1/dependencies/producers          ?ecosystem&coordinate  (list / point read)
```

The coordinate travels in the **body or the query, never a path segment** — the same choice
`GET /components/:idOrUrn/dependency-subscription` already makes (`dependency-subscriptions.ts:292-303`:
"the line arrives as a QUERY … a coordinate travels VERBATIM here"). Coordinates contain `/`, `@` and
`:` (`github.com/acme/lib`, `@acme/lib`, `docker.io/library/alpine`); path-segmenting one is a trap.

`dryRun` returns the same blast-radius report and writes nothing. It is not a nicety: it is the only
way the declarer can see whose repositories they are about to affect **before** they do.

The write is **commander-only on the federation axis only**, via `commanderOnlyFederationVerdict`
(`dependency-subscriptions.ts:447-451`) → `409`, for the reasons that route's header already gives —
"right request, wrong place", and a route must not carry the process axis. The **read** stays
tenant-facing.

A Decision (`insertDecisionIfChanged`) and an audit event accompany both verbs, per charter
principle 6: "which principal asserted this coordinate is ours, and what did that change" must be
answerable from the record, not from the row.

#### 12.3.2 Undeclaring — and the defect that makes it more than a delete

**A head, once written, has no reset path.** `recordDependencyLineHead`
(`dependency-inventory-repo.ts:277`) is the sole writer of the `latest_*` trio and refuses backward
movement (`evaluateHeadMovement`, `line-head.ts:293-350`). §7b clause 3's bounded exception rescues
only a stored value that is **not on the line as defined now**; a same-major, parseable, same-variant
version passes `lineAcceptsVersion` and therefore stands. No API resets the column.

Two consequences, in both directions, and neither is optional:

- **Retraction must clear the head.** The line returns to third-party polling carrying a head that
  the org's own releases put there. If the internal head was ahead of the public one — the ordinary
  case, `2.7.0` internal against `2.3.1` upstream — the coordinate is **wedged**: the poll refuses
  every real public version until upstream passes `2.7.0`, and refuses it as `behind_head`, which
  reads as normal operation.
- **Declaration must clear the head too, symmetrically.** A poisoned public head (the stranger's
  `9.9.9`) would otherwise survive the fix, and internal detection could never move the head down to
  the org's real `2.1.0`. Clearing is what makes the declaration actually undo the confusion it
  exists to prevent.

Clearing needs a writer of a trio that deliberately has exactly one. **Do not add a second writer.**
Add a `resetLineHead` branch *inside* `dependency-inventory-repo.ts` beside
`recordDependencyLineHead` — same `FOR UPDATE`, same Decision — reachable only from these two verbs,
named in the module header as the one exception, and pinned by a test that deletes the call and
watches a named test die. `NULL` after a reset is honest: §7's schema note already defines it as "not
observed", which is exactly the state.

**In-flight bumps are not recallable, and the design must say so rather than imply otherwise.** A
dispatched bump has left SCP: it is a pull request in another team's repository, or — under
`auto_merge` — a commit on their branch. `dependency_bump_authorships` rows with `merged_at IS NULL`
(`bump-authorship-repo.ts:162`) are the open ones. Retraction **stops future triggers only**; it must
not close or rewrite those rows, because doing so would assert SCP closed a PR it did not close. The
retraction's Decision should **name the open bump authorships that were in flight at retraction**, so
an operator has the list to go and close.

### 12.4 Federation — it must NOT federate, and the choice of storage is how that is decided

**Read both clauses, as asked.** §7c is about *how the ingresses run*, not about the table. The
federation statement is §3's "the inventory is a projection table" — and **§7d point 4 keeps exactly
that half while retiring the rest**: "*The inventory is still a projection table that **does not
federate**, and that half is what justifies the principle-2 bend; what changes is that it now exists
in exactly one place.*" So the two readings agree, and what holds now is: **does not federate, and
exists only at the commander.**

**Measured, not inferred:** a filterless census for `dependency_lines` / `dependencyLines` under
`apps/server/src/federation/` returns **nothing**. There is no export path. The non-federation is
structural, not a policy someone could forget to apply.

**Is the question moot? Yes — on two independent legs, and it is worth having both.** (i) Every
consumer of the declaration — internal detection, the version poll, the bump dispatcher — is
commander-only under §7d. (ii) The rows it qualifies exist only at the commander. Either leg alone
makes a field outpost's copy inert.

**But the moot-ness is conditional on a design choice that has to be made deliberately.** If the
declaration were modelled as a graph object — a `produces` relationship, or a `producedBy` policy
effect — it **would** federate, because `policy` does (§7d, "what does not change"). A field outpost
would then hold a declaration with no inventory behind it: a visible assertion nothing can act on,
which is the "true elsewhere, inert here" shape `dependencyManagement` exists to close. **So
`dependency_line_producers` is a projection table for a federation reason, not a storage-convenience
one**, and that sentence belongs in the ADR clause.

Residual, stated: the retrans / air-gap bundle path carries no dependency data, so an air-gapped
org's producer declarations are authored at its own commander. There is nothing to relay and no
bundle change.

### 12.5 What breaks if the declaration is wrong

Two wrong shapes, failing in opposite directions.

**(A) FALSE POSITIVE — declaring a coordinate the org does not produce** (a typo, the wrong
ecosystem, or claiming an upstream package).

1. **The coordinate leaves the third-party poll, permanently and silently.** Every subscriber stops
   receiving upstream version movement, *including security releases*. `latest_version` freezes and
   `NULL` reads as "not observed". This is the worse half precisely because the failure is an
   **absence** — there is no error, no unavailable verdict, nothing to alert on.
2. **The named component's releases start authoring other teams' commits.** X releases `4.2.0` of
   something else entirely; `resolveReleasedVersion` derives `4.2.0`;
   `recordDependencyLineHead` advances the `4` line of `@acme/lib`;
   `DEPENDENCY_LINE_HEAD_ADVANCED_EVENT` fires; `bump-dispatch` authors a bump in **every subscribing
   component's repository**, pinning a version that may exist in no registry at all. Under
   `delivery: auto_merge` that lands without human review.

**(B) FALSE NEGATIVE — failing to declare.** This is today's state for every org, and under per-line
grain it is also the state of every new major (§12.1). The coordinate is polled against a public
index while the org publishes it: §7b clause 1's named catastrophe, on a daily timer.

**What already bounds (A), and must be preserved:**

- **The three-level monotone AND.** `bump-dispatch` fans out through
  `listSubscribedComponentLines` (`bump-dispatch.ts:501`), so a wrong declaration reaches only
  components whose own team enabled the subscription, on a deployment an operator unlocked. It is not
  org-wide in *effect*; it is org-wide in *reach*.
- **`assertComponentNotDelegated`** — a component running Renovate or Dependabot is refused.
- **The blast-radius report and `dryRun`** (§12.3), which make the reach visible before the write.

**Recoverability, in three unequal tiers — this is the plain statement asked for:**

| what | recoverable? |
|---|---|
| the trigger | **Immediately.** Retract, and no further bump is dispatched. |
| the stored head | **Only if retraction clears it** (§12.3.2). Without that clearing there is no path at all, and the coordinate stays wedged for as long as the wrong head is the greatest version anyone has seen. |
| bumps already authored | **Not by SCP, ever.** An open PR is another team's to close; a merged auto-merge bump is a bad commit on their main branch. SCP coordinates, it does not revert. |

The middle row is the one this design changes. The bottom row is why the authority question (§12.2)
is an owner decision and not a build detail.

### 12.6 What this proposes, in one list

1. New projection table `dependency_line_producers`, unique on `(org_id, ecosystem, coordinate)`,
   all columns `NOT NULL`; **not** a graph object (§12.4).
2. Expand/contract removal of `dependency_lines.produced_by_object_id` and its two companions, the
   partial index and the CHECK; readers move to a join and an anti-join (§12.1).
3. Declare / retract / read verbs under `/api/v1/dependencies/producers`, coordinate in body or
   query, commander-only on the federation axis, with a blast-radius report and `dryRun` (§12.3.1).
4. Authority: **owner decision** — recommended `policy:write` at the org root, with the two-party
   propose/accept shape as the live alternative (§12.2).
5. A `resetLineHead` branch in the module that already owns the `latest_*` trio, called on **both**
   declare and retract (§12.3.2).
6. Producer must be a live in-org `component`; `service` refused in the first cut, with §7 amended to
   say why (§12.2).
7. An ADR clause amending ADR-0032 §7 to record the grain, the authority and the federation choice —
   §7 currently describes a link with no way to create one.
