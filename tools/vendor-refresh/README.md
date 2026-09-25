# `tools/vendor-refresh`

Re-vendors one of the Standard Stack's bundled backends (Argo CD, Argo Workflows, Argo Rollouts, Argo
Events, Gitea) at a new upstream tag: fetches the pinned release manifest(s), resolves every tracked
image's digest through the repo's pinned skopeo (`tools/skopeo`, `@scp/cosign`'s `resolveSkopeo()`),
and patches `deploy/helm-bundled/values.yaml`, `deploy/airgap/src/bundle-images.ts` and (where the
image is already listed) `tools/ci-mirror/images.list`. See BUILD_AND_TEST.md's M29.8(a) and
[ADR-0058](../../docs/adr/0058-revendor-bump-strategy-network-split.md) (the `re-vendor` managed-dep
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
commits, pushes, or opens a pull request itself — see ADR-0058 for how the `re-vendor` managed-dep
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

## A known, named gap this tool does NOT close

Argo CD's vendored manifest also declares `ghcr.io/dexidp/dex:v2.45.0` (a Deployment named
`dex-server`) and `public.ecr.aws/docker/library/redis:8.2.3-alpine` (retargeted to
`bundledExecutor.argocd.valkeyImage`, an OWNED deviation — never upstream's own version). Dex is
genuinely **not** tracked anywhere: not in `values.yaml`, not in `bundle-images.ts`, not retargeted by
`deploy/helm-bundled/templates/argocd.yaml`. A connected install pulls it straight from `ghcr.io` at
apply time; an air-gapped install has no bundled copy of it at all. This tool's reader (via
`@scp/dependency-manifests`'s `parseKubernetesImages`) surfaces it in every re-vendor plan's summary
as "NOT tracked by SCP" precisely so this stays visible rather than silently re-discovered — closing
it (vendor+pin dex, or disable it in the chart, since SCP never uses Argo CD's SSO login UI) is a
separate, small piece of work this tool does not attempt.

## Determinism

Running the planner twice against the same tag and the same fixtures produces byte-identical output
— see the `is deterministic` test in each of `split.test.ts`, `argoproj-plan.test.ts`,
`gitea-plan.test.ts` and `plan.test.ts`.
