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
- ~~a `coordinated_by` relationship (component → execution-system)~~ — **CORRECTION (2026-07-15): this was never true.** The plugin returns `relationships: []` ([argocd/src/index.ts:466](../../packages/plugins/argocd/src/index.ts)), and `coordinated_by` was never a registered relationship type (the real `coordinates` is `{campaign,initiative} → {change,campaign}`, unrelated). Imported components are therefore graph ORPHANS: the coordination link exists only in the `executor_bindings` projection table, not in the graph. Confirmed live on the homelab import (50 apps → 50 components, 0 relationships). Superseded by [service-component-model.md](service-component-model.md).
- **a proposed executor binding** per component (`module: argocd`, `executionSystemId`, `externalRef: <name>`).

### 4. `discovery accept` also creates the proposed bindings

`DiscoveryProposal` gains an optional `bindings[]`; `accept` creates objects + relationships **+ bindings** in the same transaction. One accept → imported and coordinated.

### 5. CLI flow

```bash
scp connect argocd --url https://argocd.mine --token <TOKEN> --name prod
  # → stores the token secret, creates the execution-system object, VALIDATES connectivity (GET /applications)
  # for an IN-CLUSTER / private-address Argo CD (e.g. http://argocd-server.argocd.svc), add
  #   --allow-internal-egress   → sets execution-system.allowInternalEgress so SCP's SSRF egress guard
  #   permits this system's private ClusterIP (per-system, operator-vetted — see docs/adr/0003)
scp discovery run   --execution-system prod        # enumerate → proposal
scp discovery accept <proposalId>                  # create components + bindings (NOT relationships — see the
                                                   # correction in §3; imported components land as orphans)
  # → SCP now observes/triggers/status/aborts your existing apps.
```

## Phased build

- **P1 — Trigger fix + `external_ref`** (foundational, independently valuable): add `external_ref` to bindings (schema/migration/repo/API/CLI `--target-ref`); reconcile uses it. Mode A coordinates a real app with a manual bind. Verified by extending the argocd plugin's trigger test + an integration test.
- **P2 — `execution-system` type + binding→system resolution**: seed the type; add `execution_system_id`; resolve plugin config from the system; observe() keys on it.
- **P3 — `argocd-discovery`** (DONE): a `DiscoveryPlugin` in the `@scp/plugin-argocd` package (mirrors github's executor+discovery split) that enumerates Applications (`GET /api/v1/applications`) and proposes one `component` per app with `properties.argocdApplication = <name>` recorded (so an execution-system binding's `externalRef` addresses the right app). Wired into the plugin host + `KNOWN_DISCOVERY_MODULES` + the manifest catalog.
- **P3b — accept-creates-bindings** (DONE): `DiscoveryProposal` gains `bindings[]` (both the plugin-api contract and the API schema); `discovery accept` creates them (resolving `objectName` → the freshly-created id) and returns `createdBindingIds`; argocd-discovery emits a binding per app when its config carries `executionSystemId`. Import→coordinate is now one `accept`.
- **P4 — `scp connect argocd`** (DONE): one command — stores the token, creates the `execution-system` object, best-effort connectivity check, and prints the `discovery run` next-step. Wraps `secret put` + `object create`.
- **P5 — UI "Connect Argo CD" wizard.** No longer an unhomed "fast-follow": it lands as **[M19](../BUILD_AND_TEST.md#m19--connect-an-execution-system-from-the-browser-the-import-wizard)** (decided 2026-08-10 — M15.3 is the right topic home but M15 closed COMPLETE on 2026-07-22, and the M14 slot promised to P5 on 2026-07-13 was later reallocated to Federation live-sync + Poke-Mode). Design below.

Each phase is codegen-clean (`pnpm gen`) and lands with tests.

## P5 design — the wizard (M19)

**UI-only.** Every step already has a public door, so P5 adds no route, no schema, no migration, and no codegen output:

| Step | Door |
|---|---|
| store the Argo CD token | `client.secrets.put` |
| create the `execution-system` | `client.object("execution-system").create` |
| enumerate Applications | `client.discovery.run` |
| import + coordinate | `client.discovery.accept` (returns `createdBindingIds`) |

`scp connect argocd` is the reference implementation; the wizard mirrors its real flags (`--url`, `--token`, `--name`, `--token-key`, `--allow-internal-egress`) rather than inventing a second shape. Every route it touches needs `object:write`, which the operator registering an execution system already holds.

**Step 2 sends only `{executionSystemId}`.** `POST /discovery/run` resolves `serverUrl`, `tokenSecretKey`, `secretRefs`, the egress allowlist and `allowInternalEgress` from the **persisted** system and lets those win over anything the caller sent (`routes/executors.ts`) — the ADR-0003 fix for "a grant on system X authorizing egress to a caller-supplied address". So the wizard never re-sends the URL and **never handles the token again after step 1**.

**Three hazards, and the shape of each answer:**

1. **In-cluster Argo CD is the first case, not the edge case.** A private `serverUrl` is refused by the SSRF guard unless *both* ADR-0003 layers permit. The wizard offers `allowInternalEgress` as an explained checkbox, labelled as the **declaration** it is — the operator's `SCP_INTERNAL_EGRESS_HOSTS` allowlist remains the boundary, and the wizard says so instead of implying the checkbox is the grant. Never a silent default.
2. **A credential crosses the browser exactly once.** The token goes to `secrets.put` and nowhere else — no query cache, no URL, no router state, no retained mutation `variables`, no log, and cleared from component state on success. `secrets` is write-only by contract, so the wizard cannot read it back and does not try. Credential asymmetry unchanged: a scoped API token *to* Argo CD, never Argo CD's cluster credentials.
3. **Imported components are graph orphans (§3 correction, 2026-07-15).** `accept` creates components + bindings + `source_mappings` and **zero relationships**. The success screen renders the counts the server returned and, when the relationship count is zero, states plainly that nothing was linked into a service and names the next step. Counts are **read from the response, never inferred** from what the plugin is believed to emit.

**No client-side connectivity check.** The CLI's best-effort `GET /api/version` runs in the operator's shell and cannot be reproduced in a browser aimed at a private address — a client-side probe would fail for hazard 1 and would be simulating server behaviour in the client (the class of thing PR #152 removed). Step 2 is the real check: server-side, through the guard, with the stored token. Stopping after step 1 is the `--no-validate` equivalent and reaches the same end state. Credential asymmetry holds throughout: SCP stores a scoped **API token** to the user's Argo CD, never its cluster credentials.
