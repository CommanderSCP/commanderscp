# Proposal: Import & coordinate existing execution systems (Mode A activation)

**Status:** Draft — proposed 2026-07-13, pending owner review.
**Relates to:** [ADR-0002](../adr/0002-execution-strategy.md) (Mode A / BYO-coordinate), [DESIGN.md §12](../DESIGN.md) (Executor Integrations), the observe() driver (M10.2, `apps/server/src/coordination/observe.ts`).

## Goal

Let an operator point CommanderSCP at an **execution system they already run** (Argo CD first), have SCP **discover** its resources and **coordinate** them (observe / trigger / status / abort) — instead of standing up a bundled duplicate (Mode B). CLI first; a "Connect Argo CD" UI wizard is a fast-follow.

Owner decisions (2026-07-13): (1) model the server as a **first-class "execution system" entity** (register once, token attached once, components reference it — no per-binding duplication); (2) first cut is **CLI import + the trigger fix**, UI follows.

## What already exists (reused, not rebuilt)

- Generic **discovery pipeline**: `DiscoveryPlugin.discover() → DiscoveryProposal`; `POST /discovery/run` (proposes, writes nothing) + `POST /discovery/accept` (materializes objects/relationships); CLI `scp discovery run|accept`. Only `github-discovery` implements it today.
- The Argo CD plugin already calls `GET /api/v1/applications` (in `observe()`) — the exact enumerate-your-apps call.
- Executor **bindings** (config + encrypted `secretRefs`), the `component`/`deployment-target`/`hosted_on` graph types, the encrypted `secrets` store, and the observe() change-ingestion driver.

## The three gaps this closes

1. **Coordination bug (fix regardless of import).** `reconcile.ts:660` sends the graph object **UUID** as `trigger.targetRef`, but the Argo CD plugin ([argocd/src/index.ts:253](../../packages/plugins/argocd/src/index.ts)) reads `targetRef` as the **Application name** → a real trigger 404s. Mode A cannot coordinate a real app today.
2. **No enumerate→register for Argo CD.** No `argocd-discovery` module; `GET /applications` is used only for change-events, never surfaced as a registration proposal.
3. **`discovery accept` creates objects but not bindings.** Importing N apps would mean N manual `executor bind` calls.

## Design

### 1. `execution-system` — a new first-class object type (graph-native: registry data, not a new table)

Seeded as a built-in object type alongside `component`/`service` (a row in the object-types seed — no new top-level table, per charter principle 2). Properties:

```jsonc
{ "kind": "argocd", "serverUrl": "https://argocd.mine", "tokenSecretKey": "argocd-prod-token" }
```

The token is stored in the existing `secrets` table (`scp secret put`) and referenced by key — **once**, on the execution-system object. This is the "register my Argo CD server" anchor and the future UI's connection object.

### 2. Executor binding references the execution-system (no duplication) + carries the external target

Two additive, nullable columns on `executor_bindings`:
- `execution_system_id` (FK to the execution-system object) — when set, the plugin **config is resolved from the execution-system** (`serverUrl` + token via its `tokenSecretKey`) instead of inline binding config. So the URL/token live in one place.
- `external_ref` — the **executor-specific target id** (the Argo CD Application name). This is what fixes gap 1.

`reconcile` change: `trigger({ ..., targetRef: binding.externalRef ?? targetObjectUrn ?? targetObjectId })` — backward-compatible (existing bindings with no `externalRef` behave as today). The observe() driver keys its plugin instance on `execution_system_id`, so all components on one Argo CD share one instance + one poll (fixes today's per-binding dedup-by-convention).

### 3. `argocd-discovery` DiscoveryPlugin (mirrors `github-discovery`)

`discover(ctx)` reads the execution-system's `serverUrl` + token, calls `GET /api/v1/applications`, and returns a proposal of:
- one `component` per Application (`properties.argocdApplication = <name>`, plus namespace/project/repo metadata),
- a `coordinated_by` relationship (component → execution-system),
- **a proposed executor binding** per component (`module: argocd`, `executionSystemId`, `externalRef: <name>`).

### 4. `discovery accept` also creates the proposed bindings

`DiscoveryProposal` gains an optional `bindings[]`; `accept` creates objects + relationships **+ bindings** in the same transaction. One accept → imported and coordinated.

### 5. CLI flow

```bash
scp connect argocd --url https://argocd.mine --token <TOKEN> --name prod
  # → stores the token secret, creates the execution-system object, VALIDATES connectivity (GET /applications)
scp discovery run   --execution-system prod        # enumerate → proposal
scp discovery accept <proposalId>                  # create components + coordinated_by + bindings
  # → SCP now observes/triggers/status/aborts your existing apps.
```

## Phased build

- **P1 — Trigger fix + `external_ref`** (foundational, independently valuable): add `external_ref` to bindings (schema/migration/repo/API/CLI `--target-ref`); reconcile uses it. Mode A coordinates a real app with a manual bind. Verified by extending the argocd plugin's trigger test + an integration test.
- **P2 — `execution-system` type + binding→system resolution**: seed the type; add `execution_system_id`; resolve plugin config from the system; observe() keys on it.
- **P3 — `argocd-discovery` + accept-creates-bindings**: the discovery module + proposal `bindings[]` + accept wiring.
- **P4 — `scp connect argocd`** + connectivity validation; docs.
- **P5 (fast-follow) — UI "Connect Argo CD" wizard.**

Each phase is codegen-clean (`pnpm gen`) and lands with tests. Credential asymmetry holds throughout: SCP stores a scoped **API token** to the user's Argo CD, never its cluster credentials.
