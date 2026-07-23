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
| cosign | **v3.1.2 pinned** (image-vendored); 2.x/3.x accepted from `PATH` | vendored by digest into the runtime image (`tools/cosign/`, `Dockerfile`); still *documented* as an operator prerequisite on `PATH` | Release artifact signing. The pinned binary lands at `/opt/scp/bin/cosign` and is what CI uses too (`scripts/install-pinned-cosign.sh`); an operator-supplied `PATH` cosign is still supported via version-adaptive flag probing. `install.sh` deliberately keeps requiring an **external** cosign. |
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
- **Updated 2026-07-18 ([ADR-0012](adr/0012-registry-consolidation.md), [ADR-0013](adr/0013-supply-chain-scan-sbom-manifest.md); master: `docs/proposals/promotion-and-execution-model.md`):** **Gitea** is added as the **default unified registry** serving **images** (OCI container registry), **code** (git), and **packages** (rpm/npm/Maven/Helm/…) — one service is the image repo, code repo, and package repo; **Harbor (M11.4) is removed from the default stack** (existing Harbor is coordinated via the import path, M15.3 — not bundled); **scanning moves to a coordinated Trivy step** (results→commander as gate evidence, M17), not a registry feature. **Argo Workflows (M11.3)** is the universal **build/test/scan/SBOM** engine for all artifact types and also runs IaC **plan→apply** for cloud infra.
- **Contents:**
  - **M11.1 Bundle framework** — the reusable opt-in Helm profile shape (`bundledExecutor.*`, `enabled: false`, fail-closed empty image refs) + vendored-OCI-in-the-signed-bundle + the post-install auto-wire hook, established by the Argo CD bundle.
  - **M11.2 Argo CD + Valkey** — vendored, UNMODIFIED upstream Argo CD **v3.4.5** (`deploy/helm/vendor/argocd/install.yaml`, sha256-pinned) rendered into its own namespace (`scp-argocd`) with three byte-level substitutions only: argocd image → retargeted image, upstream redis → **Valkey** (owned deviation), ClusterRoleBinding subject namespace → `scp-argocd`. Scoped apiKey account + get/sync-only RBAC + `server.insecure` injected into Argo CD's own ConfigMaps (operator config, not a fork). The **auto-wire hook** (`bundled-argocd-autowire-bin.ts`, a `migrate-bin`-style DB-seed) mints a scoped account token and stores it as SCP secret `bundled-argocd-token`. `allow-argocd` NetworkPolicy; `build-bundle.ts` + `install.sh` carry + retarget the argocd/valkey images.
  - **M11.3 Argo Workflows + Argo Events** — vendored, UNMODIFIED upstream (Workflows **v4.0.7**, split into 4 ordered <5 MB parts to fit Helm's per-file limit, reassembled byte-for-byte; Events **v1.9.10**) rendered into their own namespaces via the shared `commanderscp.renderVendoredBackend` helper (surgical namespace + ClusterRoleBinding-subject re-homing; CRDs passthrough), images retargeted. **Deploy-tier** (no auto-wire) — coordinating Workflows is the generic pipeline executor's job (M10.6); Argo Events can POST to the change-source webhook to feed observe() (M10.2). SCP never runs CI itself.
  - **M11.4 Harbor bundle — REMOVED** ([ADR-0012](adr/0012-registry-consolidation.md)). Gitea (M11.6) is the default bundled registry; **Harbor is not bundled at all** — an org that wants Harbor coordinates its **existing** Harbor via the import path (M15.3). The vendored Harbor bundle is **deleted from the codebase**, not kept as an optional bundle: `deploy/helm-bundled/vendor/harbor/`, `templates/harbor.yaml`, and `templates/harbor-secrets.yaml` are gone; the `bundledExecutor.harbor` values block, the `allow-harbor` NetworkPolicy, the `scp-bundled.sh` harbor case, the nine goharbor image options in `build-bundle.ts`/`install.sh`, and the Harbor cross-reference asserts in helm-verify are all removed. (Historical detail: the bundle vendored the full Harbor registry stack at v2.15.1 into `scp-harbor` with its 7 Secrets SCP-generated per install; that plumbing is written down.) Harbor's SCP integration was never built (no registry executor / token hook — "observe-only" was aspirational), so the removal discards only bundle plumbing. With Gitea as the default registry the source-side scan/SBOM path is the coordinated **Trivy step (M17)**, and a Harbor registry executor lands only for a domain that **imports** its own Harbor (M15.3).
  - **M11.5 Delivery split (out-of-release)** — an E2E kind drill (`scripts/bundled-argocd-drill.sh`) surfaced that Helm stores the WHOLE chart in its release Secret, and the ~12 MB of vendored manifests (Argo Workflows alone is 11 MB) blew the SCP release past Kubernetes' **1 MB Secret limit** — `helm install` failed outright, independent of any profile (ArgoCD/compose deploys were unaffected, hence unnoticed). Fix: the vendored backends moved OUT of the main chart into a **separate `deploy/helm-bundled` chart**, delivered via `helm template … | kubectl apply --server-side` (no stored release ⇒ no 1 MB ceiling; server-side ⇒ large CRDs don't overflow the client-side annotation). The main chart drops to ~40 KB and keeps only the SLIM integration (auto-wire hook + `allow-argocd` NetworkPolicy). Enabling stays a single command — **`scripts/scp-bundled.sh enable <backend>`** renders+applies the backend and flips the SCP release's hook/NetworkPolicy; the air-gap `install.sh` calls it for every backend the bundle carries. helm-verify renders BOTH charts + guards the main chart's packaged size < 1 MB (regression guard).
  - **M11.6 Gitea — default unified registry + git** ([ADR-0012](adr/0012-registry-consolidation.md)) — vendored, sha-pinned Gitea in `scp-gitea` via the shared `commanderscp.renderVendoredBackend` helper; SCP-generated secrets (admin/secret-key), DB per the M15 decision (**shared bundled Postgres if available, else SQLite+PVC — never a dedicated new Postgres**); scoped-token auto-wire hook; `allow-gitea` NetworkPolicy; bundle image carry/retarget; `scp-bundled.sh` verb; helm-verify gates. Serves all three artifact classes — **images** (OCI container registry), **code** (git), and **packages** (rpm/npm/Maven/Helm/Go/…): the image repo, code repo, and package repo in one service. The git-service-agnostic executor + Gitea coordination land in **M15.1**; the same Gitea runs locally on outposts (M15). An org that wants Harbor coordinates its **existing** one via the import path (M15.3) — Harbor is not bundled.
- **Done / verified by:**
  - **helm-verify:** profile-OFF ⇒ **zero** `scp-argocd` resources (the "never load-bearing / two-container floor" guarantee); profile-ON ⇒ `argocd-server` isolated in `scp-argocd`, **every image retargeted** (no `quay.io/argoproj` / `public.ecr.aws` ref survives — the air-gap contract), SCP's strict pod-hardening applied to SCP's OWN resources only (bundled backend is unmodified upstream, isolated), and the auto-wire Job passes SCP hardening.
  - **Air-gap:** the argocd + valkey images ride the signed `scp-bundle` (`build-bundle.ts` image list) and `install.sh` retargets them to the customer registry via values (never hardcoded — avoids the eval-postgres trap); the tamper-rejection suite (`@scp/airgap`) stays green.
  - **E2E (kind/homelab drill):** enabling the profile deploys Argo CD; the auto-wire hook mints a scoped token + stores it; binding an object to the `argocd` executor drives a real Application sync — the token round-trip validated against a LIVE Argo CD (the piece helm-verify can't cover).

### M13 — Air-Gap CDS Validate-and-Promote (staging node + DeliveryTarget + managed scanning)
*(Provisional number — air-gap/CDS track; builds on the M15.5(c) retrans byte relay (PR #112) and the M17.3 E6 export gate. **Status: Proposed — pending owner review (this PR); owner decisions round 2026-07-23 folded in** — charter extension approved (`scp-managed-scan` enumerated; PROJECT_CHARTER.md amended), first-class commander scanning + scanner registry, image-incl-machine-images scope, AWS SDK v3 S3 client, validate-gated confirmation, commander-resident evidence; the proposal's Decisions record has the full list. Design: `docs/proposals/airgap-cds-validate-promote.md`; [ADR-0004](adr/0004-service-naming-commander-outpost-retrans.md), [ADR-0009](adr/0009-optional-poke-mode-federation.md), [ADR-0013](adr/0013-supply-chain-scan-sbom-manifest.md), [ADR-0017](adr/0017-ownership-refinement.md), [ADR-0019](adr/0019-artifact-byte-channel.md).)*
- **Goal:** complete the air-gap promotion story at both ends of the E6 gate. E6 (M17.3) hard-refuses any cross-boundary export lacking passing digest-bound scan evidence — universal and fail-closed by design — so an org **without** a pipeline scanner cannot promote into or out of an air-gapped domain at all; and even for orgs that can, the CDS crossing is a six-step manual operator walk (the M15.5(c) runbook). M13 fixes both **without weakening any gate**: **first-class commander scanning** (owner decision 2026-07-23) makes E6's evidence exist by construction — the commander's promotion process runs **scan → evaluate (M17.5) → sign (E6) → export**, with org-pipeline evidence remaining a supported alternate ingress; the staging node + DeliveryTarget automate the boundary walk. The receiver's M17.4(a)+(b) verifies run unweakened; metadata bundles stay byte-free (ADR-0009); the retrans never terminates a promotion (ADR-0004); downstream never re-scans.
- **Contents:**
  - **M13.1 The staging node (retrans formalized)** — a `role: retrans` instance runs an unattended loop: inbox arrival → auto-import via the **existing** caller-independent verify paths (verification semantics unchanged; the retrans tarball hop extracts importRelayTarball's checks to run push-less — a refactor, not a new trust decision) → auto-relay build (the PR #112 409 role gate stays) → outbound drop via DeliveryTarget. Trigger: a pg-boss tick loop cloned from `startObserveLoop` (default), the ADR-0009 poke chain as the low-latency option where enabled. Inbox contents are untrusted (traversal guard + refuse-with-Decision survive automation); every automated action writes the same Decisions/audit as the manual CLI; `bundle_transfers` rows are the status surface. Deployment profile (owner decision 2026-07-23): the retrans is a purpose-built relay, not an outpost-minus — the same server binary in a slim `role: retrans` profile whose whole job is verify the cosign signature (the transitive proof of scan-pass at the commander — M13.3) → move the bytes (skopeo) → drop into the CDS (DeliveryTarget) → record the pass-through in the same Postgres; no local Gitea/registry, no executor coordination, no deploy machinery, no UI. Transfer confirmation is **validate-gated, never blind** (owner decision 2026-07-23): the retrans validates FIRST — success confirms the `bundle_transfers` row upward and makes the onward drop; failure refuses with a block Decision + audit and sends **no confirmation**.
  - **M13.2 DeliveryTarget** — per-peer delivery config filling exactly the ADR-0019 "signed tarball out / signed tarball in" deferral: a `deliveryTarget` jsonb beside `syncScope` on `federation_peers` (zod-validated view, M15.6 shape), instance-level env fallback = today's `SCP_RELAY_OUT_DIR`/`IN_DIR`. Providers: `filesystem` (default, today's behavior) | `s3-compatible` (operator config only, never bundle-steered; fail-closed where required and unset). Credentials: `delivery/<peer>/<target>` vault keys under the ADR-0019 §3 artifact-store class. S3 client: **`@aws-sdk/client-s3` (AWS SDK v3; owner decision 2026-07-23)** — managed multipart upload for multi-GB tarballs, first-party SigV4, retries; vendored at build (the air-gap principle constrains runtime network, not dependency size); `endpoint` + `forcePathStyle` for S3-compatibles (MinIO). S3 stays optional (Postgres remains the only required stateful dep). Everything past the drop is the org's CDS — out of scope (charter p1). *(Honest scope: the Helm `objectStorage.s3` values block is inert vocabulary today; the runtime provider layer is net-new code.)*
  - **M13.3 Managed scanning (`scp-managed-scan`) — a first-class service of the commander's promotion process** (owner decision 2026-07-23; charter extension **approved** — PROJECT_CHARTER.md amended, a second non-host-reaching enumerated managed class): the commander executes scans + signing as part of promotion — **scan → evaluate (M17.5) → sign (E6, only if scans pass) → export** — in the `scp-managed-iac` runner pattern: a thin orchestrator plugin behind the standard executor interface + a separate `scp-runner-scan` image carrying digest-pinned Trivy **and** OpenSCAP (tools exist **only** in the runner image; `tools/*/pin.env` discipline; ephemeral single-shot containers; `--network none` except an operator-allowlisted registry pull for the subject artifact's bytes). **Scanner registry** (graph-native, registry rows not new tables): scanning methods are assigned to artifact types (trivy → container/machine images, filesystems, packages; openscap → OS images vs compliance profiles); the scan step selects scanners per artifact type. **Scope (owner decision 2026-07-23): image-only for M13, where image INCLUDES machine images** (AMIs/VM disk images via Trivy's experimental `trivy vm` — local streamOptimized VMDK in air-gap, `ami:`/`ebs:` via the EBS direct APIs when connected); no live-host scanning (scp-runner-ops-adjacent, out). **Evidence is commander-resident, ONLY** (owner decision 2026-07-23): the commander's Postgres-backed evidence store holds managed-scan output; outposts/retrans never store or read scan evidence — they validate the commander's signature, the transitive proof of scan-pass; no Gitea prerequisite anywhere for evidence. Org-pipeline evidence remains a supported alternate ingress (the existing `scan-result-control`/report shapes; `ScanEvidenceSchema`'s `scanner` literal grows) — **zero gate-code changes**; M17.5 and E6 untouched. **Scan-once = once-at-the-commander-before-signing** (supersedes scan-at-source for the signing flow; the commander pulls bytes by digest over allowlisted channels — ADR-0019 §4); the staging node never scans; downstream never re-scans (unchanged). Default-permissive = adoption semantics only (no boundary crossing → no scan scheduled; bound policies stay fail-closed). Offline scanner data (trivy-db + SCAP content) crosses boundaries as `type: "blob"` artifacts on the existing byte channel — E6-exempt for the same reason the SBOM is (scan-adjacent data, not a scanned deployable subject — the SBOM is the scan's output, the DB its input), so this too is **zero gate changes**; connected instances may still refresh the upstream OCI-form DB directly via the allowlisted skopeo path. ADR-0010/0013/0017 scan-location evolutions are marked in the proposal; a follow-up ADR lands at M13 approval.
- **Done / verified by (sketch — per-increment DoDs in the proposal's Phasing table; nothing here is complete):**
  - **13.1a** inbox ingest loop + auto-import: unattended imports produce identical verify outcomes/Decisions to CLI-invoked ones; tampered/traversal inputs refused; **validate-gated confirm** — a passing validation confirms the transfer upward, a refusal never does (block Decision, no confirmation); idempotent re-processing. **13.1b** auto-relay + poke trigger: promotion import on retrans yields a signed relay tarball with no operator command; dropped poke self-heals.
  - **13.2a** per-peer DeliveryTarget view + filesystem provider (env fallback byte-for-byte; fail-closed missing-target `problem`; SDK parity). **13.2b** S3 provider (`@aws-sdk/client-s3`) round-trip via Testcontainers MinIO incl. multipart; vaulted scoped credentials; operator-only endpoints.
  - **13.3a** the promotion scan step + scanner registry: an ephemeral runner at the commander scans a subject artifact (container image + a `trivy vm` machine-image case) pulled by digest over the allowlisted channel → evidence parses via `ScanEvidenceSchema`, lands **commander-resident** → unmodified M17.5/E6 machinery consumes it (a pipeline-less promotion scans → evaluates → signs → exports, zero gate-code changes); valid org-pipeline evidence short-circuits the managed run (both ingresses proven); scanner selection follows registry rows by artifact type (unassigned type + no evidence still refuses at E6); scanners exist only in the runner image. **13.3b** scanner DB (+ SCAP content) rides the relay/bundle path as a `blob`, digest-verified at the receiver; E6 never evaluates it as a substantive artifact (vacuous exemption, not evidence — documented); runner proven offline; refresh runbook merged.

### M14 — Optional Poke-Mode Federation (per-outpost)
*(Provisional number — post-M11 federation track; sequences after the air-gap CDS work. Design: [ADR-0009](adr/0009-optional-poke-mode-federation.md), `docs/proposals/outpost-poke.md`.)*
- **Goal:** let a **reachable** outpost (or retrans) stop constantly polling. The commander sends a **contentless** "poke" ("something is pending, come pull") and the outpost pulls over its existing outbound path — no data ever flows downward. **Off by default, configured per outpost.** Builds on M6 federation; the data-direction invariant is unchanged (DESIGN §13 / ADR-0009 restatement: *no data commander→outpost; a contentless wake signal is permitted only where poke-mode is enabled and topology/accreditation allow it*). Regulated partitions (commercial cannot dial into GovCloud), CDS, and air-gap outposts stay pure-pull/bundle.
- **Contents:**
  - **M14.1 Per-outpost mode** — a `federation.pokeMode` flag (default off) on the outpost enrollment/peer binding, carried through API→SDK→CLI→UI parity.
  - **M14.2 Poke endpoint** — a contentless, enrolled-commander-mTLS-authenticated (ADR-0001), rate-limited endpoint on the outpost/retrans that wakes an immediate pull; no request body is trusted; idempotent.
  - **M14.3 Commander poke sender** — on a new pending-transfer for a poke-mode outpost (outbox-derived, DESIGN §5), poke that outpost.
  - **M14.4 Scheduler mode + backstop** — in poke-mode, disable the frequent interval poll but retain a **sparse safety-net reconcile + pull-on-(re)connect/startup** so a dropped poke self-heals within a bounded window. (Reliability model — sparse backstop vs. reliable delivery — is the open decision in the proposal.)
- **Done / verified by:**
  - **Integration (real Postgres):** a poke triggers an immediate pull; poke-mode disables the frequent poll; a **non-commander caller is rejected**; a replayed/contentless poke is idempotent; **a dropped poke self-heals via the safety-net backstop**; poll-mode outposts and the air-gap/bundle path are unchanged.
  - **Parity:** `federation.pokeMode` is set/read only through the generated SDK (no bypass); oasdiff-additive within `/v1`.

### M15 — Per-Outpost Local Artifact & Source Infrastructure (Gitea; no local Harbor)
*(Provisional number — post-M11 federation track, sibling to M14 poke-mode. Design: [ADR-0010](adr/0010-outpost-local-artifact-infra.md), `docs/proposals/outpost-local-artifact-infra.md`.)*
- **Goal:** let a FedRAMP-High / IL5 / air-gap **outpost** be self-contained for artifacts + source with its OWN local **Gitea** — serving **images** (OCI container registry), **code** (git), and **packages** (rpm/npm/…) in one service; **no local Harbor**, per [ADR-0012](adr/0012-registry-consolidation.md) — **create or import**, off by default. Fills a real gap: federation bundles are metadata-only (no artifact bytes), the git executor is GitHub-only, and outpost-scoped bundling exists but is ungoverned. Boundary model = **trust scan-at-source** (scanning is a boundary-authorization gate, [ADR-0013](adr/0013-supply-chain-scan-sbom-manifest.md); the outpost verifies the signed attestation/manifest, **never re-scans**, so it needs no scanning registry and stays light). *(Scan location evolved by owner decision 2026-07-23, M13.3: the promotion scan executes at the commander before signing — the receiver-side half this milestone builds on, verify-the-signature-never-re-scan, is unchanged.)* **Ownership ([ADR-0017](adr/0017-ownership-refinement.md), refined 2026-07-20):** **build execution devolves to the *originating* outpost** (the commander never runs build); the commander owns **only** the cross-boundary gate (consume the scan verdict M17.1 + cosign-sign **only** its own promotion manifest M17.3 E4–E6; widened 2026-07-23 to include the promotion scan step, M13.3). *Repo/byte hosting* is a separate, unchanged axis — the **shared** config/infra and commercial-tier git/image repos may stay commander-hosted, while **domain-specific** config/infra repos are outpost-owned (outpost-autonomous — commander doesn't track/scan/sign it). Also delivers the **outpost's own local UI** (its domain's service/component/graph views; distinct from M16). Invariants hold unamended: coordinate-not-execute (SCP holds scoped tokens; backends keep their own creds), graph-native (`execution-system` objects), air-gap first-class.
- **Contents (phased):**
  - **M15.0 Harbor bundle removed (registry swap)** ([ADR-0012](adr/0012-registry-consolidation.md)) — the vendored M11.4 Harbor bundle is **deleted** and Gitea takes its place as the default registry; outposts run **Gitea only**, no local Harbor. Harbor is served exclusively via the import path (M15.3), never bundled — removed, not kept as an optional bundle.
  - **M15.1 Gitea bundle + git-service-agnostic git executor** — vendored sha-pinned Gitea (DB: shared bundled Postgres if available, else SQLite+PVC — never a dedicated new Postgres) + SCP-generated secrets + scoped-token auto-wire hook + `allow-gitea` NetworkPolicy + bundle image carry/retarget + `scp-bundled.sh` verb + helm-verify gates; a **git-service-agnostic** git executor (trigger/observe/status/abort) with pluggable auth/webhook-signature/CI adapters (GitHub/GitLab/Gitea/generic) + webhook→`change-source` + `source_mapping` wiring (net-new — the git executor is GitHub-only today).
  - **M15.2 Signed-attestation verification at the outpost (DONE)** — the outpost verifies the commander's cosign-signed promotion manifest for a promoted artifact before deploy (trust the signature as the transitive proof of scan-pass — "scan-at-source" as shipped, scan-at-the-commander since the 2026-07-23 decision, M13.3; either way the outpost never re-scans). This is **ONE implementation, not two**: M15.2 IS **M17.4(a)** (`promotion-repo.ts::importPromotionBundle`) running at the receiving outpost — the universal pre-deploy validation of [ADR-0011](adr/0011-universal-outpost-validation.md); its byte-level complement is **M17.4(b)** (`coordination/pre-deploy-gate.ts`), which cosign-verifies each authorized artifact's operator-loaded BYTES at the outpost's reachable registry before the deploy executor is triggered. The outpost's Gitea registry needs no scan integration (it never re-scans); an org that runs its own Harbor binds it via the import path (M15.3), which brings its own registry executor + token hook.
  - **M15.3 Import path** — bind an existing Harbor/Artifactory/GitLab/Gitea as `execution-system` graph objects via discovery (`/discovery/run`→`/accept`); generalize git+registry executors beyond the bundled pair.
    - **M15.3c Harbor as a webhook change-SOURCE (DONE)** — import an existing **Harbor** registry as a **change-source**, NOT an executor. A container registry is a **passive artifact store SCP observes**, so — unlike M15.3's execution-system import (which brings a trigger/observe/status executor) — Harbor is modeled as a webhook source exactly like a git webhook: Harbor **PUSHES** `PUSH_ARTIFACT` events to `POST /api/v1/change-sources/harbor/webhook`, and SCP correlates them to a component on **repo** via the existing `source_mappings`. **Not** an `executor_binding`, **not** an `execution-system`, **not** an `ExecutorType` — `harbor` is just a new **open `sourceKind` string** (no schema/enum/allowlist change: `source_kind` is free text and `ChangeSourceEventParamSchema` is an open `z.string().min(1)`). The single mandatory code seam is the per-`sourceKind` webhook `ADAPTERS` map (`apps/server/src/coordination/webhook-adapters.ts`) plus the `extractHint` body-derived-event-name fix below; correlation, routing, and Change proposal are the same machinery every webhook source flows through. The mapper lives in a minimal webhook-only package `@scp/plugin-harbor` (no `ExecutorPlugin`, no manifest). A pushed **image digest** is threaded through to the proposed change's `sourceRef.artifact_digest` (the connective tissue the M17.1 scan gate binds to, [ADR-0013](adr/0013-supply-chain-scan-sbom-manifest.md)). **Two Harbor specifics:** (1) **auth** — Harbor's webhook policy exposes a single **Auth Header** field; the operator sets it to `Bearer <a scoped SCP PAT>` so the route's existing `requireAuth` authenticates the push. Harbor cannot send a separate signature header, so **do NOT configure a change-source webhook secret for `harbor`** (an HMAC verifier is moot); the harbor adapter is `mapEvent`-only, no `verify`. (2) **event name in the body** — Harbor carries its event type in `payload.type`, not an HTTP header, so `extractHint` derives the event name from the body for any adapter that declares no `eventHeaderName` (the header-driven path for github/gitea/gitlab is unchanged). `SCANNING_COMPLETED` (which carries `event_data.scan_overview`) is **recognized but ignored** for this slice — feeding it to the scan gate is a **NOTED M17.1 follow-on**. **CONNECTED registries only:** Harbor pushes to SCP. The **air-gap PULL** direction — SCP **polling** a registry that cannot reach out — is a **DEFERRED, non-binding poll-driver follow-on**, out of scope here.
      - *Operator setup:* in the Harbor project's **Webhooks** config, add an endpoint `https://<scp-host>/api/v1/change-sources/harbor/webhook`, set **Auth Header** = `Bearer <scoped SCP PAT>`, and select the `PUSH_ARTIFACT` event. On the SCP side, create a `source_mapping` for `sourceKind=harbor` whose `repoPattern` glob matches Harbor's `project/repo` (e.g. `acme/*` or `acme/widgets`) → the component. No webhook secret is configured for `harbor`.
  - **M15.4 Role-scoped governance (CHART-RENDER-TIME LINT — done)** — a `federationRole` (commander|outpost|retrans) value on the **bundled** chart (`deploy/helm-bundled`) plus a **`helm template`-time self-consistency guardrail** in `tools/helm-verify` that fails the render-check when a role enables a bundled backend it should not run. **Honest scope:** this is a **misconfiguration guardrail** — the operator sets **BOTH** the role AND the `bundledExecutor.*.enabled` flags at install time, and the lint pairs those two install-time values — **NOT** SCP runtime authority. Runtime enforcement was **deliberately NOT taken** (owner decision): it would be a **fork**, because the runtime `self_domain.role` (`apps/server/src/federation/self-repo.ts`) is **advisory** metadata set post-install via the federation API, has no bearing on a Helm install-time value, and there is **no graph representation of bundled-backend enablement** to police. The role is stamped as a label on each bundled-backend Namespace (`commanderscp.io/federation-role`, via `commanderscp.federationRole` in `templates/_helpers.tpl`, which also fails render on an invalid role); the guardrail reads it straight from the render and checks the enabled backends against the **allowed-per-role matrix** (single source of truth in `tools/helm-verify/src/verify.ts`). **Matrix** (doc source: [ADR-0012](adr/0012-registry-consolidation.md) + the poke/retrans federation model; conservative where docs are silent): **commander** = all bundled backends (`argocd`, `argoWorkflows`, `argoEvents`, `gitea`); **outpost** = `argocd` + `gitea` only (a self-contained deploy target; the *bundled* build/event backends default to the commander role); **retrans** = **none** (a validate-and-relay CDS-boundary node is not an execution site — it bundles nothing). A **future** policy-graph object could make this runtime-governed, but that is out of M15.4 scope. **Reconciliation with [ADR-0017](adr/0017-ownership-refinement.md) (build devolves to the originating outpost):** an outpost **does** build its own originating artifacts, but today via its **own coordinated/BYO** Argo Workflows (Mode A) — which needs no change to this *bundled*-backend lint. Letting a **bundled** Argo Workflows run on the outpost role is a noted ADR-0017 follow-on to this matrix, not a prerequisite; the matrix value is unchanged here.
  - **M15.5 The artifact byte channel** ([ADR-0019](adr/0019-artifact-byte-channel.md); reframed from "optional/later … if operator-loaded bytes prove insufficient" by the owner's finish-all-of-M15 mandate, 2026-07-20) — per-tier artifact-bytes transport, three parts:
    - **M15.5(a) Commercial pull — documented, no transport code.** The connected outpost's deploy tool **pulls by digest** from the commander-hosted registry (Gitea, [ADR-0012](adr/0012-registry-consolidation.md); the commander never pushes) and M17.4(b) verifies pre-deploy. SCP's role is **hosting + verify only** — ADR-0019 §1 records this so no commander push path is ever built. Done by documentation.
    - **M15.5(b) Operator-loaded MVP — DONE.** Bytes arrive by operator-loaded media into the outpost's local Gitea (the existing air-gap bundle path); the M17.4(b) pre-deploy gate (#108) verifies them digest-bound, fail-closed. Remains the sneakernet fallback forever.
    - **M15.5(c) Retrans byte-relay — the build.** The [ADR-0004](adr/0004-service-naming-commander-outpost-retrans.md) validate-then-relay made real (ADR-0019 §2): resolve the promotion manifest's authorized digests → skopeo-pull bytes from the source registry → **VALIDATE** with the M17.4 digest-bound machinery (`verifyAuthorizedArtifactSet` — a failing/tampered/unauthorized artifact **never crosses**) → package a signed OCI-layout tarball (build-bundle machinery) → relay across the CDS as a file (`.scpbundle` pattern) → push into the destination local Gitea **by digest + re-inspect** (install.sh pattern) → the receiving outpost **still** runs M17.4(a)+(b) (defense in depth — zero trust in the relay). Credentials are the ADR-0019 §3 **artifact-store class**: vaulted (`secrets` table), scoped per-peer/per-registry, source-READ + destination-PUSH only — registry creds, not exec-infra creds. **DoD:** a **two-registry Testcontainers round-trip** — pull from the source registry, validate, tarball, push to the destination registry, and the receiving M17.4 verify passes; a **tampered/unauthorized artifact never crosses** (block Decision + audit event at the retrans); the credential class is vaulted + scoped (no admin/delete grants); and the `SCP_ARTIFACT_OCI_REGISTRY_HOSTS` allowlist (ADR-0019 §4 — closing the #108 residual; unset = fail-closed) is enforced on the OCI verify/pull path (**DONE — verify path** (foundation 2): the location's registry `host[:port]` must match an allowlist entry exactly BEFORE cosign is invoked — a disallowed host fails the artifact without a dial, unset refuses every OCI verify, symmetric with `SCP_ARTIFACT_BLOB_BASE_URLS`; `federation/artifact-verify.ts` + pre-deploy-gate suite axes (i)/(j); the relay's skopeo-pull side lands with the relay); and a **pinned skopeo is vendored into the runtime image + air-gap bundle** (the M17.3 cosign-vendoring pattern — today skopeo is an operator-`PATH` prerequisite, so the relay's server-side pull/push steps require this net-new vendoring).
  - **M15.6 Multi-region Argo CD *setting* (small) — DONE** ([ADR-0017](adr/0017-ownership-refinement.md) §3) — a first-class config **surface** for one outpost owning **multiple regional Argo CDs** for a **single** prod env (e.g. Prod AMER + Prod APAC). **The capability already exists:** a region is a **deploy-target**, and each per-region Argo CD is an ordinary **per-region deploy-target binding** (1:1, resolved per target via `getExecutorBinding`) — multiple imported/coordinated Argo CDs already work. This milestone adds only the **setting/config surface** (declare "this prod env has an Argo CD per region" and bind each region) + a test; **no new object type** (graph-native — bindings, not a `region` table). *(Only running several **bundled** Argo CDs additionally needs per-instance namespacing, M15.4 — out of scope here.)*
    - **What shipped (additive, imported/coordinated per-region — bundled-N stays out of scope per [ADR-0017](adr/0017-ownership-refinement.md) §3):**
      - **The model (no new object type):** a region is a `deployment-target` carrying `properties.environment` (the prod env's name, the grouping key) + `properties.region` (e.g. `amer`); its per-region Argo CD is an ordinary per-region executor binding of Type `configuration` (Argo CD is GitOps sync), ideally an **imported/coordinated** `argocd` `execution-system` bound one-per-region. Declaring a region is exactly the existing `PUT /api/v1/executors/{idOrUrn}/binding` — **unchanged**; the setting is purely additive.
      - **The config surface (read + validate):** `GET /api/v1/environments/{environment}/regional-executors` (SDK `executors.getRegionalExecutors(env, type?)`) returns the coherent `prod env -> {region -> argocd binding}` view and a **validation verdict**: `valid` is false with per-gap `problems` when a region has **no** `configuration` binding, is bound to a **non-`argocd`** module, is **missing** its `region` label, **collides** on a region, or the env declares **no** region targets — so a multi-region prod env is never silently deployed against a region with no Argo CD of its own. `apps/server/src/coordination/regional-executors.ts`, route in `apps/server/src/routes/executors.ts`, schemas `RegionalExecutorView`/`RegionalExecutorEntry` in `packages/schemas/src/executors.ts`.
      - **Stage→region expansion — scoped OUT (flagged):** M15.6 does **not** add auto-expansion of a "prod stage" target into its region targets. The operator **names the region deploy-targets explicitly** on the change; the plan compiler already snapshots the change Type onto every wave target and reconcile drives **each** wave target's own binding, so a change naming AMER + APAC region targets **already** fans out to two regional Argo CDs (proven below). Auto-expansion (target a single stage/env object → server expands to its contained region targets) is a **larger, separate concern** — it needs a stage/env→region containment relationship that does **not** exist today (`contains` is service→component only; there is no stage/environment object type) — and is left as a **noted follow-on**, not half-built here.
- **Done / verified by:**
  - **helm-verify:** Gitea profile-OFF ⇒ zero `scp-gitea` resources; profile-ON ⇒ isolated in `scp-gitea`, every image retargeted (air-gap contract), SCP-generated secrets present, `allow-gitea` egress only. **M15.4 federation-role guardrail (render-time lint):** a positive combo (`federationRole=outpost` + gitea/argocd) renders clean, and a **disallowed** combo (`federationRole=retrans` + gitea enabled) is caught by the guardrail and, wired to the exit path, fails the render-check **non-zero** with a message naming the role + the offending backend — proven by a real negative-case assertion in `tools/helm-verify/src/verify.ts` (not a comment).
  - **Integration (real Postgres):** the `gitea` executor triggers/observes/statuses a real (nocked/containerized) Gitea; a promoted image digest is verified against a signed source attestation before it is coordinated; import via discovery binds an existing registry/git execution-system.
  - **Air-gap:** the Gitea images ride the signed bundle and retarget to the customer registry (no Harbor images — Harbor is import-only, not bundled); tamper-rejection suite green.
  - **Multi-region Argo CD (M15.6) — DONE:** `apps/server/src/coordination/multiregion-argocd.integration.test.ts` (real Postgres, SDK-only). The config surface proves a prod env with an Argo CD bound per region validates OK and names the **distinct** systems, and that an unbound / non-argocd / empty region fails validation with a helpful `problem` (never a silent deploy). Per-region **fan-out** is proven **end to end**: a change to a prod env with AMER + APAC region targets — each bound to a **distinct** `execution-system` — is driven through the real reconcile loop, and each region's wave target is asserted to have triggered against its **own** regional instance (`execution-system:{amerSys}` vs `execution-system:{apacSys}`, distinct) — AMER→AMER Argo CD, APAC→APAC Argo CD, not a unit tautology. The round-trip goes only through the generated SDK (no bypass).


### M16 — Federation / Outposts UI + Universal Boundary Pipeline Stages
*(Provisional number — federation UI track. Design: [ADR-0011](adr/0011-universal-outpost-validation.md), `docs/proposals/federation-outposts-ui.md`.)*
- **Goal:** a place in the UI to see + manage the outposts the commander syncs with, and to make the trust boundary legible in the pipeline. Two parts.
- **Contents:**
  - **M16.1 Universal boundary stages** (can land sooner; observe-enrichment on the federation boundary) — an ALWAYS-SHOWN `transferred → validated` segment in the component pipeline: transfer status from bundle transfer tracking (export→submitted→confirmed, DESIGN §13), signature + scan-attestation validation at the receiving outpost ([ADR-0011](adr/0011-universal-outpost-validation.md) — a universal pre-deploy gate, commercial included). Renders real observations + an explicit "not-yet-verified" state; NO fabrication; drives nothing (coordinate-not-execute).
  - **M16.2 Outposts UI, all-at-once** (owner: build overview + settings + config together; lands after M14 poke + M15 local-infra) — Overview (role, trust tier, connectivity, last-sync / "as of ⟨bundle⟩", sync health, pending transfers, health rollup) + per-outpost Settings (identity / mTLS / transport) + per-outpost Configuration (poke-mode M14, local Gitea registry M15, freezes, bundled backends). Commander-origin, syncs down, air-gap pending-vs-applied.
  - **M16.3 Outpost's own local UI** — the same one-binary UI served by an outpost, scoped to its local domain: service/component/graph views for the domain-specific pipelines the commander doesn't track ([ADR-0010](adr/0010-outpost-local-artifact-infra.md)). Distinct from M16.2 (commander→outposts); largely free once the views exist.
- **Done / verified by:**
  - **Boundary stages:** integration proves the pipeline surfaces a REAL transfer + a real/absent validation outcome per change; never a fabricated pass.
  - **Outposts UI:** the outpost list + per-outpost config round-trip only through the generated SDK (no bypass); editing an outpost's config writes commander-origin data the federation journal/bundle carries down; air-gap outposts show "as of ⟨bundle⟩" + pending-vs-applied.

### M17 — Supply-Chain Gate (scan + SBOM + cosign signing + cross-hop verify + scoped scan policies)
*(Design: [ADR-0013](adr/0013-supply-chain-scan-sbom-manifest.md), [ADR-0012](adr/0012-registry-consolidation.md), [ADR-0015](adr/0015-cosign-cross-boundary-signing.md) (cosign end-to-end), [ADR-0016](adr/0016-scoped-scan-requirement-policies.md) (scoped scan policies); master: `docs/proposals/promotion-and-execution-model.md`.)*
- **Goal:** make cross-boundary promotion verifiable. Scanning is a **boundary-crossing authorization gate** (not a general quality gate) — a coordinated **Trivy step** (in Argo Workflows) scans any artifact type and emits the **SBOM** in the same pass *(as shipped; since the 2026-07-23 owner decision the commander's M13.3 promotion scan step is the first-class evidence producer and the coordinated org-pipeline step is the supported alternate ingress — gate semantics here are unchanged either way)*; the executor **cosign-signs** the artifact(s) **and the build-time SBOM** **at build**, and the commander **cosign-signs** **only** a **promotion manifest** enumerating exactly the authorized artifact set. The receiver **cosign-verifies** signatures + manifest match at **every hop** ("nothing slipped in"). Signing is **cosign end-to-end over all cross-boundary artifact types + the manifest** ([ADR-0015](adr/0015-cosign-cross-boundary-signing.md)) — a **new** supply-chain layer; Ed25519 stays for federation transport, unchanged. cosign is **already used on the release path (operator-supplied on `PATH`, unpinned by design — `deploy/airgap/src/cosign.ts`), *not vendored***; its keyful/offline flag behaviour is proven, and M17.3 must vendor a **pinned** binary into the runtime image + air-gap bundle (ADR-0015 Consequences). It is **not** a pre-existing M4/M6/M8 capability (that was Ed25519). Applies to **commander-tracked** artifacts only; domain-local outpost-originated artifacts are exempt (they don't cross a boundary — keeps outposts light). SCP is the promotion authority (no registry pull-blocking needed). **[ADR-0017](adr/0017-ownership-refinement.md) (build devolves to the originating outpost) is docs-only and does NOT block M17.4 / M15.2 / M15.5:** cross-hop verify-at-outpost is **actor-agnostic** — it verifies the commander-signed manifest + arrived-set equality regardless of *which* domain ran the build — so devolving build changes nothing about the verify hops.
- **Contents:**
  - **M17.1 Scan-result ingestion** — SCP consumes the coordinated Trivy step's verdict as gate evidence (a Control/gate on the change); no scan pipeline exists today (Harbor observe was aspirational). **Shipped (#92, on `main`):** `gate-orchestrator.ts` `buildControlContext` conditionally threads `context.artifactDigest` and `scan-result-control` reads it — that conditional-context threading is the **existing** pattern M17.5 reuses, not future work.
  - **M17.2 SBOM generation** — build-time SBOM (same Trivy pass), stored + referenced on the promotion.
  - **M17.3 cosign sign — all cross-boundary artifact types + SBOM + manifest** ([ADR-0015](adr/0015-cosign-cross-boundary-signing.md)) — **vendor a pinned, checksum-verified cosign binary** into the SCP runtime image **and** the air-gap bundle (net-new: cosign is an operator prerequisite on `PATH` today, unpinned in CI), reconciling the pin with `deploy/airgap/src/cosign.ts`'s version-adaptive flag probing; build the **shared cosign signing/verify module** (lift + generalize the `deploy/airgap` keyful/offline wrapper — `--tlog-upload=false`, no Fulcio/Rekor — plus key mgmt + pubkey distribution over federation config); then sign the promotion manifest and carry origin signatures for **every** cross-boundary artifact class (OCI images, rpm/deb/npm, config bundles, infra plans, SBOM). Evolves the flat `artifactDigests: string[]` to a typed `artifacts: [{type:'oci'|'blob', digest, signatureRef}]` set (`packages/schemas/src/federation.ts`). The **executor** signs the artifact(s) **and the build-time SBOM** at build (origin sig in `signatureRef`); the **commander** signs **only its own manifest** — it never `cosign sign`s an origin artifact, SBOM included (coordinate-not-execute, ADR-0015 §5). Signing happens **only if scans pass**.
  - **M17.4 Cross-hop cosign verify — two distinct steps (DONE: (a) + (b))** ([ADR-0015 §6](adr/0015-cosign-cross-boundary-signing.md)), because federation bundles are **metadata-only** (ADR-0009) so artifact bytes are absent at import:
    - **(a) Manifest + set-equality verify at bundle import (DONE)** — an **additive gate**, sibling of the M17.1 scan gate, in **`promotion-repo.ts::importPromotionBundle`** (NOT `import-repo.ts`, which verifies **sync** bundles; the `/imports` route dispatches promotion bundles to `importPromotionBundle`) **after** the existing Ed25519 bundle gate: `cosign verify-blob` the **promotion manifest** against the exporter peer's distributed pubkey (`currentPeerCosignPublicKey`, E5) **and** assert the arrived typed artifact **set** (`{type,digest,signatureRef}`) **exactly equals** the manifest's authorized set; plus **the tie** (the Ed25519-checksummed `artifactDigests` must equal the cosign-signed manifest's digest set, binding the two anchors so neither is tamperable independently), **4 self-binding asserts** (source-change/exporter/peer/urn), and a **downgrade defense** (a manifest-less bundle from a peer that HAS a registered cosign key is rejected; from one that has none it is genuine pre-E5 back-compat). Fail-closed → a `block` Decision (`promotion-import-manifest-verify`) + a `federation.promotion.import.blocked` hash-chained audit event, surfacing a `decision_id`. Metadata-only, no re-scan (coordinate-not-execute). The `verify-blob` **subprocess runs OUTSIDE the apply tx** — `importPromotionBundle` was restructured to take `Db` + phase-split (like `exportPromotionBundle`), honoring the "never hold a pooled connection across a cosign subprocess" invariant.
    - **(b) Per-artifact `cosign verify` where the bytes land (DONE)** — the operator-loaded **pre-deploy byte VERIFY**: for each artifact in the change's (a)-verified authorized set, `oci` → `cosign verify` the image's **registry-attached** signature by digest-pinned ref; `blob` (rpm/deb/npm/config/infra/SBOM) → `cosign verify-blob` against its **origin** `signatureRef` — both against the **exporter's** distributed cosign pubkey (E5, `currentPeerCosignPublicKey`), keyful/offline. It deliberately **cannot** run at import (a federation bundle carries no bytes, ADR-0009 — the operator side-loads them AFTER the metadata import), so it runs as a **PRE-DEPLOY GATE** on reconcile's `coordinated -> executing` edge (`coordination/pre-deploy-gate.ts` + `federation/artifact-verify.ts`), the last point before `reconcileExecutingChange` triggers the deploy executor (the `waiting -> executing` edge carries the same gate as defense-in-depth). **Fail-closed:** MISSING bytes (absent from the reachable registry) OR a failing/tampered/wrong-key signature ⇒ a `block` Decision (`pre-deploy-artifact-verify`) + a `change.pre_deploy.artifact_verify.blocked` hash-chained audit event, the change is PARKED (`reconcile_blocked_at`), and the deploy is **never triggered**; a manifest-carrying change whose peer key has vanished is likewise blocked. **Scope:** ONLY changes carrying a verified cross-boundary promotion manifest are gated — a domain-local change with no manifest (ADR-0013 exemption) and a pre-manifest imported change deploy ungated, exactly as before. **Coordinate-not-execute:** the gate only READS the registry to verify — byte TRANSPORT remains M15.5 ([ADR-0019](adr/0019-artifact-byte-channel.md)), and it never re-scans. Together (a)+(b) complete M17.4.

    Lands the **outpost-side** verify (ties [ADR-0011](adr/0011-universal-outpost-validation.md), M15.2 — the outpost's pre-deploy validation IS this same import gate, one implementation) and, where retrans exists, the CDS-boundary verify (retrans was naming-only when this was written; retrans-as-a-real-component is now scheduled — the M15.5(c) byte-relay, [ADR-0019](adr/0019-artifact-byte-channel.md), whose VALIDATE step reuses exactly this machinery).
  - **M17.5 Scoped scan-requirement policies** ([ADR-0016](adr/0016-scoped-scan-requirement-policies.md)) — scan pass-criteria over six tiers, **platform → trust domain (partition) → org → containment domain → service → component**, **most-restrictive-wins** (a child may only TIGHTEN; effective threshold = per-severity MIN of `maxCritical/maxHigh/maxMedium/maxLow`; the MIN is **order-independent**, which is why the documented containment-domain-vs-service ordering tie at `containment.ts:60-73` is harmless). *Note the two senses of "domain": the **trust domain (partition)** is the ambient federation boundary above org; the **containment domain** is the intra-org `domain` object type below org — different things (`schema.ts:944-947`).* Org / containment-domain / service / component tiers are **graph-native** policy data on the existing stricter-wins resolver (`matchPoliciesForTargets`/`resolvePolicies`/`containmentChain`), unchanged. The two **above-org** tiers share **one** new primitive — a single **instance-scoped floor table** (no `orgId`) with `tier` (`platform|trust_domain` — the literal is spelled `trust_domain`, never bare `domain`, to keep it distinct from the `domain` object type) + `origin` (`local|federated`) discriminators, **tenant-read / operator-write**, following the nullable-orgId global-row *pattern* (`0002:44-70`) as its own table; ADR-0016 §3 explicitly rejects both `objects`-RLS surgery and an outside-tenant-RLS privileged table. Recommended design (A): one scan control whose effective threshold is the merged MIN, threaded via the gate context (reuses the **shipped** M17.1 `context.artifactDigest` threading). **Runs in parallel** with M17.3/M17.4 (independent of signing).
  - *Build order:* (1) M17.3 shared cosign signing/verify module → (2) M17.3 sign all types + SBOM + manifest → (3) M17.4 cross-hop verify; (4) M17.5 in parallel.
- **Done / verified by:**
  - **Integration (signing/verify):** a promotion with a failing scan is blocked (Decision recorded); a passing one carries **executor** signatures for every artifact type **and the SBOM**, plus a **commander**-signed promotion manifest (and no commander signature over any origin artifact). At **bundle import** the receiver `cosign verify-blob`s the manifest and rejects a promotion whose arrived artifact **set** doesn't match it (an injected/substituted entry fails) while accepting a matching one — offline pubkey, no re-scan; Ed25519 transport signing is untouched. **Per-artifact byte verification is tested where bytes land** (`pre-deploy-gate.integration.test.ts`: real `registry:2` + real cosign): present+exporter-signed image and blob deploy; a wrong-key image signature, a bad blob `signatureRef`, MISSING bytes (image and blob), and a vanished peer key each **block with a Decision + audit and never trigger**; a domain-local change and a pre-manifest import deploy ungated.
  - **Integration (scoped scan):** effective threshold = per-severity MIN across **platform / trust domain (partition) / org / containment domain / service / component**; a component floor tighter than its org's blocks a promotion the org floor alone would pass; the instance-scoped floors (platform + trust domain) apply to **every** org on the deployment and **no tenant can write them, loosen the resolved floor, or see across to another tenant**; and resolution is proven **order-independent** (shuffling the contributing tiers yields an identical effective threshold).

---

### M18 — Domain-Local Dev/Beta Pipelines (the very end)
*(Late milestone — owner: "for the very end." Design: [ADR-0018](adr/0018-domain-local-dev-pipelines.md); depends on nothing in M17.)*
- **Goal:** domain-local **dev/beta** pipelines an engineer iterates on inside a single domain, deploying to a dev/beta target **without** the cross-boundary supply-chain gate — and provably **without** opening a leak. The exemption is **not** new enforcement: it is the existing [ADR-0013](adr/0013-supply-chain-scan-sbom-manifest.md) domain-local case (a dev change targets **no** federation peer → never reaches `exportPromotionBundle` → the cross-boundary scan gate **structurally never applies**), named and made legible.
- **Contents:**
  - **M18.1 Path-scoped exemption + leakage test** — the exemption keys on **origin-domain-locality (a PATH property)**, never a per-artifact `dev` tag. The leakage guarantee is **(i)** the **M17.3 E6 export gate** (a dev digest **promoted later** is hard-refused unless a passing, **digest-bound** scan exists — scanned **at the crossing**, not exempted) **plus (ii)** no local-deploy path reaching the export. A permanent test proves a dev-built digest, when promoted to a peer, is **refused at E6** without a passing scan (the exemption never followed the artifact).
  - **M18.2 Deploy-percentage is observed, never set** — a dev pipeline's 10%/100% rollout weight is the dev's **Argo Rollout spec**; SCP **observes** it ([ADR-0008](adr/0008-observe-enrichment-signals.md) dec 3) and never sets it (coordinate-not-execute).
  - **M18.3 Optional operator labeling (inert)** — an optional `deploymentTarget` `classification='dev'` / [ADR-0016](adr/0016-scoped-scan-requirement-policies.md) `origin='local'` label for **UI/reporting only** — **NOT** an enforcement input. A test proves forging/removing the label changes **no** gate outcome (enforcement keys solely on the path).
- **Done / verified by:**
  - **Integration (leakage):** a dev-originated digest deployed domain-locally skips the gate; the same digest **promoted to a peer is refused at E6** (missing-scan = failed-scan), with a block Decision + `decision_id`; a matching scanned digest promotes cleanly. **The `dev` label is proven inert** (removing/forging it changes no outcome).

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
