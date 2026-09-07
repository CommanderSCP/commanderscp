# plugin-testkit

Long-form reference for the **plugin-testkit** subsystem — the rationale, hazards and open items that
used to sit inline. Each source file below carries a one-line headline at the site and points here.

> Partial: 14 of 14 multi-line comment blocks in this subsystem are here. The rest are
> still inline, pending a hand-written one-line headline.

## Files

- [`packages/plugin-testkit/src/index.ts`](#packages-plugin-testkit-src-index-ts) — §1–§9
- [`packages/plugin-testkit/src/runner-image.test.ts`](#packages-plugin-testkit-src-runner-image-test-ts) — §10–§10
- [`packages/plugin-testkit/src/runner-image.ts`](#packages-plugin-testkit-src-runner-image-ts) — §11–§12
- [`packages/plugin-testkit/vitest.config.ts`](#packages-plugin-testkit-vitest-config-ts) — §13–§14

## `packages/plugin-testkit/src/index.ts`

### §1. Public per-interface conformance suites for operators

@scp/plugin-testkit — public per-interface conformance suites (DESIGN.md §11: "`@scp/ plugin-testkit` ships public per-interface conformance suites, so operators can vet a third-party plugin before baking it into an air-gap image — the only vetting point a disconnected site gets"; BUILD_AND_TEST.md §4.2 "every shipped plugin runs the relevant `@scp/plugin-testkit` suite in its own package tests").

M3 (BUILD_AND_TEST.md §8 M3 item 7) is the first real implementation: only `ExecutorPlugin` has a shipped implementation (the in-repo fake executor) to conform against, so only its suite exists here. The other five `@scp/plugin-api` interfaces get their own `run*ConformanceSuite` exports the same way once M4/M6/M7 ship a real implementation to test.

Deliberately generic: every assertion checks only the SHAPE the `ExecutorPlugin` contract itself promises (well-formed capabilities/refs/phases/events) — never fake-executor-specific behavior (exact version numbering, file-backed state, timing). That's what lets a REAL executor plugin (GitHub/ArgoCD, M7) reuse this exact suite later against a live or fixture-backed instance, and what lets an operator vet an arbitrary third-party plugin with it before trusting it into an air-gap image.

### §2. Re-exports the tracked tempdir allocator to every fixture

Re-exported so every fixture that already imports from this package for the conformance suites themselves — every `*.conformance.test.ts` in `packages/plugins/*` — gets the tracked-tempdir allocator for free, with no new `package.json` dependency. Each fixture's factory calls `runExecutorConformanceSuite`'s `factory` once PER `it()` (see that export below), so a fixture that `mkdtemp`s its own `statePath` leaks one directory per assertion in the shared suite if it uses the raw allocator instead of this one — see `@scp/test-tmpdir`'s module doc for the class this closes.

### §3. MAJOR #4 (adversarial review)

MAJOR #4 (adversarial review): optionally simulate a SUBPROCESS RESTART — return a FRESH plugin instance + ctx that share the FIRST fixture's DURABLE dedup state (i.e. the same on-disk `statePath`), NOT the first instance's in-process memory. If provided, the idempotency conformance test fires the two `trigger()` calls across this restart, proving the dedup guarantee survives the exact crash/resume scenario `coordination/reconcile.ts`'s three-step design targets (a retry after the subprocess died must NOT re-fire the real side effect). A fixture that only supports in-memory dedup omits this, and the test falls back to same-instance dedup (still correct, just a weaker guarantee — which is why the server ALWAYS injects a durable statePath for real executor instances, `executor-bindings-repo.ts`).

### §4. Runs the executor suite on a fresh instance per test

Runs the `ExecutorPlugin` conformance suite against a fresh plugin+ctx built by `factory` — called once per `it()` so each assertion starts from a clean instance rather than accumulating state across the suite (a shipped plugin's own package test wires this up, e.g. `runExecutorConformanceSuite("fake-executor", async () => ({ plugin, ctx }))`).

### §5. Same idempotency key, same run, no duplicate effect

M7 (BUILD_AND_TEST.md §8 M7 item 6 — a tracked M3 item, now due): "extend the Executor conformance suite to assert an executor honors `idempotencyKey` (same key ⇒ same external run, no duplicate side effect)". `coordination/reconcile.ts`'s crash-safe `triggerWaveTarget` (DESIGN §9.3) depends on EVERY real executor plugin honoring this — a retry after a crash/resume re-derives the SAME `idempotencyKey` and must get back the SAME `ExternalRunRef` rather than firing a second real run. Two DIFFERENT keys, by contrast, must be free to mint different runs (this suite doesn't assert they're forced to differ — a plugin's own state might legitimately coincide — only that a REPEATED key never diverges, which is the actual safety property the engine relies on).

### §6. ControlPlugin conformance: contract shape only

ControlPlugin conformance (DESIGN.md §10.2, BUILD_AND_TEST.md §8 M4 item 2) — M4's first real implementation to conform against (`@scp/plugin-webhook-control`). Same generic-shape-only discipline as the executor suite above: every assertion checks only what the `ControlPlugin` contract itself promises (a well-formed `ControlOutcome`), never webhook-control-specific behavior, so a future real control plugin can reuse this suite unchanged.

### §7. Runs the control suite on a fresh instance per test

Runs the `ControlPlugin` conformance suite against a fresh plugin+ctx+request built by `factory` — called once per `it()`, mirroring `runExecutorConformanceSuite`'s per-test isolation.

### §8. DiscoveryPlugin conformance: a well-formed proposal only

DiscoveryPlugin conformance (DESIGN.md §11, BUILD_AND_TEST.md §8 M7) — `@scp/plugin-github`'s discovery half is the first real implementation. Shape-only, same discipline as every other suite here: asserts `discover()` returns a well-formed `DiscoveryProposal`, never that it found any particular thing. The "never auto-commits" guarantee DESIGN §11 requires is NOT (and cannot be) asserted here — `discover()` has no graph access at all, structurally, so there is nothing for this plugin-level suite to observe about commit behavior; that guarantee is proven at the server layer instead (routes/executors.integration.test.ts: `/discovery/run` never writes to the graph, only `/discovery/accept` does).

### §9. NotificationPlugin conformance: a failure is not a throw

NotificationPlugin conformance (DESIGN.md §11, BUILD_AND_TEST.md §8 M7) — `@scp/plugin- webhook-notify`/`@scp/plugin-smtp-notify`'s first real implementations. Same shape-only discipline: asserts `send()` returns a well-formed `DeliveryResult` and never throws even when delivery itself fails (a notification's own failure must never propagate as an exception to whatever engine seam called it — coordination/watchdog.ts, notify/dispatch.ts).

## `packages/plugin-testkit/src/runner-image.test.ts`

### §10. `resolveRunnerImage` HAD NO TESTS, and it is not a stub

`resolveRunnerImage` HAD NO TESTS, and it is not a stub: it decides whether a real-Docker integration test pulls a pre-built image or spends minutes building one, and it is called from three integration suites. The CI branch — `process.env[refEnvVar]` set by the `runner-images` job — is pure, needs no daemon, and is the branch every CI run takes.

THE ASSERTION THAT MATTERS IS THE ABSENCE: with a ref present, NO `docker build` may be spawned. A regression that fell through to the build would still return a usable image locally and would only show up as CI minutes, which is exactly the kind of thing nothing notices.

WHAT IT DOES NOT COVER: the fallback build arm (it spawns `docker build` for real) and the `DOCKER_BUILDKIT=0` env it passes are asserted here only through the recorded call, not executed.

## `packages/plugin-testkit/src/runner-image.ts`

### §11. Env var CI sets to a pre-pulled image ref

Env var CI sets to a pre-pulled image ref (e.g. `SCP_RUNNER_SCAN_IMAGE_REF`). When present, the image is already on this host (the CI `runner-images` job built + pushed it to GHCR by content hash, and the integration job's pre-step `docker pull`ed it) — so we RETURN the ref and never build.

### §12. Resolve the runner image: CI ref, else local build

LEVER 1 — prebuild + publish runner images; tests PULL with a local-build fallback.

Resolves the runner image a real-Docker integration test should run: - CI path: `process.env[refEnvVar]` is set to the content-hash GHCR ref that the `runner-images` job built + pushed and the integration job `docker pull`ed. We RETURN it — no build, so the test stops paying a multi-minute `docker build` on every run. - Local-dev fallback (env unset): `DOCKER_BUILDKIT=0 docker build -t <localTag> <context>` and RETURN `localTag`. Behavior is unchanged from before this lever — same legacy-builder build.

`DOCKER_BUILDKIT=0` forces the LEGACY builder (PR #126). The failure it avoids: when ONE daemon both builds runner images AND creates `--network none` scan containers, modern BuildKit's persistent embedded gRPC session can deadlock against those net=none container ops ("session healthcheck failed fatally: Unavailable: … only one connection allowed"), hanging the run. It was first hit inside the homelab DinD sidecar, which made it far easier to provoke.

SCOPE (narrowed when CI moved to GitHub-hosted runners): this flag now applies ONLY to this local-dev fallback, which is exactly the case that still builds and runs net=none containers in a single daemon. The CI `runner-images` job no longer sets it — it runs on a native (non-DinD) daemon and only builds and pushes, never creating a net=none container, so the wedge cannot occur there. It is kept HERE because the local-dev shape is unchanged and untested against BuildKit; this is a deliberate retention, not leftover cargo cult.

A SECOND, independent reason to keep the legacy builder: both runner Dockerfiles begin `# syntax=docker/dockerfile:1.7`, a BuildKit-ONLY frontend directive. The legacy builder treats it as an inert comment; BuildKit treats it as live and pulls that frontend image from Docker Hub on a cache miss — an unauthenticated external dependency (charter principle 5). Note apps/runner-scan/Dockerfile is also MULTI-stage (`FROM ... AS trivy` + `COPY --from=trivy`), which the legacy builder handles fine. (An earlier revision of this comment claimed these were "plain single-stage ... with no BuildKit-only features" — both halves were false.) Do NOT re-enable BuildKit here without re-solving the single-daemon session wedge AND vendoring or pinning the frontend image (docs/BUILD_AND_TEST.md §6).

## `packages/plugin-testkit/vitest.config.ts`

### §13. THE PER-TEST BUDGET, DECLARED RATHER THAN INHERITED

THE PER-TEST BUDGET, DECLARED RATHER THAN INHERITED (M23.1f clause 6).

Vitest's implicit default is 5,000ms. `@scp/runner-launcher` ran its unit suite on it while holding the repo's heaviest sweeps and flaked 5 runs in 23 of `pnpm -w test` — never once in 420 isolated runs, because isolation is the wrong load profile: what consumes the headroom is the 109-task parallel graph, not the test. `apps/server` had already raised its own budget for exactly this reason in 2026-08 and the sibling packages were left on the default, which is the incomplete-call-site-census property CLAUDE.md names.

The rule is now machine-checked by `@scp/source-census`'s `test-budget-census.test.ts`: every package whose `test` script is vitest must DECLARE a number, and that number must be one the census table names. This is headroom, not a slow-test licence — a passing test is unaffected by the budget, so the only cost is that a genuinely wedged test takes longer to be declared dead.

### §14. The hook budget: a second deadline nobody chose

THE HOOK BUDGET, declared for the reason `@scp/source-census`'s `test-budget-census.test.ts` gives in full: vitest's `hookTimeout` is a SECOND, independent deadline whose implicit default (10,000ms) nobody chose, and the only hook cost this repo has ever measured under CI's load profile — `@scp/cli`'s lazy-import warm-up — was 5,400ms against it. 30,000 is 25x the isolated worst case in the unit layer (1,205ms) and half the un-declarable 60,000ms `onTaskUpdate` RPC deadline a synchronous hook would otherwise be free to cross.
