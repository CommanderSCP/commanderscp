# background-work

Reference for `apps/server/src/background-work.ts`. The source carries a one-line headline at each site and points here.

> Partial: 3 of 12 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. THE BACKGROUND-WORK COMPOSITION

THE BACKGROUND-WORK COMPOSITION — every loop this process starts, as an IMPORTABLE VALUE
This module exists for ONE reason: so that "the composition root starts the loops, and stops them on shutdown" can be proven by RUNNING it instead of by matching text in `main.ts`.

`main.ts` calls `main()` at module scope, so no test can import it. Every wiring claim about it was therefore a substring match, and a substring match cannot tell a live call from a dead one. That was not a theoretical weakness — it was measured, twice:

```text
- commenting `startBumpDispatchLoop(…)` out of `main.ts` left `bump-dispatch.test.ts` green at
  20/20, INCLUDING a case named "starts the worker, and stops it on shutdown", and left the
  whole `apps/server` unit suite green at 972/972 (M21.7);
- making the enclosing `if (runsBackgroundWork)` branch unreachable — a one-token edit — left
  ALL of `bump-dispatch`, `bump-gate`, `inventory-ingestion` and `domain-event-routers` green
  at 79/79, with all eleven loops dead. `domain-event-routers.test.ts` had named this exact
  mutation as a known-uncovered edge; it is closed by this module and no longer a text problem.
```

This is the SAME MOVE M21.7 made for domain-event routers, and for the same reason: the router list moved out of `main.ts` into `events/domain-event-registry.ts`, a pure importable value, and its census went from matching four conditional registrations to executing one function. This is that move for the eleven background loops. `background-work.test.ts` starts every entry below against a probe `boss` and asserts what actually happened.

WHAT IS DELIBERATELY *NOT* HERE. The pg-boss handle, the outbox relay, the NATS fan-out and the commander poke sender stay in `main.ts`. They are not loops: they are the substrate the loops run on, they are constructed in a fixed order with interdependencies, and two of them need the raw `Pool` rather than the `Db`. Moving them here would buy a bigger extraction and a worse one — the registry's value is that every entry has the SAME shape, so a new loop cannot be added in a shape the census does not check.

ADDING A LOOP: add it to `BACKGROUND_LOOPS`. Nothing else. `background-work.test.ts` discovers every `start…Loop` in the tree and fails if one is neither registered here nor explicitly exempted with a reason, so forgetting this step is a red test rather than a capability that silently never runs.

## §2. Does THIS process own background work?

Does THIS process own background work?

Extracted from `main.ts`'s inline `config.role === "all" || config.role === "worker"` so the predicate is importable and therefore testable. The inline version was the subject of the measured mutation above: setting it `false` killed all eleven loops with a fully green suite, because no test could reach it.

`role === "api"` is a pure request server for everything EXCEPT request-scoped plugin dispatch — `main.ts` constructs the plugin host for every role (#200), and that is deliberately NOT gated on this.

## §3. Does THIS process CREATE the bootstrap admin?

Does THIS process CREATE the bootstrap admin?

Only the HTTP-serving roles, and that is the whole point rather than an optimisation.

THE BUG THIS CLOSES (measured 2026-08-29, reproduced 3/3). `ensureBootstrapAdmin` used to run UNCONDITIONALLY in every process. In the chart's default split topology the api and worker pods boot at the same moment against the same empty database, so WHICHEVER WINS creates the admin and prints the one-time password — and that password is generated, shown once, and never stored. When the worker won, the api logged "bootstrap admin 'admin' already exists, skipping" and the only copy of the credential was in the WORKER's log.

That is not merely untidy. Every operator-facing instruction — the chart NOTES, the docs, and `scripts/kind-drill.sh`, which polls the api pod and fails with "could not capture the bootstrap one-time password" — says to read the API pod's log. So on an unlucky boot the credential the whole install depends on was written somewhere nobody is told to look, with no error anywhere.

Tying creation to the role that serves HTTP makes the password's location a PROPERTY OF THE DEPLOYMENT rather than of who won a startup race.

WORKER-ONLY DEPLOYMENTS DO NOT BOOTSTRAP, deliberately: an install with no api has nothing to serve the credential to, and the chart always deploys an api (`role: all` covers the single-process case). A worker that starts first simply finds no org yet and picks it up on a later tick — its loops are all org-scoped queries, not a one-time init.

NOT A FULL MUTUAL EXCLUSION: two api REPLICAS can still race each other. That path is already safe-by-construction rather than by this predicate — the loser's `existingAdmin` check returns early and logs "already exists, skipping" — so this fixes WHERE the password lands, which is what was broken and what was measured.
