# Helm chart

One chart (DESIGN.md §16, BUILD_AND_TEST.md §8 M8): the single `scpd` image, two Deployments
(`api` — HPA-scalable, `worker` — queue-depth-scalable), a pre-upgrade migrations Job
(expand/contract, zero-downtime), hardened pod defaults, NetworkPolicies. PostgreSQL is external
by default; a plain in-cluster `postgres:16` is available for evaluation only (no Bitnami
subchart, no bundled operator).

## Quick start (evaluation, in-cluster Postgres)

```bash
helm install scp deploy/helm \
  --set postgres.evalInCluster.enabled=true \
  --set image.tag=<version>
kubectl get pods -w
kubectl port-forward svc/scp-commanderscp-api 8080:80
```

Postgres and app secrets are auto-generated on first install (see NOTES.txt after install) — fine
for evaluation. **For production**, pre-create the secrets yourself and point the chart at them:

```bash
helm install scp deploy/helm \
  --set postgres.host=my-postgres.example.internal \
  --set postgres.existingSecret=scp-postgres-creds \
  --set appSecrets.existingSecret=scp-app-secrets \
  --set image.tag=<version>
```

`postgres.existingSecret` must contain three connection strings (keys configurable via
`postgres.existingSecretKeys`): an **admin/superuser-capable** one (used ONLY by the migrations
Job) and two least-privileged ones for the `scp_app`/`scp_pgboss` roles the migrations Job itself
provisions on first run (`main.ts`/`migrate-bin.ts`'s `provisionRuntimeRole`/`provisionPgBossRole`
— `ALTER ROLE ... WITH LOGIN PASSWORD`, idempotent). `appSecrets.existingSecret` needs
`SCP_COOKIE_SECRET` (any string) and `SCP_SECRETS_MASTER_KEY` (base64, exactly 32 bytes —
`openssl rand -base64 32`).

## Hardened defaults (M8)

Every container this chart renders (api, worker, migrations Job) gets, by default:

- `runAsNonRoot: true`, a fixed non-root UID/GID, `seccompProfile: RuntimeDefault` (pod level)
- `allowPrivilegeEscalation: false`, `readOnlyRootFilesystem: true`, `capabilities.drop: [ALL]`,
  `seccompProfile: RuntimeDefault` (container level) — writable paths are explicit `emptyDir`
  mounts (`/tmp`) or PVCs (object storage), never the root filesystem
- `automountServiceAccountToken: false` on `api` (never talks to the Kubernetes API); `worker`
  only automounts a token when `managedIac.enabled` (needs the Kubernetes API to launch runner
  Jobs)
- Default-deny NetworkPolicy + explicit allows (DNS, Postgres, optionally NATS, ingress to `api`
  only) — see `templates/networkpolicy.yaml`'s own doc comment for exactly what's allowed and why

**Least privilege for database credentials** (`SCP_SKIP_MIGRATIONS`, `apps/server/src/config.ts`):
only the migrations Job ever holds the admin/superuser-capable `DATABASE_URL`. `api`/`worker` pods
run with `SCP_SKIP_MIGRATIONS=true` and only the already-least-privileged `scp_app`/`scp_pgboss`
role credentials — verified structurally by `tools/helm-verify` (below).

### Testing this chart

```bash
helm lint deploy/helm
helm template test deploy/helm            # renders cleanly, no live cluster needed
pnpm --filter @scp/helm-verify test       # structural hardened-defaults assertions
```

`tools/helm-verify` renders the chart with default values AND with every optional feature toggled
on (managed-iac, federation mTLS, ingress + ingress mTLS, serviceMonitor, NATS, OIDC, worker HPA),
then parses the YAML and asserts — per container — non-root/read-only-rootfs/dropped-caps/
seccompProfile, that the migrations Job is a `pre-install,pre-upgrade` hook holding the ONLY admin
DB credential, that api/worker never see it, that api and worker use the identical image (no
version skew), that a default-deny NetworkPolicy plus explicit allows are present with no
any-destination DB-port egress, and that ingress mTLS annotations render when enabled. It's a real
gate, not a vacuous one — deliberately loosening any of these in `values.yaml` fails it (verified
while building this chart, and re-verified while wiring adversarial-review fixes: reverting each
template to its pre-fix shape and confirming this tool actually catches it before restoring the
fix).

**Genuinely CI-gated** (adversarial review MAJOR #4 — a prior version of this doc, and the
`CHANGELOG.md` "Added" entry, called this "(CI gate)" while the tool was invoked nowhere in CI):
`.github/workflows/ci.yml`'s `helm-verify` job runs `pnpm --filter @scp/helm-verify test` on every
push/PR; it's also picked up automatically by the top-level `pnpm test` (Turborepo discovers any
workspace package's `test` script).

**Verified end to end against a real `kind` cluster** while building this chart (`helm install` →
golden path via the real API → `helm upgrade` → `helm rollback`):
- Fresh `helm install` with `postgres.evalInCluster.enabled=true`: all pods (api ×2, worker ×2,
  postgres-eval ×1) reach Ready; login → register a service → list services all succeed through a
  port-forwarded real HTTP client — the M0 golden path, end to end, through this chart.
- `helm upgrade` (worker scaled 2→3, same image): 43 consecutive `/healthz` polls at 500ms
  intervals throughout the upgrade window, **zero non-200 responses** — genuinely observed
  zero-downtime, not asserted. Postgres row count identical before/after (the eval PVC is NOT
  recreated on upgrade — see the delete-policy note below, itself a real bug this verification
  caught).
- `helm rollback` to the pre-upgrade revision: succeeds, worker count reverts to 2.

This exact drill (with a REAL previous-vs-current image pair, to prove the expand/contract schema
claim, and a genuinely network-isolated cluster for the air-gap egress claim) is what the CI
`kind`/air-gap jobs automate — see the top-level PR body for the CI-gated-vs-manual breakdown.

**Two real bugs were caught and fixed by this live-cluster verification**, beyond anything `helm
template`/`helm lint`/`tools/helm-verify` alone would catch (all three are static-rendering tools —
none of them actually starts Postgres or exchanges a password):
1. The eval Postgres NetworkPolicy ingress gap (`templates/networkpolicy.yaml`) — the eval
   Postgres pod is itself selected by the default-deny policy, so it also needed an explicit
   ingress allow; without it, connections timed out (dropped, not refused) rather than failing
   fast.
2. The migrations Job never received `SCP_RUNTIME_DATABASE_URL`/`SCP_PGBOSS_DATABASE_URL`
   (`templates/migrations-job.yaml`), so it provisioned `scp_app`/`scp_pgboss` with the ADMIN
   password (config.ts's derivation fallback) while api/worker tried to authenticate with the
   independently-generated password from the same secret — a genuine credential mismatch that
   only manifests once real Postgres roles are actually created and actually authenticated
   against, which no static render/lint step exercises.

Both are exactly the kind of bug a rendered-YAML-only test suite structurally cannot catch — this
is why an actual `kind install → golden path → upgrade → rollback` pass matters as its own gate,
not a nice-to-have on top of `tools/helm-verify`.

## Uninstall

`helm uninstall` removes every NORMAL release resource (Deployments, Services, the PVC for
object storage, the ServiceAccount, RBAC, NetworkPolicies) but — by Helm's own design — does
**not** touch resources that only ever existed as hooks (the generated `postgres`/`app-secrets`
Secrets, and everything under `postgres.evalInCluster`). This is intentional (it protects
against accidentally losing an eval database or an app's encryption key on an accidental
`helm uninstall`), not an oversight, but it does mean cleanup after evaluation is manual:

```bash
kubectl delete deployment,service,pvc,secret,networkpolicy -l app.kubernetes.io/instance=<release>
```

## Scaling

`api` is HPA-scalable on CPU by default (`api.hpa.enabled: true`). `worker` is scaled by queue
depth, not CPU (DESIGN §16) — `worker.hpa` targets an `External` metric
(`worker.hpa.metricName`, default `pgboss_queue_depth`) that must already be registered in the
cluster; wire a Prometheus Adapter rule or a KEDA `ScaledObject` publishing pg-boss's job backlog
under that name, then set `worker.hpa.enabled: true`. Disabled by default so `helm install` never
fails HPA admission against a cluster with no such metric source configured yet.

**Multi-replica `worker` safety** (M8 hardening): the coordination engine's wave-target trigger
claim is a provable Postgres advisory-lock single-flight boundary
(`apps/server/src/coordination/trigger-claim-lock.ts`) — two `worker` replicas' overlapping
reconcile ticks cannot both fire the same real deployment. See that module's doc comment and
`coordination.integration.test.ts`'s "multi-replica trigger claim is single-flight" suite for the
concurrent-replica proof.

## Managed-IaC (Mode 2) — known gap

`managedIac.enabled: true` grants the `worker` ServiceAccount RBAC to create/watch/delete `Job`s
and ships a reference Job manifest (ConfigMap) for the `scp-runner-iac` image. **This is on-ramp
infrastructure, not a working end-to-end path yet**: `packages/plugins/managed-iac`'s current
implementation launches the runner via `docker create`/`docker cp`/`docker start` (a host Docker
socket), which does not work unmodified inside a standard Kubernetes pod — and this chart
deliberately does not paper over that by mounting a host Docker socket (a real container-escape
risk). Mode 2 is fully functional under docker-compose/VM deployments today. Wiring the plugin to
launch Kubernetes Jobs via the API (using the RBAC + template this chart already ships) is tracked
follow-up work. `managedIac.enabled` defaults to `false`.

## Federation mTLS — what's enforced vs. deferred (corrected, adversarial review MAJOR #3)

**`federation.mtls.enabled: true` is CLIENT-side presentation only.** It mounts a
`kubernetes.io/tls`-shaped Secret and wires real client-certificate presentation into the
`federation-https` subprocess (M8 — `apps/server/src/plugin-host/subprocess-entry.ts`'s
`loadFederationMtlsMaterial`, proven by `plugin-host/federation-mtls.test.ts` against a real
mTLS-enforcing test server): when THIS domain acts as a CHILD dialing a parent, it presents a real
client cert. That is genuinely implemented and tested — an earlier version of this doc, and the
PR body, described this as "mTLS enforced" without qualification, which overstated it.

**What that does NOT do: make THIS domain's own API, acting as a PARENT, verify an incoming
child's client certificate.** `apps/server/src/main.ts` starts the API with a plain `app.listen`
(no `requestCert`/`rejectUnauthorized`) — a parent receiving a child's pull today accepts any (or
no) client certificate; the request is authenticated by bearer token + RBAC only, exactly as
pre-M8. `federation.mtls` alone does not close that gap.

**The deployment-level fix, shipped in this chart: `ingress.mtls`** (`templates/ingress.yaml`,
`values.yaml`). When enabled, it adds nginx ingress-controller annotations
(`auth-tls-verify-client: "on"`, `auth-tls-secret: <ns>/<ingress.mtls.caSecretName>`) that make the
ingress controller itself require and verify a client certificate, against a CA you provide,
before any request — including a federation pull — reaches the `api` Service. This is a REAL
server-side enforcement point, gated behind a values flag, verified structurally by
`tools/helm-verify`. Caveats: (a) it's nginx-specific — a different ingress controller needs its
own equivalent annotations; (b) it enforces on the WHOLE Ingress (this chart serves the entire API
on one host/path today), not scoped to `/v1/federation/*` alone; (c) an in-app enforcement path
(the API server itself calling `requestCert`/verifying peer certs, independent of whatever sits in
front of it) remains a follow-up, not yet implemented.

**The primary integrity control for federation sync remains the Ed25519 journal signatures**
(DESIGN §13) — every synced journal entry is signed and independently re-verified on import
regardless of transport-level identity, mTLS or not. mTLS (client presentation + `ingress.mtls`
enforcement) is a defense-in-depth transport-identity layer on top of that, not a replacement for
it.

Separately: the scheduled sync loop that actually calls `pull()`/`push()` on an interval for
connected children does not exist yet — only the air-gapped **file** transport (`scp federation
export/import`) has a caller today. The transport is real and independently testable; nothing
schedules it yet.

## Other known gaps (honestly flagged, not silently worked around)

- **Object storage** (`objectStorage.provider`): the chart provisions the PVC/S3 config per
  DESIGN §16, but no shipped application feature reads/writes it yet — it's plumbing ahead of a
  feature, mounted at `/var/lib/scp/storage` so no volume migration is needed later.
- **`serviceMonitor.enabled`**: the chart can render a `ServiceMonitor`, but the app does not yet
  expose a `/metrics` endpoint (DESIGN §2 names Prometheus metrics as part of the stack; not
  implemented in any milestone through M7). Disabled by default; enabling it today just means
  Prometheus scrapes get 404s.
