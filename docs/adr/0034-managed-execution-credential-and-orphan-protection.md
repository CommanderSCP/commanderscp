# ADR-0034: Managed execution — credential exposure, orphan containers, and the enforcement layering that catches neither

**Status:** **Accepted (2026-08-18)** — four decision points decided by the owner on 2026-08-18, before this milestone's code was written. Three fixes land in M23.1 and M23.2 (pending). **This ADR records the defects found in production (managed-iac live on main, credential-readable from host process table and `docker inspect`; the 10-second SIGKILL defeating every run over 10 seconds; orphaned containers from crash-killed subprocesses), their fixes, and the fundamental enforcement-layering reason none of it was caught by any existing test.**

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

The port computes the container NAME before `create` is issued, so the teardown can address it even when `create` fails. A `create` that fails **because the name is already taken** then runs its unconditional teardown and **destroys the run that legitimately holds it**. Reachable for two concurrent triggers of one `idempotencyKey` (managed-iac's dedup cache missed them both). This is the trade — **retry-stable and per-attempt naming cannot both be had**; the instruction chose stable naming, and this is the cost. Documented, not unknown.

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

- **`trigger()` on a managed executor gets that instance's resolved `timeoutMs` + 30s grace** (`MANAGED_TRIGGER_GRACE_MS`), sized so the plugin's inner `execFile` timeout fires first — it is the only one attached to cleanup code (`rm -f`, `withRecordedOutcome`, `saveState`).
- **Everything else keeps the 10s hang detector**, unchanged.
- **NO transparent crash-retry for a managed `trigger`.** The change widens the crash window from ≤10s to ≤10.5 min, and `call()`'s transparent retry re-enters an apply whose ledger entry is by construction not yet written, colliding on the container name derived from the same `idempotencyKey` — whose unconditional teardown then `rm -f`s the run that legitimately holds it.

**The tenant-settable `timeoutMs` ceiling is Accepted.** All three manifests shipped `{ type: "integer", minimum: 1000 }` with **no maximum**. `MANAGED_RUN_TIMEOUT_MAX_MS` (1 hour, 6× the largest default) is Accepted as the ceiling. Ajv honours `maximum`, so `validatePluginConfig` enforces it at all four write doors. The host **reads those bounds off the manifest** rather than re-declaring them, and **clamps** — rows stored before the ceiling existed are never re-validated on read. **The ceiling is what makes the deadline predicate computable at all** (see Decision 3).

### 3. Orphaned containers and the reaper

**The reaper labelling strategy and sweep predicate are Accepted.**

Every container now carries:

- **`scp.launcher.owner`**: a UUID minted **once per Node process**, at module load (not per run, because a plugin resolves a fresh launcher on every `trigger()` and a per-call id would make the long-lived subprocess unable to recognise its own prior container as its own).
- **`scp.launcher.deadline`**: RFC3339, `create-time + timeoutMs + RUNNER_REAP_GRACE_MS` (2 minutes, sized past the 30s grace so a legitimate peer is never swept early).

`RunnerLauncher.reap()` is called at the top of every `run()`, before `create`:

- Lists launcher-owned containers via `docker ps -a --filter label=scp.launcher.owner`.
- Removes only those that are BOTH foreign (`owner != mine`) AND past their own deadline.
- Best-effort throughout; the pre-existing silent teardown swallow now logs via `NODE_DEBUG=scp-runner-launcher`.

**That the reaper issues `docker rm -f` on containers this process did not create is Accepted.** This is **containment hygiene inside the existing Managed Execution Exception**, not a widening of it — the exception already permits the managed plugins to run orchestration code (exec/plan/apply); the sweep is the cleanup half of that same orchestration. Containment is **enforced at the label**: a container without `scp.launcher.owner` (e.g. a pre-existing orphan on the machine) is excluded by the daemon's own `--filter` before any of its state reaches this process.

**What the reaper does NOT do (still open).** Nothing sweeps the reap labels' OWNER identity for a replica that scales down permanently — its containers become reapable only once their deadline passes, same as a crash, which is correct but means a deliberate scale-down is not distinguishable from a crash for sweep-latency purpose. `abort()` head-of-line-blocked by a long `trigger()` (Defect 2 still open) remains unfixed.

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

### Later

1. **M23.2** must add a Kubernetes adapter that uses the same `secretEnv`/`env` split, proving the port's axis was correct.
2. **M23.2** must enforce `--network none` equivalence on the Kubernetes path (a deny-all-egress NetworkPolicy), making the network isolation symmetry real.
3. **Defect 2 (managed-scan, still open)** — the plugin's outer error handling must be fixed to record every failure, in the same shape managed-iac and managed-dep now use.
4. **Defect 3 (promotion-scan-step in-process call)** — must route through the plugin host, or be split into a separate executor type with its own per-method budget.
5. **M24.3+** — the audit event this work creates (federation.promotion.scan.runner_failed) must be wired to an operator UI so the bypass of Defect 2's outcome recording is visible.

## Notes

1. **Retry-stable naming cost (Decision 1, Defect 4):** A `create` that fails because the name is taken tears down the live run. This is reachable in production only if two concurrent triggers of one `idempotencyKey` both miss the dedup cache. Revisit if concurrent same-key triggers prove reachable in practice; the trade is known and documented, not an oversight.

2. **The `--env-file` path disclosure:** When `create` fails, the path appears in the error message briefly before redaction. The redaction set includes the path explicitly to catch this and any other reference to the file path. If `create` runs asynchronously in the future (M23.2 for Kubernetes), the unlink must be guarded by the same outcome-recording mechanism that makes the redaction exact.

3. **Defect 2 still open — managed-scan:** The plugin's copy-out can fail unguarded; the failure escapes `trigger()`. Fixed structurally in M23.1a Phase 2 (every `trigger()` rejection is now caught and recorded), but the plugin code itself still carries the shape. Not this ADR's fix (plugin-level, not port-level), but named as the item that survives.

4. **The audit event for runner failures:** `federation/promotion-scan-step.ts` now deposits `federation.promotion.scan.runner_failed` with the error reason intact when a runner dispatch fails. This is NOT deposited as scan evidence (would misrepresent "couldn't scan" as "scanned clean"), and the event is NOT YET visible in any operator UI. Creating the event proves the wiring; displaying it is a follow-on.
