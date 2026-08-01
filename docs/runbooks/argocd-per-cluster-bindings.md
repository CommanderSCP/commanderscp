# Runbook — one Argo CD per cluster: the `pluginInstanceId` binding pattern

**Status:** describes shipped, running behaviour. Measured against the homelab instance on
2026-08-01; every number below is a query you can re-run.

This closes M10.3's second clause ("per-cluster = per-`pluginInstanceId` binding pattern
documented"). Until now the only place that phrase appeared in the repo was the milestone line
asking for it.

## The pattern in one sentence

**One Argo CD instance = one `execution-system` graph object = one `pluginInstanceId`; a target
picks its cluster by which binding it carries, not by any per-target URL.**

There is no "cluster" field on a binding and there is deliberately never going to be one. The
cluster is an *object* in the graph, and the binding points at it.

## Why it is shaped this way

An `ExecutorBinding` is resolved 1:1 per `(target, Type)` by `getExecutorBinding`
([executor-bindings-repo.ts](../../apps/server/src/coordination/executor-bindings-repo.ts)). The
binding carries `pluginModule` (which *tool* — `argocd`) and `pluginInstanceId` (which *instance of
that tool*). For an execution system the instance id is **deterministic and reserved**:

```
execution-system:<execution-system object uuid>
```

`EXECUTION_SYSTEM_INSTANCE_PREFIX` (`executor-bindings-repo.ts:21`) reserves that namespace, and
three separate call sites refuse to let a tenant-chosen inline binding, notification binding, or
control binding squat it (`routes/executors.ts:364`, `:792`,
`notify/notification-bindings-repo.ts:88`, `governance/controls-repo.ts:52`). That matters: if an
arbitrary caller could mint `execution-system:<someone-else's-uuid>`, it would silently re-point a
real cluster's bindings at a plugin instance it controls.

The connection details live on the `execution-system` object's properties, not on the binding:

| property | meaning |
|---|---|
| `kind` | which plugin module (`argocd`) |
| `serverUrl` | the Argo CD API base URL, resolved from *inside* the cluster |
| `tokenSecretKey` | key into the `secrets` table for the scoped API token |
| `allowInternalEgress` | opt-in past the plugin SSRF guard for a private/in-cluster address |

`allowInternalEgress` is the one non-obvious flag. The plugin host's SSRF guard blocks private
address space by default; an in-cluster or Tailscale-reachable Argo CD **will not be reachable
without it**, and the symptom is a connection that never completes rather than a clear refusal.

## Worked example — two clusters, one SCP instance

The homelab instance coordinates two genuinely different Argo CDs through the same `argocd` plugin
module:

```sql
select o.name as execution_system,
       o.properties->>'serverUrl' as url,
       b.plugin_instance_id,
       count(*) as bindings
from executor_bindings b
join objects o on ('execution-system:' || o.id::text) = b.plugin_instance_id
where b.plugin_module = 'argocd'
group by 1, 2, 3 order by 4 desc;
```

```
 execution_system |                      url                      |                  plugin_instance_id                   | bindings
------------------+-----------------------------------------------+-------------------------------------------------------+----------
 homelab-argo     | http://argocd-server.argocd.svc.cluster.local | execution-system:019f5da9-7a22-75aa-b134-8db9d49218c7 |       50
 argocd-prod      | http://argocd-prod.commanderscp               | execution-system:019f6def-857d-73a4-8681-64aaca98862e |       11
```

Same `pluginModule`. Different `pluginInstanceId`. Different cluster. 61 targets routed with no
per-target configuration beyond the binding itself.

`argocd-prod` is worth reading closely, because it shows the pattern does not care whether the
cluster is local: `http://argocd-prod.commanderscp` is a Kubernetes **ExternalName** Service
pointing at a Tailscale egress proxy, which terminates on the production DigitalOcean cluster's
Argo CD. From SCP's point of view that is an ordinary URL on an ordinary execution-system object.
Cross-cluster coordination needed no SCP feature — it needed a Service.

## Adding a second cluster

1. Create the `execution-system` object (`kind: argocd`, `serverUrl`, `tokenSecretKey`,
   `allowInternalEgress: true` if it is private/in-cluster).
2. Store the scoped Argo CD API token under `tokenSecretKey`. SCP holds **only** this token — the
   backend keeps its own kube credentials, which is the credential-asymmetry invariant (DESIGN §12).
3. Bind targets to it with `pluginInstanceId = execution-system:<that object's uuid>`.

Nothing else. In particular do **not** create a second binding *Type* to mean "the other cluster" —
Type is the class of change (`configuration` for a GitOps sync), orthogonal to which cluster runs
it (DESIGN §12, ADR-0007). Conflating them is the mistake this pattern exists to prevent, and it is
the same mistake the retired `purpose: software|infra` field made.

This is also exactly the shape DESIGN §12.6 / [ADR-0017](../adr/0017-ownership-refinement.md) §3
describe for **multiple regional Argo CDs serving one prod environment**: a region is a
deploy-target, and its Argo CD is an ordinary per-region binding. Regional multi-cluster is not a
special case of this runbook — it *is* this runbook.

## Verifying a cluster is actually being driven

A binding proves intent, not execution. What proves execution is a wave target that was dispatched
and then observed:

```sql
select t.status, count(*), max(t.attempt) as max_attempt,
       count(t.executor_plugin_id) as with_plugin,
       count(t.last_observed_at) as ever_observed
from change_wave_targets t group by t.status;
```

A target that really ran has `attempt >= 1`, a non-null `executor_plugin_id`, and a non-null
`last_observed_at`. A row sitting at `pending / attempt 0 / null plugin` was **never dispatched** —
that is a coordination-side problem (nothing was triggered), not an executor problem, and chasing
Argo CD for it wastes time. Distinguishing those two is the single most useful diagnostic here.

## Failure mode seen in practice

```
[observe] org <org> instance execution-system:<uuid> failed:
  Error: plugin '<...>' call 'observe' timed out after 10000ms
[plugin-host] instance '<...>' exited unexpectedly (code=null, signal=SIGKILL) — restarting
```

`observe` has a 10s plugin-host call budget; exceeding it kills and restarts the instance. Before
assuming the network, check reachability **from the worker pod** (the plugin host lives there, not
in the api pod, and the two can have different egress policy):

```bash
kubectl -n commanderscp exec deploy/scp-commanderscp-worker -c worker -- node -e '
  const t=Date.now();
  fetch("http://argocd-prod/api/version").then(r=>r.text()).then(b=>console.log(r_status=t,b))
    .catch(e=>console.log("ERR",e.message));'
```

If that returns promptly, the timeout is inside the plugin's own work (for example enumerating a
large application set), not connectivity — and the fix is on the plugin side, not the network's.
