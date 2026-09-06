# ordering-conformance

Reference for `packages/runner-launcher/src/ordering-conformance.ts`. The source carries a one-line headline at each site and points here.

> Partial: 3 of 9 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. THE AWAIT-ORDERING CONFORMANCE SUITE

THE AWAIT-ORDERING CONFORMANCE SUITE — ADAPTER-NEUTRAL, AND REUSED BY EVERY ADAPTER

WHY THIS EXISTS AS ITS OWN FILE. `docker-adapter.test.ts` proves WHAT the adapter puts on the command line. It cannot prove WHEN, and for a while nobody noticed: its recording seam invoked every `execFile` callback SYNCHRONOUSLY, so each step resolved before the next line of the adapter ran and the recorded array was ISSUE order — which is identical whether a step was awaited or fired and forgotten. Twenty tests, twenty mutations "caught", and these two both SURVIVED:

```text
  await pending.catch(() => undefined);              ->   void pending.catch(() => undefined);
  await execFileAsync(docker, ["rm", "-f", id], …)   ->   void execFileAsync(…)
```

managed-iac's copy-out arm is `when: "always", onFailure: "swallow"`. Drop the first await and the `finally { docker rm -f }` fires while `docker cp <id>:/workspace/. <workspaceDir>` is still streaming: the container dies mid-copy, `plan.json` lands truncated or absent, `run()` still returns `{ succeeded: true }`, and the plugin caches a succeeded apply with no evidence — with the whole build green.

WHY IT IS PARAMETERISED RATHER THAN TWO MORE DOCKER TESTS. M23.2 adds a Kubernetes-Job adapter and will be written against `docker-adapter.test.ts` as its conformance contract. Ordering is not a Docker property — a Job adapter that deletes the Job while the evidence copy is still streaming loses exactly the same plan.json — so these checks are expressed over the PORT's five lifecycle steps, and an adapter supplies a `LaunchOrderingSubstrate` that can hold one step open. The Kubernetes adapter inherits every case below by writing a substrate, not by re-deriving the race.

WHAT A SUBSTRATE MUST DO, AND THE ONE THING THAT MAKES IT HONEST: a held step must be ISSUED and must NOT SETTLE.

CORRECTED CREDIT (this used to say a substrate that delayed the ISSUE instead of the settle "would make every held case below pass vacuously — which is why the first case is the UNHELD CONTROL". Measured false: forcing a held step's recording to wait for delivery instead of happening at issue time reddens EIGHT of the nine held cases directly — each one's own pre-release assertion that the held step already appears in `issued()` fails — while the unheld control, which holds nothing, passes unaffected. The protection is real; it lives in the held cases' own assertions, not in the control. The control's actual job is the one stated in its own name below: proving the substrate issues the full sequence AT ALL, so a held case with a step simply missing from `issued()` can be read as "the hold ate it" rather than as "nothing here works."

THE SECOND DESCRIBE IS ABOUT IDENTITY, NOT ORDER, and it is here for the same inheritance reason. Every case above — and every case in `docker-adapter.test.ts` — has exactly ONE `run()` in flight, so one run's steps are the only steps there are and nothing can catch a per-run value kept somewhere shared. Hoisting `const containerId` (index.ts:200) to module scope typechecks clean and passed all thirty tests of the M23.1 suite; with two runs in flight it makes one run's `rm -f` destroy the OTHER run's container, orphaning the first with its resolved credentials still in its environment and tearing the second down twice. That is not a Docker property either: a Job adapter that kept the Job name in a module binding loses exactly the same way, so the case is expressed over identities and inherited by writing a substrate.

## §2. ONE CASE'S BOOKKEEPING

ONE CASE'S BOOKKEEPING. It exists for a reason found the hard way: the first draft let a FAILED case leave a run in flight with a step still held, and when the next case reset the recorder that abandoned run resumed and interleaved its steps into the next case's recording — turning one real failure into four bogus ones with unreadable diffs. `Case.cleanup` releases whatever is still held and awaits the run, so a failing case fails alone.

## §3. WHAT THIS CATCHES, EXACTLY

WHAT THIS CATCHES, EXACTLY. Hoisting `containerId` out of the `run()` body to module scope typechecks clean and passes every other test in this package, because no other test has two `run()` calls in flight — one run's steps are always the only ones there are. Under that mutation the second run's later steps address the FIRST run's container and both teardowns `rm -f` the same id: one container is orphaned still holding whatever the run gave it, and the other is destroyed twice, the second time out from under a live run.

PER-RUN IDENTITY IS NOW TWO THINGS, NOT ONE, and both are covered by the same partition: the container id `create` returns, and the `--name` the CALLER chose (`RunnerSpec.runId`), which is what teardown addresses. A substrate reports them under one identity — see the Docker substrate's `stepIdentity` — so a teardown aimed at the OTHER run's name fails here exactly as a copy aimed at the other run's id does. That is why the substrate must hand out a distinct `runId` per run: two runs sharing one name is the same bug wearing new clothes, and with managed-iac deriving `runId` from `intent.idempotencyKey` it is reachable in production by two concurrent triggers of one key.

It is not a live bug today — `index.ts` holds no module-level mutable state — and that is the reason to pin it rather than to skip it: the three managed plugins are three pg-boss `work()` handlers in ONE Node process, so two `run()` calls across plugins overlap as a matter of course, and this suite's own framing (a substrate that holds a step OPEN) is an invitation to park per-run state where it is convenient.
