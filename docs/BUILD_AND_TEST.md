# CommanderSCP — Build & Test Plan

| | |
|---|---|
| **Version** | 1.0 |
| **Status** | **Approved** — owner sign-off 2026-07-08 |
| **Derives from** | [PROJECT_CHARTER.md](../PROJECT_CHARTER.md) (authoritative) and [DESIGN.md](DESIGN.md) (binding for technology and repo layout) |

This plan turns the design into an ordered, verifiable build. Every milestone ends in something that runs and is proven by tests that stay in the suite forever. The prime directives inherited from the charter: everything must run **self-hosted and offline** (CI included), and `docker compose up` must always work.

---

## 1. Toolchain & Prerequisites

All versions are pinned in-repo (`.nvmrc`, `package.json#packageManager`, `.tool-versions`) so "works on my machine" is a property of the checkout, not the developer.

| Tool | Version | Pin mechanism | Notes |
|---|---|---|---|
| Node.js | **22.17.x** (22 LTS line; minimum 22.11) | `.nvmrc`, `engines.node: ">=22.11 <23"` | Single runtime for server, CLI, SDK, IaC, tooling. |
| pnpm | **10.x** (pin exact, e.g. `10.12.1`) | `package.json#packageManager` + Corepack | `corepack enable` activates the pinned version automatically. |
| TypeScript | **5.8.x** | workspace devDependency | One version hoisted for the whole monorepo. |
| Turborepo | **2.x** | workspace devDependency | Task graph + local/remote build cache. |
| Changesets | **2.x** | workspace devDependency | Independent semver for `@scp/plugin-api` and `@scp/sdk`. |
| Docker Engine | **27+** with Compose v2 (**2.29+**) | documented; checked by `pnpm doctor` | Needed for compose stack, Testcontainers, e2e. Colima/Podman (with Docker socket compat) acceptable. |
| PostgreSQL | **16** (container `postgres:16` only) | compose files / Testcontainers image tag | Never installed on the host; all Postgres usage is containerized. |
| NATS | **2.10.x** (container `nats:2.10` only) | compose profile / Testcontainers image tag | Optional EventBus backend (design §8); event-bus integration suite runs against it from M3. |
| OpenTofu | **1.8.x** pinned, baked into the `scp-runner-iac` image (and the CI runner image for tests) | apps/runner-iac/Dockerfile · tools/ci-image | Managed-IaC executor (M7); never in the scpd image, never required on developer hosts. |
| Drizzle ORM / drizzle-kit | **latest 0.x pinned exactly** | workspace dependency | Migrations are committed SQL; drizzle-kit only generates them. |
| Vitest | **3.x** | workspace devDependency | Unit + integration runner. |
| Playwright | **1.5x pinned** | devDependency in `apps/web` | Chromium only in CI (bundled browser, no CDN fetch at test time — browsers are baked into the CI image). |
| oasdiff | **1.11+** | vendored binary under `tools/openapi/bin/` per platform | Vendored so the spec gate runs air-gapped. |
| Helm | **3.16+** | documented; used in `deploy/helm` lint/test | |
| kind | **0.27+** | documented | Optional local chart verification; CI chart-install job. |
| skopeo | **1.16+** | documented | Air-gap bundle build (OCI layout copy). |
| cosign | **2.x** | documented | Release artifact signing. |
| git | 2.40+ | documented | |

Developer bootstrap check:

```bash
corepack enable
pnpm install
pnpm doctor        # scripts/doctor.mjs: verifies node/pnpm/docker/compose versions, docker daemon reachable
```

Nothing in the toolchain phones home: pnpm uses the committed lockfile, Playwright browsers and the oasdiff binary are vendored/cached, Turborepo remote cache is optional and self-hosted if enabled.

---

## 2. Repository Bootstrap

Exact sequence to scaffold the monorepo defined in DESIGN.md §3. Run once from an empty directory.

```bash
# 0. Repo + root manifests
git init commanderscp && cd commanderscp
node -v > .nvmrc                      # expect v22.17.x
pnpm init                             # then edit package.json:
#   "private": true,
#   "packageManager": "pnpm@10.12.1",
#   "engines": { "node": ">=22.11 <23" }

cat > pnpm-workspace.yaml <<'EOF'
packages:
  - "apps/*"
  - "packages/*"
  - "packages/plugins/*"
  - "tools/*"
  - "deploy/airgap"      # @scp/airgap — bundle-builder scripts (referenced by CI stage 8)
EOF

# 1. Workspace tooling
pnpm add -Dw typescript turbo @changesets/cli vitest @vitest/coverage-v8 \
  eslint @eslint/js typescript-eslint prettier tsx
pnpm changeset init
npx tsc --init          # becomes tsconfig.base.json: strict, NodeNext, ES2023, composite refs

# 2. Directory skeleton (per DESIGN.md §3 — this layout is binding)
mkdir -p apps/server apps/web apps/runner-iac \
  packages/schemas packages/sdk packages/cli packages/iac \
  packages/plugin-api packages/plugin-testkit \
  packages/plugins/{github,argocd,terraform,managed-iac,oidc,local-auth,webhook-control,webhook-notify,smtp-notify,federation-https} \
  deploy/compose deploy/helm deploy/airgap tools/openapi docs

# 3. Server app (the monolith "scpd")
cd apps/server
pnpm init   # name: @scp/server
pnpm add fastify fastify-type-provider-zod zod drizzle-orm pg pg-boss pino \
  @fastify/cookie @fastify/static openid-client argon2 cel-js ajv uuid
pnpm add -D drizzle-kit @types/pg testcontainers nock fast-check
cd ../..

# 4. Web app
pnpm create vite apps/web --template react-ts
cd apps/web
pnpm add @tanstack/react-router @tanstack/react-query tailwindcss cytoscape
pnpm add -D playwright @playwright/test
cd ../..

# 5. Shared packages (each: pnpm init with the @scp/* name, tsconfig extending base)
#    packages/schemas       → @scp/schemas       (zod only)
#    packages/sdk           → @scp/sdk           (dev-dep: @hey-api/openapi-ts)
#    packages/cli           → @scp/cli           (commander, depends on @scp/sdk; bin: "scp")
#    packages/iac           → @scp/iac           (depends on @scp/schemas, @scp/sdk)
#    packages/plugin-api    → @scp/plugin-api    (types only, zero runtime deps)
#    packages/plugin-testkit→ @scp/plugin-testkit (depends on @scp/plugin-api, vitest as peer)
pnpm --filter @scp/sdk add -D @hey-api/openapi-ts
pnpm --filter @scp/cli add commander

# 6. Turborepo task graph
cat > turbo.json <<'EOF'
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build":     { "dependsOn": ["^build"], "outputs": ["dist/**"] },
    "openapi":   { "dependsOn": ["@scp/server#build"], "outputs": ["tools/openapi/openapi.v1.json"] },
    "generate":  { "dependsOn": ["^openapi"], "outputs": ["src/generated/**"] },
    "lint":      {},
    "typecheck": { "dependsOn": ["^build"] },
    "test":      { "dependsOn": ["build"] },
    "test:integration": { "dependsOn": ["build"], "cache": false },
    "dev":       { "cache": false, "persistent": true }
  }
}
EOF

# 7. Compose stack (deploy/compose/docker-compose.yml): exactly two services
#    postgres (postgres:16, healthcheck pg_isready) and scp (build: ../../,
#    SCP_ROLE=all, depends_on postgres healthy, port 8080)
#    plus docker-compose.dev.yml overlay: postgres only, port 5432 exposed.

# 8. CI + hygiene
mkdir -p .github/workflows
#    ci.yml per §6; .editorconfig; eslint.config.mjs; .prettierrc; LICENSE
git add -A && git commit -m "scaffold: pnpm/turbo monorepo per DESIGN.md §3"
```

Definition of done for bootstrap: `pnpm install && pnpm build && pnpm lint && pnpm typecheck` all pass on a clean clone with empty-but-compiling packages.

---

## 3. Build Pipeline

### 3.1 Dependency order

The build order is forced by the single-source-of-truth contract pipeline (DESIGN.md §6, §15):

```
@scp/schemas  (Zod — no deps)
   └─▶ @scp/server        (routes typed by schemas)
          └─▶ openapi emit (tools/openapi → openapi.v1.json, COMMITTED)
                 └─▶ @scp/sdk   (generated core via @hey-api/openapi-ts + handwritten layer)
                        ├─▶ @scp/cli
                        ├─▶ @scp/iac
                        └─▶ apps/web  (SPA; consumes only @scp/sdk)
@scp/plugin-api (types only — parallel track)
   ├─▶ @scp/plugin-testkit
   └─▶ packages/plugins/*  (also depend on nothing in the server — enforced by lint rule)
```

Turborepo derives this from workspace `dependsOn`; `pnpm build` = `turbo run build` builds the whole graph in topological order with caching.

### 3.2 Codegen steps (all deterministic, all committed)

| Step | Command | Output (committed?) |
|---|---|---|
| OpenAPI emit | `pnpm --filter @scp/server openapi:emit` — boots route definitions (no DB) and serializes the OpenAPI 3.1 doc | `tools/openapi/openapi.v1.json` — **committed** |
| SDK generation | `pnpm --filter @scp/sdk generate` — runs `openapi-ts -i ../../tools/openapi/openapi.v1.json -o src/generated` | `packages/sdk/src/generated/**` — **committed** (offline builds must not need to regenerate) |
| DB migrations | `pnpm --filter @scp/server db:generate` (drizzle-kit) after schema edits | `apps/server/drizzle/*.sql` — **committed**, forward-only, expand/contract |
| Web build | `pnpm --filter @scp/web build` (Vite) | `apps/web/dist` — not committed; copied into the server image |

**Drift rule:** CI re-runs `openapi:emit` and `sdk generate` and fails on `git diff --exit-code` — the committed spec and generated SDK can never lag the routes (§7).

### 3.3 Incremental builds

- Turborepo hashes inputs per package; unchanged packages are cache hits locally and in CI (cache restored from the self-hosted cache dir or artifact store — no SaaS dependency).
- TypeScript project references (`composite: true`) give incremental `tsc` within packages.
- The server image is a single multi-stage Dockerfile at repo root: `pnpm fetch` layer (lockfile-cached) → build → runtime stage copying `apps/server/dist`, `apps/web/dist`, and bundled plugin dists into one image. A second, much smaller Dockerfile at `apps/runner-iac/` builds the `scp-runner-iac` image (pinned tofu/terraform + run shim; no Node app code — design §12 Mode 2). `docker build -t scp:dev .` and `docker build -t scp-runner-iac:dev apps/runner-iac` are the only image-build commands in the project.

---

## 4. Test Strategy

Four layers, matching DESIGN.md §18. Every layer runs offline; no test may reach the public internet (enforced in CI by running jobs with no egress except the local registry mirror).

```
        ┌──────────────┐   few, slow, definitive
        │     E2E      │   compose stack + CLI + Playwright + 2-domain federation
        ├──────────────┤
        │   Contract   │   committed OpenAPI + oasdiff + SDK-vs-live-server + idempotency fuzz
        ├──────────────┤
        │ Integration  │   real PostgreSQL 16 via Testcontainers — no mocked DB, ever
        ├──────────────┤
        │     Unit     │   pure functions, table-driven, exhaustive
        └──────────────┘   many, milliseconds
```

### 4.1 Unit (Vitest, Node 22, no Docker)

- **What:** change state-machine transition table (every legal and illegal edge), CEL policy evaluation (verdict + reason tree as pure function), wave ordering / topological sort / cycle rejection, permission resolution (containment walk, deny-override), correlation matchers, URN parsing, hash-chain computation, IaC synth determinism (same input → byte-identical manifest).
- **Where:** colocated `*.test.ts` in each package. `pnpm test` = `turbo run test`.
- **Rule:** anything testable as a pure function must be written as a pure function (the design's single guarded transition function, pure policy evaluator, and pure IaC synth exist partly for this).

### 4.2 Integration (Vitest + Testcontainers, real PostgreSQL 16)

- **What:** graph CRUD + type registry, recursive-CTE named queries against seeded fixture graphs, **adversarial RLS cross-org probes** (attempt reads/writes across `org_id` with a mis-set/unset `app.current_org_id`), transactional outbox delivery (Postgres and NATS `EventBus` backends), pg-boss retry/backoff/poison-message behavior, subprocess plugin-host lifecycle (crash isolation, restart-with-backoff, timeout kill), transition-function atomicity (audit event + Decision + state change commit or roll back together), audit-chain integrity (`scp audit verify` logic), migration up-path from every released version's schema snapshot, plan/apply diff engine, federation journal derivation and import idempotency.
- **Executor plugins:** tested against recorded HTTP fixtures (nock) plus a **fake-executor plugin** (in-repo, implements `ExecutorPlugin` with controllable outcomes) used for full coordination-loop tests without any external system.
- **Runner:** `pnpm test:integration` — Vitest project with `testTimeout: 60_000`, one Postgres container per worker, schema migrated per suite, truncate between tests.
- **Plugin conformance:** every shipped plugin runs the relevant `@scp/plugin-testkit` suite in its own package tests.

### 4.3 Contract

- **Spec stability:** `tools/openapi/check.sh` runs vendored `oasdiff breaking` between the committed spec on the merge base and the newly emitted spec; any breaking change within `/v1` fails CI.
- **SDK-vs-server:** the generated SDK is exercised against a live server (compose Postgres + `scpd` booted in-process) covering every resource: create/read/update/delete/list/paginate through SDK calls only.
- **Idempotency fuzzing (fast-check):** property-based tests firing randomized sequences of `PUT` upserts-by-URN, replayed `Idempotency-Key` POSTs, and duplicated federation-journal applications, asserting convergence to identical graph state — this property is what federation import correctness rests on.

### 4.4 E2E

- **Golden path (CLI, compose in CI):** script boots `docker compose up`, then via the real `scp` CLI: register service → register component → connect fake executor → propose change → gate blocks → approve → promote → `scp change explain` shows the Decision → `scp audit verify` passes.
- **UI (Playwright, Chromium):** login (local auth), graph explorer renders seeded org, service detail shows owners/dependents, change detail shows waves and a working "Why?" Decision link, blocked action surfaces `decision_id`. Runs against the compose stack; also a `pnpm --filter @scp/web test:e2e` local target against the dev server.
- **Two-domain federation round-trip (every merge, non-negotiable):** compose file with two isolated `scpd`+postgres pairs; create objects in Domain A → `scp federation export` → file copy (simulating the air gap — no network path exists between the stacks) → `scp federation import` into B → assert graph equivalence → promote a change through B's **local** gates → export status back to A → assert convergence and audit-chain integrity on both sides.

### 4.5 What runs where / target runtimes

| Layer | Local dev | CI | Needs Docker | Target runtime |
|---|---|---|---|---|
| Unit | on save (`vitest --watch`) | every push | no | Node 22 |
| Integration | `pnpm test:integration` before push | every push | yes | Node 22 + postgres:16 |
| Contract | `pnpm contract` | every push | partial | Node 22 |
| E2E | on demand | every merge to main + every PR labeled `e2e` (fast subset on all PRs) | yes | linux/amd64 compose stack; Chromium |
| Chart install | on demand (`kind`) | nightly + release | yes | kind ≥ 1.30 |

Published images target **linux/amd64 and linux/arm64**. Node 22 is the only supported server runtime for v1.

---

## 5. Local Development Loop

### 5.1 Services

`deploy/compose/docker-compose.dev.yml` runs **Postgres only** (port 5432); the app runs on the host for hot reload:

```bash
docker compose -f deploy/compose/docker-compose.dev.yml up -d   # postgres:16 + named volume
pnpm dev                                                        # turbo run dev:
#   @scp/server  → tsx watch src/main.ts   (SCP_ROLE=all, port 8080, auto-migrate on boot in dev)
#   @scp/web     → vite dev server, port 5173, proxies /api → localhost:8080
#   @scp/schemas, @scp/sdk, @scp/cli, @scp/iac → tsc --watch
```

Hot reload: server restarts in ~1s via tsx; web HMR via Vite; schema changes ripple through watch-mode `tsc` (SDK regeneration is only needed when routes change: `pnpm gen` = emit spec + regenerate SDK).

### 5.2 Full-stack evaluation mode (what a new user runs)

```bash
docker compose -f deploy/compose/docker-compose.yml up
# exactly two containers: postgres:16 + scp (api + worker + built UI, local auth)
```

### 5.3 Seeding — the five-minute-value experience

`pnpm seed` (and `SCP_SEED_DEMO=true` in the compose file, on by default for the eval stack) idempotently creates via the **public API only**: a demo org, one domain, bootstrap admin (`admin` / printed one-time password), the fake executor connected, two services with components, ownership/`depends_on`/`consumes` edges, one policy, and one in-flight change sitting at an approval gate. A fresh user therefore sees the charter's five-minute path — deploy → register service → register component → connect executor → see useful information — already alive, and the README walks them through repeating it themselves with `scp service register …`. The seed script doubles as the E2E fixture, so the demo experience is itself under test.

### 5.4 Everyday commands

```bash
pnpm dev                 # everything in watch mode
pnpm test                # unit, fast
pnpm test:integration    # real Postgres
pnpm gen                 # openapi emit + SDK regen (run after route changes)
pnpm check               # lint + typecheck + spec-drift — the pre-push gate
pnpm seed                # (re)seed demo data
pnpm doctor              # toolchain sanity
```

---

## 6. CI Pipeline

Reference implementation is GitHub Actions (`.github/workflows/ci.yml`), but **every stage is a plain pnpm/docker command with no hosted-service dependency**, so the identical pipeline runs on self-hosted runners, GitLab CI, or a bare `scripts/ci-local.sh` on an air-gapped machine — a charter requirement (self-hosting first). Required tooling (Node, pnpm store, Playwright browsers, oasdiff) is baked into a versioned CI runner image built from `tools/ci-image/Dockerfile`.

Stages (each a job; 2–5 fan out in parallel after build):

| # | Stage | Command | Gates merge? |
|---|---|---|---|
| 1 | Setup & build | `pnpm install --frozen-lockfile && pnpm build` (Turbo cache restored) | yes |
| 2 | Static checks | `pnpm lint && pnpm typecheck` | yes |
| 3 | Codegen drift | `pnpm gen && git diff --exit-code` + `tools/openapi/check.sh` (oasdiff vs merge base) | yes |
| 4 | Unit + coverage | `pnpm test -- --coverage` (thresholds in §7) | yes |
| 5 | Integration | `pnpm test:integration` (Testcontainers Postgres) | yes |
| 6 | Contract | `pnpm contract` (SDK-vs-live-server + idempotency fuzz) | yes |
| 7 | E2E | `docker build -t scp:ci . && pnpm e2e` — golden path CLI + Playwright smoke + **two-domain federation round-trip** | yes on merge to main; fast subset (golden path only) on PRs |
| 8 | Package (main only) | multi-arch image build, `helm lint` + kind install test, `pnpm --filter @scp/airgap bundle` (nightly) | no (informational until release) |
| 9 | Release (tag only) | Changesets version/publish, image push, cosign sign, air-gap bundle `scp-bundle-<version>.tar.gz` build + signature | n/a |

**Merge policy:** a PR merges only when stages 1–6 are green, stage 7's PR subset is green, and (for changes under `packages/plugin-api` or `packages/sdk`) a changeset file is present (`pnpm changeset status` check).

---

## 7. Quality Gates

| Gate | Tool / command | Threshold / rule |
|---|---|---|
| Lint | ESLint 9 flat config + typescript-eslint (`pnpm lint`) | zero errors; warnings fail CI |
| Import boundaries | eslint `import/no-restricted-paths` | `apps/web` may import only `@scp/sdk` + `@scp/schemas`; `packages/plugins/*` may import only `@scp/plugin-api`; server modules respect DESIGN §1 module boundaries |
| Format | Prettier (`pnpm format:check`) | byte-exact |
| Types | `tsc --noEmit` strict everywhere (`pnpm typecheck`) | zero errors; no `any` escapes in `@scp/schemas`, `@scp/plugin-api`, `@scp/sdk` public surfaces (`noImplicitAny` + eslint ban) |
| Unit coverage | Vitest v8 provider | global ≥ **80% lines/branches**; ≥ **95%** for `coordination/transitions`, `governance/evaluate`, `authz/resolve`, `graph/traverse`, `federation/journal` — the modules whose failure modes are the platform's worst |
| API spec drift | `pnpm gen && git diff --exit-code` | committed spec/SDK always match routes |
| API breaking change | `oasdiff breaking base.json head.json` | zero breaking changes within `/v1`; overridable only by an explicit `api-v2-exception` label + review |
| Migration safety | CI job applies migrations to the previous release's schema snapshot, then boots the previous server version against the migrated schema | expand/contract holds (old code runs on new schema) |
| Audit integrity | integration test + `scp audit verify` in every E2E run | chain verifies end-to-end |
| Dependency hygiene | `pnpm audit --prod` (against a mirrored advisory DB for air-gapped runners) + lockfile-only installs | no critical vulns in prod deps at release |
| Release artifacts | cosign verify in the release pipeline itself | every published image/bundle verifiable offline |

---

## 8. Milestone Plan

Ordered milestones from empty repo to MVP. Each is independently verifiable; its verification lands as permanent CI tests, so "done" is machine-checked from then on. Sequencing follows the charter's adoption phases (graph → services/relationships → changes+coordination → governance → campaigns/initiatives → federation → integrations); real executor integrations come last because the fake executor and webhook escape hatches let every engine milestone be fully exercised without them.

### M0 — Walking Skeleton
- **Goal:** the smallest thing that is end-to-end real: compose up → API + DB + UI stub + one object registered via CLI, with the full contract pipeline already in place.
- **Contents:** repo bootstrap (§2); Drizzle migrations runner; minimal `objects` table + `POST/GET /api/v1/objects/service` (org from token; the `orgs/{org}` path override registered from day 1 — design §6); local-auth plugin with bootstrap admin; Fastify serving a UI stub page that lists objects via the SDK; Zod→OpenAPI emit→SDK gen→CLI (`scp login`, `scp object create/list`) pipeline; single `scp` image; two-container compose file; CI stages 1–4 live.
- **Done / verified by:** on a clean machine: `docker compose up`, then `scp login && scp object create service --name billing && scp object list service` shows the object, and the UI stub shows it in a browser. This exact script is CI's first E2E test. `pnpm gen && git diff --exit-code` passes.

### M1 — Graph Core
- **Goal:** the charter's Core Graph Engine: generic objects + first-class relationships + runtime type registry, with tenancy, audit, and authorization foundations — the substrate every later milestone writes into.
- **Contents:** full `object_types`/`relationship_types`/`objects`/`relationships` schema (UUIDv7, URN, provenance columns, soft delete, optimistic concurrency) with pre-seeded built-in types; generic `/objects/{type}` + `/relationships` endpoints incl. idempotent upsert-by-URN and `Idempotency-Key`; RLS multi-tenancy (`SET LOCAL app.current_org_id`); hash-chained `audit_events` written in-transaction + `scp audit verify`; RBAC (`roles`/`role_bindings`, containment inheritance, deny-override); transactional outbox + pg-boss worker skeleton; named graph queries (`owners-of`, `dependents-of`, `consumers-of`, `impact-of`, `blast-radius`, `paths-between`, …) and bounded `/graph/traverse`; RFC 9457 errors; cursor pagination; SSE `/events/stream`.
- **Done / verified by:** integration suite passes: adversarial RLS cross-org probes fail closed; custom object/relationship type registered via API is immediately usable through generic endpoints, SDK, and CLI with no deploy; named queries return correct closures on a fixture graph (incl. cycle handling and depth limits); audit chain verifies after 10k mixed writes; fast-check idempotency properties hold on all write endpoints.

### M2 — Registries, Relationships & the Modeled Org (+ IaC, OIDC)
- **Goal:** charter Phase 1–2 value: register real services/components/domains, model ownership/consumers/dependencies, see it in a real UI, and manage it as code.
- **Contents:** typed convenience endpoints for domains, services, components, deployment-targets, teams, groups, users, service-accounts (thin layers over the graph); ownership/`consumes`/`depends_on` flows; Web UI v1 (React SPA: login, object browsing, Cytoscape graph/impact explorer fed by named queries, SSE live updates); generic-OIDC identity plugin (Auth Code + PKCE) + PATs + CLI device flow; `@scp/iac` constructs (`Service`, `Component`, `Team`, ownership) with pure synth; server-side `/plans` + `/plans/{id}:apply` diff engine; `scp plan` / `scp apply`; seed script + five-minute-value demo experience (§5.3).
- **Done / verified by:** E2E: seeded org renders in the graph explorer; `scp service register` → service visible in UI within one SSE tick; an `@scp/iac` stack applied twice is a no-op the second time (plan shows zero actions); OIDC login round-trip tested against a containerized Keycloak fixture; Playwright smoke suite established. Charter five-minute path demonstrable by script.

### M3 — Changes & Coordination Engine
- **Goal:** the charter's primary operational responsibility: the Change lifecycle, correlation, plans/waves/topologies, and rollback — proven against the fake executor.
- **Contents:** `changes` projection table + table-driven state machine with the single guarded transition function (audit event + Decision record per transition — Decision records land here, not in M4); change sources API + webhook ingress (persist-then-process); correlation (`source_mappings`, correlation keys, artifact digests, CoordinatedChange groups); Release Topologies as versioned documents; plan compiler (graph-derived wave ordering, toposort, cycle rejection, fan-out/fan-in); resumable pg-boss reconciliation loop; stuck-change watchdog (per-state progress SLAs; a sweep flags stalled changes, writes a Decision naming what is being waited on, escalates via notifications — design §9.4); rollback-as-its-own-Change (manual trigger); fake-executor plugin + `@scp/plugin-testkit` for the Executor interface; subprocess plugin host (`scpd plugin-host`: one child process per plugin instance, JSON-RPC over stdio, timeouts, restart-with-backoff — design §11) with the fake executor running under it; NATS JetStream `EventBus` implementation + compose profile and Helm toggle (design §8 — Postgres remains the default); `scp change propose/promote/rollback/explain`; UI change list + wave progression view.
- **Done / verified by:** unit: exhaustive legal/illegal transition table; toposort property tests. Integration: full loop with fake executor — propose → coordinate → execute (fake) → validate → promote, then trigger rollback and verify prior state ref executed; kill the worker mid-wave and verify resume from Postgres state. Plugin-host isolation: kill the fake-executor subprocess mid-wave and verify the worker survives, the plugin restarts with backoff, and the wave resumes. Event-bus suite passes against both Postgres and NATS backends. The watchdog flags an artificially stalled change within its SLA and produces a Decision. Every transition has a queryable Decision; `scp change explain` renders it.

### M4 — Governance Engine
- **Goal:** policies, controls, approvals, freezes, and emergency flow — gates that actually block, with explainability as the return value.
- **Contents:** policy documents (CEL conditions, scope selectors, advisory/recommended/required, containment inheritance, stricter-wins); control objects + ControlPlugin bindings; webhook-control escape-hatch plugin; approval controls (N-of-M quorum, `approves` relationships, Ed25519 attestation signed at creation — design §10.2) actionable via API/UI/CLI; freeze windows + audited `freeze:override` with mandatory reason; emergency-change path; gates bound to wave boundaries and lifecycle edges; `decision_id` on every blocked 4xx; `scp policy evaluate`; UI "Why?" links everywhere.
- **Done / verified by:** the **full golden path** becomes CI's flagship E2E: register → propose → required gate blocks (response carries `decision_id`) → approve via CLI → promote → `scp change explain` reconstructs policy version + control outcome + evidence → `scp audit verify`. Integration: stricter-wins resolution matrix; freeze blocks then override audits with reason; hybrid (scan AND approval) gate; policy evaluation is pure (same context snapshot → same verdict, property-tested).

### M5 — Campaigns & Initiatives
- **Goal:** coordinated multi-change activity and strategic roll-up over the existing engine — no new machinery.
- **Contents:** Campaign objects that `coordinate` many Changes with their own plan/waves/gates; Initiative objects grouping campaigns with traversal-derived roll-up status; campaign-scoped rollback; `scp campaign create/status`; IaC constructs for Campaign/Initiative/ReleaseTopology; UI campaign board + initiative roll-up.
- **Done / verified by:** E2E: a "patch 3 services" campaign compiles to per-target changes, wave 2 blocked by one target's failing control while wave 1 promotes; campaign status aggregates correctly; initiative roll-up reflects it; campaign-level rollback reverts promoted targets. All engine invariants from M3/M4 re-verified at campaign scope in integration tests.

### M6 — Federation Basics
- **Goal:** the charter's Basic Federation: two domains exchanging signed journals, offline-first, with promotion-as-evidence semantics.
- **Contents:** outbox-derived sync journal (per-domain sequence, hash-chained, Ed25519-signed segments; reserved v1-unused `base_revision`/`conflict` fields — design §13); shared-authority overlays (`annotates` objects; policy overlays stricter-only); peer pairing + configurable sync scope; file transport built-in (`scp federation export/import` bundles) + `federation-https` mTLS plugin (outpost-initiated only: pull config, push status); bundle-transfer tracking (exported → submitted → confirmed on return); import via the idempotent public write path; single-writer authority + read-only replicas; **commander/outpost enrollment** (commander designation, outpost registration, read-only commander-origin config replicas, `provenance: manual` hand-fill with reconcile-on-import — design §13); Promotion Bundles (change + provenance + control evidence + artifact digests + per-approval attestations validated against exchanged domain keys → local `proposed` change, `imported_from_domain`, approvals as evidence never authority); audit segments riding the journal; commander cross-domain status UI (all domains, sync freshness, in-flight changes).
- **Done / verified by:** the **two-domain round-trip E2E on every merge** (§4.4): export A → file-copy across a real network boundary → import B → graph equivalence → promote through B's local gates → status returns to A → convergence + audit-chain integrity both sides. Integration: interrupted-transfer resume from cursor; double-import is a no-op; tampered segment (bad signature or broken chain) is rejected; tampered or missing approval attestation rejects the approval as evidence; hand-filled commander-origin config reconciles correctly when the signed bundle later arrives; overlay round-trip: an outpost annotates a commander-origin policy, the merged view renders via API/UI, and the base object is never mutated; a network fixture blocks every commander→outpost connection and sync still converges (outpost-initiated pull + push only); scope filters honored.

### M7 — Real Executor Integrations
- **Goal:** replace "fake" with the charter's named MVP integrations — GitHub, ArgoCD, Terraform/OpenTofu — exercising push, pull, and hybrid detection.
- **Contents:** GitHub App plugin (webhooks + polling fallback, `workflow_dispatch` trigger, check/commit-status reporting, repo Discovery proposing Services/Components/source_mappings); ArgoCD plugin (app watch, sync trigger, terminate, sync-to-previous-revision rollback); Terraform/OpenTofu in both modes (design §12): the pipeline-mediated plugin (`scp change-source report --plan-json`, TFC/Atlantis webhooks, gate-verdict endpoint the org's apply step consults, pipeline trigger) and the `scp-managed-iac` executor with its separate `scp-runner-iac` image (thin orchestrator plugin; per-run ephemeral runner container — K8s Job or docker run — carrying pinned tofu/terraform; vaulted scoped credentials injected only into the runner; plan persisted as change evidence); smtp-notify + webhook-notify plugins; plugin config schemas surfaced as validated forms in UI/CLI.
- **Done / verified by:** each plugin passes its `@scp/plugin-testkit` conformance suite plus nock-fixture integration tests (webhook signature verification, pagination, rate-limit/backoff, poll-vs-push equivalence); an opt-in live-sandbox E2E job (nightly, real GitHub org + kind-hosted ArgoCD) proves the happy path; the golden-path E2E gains a variant where the executor is ArgoCD-in-kind. The managed-IaC executor is proven by an integration test that launches a real `scp-runner-iac` container against a local-state tofu fixture end-to-end: plan evidence → gate block → approve → apply → rollback via the prior state ref. Discovery proposals require explicit acceptance (never auto-commit) — asserted in tests.

### M8 — MVP Hardening, Packaging & Release Candidate
- **Goal:** ship it: production Kubernetes path, air-gap bundle, hardening, and release machinery — MVP scope closed.
- **Contents:** Helm chart (api/worker Deployments, migrations Job pre-upgrade hook, optional runner-iac Job template for Mode 2, hardened defaults, NetworkPolicies, ServiceMonitor); air-gap bundle builder (OCI layout via skopeo, chart, compose, plugins, checksums, cosign signatures, registry-retarget install script) — bundle doubles as the upgrade package; Ansible collection `scp.platform` wrapping the bundle installer for VM/on-prem fleet updates (design §16); informational load tests of the outbox/pg-boss and NATS event paths at target webhook rates (no benchmark gate — review decision); security pass (secrets handling, token hashing audit, RLS review); versioned docs; Changesets-driven `v1.0.0-rc`.
- **Done / verified by:** kind CI job: `helm install` → seeded golden path passes → `helm upgrade` from previous build with zero downtime (expand/contract proven) → rollback. Air-gap drill in CI: build bundle → install into a network-isolated kind cluster from a local registry → golden path + federation file round-trip pass with **zero external egress** (enforced by network policy). An Ansible-driven upgrade of a compose-based instance passes in CI. All §7 gates at release thresholds.

### M9 — Road to 1.0 (post-RC hardening)
- **Goal:** close the four disclosed post-`v1.0.0-rc` items so `v1.0.0` is a true GA rather than an rc with known gaps — graph reachability performance, dependency-advisory hygiene, in-app federation transport identity, and turning the written deployment drills into proven-green ones. (Beyond the original M0–M8 MVP scope; the pre-GA pass.)
- **Contents:**
  - **Graph reachability-CTE node-dedup** — rewrite `impact-of`/`dependents-of`/`consumers-of`/`blast-radius`/`domains-impacted` (`graph/named-queries.ts`) to dedupe at the node level between recursion steps (drop path-tracking for the reachability variants in favor of `UNION` visited-set semantics; any depth/distance column becomes a post-aggregate), eliminating the fan-in^depth intermediate-row blowup on shared-component topologies. `paths-between` keeps full path-tracking. The M8 defensive `statement_timeout` guardrail remains as belt-and-suspenders.
  - **Dependency-advisory pass** — resolve the pre-existing lodash-es HIGH (prod, via `cel-js>chevrotain>lodash-es`) by upstream bump / pnpm override / justified+expiring audit-ignore, and the moderate esbuild advisory (dev-only, via `drizzle-kit>@esbuild-kit`) by bump or a documented dev-only-not-shipped disposition.
  - **In-app federation mTLS** — server-side client-cert request+verification on federation transport endpoints, mapping the peer cert identity (CN/SAN) to the expected commander/outpost, **fail-closed** on misconfiguration, optional (air-gap file transport unaffected), with documented precedence vs. the M8 ingress-mTLS option. Preceded by an ADR (`docs/adr/`) + DESIGN.md edit reviewed before implementation.
  - **Deployment drills proven-green (prove-once + nightly)** — get the kind, air-gap, and Ansible drills (`scripts/*-drill.sh`, `.github/workflows/deploy-drills.yml`) to a recorded green run on the self-hosted runner (starting with a nested-kind capability spike), fixing whatever breaks (disk, CNI/privileges, offline vendoring of the Calico manifest + base images); kept nightly + on-demand, never a per-PR gate.
- **Done / verified by:**
  - **Graph:** a property test over random graphs (incl. cycles + shared components) asserts each reachability query's result **set equals** a naive BFS reachable-set (semantics preserved), and a perf regression test on the pathological high-fan-in topology completes well under the `statement_timeout`; `paths-between` results unchanged.
  - **Advisories:** `pnpm audit --prod` clear of the lodash-es HIGH; the esbuild advisory resolved or explicitly dispositioned; full suite green after any override.
  - **mTLS:** integration matrix — valid peer cert → federation sync succeeds; no cert / wrong-CA / valid-CA-but-wrong-identity → rejected fail-closed; air-gap file transport unaffected; ADR + Helm values + DESIGN.md merged.
  - **Drills:** each of the three has ≥1 linked green run on the self-hosted runner, re-triggered once for stability; the workflow's honest-scope comment updated from "not claimed as passing CI yet" to the recorded green run IDs + date.

---

### M10 — Execution strategy foundations
- **Goal:** land the **now + near** horizons of the approved execution strategy (owner decisions 2026-07-12; [ADR-0002](adr/0002-execution-strategy.md), `docs/proposals/execution-strategy.md`): the governing docs, the `observe()` polling driver, real-cluster ArgoCD hardening, the CI-evidence wave-gate control, the GitLab dedicated plugin, and the generic pipeline executor. **`scp-runner-ops` (Mode C host-reaching) and the bundled Standard Stack backends are explicitly OUT of M10** — each is gated on its own preconditions (SSTI closure + SSH-CA analysis for the runner; per-backend vendoring + license pass for the bundles; ADR-0002 Consequences) and lands in later milestones. (Beyond the original M0–M8 MVP scope; §9's Verification Mapping tracks charter MVP items only and is unchanged.)
- **Contents:**
  - **M10.1 Governing docs** — the approved package (this PR): the charter amendment (Mode C host-reach + the Mode B scope decision + the Standard Stack allowlist), [ADR-0002](adr/0002-execution-strategy.md) (four-arm ownership test + six-gate boundary test + bundling-flips-gate-1), the DESIGN §12/§19 edits (referencing §16 packaging) (three-mode strategy + Mode B + layer-composition table), and this milestone.
  - **M10.2 `observe()`/status polling driver** — a worker loop drives each bound executor's `observe()` on an interval with **persisted per-binding cursors**, ingesting events on the same `change_source_events` → `webhook-processor` path the inbound webhook uses. This is the fallback for domains whose executors cannot reach SCP's ingress (air-gapped/tailnet-only) and the prerequisite that makes Mode B's coordination value real (the known gap: today only inbound webhooks create Changes).
  - **M10.3 ArgoCD real-cluster hardening** — the `argocd` plugin exercised against a real cluster via the agentkit gamma→prod trial (converts it from mock-tested to demonstrated); per-cluster = per-`pluginInstanceId` binding pattern documented.
  - **M10.4 CI-evidence wave-gate control** — a concrete "CI green for digest X" control (a `github-check`/`webhook-control` binding) evaluable at `evaluateWaveGate`, so CI evidence can gate the infra→app boundary — the composition model's signature move.
  - **M10.5 GitLab dedicated plugin** — SCM + CI in one (trigger tokens, cancel, system/webhooks); opens the enterprise-VM and air-gapped-gov org profiles.
  - **M10.6 Generic pipeline executor** — extract `@scp/plugin-pipeline-generic` from the terraform Mode-1 shape (Mode 1 becomes a preset); a **required structured-evidence report schema** (`additionalProperties:false`) on the inbound `scp change-source report`/webhook path — the discipline that separates it from a "call any URL" bus and makes every coordinate-generic verdict real.
- **Done / verified by:**
  - **Docs:** charter amendment + ADR-0002 (Status: Accepted) + DESIGN §12/§19 edits (referencing §16 packaging) + this milestone merged; the three proposals linked as the exploratory record.
  - **Observe driver:** integration test (Testcontainers Postgres) — a bound executor's `observe()` output creates a Change with **no inbound webhook**; cursor persists across a worker restart; re-observing an already-seen event is a no-op (idempotent).
  - **ArgoCD:** the agentkit trial drives ≥1 real gamma→prod change to `succeeded` through the `argocd` plugin against a live cluster; per-instance binding docs merged.
  - **CI-evidence control:** integration test — a wave gate **blocks** until the bound control reports CI-green for the target digest, then **allows**; a Decision with the control outcome is persisted.
  - **GitLab:** conformance suite (`plugin-testkit`) + nock coverage for trigger/status/abort/observe; contract parity with the `github` plugin.
  - **Generic executor:** contract test that the structured-evidence schema **rejects** malformed/unknown-field reports; the terraform Mode-1 plugin refactored onto the generic preset with its existing suite green.

---

### M11 — SCP Standard Stack (bundled executor backends)
- **Goal:** ship the opt-in, air-gap-vendored **Standard Stack** bundles (Mode B — [ADR-0002](adr/0002-execution-strategy.md), `docs/proposals/bundled-executor-backends.md`), starting with **Argo CD**, so a domain lacking an executor gets one FROM SCP while SCP still only COORDINATES it (the backend keeps its own kube creds; SCP holds a scoped API token — credential-asymmetry invariant unamended). Off by default; the coordination core is unchanged. **`scp-runner-ops` (Mode C) is not part of M11.**
- **Updated 2026-07-18 ([ADR-0012](adr/0012-registry-consolidation.md), [ADR-0013](adr/0013-supply-chain-scan-sbom-manifest.md); master: `docs/proposals/promotion-and-execution-model.md`):** **Gitea** is added as the **default unified registry** (git + OCI images + rpm/npm/Maven/Helm/…); **Harbor (M11.4) is demoted to optional**; **scanning moves to a coordinated Trivy step** (results→commander as gate evidence, M17), not a registry feature. **Argo Workflows (M11.3)** is the universal **build/test/scan/SBOM** engine for all artifact types and also runs IaC **plan→apply** for cloud infra.
- **Contents:**
  - **M11.1 Bundle framework** — the reusable opt-in Helm profile shape (`bundledExecutor.*`, `enabled: false`, fail-closed empty image refs) + vendored-OCI-in-the-signed-bundle + the post-install auto-wire hook, established by the Argo CD bundle.
  - **M11.2 Argo CD + Valkey** — vendored, UNMODIFIED upstream Argo CD **v3.4.5** (`deploy/helm/vendor/argocd/install.yaml`, sha256-pinned) rendered into its own namespace (`scp-argocd`) with three byte-level substitutions only: argocd image → retargeted image, upstream redis → **Valkey** (owned deviation), ClusterRoleBinding subject namespace → `scp-argocd`. Scoped apiKey account + get/sync-only RBAC + `server.insecure` injected into Argo CD's own ConfigMaps (operator config, not a fork). The **auto-wire hook** (`bundled-argocd-autowire-bin.ts`, a `migrate-bin`-style DB-seed) mints a scoped account token and stores it as SCP secret `bundled-argocd-token`. `allow-argocd` NetworkPolicy; `build-bundle.ts` + `install.sh` carry + retarget the argocd/valkey images.
  - **M11.3 Argo Workflows + Argo Events** — vendored, UNMODIFIED upstream (Workflows **v4.0.7**, split into 4 ordered <5 MB parts to fit Helm's per-file limit, reassembled byte-for-byte; Events **v1.9.10**) rendered into their own namespaces via the shared `commanderscp.renderVendoredBackend` helper (surgical namespace + ClusterRoleBinding-subject re-homing; CRDs passthrough), images retargeted. **Deploy-tier** (no auto-wire) — coordinating Workflows is the generic pipeline executor's job (M10.6); Argo Events can POST to the change-source webhook to feed observe() (M10.2). SCP never runs CI itself.
  - **M11.4 Harbor** (bundled registry + Trivy, **observe-only**) — **OPTIONAL as of ADR-0012** (Gitea is the default registry; Harbor remains bundle-able/importable for enterprise-registry needs). helm-template-then-vendor of the full registry stack (own Postgres/Redis/Trivy) at **v2.15.1** into `scp-harbor` via the shared `commanderscp.renderVendoredBackend` helper, the heaviest bundle. Harbor's ~15 chart-baked secret values would freeze to static, identical-for-everyone credentials, so the **7 Secrets are stripped from the vendored manifest and SCP-GENERATED per install** (`harbor-secrets.yaml`): random values, correct **cross-references** (one Postgres password shared by core+database; one registry-credential shared by core+jobservice and bcrypt'd into the registry htpasswd), a self-signed token-signing cert, all persisted across `helm upgrade` via `lookup`. Nine goharbor images retargeted+digest-pinned individually (`build-bundle.ts`/`install.sh`); `allow-harbor` NetworkPolicy; helm-verify locks the cross-reference invariants into CI. Observe-only: SCP reads image/scan state through a scoped read token, never Harbor's admin/infra creds.
  - **M11.5 Delivery split (out-of-release)** — an E2E kind drill (`scripts/bundled-argocd-drill.sh`) surfaced that Helm stores the WHOLE chart in its release Secret, and the ~12 MB of vendored manifests (Argo Workflows alone is 11 MB) blew the SCP release past Kubernetes' **1 MB Secret limit** — `helm install` failed outright, independent of any profile (ArgoCD/compose deploys were unaffected, hence unnoticed). Fix: the vendored backends moved OUT of the main chart into a **separate `deploy/helm-bundled` chart**, delivered via `helm template … | kubectl apply --server-side` (no stored release ⇒ no 1 MB ceiling; server-side ⇒ large CRDs don't overflow the client-side annotation). The main chart drops to ~40 KB and keeps only the SLIM integration (auto-wire hook + `allow-argocd`/`allow-harbor` NetworkPolicy). Enabling stays a single command — **`scripts/scp-bundled.sh enable <backend>`** renders+applies the backend and flips the SCP release's hook/NetworkPolicy; the air-gap `install.sh` calls it for every backend the bundle carries. helm-verify renders BOTH charts + guards the main chart's packaged size < 1 MB (regression guard).
  - **M11.6 Gitea — default unified registry + git** ([ADR-0012](adr/0012-registry-consolidation.md)) — vendored, sha-pinned Gitea in `scp-gitea` via the shared `commanderscp.renderVendoredBackend` helper; SCP-generated secrets (admin/secret-key), DB per the M15 decision (**shared bundled Postgres if available, else SQLite+PVC — never a dedicated new Postgres**); scoped-token auto-wire hook; `allow-gitea` NetworkPolicy; bundle image carry/retarget; `scp-bundled.sh` verb; helm-verify gates. Serves **git + OCI container images + rpm/npm/Maven/Helm/Go/…** — one registry for every artifact type. The git-service-agnostic executor + Gitea coordination land in **M15.1**; the same Gitea runs locally on outposts (M15). Harbor (M11.4) is the optional alternative for enterprise image-registry needs.
- **Done / verified by:**
  - **helm-verify:** profile-OFF ⇒ **zero** `scp-argocd` resources (the "never load-bearing / two-container floor" guarantee); profile-ON ⇒ `argocd-server` isolated in `scp-argocd`, **every image retargeted** (no `quay.io/argoproj` / `public.ecr.aws` ref survives — the air-gap contract), SCP's strict pod-hardening applied to SCP's OWN resources only (bundled backend is unmodified upstream, isolated), and the auto-wire Job passes SCP hardening.
  - **Air-gap:** the argocd + valkey images ride the signed `scp-bundle` (`build-bundle.ts` image list) and `install.sh` retargets them to the customer registry via values (never hardcoded — avoids the eval-postgres trap); the tamper-rejection suite (`@scp/airgap`) stays green.
  - **E2E (kind/homelab drill):** enabling the profile deploys Argo CD; the auto-wire hook mints a scoped token + stores it; binding an object to the `argocd` executor drives a real Application sync — the token round-trip validated against a LIVE Argo CD (the piece helm-verify can't cover).

### M17 — Supply-Chain Gate (scan + SBOM + signed promotion manifest)
*(Design: [ADR-0013](adr/0013-supply-chain-scan-sbom-manifest.md), [ADR-0012](adr/0012-registry-consolidation.md); master: `docs/proposals/promotion-and-execution-model.md`.)*
- **Goal:** make cross-boundary promotion verifiable. Scanning is a **boundary-crossing authorization gate** (not a general quality gate) — a coordinated **Trivy step** (in Argo Workflows) scans any artifact type and emits the **SBOM** in the same pass; the commander signs the artifact(s), SBOM, and a **promotion manifest** (cosign) enumerating exactly the authorized artifact set. The receiver verifies signature + manifest match at **every hop** ("nothing slipped in"). Applies to **commander-tracked** artifacts only; domain-local outpost-originated artifacts are exempt (they don't cross a boundary — keeps outposts light). SCP is the promotion authority (no registry pull-blocking needed).
- **Contents:**
  - **M17.1 Scan-result ingestion** — SCP consumes the coordinated Trivy step's verdict as gate evidence (a Control/gate on the change); no scan pipeline exists today (Harbor observe was aspirational).
  - **M17.2 SBOM generation** — build-time SBOM (same Trivy pass), stored + referenced on the promotion.
  - **M17.3 Signed promotion manifest** — cosign-signed enumeration of the authorized artifact digests (artifact + SBOM + manifest).
  - **M17.4 Cross-hop verification** — retrans (before crossing the CDS) and outpost (before deploy) verify signature + arrived-set-matches-manifest; no re-scan (trust scan-at-source). Ties to [ADR-0011](adr/0011-universal-outpost-validation.md).
- **Done / verified by:**
  - **Integration:** a promotion with a failing scan is blocked (Decision recorded); a passing one is signed with a manifest; a receiver rejects a promotion whose arrived set doesn't match the signed manifest (an injected/substituted artifact fails), and accepts a matching one — no re-scan performed.

---

## 9. Verification Mapping

Every MVP Scope item from the charter, the milestone that delivers it, and the test layer that proves it (deepest layer listed; lower layers also cover it).

| Charter MVP item | Delivered in | Proven by |
|---|---|---|
| Core Graph Engine | M1 | Integration: traversal/named-query suite on fixture graphs (depth limits, cycle handling) |
| Organization Model | M0 (seeded) / M1 (full) | Integration: RLS adversarial probes; org-scoped API tests |
| Domain Model | M2 | Integration: domain containment queries; E2E: federation round-trip (M6) |
| Service Registry | M2 | E2E: golden path `scp service register`; contract suite CRUD |
| Component Registry | M2 | E2E: golden path; contract suite CRUD |
| Relationships | M1 | Integration: first-class relationship CRUD, endpoint/cardinality constraints; idempotency fuzz |
| Ownership | M2 | Integration: `owners-of` query; unit: ownership ≠ permissions separation |
| Consumers | M2 | Integration: `consumers-of` / `impact-of` transitive closure tests |
| Policies | M4 | Unit: CEL evaluator (pure, property-tested); integration: stricter-wins matrix; E2E: gate blocks golden path |
| Controls | M4 | Integration: outcome taxonomy + evidence persistence; plugin-testkit conformance (webhook control) |
| Change Model | M3 | Unit: exhaustive transition table; integration: full loop with fake executor |
| Campaigns | M5 | E2E: multi-service campaign with blocked wave + campaign rollback |
| Initiatives | M5 | Integration: traversal-derived roll-up status |
| Governance Engine | M4 | E2E: golden path (block → approve → promote → explain); integration: freezes, emergency, hybrid gates |
| REST API | M0 (contract pipeline) → all | Contract: committed OpenAPI + oasdiff gate + SDK-vs-live-server + idempotency fuzz |
| Web UI | M0 stub / M2 v1 / M3–M5 views | E2E: Playwright suite incl. "Why?" Decision links; lint gate: UI imports only `@scp/sdk` |
| TypeScript SDK | M0 | Contract: generated-SDK-vs-live-server across all resources |
| CLI | M0 | E2E: entire golden path executed via `scp`; unit: command tree over mocked SDK |
| TypeScript IaC | M2 | Unit: deterministic pure synth; E2E: apply-twice-is-no-op plan test |
| PostgreSQL Persistence | M0 | Integration: everything runs against real postgres:16; migration up-path gate |
| Authentication | M0 (local) / M2 (OIDC) | Integration: OIDC round-trip vs containerized Keycloak; PAT + device-flow tests |
| Authorization | M1 | Integration: RBAC inheritance + deny-override matrix; RLS probes (defense-in-depth) |
| ArgoCD Integration | M7 | Plugin-testkit conformance + nock fixtures; E2E variant with ArgoCD-in-kind; nightly live sandbox |
| Terraform/OpenTofu Integration | M7 | Integration: gate-verdict handshake + plan-report ingestion fixtures (TFC/Atlantis webhook + CLI report); managed-IaC local-state tofu fixture E2E |
| GitHub Integration | M7 | Plugin-testkit conformance; webhook-signature + polling-fallback fixtures; nightly live sandbox |
| Basic Federation | M6 | E2E: two-domain signed round-trip on every merge, incl. air-gap file transport, promotion-as-evidence, approver-attestation validation, audit integrity both sides |

Cross-cutting charter guarantees with standing verification: **API-first** (UI/CLI/IaC structurally limited to the SDK — lint-enforced, contract-tested), **explainability** (every blocked E2E assertion checks `decision_id` resolves), **auditability** (`scp audit verify` in every E2E run), **air-gap compatibility** (M8 zero-egress install drill; no test may touch the internet from M0 on).
