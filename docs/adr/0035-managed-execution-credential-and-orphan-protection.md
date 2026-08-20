# ADR-0035: Managed execution — credential exposure, orphan containers, and the enforcement layering that catches neither

**Status:** **Accepted (2026-08-18)**, **amended 2026-08-18 (M23.1e, Decision 5)**, **amended 2026-08-20 (M23.4, Decision 6 — the per-run Secret grant)** — four decision points decided by the owner on 2026-08-18, before this milestone's code was written; a fifth records the whole-run budget that M23.1e added, which amends Decisions 2 and 3 and closes Defect 4. Three fixes land in M23.1 and M23.2 (pending). **This ADR records the defects found in production (managed-iac live on main, credential-readable from host process table and `docker inspect`; the 10-second SIGKILL defeating every run over 10 seconds; orphaned containers from crash-killed subprocesses), their fixes, and the fundamental enforcement-layering reason none of it was caught by any existing test.**

**Numbering:** this ADR was authored as 0034 and renumbered to **0035** by agreement with the
concurrent `claude/ui-review-worktree-efc42b` branch on 2026-08-18. Three branches independently claimed
0034: this one, that branch's `remove-initiative`, and — already on `main` — the prose reservation at
`docs/proposals/governance-label-namespace.md:3` ("An ADR (0034) follows owner approval"), which neither
branch's renumber pass would have seen, because it reserves a number without holding a file in `docs/adr/`.
Agreed map: **0034** reserved for governance-label-namespace, **0035** here, **0036–0038** that branch.
Agreeing numbers up front makes merge order irrelevant, which is strictly better than renumbering
second-to-merge. Two cautions for whoever renumbers next: grep `docs/proposals` for `An ADR (00` as well as
reading `docs/adr/`, and replace **anchored** forms only (`ADR-00NN`, `adr/00NN-`, the filename) — a bare
four-digit match collides with the migration namespace, where `0034` is `federation_inbox_files` and
appears in nine unrelated places in this repo.

**Context doc:** [docs/BUILD_AND_TEST.md](../BUILD_AND_TEST.md) §8 (M23.0–M23.2 entries describe the defects, their fix order and proof strategy).

**Relates to:** [ADR-0002](0002-execution-strategy.md) (charter principle 1: coordination not execution; the managed executor exception); [ADR-0020](0020-promotion-scan-step.md) (managed-scan, same defect 2 as iac); [ADR-0032](0032-dependency-subscriptions.md) §8a–§8f (managed-dep, same defects, M21.5).

## Context

Three measured defects in managed execution (scp-managed-iac, live on main since M11 forward; scp-managed-scan and scp-managed-dep, shipped later) survived from pilot to production because the test isolation boundary that discovered each one was **the wrong isolation boundary for that defect**.

### Defect 1: Credentials readable from the host process table and `docker inspect` (M23.0, live)

The plugin resolves infrastructure credentials (AWS keys, TF_VAR_* env vars) into the `docker create` argv as `-e KEY=VALUE`. Every local process on the host can read it via `/proc/<pid>/cmdline` (unprivileged, always accessible — the defect is not a privilege escalation). The `docker inspect <container>` output carries the same value in `Config.Env` for the container's entire lifetime, and crucially, for UNBOUNDED lifetime when the container orphans (see Defect 2). A credential appears unredacted in error logs via `Command failed: docker create ... -e AWS_SECRET_ACCESS_KEY=... ...` and crosses the plugin-host RPC boundary (`subprocess-entry.ts` serialises only `err.message`), reaching `console.error` and any Decision built from it.

**Why it was not caught:** The real plugin (`managed-iac`, `managed-scan`, `managed-dep`) is **tested without the host** — `managed-iac.integration.test.ts` imports the plugin directly and calls its `trigger()` method with a test harness, never a SubprocessPluginHost. The docker-spawning call is direct, so the argv is built and measured, but it is never redacted. It is never seen by log infrastructure and never appears in the RPC payload that a host would have to transmit. A test at the port level (the adapter that builds the argv) proved it once and broke it again on the very same day the credential fix landed, because no other layer enforced what the port's own test asserted.

### Defect 2: The 10-second SIGKILL defeating every managed run (M23.1c, live)

`plugin-host/host.ts` defaults every RPC method's budget to 10 seconds (`callTimeoutMs: 10_000`). All three managed executors run their container **synchronously inside `trigger()`**, budgeted 10 min (iac, scan) and 5 min (dep). On expiry `sendOnce` does not reject the RPC — it `instance.child?.kill("SIGKILL")` with no `finally`, no `catch`, no outcome write and no `saveState`. The result: every real managed run ends that way (10 seconds is a hang detector meaningful for fast methods like `status()`; a 10-minute apply is the outlier). Three measured consequences:

1. **The runner container orphans `state=running`.** The daemon has already started it; a SIGKILL to the subprocess stops only the listening process, not the container. It keeps running, doing whatever its workload does (for managed-iac, a `tofu apply` still mutating live infrastructure), with nothing left supervising it. When it finishes and `state=exited`, the container persists indefinitely with full `docker inspect` visibility, including the credentials from Defect 1. Reachable: a legitimately slow `tofu apply` or a full-filesystem Trivy scan.

2. **The idempotency ledger is never written.** Affected: managed-iac only. Its outer `catch` runs `saveState`, which persists the idempotency ledger entry (used by `reconcile.ts` to deduplicate retries). With no `catch`, the entry is never written. A retry bumps `attempt`, backs off, and issues a **second `tofu apply` against the same live infrastructure while the first container is still applying**. Against a plugin whose own header calls this "the strongest idempotency guarantee of any M7 executor." Measured: managed-dep's `bump-dispatch.ts` and managed-scan's executor dispatch both write ledgers and are also affected by the SIGKILL, but their outer catches fire (Defect 2, the second part, still open).

3. **`status()` reports `pending` indefinitely.** Affected: all three. No `saveState` means no outcome in the ledger. `status()` reads the ledger, finds nothing, and reports `pending`. For managed-iac, the same run that triggered a double-apply now blocks iac's dedup logic while another just-started apply reads the stale ledger and is unblocked to run a third.

**Why it was not caught:** The real plugins are tested **without the host** (same as Defect 1). A test that constructs each plugin's `trigger()` and measures its behaviour — success case, copy-out failure, everything — never sees a 10-second timeout, because `managed-iac.integration.test.ts` runs the plugin in-process with explicit `timeoutMs` on the fake-executor (`timeoutMs: 30_000`), making the hang detector invisible. The hang detector's own real job — catching a wedged `status()` — is tested in isolation against a fast fake. The two halves never meet in a test until M23.1c splits the budget.

### Defect 2 (still open): A managed-scan run can finish with no outcome recorded (M23.0)

The third "answer to one Docker failure" (managed-iac swallows a copy-out failure; managed-dep records it as failed; managed-scan's copy-out rejection escapes and strands `status()` at `pending`). This is the plugin's outer error handling, not the port's. It is recorded and will be fixed after M23.1c lands, because the port's outer guard in Phase 2 now enforces that every `trigger()` resolution is a recorded outcome.

**Why it was not caught:** Same as the second one — the plugin is tested without the host, so the five-second timeout is explicit, the copy-out failure is never unguarded, and the three asymmetries are all exercised. The test is correct; the asymmetry is real.

### Defect 3: The host bypasses the subprocess isolation boundary (M23.1c, still open)

`federation/promotion-scan-step.ts` calls `managed-scan` **in-process**, importing `createManagedScanExecutorPlugin` and constructing it at module load. A docker-spawning plugin runs inside the server process, outside the subprocess isolation boundary. The `dockerBinary` is server-injected (no tenant input — this is not an RCE), but it is **the one managed path with no plugin host in front of it** and therefore the one this milestone's per-method budget does not reach. The plugin can still run the 10-second default and SIGKILL, because `sendOnce` is never involved.

**Why it was not caught:** There is no test for this mode; the isolation boundary is architectural and no enforcement mechanism names this as a requirement.

### Defect 4: Retry-stable naming has an atomic cost

The port computes the container NAME before `create` is issued, so the teardown can address it even when `create` fails. A `create` that fails **because the name is already taken** then runs its unconditional teardown and **destroys the run that legitimately holds it**. Reachable for two concurrent triggers of one `idempotencyKey` (managed-iac's dedup cache missed them both). This was recorded as the trade — **retry-stable and per-attempt naming cannot both be had**; the instruction chose stable naming, and this was called its cost. **M23.1e rejects that framing (Decision 5).** The two things being traded were never the same thing: the NAME is the feature, and the *unconditional* teardown was the bug. A create that fails on a name conflict can be told apart from every other create failure, and the destructive step skipped for exactly that one case, with the naming untouched.

### Defect 5: A per-call bound used as a whole-run bound (M23.1e, live) — and the three defects downstream of it

`@scp/runner-launcher` passed `{ timeout: spec.timeoutMs }` to `create`, to **every** copy-in, to `start` and to the copy-out **independently**. A run issues four (managed-iac, managed-dep) to six (managed-scan) sequential `execFile` calls and each got a fresh, full `timeoutMs`, so **a run's wall clock was k × timeoutMs and nothing bounded the sum**. Both numbers derived from `timeoutMs` had then been sized as `timeoutMs + a constant`, so all three of the following are one defect, not three:

- **The per-method budget is exceedable, so Defect 2's SIGKILL is reachable again.** Measured through a default-constructed `SubprocessPluginHost` driving the real managed-iac with `timeoutMs: 20_000` and steps of 18s/9s/18s/9s — every one of them under the inner 20s bound — the budget (50000ms) expired at 50003ms: `plugin 'managed-iac-overrun' call 'trigger' timed out after 50000ms`, container still held, ledger unwritten, so `reconcile.ts` issues a second `tofu apply` while the first is still applying. That is verbatim the defect Decision 2 claims to have closed. Reachable at the shipped 630s budget, because `docker create` **pulls the image when it is absent** — a cold pull plus an ordinary apply clears 630s with no single call reaching 600s. **The proof it was untested: shrinking `MANAGED_TRIGGER_GRACE_MS` from 30_000 to 3_000 reddened nothing.**
- **A run outlives the deadline it stamped on its own container.** `scp.launcher.deadline` was `Date.now() + timeoutMs + RUNNER_REAP_GRACE_MS`, computed once before `create` — a different quantity from the run's real duration. Real managed-scan shape (3 copy-ins, `timeoutMs: 30_000`, steps of 28s): stamped ~t0+150000ms, `run()` returned after 168354ms. For 18s the container was **foreign AND past deadline** to every peer launcher, which is precisely and only what `reap()` removes. A peer's `docker rm -f` lands on a live `tofu apply` — the one thing `RunnerLauncher.reap`'s own contract says it must never do. Threshold ≈ 24s of `timeoutMs`; all three defaults are above it.
- **`reap()` spends the run's budget, and amplifies itself.** `await reap()` was prepended to `run()` *after* Decision 2 had sized the budget, and no phase re-checked the sum. With `timeoutMs: 1_000` and four stale orphans at 9s each, the budget (31s) expired at 31.2s with **`create` never issued**. Each resulting SIGKILL respawns the subprocess with a new `LAUNCHER_OWNER_ID`, so every container the dead process created becomes foreign and joins the next pass: the reaper's workload grows with each timeout it causes.

**Why none of it was caught.** `docker-adapter.test.ts` settles every step on the next tick of the loop — by design, because it is about *what* goes on the command line and in what *order*. `managed-trigger-budget.test.ts` drives a stub `docker` whose one slow step is `start`. With one slow step there is no sum to bound, so a suite built around one slow step is structurally blind to a defect about the sum. Eighty green tests, and none of them could ask *how long*.

## Decision

### 1. Credential exposure and its fix

**The credential `env/secretEnv` split, the `--env-file` mechanism, and the redaction layer are Accepted.**

- **`env`** (non-secret): ride the argv as `-e KEY=VALUE` (unchanged from before).
- **`secretEnv`**: written to a mode-0600 temporary file, passed as `--env-file P`, unlinked the instant `create` returns — even on the failure path.
- **The split is along the SECRECY axis**, because **both adapters must branch on it**: Kubernetes maps `env` to `env[].value` and `secretEnv` to a per-run Secret with `envFrom.secretRef`. Under one undifferentiated list, "port env to Kubernetes" reads as `env[].value` for everything — plaintext credentials in etcd and in every etcd backup, strictly worse than the host process table this replaced.
- **Every rejection out of the adapter is wrapped in `RunnerLaunchError`** built from a **redacted argv**. The redaction is **by VALUE from `secretEnv`, plus the `--env-file` path** — exact rather than heuristic. This is the only place in the product that can do that, because it is the only place that knows both the argv it built and which entries the caller declared secret.

**That `--env-file` is a partial fix and why.** The value is out of the host process table (removes it from `/proc/<pid>/cmdline`) and out of error messages. It is **still in `docker inspect` for the container's life** (no API to hide it) and **still on a disk for the duration of one `create`** (mode 0600, unlinked after `create` succeeds or fails, but a crash between write and unlink leaks it). The tradeoff is Accepted: the split buys the Kubernetes arm a native-secret mapping, and the time window is bounded by `create`'s own timeout.

### 2. The 10-second SIGKILL and its fix

**The per-method budget, with managed `trigger` getting the instance's resolved `timeoutMs` + grace, is Accepted.**

The obvious fix — raise `callTimeoutMs` to 10 minutes — is wrong. It would blind the host to a wedged `status()` on every plugin in the product. Instead:

- **`trigger()` on a managed executor gets that instance's resolved `timeoutMs` + 60s grace** (`MANAGED_TRIGGER_GRACE_MS`). **Amended by M23.1e — see Decision 5.** As first written this read "+ 30s grace, sized so the plugin's inner `execFile` timeout fires first", and that was false: it was true of ONE `execFile`, while a managed run issues four to six of them and the launcher gave each a fresh, full `timeoutMs`. What guarantees the plugin's own bound fires first is not this grace but `RunnerSpec.timeoutMs` being a **whole-run deadline**; the grace covers only what happens after that deadline, which is one `docker rm -f` teardown plus the outcome write.
- **Everything else keeps the 10s hang detector**, unchanged.
- **NO transparent crash-retry for a managed `trigger`.** The change widens the crash window from ≤10s to ≤11 min, and `call()`'s transparent retry re-enters an apply whose ledger entry is by construction not yet written — a second `tofu apply` against live infrastructure while the first is still applying. It also collides on the container name derived from the same `idempotencyKey`; since M23.1e the loser no longer tears the winner down (Decision 5), but a retry that cannot proceed is not a retry worth having.

**The tenant-settable `timeoutMs` ceiling is Accepted.** All three manifests shipped `{ type: "integer", minimum: 1000 }` with **no maximum**. `MANAGED_RUN_TIMEOUT_MAX_MS` (1 hour, 6× the largest default) is Accepted as the ceiling. Ajv honours `maximum`, so `validatePluginConfig` enforces it at all four write doors. The host **reads those bounds off the manifest** rather than re-declaring them, and **clamps** — rows stored before the ceiling existed are never re-validated on read. **The ceiling is what makes the deadline predicate computable at all** (see Decision 3).

### 3. Orphaned containers and the reaper

**The reaper labelling strategy and sweep predicate are Accepted.**

Every container now carries:

- **`scp.launcher.owner`**: a UUID minted **once per Node process**, at module load (not per run, because a plugin resolves a fresh launcher on every `trigger()` and a per-call id would make the long-lived subprocess unable to recognise its own prior container as its own).
- **`scp.launcher.deadline`**: RFC3339, `runDeadline + RUNNER_REAP_GRACE_MS`, where `runDeadline` is the single `now + timeoutMs` the run itself is bounded by. **Amended by M23.1e — see Decision 5.** As first written this was `create-time + timeoutMs + RUNNER_REAP_GRACE_MS` off its own clock read, which was a *different* quantity from the run's real duration, and runs routinely outlived the stamp they had put on their own container.

`RunnerLauncher.reap()` is **scheduled** at the top of every `run()`, before `create`, and **not awaited** (M23.1e, Decision 5):

- Lists launcher-owned containers via `docker ps -a --filter label=scp.launcher.owner`.
- Removes only those that are BOTH foreign (`owner != mine`) AND past their own deadline.
- Best-effort throughout; the pre-existing silent teardown swallow now logs via `NODE_DEBUG=scp-runner-launcher`.

**That the reaper issues `docker rm -f` on containers this process did not create is Accepted.** This is **containment hygiene inside the existing Managed Execution Exception**, not a widening of it — the exception already permits the managed plugins to run orchestration code (exec/plan/apply); the sweep is the cleanup half of that same orchestration. Containment is **enforced at the label**: a container without `scp.launcher.owner` (e.g. a pre-existing orphan on the machine) is excluded by the daemon's own `--filter` before any of its state reaches this process.

**Bounded per pass (M23.1e).** A pass is `docker ps` plus one `rm -f` per expired orphan, and the orphan count is unbounded; bounding only the individual calls therefore bounds nothing. `RUNNER_REAP_BUDGET_MS` (2 minutes) bounds the pass, which simply stops issuing removals when it expires — what is left is still expired and still labelled, so the next pass collects it. Passes are also single-flighted per container CLI, so k concurrent runs do not start k sweeps over the same containers.

**What the reaper does NOT do (still open).** Nothing sweeps the reap labels' OWNER identity for a replica that scales down permanently — its containers become reapable only once their deadline passes, same as a crash, which is correct but means a deliberate scale-down is not distinguishable from a crash for sweep-latency purpose. `abort()` head-of-line-blocked by a long `trigger()` (Defect 2 still open) remains unfixed.

### 6. The per-run Secret grant on Kubernetes (M23.4, owner decision 2026-08-20)

**Granted. `secrets: create,delete` on the worker ServiceAccount, rendered by the chart's DEFAULT, is Accepted.** Owner decision, verbatim: *"Grant the secrets RBAC, keep going."*

**What it decides.** M23.2 built the Kubernetes half of Decision 1's `env`/`secretEnv` split — `secretEnv` reaching a pod as a per-run Secret plus `envFrom.secretRef` — and shipped it as a *declared, disabled capability*: `managedRunners.kubernetes.perRunSecrets` defaulted to `false`, the chart rendered no `secrets` rule, and a spec carrying a non-empty `secretEnv` was refused at step `secret-env` with a sentence naming the value. That was correct while the grant was undecided, and it had a cost that is the whole reason to end it: **`managed-iac` is the only class that populates `secretEnv`, so it could not run on Kubernetes at all.** With this decision the default is `true`.

**The scope of the grant, and the omissions are measurements rather than tidiness:**

| Verb | Granted | Why |
|---|---|---|
| `create` on `""/secrets` | yes | One POST per run that carries a credential. |
| `delete` on `""/secrets` | yes | Teardown's fast path, and `reap()`'s sweep of a dead peer's run. |
| `get` | **no** | A filterless read of every `SECRETS_PATH` use in `kubernetes-adapter.ts` finds one POST and two DELETEs and no GET. M23.2's own comment said "create,get,delete"; the code never needed the middle verb. |
| `list` | **no** | A refusal, not an omission: `list` on secrets returns every Secret **body** in the namespace, including the release's own database password. The reap sweep is built to work without it — it lists **Jobs**, which are not secret, and derives the Secret's name from the Job's. |
| `update`/`patch` on `jobs/finalizers` | **no** | What `blockOwnerDeletion: true` would have cost; the ownership edge below sets it `false` instead. |

**`resourceNames` is not expressible, and that is stated rather than left as a silence.** Per-run Secret names derive from `runId`, so the set is unbounded — and Kubernetes RBAC cannot restrict a `create` by `resourceNames` under **any** circumstances, because the object's name is not known to the authorizer at admission time. The grant is therefore namespace-wide on `secrets`. **The narrowing that IS available is deployment-shaped:** `managedRunners.kubernetes.namespace` puts the runner Jobs, their Secrets, the Role and the RoleBinding in a namespace of the runners' own, away from the release's own Secrets. That is the recommended shape for anything holding real cloud credentials, and it did not work before M23.4 — the Role rendered unconditionally into `.Release.Namespace` while the adapter created Jobs in the configured one, so setting the value produced a silent 403 on every launch.

**The credential's lifetime is the cluster's obligation, not a `finally`'s.** Decision 1's Docker arm unlinks the `--env-file` in a `finally`, and M23.1d found the hole in that: **no `finally` survives a SIGKILL**, and the plugin host's hang detector kills a subprocess mid-`trigger()`. On Docker the answer had to be a sweep, because a file has no owner. A Kubernetes object has one, so the answer here is `ownerReferences` — and it costs an ordering change that is part of this decision:

- **The Job is POSTed first and the Secret second.** M23.2 had it the other way round (the Secret staked the run's name). An `ownerReference` needs the owner's uid, so the owner must exist first.
- **The Secret references the Job by `uid`**, with `controller: false` and `blockOwnerDeletion: false`. Deleting the Job — by teardown, by `ttlSecondsAfterFinished`, by an operator, or by a successor launcher's `reap()` — makes the Secret garbage. **A create response with no `metadata.uid` refuses the run** rather than falling back to an unowned Secret.
- **The `finally` stays, demoted to what it is:** a latency optimisation over a guarantee that no longer depends on it.
- **A 409 on the Secret POST changed meaning.** It used to mean "another run holds this runId, touch nothing". It is now reachable only *after* a Job POST that did not 409, so it means "this run owns the name and there is orphan debris behind it whose owning Job is gone": tear down the Job this run created, delete nothing this run did not create, and let the collector take the debris — which makes the retry succeed rather than loop on the same 409 forever.

### 6a. THE COMBINATION THE OWNER ACCEPTED, named rather than footnoted

Granting the RBAC does not only add a Secret. It adds a Secret **to a runner that already keeps a routable network interface**, and the two compound. Both halves were surfaced by M23.2 rather than resolved, and by granting, the owner accepted them **together**:

1. **`--network none` is not honoured on Kubernetes and cannot be** (Decision recorded at M23.2, owner decision 1). No pod-spec field, annotation, `securityContext` or RuntimeClass removes a pod's network namespace. The strongest portable substitute is a deny-all-egress NetworkPolicy, which is **traffic denial, not interface absence** — and it is **fail-open on a CNI that does not enforce**. That is measured, not assumed: on kind + kindnet, a pod *selected* by a deny-all-egress policy reached a public IP and a resolver, indistinguishable from an unselected control. The adapter therefore carries the resolved mode as the pod label `scp.launcher.network` and **claims nothing**.
2. **A per-run Secret is at rest in etcd for the Job's life**, and in every etcd backup — longer-lived and more replicated than the mode-0600 `--env-file` it replaces, which lived for one `docker create`.

**The combination, stated plainly: on a cluster whose CNI does not enforce NetworkPolicy, a managed-iac runner holds a real cloud credential in its environment AND has an egress path to the internet.** On the Docker path `--network none` denied that path outright. This is a genuine reduction in containment for that deployment shape, and it is accepted because:

- **The alternative was not "a safer credential" but "no managed-iac on Kubernetes at all."** Refusing left the class dead on the substrate the product ships a Helm chart for, and pushed operators toward the docker-socket mount this chart explicitly refuses to paper over — a container-escape risk strictly worse than either half of this combination.
- **The credential is scoped and vaulted already** (charter Managed Execution Exception: "vaulted scoped credentials", per run, never tenant- or server-wide). What egress buys an attacker is bounded by that scope, not by the credential class.
- **The degradation is a property of the operator's CNI, not of this product**, and it is *observable* rather than hidden: the pod carries `scp.launcher.network=none` precisely so a policy written against that selector never silently selects nothing. An operator on Calico/Cilium loses nothing.
- **The etcd exposure is the lesser of the two available spellings.** The rejected alternative — `env[].value` — puts the same credential in the same etcd with no lifetime bound at all, and the adapter refuses to fall back to it even when the Secret path is unavailable.

**What is NOT accepted, and remains open:** enforcing `--network none` equivalence on Kubernetes (already listed under Consequences → Later, item 2). Granting the Secret RBAC makes that item **more** urgent, not less, and it is the thing to fix if this combination is ever judged unacceptable. Nothing in this decision should be read as closing it.

### 5. The whole-run budget (M23.1e), which amends Decisions 2 and 3

**`RunnerSpec.timeoutMs` is the WHOLE-RUN budget, and that is Accepted.** Not three constants re-sized: the property was *a per-call bound being used as a whole-run bound*, and three sites means the boundary is wrong, not that there are three edits.

- **One deadline, read once.** `run()` computes `deadline = now + timeoutMs` at its top and every `execFile` of the run proper is issued with `deadline - now`. A run therefore cannot exceed `timeoutMs`, so the host budget and the reap stamp are correct **by construction** rather than because a padding constant happened to be big enough.
- **At exhaustion, a step is refused before it is issued**, carrying `RunnerLaunchError.deadlineExceeded` and a message naming the budget and the deadline. **`timeout: 0` is Node's "no timeout at all"** (measured on the running Node: a 1.5s child ran to completion), and a negative `timeout` throws `ERR_OUT_OF_RANGE` synchronously with an unredacted argv in its message — so a naive `deadline - now` would restore the defect at exactly the moment a bound matters most.
- **The teardown is deliberately outside the budget** and keeps its own `RUNNER_REMOVE_TIMEOUT_MS`, because the commonest reason to reach it is that the budget is what ran out. `run()` therefore returns within `timeoutMs + RUNNER_REMOVE_TIMEOUT_MS`, and **that sum is what every outer budget must cover.**
- **`MANAGED_TRIGGER_GRACE_MS` becomes 60s**, re-derived rather than re-guessed: the only work after the deadline is one teardown capped at 30s, so 30s was wrong *by construction* — one worst-case teardown consumed the whole grace and left nothing for the `withRecordedOutcome` write and `saveState` the grace exists to protect. The **relationship** (`grace > RUNNER_REMOVE_TIMEOUT_MS`, and `RUNNER_REAP_GRACE_MS > grace`) is now gated by a test in `apps/server`, which is the side of the dependency that is allowed to import. The launcher's old note that "nothing CAN enforce this" was true only from the launcher's side.
- **`reap()` is scheduled, never awaited**, hard-bounded per pass by `RUNNER_REAP_BUDGET_MS`, and single-flighted per container CLI. A reap that is slow, wedged or failing can no longer delay `create` by a tick, consume a run's budget, or fail a run. The trigger point stays where Decision 3 put it — the top of `run()`, within one respawn of the event that orphans a container.
- **A `create` that fails on a NAME CONFLICT issues no teardown**, which closes Defect 4 without touching the naming. The signal is measured, not guessed (Docker 29.5.2: exit 1, `Conflict. The container name "/X" is already in use by container "<id>"`), and the match is deliberately the broad `already in use` substring shared across OCI CLIs, because `dockerBinary` is server-injected and the two errors are not symmetric: a false positive skips one teardown and leaves a container `reap()` collects on its deadline; a false negative destroys live infrastructure somebody else is running. **Every other create failure still tears down by name** — M23.0's Defect 1 must not regress, and both arms are tested.

### 4. Why none of this was caught by the existing test suite

**The real plugin is tested in isolation; the integration boundary is tested in isolation. They have never met in a test, so the wiring between them had no defect-catching surface.**

- The docker-spawning plugin (managed-iac, managed-scan, managed-dep) is imported and called directly in unit/integration tests. No plugin host, no RPC, no timeout budget derived from the manifest. The argv is proved correct, the redaction is proved at the port level, but the argv is never transmitted across an RPC and never reaches log infrastructure. Defects 1 and 2 are invisible because the path they exploit is not in the test's wiring.
- The plugin host (SubprocessPluginHost) is tested with a fast fake executor and an explicit `callTimeoutMs` override. The hang detector works correctly in isolation. Defect 2 is invisible because the timeout that defeats it is not in the test's wiring.
- `promotion-scan-step.ts` constructs managed-scan in-process with no test. The wiring is architectural and has no assertion.
- No test for two concurrent triggers of one `idempotencyKey` (Defect 4).

**The enforcement that would have caught it doesn't exist.** Charter principle 1 says "the platform does not hold credentials to the infrastructure that execution systems manage" — but this is not machine-checked. A credential appears on an argv or in an error message, and neither integration layer (unit test reaching the plugin; plugin-host test reaching a fake) is wired to inspect the other's output. A defect in the wiring between them is structurally invisible to both. **The only check that would work: delete the wiring and watch a test die.** Applied to everything this milestone built, and reported in BUILD_AND_TEST.md §8 (M23.1a, M23.1c, M23.1d).

## Consequences

### Immediate (M23.1)

1. Managed-iac and managed-dep's argv no longer carry `secretEnv` values (M23.1a).
2. Managed-scan's argv unchanged (its five secret paths stay in `env`, per the Kubernetes split).
3. Every `trigger()` rejection is caught and redacted (M23.1a, Phase 2).
4. The per-method budget removes the 10-second SIGKILL (M23.1c).
5. Orphaned containers from prior crashes are swept on each `run()` (M23.1d).

### Immediate (M23.4)

1. `managedRunners.kubernetes.perRunSecrets` defaults to **true**; the chart renders `secrets: create,delete` and managed-iac launches on Kubernetes.
2. The per-run Secret is owned by its Job (`ownerReferences`), so its deletion survives a SIGKILL of the launcher. Proved on a real cluster on the success path, the failure path, and by deleting the Job out from under a live run.
3. The credential path is proved end to end in-cluster — a real value reaching the runner's environment and appearing in no argv, no log, and no API object a reader can list — with a non-vacuity control that delivers the same value as `env[].value` and requires the sweep to find it.
4. Three chart defects found by granting it "for all three managed classes": the runner Role was gated on `managedIac.enabled` (so managed-dep and managed-scan got a token and no RBAC), `managedScan.runnerImage` did not exist at all, and the Role ignored `managedRunners.kubernetes.namespace`.

### Later

1. **M23.2** must add a Kubernetes adapter that uses the same `secretEnv`/`env` split, proving the port's axis was correct.
2. **M23.2** must enforce `--network none` equivalence on the Kubernetes path (a deny-all-egress NetworkPolicy), making the network isolation symmetry real. **Still open, and Decision 6 raised its priority rather than lowering it:** the runner now holds a mounted credential as well as a routable interface, so the fail-open CNI case is the combination named in §6a.
3. **Defect 2 (managed-scan, still open)** — the plugin's outer error handling must be fixed to record every failure, in the same shape managed-iac and managed-dep now use.
4. **Defect 3 (promotion-scan-step in-process call)** — must route through the plugin host, or be split into a separate executor type with its own per-method budget.
5. **M24.3+** — the audit event this work creates (federation.promotion.scan.runner_failed) must be wired to an operator UI so the bypass of Defect 2's outcome recording is visible.

## Notes

1. **Retry-stable naming cost (Decision 1, Defect 4) — CLOSED by Decision 5 (M23.1e), not accepted.** This note said a `create` that fails because the name is taken tears down the live run, that it is reachable only for two concurrent triggers of one `idempotencyKey`, and that the trade was known. The reachability was right and the trade was false: the conflict is distinguishable from every other create failure, so the teardown is skipped for that one case and the naming is untouched. Recorded here rather than deleted, because "documented, not an oversight" is exactly the shape CLAUDE.md warns about — a well-written comment naming a hazard is a signal to sweep, not evidence it was handled.

2. **The `--env-file` path disclosure:** When `create` fails, the path appears in the error message briefly before redaction. The redaction set includes the path explicitly to catch this and any other reference to the file path. If `create` runs asynchronously in the future (M23.2 for Kubernetes), the unlink must be guarded by the same outcome-recording mechanism that makes the redaction exact.

3. **Defect 2 still open — managed-scan:** The plugin's copy-out can fail unguarded; the failure escapes `trigger()`. Fixed structurally in M23.1a Phase 2 (every `trigger()` rejection is now caught and recorded), but the plugin code itself still carries the shape. Not this ADR's fix (plugin-level, not port-level), but named as the item that survives.

4. **The audit event for runner failures:** `federation/promotion-scan-step.ts` now deposits `federation.promotion.scan.runner_failed` with the error reason intact when a runner dispatch fails. This is NOT deposited as scan evidence (would misrepresent "couldn't scan" as "scanned clean"), and the event is NOT YET visible in any operator UI. Creating the event proves the wiring; displaying it is a follow-on.
