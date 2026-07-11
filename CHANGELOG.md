# Changelog

All notable changes to CommanderSCP are documented here. Per `.changeset/README.md`, `@scp/plugin-api`
and `@scp/sdk` carry independent semver via Changesets when their public surface changes; every
other package in this monorepo is private/internal and versioned alongside the platform release
below. Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

## [1.0.0-rc.0] — M8: Hardening, Packaging & Release Candidate (unreleased)

MVP scope closed — production Kubernetes path, air-gap bundle, hardening, and release machinery.
See the M8 pull request for the full definition-of-done evidence (CI-gated vs. manual breakdown,
load/perf numbers, security-sensitive surfaces).

### Added
- Helm chart (`deploy/helm`): `api` (HPA-scalable) + `worker` (queue-depth-scalable) Deployments,
  a pre-install/pre-upgrade migrations Job (`apps/server/src/migrate-bin.ts`, expand/contract),
  hardened pod defaults (non-root, read-only rootfs, dropped caps, `seccompProfile: RuntimeDefault`)
  on every container, default-deny NetworkPolicy + explicit allows, Ingress + ServiceMonitor,
  object storage PVC/S3, external PostgreSQL by default with an eval-only in-cluster option,
  managed-IaC (Mode 2) RBAC + reference Job template, federation mTLS secret wiring. Verified
  end to end against a real `kind` cluster: install → golden path → zero-downtime upgrade →
  rollback (`scripts/kind-drill.sh`).
- Air-gap bundle builder (`deploy/airgap`, `@scp/airgap`) and Ansible collection (`scp.platform`)
  for VM/on-prem fleet updates wrapping the signed-bundle installer.
- `tools/ci-image`: a versioned CI runner image baking in Node/pnpm/Playwright Chromium so the
  Web E2E job makes no CDN/network fetch.
- `tools/helm-verify`: structural hardened-defaults assertions over `helm template` output —
  non-root/read-only-rootfs/dropped-caps/seccompProfile, least-privilege DB credential
  separation, single image version (no api/worker skew), default-deny + explicit-allow
  NetworkPolicies with no any-destination DB-port egress, ingress mTLS annotations when enabled.
  **Genuinely CI-gated** as of the adversarial-review fix pass (MAJOR #4 — a prior version of this
  entry claimed "CI gate" while the tool was invoked nowhere in CI): a dedicated job
  (`.github/workflows/ci.yml`'s `helm-verify`) runs it on every push/PR, and it's additionally
  picked up automatically by `pnpm test` (`tools/helm-verify` now has a `test` script, so Turborepo
  includes it in the standard test task graph).
- Federation mTLS transport identity (DESIGN §13): `federation-https` now presents a real client
  certificate (host-level, operator-configured — `SCP_FEDERATION_MTLS_*`), proven against a real
  mTLS-enforcing test server (`plugin-host/federation-mtls.test.ts`) including peer-without-a-
  valid-cert rejection. Also wires `federation-https` into the subprocess plugin host for the
  first time (`FederationTransportPluginClient`, a `PluginHost.federationTransport()` accessor).
- Create-time module allowlist: executor/notification binding creation now rejects an unknown or
  wrong-kind `pluginModule` at write time, mirroring the existing discovery-create check.
- Multi-replica coordination single-flight — **all FOUR** genuine races found and reproduced
  against a real Postgres while hardening for `worker` replica scaling, one coherent story:
  1. the wave-target trigger claim (could double-fire a real executor call) —
     `trigger-claim-lock.ts`, a Postgres session-scoped advisory lock
     (`apps/server/src/coordination/advisory-lock.ts`).
  2. the `evaluated -> coordinated` plan compilation (could persist a duplicate plan and
     wrongfully cancel a change another replica had already coordinated) —
     `change-coordination-lock.ts`, the same advisory-lock mechanism.
  3. webhook-event processing (could create duplicate Changes for one real webhook delivery under
     concurrent ticks) — closed with `FOR UPDATE SKIP LOCKED` on the claim query.
  4. the executing-wave gate evaluation (`reconcile.ts`'s pending-wave branch — could insert a
     duplicate `kind: "gate"` audit Decision under concurrent ticks; bounded — no double-execution,
     since `markWaveRunning` is itself idempotent and triggering was already covered by #1) —
     found in the adversarial review of this same PR (MINOR #5) and closed with the same
     `change-coordination-lock.ts` lock, completing the single-flight story across every
     `reconcile.ts` state-advancing branch.
- `SCP_SKIP_MIGRATIONS`: `api`/`worker` pods can now run with only the least-privileged
  `scp_app`/`scp_pgboss` database credentials — only the migrations Job ever holds the admin
  connection.

### Fixed
- `instance_keys` (each org's federation/attestation Ed25519 private signing key) became
  org-scoped in M6 but never received a Row-Level Security policy — a full RLS audit found this
  gap and closed it (`drizzle/0016_instance_keys_rls.sql`), with adversarial regression coverage
  added to `rls.integration.test.ts`.
- Dependency hygiene: `pnpm audit --prod` findings reduced from 19 to 4 (0 critical) —
  `undici` 5→7 (federation mTLS's own new dependency), `@fastify/static` 8→9, and a
  `@scp/plugin-testkit` dependency-classification fix (`vitest` moved to `peerDependencies`,
  matching the originally documented intent) that removed a large class of dev-tooling-only noise
  from the `--prod` audit surface entirely.

## Earlier milestones

- **M7 — Real Executor Integrations**: GitHub App, ArgoCD, and Terraform/OpenTofu (pipeline-mediated
  and SCP-managed IaC via the isolated `scp-runner-iac` image) plugins; SMTP/webhook notifications;
  plugin config schemas as validated forms.
- **M6 — Federation Basics**: outbox-derived signed sync journal, file-transport export/import,
  parent/child enrollment, Promotion Bundles with approval attestation, shared-authority overlays.
- **M5 — Campaigns & Initiatives**: coordinated multi-change activity and roll-up status over the
  existing coordination/governance engines.
- **M4 — Governance Engine**: policies (CEL), controls, N-of-M approvals with Ed25519 attestation,
  freezes, emergency changes, Decision records everywhere.
- **M3 — Changes & Coordination Engine**: the Change lifecycle state machine, correlation, plans/
  waves/topologies, the resumable reconciliation loop, rollback, the subprocess plugin host.
- **M2 — Registries, Relationships & the Modeled Org**: typed registries, Web UI v1, generic OIDC,
  `@scp/iac`, server-side plan/apply.
- **M1 — Graph Core**: generic objects/relationships, runtime type registry, RLS multi-tenancy,
  hash-chained audit log, RBAC.
- **M0 — Walking Skeleton**: the first end-to-end slice — compose stack, one registered object,
  the full contract pipeline (Zod → OpenAPI → SDK → CLI).

[1.0.0-rc.0]: https://github.com/CommanderSCP/commanderscp/compare/main...m8-hardening-packaging-rc
