# `tools/vendor-refresh`

Re-vendors one of the Standard Stack's bundled backends (Argo CD, Argo Workflows, Argo Rollouts, Argo
Events, Gitea) at a new upstream tag: fetches the pinned release manifest(s), resolves every tracked
image's digest through the repo's pinned skopeo (`tools/skopeo`, `@scp/cosign`'s `resolveSkopeo()`),
and patches `deploy/helm-bundled/values.yaml`, `deploy/airgap/src/bundle-images.ts` and (where the
image is already listed) `tools/ci-mirror/images.list`. See BUILD_AND_TEST.md's M29.8(a) and
[ADR-0059](../../docs/adr/0059-revendor-bump-strategy-network-split.md) (the `re-vendor` managed-dep
strategy this tool's planner also runs behind, in-process, from `packages/plugins/managed-dep`).

It needs the internet to run for real — that is fine for a maintenance tool. Its own tests never touch
the network: a local HTTP server stands in for GitHub, a local fixture Helm chart stands in for
`gitea-charts/gitea` (rendered with the real `helm` binary — a local chart needs no network), and
skopeo is injected.

## Usage

```bash
pnpm --filter @scp/vendor-refresh refresh <backend> <tag>
```

- `<backend>`: `argocd | argo-workflows | argo-rollouts | argo-events | gitea`
- `<tag>`: the upstream release tag for the four argoproj-family backends (e.g. `v3.5.0`). For gitea
  it is the Helm CHART version (e.g. `12.7.0`) — the APP version and image tag are read back out of
  what the chart itself renders, never asked for separately.

Prints a summary and writes every file the plan describes; review with `git diff`. This tool never
commits, pushes, or opens a pull request itself — see ADR-0059 for how the `re-vendor` managed-dep
strategy does that in-process, from the server.

## Where each backend's manifest actually lives — measured, not assumed

Argoproj's four projects do **not** all publish the same way, and assuming otherwise silently
vendors the wrong bytes:

| Backend        | Source                                                                                | Why                                                                                                                                                                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Argo CD        | `raw.githubusercontent.com/argoproj/argo-cd/<tag>/manifests/install.yaml`             | the source tree at the tag already carries the release's own pinned image tag                                                                                                                                                                               |
| Argo Events    | same shape, `argoproj/argo-events`                                                    | same reason                                                                                                                                                                                                                                                 |
| Argo Workflows | `github.com/<repo>/releases/download/<tag>/install.yaml` (a GitHub Release **asset**) | there is no `manifests/install.yaml` in the source tree at all (404) — only `manifests/quick-start-*.yaml` and per-component kustomize bases                                                                                                                |
| Argo Rollouts  | same Release-asset shape                                                              | the source tree's `manifests/install.yaml` **exists** but still says `image: quay.io/argoproj/argo-rollouts:latest` — a build-time substitution that happens only when the release is cut. Confidently wrong, not obviously broken: it fetches successfully |

Both halves were confirmed byte-for-byte against the files already vendored in this repo (and, for
Argo CD, against the sha256 the original 2026-07-12 vendoring commit recorded) by running this tool's
planner against the real network at the currently-pinned tags — see `argoproj-backends.ts`'s own
`ArgoprojUrlKind` doc comment and `argoproj-backends.test.ts` for the regression test that pins the
per-backend choice.

## Gitea

Rendered from the upstream Helm chart `gitea-charts/gitea` in the SQLite / single-replica /
no-external-DB / no-valkey minimal profile (see `gitea-backend.ts`'s exact `--set` flags — the same
ones `deploy/helm-bundled/vendor/gitea/install-no-secrets.yaml`'s own header documents). Every
`kind: Secret` document and the helm-test connection Pod are stripped; the four scripts SCP's own
`templates/gitea-secrets.yaml` re-injects (`config_environment.sh`, `configure_gpg_environment.sh`,
`init_directory_structure.sh`, `configure_gitea.sh`) are extracted verbatim from the two Secrets the
vendored Deployment's own volumes name (`scp-gitea`, `scp-gitea-init` — fixed names, not invented:
they come from the chart's naming convention applied to the release name `scp-gitea`). If a future
chart version renames either Secret or drops one of the four keys, this tool throws rather than
silently vendoring nothing — see `gitea-plan.ts`'s extraction checks.

## Images this tool reads but does not bump

Each re-vendor bumps only the images whose tag **is** the backend's `toTag`. That is the sandbox's
fail-closed property (`sandbox-io.ts`): the orchestrator resolves and cosign-verifies digests only
for `coordinate:toTag`. The images below have their own versions, so they are named here instead of
bumped:

- **`ghcr.io/dexidp/dex`** (Argo CD's `dex-server`). Since M29.2 the chart retargets it
  (`bundledExecutor.argocd.dexImage`, with `vendoredDexImage` as the retarget source) and the air-gap
  bundle carries it (`bundle-images.ts` `argocd-dex`). The plan summary still lists it as "NOT
  tracked", because its tag is Dex's own and not Argo CD's. If a re-vendor changes it,
  `templates/argocd.yaml` **fails the render**: `vendoredDexImage` is then absent from the new
  manifest, so the retarget cannot be skipped silently. Bump `vendoredDexImage`, `dexImage` and the
  `argocd-dex` `defaultRef` by hand to the tag in that failure.
- **`public.ecr.aws/docker/library/redis`**, which the chart retargets to
  `bundledExecutor.argocd.valkeyImage`. This deviation is owned by SCP and never tracks upstream's
  version.
- **`quay.io/argoproj/argoexec`**, the executor every Argo Workflows pod runs
  (`bundledExecutor.argoWorkflows.executorImage`, `bundle-images.ts` `argo-workflows-exec`, since
  M29.2). Upstream's `install.yaml` never names it, so this reader cannot see it. Bump it by hand to
  the same tag as the Argo Workflows re-vendor.

## Determinism

Running the planner twice against the same tag and the same fixtures produces byte-identical output
— see the `is deterministic` test in each of `split.test.ts`, `argoproj-plan.test.ts`,
`gitea-plan.test.ts` and `plan.test.ts`.
