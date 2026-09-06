# kubernetes-adapter.test

Reference for `packages/runner-launcher/src/kubernetes-adapter.test.ts`. The source carries a one-line headline at each site and points here.

> Partial: 4 of 35 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. WHICH PORT STEP AN OP MARKS

WHICH PORT STEP AN OP MARKS — the Kubernetes spelling of `docker-adapter.test.ts`'s `stepKind(args)`, and derived the same way: from what was SENT, not from a flag the adapter set for the test's benefit.

ONLY THE FIRST OP OF EACH STEP MARKS IT, and the rule is structural rather than a de-duplication hack: `start` is one PATCH followed by N status GETs and one log GET, and `teardown` is a Job DELETE followed by a Secret DELETE and a directory removal. The op that MARKS the step is the one that cannot happen twice — the PATCH, the Job DELETE, the Job POST — so a step is recorded exactly once no matter how long its tail is. Everything else returns `undefined` and is invisible to `issued()`, including the `reap()` listing GET that every `run()` schedules.

## §2. M23.5 VERIFICATION PASS 18

M23.5 VERIFICATION PASS 18 — WHAT A LAUNCHER THAT COULD NOT SEE IS ALLOWED TO SAY

`!everStarted` MEANT TWO THINGS AT ONE SITE. "Observed, and nothing had started" — the fact D2's fix rests on — and "never observed at all", which is not a fact about the run at all. The second was unguarded, and MEASURED against a real cluster it is the one that happens: the unsuspend PATCH reaches the API server and succeeds, every `GET pods` after it stalls past the budget, the real Job and the real kubelet do the work, a real container writes a real file to the real volume — and the durable record says `spawn-failed: … so NOTHING RAN and nothing was mutated — the Job had not yet been observed`. THE EVIDENCE THAT THE CLAIM IS UNFOUNDED IS IN THE SAME SENTENCE AS THE CLAIM.

TWO MUTATIONS SURVIVED THE WHOLE SUITE BEFORE THESE CASES EXISTED, and each has its arm below: S1  `let waiting = "the Job had not yet been observed"` -> "the pod was observed and no container had started": a lie about what was observed, in the operator-facing detail. 377/377 green. Nothing pinned the never-observed case at all. S2  `api()`'s `const deadlineExceeded = runDeadline.spent()` -> `= true`: 377/377 unit AND 18/18 kind green. Nothing pinned that a transport failure with budget LEFT is not a budget exhaustion, in either adapter's spelling.

## §3. A TRANSPORT THAT ANSWERS NOTHING

A TRANSPORT THAT ANSWERS NOTHING — `AbortSignal.timeout` firing on every `GET pods`, which is what an API-server stall or a partition looks like from inside this adapter. Unconditional, unlike D2's `abortingPodGetIo`, which only fires near the deadline and therefore always leaves the run an observation to reason from: the WHOLE point here is a run that never gets one.

`letThrough` reads succeed first, so the same fixture produces the negative control — one landed observation, and the verdict is entitled to say nothing started again.

## §4. THE KUBERNETES SUBSTRATE

THE KUBERNETES SUBSTRATE.

`ordering-conformance.ts` was written for this moment and says so: "M23.2 adds a Kubernetes-Job adapter... The Kubernetes adapter inherits every case below by writing a substrate, not by re-deriving the race." This is that substrate, and every one of the ten cases is MEANINGFUL for a Job-based launcher — none is skipped. Two are worth naming because their premise changes shape:

```text
THE COPY-INS ARE SEQUENTIAL. On Docker the hazard is two `docker cp`s racing into one container
and racing `start`. Here the copies are ordinary filesystem writes into a shared volume, and the
race they would lose is worse rather than milder: an unawaited copy-in lets the PATCH that
unsuspends the Job fire while bytes are still landing, so the runner starts against a partial
workspace. Same case, same assertion, a hazard that is if anything sharper.
```

```text
WITH NO COPY-OUT, TEARDOWN STILL WAITS ON `start`. Its `issued()` expectation is
`["create","start","teardown"]`, i.e. it requires `create` and `start` to be TWO issued steps. A
Job is created running, and an adapter that collapsed them would fail this case. `suspend: true`
is what keeps them two, and it is the right answer for an independent reason (the name must be
staked before the bytes move) — so this case is not merely satisfied, it is the check that the
design decision stayed made.
```

WHAT IT STILL CANNOT SEE, inherited verbatim from the Docker substrate's own caveat: it proves each step is awaited before the next is ISSUED; it does not prove the process the adapter waited on is the one that finished. Here that gap is wider than on Docker — a held PATCH is not a running pod — and `kubernetes-adapter.integration.test.ts` against a real kind cluster is the only thing that can close it.
