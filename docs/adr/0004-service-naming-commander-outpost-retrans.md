# ADR-0004: Service naming — commander / outpost / retrans (federation role rename)

| | |
|---|---|
| **Status** | **Accepted** — owner decision, 2026-07-15 |
| **Date** | 2026-07-15 |
| **Deciders** | Owner (jag8765) |
| **Relates to** | [DESIGN.md §13 (Federation)](../DESIGN.md), [docs/ARCHITECTURE.md](../ARCHITECTURE.md), `packages/schemas/src/federation.ts` (`FederationRoleSchema`), `apps/server/drizzle/0020_commander_outpost_retrans.sql`, [BUILD_AND_TEST.md §6](../BUILD_AND_TEST.md) (API additive-only within `/v1`, `tools/openapi/check.sh`) |

## Context

Federation (DESIGN.md §13) has shipped since M6 with a two-role, hub-and-spoke vocabulary: **`parent`** (the single instance that is the Global Coordination Layer / source of truth for global config) and **`child`** (a per-environment domain instance — commercial, GovCloud, air-gapped, …) enrolled with it. `FederationRoleSchema` (`packages/schemas/src/federation.ts`) is `z.enum(["unset", "parent", "child"])`, carried on the `federation_self.role` and `federation_peers.role` columns (`apps/server/src/db/schema.ts`), and threaded through the CLI (`scp federation init --role`), the routes, the `federation-https` transport plugin, and the SDK/OpenAPI contract.

Two things motivated a rename:

1. **`parent`/`child` reads as a strict ownership hierarchy**, which is not quite the shape of the system — every install is the same binary and the same Domain Control Plane; the designated instance is a coordination role, not an owning parent in the graph-containment sense the codebase also uses "parent"/"child" for elsewhere (process supervision, RBAC containment walks, git commit ancestry). The overloaded vocabulary was already a source of local confusion in review (see the surviving, deliberately-untouched "parent"/"child" usages in `graph/objects-repo.ts`, `graph/import-repo.ts`, `cel-worker-entry.ts`, and the plugin-host subprocess code, all a *different* concept).
2. **A third role is needed** for work already scoped but not yet built: a CDS (cross-domain solution) boundary node (see the air-gap CDS proposal work). That node is not a full outpost — it holds no local authoritative objects, never originates config, and never terminates a promotion. It only validates (the same signature/hash-chain checks as any import) and relays the artifact onward through the CDS. Retrofitting a third value onto `parent`/`child` later, once CI/docs/UI all say "parent or child," would have been a second breaking rename instead of one.

## Decision

**Three service tiers**, used in docs and code alike:

- **`commander`** — top/central. Replaces `parent`. The single source of truth for global configuration (domain registry, org structure, global policies, release topologies, campaign/initiative definitions).
- **`outpost`** — per-environment/region. Replaces `child`. One per environment (e.g. `commercial-amer`, `commercial-apac`, `federal`, `airgap-1`); authoritative for its own local objects, structurally read-only on commander-origin config.
- **`retrans`** (retransmission) — **new**. Sits at a CDS boundary. Deliberately does much less than an outpost: it still validates (signature/hash-chain verification, the same fail-closed checks as any import) but otherwise only relays a bundle onward through the CDS. It never originates config, never holds local authoritative objects, and never terminates a promotion — a store-and-forward validation relay, nothing more.

`FederationRoleSchema` becomes `z.enum(["unset", "commander", "outpost", "retrans"])`.

### Clean break, not additive aliases

The owner explicitly rejected keeping `parent`/`child` as deprecated aliases alongside the new names. **`parent` and `child` are removed outright**, not mapped or accepted as legacy input. Justification:

- **Pre-1.0.** No published `/v1` contract has external consumers yet beyond this repo's own CLI/SDK/UI.
- **Single deployment.** The homelab install (`docs`/memory: "SCP live on homelab k3s") is the only running instance; there is no fleet of already-configured `parent`/`child` peers whose config would break.
- **Zero legacy vocabulary to carry.** An alias would mean documentation, error messages, and the CLI help text forever explaining "parent (also spelled commander)" for a rename that has no external users to serve. That cost was judged higher than the one-time migration cost below, especially before a real SDK-consumer or federation partner exists to be broken by it.

This is the same reasoning trail as the parent/child-*process* and RBAC parent/child hierarchy concepts staying untouched elsewhere in the codebase: this ADR renames the *federation role* vocabulary specifically, not every English use of the words "parent" and "child."

### Data migration

`role` is a plain `text` column on `federation_self` and `federation_peers` (`apps/server/src/db/schema.ts`) with no `CHECK` constraint and no earlier SQL migration that hard-codes `parent`/`child` as literal values — enforcement was always at the application/Zod layer. The rename is therefore purely a **data** migration, not a schema migration: `apps/server/drizzle/0020_commander_outpost_retrans.sql` rewrites any existing `'parent'` row to `'commander'` and any `'child'` row to `'outpost'` on both tables. A fresh or never-initialized instance has no rows to touch (`federation_self` is created lazily with `role: 'unset'` on first use).

### `retrans` semantics — deliberately minimal

The role is **declared, not built out**. It is added to the enum, to the CLI's `--role` help text, and documented (here and in DESIGN.md §13) as validate-and-relay-only with no local authority. No CDS transfer logic ships with this ADR — that lands with the dedicated CDS work referenced above. Anywhere an exhaustive `switch`/union over the three roles needed a `retrans` arm to typecheck, the minimal correct behavior was implemented with a comment pointing back to this reduced-responsibility contract, rather than inventing behavior ahead of the feature that needs it.

### Breaking `/v1` change

Removing enum values from a published Zod schema is an OpenAPI-level breaking change under `tools/openapi/check.sh`'s additive-only-within-`/v1` gate (BUILD_AND_TEST.md §6) — the check is expected to **fail** (ERR-level break) on this PR, by design. Per that script's own header, the override is a human-applied `api-v2-exception` label, not a code or CI-config change. This ADR is the record that the break is deliberate and owner-approved, not an oversight to route around.

## Consequences

**Positive**
- One coherent, non-overloaded vocabulary for the federation role, distinct from the unrelated "parent/child" usages that remain elsewhere in the codebase (process supervision, graph containment, CEL worker messaging).
- Room for the CDS boundary role to exist in the type system and API contract now, ahead of the CDS work itself, without a second breaking rename later.
- No schema migration risk — the rename is a same-shaped `text` column with a straightforward `UPDATE`.

**Negative / cost**
- A hard breaking change to the `/v1` API contract (`FederationRoleSchema`, `scp federation init --role`, `scp federation pair --role`, and every route/SDK type that surfaces `role`) — requires the `api-v2-exception` label and conscious reviewer sign-off, not a rubber stamp.
- Any external tooling or script written against the old `parent`/`child` values (there are none known today — homelab is the only deployment) would need to update in lockstep with the upgrade; there is no compatibility window.
- `retrans` exists in the enum and CLI before the CDS feature that gives it real behavior — a small amount of "declared ahead of use," accepted deliberately rather than blocking the rename on the CDS work's schedule.

## Alternatives considered

1. **Additive aliases** (`parent`/`child` kept as accepted input, normalized internally to `commander`/`outpost`) — rejected. See "Clean break, not additive aliases" above: no real consumers exist yet to protect, and the doc/CLI/help-text cost of explaining two names forever was judged not worth paying for zero backward-compatibility benefit.
2. **Keep `parent`/`child` and bolt `retrans` on as a third value** (`z.enum(["unset","parent","child","retrans"])`) — rejected: does not fix the overloaded-vocabulary problem that motivated the rename in the first place, and `retrans` alongside `parent`/`child` reads even less coherently than alongside `commander`/`outpost`.
3. **Defer the rename until the CDS work lands and needs the third role anyway** — rejected: the owner judged it strictly cheaper to do one breaking rename now (pre-1.0, single deployment) than two smaller ones (rename, then add-a-role) at a point where more might depend on the old names.

## Verification

- `apps/server/drizzle/0020_commander_outpost_retrans.sql` + the matching `apps/server/drizzle/meta/_journal.json` entry (idx 20).
- `pnpm --filter @scp/schemas build && pnpm gen` regenerates `tools/openapi/openapi.v1.json` and the `@scp/sdk` client types with the new enum; committed as part of this change (codegen outputs are committed per CLAUDE.md).
- `tools/openapi/check.sh` (CI job 3) is expected to fail on this PR — flagged loudly in the PR body, resolved by the `api-v2-exception` label, not by editing the check.
- Federation integration tests (`apps/server/src/federation/federation.integration.test.ts`, `apps/server/src/federation/mtls.integration.test.ts`) exercise pairing/import/export/mTLS under the new role values against a real Testcontainers Postgres, including the migration path.
