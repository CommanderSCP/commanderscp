# CommanderSCP Standard Stack — bundled executor backends

The optional, opt-in **bundled executor backends** (Mode B, [ADR-0002](../../docs/adr/0002-execution-strategy.md)):
Argo CD + Valkey, Argo Workflows, and Argo Events. Each is vendored **unmodified** from
upstream and rendered here with only image-retarget + namespace substitutions.

The bundled OCI registry is Gitea ([ADR-0012](../../docs/adr/0012-registry-consolidation.md)); Harbor
is **removed** from the default stack — an existing Harbor is served via the **import** path
(coordinated as an execution system), not bundled here.

## Why this is a separate chart (not part of `deploy/helm`)

Helm stores the **entire chart** (every file) in its release Secret, and Kubernetes caps a Secret at
**1 MB**. The vendored manifests are far larger than that (Argo Workflows alone is 11 MB), so packaging
them into the main `commanderscp` release makes `helm install` fail outright:

```
Secret "sh.helm.release.v1.scp.v1" is invalid: data: Too long: may not be more than 1048576 bytes
```

So these backends are delivered the way upstream intends — rendered and `kubectl apply`d — **never**
stored in a Helm release. The main chart stays tiny (~40 KB) and installs normally.

## Enable a backend — one command

```bash
# Connected: zero image flags needed (the chart defaults to the upstream refs)
scripts/scp-bundled.sh enable argocd
scripts/scp-bundled.sh enable argo-workflows
scripts/scp-bundled.sh enable argo-events
```

`scp-bundled.sh enable <backend>` renders this chart for that backend, applies it with
`kubectl apply --server-side` (required — the large CRDs overflow client-side apply's annotation),
waits for readiness, and — for Argo CD — flips the matching flag on the SCP release so its
**auto-wire hook** (mints the scoped Argo CD token, zero token plumbing) and **NetworkPolicy egress**
turn on. Pass `--scp-release <name> --scp-namespace <ns>` if your SCP release isn't `scp`/`default`.

**Air-gap:** you don't run this directly — the signed bundle's `install.sh` calls it for every backend
the bundle carries, passing the retargeted, digest-pinned images via `--set`. One `./install.sh` and
the enabled backends come up.

**GitOps / ArgoCD-managed SCP:** render and commit, or point a second Application at this chart:
`helm template scp-bundled deploy/helm-bundled --set bundledExecutor.argocd.enabled=true | kubectl apply --server-side -f -`,
and set `bundledExecutor.argocd.enabled: true` in the values your GitOps tool renders for the SCP chart.

## Inspect without applying

```bash
scripts/scp-bundled.sh render argocd        # print the manifest to stdout, apply nothing
```

## What stays in the main `commanderscp` chart

Only the *slim* integration the SCP pods themselves need: the Argo CD auto-wire hook Job and the
`allow-argocd` NetworkPolicy egress rule, gated on
`bundledExecutor.argocd.{enabled,namespace}`. The heavy vendored manifests live here.
