# ADR-0058: The `re-vendor` bump strategy computes entirely in the orchestrator; the isolated runner is never launched for it

**Status:** Accepted (2026-09-25, M29.8a) — the network/containment split below and the charter-language reading in "A charter-language interpretation" are this increment's calls, and the owner is invited to overrule either
**Relates to:** ADR-0032 §8 (`scp-managed-dep`'s standard executor interface); PROJECT_CHARTER.md's `scp-managed-dep` amendment and its 2026-08-15 qualification (the orchestrator/runner network split this ADR extends); `tools/vendor-refresh` (the planner this strategy calls); `docs/proposals/zero-to-running.md` §9.1 step 1

## Context

Proposal §9.1 step 1 (`docs/proposals/zero-to-running.md`) and BUILD_AND_TEST.md's M29.8(a) call for
a **re-vendor bump strategy** on top of the existing `scp-managed-dep` actuator (ADR-0032 §8,
`packages/plugins/managed-dep`): a component whose dependency is a vendored upstream install (Argo
CD, Argo Workflows, Argo Rollouts, Argo Events, Gitea) bumps by running `tools/vendor-refresh` at the
new tag — fetching the upstream manifest(s), pinning every image by digest through the repo's pinned
skopeo, and rewriting `deploy/helm-bundled/values.yaml`, `deploy/airgap/src/bundle-images.ts` and
(where applicable) `tools/ci-mirror/images.list` — rather than the existing strategy's single-line
tag-string edit.

That computation needs the internet: a GitHub fetch (raw source tree for Argo CD/Argo Events, a
GitHub Release asset for Argo Workflows/Argo Rollouts — see `tools/vendor-refresh`'s own README for
why the two differ), a `helm repo` fetch of `gitea-charts/gitea` for Gitea, and a `skopeo inspect`
against the image registry to resolve each tracked image's digest.

`scp-managed-dep`'s charter clause is explicit and unqualified about where network reach may live:

> Runner network egress is `--network none`; the runner holds no credential, contains no package
> manager, and edits only the bytes handed to it. The orchestrator holds the per-run,
> repository-scoped, short-lived credential and reaches the git provider on the runner's behalf,
> mirroring the split already shipped for managed scanning, where the commander pulls the subject
> artifact's bytes and the runner has no network.
> — PROJECT_CHARTER.md, `scp-managed-dep` amendment, 2026-08-15 qualification

So the runner (`apps/runner-dep`, the `scp-runner-dep` image) categorically may not reach a network,
and this is enforced as a property of the image itself (`FROM scratch`, one static BusyBox binary,
seven applets — see `apps/runner-dep/README.md`), not merely asserted. A re-vendor strategy that
launched that runner and expected it to fetch upstream bytes would either violate the clause or
require weakening it. The M29.8a kickoff explicitly named this tension and asked for either a
charter-consistent design or a stop-and-report.

## Decision

**The `re-vendor` strategy never launches `scp-runner-dep`.** All of its work — the network fetch,
the skopeo digest resolution, and the `helm template` render — happens in the ORCHESTRATOR
(`packages/plugins/managed-dep`'s `triggerRevendor`, running inside `scpd`/the worker, on the
commander only, exactly where every other dependency-automation job already runs per ADR-0032 §7d).
This is not a new exception to the charter clause above — it is the SAME split the clause already
states, extended to a second class of orchestrator-side work:

- The clause already says the credential and the host reach belong to the orchestrator. Today that
  reach is "the git provider" (minting a scoped installation token and calling the GitHub API). This
  strategy asks the SAME already-authorized orchestrator to also reach two more classes of host it
  was never barred from: the upstream release host (a public, unauthenticated GET) and an OCI
  registry through the repo's own pinned skopeo (`@scp/cosign`'s `resolveSkopeo()` — the identical
  mechanism `apps/server/src/dependencies/version-index.ts` and
  `packages/plugins/dependency-index-oci` already use server-side, today, for the unrelated M21.4
  third-party version index). No new capability is granted; two more specific, named, read-only,
  unauthenticated hosts are reached by code that already reaches a host.
- The runner's `--network none` clause is therefore untouched. It stays exactly as unqualified as the
  charter states it, because this strategy simply never invokes it. `RUNNER_NETWORK_MODE` and
  `runEditorContainer` are unchanged; `triggerRevendor` calls neither.
- What the runner's isolation actually buys on the tag-edit path — sandboxing the ONE untrusted step,
  applying a caller-supplied edit to caller-supplied bytes — has no analogue here. There is no
  untrusted party on the re-vendor path: the content is entirely composed by this repo's own,
  reviewed, versioned `tools/vendor-refresh` code, fetching from a fixed, hardcoded, non-tenant-
  writable set of URLs per backend (never influenced by tenant/org input — `backend` and `tag` are
  both drawn from an enum-like set the descriptor validates, and there is exactly one component in
  exactly one org, the CommanderSCP repo's own component, that can ever have this strategy attached).
  Launching an isolated container to "sandbox" a step with no untrusted input would add process
  overhead and a second failure mode without adding a containment property.
- What DOES need a boundary is scope: "this bump may touch only the files this backend's re-vendor is
  known to write." The single-file path gets that from `assertDeclaredManifest` + the HMAC-bound
  `ManifestEditProof`; the multi-file path gets the analogous half (path containment) from a new,
  smaller check — every file `planVendorRefresh` proposes must be a member of `declaredManifestPaths`
  the descriptor carries, checked in `publishVendorRefresh` before any blob is created — and does NOT
  get the proof half, because the proof exists to authorise bytes an UNTRUSTED runner produced, and
  there are none here to authorise.

Concretely, `packages/plugins/managed-dep/src/index.ts` gains a third `ManagedDepAction`,
`"re-vendor"`, parsed by `parseRevendorDescriptor` (repo/branch/path safety exactly as the bump
descriptor's, plus `backend` validated against `@scp/vendor-refresh`'s `BACKEND_NAMES` and
`fromTag`/`toTag` validated as control-character-free non-empty strings). `triggerRevendor`:

1. calls `planVendorRefresh(backend, toTag, vendorRefreshIO, readRepoFile, …)` — the SAME pure planner
   `tools/vendor-refresh`'s CLI uses for a human-run maintenance bump, imported as `@scp/vendor-refresh`
   — where `vendorRefreshIO` is the real, network-reaching `realVendorRefreshIO` in production and an
   injectable seam in tests (the same "resolver injected, default is the real one" shape
   `resolveRunnerLauncher` already establishes for the container launcher), and `readRepoFile` reads
   `values.yaml` / `bundle-images.ts` / `images.list` from the TARGET REPOSITORY at the base branch
   through `session.readFile`, not off local disk — this orchestrator is bumping CommanderSCP's own
   repository over the GitHub API, the same way it authors every other bump;
2. asserts every path the plan proposes is in `declaredManifestPaths`;
3. calls `session.publishVendorRefresh` (new `RepoSession` method, `repo-write.ts`) — one commit via
   the Git Data API (blob per file, one tree layered on the base branch's own tree via `base_tree`,
   one commit, one ref update), then the same pull-request-open/auto-merge sequence `publishBump`
   already uses.

`scp-runner-dep` and `RUNNER_NETWORK_MODE` are reachable from precisely nothing on this path.

### A charter-language interpretation this ADR makes explicit, for the owner to confirm

The charter defines `scp-managed-dep`'s class as "editing the declared version of an already-declared
dependency in **a manifest** the component already contains" (singular). A re-vendor bump edits
SEVERAL files that, together, declare one upstream backend's pinned version (the vendored
manifest(s), plus the tag-only defaults in `values.yaml` and `bundle-images.ts`, plus — sometimes —
the digest pin in `images.list`). This ADR reads "a manifest" as "the manifest SET a vendored backend
declares its version across," not literally one file, on the grounds that every other charter
invariant for the class still holds file-by-file: no lockfile is resolved, no package manager runs,
nothing is built or tested, and every file touched is one the component's own declared dependency
already names (`declaredManifestPaths`). If the owner reads "a manifest" more literally, the
fallback is to keep today's single-file semantics and require a SEPARATE bump change per file — which
would produce up to four uncoordinated pull requests for one version bump of one backend (the
vendored manifest, `values.yaml`, `bundle-images.ts`, `images.list`), each individually
uninstallable, which is a materially worse outcome for the exact "keep taking updates often" goal
§9.1 exists to serve. This ADR's recommendation is the reading it implements; flagged here rather
than assumed silently.

## Alternatives considered

1. **Give the runner a registry-pull exception, mirroring `scp-managed-scan`'s qualified clause.**
   Rejected: `scp-managed-scan`'s 2026-07-23 amendment is itself qualified ONLY for pulling the
   SUBJECT ARTIFACT's bytes by digest — a narrow, read-only, single-purpose exception the owner
   granted for that class specifically. `scp-managed-dep`'s own 2026-08-15 qualification EXISTS and
   reads the opposite way: it explicitly keeps the runner's clause unqualified and puts ALL host reach
   in the orchestrator instead. Re-opening that qualification for a different class would contradict a
   decision the owner already made about this exact tension.
2. **Extend the runner to fetch upstream itself, with the fetch URLs allowlisted at build time.** This
   would need a Node/HTTP-capable image, a way to hand a signed URL set from the orchestrator to a
   `--network none` container being asked to reach one anyway (contradictory), and helm + skopeo
   inside `scp-runner-dep` — reintroducing the exact "toolchain nobody wants in the class that has
   none" cost `apps/runner-dep/README.md`'s "why this runner installs nothing at build time" argues
   against for its siblings. Rejected on the same grounds that keep managed-scan's toolchain server-
   side and read-only for the class that needs it.
3. **Keep the single-file `applyManifestBump` shim and run it four times, once per touched file.**
   Rejected above as the fallback if "a manifest" is read literally; recorded here because it was the
   first design considered and is a real, working alternative if the owner prefers strict adherence to
   the singular reading.

## Consequences

- `scp-runner-dep`'s containment properties (network none, no package manager, edits only bytes
  handed to it) are unchanged and unexercised by this strategy — a genuinely separate code path that
  happens to share the plugin's dispatcher and its repository-write credential machinery.
- The orchestrator's egress footprint gains exactly two more classes of host: GitHub's raw-content and
  release-asset hosts (already reached for the OTHER four ecosystems' version-index checks, M21.4),
  and whatever OCI registries the pinned skopeo already reaches for the same reason. No new allowlist
  mechanism is introduced.
- A future SIXTH bundled backend that is NOT vendored from a plain `install.yaml` or a Helm chart
  (e.g., a Kustomize overlay, or a multi-chart umbrella) needs its own `tools/vendor-refresh` backend
  spec and, if its recipe differs enough, its own review of this ADR's reasoning — this ADR is not a
  blanket "the orchestrator may run arbitrary fetch logic" grant, it is scoped to the five backends
  `tools/vendor-refresh` names today.
- `packages/plugins/managed-dep` gains a dependency on `@scp/vendor-refresh` (a `tools/*` workspace
  package now importable like any other, matching the precedent of `tools/helm-verify` depending on
  `@scp/plugin-argo-workflows`).
