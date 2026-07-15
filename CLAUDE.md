# CLAUDE.md — CommanderSCP

CommanderSCP is a **Federated Systems Coordination Platform**: a graph-native system of record that models an organization's systems, ownership, dependencies, and governance, and coordinates change across existing execution systems (GitHub, ArgoCD, Terraform/OpenTofu, …). It operates across connected, disconnected, and air-gapped domains. It **coordinates rather than executes** — the single scoped exception is the managed IaC executor described in principle 1 below.

## Key documents

| Document | Role |
|---|---|
| [PROJECT_CHARTER.md](PROJECT_CHARTER.md) | **Authoritative.** Vision, requirements, principles, MVP scope. Where anything conflicts with it, the charter governs. |
| [docs/DESIGN.md](docs/DESIGN.md) | Initial architecture. v0.1 Draft — **proposed, pending review**. |
| [docs/BUILD_AND_TEST.md](docs/BUILD_AND_TEST.md) | Toolchain, bootstrap, test strategy, milestones M0–M8. v0.1 Draft — **proposed, pending review**. |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Architecture diagrams (commander instance, outpost instance, multi-domain overview) with legends. SVG sources in `docs/diagrams/` — keep them in sync with DESIGN.md. |

## Current status

**Building — go given 2026-07-08.** Design and build plan are approved (decision log in DESIGN.md §19); the charter carries the Managed Execution Exception. Work proceeds milestone by milestone per BUILD_AND_TEST.md §8, in batches, starting with M0 (walking skeleton). Code lives in the GitHub org **CommanderSCP**, monorepo `CommanderSCP/commanderscp`. Cost discipline: delegate implementation to agents on cheaper models (haiku/sonnet; opus only when genuinely hard) with deliberate effort levels.

## Non-negotiable principles (charter digest)

These are invariants. Never trade them away for implementation convenience.

1. **Coordination, not execution.** CommanderSCP does not deploy, provision, or run tests itself; executor integrations get only observe/trigger/status/abort verbs, and the platform does not hold credentials to the infrastructure that execution systems manage. One scoped exception (owner decision, 2026-07-08): the isolated `scp-managed-iac` executor performs trivial IaC releases for orgs without pipelines — behind the same executor interface, in ephemeral containers from a separate `scp-runner-iac` image, with vaulted scoped credentials (DESIGN.md §12; charter "Managed Execution Exception", approved 2026-07-08).
2. **Graph-native.** Every capability derives from graph objects and first-class relationships. New concepts arrive as relationship/policy/registry data, not new top-level tables.
3. **API-first parity.** Every capability is API → SDK → CLI → IaC → UI. The UI and CLI consume only the generated SDK; nothing may bypass the public API.
4. **PostgreSQL is the only *required* stateful dependency.** NATS JetStream ships as an optional event-bus backend but is never required. Adding another *required* stateful service (broker, graph DB, authz service) needs charter-level justification and owner sign-off.
5. **Air-gap and self-hosting are first-class.** No runtime network calls to the outside world — no CDN assets, no phone-home, vendored tooling. Everything (CI included) must run offline.
6. **Explainability & auditability.** Every engine verdict persists a Decision record with its inputs; every blocked response carries a `decision_id`. Audit events are hash-chained and written in the same transaction as the action.
7. **Decision priorities when trading off** (in order): Simplicity, Extensibility, Federation, Operability, Self-Hostability, Air-Gapped Compatibility, Maintainability, Developer Experience.

## Proposed stack (pending review — see DESIGN.md for rationale)

TypeScript 5.x / Node 22 everywhere. Fastify 5 + Zod (single contract source → OpenAPI 3.1 → generated SDK → CLI/IaC). PostgreSQL 16 serves as graph store, default event bus (outbox + pg-boss + LISTEN/NOTIFY), scheduler, and audit log; NATS JetStream is an optional event-bus backend built early in MVP. Drizzle ORM with expand/contract migrations. React 18 + Vite SPA served by the API process. pnpm workspaces + Turborepo monorepo. CEL (cel-js) for policy expressions. Plugins run under a subprocess isolation host. Federation is hub-and-spoke: a commander instance is the source of truth for global config, outpost domain instances hold it read-only and report status upward, exchanging signed journals over mTLS HTTPS or air-gap bundle files. Deployment: two-container docker compose for dev/eval, one Helm chart for Kubernetes (api/worker scaled independently), signed air-gap bundles, and an Ansible collection for VM/on-prem fleet updates.

## Working conventions

- **Design changes go through docs first.** Architectural decisions are proposed as edits to docs/DESIGN.md and reviewed before implementation. Significant decisions after approval get an ADR under `docs/adr/`.
- **Codegen outputs are committed.** After route/schema changes run `pnpm gen` (OpenAPI emit + SDK regen); CI fails on drift. The API is additive-only within `/v1` (oasdiff gate).
- **Everyday commands** (once M0 lands): `pnpm dev`, `pnpm test`, `pnpm test:integration`, `pnpm gen`, `pnpm check` (pre-push gate), `pnpm seed`, `pnpm doctor`.
- **Tests never touch the internet.** Integration tests run against real PostgreSQL via Testcontainers — never a mocked DB.
- **Milestone discipline.** Each milestone in BUILD_AND_TEST.md §8 has a machine-checked definition of done; its verification lands as permanent CI tests before the milestone is called complete.
