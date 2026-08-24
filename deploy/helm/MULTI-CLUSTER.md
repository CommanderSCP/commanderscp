# Multi-cluster values recipe (M26.3)

This is the chart-side recipe for **one CommanderSCP instance spanning more than one Kubernetes
cluster** — the design this recipe implements is
[`docs/proposals/multi-region-instance-resilience.md`](../../docs/proposals/multi-region-instance-resilience.md)
(read §5 "the design: one instance, many member clusters" and §7.4 "Chart & packaging" for the
full reasoning; this doc only carries the values-level recipe, not the design case for it).

**The one-sentence version, load-bearing (§2 of the proposal): multi-cluster is a property of ONE
instance, never a multiplication of instances.** There is no separate "multi-cluster chart" —
`deploy/helm` is what you install, **once per member cluster**, every time pointed at the **same**
PostgreSQL database. An instance spanning three clusters is still one database, one per-org
journal set, one everything except compute.

## What "member cluster" means here

A **member cluster** is one Kubernetes cluster running some of the instance's `api`/`worker`
compute (proposal §2, GLOSSARY.md's amended `instance` entry). One of them may be designated the
**XO** (proposal §5-I3/§11 D3) — the standby member cluster holding the synchronous Postgres
replica, warm compute, and the pre-provisioned fallback dial entry peers use. The XO is a
_designation_, not a second commander: exactly one Postgres primary exists for the whole instance
at any moment (I1), and every member cluster's release, XO or not, is the _identical_ chart with
the _identical_ database-facing values.

## The contract, checklist form

Apply every line below to **every** member cluster's `helm install`/`helm upgrade`. The chart
enforces what it structurally can (marked **[enforced]**); the rest is an operator discipline no
single release's render can check, because Helm never sees another cluster's values
(marked **[operator discipline — see MULTI-CLUSTER.md]**, this doc).

1. **One shared PostgreSQL.** `postgres.host` is the SAME failover-stable endpoint (a DNS name/
   VIP/GSLB entry your Postgres HA layer keeps pointed at the current primary — proposal §5-I1,
   owner decision D5) on every release. SCP does not fail over Postgres for you; it states the
   requirement (charter principle 1/4).

2. **Identical database credentials — `postgres.existingSecret` REQUIRED.**
   [**enforced** when `multiCluster.enabled: true`, see below] Leaving `postgres.existingSecret`
   unset makes the chart GENERATE a Secret with random `scp_app`/`scp_pgboss` passwords — fine for
   one cluster, actively dangerous for two: a second cluster's install mints its OWN random
   passwords, and its migrations Job (if you also left `migrations.enabled: true` there — see item 4) tries to reset the shared database's live roles to them. This is B9 in the proposal, and it
   was proven against a real cluster: `ALTER ROLE ... WITH PASSWORD` from the second install
   **clobbers** the first cluster's working credentials mid-flight. Create the Secret once, and
   set the identical `postgres.existingSecret` name (and content) on every release.

3. **Identical app secrets — `appSecrets.existingSecret` REQUIRED.**
   [**enforced** when `multiCluster.enabled: true`] Same reasoning, different failure shape:
   `SCP_SECRETS_MASTER_KEY` is the KEK for every row in the secrets vault (plugin/managed-IaC
   credentials — the ROWS replicate with Postgres, the per-cluster chart-generated KEK does not).
   A member cluster promoted to take live traffic with a DIFFERENT key holds every one of those
   rows **permanently undecryptable**, discovered only the first time something tries to use one
   (B3). `SCP_COOKIE_SECRET` mismatched across clusters force-logs-out every user on a failover
   (B4). Create the Secret once, set the identical `appSecrets.existingSecret` name everywhere.

4. **Exactly one member cluster runs the migrations Job.** `migrations.enabled: true` on the ONE
   release that owns migrations (pick one, consistently — the XO is a reasonable default), and
   `migrations.enabled: false` on every other member cluster's release. Two Jobs racing
   `migrate-bin.js` against one Postgres is undefined (Drizzle's tracking table is not a
   cross-release mutex, C5), and — see item 2 — this Job is also the one place that provisions/
   resets the shared role passwords. `migrations.allowPasswordReset` (added M26.1, B9's guard)
   stays `false` on every release; flip it to `true` only for a single, deliberate,
   operator-initiated rotation run, then back to `false`.

5. **mTLS material replicated, with SAN coverage for every dial name.** Whichever of
   `federation.mtls` (client presentation) / `federation.serverMtls` (in-app server verification) /
   `ingress.mtls` (edge verification) you use, the Secret(s) must be replicated — by hand, by an
   external-secrets operator, or by your own GitOps — to every member cluster; they are per-cluster
   k8s Secrets and do **not** ride Postgres replication (B5). The part that is easy to get half
   right: the SERVER certificate must carry **every dial name a peer might use as a SAN** — the
   stable VIP/GSLB name AND every entry in that peer's ordered fallback dial-URL list (proposal
   §5-I3), including whatever label the XO answers under. `scp federation doctor`/`scp doctor`
   check SAN coverage against the configured dial list on the server side; this chart cannot (it
   never sees a peer's dial-URL rows), so treat this line as a manual pre-flight, not a rendered
   guarantee.

6. **NetworkPolicy egress to the shared Postgres endpoint.** `networkPolicy.postgresCidr` is the
   SAME rule you'd set for any external Postgres — it's the DESTINATION CIDR, so it doesn't change
   just because more member clusters dial it. Set it to whatever CIDR reaches `postgres.host` from
   THIS cluster's network; the RFC1918 default already covers the common case of a peered/on-prem
   private endpoint. Accepts a single CIDR string or (M26.3) a **list** of CIDR strings, for a
   topology where the reachable path genuinely differs per network hop (VPC peering ranges, a
   Transit Gateway/VPN's advertised routes). A genuinely public-IP-reachable managed-Postgres
   endpoint still wants a precise `/32`.

7. **The DSN contract stays single-host (owner decision D5).** `postgres.host` is the one stable
   endpoint; the `wait-for-postgres` init container and the server's own role-URL derivations parse
   it with a plain single-host `new URL()`, deliberately, on every release. There is no per-cluster
   Postgres — multi-host DSN parsing is out of scope for this instance shape and is not something
   this chart will grow (a fronting proxy or client-side host iteration, if ever needed, is a
   scoped project of its own, not a chart change).

8. **Retrans spanning member clusters: prefer S3, not a filesystem volume.**
   `federation.relay.volumes` gives the byte-channel drop directories (`SCP_RELAY_OUT_DIR`/
   `IN_DIR`/`BLOB_OUT_DIR`) a chart-settable volume — but an RWX PersistentVolumeClaim essentially
   never spans clusters. If your retrans instance's replicas live in more than one member cluster,
   set `federation.relay.s3.endpoints` (S3-compatible delivery, `delivery-s3.ts` — a self-hosted
   MinIO in the enclave keeps this air-gap-legal) and leave `federation.relay.volumes.type: none`.
   The `pvc` volume type is only for spreading replicas of ONE retrans release across nodes
   _within_ one cluster. See `federation.relay`'s values.yaml comment for the full reasoning, and
   note there is deliberately **no `hostPath` option** at all — this chart's own `helm-verify`
   gate refuses any `hostPath:` volume anywhere in it (the same container-escape-risk reasoning
   that already refuses to mount a Docker socket).

## The self-consistency guard: `multiCluster.enabled`

```yaml
multiCluster:
  enabled: true
```

Set this on every member cluster's release. What it changes: **nothing at runtime.** What it
enforces at render time: this release will not proceed with an empty `postgres.existingSecret` or
`appSecrets.existingSecret` (items 2/3 above) — the two cases that are _always_ wrong once more
than one cluster is involved, because the chart-generated Secrets it would otherwise fall back to
are single-cluster-only by construction. It **cannot** check that the Secret's _content_ is
identical across clusters, or that exactly one release has `migrations.enabled: true`, or that mTLS
material is actually replicated — those are operator disciplines this doc exists to name, not facts
one `helm template` invocation can observe about another cluster's release.

## Worked example — three member clusters, one instance

A commander instance spanning `cluster-a` (primary Postgres + migrations owner), `cluster-b` (the
XO — synchronous standby, warm compute), and `cluster-c` (additional compute only, no special
role). Assume `scp-postgres-creds` and `scp-app-secrets` were each created once (e.g. via an
external-secrets operator syncing from a central vault) and are present, byte-identical, in every
cluster's target namespace; `postgres.example.internal` is the operator's failover-stable DNS name.

```bash
# cluster-a — owns migrations
helm install scp deploy/helm --kube-context cluster-a \
  --set multiCluster.enabled=true \
  --set postgres.host=postgres.example.internal \
  --set postgres.existingSecret=scp-postgres-creds \
  --set appSecrets.existingSecret=scp-app-secrets \
  --set migrations.enabled=true \
  --set federation.serverMtls.enabled=true \
  --set federation.serverMtls.existingSecret=scp-federation-server-mtls \
  --set networkPolicy.postgresCidr=10.20.0.0/16

# cluster-b — the XO: same values, migrations OFF
helm install scp deploy/helm --kube-context cluster-b \
  --set multiCluster.enabled=true \
  --set postgres.host=postgres.example.internal \
  --set postgres.existingSecret=scp-postgres-creds \
  --set appSecrets.existingSecret=scp-app-secrets \
  --set migrations.enabled=false \
  --set federation.serverMtls.enabled=true \
  --set federation.serverMtls.existingSecret=scp-federation-server-mtls \
  --set networkPolicy.postgresCidr=10.30.0.0/16

# cluster-c — additional compute, migrations OFF
helm install scp deploy/helm --kube-context cluster-c \
  --set multiCluster.enabled=true \
  --set postgres.host=postgres.example.internal \
  --set postgres.existingSecret=scp-postgres-creds \
  --set appSecrets.existingSecret=scp-app-secrets \
  --set migrations.enabled=false \
  --set federation.serverMtls.enabled=true \
  --set federation.serverMtls.existingSecret=scp-federation-server-mtls \
  --set networkPolicy.postgresCidr=10.40.0.0/16
```

Note what does **not** change across the three installs: `postgres.host`, `postgres.existingSecret`,
`appSecrets.existingSecret`, and the federation mTLS Secret name/content (the Secret OBJECT must be
replicated to each cluster/namespace out of band — this chart cannot do that for you — but the name
and content stay identical). Only `migrations.enabled` and each cluster's own network-facing values
(`networkPolicy.postgresCidr`) differ.

## Related chart-level hardening this recipe assumes (also M26.3)

- **PodDisruptionBudgets** (`api.pdb`/`worker.pdb`, enabled by default) and **topologySpreadConstraints**
  (`api.topologySpreadConstraints`/`worker.topologySpreadConstraints`, a soft `ScheduleAnyway`
  default safe on a single-node cluster) apply **within** each member cluster's own release — they
  spread replicas across that cluster's nodes/zones, which is a different, narrower guarantee than
  spreading compute across member clusters. Both matter; neither substitutes for the other.
- **Version skew across member clusters (§7.4, now built)**: each release heartbeats its
  `(SCP_CLUSTER_ID, SCP_APP_VERSION)`; the migrations Job refuses a **contract-phase** deploy
  (`migrations.phase: contract`) while any live member cluster still reports an older version. Roll
  every member cluster to the new version, _then_ deploy with `migrations.phase: contract`. `N` and
  `N+1` only. `GET /doctor/instance` surfaces skew as a `member-cluster-version-skew` check.
- **Object storage across member clusters (C3, resolved 2026-08-24)**: there is **no bespoke S3
  object-storage backend** — multi-cluster object storage is served by the already-built S3 delivery
  path (`SCP_DELIVERY_S3_ENDPOINTS` / `federation.relay.s3` / `delivery-s3.ts`). Either point the
  relay/blob drops at S3 delivery targets, **or** use a replicated RWX volume for the object-storage
  PVC. `objectStorage.s3` configures the credentials/endpoint for that delivery path.
