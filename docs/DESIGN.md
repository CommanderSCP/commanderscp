# CommanderSCP — Initial Design

| | |
|---|---|
| **Version** | 1.0 |
| **Status** | **Approved** — owner sign-off 2026-07-08 (review decisions logged in §19) |
| **Derives from** | [PROJECT_CHARTER.md](../PROJECT_CHARTER.md) — the charter is authoritative; where this document is silent, the charter governs. |

This design was synthesized from three candidate architectures (Simplicity-First, Federation & Air-Gap First, Extensibility & DX First) evaluated by a judge panel against the charter's Decision Priorities (1. Simplicity … 8. Developer Experience). The Simplicity-First candidate is the base; specific superior mechanisms from the other two are grafted in and called out with a "Why" wherever they appear.

---

## 1. Overview & Architecture Shape

CommanderSCP v1 is a **single TypeScript modular monolith ("scpd") plus PostgreSQL** — nothing else is required to run it. One Node.js/Fastify binary serves the versioned REST API, the static React Web UI, webhook receivers, and (via a role flag) the background reconciliation workers. PostgreSQL is the entire data plane:

- the **graph** (two generic tables — `objects` and `relationships` — with JSONB properties and a runtime type registry),
- the **event bus** (transactional outbox + LISTEN/NOTIFY + pg-boss durable jobs),
- the **scheduler**, the **policy store**, and
- the **hash-chained append-only audit log**.

Every domain — commercial, FedRAMP, IL5, air-gapped — runs this identical stack. "Federation" is the same binary exchanging signed, hash-chained sync-journal segments: automatically over HTTPS between connected domains, or as files walked across an air gap. `docker compose up` starts exactly two containers (app + postgres) and lands the user in a seeded organization in under five minutes.

Everything downstream derives from one source of truth: **Zod schemas** on Fastify routes emit the OpenAPI 3.1 spec at build time; the TypeScript SDK is generated from that spec; the CLI and the CDK-style IaC library are thin layers over the SDK, with desired-state reconciliation done **server-side** via plan/apply endpoints. Extensibility lives in six typed, host-mediated plugin interfaces (Executor, Control, Identity, Notification, FederationTransport, Discovery). The Coordination Engine is a persistent, resumable state machine over rows in Postgres — not an embedded workflow engine — and every transition it makes writes a **Decision record** explaining exactly which policies, controls, and graph facts produced the outcome.

**Why this shape.** The charter's #1 decision priority is Simplicity, and its self-hosting/air-gap requirements (priorities 5–6) punish every extra stateful service. A monolith + Postgres is the smallest system that satisfies the full MVP scope; the module boundaries inside it mirror the charter's Core Services list so later extraction is a deployment change, not a rewrite.

```
                        ┌─────────────────────────────────────────────────────┐
                        │                 CommanderSCP Domain                 │
                        │                (one per trust boundary)             │
                        │                                                     │
  Users ── Web UI ──┐   │  ┌───────────────── scpd (one image) ────────────┐  │
  (React SPA,       │   │  │ role=api                    role=worker       │  │
   static assets) ──┼──▶│  │ ┌──────────────┐            ┌──────────────┐  │  │
                    │   │  │ │ REST API v1  │            │ Coordination │  │  │
  CLI (scp) ────────┤   │  │ │ (Fastify+Zod)│            │ Engine loops │  │  │
                    │   │  │ │ Webhook      │  outbox    │ Policy eval  │  │  │
  SDK (TS) ─────────┤   │  │ │ ingress      │──events───▶│ Scheduler    │  │  │
                    │   │  │ │ SSE stream   │            │ Federation   │  │  │
  IaC (CDK-style) ──┘   │  │ │ plan/apply   │            │ sync         │  │  │
                        │  │ └──────┬───────┘            └──────┬───────┘  │  │
                        │  │        │      plugin host (v1)     │          │  │
                        │  │        │   (executor/control/identity/        │  │
                        │  │        │    notification/federation/discovery)│  │
                        │  └────────┼───────────────────────────┼──────────┘  │
                        │           ▼                           ▼             │
                        │  ┌─────────────────────────────────────────────┐    │
                        │  │              PostgreSQL 16+                 │    │
                        │  │  graph (objects/relationships) · outbox ·   │    │
                        │  │  pg-boss jobs · policies · decisions ·      │    │
                        │  │  audit chain · sync journal · schedules     │    │
                        │  └─────────────────────────────────────────────┘    │
                        │           │ (optional) object storage:              │
                        │           ▼  filesystem/PVC default, S3 provider    │
                        └───────────┬─────────────────────────────────────────┘
                                    │ observe / trigger / status / abort
                                    ▼
                    ┌────────────────────────────────────────────┐
                    │ Execution systems (external — plus SCP's   │
                    │ own managed-IaC runner, §12 Mode 2):       │
                    │ GitHub Actions · ArgoCD · Terraform/       │
                    │ OpenTofu pipelines · (via plugins: any)    │
                    └────────────────────────────────────────────┘

  Federation (same binary; one instance designated parent):
     Domain A ──HTTPS pull (mTLS), signed journal segments──▶ Domain B
     Domain A ──`scp federation export` → bundle file → sneakernet →
                `scp federation import`────────────────────▶ Air-gapped Domain C
```

---

## 2. Technology Stack

| Layer | Choice | Why |
|---|---|---|
| Language / runtime | TypeScript 5.x on Node.js 22 LTS, everywhere | Charter fixes TypeScript for SDK and IaC; one language collapses the platform to one runtime, one hiring profile, and shared domain types with zero codegen between server and clients. |
| Web framework | Fastify 5 + `fastify-type-provider-zod` | Schema-first routes give validation and the OpenAPI 3.1 contract from one Zod source; fast, boring, plugin-oriented. |
| Schema / validation | Zod (single contract source) | One schema language drives validation, OpenAPI, SDK types, CLI flags, IaC property types. TypeSpec (candidate 2) was rejected: a second contract toolchain is a drift surface the Simplicity priority does not sanction. |
| Database | PostgreSQL 16+ (only required dependency) | Charter names PostgreSQL the system of record. It also serves as event bus, queue, scheduler, and audit store — zero extra stateful services to ship air-gapped. |
| ORM / migrations | Drizzle ORM over node-postgres; drizzle-kit migrations (expand/contract) | Stays close to real SQL, which matters for recursive graph CTEs; typed without magic. |
| Durable jobs | pg-boss (retries, backoff, poison handling, archival) over Postgres | Grafted from candidate 3: hand-rolled SKIP LOCKED consumers are exactly where subtle 2am-page bugs live. Transactional outbox + LISTEN/NOTIFY retained for domain events. |
| Event bus (optional) | NATS JetStream behind the internal `EventBus` interface | Built early in MVP as scaling insurance (review decision, 2026-07-08); optional component — PostgreSQL remains the default bus and the only *required* dependency (§8). |
| Policy expressions | CEL via `cel-js` (sandboxed, no I/O) | Real expressive power, tiny footprint, Kubernetes-familiar; far simpler to embed and air-gap than an OPA sidecar. |
| API spec / SDK gen | OpenAPI 3.1 emitted from Zod; SDK via `@hey-api/openapi-ts` + thin handwritten layer | Off-the-shelf generator, not bespoke codegen (candidate 3's keystone risk avoided); parity is a build artifact. |
| API stability gate | `oasdiff` breaking-change check in CI on committed spec | Grafted: semantic breaking-change detection is strictly stronger than snapshot testing for the additive-only-within-v1 promise. |
| Web UI | React 18 + Vite SPA, TanStack Router/Query, Tailwind + shadcn/ui, Cytoscape.js | Static SPA served by the API process; consumes only the generated SDK; no CDN assets (air-gap). |
| CLI | commander over the SDK (`scp`) | Thin veneer; JSON + table output; PATs and OIDC device flow. |
| IaC | `@scp/iac` CDK-style constructs → deterministic manifest → server-side plan/apply | Charter mandates CDK-style TypeScript IaC; server-side diff keeps reconciliation logic in one place. |
| Monorepo tooling | pnpm workspaces + Turborepo + Changesets | Boring, fast, offline-cacheable; atomic contract→server→SDK→CLI→IaC changes. |
| Logging / metrics | pino structured logs; Prometheus metrics endpoint | Standard, self-host-friendly observability. |
| Signing / integrity | SHA-256 hash chains; Ed25519 domain keys; cosign for release artifacts | Tamper evidence with zero extra infrastructure; works fully offline. |
| Testing | Vitest, Testcontainers (Postgres), fast-check, nock, Playwright | All layers runnable offline in CI. |

---

## 3. Repository Layout

Single pnpm-workspace monorepo, Turborepo task graph, Changesets versioning.

```
commanderscp/
├── apps/
│   ├── server/            # The monolith ("scpd"): API + worker roles, module boundaries enforced
│   ├── web/               # React SPA; consumes only @scp/sdk; built to static assets served by server
│   └── runner-iac/        # scp-runner-iac image source: pinned tofu/terraform + minimal run shim (Mode 2 only)
├── packages/
│   ├── schemas/           # Shared Zod schemas — the single contract source (domain types, API DTOs)
│   ├── sdk/               # @scp/sdk: @hey-api/openapi-ts generated core + handwritten ergonomic layer
│   ├── cli/               # @scp/cli: `scp` command tree over the SDK (commander)
│   ├── iac/               # @scp/iac: CDK-style constructs; pure synth to desired-state manifest
│   ├── plugin-api/        # @scp/plugin-api: the six plugin interfaces + manifest types (independently semver'd)
│   ├── plugin-testkit/    # @scp/plugin-testkit: conformance suites plugin authors run per interface version
│   └── plugins/
│       ├── github/        # ExecutorPlugin + DiscoveryPlugin: GitHub App, webhooks + polling fallback
│       ├── argocd/        # ExecutorPlugin: Argo CD API integration
│       ├── terraform/     # ExecutorPlugin: pipeline-mediated Terraform/OpenTofu gating (§12 Mode 1)
│       ├── managed-iac/   # ExecutorPlugin: thin orchestrator launching scp-runner-iac containers (§12 Mode 2)
│       ├── oidc/          # IdentityPlugin: generic OIDC (Okta/Entra/Keycloak/Ping)
│       ├── local-auth/    # IdentityPlugin: argon2 local accounts for dev + air-gap
│       ├── webhook-control/       # ControlPlugin escape hatch: POST context → receive outcome
│       ├── webhook-notify/        # NotificationPlugin escape hatch
│       ├── smtp-notify/           # NotificationPlugin: email
│       └── federation-https/      # FederationTransportPlugin: mTLS pull; file transport is built in
├── deploy/
│   ├── compose/           # docker-compose.yml: postgres + scp (api+worker+UI one process, seeded org)
│   ├── helm/              # One chart: api Deployment, worker Deployment, migrations Job
│   └── airgap/            # Bundle builder: OCI image layout, chart, compose, signatures, install script
├── tools/
│   └── openapi/           # Spec emit + commit + oasdiff CI gate
└── docs/
```

**Why.** One repo, one language: Zod schemas flow untranslated from server to SDK to IaC, and `pnpm install && pnpm dev` boots everything. Changesets lets `@scp/plugin-api` and `@scp/sdk` carry independent semver — the stability contract plugin and SDK consumers actually depend on.

---

## 4. Domain & Data Model

### 4.1 Everything is an object; relationships are first-class rows

The graph is two generic tables plus a runtime type registry. Core charter types (Organization, Domain, Service, Component, Team, Group, User, DeploymentTarget, Contract, Policy, Control, Change, Campaign, Initiative, ReleaseTopology…) are **pre-seeded registry rows**, so core and org-defined custom types share one code path. Likewise, **all eleven charter relationship types are pre-seeded** `relationship_types` rows — `owns`, `consumes`, `depends_on`, `communicates_with`, `hosted_on`, `governed_by`, `deploys_to`, `coordinates`, `synchronizes_with`, `member_of`, `approves` — with endpoint constraints, plus the built-in `annotates` used by federation overlays (§13). `member_of` (user/service-account → group/team) is load-bearing: authorization resolves group- and team-bound roles through it (§7).

Every row is **born federation-ready** (grafted from the Federation-First candidate — unanimously flagged by the judges as cheap now, expensive to retrofit): UUIDv7 primary keys (time-ordered, coordination-free), `origin_domain_id`, a per-domain monotonic `revision`, and a `content_hash`. Federation sync is therefore generic row replication, never per-entity export logic.

```sql
CREATE TABLE object_types (
  id            text PRIMARY KEY,            -- e.g. 'service', 'component', 'cost_center'
  org_id        uuid,                        -- NULL = built-in/global type
  display_name  text NOT NULL,
  property_schema jsonb,                     -- JSON Schema validating `properties` (Ajv at write time)
  is_builtin    boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE relationship_types (
  id             text PRIMARY KEY,           -- e.g. 'depends_on', 'owns', 'consumes', 'governed_by'
  org_id         uuid,
  display_name   text NOT NULL,
  property_schema jsonb,
  from_types     text[],                     -- endpoint constraints (grafted: structural validation
  to_types       text[],                     --  of custom relationship types at write time)
  cardinality    text NOT NULL DEFAULT 'many_to_many',  -- 'one_to_one'|'one_to_many'|'many_to_many'
  is_builtin     boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE objects (
  id               uuid PRIMARY KEY,          -- UUIDv7, client-suppliable
  org_id           uuid NOT NULL,
  domain_id        uuid,                      -- containing SCP domain object (NULL for org-level)
  type_id          text NOT NULL REFERENCES object_types(id),
  name             text NOT NULL,
  urn              text NOT NULL,             -- stable human key: urn:scp:{org}:{type}:{slug-path}
  properties       jsonb NOT NULL DEFAULT '{}',
  labels           jsonb NOT NULL DEFAULT '{}',
  -- federation provenance (on every row from day 1)
  origin_domain_id uuid NOT NULL,             -- the single authoritative writer domain
  revision         bigint NOT NULL DEFAULT 1, -- per-origin-domain monotonic, bumped on every write
  content_hash     bytea NOT NULL,            -- sha256 of canonical row content
  -- lifecycle
  version          bigint NOT NULL DEFAULT 1, -- optimistic concurrency
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,               -- soft delete (tombstones replicate)
  UNIQUE (org_id, urn)
);

CREATE TABLE relationships (
  id               uuid PRIMARY KEY,          -- UUIDv7
  org_id           uuid NOT NULL,
  type_id          text NOT NULL REFERENCES relationship_types(id),
  from_id          uuid NOT NULL REFERENCES objects(id),
  to_id            uuid NOT NULL REFERENCES objects(id),
  properties       jsonb NOT NULL DEFAULT '{}',
  origin_domain_id uuid NOT NULL,
  revision         bigint NOT NULL DEFAULT 1,
  content_hash     bytea NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  UNIQUE (org_id, type_id, from_id, to_id)
);

-- Traversal indexes
CREATE INDEX rel_fwd ON relationships (org_id, from_id, type_id) WHERE deleted_at IS NULL;
CREATE INDEX rel_rev ON relationships (org_id, to_id,   type_id) WHERE deleted_at IS NULL;
CREATE INDEX obj_type ON objects (org_id, type_id) WHERE deleted_at IS NULL;
CREATE INDEX obj_props ON objects USING gin (properties jsonb_path_ops);
CREATE INDEX obj_labels ON objects USING gin (labels jsonb_path_ops);
```

**Custom types are data, not DDL.** `POST /type-registry/object-types` (org from token, §6) inserts a registry row; instances of the new type are immediately readable/writable through the generic `/objects/{type}` endpoint (§6) and get SDK/CLI support automatically. No migration, no deploy.

**Projection tables for hot lifecycle state.** Entities whose lifecycle needs real columns and constraints (Change state, plan/wave execution, approvals) get thin projection tables that reference their graph object (`object_id uuid REFERENCES objects(id)`), keeping the graph uniform while giving the engine typed, indexed state (§9).

**Why two tables.** They literally satisfy "everything is an object, relationships are first-class, types are extensible" with no graph database, no extension, trivially auditable and — with per-row provenance — trivially replicable rows.

### 4.2 Multi-tenancy

Single shared database; `org_id NOT NULL` on every tenant-scoped table, enforced by **PostgreSQL Row-Level Security**. Each request runs `SET LOCAL app.current_org_id = ...` inside its transaction; RLS policies filter every table, so cross-tenant leakage requires two independent failures (app bug AND policy bug). Organization exists from install — single-org is the degenerate case. MSPs needing hard isolation run one instance per customer (cheap at two containers) and optionally federate them; schema-per-tenant machinery is explicitly not built.

```sql
ALTER TABLE objects ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON objects
  USING (org_id = current_setting('app.current_org_id')::uuid);
-- identical policy on every tenant-scoped table
```

### 4.3 Audit log

Append-only, hash-chained, database-enforced:

```sql
CREATE TABLE audit_events (
  id           uuid PRIMARY KEY,              -- UUIDv7
  org_id       uuid NOT NULL,
  domain_id    uuid,
  actor_id     uuid NOT NULL,                 -- user or service account object
  action       text NOT NULL,                 -- e.g. 'change.promote', 'policy.update', 'freeze.override'
  subject_id   uuid,                          -- object acted upon
  before_hash  bytea,                         -- digest of prior state (not full copy)
  after_hash   bytea,
  reason       text,                          -- mandatory for overrides/emergency actions
  decision_id  uuid,                          -- link to the Decision record when one exists
  request_id   text NOT NULL,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  prev_hash    bytea NOT NULL,                -- per-org hash chain
  row_hash     bytea NOT NULL                 -- sha256(prev_hash || canonical row)
);
REVOKE UPDATE, DELETE ON audit_events FROM scp_app;   -- app role is INSERT/SELECT only
-- plus a trigger raising an exception on UPDATE/DELETE as belt-and-braces
```

- Written **in the same transaction** as the audited action — the trail can never skew from reality.
- `scp audit verify` re-walks the chain; chain heads are periodically **anchored** to object storage/filesystem for external verifiability (grafted).
- Audit segments **ride the federation journal**, so cross-domain actions are audit-complete on both sides of a trust boundary (grafted).

---

## 5. Graph Query & Intelligence

**Strategy: depth-limited recursive CTEs over indexed adjacency, exposed as named queries — not a general graph query language.**

```sql
-- e.g. impact-of (transitive reverse depends_on/consumes closure)
WITH RECURSIVE impact AS (
  SELECT r.from_id AS id, 1 AS depth, ARRAY[r.to_id, r.from_id] AS path
  FROM relationships r
  WHERE r.to_id = $target AND r.type_id = ANY($rel_types) AND r.deleted_at IS NULL
  UNION ALL
  SELECT r.from_id, i.depth + 1, i.path || r.from_id
  FROM relationships r JOIN impact i ON r.to_id = i.id
  WHERE r.type_id = ANY($rel_types) AND r.deleted_at IS NULL
    AND NOT r.from_id = ANY(i.path)          -- cycle detection
    AND i.depth < $max_depth                  -- default 10
)
SELECT DISTINCT o.* FROM impact JOIN objects o ON o.id = impact.id;
```

The charter's intelligence questions become **canned, parameterized API queries** at `/graph/query/{name}`:

| Named query | Charter question | Traversal |
|---|---|---|
| `owners-of` | Who owns this? | reverse `owns` (direct + via containment) |
| `dependents-of` | What depends on this? | reverse `depends_on`, transitive |
| `consumers-of` | Who consumes this? | reverse `consumes`, transitive |
| `impact-of` | What breaks if this changes? | reverse `depends_on` ∪ `consumes` ∪ `hosted_on`, transitive |
| `blast-radius` | How large is the impact? | `impact-of` + counts by type/domain |
| `policies-applying-to` | What policies apply? | `governed_by` walk up containment, stricter-wins merge |
| `changes-affecting` | What changes affect this? | `impacts`/`coordinates` edges from active Changes/Campaigns |
| `domains-impacted` | Which domains are impacted? | `impact-of` grouped by domain containment |
| `paths-between` | Why are these connected? | bounded bidirectional path search (explainability) |

Plus a generic bounded `/graph/traverse` (direction, relationship-type set, max depth ≤ 10, org-scoped) for the UI explorer and custom tooling.

**Why CTEs and named queries.** Recursive CTEs on indexed adjacency comfortably handle 10k-service graphs for these bounded traversals; a graph database or general query language (Gremlin/Cypher-alike) is the single largest avoidable complexity in this system, and named queries keep the API contract stable while traversal internals evolve. **Escape hatch:** if profiling shows deep-closure pain at the high end, a materialized closure table for `depends_on`/`consumes` (refreshed from the outbox stream) slots in behind the same named-query API without any contract change.

---

## 6. API Design

**REST, token-resolved org scoping with an optional explicit path override, OpenAPI 3.1 from Zod, additive-only within `/v1`.**

```
/api/v1/[orgs/{org}/]     # org resolves from the auth token by default; the explicit
                          # orgs/{org} path form overrides it (review decision) —
                          # for multi-org principals: MSPs, parent instances, federation
  domains/            services/           components/         deployment-targets/
  teams/  groups/  users/  service-accounts/
  relationships/      type-registry/{object-types,relationship-types}
  objects/{type}/     objects/{type}/{id}          # generic endpoint for ANY registry type (grafted)
  changes/            changes/{id}:promote|:cancel|:rollback
  campaigns/          initiatives/        release-topologies/
  policies/           controls/           approvals/          freezes/
  decisions/{id}      audit-events/
  graph/query/{name}  graph/traverse
  plans/              plans/{id}:apply             # server-side desired-state reconciliation
  federation/{peers,exports,imports,journal}
  events/stream                                    # SSE (grafted): live UI/CLI updates
/api/v1/openapi.json
```

Key contract rules:

- **Write idempotency (grafted, load-bearing for federation):** clients may supply UUIDv7 ids; `PUT /objects/{type}/{urn}` is an idempotent upsert-by-URN; every `POST` accepts an `Idempotency-Key` header (server stores key→result for replay). A federation bundle import is therefore literally a replay of public-API writes that converges no matter how many times it is applied — and operator retries over flaky networks are always safe.
- **Org scoping (review decision):** the org is resolved from the auth token; every route also exists under an explicit `/v1/orgs/{org}/…` prefix that overrides it for multi-org principals. SDK and CLI default to the token's org and expose `--org`.
- **Versioning:** `/v1` path prefix; additive-only changes within v1, enforced by an **oasdiff breaking-change gate in CI** against the committed spec artifact; deprecation via `Deprecation`/`Sunset` headers.
- **Errors:** RFC 9457 `application/problem+json`; every policy/gate-blocked 4xx response carries its `decision_id` (grafted) so "why was I blocked" is one GET away.
- **Pagination:** cursor-based (`?cursor=&limit=`), stable ordering by (created_at, id).
- **Spec → clients pipeline:** Zod route schemas → OpenAPI 3.1 emitted at build, committed → `@hey-api/openapi-ts` generates the SDK core → CLI and IaC import the SDK. **Nothing talks to the server except through the public API** — the UI included — so API-first is structurally impossible to violate.

**Why REST + generated clients.** One schema source drives validation, docs, SDK, CLI, and IaC; the generic `/objects/{type}` endpoint makes org-defined custom types first-class across every interface tier automatically.

---

## 7. AuthN & AuthZ

### Authentication

- **IdentityPlugin** interface with two shipped implementations:
  - **Generic OIDC** (Authorization Code + PKCE via `openid-client`) — covers Okta, Entra ID, Keycloak, Ping with one plugin.
  - **Local provider** (argon2 password hashes; bootstrap admin created on first run) — guarantees five-minute value and IdP-less air-gapped operation. This sits in acknowledged tension with the charter's "CommanderSCP is not an identity provider": the local provider exists solely for bootstrap, evaluation, and IdP-less disconnected sites; it lives behind the same IdentityPlugin interface, can be disabled by configuration, and external IdPs remain the recommended production posture.
- **Sessions:** signed HTTP-only cookies for the UI; Bearer tokens for the API.
- **Automation:** Personal Access Tokens and service-account tokens, hashed at rest; **OIDC device flow** for the CLI (grafted — headless jump boxes can't do browser redirects).
- SAML/LDAP/AD are deferred behind the IdentityPlugin interface (§18).

### Authorization

**RBAC with graph-anchored scopes**, evolving to ReBAC without a model change:

```sql
CREATE TABLE roles (
  id uuid PRIMARY KEY, org_id uuid,                 -- NULL org = built-in
  name text NOT NULL,                               -- Viewer|Operator|Approver|Administrator|Owner|custom
  permissions text[] NOT NULL                       -- e.g. '{change:promote, policy:write, freeze:override}'
);
CREATE TABLE role_bindings (
  id uuid PRIMARY KEY, org_id uuid NOT NULL,
  subject_id uuid NOT NULL,                         -- user | group | team | service account (graph object)
  role_id uuid NOT NULL REFERENCES roles(id),
  scope_object_id uuid NOT NULL REFERENCES objects(id),  -- ANY graph object: org/domain/service/component
  effect text NOT NULL DEFAULT 'allow'              -- 'allow' | 'deny' (deny overrides)
);
```

- **Inheritance:** permission checks walk the containment path (component → service → domain → organization) with one recursive CTE and take the union of allows unless an explicit deny binding exists at a narrower scope — inheritance downward per charter, deny-override.
- **Membership:** when a binding's subject is a group or team, the evaluator expands members through built-in `member_of` relationships (user/service-account → group/team) in the same recursive CTE — group membership is graph data, not a separate membership table.
- **Relationship writes require write permission at both endpoints' scopes** — load-bearing for `member_of`, which feeds subject expansion.
- **Ownership ≠ permissions:** ownership is an `owns` graph relationship (responsibility); permissions are role bindings (authority). They never merge — per the charter's critical distinction.
- **Path to ReBAC:** scopes and subjects already *are* graph nodes, so v2 adds relationship-derived bindings ("team `owns` service ⇒ implied Approver on its changes") as new traversal rules in the same evaluator — a query change, not a re-architecture. No SpiceDB/OpenFGA (an extra stateful service self-hosters would have to run).

---

## 8. Event & Reconciliation Architecture

**PostgreSQL is the default event bus. No broker is ever *required*** (NATS ships as an optional backend — see below).

- **Transactional outbox:** every domain mutation writes a CloudEvents-1.0-shaped row to an `outbox` table *in the same transaction*. Write-then-publish atomicity — the thing brokers make hard — is free.
- **Delivery:** an outbox relay in the worker fans events to (a) **pg-boss** durable job queues for async work (control runs, reconcile ticks, notifications, federation sync) and (b) **LISTEN/NOTIFY** for low-latency wakeups and the SSE stream; 1-second polling is the air-gap-proof fallback. At-least-once delivery; handlers are idempotent, keyed by event id.
- **pg-boss** (grafted) supplies retries, exponential backoff, poison-message dead-lettering, and archival instead of hand-rolled SKIP LOCKED plumbing.
- **Scheduler:** pg-boss cron jobs sweep a `schedules` table (freeze-window activation, polling discovery, sync intervals, audit anchoring).
- **Webhook ingestion:** raw payload persisted first (signature-verified), then processed as an event — replayable and auditable.
- **Federation feeds from here:** the sync journal (§13) is **derived from the outbox stream**, so one change-capture mechanism serves audit, UI activity, webhooks, and federation (grafted — disconnected domains accumulate a replayable log by construction).
- **Reconciliation loops:** every engine follows the charter's Observe → Compare → Decide → Coordinate → Repeat pattern as pg-boss jobs over Postgres state; any worker can resume after a crash because no state lives in memory.
- **Scaling insurance (review decision — build NATS early):** the internal `EventBus` interface is broker-agnostic, and the **NATS JetStream implementation is built early in MVP (M3)** rather than deferred — shipped as an optional component (compose profile, Helm toggle, included in the air-gap bundle) with the event-bus integration suite running against both backends in CI. PostgreSQL remains the default bus and the two-container evaluation floor is unchanged; NATS is switched on for webhook-heavy, high-volume estates.

**Why.** Coordination workloads are low-throughput/high-value (thousands of events per minute, not millions per second) — comfortably Postgres-queue territory — and one fewer stateful service to deploy, back up, secure, and ship in an air-gap bundle is a direct win on priorities 1, 5, and 6.

---

## 9. Change Coordination Engine

### 9.1 Lifecycle state machine

The charter lifecycle is an **explicit, table-driven, DB-persisted state machine** — not an embedded workflow engine:

```
 proposed ──▶ evaluated ──▶ coordinated ──▶ executing ──▶ validating ──▶ promoted
     │             │              │              │              │
     └─────────────┴──────┬───────┴──────────────┴──────┬───────┘
                          ▼                             ▼
                      cancelled                    rolled_back
```

Legal transitions are data; **every transition goes through one guarded transition function** that atomically: checks the gates bound to that edge, writes the audit event, and writes the Decision record. This single funnel is what makes explainability and auditability cheap instead of aspirational.

```sql
CREATE TABLE changes (                    -- projection table; each row references its graph object
  object_id    uuid PRIMARY KEY REFERENCES objects(id),
  org_id       uuid NOT NULL,
  state        text NOT NULL DEFAULT 'proposed',
  source_kind  text,                      -- github|argocd|terraform|manual|federation
  source_ref   jsonb,                     -- {repo, ref, commit, run_url, workspace, artifact_digest, ...}
  correlation_key text,                   -- optional user-supplied grouping key
  emergency    boolean NOT NULL DEFAULT false,
  imported_from_domain uuid,              -- set when instantiated from a promotion bundle
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
```

### 9.2 Change correlation

Multiple repos → one component; multiple components → one service. Executor events carry correlation hints — **repo + path patterns, commit SHA, artifact digest (grafted), labels, explicit correlation key** — matched against `source_mappings` rows (repo/path pattern → component). Matching changes are linked into a **CoordinatedChange** group object via `correlates` relationships, giving the charter's "app repo + infra repo + config repo → single coordinated change" differentiator.

### 9.3 Plans, topologies, waves, gates

- **Release Topologies** are versioned declarative JSON documents (registry objects, IaC-manageable): waves with sequential/parallel target groups, per-wave gates, fan-in gates. Single, canary (two waves), blue/green, rolling, regional, domain-based, federated, and custom topologies are all **data**, not workflow code.
- A change (or campaign) compiles into `plan → waves → wave_targets` **rows**. Wave order is computed from graph `depends_on` edges (topological sort, cycle rejection) plus explicit coordination rules ("infrastructure before application", "shared platform before consumers"). Parallel waves share a wave index (fan-out); fan-in is a gate requiring all targets of the previous wave to have succeeded.
- **Gates** are sets of control bindings (§10) attached to wave boundaries and lifecycle edges. A gate is satisfied when its required controls pass (advisory/recommended controls annotate but don't block).
- The engine itself is a **resumable reconciliation loop**: pg-boss workers claim due changes, run observe → compare → decide → coordinate, persist, repeat. All engine state lives in Postgres; any worker resumes after a crash.

### 9.4 Rollback (first-class)

- A rollback is **its own Change**, linked to the original, referencing the prior known-good executor state (Argo revision, previous artifact digest, prior Terraform state ref), executed through the same plan/wave machinery.
- **Triggers:** automatic (gate/control failure policy, canary threshold, health-check failure, policy violation) or manual (operator API/CLI/UI, always available).
- **Scope:** component, service, domain, or campaign — the plan compiler scopes the rollback waves accordingly.
- Every rollback writes a Decision record naming its trigger.

**Durable execution without Temporal (review decision — resolved).** Rather than standing up a workflow engine in every domain, the engine **recreates the specific Temporal properties we need** on Postgres + pg-boss, and deliberately skips the one we don't:

- **Durable timers** — bake periods, gate timeouts, and sync intervals are pg-boss scheduled jobs: they survive restarts and fire late rather than never.
- **Retries with backoff + dead-lettering** — every engine action and executor call runs as a pg-boss job with a per-kind retry policy; poison jobs land in a dead-letter queue surfaced in the UI.
- **Crash resumption** — all engine state lives in `plan`/`wave`/`wave_target` rows and the change's transition history; any worker resumes any change from Postgres alone (proven by M3's kill-the-worker tests).
- **Heartbeats + stuck-change watchdog** — long-running executor operations report progress; a watchdog sweep flags any change showing no progress within its per-state SLA, writes a Decision naming what it's waiting on, and escalates via notifications. The "stuck change" failure mode is *detected*, not discovered.
- **Signals** — external events (webhooks, approvals, control outcomes) wake the reconciliation loop through the outbox, Temporal-signal-style.
- **Deliberately not recreated: deterministic code replay.** Temporal re-derives workflow state by replaying workflow code against an event history; we externalize *all* state to rows, so there is nothing to replay — simpler to operate, simpler to explain, and the history (transitions + Decisions) exists for humans rather than for the runtime.

A DB-persisted explicit state machine is dramatically simpler to operate, ship air-gapped, and explain — and it *is* the charter's reconciliation pattern — while the list above closes the durability gap that made a workflow engine tempting.

### 9.5 Campaigns & Initiatives

Campaign (Kubernetes upgrade, OS patch cycle) = graph object that `coordinates` many Changes across targets, with its own plan/waves/gates over the same machinery. Initiative (Cloud Modernization, FedRAMP Certification) = graph object grouping campaigns with roll-up status derived by traversal. Both are in MVP scope per the charter; neither introduces new engine machinery.

---

## 10. Governance: Policies & Controls

### 10.1 Policies

Versioned declarative JSON documents (graph objects, IaC-manageable):

```jsonc
{
  "name": "prod-security",
  "version": 3,
  "scope": { "selector": { "labels": { "env": "prod" } } },   // or explicit object ref
  "enforcement": "required",                                   // advisory | recommended | required
  "condition": "change.impacts.exists(s, s.tier == 'critical')",  // CEL, sandboxed
  "effects": [
    { "requireControls": ["security-scan", "integration-tests"] },
    { "requireApprovals": { "count": 2, "fromRole": "Approver", "scope": "service" } }
  ]
}
```

- **Evaluation context** (documented, versioned): change, subject object, graph facts (owners, dependents, domains), control outcomes, time. CEL via `cel-js` — sandboxed, no I/O, no arbitrary code.
- **Resolution:** walk the containment path org → domain → service → component; policies inherit downward; **stricter wins** on conflict; local domains may add strictness but never weaken higher-level requirements unless explicitly permitted (federated governance per charter).
- **Group scope** (charter Policy Scope): a policy may scope to a Group; it applies when the change's acting or owning subject is a `member_of` that group — resolved with the same membership expansion as authorization (§7). **Relationship scope** is deferred (§18): selectors match objects in MVP; extending the selector engine to match relationship rows is additive, since policies and scopes are versioned documents.
- Evaluation is a **pure function** (context in → verdict + reason tree out), so explainability is the return value.

### 10.2 Controls

- **Controls are abstract graph objects** declaring a category (security/quality/operational/compliance/custom) and contract; **ControlPlugin implementations are bindings**. Swapping Trivy for Snyk or an internal scanner changes a binding, never a policy — exactly the charter's replaceability rule.
- **Standardized outcomes:** `pass | fail | warning | skipped | timed_out | expired`, always with an evidence payload (persisted, referenced by Decisions).
- **Human controls:** `approval` control instances materialize as approval tasks — actionable via API, UI, and CLI — with N-of-M quorum from a role/group; approvals are recorded as `approves` relationships. **Hybrid** = a gate requiring both the scan and the human sign-off.
- **Approval attestation (review decision):** every approval is cryptographically attested at creation — the domain instance signs (Ed25519 domain key) a canonical record binding the approver's subject id and IdP subject, the approved object's URN and content hash, the decision id, and the timestamp. Attestations are stored with the approval, checked by `scp audit verify`, and travel in promotion bundles, where the importing domain validates them before accepting the approval as evidence (§13). SCP performs all signing and validation itself — no external PKI.
- **Webhook escape hatch:** a generic webhook ControlPlugin (POST evaluation context → receive outcome, timeout → `timed_out`) gives orgs custom controls on day 1 without writing a plugin.

### 10.3 Freezes, emergency changes

- **Freezes** are a built-in policy effect with time windows and scope (org/domain/service/component). Override requires an explicit `freeze:override` permission **and a mandatory reason**, producing a high-severity audit event + Decision.
- **Emergency changes:** a change flagged `emergency` by a permitted actor follows a configured emergency policy (may bypass normal gates); everything is still audited and a retrospective Decision trail is produced. Human-assisted, fully-automated, and emergency-override models are all just policy configurations — the charter's governance optionality.

### 10.4 Decision records (explainability)

```sql
CREATE TABLE decisions (
  id           uuid PRIMARY KEY,             -- UUIDv7
  org_id       uuid NOT NULL,
  kind         text NOT NULL,                -- gate|policy|freeze|rollback_trigger|plan_diff|promotion|...
  subject_id   uuid NOT NULL,                -- the change/approval/plan decided about
  verdict      text NOT NULL,                -- allow|block|warn|rollback|...
  input_context jsonb NOT NULL,              -- snapshot: policy versions consulted, control outcomes
                                             --  (with evidence refs), graph facts, actor, time
  reason_tree  jsonb NOT NULL,               -- structured explanation, rendered to human text
  created_at   timestamptz NOT NULL DEFAULT now()
);
```

Every engine verdict persists one. Exposed at `/decisions/{id}`, linked from every change/approval/rollback in the UI ("Why?"), from `scp change explain <id>`, and from every blocked 4xx response (`decision_id` field). Because the *inputs* are persisted — not re-derived — "blocked because required policy `prod-security@v3` control `security-scan` (Trivy binding) returned `fail` (CVE-2026-1234)" is reconstructible forever, even after policies change.

---

## 11. Plugin Architecture

**Six stable, independently semver'd TypeScript interfaces in `@scp/plugin-api`, designed message-first and hosted with minimal process isolation in v1 (review decision).**

```ts
// Every call crosses a host-mediated seam: JSON-serializable args/results only,
// injected scoped context, host-enforced timeouts, standardized error mapping.
interface PluginContext {
  orgId: string;
  domainId: string;
  logger: Logger;
  secrets: SecretsAccessor;        // read-only, scoped to this plugin's configured secrets
  http: ScopedHttpClient;          // egress-controlled, instrumented
  config: unknown;                 // validated against the manifest's config JSON Schema
}

interface ExecutorPlugin {
  // Deliberately NO execute()/deploy() verb — coordination-not-execution is a type-system fact.
  observe(ctx: PluginContext, since?: Cursor): Promise<ExecutorEvent[]>;   // pull/poll detection
  trigger(ctx: PluginContext, intent: TriggerIntent): Promise<ExternalRunRef>; // invoke the executor's defined automation (org-defined, or SCP-shipped: §12 Mode 2)
  status(ctx: PluginContext, ref: ExternalRunRef): Promise<ExecutionStatus>;
  abort(ctx: PluginContext, ref: ExternalRunRef): Promise<AbortResult>;
  describeCapabilities(): ExecutorCapabilities;
}

interface ControlPlugin {
  evaluate(ctx: PluginContext, req: ControlRequest): Promise<ControlOutcome>;
  // ControlOutcome.status: 'pass'|'fail'|'warning'|'skipped'|'timed_out'|'expired' + evidence
}

interface IdentityPlugin {
  authenticate(ctx: PluginContext, credentials: AuthInput): Promise<AuthResult>;
  resolveSubject(ctx: PluginContext, subjectId: string): Promise<SubjectProfile>;
}

interface NotificationPlugin {
  send(ctx: PluginContext, msg: NotificationMessage): Promise<DeliveryResult>;
}

interface FederationTransportPlugin {                       // grafted: charter names Federation Plugins
  push(ctx: PluginContext, segment: JournalSegment): Promise<void>;
  pull(ctx: PluginContext, cursor: DomainCursor): Promise<JournalSegment[]>;
  exportBundle(ctx: PluginContext, opts: ExportOptions): Promise<BundleRef>;
  importBundle(ctx: PluginContext, bundle: BundleRef): Promise<ImportReport>;
}

interface DiscoveryPlugin {                                 // grafted: charter has a Discovery Architecture
  discover(ctx: PluginContext): Promise<DiscoveryProposal>; // proposed objects + relationships,
}                                                           // reviewed/accepted into the graph, never auto-committed
```

- **Manifest:** every plugin is an npm package declaring `{ id, kind, version, configSchema: JSONSchema, requiredCapabilities }`. Config schemas **auto-surface** as validated config forms in API, CLI, and UI (grafted) — plugin authors get interface parity for free.
- **Distribution:** bundled plugins compile into the server image; third-party plugins are added via a documented custom-image-layer pattern. **No runtime hot-loading, ever** — the only model that works air-gapped, and it closes the runtime supply-chain hole.
- **Conformance:** `@scp/plugin-testkit` ships public per-interface conformance suites (grafted), so operators can vet a third-party plugin *before* baking it into an air-gap image — the only vetting point a disconnected site gets.
- **Policy plugins / Intelligence plugins** (charter categories 3 and 6): deferred — a conscious, documented exception to the Extensibility-First principle's enumerated list for v1. CEL effects plus the webhook control escape hatch cover custom governance, and named graph queries cover intelligence, until both land as additional `@scp/plugin-api` interfaces without touching the six above (§18).

**Process isolation (v1 — review decision).** Plugin instances run under a **subprocess plugin host**: one child process per configured plugin instance (`scpd plugin-host`, same image), speaking JSON-RPC 2.0 over stdio, with host-enforced call timeouts, restart-with-backoff, and OS-level resource limits. A crashed or hung plugin cannot take down the worker. Tool-executing plugins go one step further (review decision, 2026-07-08): the managed-IaC toolchain does not live in the scpd image at all — the `scp-managed-iac` plugin is a thin orchestrator that launches per-run containers from the separate `scp-runner-iac` image (§12). First-party in-tree plugins may be configured in-process for latency, but subprocess is the default for anything third-party or tool-executing. The interfaces were already JSON-serializable and host-mediated, so isolation changes the transport, not the contracts; a network-remote (gRPC/sidecar) host remains a later transport swap (§18).

---

## 12. MVP Executor Integrations

The coordination boundary is enforced **structurally**, twice: (1) the ExecutorPlugin verb set has no execute/deploy primitive — `trigger` can only invoke automation the target system already defines; (2) **credential asymmetry** — SCP holds credentials to execution systems' APIs, never to the infrastructure those systems manage. One deliberate, scoped exception exists by review decision: the **SCP-managed IaC executor** (below), where SCP itself supplies the execution system and holds scoped, vaulted infrastructure credentials confined to its isolated runner. Every `trigger` is recorded as a CoordinationAction with the resulting external run URL.

### GitHub (also the primary Discovery source)

- **Auth:** GitHub App, org-installable, fine-grained permissions.
- **Observe (push):** webhooks — `push`, `pull_request`, `workflow_run`, `deployment`, `release` — feed change detection and correlation.
- **Observe (pull, grafted):** polling fallback over the same REST endpoints for regulated/disconnected networks where inbound webhooks are impossible — the charter requires push, pull, and hybrid detection.
- **Trigger:** `workflow_dispatch` / `repository_dispatch` of the org's **own** workflows.
- **Status:** check runs + workflow conclusions; SCP posts a commit status/check so repos can make SCP coordination a branch-protection gate.
- **Discovery:** repo/topology scan proposing Service/Component objects and `source_mappings`.

### ArgoCD

- **Observe:** Application get/watch — health + sync status is the actual-state input to reconciliation.
- **Trigger:** `sync` of an Application the org already defined (optionally setting target revision).
- **Abort:** terminate operation. **Rollback:** sync to previous known-good revision.

### Terraform / OpenTofu (two modes — review decision)

**Mode 1 — pipeline-mediated (the org already has a pipeline).** The org's pipeline remains the executor:

- **Observe:** plan/apply results reported by the org's pipeline — either a one-line CLI step (`scp change report --plan-json …`) or TFC/TFE/Atlantis webhooks.
- **Gate:** the pipeline's apply step asks SCP for a gate verdict (poll or callback) before applying; SCP evaluates policies/controls and answers with a Decision.
- **Trigger:** kick the org's pipeline (TFC run API, Atlantis, or a GitHub workflow wrapping tofu).
- **Correlate:** workspace/backend refs + artifact digests link infra changes to app changes.

**Mode 2 — SCP-managed IaC releases (no pipeline exists).** For trivial-to-moderate IaC deployments, SCP performs release management itself through the built-in **`scp-managed-iac` ExecutorPlugin** paired with the separate **`scp-runner-iac` image** (review decision, 2026-07-08): the plugin is a thin orchestrator inside scpd; each run launches an ephemeral runner container from that image — a Kubernetes Job in production, `docker run` under compose/VM — containing pinned `terraform`/`tofu` binaries and a minimal run shim, nothing else. Org-supplied credentials are held scoped and encrypted in SCP's secret store and injected only into the ephemeral runner for the duration of the run. The plan output is persisted as the change's evidence; apply proceeds only when the change's gates pass — the same policies, controls, approvals, waves, and rollback (apply of the prior state ref) as any other change. **The scpd image carries no IaC toolchain**: the runner image ships in the same signed bundle at the same version tag and is pulled only by domains that enable Mode 2. The coordination core is unchanged: it still speaks only observe/trigger/status/abort; the execution system behind the interface happens to be shipped by SCP.

**Boundary note — charter amended.** The charter's coordination principle states SCP "does not provision infrastructure"; Mode 2 is a deliberate, scoped exception decided in owner review (2026-07-08) for orgs without execution pipelines, now codified in the charter's **Managed Execution Exception** (approved and applied the same day).

---

## 13. Federation (MVP)

**One binary, roles not products — deployed hub-and-spoke.** Every install is a Domain Control Plane. The reference topology (review decision) is **parent/child**: one instance is designated the **parent** (the charter's Global Coordination Layer) by configuration, and each domain instance — commercial, GovCloud, air-gapped, … — is a **child** enrolled with it. Same image, same chart, same upgrade path. Domains remain fully operational when disconnected: federation enhances operation, it is never required for it.

**The parent is the single source of truth for global configuration** — the domain registry, org structure, global policies, release topologies, campaign and initiative definitions. Under single-writer authority (below) these objects originate at the parent, so at every child they are **structurally read-only replicas**: a child cannot edit parent-origin config, only layer stricter local policy on top. Children are authoritative for their **local** objects — local services/components, deployment targets, changes, control outcomes, approvals, audit segments — and report them upward, which is what gives the parent UI the cross-domain view: every domain, its sync freshness, its in-flight changes, campaign and initiative status. For connected children this is near-real-time; for air-gapped children it is explicitly last-known-as-of the latest returned bundle, plus outstanding-transfer status (see Transports).

**Config delivery to disconnected children:** connected children pull parent config and push status over mTLS HTTPS on an interval — every network connection is child-initiated; the parent only listens (see Transports). Air-gapped children receive the identical parent config via `scp federation import` of a signed bundle file — or, where even file transfer is impractical, by **hand-entry**: manually entered parent-origin objects are stored as `provenance: manual` shadow copies, flagged as unverified in API and UI, and reconciled (confirmed or replaced) the next time a signed bundle arrives.

### Sync protocol — outbox-derived, hash-chained journal (grafted core)

- Each domain maintains an **append-only Sync Journal** derived from its transactional outbox: object/relationship upserts and tombstones, change/campaign status, policies, approvals-as-evidence, and audit segments, each entry stamped `(origin_domain, sequence, content_hash)` with segments hash-chained and **Ed25519-signed** with domain keys exchanged at pairing. Each entry also carries two reserved, v1-unused fields — `base_revision` and a `conflict` marker — the format insurance behind the overlay decision below.
- **Single-writer authority:** every object has exactly one authoritative origin domain; non-authoritative copies are read-only replicas. Conflict resolution is "authority wins" — no merge algorithm exists because none is needed.
- **Per-domain monotonic sequence cursors** make replication idempotent and **resumable**: an interrupted transfer resumes from the last applied sequence; re-applying a segment is a no-op (imports ride the idempotent public write path, §6).
- **Sync scope is configurable** per peer: full graph, policies-only, changes-only, status-only, or label-selector custom scope.

### Transports (both implement FederationTransportPlugin; identical journal format)

1. **Connected / intermittent — always child-initiated (review decision, 2026-07-08).** The child dials the parent over mTLS HTTPS to *pull* config-journal segments and to *push* its own status/audit segments; **the parent never initiates a connection to a child.** This matches regulated-partition reality: GovCloud may dial out to the commercial partition where the parent lives, but commercial cannot dial into GovCloud. Pairing and key exchange are likewise performed by the child dialing the parent. Near-real-time sync is just a small interval; delayed sync is a schedule; manual sync is a button/CLI call.
2. **Air-gapped:** `scp federation export --peer il5 --since <seq> > bundle.scpbundle` emits a signed, checksummed tarball of journal segments (+ optional snapshot for bootstrap + referenced artifacts' digests); walked across the gap; `scp federation import bundle.scpbundle` verifies signatures and chain, then applies. **The air gap is the design center** — connected mode is merely automated bundle exchange. **Parent-side visibility for air-gapped children is explicitly bounded (review decision):** the parent can show only (a) bundle-transfer tracking — export created → *transfer submitted* (recorded handoff) → *confirmed* when a returned bundle carries the child's import cursor — and (b) the child's last-known state as of its most recent returned bundle. The parent UI labels air-gapped domains "as of &lt;bundle/date&gt;" and never presents stale data as live status.

### Federated change promotion — Promotion Bundles (grafted semantics)

A change promoted toward another domain exports as a **Promotion Bundle**: the change object, provenance, control outcomes with evidence, and artifact digests. The importing domain **instantiates its own local Change** (state `proposed`, `imported_from_domain` set) which must pass **local** policies, controls, and approvals before its executors act. **Approvals transfer as evidence, never as authority** — a faithful encoding of the charter's domain-sovereignty and stricter-local-policy rules. Commercial → FedRAMP → IL5 → Air-Gapped is a federated release topology whose waves are domains; each wave's gate is the target domain's own local gate outcome, reported back via the journal. **Approver attestation (review decision):** every approval in a bundle carries its Ed25519 attestation (§10.2) binding the original approver's identity to exactly what was approved; the importing domain validates each attestation against the origin domain's public keys (exchanged at pairing, rotated via signed journal events) before accepting the approval as evidence. SCP performs all signing and validation — no external PKI.

### Shared-authority objects — overlays (review decision — resolved)

Two domains never write one object. When a non-owning domain must contribute to an object it doesn't own (canonical case: locally annotating a parent-distributed global policy), it creates an **overlay** — a separate object it *does* own, linked to the base via the built-in `annotates` relationship. Readers (UI, policy evaluation) merge base + local overlay at read time; per-type overlay rules bound what may be layered — policy overlays may only **add strictness**, per federated governance. Single-writer authority and convergent replication are preserved by construction. **Cheap insurance:** the journal-entry format reserves `base_revision` and `conflict` fields (unused in v1) so richer shared-authority semantics can be introduced later without a format break.

### Explicitly deferred (safe: protocol carries version + capability flags)

- Cross-domain *writes* to a single object (overlays cover known needs; the reserved journal fields keep richer semantics format-compatible).
- Automatic transitive multi-hop routing (MVP: explicit peer pairs).
- Federated identity mapping (never assumed by charter; each domain keeps its own identities).

---

## 14. Web UI

- **React 18 + TypeScript + Vite SPA**, built to static assets, **served by the Fastify server** — no separate UI service, no BFF, no SSR.
- **Consumes only the generated `@scp/sdk`** against the public `/v1` API, authenticating with the same OIDC/local flows. The UI is the permanent proof of API-first: it literally cannot do anything the SDK/CLI can't.
- TanStack Router + TanStack Query; Tailwind CSS + shadcn/ui; **Cytoscape.js** graph/impact visualization fed by the same named graph-query endpoints; wave/topology progression views over plan rows.
- **Live updates via SSE** from `/events/stream` (grafted) — nearly free once the outbox exists, and it removes UI polling.
- **Zero external requests:** all assets (fonts, icons, scripts) ship in the image — a hard air-gap requirement.
- Every blocked or acted-upon item renders a "Why?" link to its Decision record.

---

## 15. CLI / SDK / IaC

Strictly layered — each layer a thin, testable veneer over the one below, so every capability is automatically API-, SDK-, CLI-, and IaC-available:

```
Zod schemas ──▶ OpenAPI 3.1 (committed, oasdiff-gated)
                  └─▶ @scp/sdk        generated core (@hey-api/openapi-ts)
                                      + thin handwritten layer (auth, retries, pagination iterators)
                        └─▶ @scp/cli  `scp` (commander): resource verbs mirror API nouns
                        └─▶ @scp/iac  CDK-style constructs → pure synth → manifest JSON
```

- **CLI:** `scp service register`, `scp change promote`, `scp change explain`, `scp policy evaluate`, `scp federation export/import`, `scp audit verify`, `scp plan` / `scp apply`. `--output json|table` everywhere; auth via PAT or OIDC device flow.
- **IaC:** `new Service(scope, 'billing', {...})`, `new Policy(...)`, `new ReleaseTopology(...)`, `new Campaign(...)` — constructs synthesize a **deterministic desired-state manifest** (URN-keyed objects + relationships). **Synthesis is pure — no API calls** — so IaC works in CI and across air gaps: synthesize connected, apply disconnected.
- **Server-side reconciliation:** `scp apply` POSTs the manifest to `/plans`; the server diffs desired vs. actual graph and returns a typed, **explained** plan (create/update/delete/no-op with reasons — itself a Decision); `/plans/{id}:apply` executes transactionally. IaC-managed objects carry a `managed-by` marker + stack label so pruning is scoped and safe; `scp plan` is the dry-run. The same diff engine powers drift detection as a worker reconciliation loop.

**Why server-side plan/apply.** Diff logic lives once and is identical for UI, CLI, IaC, federation import, and drift detection — and every plan is explainable and auditable like any other mutation (Kubernetes-apply semantics, not client-side Terraform semantics).

---

## 16. Deployment & Packaging

### Dev / evaluation — `docker compose up`

Exactly **two containers**: `postgres:16` and `scp` (api + worker + UI in one process, local auth, seeded example org, filesystem object storage). Enabling Mode 2 launches ephemeral `scp-runner-iac` containers on demand — an optional profile; the two-container floor is unchanged. Five-minute value: deploy → register service → register component → connect executor → see the graph. No MinIO, no Keycloak, no NATS required (optional compose profiles exist for each).

### Production — Kubernetes, one Helm chart

- **One scpd image**, two Deployments: `api` (SCP_ROLE=api, HPA-scalable) and `worker` (SCP_ROLE=worker, scaled by queue depth). Where Mode 2 is enabled, the chart adds a Job template for the separate **`scp-runner-iac` image** — pulled only by domains actually running managed-IaC releases (review decision: keeps the main image free of IaC toolchain and shrinks its CVE surface).
- **Migrations Job** (pre-upgrade hook): Drizzle migrations, forward-only, **expand/contract pattern** for zero-downtime, reversible upgrades (charter's upgradeability NFR).
- PostgreSQL **external by default** (documented requirements); a plain `postgres` image option for evaluation only — no Bitnami subchart (grafted: licensing/registry churn), no bundled operator.
- Object storage: filesystem/PVC provider default; S3-compatible provider configurable. Ingress + ServiceMonitor included; hardened defaults (non-root, read-only rootfs, NetworkPolicies).

**Scaling shape (review question answered).** "One image" is not one container: `api` and `worker` are independent Deployments scaled horizontally — HPA on the api, queue-depth-driven scaling on workers — Postgres is external and HA per the org's standard practice, and NATS (§8, optional) takes over event delivery for high-volume estates. The two-container topology is the evaluation floor, not the production ceiling.

### Air-gapped bundle — a first-class CI artifact on every release

`scp-bundle-<version>.tar.gz` contains: all images — scpd, `scp-runner-iac`, and the evaluation postgres — as **OCI layout** (skopeo-copy-able into any private registry), the Helm chart, the compose file, bundled plugins, checksums, **cosign signatures**, offline docs, and an **install/upgrade script that retargets image references to the customer's registry** (grafted — removes the most error-prone manual step of offline installs). The same bundle format is the upgrade package, so disconnected upgradeability is exercised from v1.

### VM / on-prem / static instance updates — Ansible collection (review decision)

Kubernetes installs upgrade with `helm upgrade` (pre-upgrade migrations Job). For compose/VM/static installs — including disconnected sites — the signed bundle's idempotent install/upgrade script is the unit of update, and we ship an **Ansible collection (`scp.platform`)** wrapping it for fleet rollout: inventory-driven cosign verification, image load and registry retarget, migration run, service restart, and health check per instance. Ansible is a packaging convenience, never a platform dependency — the script remains directly runnable without it. Long term, per the charter's "CommanderSCP managing CommanderSCP," instances become SCP-managed components and platform upgrades become campaigns.

---

## 17. Non-Functional Requirements Mapping

| Charter NFR | How this design satisfies it |
|---|---|
| Availability (enterprise-ready) | Stateless api/worker pods behind HPA; all state in Postgres (HA via the org's standard Postgres HA); crash-resumable reconciliation loops; pg-boss retries. |
| Scalability (1 → 10,000+ services) | Indexed adjacency + depth-limited CTEs; role-split horizontal scaling (independent api/worker replicas); closure-table escape hatch behind stable named-query API; optional NATS JetStream event bus (shipped in MVP) for high event volume. |
| Extensibility (plugins remain stable) | Six independently semver'd interfaces; JSON-serializable host-mediated seams; public conformance testkit; additive-only `/v1` enforced by oasdiff. |
| Maintainability (simple ops model) | Two-container floor; one image, one chart, one migrations job; one language; Postgres is the only stateful dependency. |
| Upgradeability (safe, reversible) | Expand/contract migrations; pre-upgrade Job; single image version for api+worker (no skew); air-gap bundle doubles as upgrade package. |
| Security (enterprise-grade) | OIDC + PKCE; argon2; hashed tokens; RLS defense-in-depth tenancy; deny-override RBAC; credential asymmetry to executors (single scoped exception: the isolated managed-IaC runner, §12); signed webhooks; cosign-signed releases; no runtime plugin loading. |
| Air-gap compatibility (first-class) | No external calls anywhere (UI assets bundled, CEL in-process, local IdP); journal/bundle federation designed offline-first; OCI-layout bundles; two-domain round-trip tested in CI every merge. |
| Explainability / Auditability | Decision records with persisted inputs on every verdict; `decision_id` on every blocked response; same-transaction hash-chained audit; `scp audit verify` + anchored chain heads. |

---

## 18. What Is Explicitly Deferred (and why deferral is safe)

| Deferred | Why safe — no redesign later |
|---|---|
| Broker as a *required* dependency | NATS JetStream `EventBus` implementation ships in MVP as an optional component (§8); PostgreSQL stays the default. Kafka and others remain out. |
| Network-remote plugin host (gRPC/sidecar) | The v1 subprocess host (§11) already isolates plugins; a remote host changes transport only. |
| SAML / LDAP / Active Directory | Behind IdentityPlugin; OIDC covers most enterprise IdPs (incl. Entra, Okta, Keycloak, Ping) meanwhile. |
| ReBAC | Scopes/subjects are already graph nodes; relationship-derived bindings are new traversal rules in the same evaluator. |
| Go/Python/Java SDKs | Generated from the same committed OpenAPI artifact; no server change. |
| General graph query language | Named queries + bounded `/graph/traverse` keep the contract stable; a query language or closure tables can appear behind it. |
| Materialized closure tables | Additive, derived from the outbox stream; behind existing named-query API. |
| Policy & Intelligence plugin categories | CEL effects and named queries cover MVP; both are additive interfaces in `@scp/plugin-api`. |
| Relationship-scoped policies | Selectors match objects in MVP; matching relationship rows is an additive selector-engine extension — policies/scopes are versioned documents, no migration. |
| Shared *writable* federated objects | Overlays via `annotates` are the v1 answer (§13, review decision); the journal format reserves `base_revision`/`conflict` fields so richer semantics arrive without a format break. |
| Multi-hop federation routing | Explicit peer pairs in MVP; journal format carries origin + sequence, so routing is a transport concern. |
| Schema-/DB-per-tenant isolation | Instance-per-customer (+ optional federation) is the documented hard-isolation tier; RLS covers shared installs. |
| Runtime plugin hot-loading | Deliberately never; custom-image-layer pattern is the permanent distribution model (air-gap-compatible by definition). |
| GitLab/Jenkins/Ansible/etc. executors | Same ExecutorPlugin verbs; the three MVP integrations exercise push, pull, and hybrid detection modes. |
| Argo Rollouts-driven canary analysis | Canary is already a two-wave topology + operational control; deeper analysis is a ControlPlugin. |

### Testing strategy (how the promises stay true)

1. **Unit (Vitest):** state-machine transitions, CEL evaluation, wave ordering/toposort, permission resolution, correlation matchers — pure functions, table-driven, exhaustive.
2. **Integration (Testcontainers Postgres):** graph traversals, **adversarial RLS cross-org probes**, outbox delivery, pg-boss retry/poison behavior, transition atomicity, audit-chain integrity, migration up-paths; executor plugins against recorded HTTP fixtures (nock) + a fake-executor plugin for full-loop tests.
3. **Contract:** committed OpenAPI + **oasdiff breaking-change gate**; generated SDK exercised against a live server; **fast-check property-based idempotency fuzzing** of write endpoints (grafted) — directly verifying the convergence guarantee federation import depends on.
4. **E2E (docker compose in CI):** scripted golden path (register service → connect fake executor → propose change → gate blocks → approve → promote → explain → audit verify) via CLI; Playwright UI smoke; and the **definitive two-domain federation round-trip on every merge** (grafted): create in A → export → import into isolated B → assert graph equivalence → promote a change through B's *local* gates → export status back → verify convergence **and audit-chain integrity on both sides**.

---

## 19. Open Questions & Resolved Decisions

### Still open

*None — every question raised in the v0.1 review cycle has been resolved (see below).*

### Resolved in owner review (2026-07-08)

| Decision | Outcome | Where |
|---|---|---|
| Parent instance | Hub-and-spoke parent/child is the reference topology: children hold read-only parent-origin config; air-gap children import signed bundles or hand-fill with `provenance: manual` reconciliation | §13 |
| Managed IaC execution | SCP does release management for trivial IaC deployments via the isolated `scp-managed-iac` executor when no org pipeline exists; codified in the charter's Managed Execution Exception | §12 |
| Plugin isolation | Minimal process isolation ships in v1: subprocess plugin host | §11 |
| Graph benchmark | No pre-MVP benchmark gate required; closure-table escape hatch stays documented | §5 |
| Event-bus ceiling | NATS JetStream `EventBus` implementation built early in MVP, shipped as optional component | §8 |
| Org path scoping | Org resolves from the auth token; explicit `/orgs/{org}` path override for multi-org principals | §6 |
| Approver attestation | Per-approval Ed25519 attestations, signed and validated by SCP itself, required in promotion bundles | §10.2, §13 |
| VM/on-prem instance updates | Ansible collection `scp.platform` wraps the signed-bundle installer for fleet updates | §16 |
| State-machine durability | Hand-rolled durable execution stays — the engine recreates the needed Temporal properties (durable timers, retries/dead-letter, crash resumption, heartbeat watchdog, signals) on Postgres + pg-boss; no workflow-engine dependency | §9.4 |
| Shared-authority objects | Overlays via `annotates` now; journal format reserves `base_revision` + `conflict` fields as insurance | §13 |
| Managed Execution charter amendment | Approved and applied to PROJECT_CHARTER.md ("Managed Execution Exception") | §12 |
| Federation connectivity | All network federation is child-initiated (child pulls config, pushes status); the parent never dials a child. Parent view of air-gapped children = bundle-transfer tracking (submitted → confirmed) + last-known state, never presented as live | §13 |
| Managed-IaC runner image | Split into its own `scp-runner-iac` image: pinned tofu/terraform + run shim, same version tag and signed bundle, pulled only where Mode 2 is enabled, launched per run as an ephemeral Job/container; scpd carries no IaC toolchain | §11, §12, §16 |
