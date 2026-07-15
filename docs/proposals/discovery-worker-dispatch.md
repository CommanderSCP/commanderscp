# Proposal: `discovery/run` must work on the topology we ship

**Status:** Draft — proposed 2026-07-15, pending owner review.
**Severity:** Shipped bug — the documented Mode A flow is impossible on a default `helm install`.
**Relates to:** [import-existing-executors.md](import-existing-executors.md) (the flow this breaks), [ADR-0002](../adr/0002-execution-strategy.md) (Mode A), [DESIGN.md](../DESIGN.md) §8 (event bus / pg-boss), §16 (deployment topology).

## The bug

`POST /discovery/run` executes the DiscoveryPlugin **in-process** and requires `deps.pluginHost`, which only exists when `SCP_ROLE=all|worker` (`main.ts:88-140`). An API-only process rejects it:

```
400 discovery requires a worker-capable process (SCP_ROLE=all or worker) — this process is API-only
```
`routes/executors.ts:548`

The Helm chart — our own shipped, recommended topology — renders exactly the deployment that cannot serve it. Rendered from default values:

```
Service exists:  scp-commanderscp-api        <- the ONLY Service in the chart
Deployment api    -> SCP_ROLE=api            <- no plugin host
Deployment worker -> SCP_ROLE=worker         <- HAS the plugin host, but no Service
Ingress ->  scp-commanderscp-api
```

So on **every** default install:
- the ingress terminates at api pods, which are `role=api` and always 400;
- the worker has **no Service**, so nothing can address it;
- there is **no values knob** to set `role=all` — the roles are hardcoded per-Deployment template.

**The documented Mode A flow is therefore unusable as shipped.** [import-existing-executors.md](import-existing-executors.md) §5 tells the operator to run `scp discovery run` immediately after `scp connect argocd`; against a standard install that returns 400 with an error mentioning an env var they cannot set. The only way through is `kubectl port-forward` to a worker *pod* located by label — which is what we did during the 2026-07-15 homelab bring-up, and mistook for a rough edge rather than the feature being broken.

This is not exotic: it hits every Helm user, on the happy path, on a headline feature.

## Why it wasn't caught

- Unit/integration tests build the app with `role=all` (one process, plugin host present), so the gate never fires.
- The E2E suites drive compose/kind topologies that are also worker-capable.
- Nothing tests **the topology the chart actually ships**. The gate is correct code; the deployment is the untested part.

That is the generalizable lesson: *the shipped topology is a test surface, and we don't test it.*

## Constraint: api must stay a pure request server

`main.ts:83-88` is explicit — *"only the roles that own background work run them; `role=api` stays a pure request server."* The plugin host is a subprocess host; giving it to every api replica means N HPA-scaled pods each spawning plugin subprocesses, with tenant secrets resolved into them. **Making api worker-capable is not on the table** — it would dissolve the role split and its least-privilege posture, and it scales the wrong thing.

So the fix must let an api-only process *cause* discovery to happen somewhere worker-capable.

## Options

### A. Async dispatch via pg-boss (recommended)

Discovery becomes a job, exactly like `observe`/`watchdog` (`main.ts:131-134` already runs both loops under `role=all|worker` on pg-boss).

- `POST /discovery/runs` → enqueue, return `202` + a run id. Works from **any** role.
- Worker consumes, executes the plugin, persists the proposal.
- `GET /discovery/runs/{id}` → `pending | succeeded | failed` + the proposal.
- CLI polls, so `scp discovery run` **still feels synchronous** to the operator — no UX change.

**Additive** — new endpoints alongside the existing `POST /discovery/run`, which keeps working for `role=all` (dev/compose/eval). No oasdiff break, no `api-v2-exception`.

Costs: a place to persist proposals (a table, or reuse the object-storage provider); job plumbing; the CLI poll loop. It also **removes the request-lifetime bound on discovery** — enumerating a large Argo CD is currently hostage to an HTTP timeout, which async fixes for free.

### B. api proxies to a worker over HTTP

Add a worker Service; api forwards the request internally.

Keeps the sync contract, but: the worker already serves the full API (`app.listen` is unconditional), so exposing it as a Service makes **every route reachable on the worker**, not just discovery — a real surface expansion. Needs api→worker egress in the NetworkPolicy (which is default-deny). Needs load-balancing/retry across worker replicas. And it's a bespoke internal RPC path parallel to the pg-boss one we already have. **Not recommended** — more moving parts, worse security posture, and it duplicates existing infrastructure.

### C. A `role=all` values knob

Let operators collapse to a single worker-capable Deployment. Honest as an **escape hatch for small installs** (the homelab is exactly this), but it is not a fix: it abandons the api/worker split the chart is built around, and silently changes the security posture of every api replica. Reasonable as a **documented, opt-in extra** alongside A — not instead of it.

### D. Document the limitation

Rejected. "Run this command; it returns 400 unless you port-forward to an unaddressable pod" is not a product.

## Recommendation

**A**, plus **C** as an explicit small-install escape hatch, plus a test that renders the shipped chart's topology and asserts the documented flow works against it (§"Why it wasn't caught").

## Scope check — is discovery the only victim?

`deps.pluginHost` gates any in-process plugin execution reachable from a route. Discovery is the one we hit, but the audit belongs in this work: **anything else routed through an api-only process that needs the plugin host has the same bug.** (`reconcile`/`observe`/`watchdog` are worker loops already and unaffected; control evaluation runs in the reconcile path, not a route.) That audit is a P0 item below, not an assumption.

## Phasing

- **P0 — audit.** Enumerate every route touching `deps.pluginHost`; confirm discovery is the only ingress-reachable one. Cheap, and it sizes the rest.
- **P1 — async run.** `POST /discovery/runs` + `GET /discovery/runs/{id}` + worker consumer + proposal persistence. Additive.
- **P2 — CLI.** `scp discovery run` uses the async path with a poll + `--wait/--no-wait`; unchanged UX.
- **P3 — topology test.** Render the chart's real api/worker split (kind, per the M9.4 drill) and assert `connect argocd` → `discovery run` → `accept` works **through the ingress**. This is the test whose absence let this ship.
- **P4 — escape hatch.** Optional `role=all` values knob, documented for single-node installs, defaulting off.

## Open questions

1. Where do proposals persist — a new table, or the object-storage provider (they're JSON documents, potentially large for a 50+ app Argo CD)?
2. Retention: proposals are reviewable artifacts. TTL, or keep until accepted/rejected?
3. Does `POST /discovery/run` (sync) stay forever for `role=all`, or get deprecated once the async path lands?
4. Should the 400 message, until P1 ships, at least tell the truth — i.e. name the port-forward workaround rather than an env var the operator cannot set on a Helm install?
