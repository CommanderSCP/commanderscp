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

**The RPM build catalog template (`scp-build-rpm-v1`, ADR-0053) needs one flag on a connected
install.** Its builder, `scp-builder-rpm`, is first-party, so the chart has no upstream ref to default
to and does not render the template until you name the image. Run the `publish-images` workflow
(it pushes `ghcr.io/commanderscp/scp-builder-rpm:sha-<commit>` and prints the digest), then:

```bash
scripts/scp-bundled.sh enable argo-workflows \
  --set bundledExecutor.argoWorkflows.catalog.buildRpm.builderImage=ghcr.io/commanderscp/scp-builder-rpm:sha-<commit>@sha256:<digest>
```

`scp-build-image-v1` needs nothing: its images are upstream. The air-gap `install.sh` sets both.

**The infrastructure templates (`scp-infra-plan-v1` / `scp-infra-apply-v1`, ADR-0056) render only
once you name a state backend** — that is the switch, because they must never run with nowhere real
to keep state. The backend is yours (a deployment-level setting, never tenant data SCP holds); each
deployment-target gets its own workspace in it, and a repository carrying its own override file,
`backend` or `cloud` block is refused. Credentials go in TWO Secrets in the Argo namespace, one per
phase (every key becomes an env var; SCP never reads either): `scp-infra-plan-credentials` —
**read-only** for the cloud, because a plan runs the repository's own code before anyone approves
it — and `scp-infra-apply-credentials`, which only an approved apply reaches. **You do not create
them** (M29.5, ADR-0062): enter each key through SCP — `scp stack credential set argo-workflows
scp-infra-plan-credentials AWS_ACCESS_KEY_ID` (the value from a hidden prompt, stdin or
`--from-file`), or Admin › Stack › Credentials — and the stack controller writes it there; SCP keeps
no copy. The keys are a fixed set (`scp stack credential list`). The same goes for the build
templates' `scp-build-registry` (`registryUsername`, `registryPassword`, `registryHost`,
`gitToken`). Each phase also runs as its own ServiceAccount (`scp-infra-plan` / `scp-infra-apply`),
and **workload identity is preferred**: `scp stack workload-identity set argo-workflows
scp-infra-plan --provider aws-irsa --identifier arn:aws:iam::…:role/…` (or `gke-workload-identity`,
`azure-workload-identity`) makes the controller annotate the ServiceAccount, and nothing needs
entering.

```bash
scripts/scp-bundled.sh enable argo-workflows \
  --set bundledExecutor.argoWorkflows.catalog.infra.image=ghcr.io/commanderscp/scp-runner-iac:sha-<commit>@sha256:<digest> \
  --set bundledExecutor.argoWorkflows.catalog.infra.stateBackend.type=s3 \
  --set bundledExecutor.argoWorkflows.catalog.infra.stateBackend.config.bucket=acme-tofu-state \
  --set bundledExecutor.argoWorkflows.catalog.infra.stateBackend.config.region=us-east-1
```

The air-gap `install.sh` sets the image (it is `scp-runner-iac`, already in the bundle); the backend
is always yours to name. Then give a deployment-target `properties.environment` and
`properties.infrastructureRepo` (the one repo its infrastructure comes from), bind its
`infrastructure` pipeline to `scp-infra-plan-v1` THROUGH AN EXECUTION SYSTEM (an inline binding is
refused), allow that repo on the system with
`scp execution-system source-allowlist set <system> --repo <owner/name>` (needs `secret:write` at the
org root — the target's editor cannot), propose a plan pinned to a commit of that repo,
have someone OTHER than its proposer accept it, and apply it with
`scp change propose --apply-plan <plan change id>`.

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

Only the _slim_ integration the SCP pods themselves need: the Argo CD auto-wire hook Job and the
`allow-argocd` NetworkPolicy egress rule, gated on
`bundledExecutor.argocd.{enabled,namespace}`. The heavy vendored manifests live here.
