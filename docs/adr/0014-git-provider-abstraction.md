# ADR-0014: Provider-neutral git-provider-core + thin per-provider adapters

**Status:** Proposed (2026-07-18)
**Context doc:** [docs/proposals/promotion-and-execution-model.md](../proposals/promotion-and-execution-model.md)
**Relates to:** [ADR-0012](0012-registry-consolidation.md) (Gitea as the default unified git + registry); [ADR-0010](0010-outpost-local-artifact-infra.md) (per-outpost local Gitea, create-or-import); M15 (bundled Gitea), M15.1 (this work)

## Context

ADR-0012 makes **Gitea** the default bundled git service, and M15 stands it up per-outpost. That means CommanderSCP needs a **Gitea `ExecutorPlugin`** (observe pushes/PRs, trigger Gitea Actions, read run status) alongside the existing **GitHub** one. Today `@scp/plugin-github` is a single ~700-line module that interleaves two very different concerns:

- **Provider-neutral coordination machinery** — the idempotency/dedup cache the crash-safe retry in `coordination/reconcile.ts` depends on, correlation-hint normalization, the observe cursor (ISO watermark) protocol, and the dispatch-then-persist trigger dance. None of this is GitHub-specific.
- **GitHub-wire specifics** — GitHub App JWT → installation-token auth, the base URL + REST wrapper, `workflow_dispatch`/`repository_dispatch`, `X-Hub-Signature-256` webhook verification, GitHub event→hint mapping, and the run status/conclusion → `ExecutionPhase` map.

Copy-pasting the whole module for Gitea would duplicate the coordination machinery (and its subtle idempotency semantics) into a second place that then drifts.

## Decision

Extract the provider-neutral machinery into a shared internal library, **`@scp/git-provider-core`**, and refactor `@scp/plugin-github` into a **thin adapter** over it. New providers arrive **additively** — a new adapter module — rather than by generalizing GitHub in place; existing GitHub executor bindings are untouched (the `github`/`github-discovery` module names, config schema, verbs, and observable behavior are byte-identical, proven by the unchanged GitHub `nock` suite).

`@scp/git-provider-core` is a normal workspace package that provider plugins depend on. It is **not itself a loadable plugin module** (the plugin host never imports it directly; only the per-provider plugins do). It exposes the `GitProviderAdapter` interface and `createExecutorPluginFromAdapter(adapter)`, which assembles a full `ExecutorPlugin` (observe/trigger/status/abort/describeCapabilities) from an adapter.

### `GitProviderAdapter` (the per-provider seam)

| Hook | Consumer | Responsibility |
|---|---|---|
| `sourceKind` | discovery / source mapping | provider identity literal (`"github"`, `"gitea"`) |
| `authorize(ctx)` → headers | adapter's own REST calls | auth headers (bearer token, accept/content-type) |
| `baseUrl(ctx)` | adapter's own REST calls | provider REST base URL |
| `resolveStatePath(ctx)` | **core factory** | where the dedup cache persists (undefined = in-memory) |
| `triggerCI(ctx, intent)` → `ExternalRunRef` | **core factory** | fire the provider's own automation, **including any provider-specific run-correlation step** (GitHub: dispatch returns 204, then poll the runs list) |
| `pollCommits(ctx, sinceIso?)` → `ExecutorEvent[]` | **core factory** | push-equivalent polling fallback |
| `pollRuns(ctx, sinceIso?)` → `ExecutorEvent[]` | **core factory** | run-equivalent polling fallback |
| `getStatus(ctx, ref)` | **core factory** | run status |
| `abortRun(ctx, ref)` | **core factory** | run cancel |
| `capabilities()` | **core factory** | `ExecutorCapabilities` incl. `triggerKinds` |
| `verifyWebhook(rawBody, header, secret)` | server webhook ingest | signature verify (fail-closed) |
| `mapEvent(name, payload)` → hint | server webhook ingest | event-name → correlation hint |
| `mapStatusToPhase(status, conclusion)` | `getStatus` | native status → `ExecutionPhase` |

The core owns: the idempotency/dedup cache (`loadDedupState`/`saveDedupState`/`dedupCacheKey`, file-backed via write-temp+rename or a single process-wide in-memory map — identical scoping to what GitHub had before), `normalizeCorrelation(hint)`, the observe cursor protocol (decode `since.token` as an ISO watermark, pass to both pollers, concatenate commits-then-runs), and the trigger dance (dedup-first → `triggerCI` only for a genuinely new key → persist → return).

## Risks / follow-ups

- **Gitea Actions REST parity (unconfirmed).** The GitHub adapter's `triggerCI` correlation step leans on GitHub's exact runs-list semantics (`workflow_dispatch` returns 204 with no run id; the newest matching run is adopted after a bounded poll). Gitea Actions exposes a GitHub-Actions-shaped REST surface, but its dispatch/runs-list field parity is **not yet verified against a live instance**. The abstraction is deliberately coarse (`triggerCI` returns a ref, correlation included) precisely so a Gitea adapter can implement a *different* correlation dance if needed — but the parity assumption is flagged here and must be confirmed by a later live drill (M15.1b), not assumed from docs.
- **Webhook wiring.** `verifyWebhook`/`mapEvent` are on the adapter contract, but the server webhook path (`apps/server/src/coordination/`) still imports GitHub's standalone `verifyGithubWebhookSignature`/`mapGithubWebhookEventToHint`. Routing the server webhook ingest through an adapter registry keyed by `sourceKind` is follow-up work; this ADR only extracts the executor seam.

## Consequences

**Positive** — the coordination-critical idempotency semantics live in one tested place; a new provider is a thin adapter, not a fork; GitHub's external contract and its `nock` behavioral spec are unchanged.

**Costs** — one more workspace package; two hooks (`verifyWebhook`/`mapEvent`) are defined on the adapter ahead of the server consuming them through it (documented follow-up above).
