# Coordinated tests with Argo Workflows

**Audience:** a team wiring their pipeline's tests into CommanderSCP, and the operator who binds the
Argo Workflows instance those tests run on.

CommanderSCP **coordinates** tests; it never runs them (charter principle 1). Argo Workflows
executes; SCP triggers a run, reads its result, and turns that result into gate or hold evidence for
a wave. Everything below is the seam between those two jobs — what your CI must produce, and what
SCP does with it.

## 1. What SCP does, and what it cannot do for you

| | who does it |
|---|---|
| Run the test workflow | **Argo Workflows** |
| Build and push the test bundle | **your CI** |
| Decide when a wave may proceed | **SCP** |
| Trigger the run, poll it, record evidence | **SCP** |
| Author the WorkflowTemplate | **you**, in your repo |

The load-bearing consequence: **if your CI does not report a test bundle, every declared hook holds
its wave forever.** It does so correctly and says why — the run reaches a terminal status and writes
no evidence, with `no_captured_workflow` as the reason — but nothing you do inside SCP will unblock
it. Section 3 is the fix.

## 2. Why the bundle exists at all (D23)

A hook names a workflow by path in your repo. A govcloud or air-gapped domain **cannot reach your
commercial source repo**, so a path reference alone cannot be what runs there.

So at build time your CI captures the workflows the hooks name, **at the built commit**, into an OCI
artifact — the *test bundle* — pushed beside the image. It rides the same admitted crossing as the
image, lands in the destination domain's own registry, and that domain's Argo Workflows runs the
local, digest-pinned copy. Two consequences worth knowing:

- **Every domain runs the captured copy, including the commercial one.** One behaviour everywhere,
  not two.
- **"Which tests gate this wave" is pinned to the commit being deployed**, not to whatever `main`
  holds today.

The bundle is signature-verified per hop and **never scanned** — scanning stays image-only.

## 3. The CI contract — three fields

SCP assembles a run's pin from three facts and **fabricates none of them**. All three must be
present or the run writes no evidence:

1. the workflow your hook **declared** (from the hook, not from CI),
2. the **built commit**, and
3. the **test bundle** your build pushed.

Your CI reports the last two, in one step:

```bash
scp change-source report terraform \
  --status applied \
  --repo "$CI_REPO" \
  --ref "$CI_REF" \
  --commit-sha "$CI_COMMIT_SHA" \
  --artifact-digest "sha256:$IMAGE_DIGEST" \
  --test-bundle-repository "acme/api-tests" \
  --test-bundle-digest "sha256:$BUNDLE_DIGEST" \
  --artifact-class image
```

- `--commit-sha` is the **built commit**, not a ref. `--ref` is a moving label; a gate pinned to
  "whatever that branch holds now" is exactly what the bundle replaces. Both are useful — the ref
  routes to a ref-scoped mapping, the commit pins the evidence.
- `--test-bundle-repository` and `--test-bundle-digest` are **all-or-nothing**. Half a reference is
  rejected by the CLI, naming the flag. (Were it accepted, the server would drop and quarantine it,
  and your wave would hold citing a bundle you believe you sent.)
- `--artifact-class` declares what the build **actually produced**, and SCP verifies it against what
  the pipeline declared (`source_mappings.type`, which your IaC wrote). **A mismatch refuses the
  release** with a Decision naming both sides. Omitting it is fine and changes nothing — the verdict
  is `unverified`, which is deliberately not the same as `match`.

SCP stores **references only** — never the bundle bytes, never an SBOM document. It neither builds
nor signs a bundle.

### The build step, in order

`build → unit tests → scan (digest-bound) → origin signature → push`. Scan before push keeps a dirty
image out of the registry entirely. The commander's signature is a *different* signature at a
different time: it signs the promotion manifest per crossing.

## 4. Declaring the hooks

Hooks come in three kinds:

| kind | when it runs | what it gates |
|---|---|---|
| `postMerge` | unit tests on the mapped branch | the first wave |
| `postDeploy` | integration suites after a wave lands | promotion out of that environment |
| `continuous` | always-running canary probes | a **per-target hold**, with a freshness window |

A `postDeploy` hook with no `stage` gates **every** wave's exit — adding a `stage` *removes* gates.
The strict end is the default.

`continuous` evidence **time-decays**: `maxAge` is part of the hook contract, so stale evidence stops
counting rather than passing forever. The freshness boundary is recorded in the Decision.

### Declaring them in IaC

A `Workflow` names the file once, inheriting `repo` and `branch` from its pipeline; the hooks hang
off it:

```ts
import { Duration, Workflow, PostMergeTest, PostDeployTest, ContinuousTest, BakeAlarms } from "@scp/iac";

const integration = new Workflow(pipeline, "integration", { path: ".argo/integration.yaml" });

new PostMergeTest(integration);   // id defaults to the hook kind
new PostDeployTest(integration);  // no `stage` -> gates EVERY wave's exit

new ContinuousTest(integration, "canary", {
  every: Duration.minutes(5),
  maxAge: Duration.minutes(15)    // evidence older than this stops counting
});

new BakeAlarms(pipeline, "bakeAlarms", { quietWindow: Duration.minutes(10) });
```

Durations are `Duration` values, never `"5m"` strings — they resolve to plain seconds at the
construct boundary, so the manifest carries `everySeconds` / `maxAgeSeconds` / `quietWindowSeconds`
as numbers.

Two behaviours worth knowing before you are surprised by them:

- **A hook under a service-rung pipeline is refused, not defaulted.** Every hook keys on a component,
  and which components inherit a service-rung pipeline is resolved at read time by the nearest-rung
  ladder — so there is no component for synth to name. Declare hooks on the component's own pipeline.
- **`stage` is omitted, not defaulted.** Absent is the *strict* end (gates every wave), not "unset,
  pick something".

The L1 escape hatch is `stack.addPipelineHook(...)` (with `addRollout` / `addConvergence` alongside),
and it takes the same manifest entry the constructs synthesize — the typed classes are sugar over it,
not a different path.

> **Retracting the last hook needs a hand-authored `"pipelineHooks": []`.** The collection is omitted
> when empty rather than emitted as `[]`, because absent means UNMANAGED — so a program that declares
> no hooks does not silently retract the ones a component already has. Removing the final hook is the
> one case the constructs cannot express, exactly as it is for `producers`.

## 5. Binding the Argo Workflows instance (operator)

The executor needs `serverUrl` and `namespace`; the token is optional and depends on your instance's
auth mode:

- **`--auth-mode=server`** (the bundled instance's default): the API acts as its own ServiceAccount
  and needs **no per-client token**. Access control is therefore **network-level** — whatever can
  reach argo-server can drive it. Keep the NetworkPolicy tight.
- **`--auth-mode=client` or `sso`** (common for BYO): supply a scoped token and reference it with
  `tokenSecretKey`.

### Egress

The chart is default-deny. Reaching any Argo Workflows needs **both** ADR-0003 layers — the
operator's `SCP_INTERNAL_EGRESS_HOSTS` allowlist *and* the execution system's `allowInternalEgress`
— plus a NetworkPolicy. For the bundled instance, setting `bundledExecutor.argoWorkflows.enabled`
renders `allow-argo-workflows` (port 2746, plus 443/80 for ingress-fronted installs). For a BYO
instance, add an entry to `networkPolicy.executorEgress`.

Unlike the bundled Argo CD and Gitea, there is **no auto-wire Job** for Argo Workflows, and that is
deliberate: in `server` auth mode there is no scoped token to mint, so a hook would create a
credential nothing consumes.

> **Known gap: TLS.** The bundled argo-server serves **HTTPS on 2746 with a self-signed certificate**
> (the vendored Deployment's readiness probe uses `scheme: HTTPS`). The plugin host's HTTP client
> currently has no CA-trust knob for plugin traffic — only federation mTLS has one — so verifying
> that certificate is unresolved. A BYO instance behind a trusted certificate is unaffected. Track
> this before relying on the bundled instance.

## 6. Reading a held wave

| what you see | what it means | what to do |
|---|---|---|
| terminal run, no evidence, `no_captured_workflow` | one of the three facts was missing — usually the bundle | add the report flags in §3 |
| hold with a freshness boundary | `continuous` evidence aged past `maxAge` | the probe is not reporting |
| release refused, `artifactClassVerification` in the Decision | declared class ≠ produced class | fix the IaC declaration or the CI's `--artifact-class` |

Every refusal carries a `decision_id`, and the Decision carries the inputs it was reached from.

> **Known gap: no UI.** Hooks, hook runs and pipeline evidence have **no interface surface yet** — a
> wave held on a test gate shows no reason in the web UI. Read the Decision via the API or CLI.

## 7. Where tests run today

A hook run resolves its executor from the **deploy target's own binding** (falling back to the
component's). There is **no separate test lane yet**, so pointing tests at a different Argo Workflows
instance than the one coordinating deploys is not expressible. The binding-policy `test` lane key is
planned; until it lands, bind the instance you want tests to run on to the target itself.

## Related

- [organizing-waves.md](organizing-waves.md) — the stage/wave grammar these gates apply to
- [team-pipeline-iac.md](../proposals/team-pipeline-iac.md) — D11 (hooks), D13 (artifact class),
  D22 (the build step), D23 (the test bundle)
- [ADR-0003](../adr/0003-internal-egress-for-execution-systems.md) — the two egress layers
- [ADR-0013](../adr/0013-supply-chain-scan-sbom-manifest.md) — cross-boundary artifact classes
