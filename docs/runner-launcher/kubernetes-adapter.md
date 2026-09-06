# kubernetes-adapter

Reference for `packages/runner-launcher/src/kubernetes-adapter.ts`. The source carries a one-line headline at each site and points here.

> Partial: 13 of 75 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. THE KUBERNETES ADAPTER

THE KUBERNETES ADAPTER (M23.2) — THE SECOND IMPLEMENTATION OF THE PORT M23.1 EXTRACTED

WHY IT IS A SECOND ADAPTER AND NOT A FOURTH LAUNCH SEQUENCE. M23.1's whole finding was that three plugins had each hand-rolled one mechanism, so a fix or a new platform arm had to be applied three times and the instance that got missed was invisible. This file is the test of that claim: it adds a platform arm and touches **no plugin**. The three `launch-argv.golden.test.ts` files do not move by a byte, and `launcher-seam.test.ts` — which pins each plugin's whole `RunnerSpec` with `toStrictEqual` and constructs its launcher by hand — is adapter-independent by construction and is likewise untouched.

THE LIFECYCLE MAPPING, AND WHY `suspend` IS THE ONE THAT MAKES IT FAITHFUL
The port's five steps are `create` -> `copy-in` -> `start` -> `copy-out` -> `teardown`, and the order is not decoration: `docker create` stakes the NAME before a single byte is copied, so two concurrent runs of one `runId` collide on the name rather than on each other's workspace bytes (`isContainerNameConflict`, M23.1e). Any Kubernetes mapping that moved the name-staking after the byte movement would re-open that race in a worse form — two runs writing the same files.

```text
create    POST a Job with `spec.suspend: true`. The Job object exists; no pod does. This is the
          precise analogue of `docker create`: the name is claimed (a duplicate is a typed 409
          `AlreadyExists`, which is STRICTLY better than Docker's `already in use` stderr
          substring match) and nothing is running yet.
copy-in   A recursive filesystem copy into a per-run subtree of the SHARED workspace volume.
          There is no `docker cp` on Kubernetes and there cannot be: a ConfigMap fails the 1 MiB
          etcd limit and `pods/exec` + tar is impossible against `apps/runner-dep`'s seven-applet
          `FROM scratch` image, which has no tar and no shell. Owner decision 5 (2026-08-18)
          therefore makes RWX storage a documented deployment prerequisite, and this is where
          that prerequisite is spent. The copies are sequential and awaited for the same reason
          they are on Docker — see `ordering-conformance.ts`.
start     PATCH `spec.suspend: false`, then poll the run's pod to a terminal state and read its
          log. This is the only step that can consume real time and it is the one the whole-run
          deadline mostly bounds.
copy-out  A recursive filesystem copy back OUT of the same subtree, honouring `when` and
          `onFailure` unchanged — the two asymmetries M23.1 refused to normalise.
teardown  DELETE the Job (background propagation), DELETE the per-run Secret, remove the
          workspace subtree. The Secret DELETE is a latency optimisation over the
          `ownerReference` the Job already carries, never the thing the credential's lifetime
          depends on — see step 2b. Unconditional, outside the run budget, swallowed-but-not-silent —
          all three exactly as the Docker adapter, and with the same ONE exception: a run that
          lost the name to somebody else tears down NOTHING, because none of it is its own.
```

BYTES ARE COPIED, NEVER MOUNTED FROM THE HOST — the same structural property the Docker adapter keeps by never passing `-v`. The Job mounts one operator-declared volume, at subpaths this adapter derives from the caller's `containerPath`s; no caller-supplied host path becomes a mount.

WHAT THE PORT COULD NOT PROMISE, SAID OUT LOUD RATHER THAN PAPERED OVER
1. `networkMode` CANNOT BE HONOURED, and this adapter does not pretend otherwise (owner decision 1, BUILD_AND_TEST.md M23). No pod-spec field, annotation, `securityContext` or RuntimeClass removes a pod's network namespace. The strongest portable substitute is a deny-all-egress NetworkPolicy — traffic denial, not interface absence, and fail-open on a CNI that does not enforce (measured on kind + kindnet: a pod SELECTED by a deny-all-egress policy reached a public IP and a resolver, indistinguishable from an unselected control). So the adapter does the one honest thing available: it CARRIES the resolved value to where a policy can act on it, as the pod label `RUNNER_NETWORK_LABEL`, and CLAIMS NOTHING. The port's own rule is unchanged — it "takes the resolved value and never decides it". 2. `pods/log` MERGES stdout AND stderr into one stream and does not preserve their interleaving (measured: a container printing STDOUT-LINE then STDERR-LINE returned them reversed). The port's `RunnerResult` has two fields. This adapter puts the whole merged stream in `stdout` and leaves `stderr` EMPTY — see `KUBERNETES_MERGES_STDERR_INTO_STDOUT` for why that direction and not the other, and for the two readers that decide it. 3. `maxBuffer` IS AN `execFile` CONCEPT. Kubernetes offers `limitBytes`, which truncates at the SERVER and returns success. `output-exceeded` is kept REACHABLE anyway — see `logRequestPath` — because the hazard it names ("the output looks like data but is truncated") is a property of the evidence, not of Node. 4. THE PER-RUN SECRET IS ON (M23.4, owner decision 2026-08-20). It was shipped in M23.2 as a declared, DISABLED capability; the grant has since been taken, so the chart renders the RBAC by default and `managed-iac` launches on Kubernetes. What the grant BOUGHT and what it COST are both recorded, as an accepted combination, in ADR-0035 §"the accepted combination". See `KubernetesRunnerLauncherConfig.perRunSecrets`.

## §2. WHAT THE RUN'S POD SAYS HAPPENED

WHAT THE RUN'S POD SAYS HAPPENED — or `undefined` while it is still going.

THE RETURN IS SHAPED AS AN `execFile` REJECTION ON PURPOSE, and that is the single most useful thing in this file. `classifyRunnerFailure` is the port's only producer of a `RunnerFailure`, it is 30 lines of measured branch ORDER, and its kinds are the operator-facing vocabulary the whole product records. Writing a second Kubernetes classifier would have been the M23.1 defect again — one mechanism, two implementations, and the one that gets missed is invisible. So this function's job is translation, not classification: it produces `code`/`killed`/`signal` such that the EXISTING classifier reaches the right kind, and every one of them is exercised by a named test.

```text
pod Succeeded                      -> succeeded
terminated, signal != 0            -> killed: true            -> `signalled`
terminated, reason OOMKilled       -> killed: true            -> `signalled`
waiting, a fatal image/config      -> code: "<Reason>"        -> `spawn-failed` (a STRING code)
terminated, exitCode != 0          -> code: <number>          -> `exit-nonzero`
```

`budget-exhausted` and `output-exceeded` are not produced here: the first is the deadline path (`deadlineExceeded`) and the second is the log-size check, exactly as on Docker.

## §3. DID THE RUNNER CONTAINER EVER START?

DID THE RUNNER CONTAINER EVER START? — the fact every verdict below turns on.

`budget-exhausted` says, in `RunnerFailureKind`'s own words, "a `tofu apply` was SIGTERMed mid-flight, so the real infrastructure state is unknown". That sentence is true only if something ran. Once, for every route where nothing did, it was what an operator was told — which is the same misdiagnosis `FATAL_WAITING_REASONS` already calls "the single worst available here", arrived at from the other side: that set catches a container the kubelet REFUSED, and this catches the routes where no container was ever asked for.

STICKY, not a reading of the current state: a pod deleted mid-run leaves no status at all, and the whole point of the distinction is to remember that there had been one.

## §4. WHY THIS RUN IS STILL WAITING

WHY THIS RUN IS STILL WAITING — one operator-facing clause, assembled from whatever said anything.

THE THREE MEASURED ROUTES, all of which produced the identical `budget-exhausted` verdict after burning the entire run budget, and none of which `kubernetesTermination` can see because it reads ONLY `pod.status.containerStatuses`:

```text
1. A ResourceQuota requiring compute limits. `jobManifest` set no `resources` block at all
   (M23.5 gives the chart one), so the pod CREATE is rejected — `must specify limits.memory for:
   runner` — no pod ever exists, and the refusal is written down in exactly one place: the Job
   controller's `FailedCreate` event.
2. An unschedulable pod. The pod EXISTS, has no `containerStatuses` whatsoever, and carries
   `PodScheduled=False` with `Unschedulable` and the scheduler's own message. That is also the
   shape of an unbound RWX claim — the failure `assertRunnerPrerequisites` exists to pre-empt.
3. The pod deleted mid-run (a node drain, an eviction). Handled by
   `kubernetesJobTermination` rather than here, because the Job says so outright.
```

## §5. WHAT THE JOB ITSELF SAYS HAPPENED

WHAT THE JOB ITSELF SAYS HAPPENED — the terminal verdict no pod can carry, or `undefined`.

`kubernetesTermination` reads `pod.status.containerStatuses` and nothing else, which is correct for every run that produced a pod that ran and WRONG, in one specific and expensive way, for every run that did not: with no terminal pod the loop polls to the whole-run deadline and reports `budget-exhausted`, i.e. "the runner was stopped mid-flight, the real infrastructure state is unknown", when nothing ran at all.

A `Failed` condition on the Job is that missing verdict, and the KIND depends on `everStarted` — which is the whole reason that flag is threaded through:

```text
pod deleted mid-run (drain/eviction)  everStarted -> killed  -> `signalled`
the Job never produced a running pod  !everStarted -> STRING code -> `spawn-failed`
```

The second is the honest one: `spawn-failed`'s own wording is "the container CLI could not be executed at all — nothing ran. Nothing ran, so nothing was mutated", which is exactly true of a quota rejection and exactly false of the budget verdict it used to get.

## §6. WHAT THIS RUN OBSERVED

WHAT THIS RUN OBSERVED — the whole input to `kubernetesStartVerdict`, and deliberately not one boolean more. Every field is something the run WATCHED HAPPEN, never something inferred from which line of the control flow raised the failure.

## §7. 2. THE UNSUSPEND WAS NEVER SENT

2. THE UNSUSPEND WAS NEVER SENT. The budget was already gone when the run reached `start`, so `spend` refused it before it was issued: the Job is exactly as `create` left it. This arm exists so that the KNOWABLE half of "nobody answered" is not swept into arm 3 with the unknowable half — telling an operator to go and inspect infrastructure that was never touched is a weaker claim than the truth, and a weaker claim is still the wrong one.

## §8. IS THE BUDGET ALREADY GONE?

IS THE BUDGET ALREADY GONE? — READ BEFORE THE CALL, AND THAT PLACEMENT IS THE OPPOSITE OF THE GUARD M23.5 DELETED RATHER THAN A RETURN TO IT.

The deleted guard read the clock before a call and used the answer to decide the verdict AFTER it, in the direction that can be wrong: the clock could cross in between, so "there is budget left" did not mean the call would be issued, and the run reported `budget-exhausted` for a run in which nothing ever started (6 in 20).

THIS READS IT IN THE DIRECTION THAT CANNOT BE WRONG. The clock only moves forward, so `spent()` here means `spend` WILL refuse and the request WILL NOT be issued — a positive proof. A `false` proves nothing and is used to prove nothing: the run falls through to `unanswered`, the conservative arm. Non-atomicity can only ever cost precision here, never make the verdict false.

## §9. POLL TO A TERMINAL POD

POLL TO A TERMINAL POD — OR TO A TERMINAL JOB, which is the half M23.5 added and the half three measured failure routes needed.

THERE IS STILL EXACTLY ONE BOUND, AND NOW EXACTLY ONE PLACE THAT SAYS WHAT REACHING IT MEANS. Every request goes through `api()`, which refuses once `runDeadlineAt` is spent, so the deadline can be DISCOVERED at any of four calls in this loop — `GET pods`, `GET events`, `GET job`, `GET log`. A guard at the top of the loop cannot fix that and the previous round's attempt to (moving the check up, and calling the placement load-bearing) did not: the check and the `api()` it guards are not atomic, so the clock could cross between them and the run reported `budget-exhausted` — "a `tofu apply` was SIGTERMed mid-flight, so the real infrastructure state is unknown" — for a run in which NOTHING EVER STARTED. 6 runs in 20, only under the full file's timing.

SO THE CHECK IS GONE and the verdict is decided ONCE, in the `catch` below, from the facts this loop observed rather than from which line noticed the clock. What is left here is the polling itself.

## §10. NO TERMINAL POD

NO TERMINAL POD. Everything below is DIAGNOSIS, and it is gathered while the run is still alive because teardown deletes the Job and takes the Job's events with it.

AND DIAGNOSIS NEVER BECOMES THE FAILURE. The whole block is swallowed: a Role that predates M23.5 has no `events` grant, a `GET job` can 404 against a Job something else deleted, and either of those replacing the real cause would be this same defect wearing a different mask. What is lost when it fails is specificity, never the verdict.

## §11. THE JOB MANIFEST

THE JOB MANIFEST — this adapter's `argv`, and the thing its golden pins whole.

A PURE FUNCTION OF THE SPEC AND THE DEPLOYMENT SETTINGS, exported for exactly that reason: the Docker adapter's complete statement of intent is one array of strings a test can compare, and the Kubernetes equivalent has to be equally comparable or the golden degrades into "some of the fields we remembered to check". `kubernetes-launch.golden.test.ts` asserts the whole object with `toStrictEqual`, so a field ADDED here without a golden update is a red test rather than a silent change to what every managed run does.

`args` and `env[].value` are escaped through `escapeKubernetesVarExpansion` before they reach this object (M23.5 MEDIUM-6) — see that function for why an unescaped caller string can leak a `secretEnv` value into the runner's argv.

## §12. NO KUBERNETES CLIENT LIBRARY

NO KUBERNETES CLIENT LIBRARY (owner decision 7, and it is verified rather than asserted: a filterless grep for `@kubernetes/client-node`/`kubernetes-client` over `package.json`, `pnpm-lock.yaml`, `apps` and `packages` returns zero). The precedent already ships twice — `bundled-argocd-autowire-bin.ts:69-95` and `bundled-gitea-autowire-bin.ts:71-97` — and both rely on the SAME constraint this transport inherits: Node's global `fetch` cannot take a custom CA without an undici Agent, so the cluster CA must reach it through `NODE_EXTRA_CA_CERTS`. That is a DEPLOYMENT obligation, not a code one, and the chart is where it is met.

`token` and `apiBase` are read per request rather than captured: a projected token is rotated in place by the kubelet, and a launcher instance outlives one rotation only if it re-reads.

## §13. THE SELECTING RESOLVER

THE SELECTING RESOLVER — one switch on an EXPLICIT operator setting, never an auto-detection.

`resolveDockerRunnerLauncher`'s own doc has said since M23.1 that this is "NEVER an auto-detection of the platform (M15.4 declined to create that runtime/install-time fork, and guessing from the presence of a service-account token is exactly that guess)". This function is that promise cashed: the ONLY thing it reads is `config.runnerLauncher`, and an unset value is Docker — byte-identical behaviour for every deployment that does not opt in, which is what makes M23.2 safe to merge.

WHERE THE VALUE COMES FROM AND WHY IT CANNOT COME FROM A TENANT. `runnerLauncher` and the `kubernetes` block below it join the server-injected/never-tenant-settable class on day one, and that class is three layers, all of which move in this same change (index.ts's own note: "WHEN M23.2 ADDS ADAPTER SELECTION it becomes a config field, and all three layers must be updated in that same change"): each plugin's manifest `configSchema` (`additionalProperties: false`, so the key is refused by schema), `validatePluginConfig` at the four write doors (refused by name), and the LAST-wins injection sites in `executor-bindings-repo.ts` / `managed-dep-instance.ts` / `promotion-scan-step.ts` (overwritten even if the first two ever regress). Two defences that fail independently, plus the injection that wins — the same posture `dockerBinary` has since the managed-scan RCE.
