# server

Long-form reference for the **server** subsystem — the rationale, hazards and open items that
used to sit inline. Each source file below carries a one-line headline at the site and points here.

> Partial: 104 of 107 multi-line comment blocks in this subsystem are here. The rest are
> still inline, pending a hand-written one-line headline.

## Files

- [`apps/server/drizzle.config.ts`](#apps-server-drizzle-config-ts) — §1–§1
- [`apps/server/src/app.ts`](#apps-server-src-app-ts) — §2–§10
- [`apps/server/src/background-work.test.ts`](#apps-server-src-background-work-test-ts) — §11–§14
- [`apps/server/src/background-work.ts`](#apps-server-src-background-work-ts) — §15–§26
- [`apps/server/src/boot-checks.ts`](#apps-server-src-boot-checks-ts) — §27–§27
- [`apps/server/src/bundled-argocd-autowire-bin.ts`](#apps-server-src-bundled-argocd-autowire-bin-ts) — §28–§28
- [`apps/server/src/bundled-gitea-autowire-bin.ts`](#apps-server-src-bundled-gitea-autowire-bin-ts) — §29–§29
- [`apps/server/src/config.ts`](#apps-server-src-config-ts) — §30–§51
- [`apps/server/src/domain-id-edge.ts`](#apps-server-src-domain-id-edge-ts) — §52–§53
- [`apps/server/src/error-handler-status.test.ts`](#apps-server-src-error-handler-status-test-ts) — §54–§55
- [`apps/server/src/errors.ts`](#apps-server-src-errors-ts) — §56–§61
- [`apps/server/src/http-limits.ts`](#apps-server-src-http-limits-ts) — §62–§62
- [`apps/server/src/idempotency.ts`](#apps-server-src-idempotency-ts) — §63–§64
- [`apps/server/src/json-body-parser.test.ts`](#apps-server-src-json-body-parser-test-ts) — §65–§68
- [`apps/server/src/main.ts`](#apps-server-src-main-ts) — §69–§81
- [`apps/server/src/migrate-bin.ts`](#apps-server-src-migrate-bin-ts) — §82–§83
- [`apps/server/src/pagination.ts`](#apps-server-src-pagination-ts) — §84–§86
- [`apps/server/src/seed.integration.test.ts`](#apps-server-src-seed-integration-test-ts) — §87–§87
- [`apps/server/src/seed.ts`](#apps-server-src-seed-ts) — §88–§93
- [`apps/server/src/types.ts`](#apps-server-src-types-ts) — §94–§98
- [`apps/server/vitest.config.ts`](#apps-server-vitest-config-ts) — §99–§103
- [`apps/server/vitest.integration.config.ts`](#apps-server-vitest-integration-config-ts) — §104–§104

## `apps/server/drizzle.config.ts`

### §1. Forward-only migrations, diffed against the snapshot

drizzle-kit generates committed, forward-only SQL migrations under ./drizzle (BUILD_AND_TEST.md §3.2). No live database connection is required.

IT DIFFS AGAINST `drizzle/meta/<newest>_snapshot.json`, NOT AGAINST THE `.sql` FILES — the earlier wording here ("against the migrations already on disk") is what made a stale snapshot look harmless. That snapshot is the tool's whole model of what already exists, and it sat at 4 tables against 110 journal entries until 0109_snapshot.json reconciled it, which made `db:generate` abort on an interactive rename prompt rather than emit anything at all.

`src/db/snapshot-freshness.test.ts` fails if a schema.ts edit lands without a matching generate.

## `apps/server/src/app.ts`

### §2. M7 (routes/change-sources.ts, coordination/webhook-signature.ts)

M7 (routes/change-sources.ts, coordination/webhook-signature.ts): every inbound webhook source (GitHub, TFC/Atlantis, ...) signs over the RAW request bytes, not a re-serialized JSON.parse/stringify round trip — whitespace/key-order differences would break the HMAC. Fastify augmented here with the one extra field the signature-verification path needs.

### §3. Builds (but does not start listening on) the Fastify app

Builds (but does not start listening on) the Fastify app. Never touches the database at construction time — `pg.Pool` connects lazily — so `openapi:emit` can boot route definitions without a DB (BUILD_AND_TEST.md §8 M0).

### §4. Global body ceiling

Global body ceiling (http-limits.ts). Modest by default so a small route (e.g. /auth/login) can't be handed a huge JSON body that blocks the event loop in the synchronous JSON.parse + prototype-poisoning walk below. The two doors that ingest large payloads — POST /federation/imports (a `.scpbundle` as one JSON body) and POST /change-sources/:kind/report (an open-ended IaC planJson) — opt UP to LARGE_BODY_LIMIT_BYTES per-route. Both limits are finite and explicit (never unbounded — the oversized-payload DoS a bundle parser must defend against), and enforced by Fastify BEFORE the body reaches JSON.parse or any route code. (2026-08-31 security review; the global was previously a flat 64 MiB for bundles' sake.)

### §5. M9.3 (ADR-0001, `docs/adr/0001-in-app-federation-mtls.md`)

M9.3 (ADR-0001, `docs/adr/0001-in-app-federation-mtls.md`) — when in-app federation mTLS is configured, the WHOLE process listens as HTTPS (there is only ever one Fastify instance / one `.listen()` call — main.ts), not just the federation routes: Node has no per-route TLS concept, only per-listener. `requestCert: true, rejectUnauthorized: false` is mandatory, not a relaxed default — this SAME listener also serves browsers/CLI/SDK traffic that must NOT be required to present a client certificate; `rejectUnauthorized: false` asks for a cert but never refuses the HANDSHAKE over its absence, so enforcement happens per-route instead (`federation/mtls-enforcement.ts`'s `enforceFederationMtls`, called explicitly as the first statement in each of the three federation transport routes' handlers in `routes/federation.ts` — see that module's doc comment for why this is a plain function call rather than a registered Fastify hook). When `federationServerMtls` is unset (the default), `https` is omitted entirely and Fastify builds a plain `http.Server`, byte-for-byte the pre-M9.3 behavior.

### §6. Captures the raw request bytes for signature checking

M7 (coordination/webhook-signature.ts): captures the RAW request bytes onto `request.rawBody` BEFORE JSON-parsing them — every webhook signature scheme (GitHub's `X-Hub-Signature-256`, the generic `sha256=` fallback) is computed over those exact bytes, and a JSON.parse -> JSON. stringify round trip is not guaranteed byte-identical (whitespace, key order). This REPLACES Fastify's default parser rather than adding a second, route-scoped one, because Fastify content-type parsers are registered per content-type globally, not per-route — so whatever this function does or fails to do applies to EVERY route in the process.

THIS COMMENT USED TO CLAIM the replacement "behaves identically to Fastify's own default JSON parser for every OTHER route". It was false in three ways, all measured against the base commit, and the first was a live vulnerability:

```text
1. Fastify's default is `secure-json-parse` with `onProtoPoisoning: "error"` and
   `onConstructorPoisoning: "error"`. The replacement was a bare `JSON.parse`, so prototype-
   poisoning rejection was absent from every route in the application — and, since nothing
   else in this codebase ever mentioned `secure-json-parse`, from the codebase entirely.
   `POST /services` with `properties: {"ok":1,"__proto__":{…}}` returned 201 Created and
   stored `{"ok":1}`: accepted, silently partially discarded, reported as success. Restored
   below via `util/safe-json.ts`, which reimplements the same two rules (that module's doc
   comment records why the library itself cannot be added as a dependency here: it is in the
   pnpm store but not the offline metadata mirror, so a direct dependency edge would need a
   network fetch at install time, which charter principle 5 forbids).
2. A JSON syntax error did NOT surface as `FST_ERR_CTP_INVALID_JSON_BODY`. That error carries
   `statusCode: 400`; a raw `SyntaxError` carries none, so `setErrorHandler` below fell
   through to its catch-all and answered a client typo with 500 Internal Server Error
   (measured: `{not json` -> 500). Both failure modes now produce a 400 problem+json via
   `badRequest`, which is this codebase's own equivalent of that Fastify error.
```

```text
   THAT SENTENCE NAMES A PROPERTY, AND THIS PARSER WAS ONE MEMBER OF IT. `setErrorHandler`
   ignored `err.statusCode` for EVERY error, not only for parser errors, so every other
   pre-handler refusal Fastify raises was a 500 too — an unsupported media type, an
   oversized body, a mismatched `content-length`. Fixing the parser and leaving those is the
   exact shape CLAUDE.md's census-by-property rule exists to prevent, so the handler now
   honours the status instead: see `frameworkClientProblem` in `errors.ts` for the
   measured census of the whole class and `error-handler-status.test.ts` for its pins.
3. An empty body does NOT match Fastify's default — the default replies
   `FST_ERR_CTP_EMPTY_JSON_BODY`. Parsing it to `undefined` is a DELIBERATE divergence that
   routes here rely on, so it is kept, and now labelled as a divergence rather than as parity.
```

One further known divergence, left as-is: Fastify's default strips a leading UTF-8 BOM before parsing and this does not, so a BOM-prefixed body is a 400 here. Narrowing behaviour is safe; it is recorded rather than silently "fixed" because widening it is a functional change.

### §7. A framework-raised client error keeps its own status

A FRAMEWORK-RAISED CLIENT ERROR KEEPS THE STATUS THE FRAMEWORK GAVE IT. Everything Fastify refuses before a route handler runs — unsupported media type, oversized body, a `content-length` that does not match the bytes — arrived here with a correct `statusCode` that this handler used to drop on the floor, answering 415/413/400 conditions with 500. `frameworkClientProblem` (errors.ts) carries the full census, and the reason it is narrower than a bare `err.statusCode` read: `undici`'s errors carry an UPSTREAM response's status under that same property name.

Logged at `info`, not `error`: these are the caller's mistakes, and the whole harm of the old behaviour was that a client typo looked like a server fault to everything downstream of the logs as well as to the client.

### §8. THE PRODUCER DECLARATION'S AUTHORING SURFACE

THE PRODUCER DECLARATION'S AUTHORING SURFACE (ADR-0032 §7e). Without this line `declareDependencyLineProducer` has no non-test caller, `dependency_line_producers` stays empty, and the INTERNAL half of dependency subscriptions cannot fire in production at all — that is the defect the route exists to close, so deleting this registration must turn `dependency-producers.integration.test.ts`'s "WIRING" case red rather than merely removing a convenience.

### §9. M2 step 4 (BUILD_AND_TEST.md §8 M2 item 2, DESIGN.md §14)

M2 step 4 (BUILD_AND_TEST.md §8 M2 item 2, DESIGN.md §14): the built Web UI v1 SPA (apps/web/dist) — superseding the M0 `/ui` server-rendered stub, which is deleted (see routes/typed-registries.ts and friends for the real API this now talks to via @scp/sdk). `wildcard: false` makes this registration glob `apps/web/dist` once at boot and register one route per real file (e.g. `/assets/index-*.js`) instead of a dynamic wildcard — the SPA client-side-routing fallback below handles everything else. `decorateReply: false` avoids colliding with the `/static/` registration above, which already added `reply.sendFile`.

M16.3 P3 (owner decision 2026-07-29): a `role: retrans` relay MUST NOT serve this — the profile is "no local Gitea/registry, no executor coordination, no deploy machinery, no UI" (BUILD_AND_TEST.md M13.1), and a retrans sits at the most sensitive point in the topology (a CDS boundary). Gated on `deps.config.federationRole` — the install-time/deployment-wide axis (`config.ts`'s doc comment on `federationRole` explains why THIS axis, not `SCP_ROLE` and not the per-org `self_domain.role`, governs here). Every other value (the `commander`/`outpost` defaults every pre-M16.3 deployment already has) preserves the unconditional-serve behavior byte-for-byte.

### §10. Low-priority catch-all: find-my-way

Low-priority catch-all: find-my-way (Fastify's router) always prefers the exact/static routes @fastify/static just registered over this wildcard, for any request that lands here at all — so real built assets are served directly, and this only ever runs for SPA client-side routes (`/services`, `/graph/abc`, ...) that have no matching file on disk. The explicit `/api/`, `/static/`, `/healthz` guard is belt-and-braces on top of that route precedence, so an unmatched API path still 404s as JSON rather than getting served HTML.

READ FROM DISK EVERY TIME, DELIBERATELY. This used to memoize into a `let cachedIndexHtml: string | undefined` for the lifetime of the process, which made ONE document served from TWO sources under TWO different caching policies: `GET /` comes from @fastify/static, which reads the file per request, while every SPA deep link came from a snapshot taken at the first such request. Rebuild the web app under a running server — the ordinary local loop — and Vite emits new content-hashed asset names and deletes the old ones, so `/` correctly referenced the new bundle while `/services/anything` kept handing out HTML pointing at files that no longer existed: two 404s and a blank page, with nothing in the server log. The asymmetry was the defect, not the staleness; the fix is to make both paths agree, and agreeing on "fresh" is the only option that is never wrong.

The cost is one ~400-byte `readFile` per SPA DOCUMENT request — not per client-side navigation (those never reach the server) and not per asset (@fastify/static already reads those from disk per request). Next to the DB-backed API calls the page makes on load it does not register. Pinned by `routes/spa-index-freshness.integration.test.ts`.

## `apps/server/src/background-work.test.ts`

### §11. The composition root's background work, proven by running

THE COMPOSITION ROOT'S BACKGROUND WORK, PROVEN BY RUNNING IT
This file exists because the thing it checks was, until now, checked by SUBSTRING MATCHES on `main.ts` — and those were measured worthless twice over:

```text
- M21.7: commenting `startBumpDispatchLoop(…)` out of `main.ts` left `bump-dispatch.test.ts`
  green at 20/20, including a case literally named "starts the worker, and stops it on
  shutdown", and left the whole apps/server unit suite green at 972/972.
- 2026-08-17 (this change): flipping `main.ts`'s background-work condition to `false` — one
  token, killing ALL ELEVEN loops — left `bump-dispatch`, `bump-gate`, `inventory-ingestion`
  and `domain-event-routers` green at 79/79, and the full 972-test unit suite green.
  `domain-event-routers.test.ts` had recorded that exact mutation as a known-uncovered edge.
```

`main.ts` cannot be imported (`main()` runs at module scope), so the fix was not a better regex — it was to MOVE THE THING BEING CHECKED somewhere importable. `background-work.ts` holds the loop registry and the role predicate; everything below EXECUTES them.

WHAT IS PROVEN HERE, BEHAVIOURALLY: 1. `runsBackgroundWork` — which process roles own loops, by calling it. 2. The registry is COMPLETE — every `start…Loop` in the tree is registered or explicitly exempted, compared by function IDENTITY against what each module exports. 3. Every registered loop ACTUALLY STARTS and reaches pg-boss, creating its own queue, when its config allows. Wrong arguments in a registry entry fail here, because the loop runs. 4. Every registered loop's guard is OBEYED through the registry path — a refused loop creates no queue. 5. `stop()` stops EVERY loop that was started, in order.

WHAT IS *NOT* PROVEN HERE, STATED PLAINLY (see `@scp/source-census`'s package doc for the general list): that `main.ts` calls `startBackgroundLoops` at all. That single link is still a substring match — the one at the bottom of this file — because nothing can import `main.ts`. It is one call rather than eleven plus eleven `.stop()`s, and the registry means a NEW loop cannot widen that gap; but a mutation that deletes the call from `main.ts` entirely is caught only by that substring, and a mutation that makes the enclosing branch dead is caught by NOTHING in this package. Closing it needs a test that boots the real process against a real database and asks the database which queues exist. That is not written, and this comment is not a substitute for it — it is a record that the gap is known and where it lives.

### §12. The worker is the load-bearing case

The worker is the load-bearing case. It used to be true for every role, so the api and the worker raced on an empty database and the winner printed the bootstrap one-time password — a credential that is generated, shown once and never stored. When the worker won, the only copy landed in the worker's log, while every operator instruction (chart NOTES, docs, scripts/kind-drill.sh) says to read the API pod's. Reproduced 3/3 before this guard.

### §13. Loop starters deliberately not in that list, with reasons

Loop starters that are deliberately NOT in `BACKGROUND_LOOPS`, each with the reason — listed rather than filtered by directory, because a path filter is exactly where the next unwired loop hides (CLAUDE.md: census with no grep filters).

### §14. WHAT THIS PROVES: the characters

WHAT THIS PROVES: the characters `startBackgroundLoops(` appear in `main.ts`'s code, outside a comment.

WHAT IT DOES NOT PROVE, and this list is not decoration — every item has shipped in this repo: that the enclosing branch is reachable (the MEASURED mutation: condition flipped to `false`, 79/79 green, whole suite green); that the call is not in a dead branch; that the context handed over is correct; that the returned handle is stopped. Only booting the real process against a real database and asking it which queues exist can prove those, and that test does not exist.

It is kept because it is the cheapest possible detector for the single most likely edit — a merge or a revert that drops the line — and because everything AROUND it is now behavioural, so this is the whole of the residue rather than one of twenty-three such assertions.

## `apps/server/src/background-work.ts`

### §15. THE BACKGROUND-WORK COMPOSITION

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

### §16. M3 coordination engine

M3 coordination engine (BUILD_AND_TEST.md §8 M3, DESIGN.md §9.3/§9.4): the resumable reconciliation loop, over the plugin host. The shared fake-executor instance it relies on (coordination/executor-config.ts documents why: M3 has no plugin-instance configuration API yet) is registered there under this same role condition, with its state file under the OS temp dir — durable across the plugin SUBPROCESS restarting (the plugin-host isolation DoD scenario), not across this whole `scpd` process restarting, which is fine: fake-executor is never a real system of record.

### §17. M13.1b staging-node AUTO-RELAY (proposal §13.1)

M13.1b staging-node AUTO-RELAY (proposal §13.1): the last operator-gated step of the CDS boundary walk — a `role: retrans` instance builds the onward byte tarball for an imported promotion with no operator command. DEFAULT-OFF behind its own explicit `SCP_RETRANS_AUTO_RELAY=1` (unattended byte egress across a security boundary is opted into separately from unattended INGEST; without it an inert handle, and the queue is never created).

### §18. M14.0 outpost live-pull scheduler

M14.0 outpost live-pull scheduler (docs/proposals/outpost-poke.md §"Milestone scope", ADR-0009) — DEFAULT-OFF (explicit `SCP_FEDERATION_SYNC_LOOP=1` opt-in; without it an inert handle, never a scheduled tick). The deferred federation-over-HTTP live-sync substrate the poke increments (M14.1–M14.4) optimize; it pulls+imports commander config over the fail-closed per-peer mTLS outbound dialer (federation-outbound.ts) and is the sparse-safety-net + pull-on-startup reliability floor.

### §19. M21.4 third-party dependency version poll (ADR-0032 §7)

M21.4 third-party dependency version poll (ADR-0032 §7): same queue-per-capability pattern, but with a SECOND, explicit guard on top of the background-work gate — `config.federationRole` must be `commander`. An unguarded background job that dials package registries on a timer would run on AIR-GAPPED OUTPOSTS too, and neither the process-role split nor any runtime predicate would stop it (`self_domain.role` is per-org, lazy and advisory). The guard lives in `dependencyVersionPollRoleGuard`, which returns an inert handle and never creates the queue when it refuses — proven across the full config matrix in `commander-only.test.ts`.

### §20. M21.4 internal release detection (ADR-0032 §7)

M21.4 internal release detection (ADR-0032 §7) — the worker half of a domain-event router. Event-driven rather than a timer, because a release IS an event. COMMANDER-ONLY, like every dependency job (ADR-0032 §7d, owner decision 2026-08-17): a FIELD outpost never ORIGINATES a dependency bump — it receives the resulting change down the global pipeline the commander manages — so it derives no inventory and detects no releases for this feature. ("Field" is load-bearing: an HQ outpost is the outpost in the commander's OWN trust domain, which is this process — see `dependencies/commander-only.ts`, which reads that out of the code.) The loop's module doc carries the accepted cost: an internal line released only at a FIELD outpost keeps a NULL head, which §7 defines as "not observed", never "nothing newer exists".

### §21. M21.2 dependency-inventory ingestion (ADR-0032 §4/§6)

M21.2 dependency-inventory ingestion (ADR-0032 §4/§6) — the worker half of the ingestion router. THIS IS WHAT WRITES `component_dependencies`: without it the table is empty on every deployment and the enablement chain, the version poll and internal detection all resolve over nothing. Same role answer as internal detection and the poll — COMMANDER-ONLY (ADR-0032 §7d). Accepted consequence, in the loop's module doc: dependencies declared in FIELD-outpost-only repositories are out of scope for dependency subscriptions.

### §22. M21.5 the auto-merge link (ADR-0032 §8c)

M21.5 the auto-merge link (ADR-0032 §8c) — runs the EXISTING governance gate FOR a bump change once its own commit has been observed back, then merges only if a governed control evidenced the component's own checks passed for exactly that commit. It takes `ctx.sandbox`, the SAME object the reconcile loop above was handed, which is what makes "the same gate machinery" literally the same — previously two `getSharedCelSandbox()` calls that happened to memoise.

### §23. M25.8b the freeze re-drive (owner decision D8)

M25.8b the freeze re-drive (owner decision D8) — THE PRODUCER OF "THE NEXT ATTEMPT" the auto-merge gate's `frozen` refusal promises. That refusal's own Decision told the operator the pull request would merge once the window closed, and nothing scheduled such an attempt: the only producer of `dependency-bump-gate` jobs is a PROVIDER WEBHOOK correlated to the bump's branch, and a freeze expiring, being lifted or being shortened touches no repository. So a bump refused during a freeze was stranded for ever, silently, with the latest Decision asserting the opposite. This re-asks `checkBumpMergeFreeze` once a minute for exactly the bumps that refusal named and re-enqueues the ones nothing covers any more — commander-only under `bumpDispatchRoleGuard`, the same guard the gate above consults, because a refused gate loop never creates the queue this one sends to.

### §24. Does THIS process own background work?

Does THIS process own background work?

Extracted from `main.ts`'s inline `config.role === "all" || config.role === "worker"` so the predicate is importable and therefore testable. The inline version was the subject of the measured mutation above: setting it `false` killed all eleven loops with a fully green suite, because no test could reach it.

`role === "api"` is a pure request server for everything EXCEPT request-scoped plugin dispatch — `main.ts` constructs the plugin host for every role (#200), and that is deliberately NOT gated on this.

### §25. Does THIS process CREATE the bootstrap admin?

Does THIS process CREATE the bootstrap admin?

Only the HTTP-serving roles, and that is the whole point rather than an optimisation.

THE BUG THIS CLOSES (measured 2026-08-29, reproduced 3/3). `ensureBootstrapAdmin` used to run UNCONDITIONALLY in every process. In the chart's default split topology the api and worker pods boot at the same moment against the same empty database, so WHICHEVER WINS creates the admin and prints the one-time password — and that password is generated, shown once, and never stored. When the worker won, the api logged "bootstrap admin 'admin' already exists, skipping" and the only copy of the credential was in the WORKER's log.

That is not merely untidy. Every operator-facing instruction — the chart NOTES, the docs, and `scripts/kind-drill.sh`, which polls the api pod and fails with "could not capture the bootstrap one-time password" — says to read the API pod's log. So on an unlucky boot the credential the whole install depends on was written somewhere nobody is told to look, with no error anywhere.

Tying creation to the role that serves HTTP makes the password's location a PROPERTY OF THE DEPLOYMENT rather than of who won a startup race.

WORKER-ONLY DEPLOYMENTS DO NOT BOOTSTRAP, deliberately: an install with no api has nothing to serve the credential to, and the chart always deploys an api (`role: all` covers the single-process case). A worker that starts first simply finds no org yet and picks it up on a later tick — its loops are all org-scoped queries, not a one-time init.

NOT A FULL MUTUAL EXCLUSION: two api REPLICAS can still race each other. That path is already safe-by-construction rather than by this predicate — the loser's `existingAdmin` check returns early and logs "already exists, skipping" — so this fixes WHERE the password lands, which is what was broken and what was measured.

### §26. Start every loop, and return one handle that stops them

Start every loop in `loops`, and return one handle that stops them all.

SEQUENTIAL, IN ORDER, AND `stop()` STOPS IN THE SAME ORDER — preserving exactly what `main.ts`'s hand-written `onClose` did. Neither start nor stop swallows an error, also as before: a loop that throws on the way up fails boot loudly, and one that throws on the way down surfaces rather than being hidden behind the loops after it.

`loops` is a parameter with a production default so a test can drive this with its own table (proving the runner) as well as with the real one (proving the wiring). The default is what `main.ts` gets, so the test and production share one code path rather than resembling each other.

## `apps/server/src/boot-checks.ts`

### §27. The boot-safety check, extracted so it is testable

D6 (§7.3) boot-safety check, extracted from `main.ts` so it is directly testable. A PRODUCTION instance must not boot on EPHEMERAL generated secrets: an ephemeral `SCP_SECRETS_MASTER_KEY` orphans every stored credential on restart, and an ephemeral `SCP_COOKIE_SECRET` invalidates every session on restart — neither survives a failover, which is exactly the posture M26 exists to make safe. `evaluation` mode (compose-eval, `pnpm dev`) keeps the zero-required-env boot; the caller emits the loud-not-fatal warning there.

## `apps/server/src/bundled-argocd-autowire-bin.ts`

### §28. Bundled Argo CD auto-wire entrypoint

Bundled Argo CD auto-wire entrypoint (M11 — the "zero token plumbing" step of Mode B, docs/ proposals/bundled-executor-backends.md). `deploy/helm`'s bundled-argocd-autowire Job runs exactly `node dist/bundled-argocd-autowire-bin.js` as a Helm `post-install,post-upgrade` hook when `bundledExecutor.argocd.enabled`. It mints a SCOPED (never admin) Argo CD API token and stores it in SCP's encrypted secret store so an operator can bind any graph object to the `argocd` executor with `--secret-refs '{"tokenSecretKey":"<key>"}'` and no manual token creation.

Why a DB-seed bin (like migrate-bin.ts) rather than the public API: this is INSTALL-TIME bootstrap plumbing, run by the operator's `helm install` (not by scpd at runtime), so it uses the same admin `DATABASE_URL` + `SCP_SECRETS_MASTER_KEY` the migrations Job already uses — no bootstrap PAT chicken-and-egg. It never holds Argo CD's kube credentials: it obtains only a scoped API token (applications get/sync), which is exactly what the credential-asymmetry invariant permits.

Idempotent: re-running (e.g. a `helm upgrade`) simply re-mints + overwrites the stored token. The per-object executor BINDING is deliberately NOT seeded here — bindings attach to a graph object (Component/DeploymentTarget), which the operator creates later; the value delivered here is that the token already exists, so the bind is a single command with no token step.

Env contract (all injected by the Helm hook Job): SCP_ARGOCD_SERVER_URL        in-cluster Argo CD API base (http, behind NetworkPolicy), e.g. http://scp-argocd-server.scp-argocd.svc SCP_ARGOCD_ADMIN_SECRET_NS   namespace of Argo CD's initial-admin secret (scp-argocd) SCP_ARGOCD_ADMIN_SECRET_NAME argocd-initial-admin-secret SCP_ARGOCD_ACCOUNT           the scoped account to mint a token for (scp-coordinator) SCP_ARGOCD_TOKEN_SECRET_KEY  the SCP secret key to store the token under SCP_BOOTSTRAP_ORG            the org whose secret store receives the token DATABASE_URL, SCP_SECRETS_MASTER_KEY   admin DB + master key (same as migrate-bin)

## `apps/server/src/bundled-gitea-autowire-bin.ts`

### §29. Bundled Gitea auto-wire entrypoint

Bundled Gitea auto-wire entrypoint (M15.1c — the "zero token plumbing" step of Mode B for the default bundled registry, ADR-0012). `deploy/helm`'s bundled-gitea-autowire Job runs exactly `node dist/bundled-gitea-autowire-bin.js` as a Helm `post-install,post-upgrade` hook when `bundledExecutor.gitea.enabled`. It mints a SCOPED (never admin) Gitea API token — least- privilege scopes, only what a coordinator needs to push code + packages — and stores it in SCP's encrypted secret store so an operator can bind any graph object to a git-provider / registry executor with `--secret-refs '{"tokenSecretKey":"<key>"}'` and no manual token creation.

Mirrors bundled-argocd-autowire-bin.ts. Why a DB-seed bin (like migrate-bin.ts) rather than the public API: this is INSTALL-TIME bootstrap plumbing, run by the operator's `helm install` (not by scpd at runtime), so it uses the same admin `DATABASE_URL` + `SCP_SECRETS_MASTER_KEY` the migrations Job already uses — no bootstrap PAT chicken-and-egg. It never holds Gitea's admin password at runtime: it reads the SCP-generated admin secret once, basic-auths to mint a SCOPED token, and stores only that token — exactly what the credential-asymmetry invariant permits.

Idempotent: re-running (e.g. a `helm upgrade`) DELETEs any pre-existing token of the same name (Gitea rejects a duplicate token NAME with HTTP 400) and re-mints, then overwrites the stored token. The per-object executor BINDING is deliberately NOT seeded here — bindings attach to a graph object the operator creates later; the value delivered here is that the token already exists, so the bind is a single command with no token step.

Env contract (all injected by the Helm hook Job): SCP_GITEA_SERVER_URL         in-cluster Gitea API base (http, behind NetworkPolicy), e.g. http://scp-gitea-http.scp-gitea.svc:3000 SCP_GITEA_ADMIN_SECRET_NS    namespace of the SCP-generated Gitea admin secret (scp-gitea) SCP_GITEA_ADMIN_SECRET_NAME  gitea-admin-secret (keys: username, password) SCP_GITEA_TOKEN_NAME         the name to give the minted token (scp-coordinator) SCP_GITEA_TOKEN_SECRET_KEY   the SCP secret key to store the token under DATABASE_URL, SCP_SECRETS_MASTER_KEY   admin DB + master key (same as migrate-bin)

## `apps/server/src/config.ts`

### §30. Admin/bootstrap connection (compose POSTGRES_USER)

Admin/bootstrap connection (compose POSTGRES_USER) — used ONLY by the migration runner and boot-time runtime-role provisioning (db/provision.ts), never by request-serving code (PR #4 security review, CRITICAL 3).

### §31. The connection the application pool actually uses

The connection the application pool actually uses: authenticates as the least-privileged `scp_app` login role (NOSUPERUSER, NOBYPASSRLS), so RLS holds independently of application code. Defaults to `databaseUrl` with the user swapped to `scp_app` (same password); override with SCP_RUNTIME_DATABASE_URL when the role is managed externally.

### §32. The connection pg-boss uses for its own schema

The connection pg-boss itself uses to manage its own `pgboss` schema (job/queue tables) — authenticates as the schema-scoped `scp_pgboss` login role (NOSUPERUSER, NOBYPASSRLS, owns only the `pgboss` schema, no grants on `public` at all — drizzle/0008_pgboss_role.sql). M3 tracked security follow-up: pg-boss previously ran on `databaseUrl` (the admin/superuser connection) to perform its internal schema migrations at boot; this closes that gap the same way `runtimeDatabaseUrl` closed it for the request-serving pool. Defaults to `databaseUrl` with the user swapped to `scp_pgboss` (same password); override with SCP_PGBOSS_DATABASE_URL when the role is managed externally.

### §33. The connection the instance-operator write doors use

M22.9 R3 — the connection the four INSTANCE-OPERATOR write doors use (`routes/ instance-scan-exclusion-admissions.ts`, `instance-scan-floors.ts`, `scanner-assignments.ts`, `scan-db.ts`). Authenticates as `scp_operator`: NOSUPERUSER, NOBYPASSRLS, and granted INSERT/UPDATE/DELETE plus a write RLS policy on exactly those four instance-scoped tables and nothing else (drizzle/0076). `SCP_OPERATOR_DATABASE_URL`.

WHY IT IS A THIRD CONNECTION RATHER THAN EITHER OF THE TWO ABOVE. It cannot be `runtimeDatabaseUrl`: `scp_app` holds SELECT only on those tables and has no write policy, by design and in two independent layers (drizzle/0029, 0035, 0036, 0074) — an operator write must not be reachable from the role that serves tenant traffic. And it must not be `databaseUrl`, which is what these four doors USED and is the bug they shipped with: in the hardened Helm shape the api/worker pods hold no admin credential at all (`commanderscp.adminDbEnv` is included only by `migrations-job.yaml`), so `databaseUrl` silently resolved to the `localhost:5432` fallback below and every operator write dialed 127.0.0.1 inside its own pod — ECONNREFUSED, a bare 500, and for M22 an admissions table that stayed empty, which fails the exclusion AND at its top rung for every clause on the deployment.

`undefined` MEANS THE WRITE DOORS FAIL CLOSED WITH A 503 THAT NAMES THIS VARIABLE (`routes/operator-db.ts`), never a 500 and never a fallback to a wider credential. Reads are unaffected — they run inside the ordinary tenant transaction and always did.

THE DEFAULT IS THE ADMIN CONNECTION *ONLY IN THE SHAPES THAT ACTUALLY HAVE ONE*, i.e. when this process is self-migrating (`SCP_SKIP_MIGRATIONS` unset/false — `pnpm dev`, the compose eval stack, Testcontainers). Those are precisely the shapes where `databaseUrl` is a real, reachable, superuser-capable credential that `main.ts` Phase 1 already opens a pool on, so their behaviour is byte-for-byte what it was before this field existed. `SCP_SKIP_MIGRATIONS= true` is the hardened deployment saying it holds no admin connection, and there the absence of an explicit `SCP_OPERATOR_DATABASE_URL` is a missing credential, not a default to guess at.

### §34. The operator-declared, install-time federation role

M16.3 P3 — the OPERATOR/install-time-declared federation role, `SCP_FEDERATION_ROLE` (`commander` the default when unset — matches `deploy/helm-bundled`'s `federationRole` default, and preserves every pre-M16.3 deployment's behavior byte-for-byte since no such env var existed before). This is DELIBERATELY NOT `self_domain.role` (`federation/self-repo.ts`'s `FederationSelf.role`): that value is per-ORG (DESIGN §4.1 "kept org-scoped, not instance-wide" — self-repo.ts's own module doc), set lazily post-install via the federation API, and advisory (M15.4's `tools/helm-verify` doc comment: "the runtime `self_domain.role`... has no bearing on a Helm install-time value" — using it here would be exactly the runtime/install-time fork that M15.4 explicitly declined to create). SPA registration in `app.ts`, by contrast, happens ONCE at process boot, before any request (or tenant/org) context exists — there is no per-request org to look up a DB row for even if we wanted to. So this mirrors `role` above: an explicit, install-time, deployment-wide config value the operator sets (Helm's `federationRole` value on the MAIN chart, wired to this env var — `deploy/helm/templates/_helpers.tpl`), never inferred from tenant data.

Used for exactly one thing today (P3): a `retrans` relay — "no local Gitea/registry, no executor coordination, no deploy machinery, no UI" (BUILD_AND_TEST.md M13.1) — must not serve the full management SPA at the most sensitive point in the topology (a CDS boundary). Every other value (`commander`/`outpost`/unset) preserves the pre-M16.3 unconditional-serve behavior.

### §35. DID THE OPERATOR ACTUALLY SAY SO?

DID THE OPERATOR ACTUALLY SAY SO? True only when `SCP_FEDERATION_ROLE` was set; false when `federationRole` above is the `commander` DEFAULT (M21.4).

The two are not the same fact, and one consumer needs the difference. `federationRole` defaults to `commander` so that every pre-M16.3 deployment keeps serving the SPA byte-for-byte — that default is right for a question about what to SERVE, because serving is what those deployments already did. It is the wrong default for a question about what to REACH: an outpost deployed before this env var existed, or a chart that simply does not set it, is indistinguishable from a declared commander, so a guard that only tests `federationRole === "commander"` is FAIL-OPEN for exactly the deployments most likely to be air-gapped.

Consumers therefore pick per question: "may I serve the SPA?" reads `federationRole`, and "may I dial the public internet on a timer?" additionally requires this to be true (see `dependencies/version-poll.ts`'s `dependencyVersionPollRoleGuard`). Nothing about the pre-M16.3 serve behaviour changes — this field ADDS a distinction rather than moving the default.

### §36. D6 (multi-region-instance-resilience.md §7.3, §11)

D6 (multi-region-instance-resilience.md §7.3, §11) — the DEPLOYMENT MODE. `production` (the default; Helm ships it) makes boot FAIL-CLOSED on the DR footguns that only bite after a restart/failover: an ephemeral generated `SCP_SECRETS_MASTER_KEY`/`SCP_COOKIE_SECRET` (which silently orphans every stored secret and every session on restart), and a secrets vault that cannot be decrypted with the configured key (the B3 canary). `evaluation` (compose-eval and `pnpm dev` set it explicitly) keeps today's zero-required-env boot with only a loud warning. An invalid value fails loud at boot, exactly like `SCP_FEDERATION_ROLE`.

### §37. The instance operator's shared secret

M17.5 (ADR-0016) — the INSTANCE OPERATOR's shared secret (`SCP_OPERATOR_TOKEN`). Authenticates the one write surface that is deliberately NOT a tenant capability: authoring the instance-scoped scan-requirement floors (`scan_requirement_floors` — platform + trust domain), which apply to EVERY org hosted on this deployment. A tenant admin, however privileged inside their own org, must never be able to author or loosen them, so no RBAC permission can grant this — it is a separate, deployment-level credential.

UNSET (the default) means the operator write surface is CLOSED: the route 403s rather than falling back to any tenant credential. Fail-closed, and air-gap friendly (an env var, no external IdP).

### §38. Boot-time demo seed

Boot-time demo seed (BUILD_AND_TEST.md §5.3, seed.ts's `loginAndSeedDemoData`) — off by default; the eval compose stack (`deploy/compose/docker-compose.yml`) turns it on. Never required for the platform to function: a failed/skipped seed only means the demo graph isn't there, never a boot failure (main.ts logs and continues).

### §39. Generic OIDC (Authorization Code + PKCE via `openid-client`)

Generic OIDC (Authorization Code + PKCE via `openid-client`) — DESIGN.md §7, M2 step 2 Part B. `undefined` (the default — unset `SCP_OIDC_ISSUER`) means OIDC is DISABLED: the `/auth/oidc/*` routes 404 rather than crash, and local-auth keeps working unmodified (CLAUDE.md: air-gap/self-hosting is first-class — OIDC must be optional, never required). One config shape covers Okta/Entra/Keycloak/Ping via discovery — no per-provider special casing (auth/oidc.ts).

### §40. `EventBus` backend toggle

`EventBus` backend toggle (DESIGN.md §8 "Scaling insurance", BUILD_AND_TEST.md M3 item 8). `"postgres"` (the default — `SCP_EVENT_BUS_BACKEND` unset) is the untouched, zero-new-dependency path: the transactional outbox relay fans out to pg-boss + SSE only, exactly as it always has. `"nats"` is an explicit opt-in that ALSO fans relayed outbox events out to NATS JetStream (events/nats-fanout.ts) — never a *required* dependency (CLAUDE.md principle 4). `publish()` itself (events/event-bus.ts) is identical for both backends; see that file's doc comment.

### §41. AES-256-GCM root key for the `secrets` table

AES-256-GCM root key for the `secrets` table (M7, secrets/crypto.ts) — org-supplied plugin credentials (GitHub App private key, ArgoCD token, managed-IaC infra creds) are encrypted under this key, never stored in plaintext. `SCP_SECRETS_MASTER_KEY` (base64, 32 bytes) SHOULD be set explicitly and kept stable across restarts/deploys — every secret encrypted under one value becomes undecryptable if it changes. Mirrors `cookieSecret`'s "generate an ephemeral one with a loud warning if unset" fallback (five-minute-value / self-hosting-first: the compose eval stack and a first `pnpm dev` must still boot with zero required env vars) rather than failing boot — the operational consequence (secrets configured before a restart become unreadable after one) is a one-line warning away from being obvious, not a silent landmine.

### §42. Hardened defaults, and least privilege as the baseline

M8 hardening (BUILD_AND_TEST.md §8 M8 item 1, "hardened defaults" — least privilege): when `true`, `main.ts` skips Phase 1 entirely (no admin-connection migrations/role-provisioning on boot) and connects straight in as `runtimeDatabaseUrl`/`pgBossDatabaseUrl`. Set by the Helm chart's `api`/`worker` Deployments — ONLY the migrations Job (`migrate-bin.ts`, run as a pre-upgrade hook with the admin `DATABASE_URL`) ever holds admin/superuser-capable database credentials in that deployment shape; `api`/`worker` pods hold only the already-least- privileged `scp_app`/`scp_pgboss` role credentials. Default `false` preserves EVERY existing deployment shape unchanged (compose, `pnpm dev`, every E2E script): every pod still self-migrates+self-provisions on its own boot, exactly as it always has.

### §43. Defensive graph guardrail

Defensive graph guardrail (adversarial review of PR #15 — graph/query-timeout.ts's module doc): bounds every `/graph/traverse` and `/graph/query/:name` call to this many milliseconds via Postgres `statement_timeout`, so a pathological shared-component topology (the `impact-of` recursive CTE's measured fan-in^depth blowup — 7+ minutes then disk exhaustion on one real topology) fails cleanly (a 408) instead of hanging a worker/connection or exhausting disk. Does not change query semantics — the CTE's own node-dedup fix remains a separate, pending owner decision. `SCP_GRAPH_QUERY_TIMEOUT_MS`, default 5000 (a few seconds — generous for any legitimate depth-≤10 query against a normal topology, per the load-test numbers in the M8 PR body, while still bounding the pathological case).

### §44. M9.3 (ADR-0001, `docs/adr/0001-in-app-federation-mtls.md`)

M9.3 (ADR-0001, `docs/adr/0001-in-app-federation-mtls.md`) — OPTIONAL, fail-closed in-app mTLS for the three federation transport routes (`routes/federation.ts`'s `/exports`, `/exports/promotion`, `/imports`), layered on top of (never replacing) bearer+RBAC+Ed25519. `undefined` (no `SCP_FEDERATION_SERVER_MTLS_*` env set) is the default — behavior is BYTE-FOR- BYTE unchanged from pre-M9.3 (plain HTTP, no client-cert requirement at all; the deployment- level `ingress.mtls` from M8 remains the enforcement point for ingress-terminated topologies). Mirrors `loadOidcConfig`'s house style: a nested optional block, throwing at boot on a PARTIAL configuration (some but not all of ca/cert/key set) rather than silently degrading.

This is a listener-construction concern, not a request-time one: `ca`/`cert`/`key`/`crl` are read into memory ONCE at boot (here) because `app.ts` needs them synchronously to build the `Fastify({ https: {...} })` options — the whole process listens as HTTPS when this is set, `rejectUnauthorized: false` (ADR-0001 §Decision 1: the SAME listener also serves browsers/ CLI/SDK traffic that must not present a client cert; enforcement is per-route, not at the handshake — see `federation/mtls-enforcement.ts`).

### §45. Default `false` (warn-and-continue)

Default `false` (warn-and-continue) — see `loadFederationServerMtlsConfig`'s doc comment for why an expired CRL can't just be "included but logged": empirically, Node/OpenSSL treats ANY CRL past its `nextUpdate` as invalidating EVERY cert-presenting connection (`CRL_HAS_EXPIRED`), not merely disabling revocation checking — so this flag controls whether boot refuses outright (`true`) or drops the stale CRL from the TLS context entirely and continues without revocation enforcement until a fresh CRL is delivered (`false`).

### §46. `undefined` (SCP_OIDC_ISSUER unset) is the default

`undefined` (SCP_OIDC_ISSUER unset) is the default — OIDC disabled, local-auth-only. Setting the issuer without a client id/redirect URI is a misconfiguration worth failing loudly at boot rather than silently 404ing every OIDC route later.

### §47. `postgres` (SCP_EVENT_BUS_BACKEND unset) is the default

`postgres` (SCP_EVENT_BUS_BACKEND unset) is the default — no NATS connection is ever attempted. Opting into `nats` without `SCP_NATS_URL` is a misconfiguration worth failing loudly at boot (mirrors `loadOidcConfig` above) rather than silently falling back to Postgres-only fan-out or deferring the failure to the first missed event. Actual reachability isn't checked here (this function does no I/O) — that happens when the relay connects the JetStream client at boot (main.ts) / per-test (test-support/harness.ts), where a failed `connect()` is likewise left to throw rather than being caught and swallowed.

### §48. `commander` (SCP_FEDERATION_ROLE unset) is the default

`commander` (SCP_FEDERATION_ROLE unset) is the default — matches `deploy/helm-bundled`'s `federationRole` default (`templates/_helpers.tpl`) and every pre-M16.3 deployment, none of which set this env var, keeps serving the SPA exactly as before. An explicit invalid value fails loud at boot (mirrors `loadEventBusConfig`/`loadOidcConfig` above) rather than silently doing something an operator didn't ask for with a deployment-wide, security-relevant switch.

### §49. Production is the default when unset, so an install is safe

D6 (§7.3). `production` is the DEFAULT (unset → production) so a Helm install with no extra env is fail-closed on the DR footguns; the compose-eval stack and `pnpm dev` set `SCP_DEPLOYMENT_MODE= evaluation` explicitly to keep their zero-required-env boot. An explicit invalid value fails loud at boot rather than silently picking a posture the operator didn't ask for (mirrors `loadFederationRole`).

### §50. Undefined is the default: no such environment at all

`undefined` (no `SCP_FEDERATION_SERVER_MTLS_*` env at all) is the default — in-app federation mTLS disabled, byte-for-byte pre-M9.3 behavior. Setting ANY of ca/cert/key without ALL three is a misconfiguration worth failing loudly at boot (mirrors `loadOidcConfig` above) rather than silently booting plain HTTP while an operator believes mTLS is on.

**Why an expired CRL is handled here, not deferred to request time:** empirically verified while building this (a throwaway CA + a CRL whose `nextUpdate` was set in the past via `openssl ca -gencrl -crl_nextupdate <past-date>`, loaded into a real `https.createServer`): passing an EXPIRED CRL into the TLS context makes Node/OpenSSL mark `authorized: false` with `authorizationError: "CRL_HAS_EXPIRED"` for a perfectly valid, non-revoked client certificate — not just for actually-revoked ones. In other words, OpenSSL's CRL-checking is itself already fail-closed on staleness; it does NOT offer a "check revocation but tolerate staleness" mode. So ADR-0001's "warn loudly and continue" policy (`crlHardFailOnExpiry: false`, the default — an air-gapped domain may legitimately go a while between physical CRL deliveries) can only be implemented by NOT handing the stale CRL to the TLS context at all: revocation enforcement is disabled for federation until a fresh CRL is delivered, but the CA-trust check (and everything else — bearer+RBAC, Ed25519 signatures) still holds. `crlHardFailOnExpiry: true` instead refuses to boot outright — the simplest, clearest expression of "would rather reject all federation than trust a stale revocation list" (ADR-0001 §8).

### §51. Not derived like the two above, and the reason why

NOT `deriveRuntimeDatabaseUrl(databaseUrl, "scp_operator")` like the two above, and the difference is load-bearing rather than an oversight: that helper swaps the USER and keeps the admin PASSWORD, which only authenticates because `main.ts`/`migrate-bin.ts` provision `scp_app`/`scp_pgboss` with exactly that password at boot. There is no such provisioner for `scp_operator` yet (drizzle/0076's header names the owed `provisionOperatorRole`), so a derived URL here would be a credential that looks configured and cannot log in.

## `apps/server/src/domain-id-edge.ts`

### §52. THE WIRE BOUNDARY for branded domain ids

THE WIRE BOUNDARY for branded domain ids — [ADR-0021](../../../docs/adr/0021-terminology.md) D4, follow-on (i).

`TrustDomainId` and `ContainmentDomainId` are branded inside the server so the two senses of "domain" cannot be interchanged (see `packages/schemas/src/domain-ids.ts`). The brand deliberately **stops at the wire**: `/v1` request and response schemas, the generated SDK, and the OpenAPI document all keep plain `string`, so branding costs no API change and produces no codegen drift.

That makes this module the boundary. Everything here takes an already-Zod-validated value that crossed one of those plain-`string` schemas — a request body, a query parameter, an IaC manifest, a stored plan diff read back — and asserts which sense it is. The assertion is a claim about the SCHEMA FIELD, not about the string, and it is sound precisely because the field's declaring route or document knows which sense it declared. Keeping every such assertion in one file makes the set greppable and reviewable; scattering `as` casts through the handlers would not be.

Brands erase at runtime, so all three functions are identity at the value level.

### §53. A `domainId` that names **the containment parent

A `domainId` that names **the containment parent (any object; a domain in the common case)**.

The parenthetical is load-bearing and is not a style choice: `objects.domain_id` is a bare `uuid` with **no foreign key and no CHECK** (`apps/server/drizzle/0001_graph_core.sql:32`), and `resolveContainmentParent` (`graph/objects-repo.ts`) validates only that the id names an object in the same org — **no type filter**. Shipped tests deliberately pass a `service.id` and a `component.id` (`governance/governance.integration.test.ts`, `dependencies/subscription-authoring-guard.integration.test.ts:263`), and RBAC/policy/freeze scope walks accept whatever chain results. Anything written against "this must be a `domain` object" is a constraint the code does not have.

`null`/`undefined` pass through unchanged — both are meaningful to `graph/objects-repo.ts`'s `resolveDomainId` (`undefined` = default to the org root, `null` = this IS the org root).

## `apps/server/src/error-handler-status.test.ts`

### §54. The wiring test for the error handler honouring a status

THE WIRING TEST for `app.ts`'s `setErrorHandler` honouring a framework-supplied status.

Every case here answered **500 Internal Server Error** before this change, on this branch and on `origin/main` — including on the commit that fixed prototype poisoning, which repaired one member of this class (a raw `SyntaxError` from the replacement JSON parser) and left the rest.

Routed through the real `buildApp`, not through `frameworkClientProblem` directly, for the reason `json-body-parser.test.ts` gives: a helper that is correct but not installed is this repo's dominant failure mode. Delete the `frameworkClientProblem` branch from `app.ts` and every case in "framework client errors keep their own status" dies while the unit-level "discriminates ..." cases below stay green.

No database: `buildApp` connects lazily and none of these requests reaches a route handler.

### §55. Why this tests a marker rather than reading the property

The reason `frameworkClientProblem` tests a marker rather than reading `err.statusCode`. `undici` — a direct dependency, used by the executor plugins — puts the UPSTREAM response's status on `statusCode` and the upstream body on `.body`. Honouring it would make an Argo CD 403 into SCP's own 403 and put the upstream's message on the wire.

## `apps/server/src/errors.ts`

### §56. RFC 9457 EXTENSION MEMBERS

RFC 9457 EXTENSION MEMBERS — refusal-specific fields serialized alongside the six fixed ones.

WHY THIS EXISTS. Every refusal in this server is a thrown `ProblemError` funnelled through the single `setErrorHandler` (app.ts) into `toProblem`, which emitted exactly six fields — so a refusal whose whole value is the DATA it carries had nowhere to put it, and the zod serializer strips anything a route's response schema does not declare. `decision_id` is the in-house precedent for an extension member; this generalizes it rather than adding a second bespoke field per refusal.

A member only reaches the wire if the ROUTE declares it for that status (e.g. `412: OutpostReconcileStaleProblemSchema`) — the serializer is still the contract, so an undeclared extension is dropped, not smuggled out.

### §57. Extensions carry the refusal-specific payload

`extensions` carries the refusal-specific payload an optimistic-concurrency 412 needs to be actionable in ONE round trip — e.g. reconcile's fresh `claimants` list, so a caller CAN re-render a real preview instead of opening a second staleness window re-reading it. That is what `scp federation outpost reconcile` does (`packages/cli/src/cli.ts`). It is an offer, not a guarantee every consumer takes: the Outposts web panel (`apps/web/src/routes/ outpost-configuration.tsx`) reads a 412 here only as a signal to refetch, and discards the carried preview — a second round trip, on purpose, not a defect (R3, PR #156 residual).

### §58. The one marker every framework-built error class carries

THE ONE MARKER every error class built by `@fastify/error` carries — Fastify's own `createError` defines it on the error PROTOTYPE (non-enumerable, non-writable) and uses it for its `Symbol.hasInstance`. `Symbol.for` is the cross-realm registry, so this matches errors from Fastify core AND from any plugin that builds its errors the same way, without importing `@fastify/error` (which is not a direct dependency here — charter principle 5, no new dependency).

### §59. The status a framework-raised client error already carries

THE STATUS A FRAMEWORK-RAISED CLIENT ERROR ALREADY CARRIES, or `undefined` if this is not one.

WHY THIS EXISTS (the census this repo's rules demand). `setErrorHandler` in `app.ts` ignored `err.statusCode` outright, so EVERY error Fastify raises before a route handler runs became a 500. The prototype-poisoning fix repaired exactly one member of that class — a raw `SyntaxError` from the replacement JSON parser — by throwing a `ProblemError` instead. Measured on the branch that shipped that repair, through the real `buildApp`:

| request                                  | was | is  | Fastify error                       |
```text
| body with NO `content-type`              | 500 | 415 | `FST_ERR_CTP_INVALID_MEDIA_TYPE`    |
| `content-type: application/xml`          | 500 | 415 | `FST_ERR_CTP_INVALID_MEDIA_TYPE`    |
| `content-length` larger than the body    | 500 | 400 | `FST_ERR_CTP_INVALID_CONTENT_LENGTH`|
| body over the 64 MiB `bodyLimit`         | 500 | 413 | `FST_ERR_CTP_BODY_TOO_LARGE`        |
```

Two more members of the class were already correct and are listed so the census is complete rather than filtered: `FST_ERR_CTP_EMPTY_JSON_BODY` and `FST_ERR_CTP_INVALID_JSON_BODY` cannot fire at all, because `app.ts` replaces the JSON parser and handles both itself (empty -> the deliberate `undefined` divergence; malformed -> `badRequest`). `FST_ERR_VALIDATION` (400, missing/invalid params) is caught one branch earlier by `hasZodFastifySchemaValidationErrors`. A request timeout is NOT in the class: neither `requestTimeout` nor `connectionTimeout` is set, and Node's own socket timeout destroys the connection without raising into the error handler. `FST_ERR_BAD_URL` (400) and `FST_ERR_MAX_PARAM_LENGTH` (414) are raised by the router BEFORE the request lifecycle starts, so `setErrorHandler` never sees them; measured, `/__probe/%zz` already answers 400 — with Fastify's default error shape rather than `application/problem+json`. That body-shape divergence is real, is not a status defect, and is left alone here.

WHY THIS IS NOT `err.statusCode >= 400 && err.statusCode < 500`, WHICH IS THE OBVIOUS SPELLING. `statusCode` is not a Fastify-owned property name. `undici` — a direct dependency of this package, used by the executor plugins — sets `statusCode` on `ResponseError` and `RequestRetryError` from the UPSTREAM response's status, alongside `.body` and `.headers` from that upstream. Honouring `statusCode` blindly would let an Argo CD 403 escaping a plugin become SCP's OWN 403, with the upstream's message in `detail`: a wrong answer and a disclosure in one. The marker restricts this to errors the framework itself minted, whose messages are fixed templates over client-supplied input.

5xx framework errors (`FST_ERR_CTP_INVALID_TYPE` and friends — all local misconfiguration) are deliberately NOT honoured and fall through to the catch-all, so honouring `statusCode` never turns into honouring `message` for a server fault.

### §60. Title from `node:http`'s registered reason phrases

Title from `node:http`'s registered reason phrases — no table of our own to drift, and it already agrees with the titles the helpers above hand-write ("Bad Request", "Not Found", "Unprocessable Entity", ...). Detail is the framework's own message, which for these classes is a fixed template over client-supplied input ("Unsupported Media Type: application/xml"). Returning the whole `ProblemError` rather than a bare number keeps that judgement HERE, next to the reasoning for it, instead of leaving the caller to reach into `err.message` itself.

### §61. THE HUMAN-READABLE TEXT OF ANY THROWN VALUE

THE HUMAN-READABLE TEXT OF ANY THROWN VALUE — the one thing to record in a Decision, a control run, an audit payload, or an operator-facing outcome.

WHY THIS EXISTS RATHER THAN `err instanceof Error ? err.message : String(err)` (PR #153 review Q3). `ProblemError` is constructed `(status, title, opts)` and passes the TITLE to `super()`, so `err.message` on one of these is the bare HTTP title — `"Not Found"`, `"Bad Request"`, `"Conflict"` — while everything informative (WHICH object, WHY it was refused) lives in `detail`. Two consequences, both real and both measured on this branch:

1. EXPLAINABILITY (charter principle 6). A Decision recording `{ error: "Not Found" }` names neither the offending object nor the reason. `scp change explain` shows the operator an HTTP status word. 2. AND, SINCE PERSIST-ON-CHANGE, SUPPRESSION. `insertDecisionIfChanged` compares CONTENT, so two genuinely DIFFERENT faults that both collapse to `"Not Found"` produce a byte-identical `input_context` — and the second one is correctly suppressed as a restatement. The operator keeps reading a Decision about the fault that is no longer the problem. Recording `detail` restores the discrimination the dedupe needs: different faults say different things, so they write different rows.

Falls back to `message` for a `ProblemError` with no `detail`, then to `Error.message`, then to `String(err)` — so it is a drop-in for the idiom it replaces and never returns `undefined`.

## `apps/server/src/http-limits.ts`

### §62. HTTP request body-size ceilings

HTTP request body-size ceilings (Fastify `bodyLimit`).

The GLOBAL default applies to EVERY route unless it opts up. It is deliberately modest: a small endpoint like `POST /auth/login` has no reason to accept a multi-megabyte body, and letting it would hand a synchronous `JSON.parse` + prototype-poisoning walk (app.ts's pre-auth parser) a huge payload that blocks the event loop — a cheap DoS from an unauthenticated caller. 4 MiB is generous for any normal API JSON (object `properties`, executor `config`, a campaign plan, …) while keeping that parse bounded.

Two doors legitimately ingest much larger payloads and opt UP to LARGE per-route: - POST /federation/imports — a signed `.scpbundle` arrives as one JSON body (routes/federation.ts). - POST /change-sources/:kind/report — carries an open-ended IaC `planJson` blob (routes/change-sources.ts). LARGE is still a finite, explicit ceiling (not unbounded) — the oversized-payload defense a bundle/plan parser must keep. Historically the GLOBAL was 64 MiB purely to accommodate bundles; moving that 64 MiB to the two routes that need it lets every other route fall back to the modest default. (2026-08-31 security review.)

## `apps/server/src/idempotency.ts`

### §63. `Idempotency-Key` replay (DESIGN.md §6)

`Idempotency-Key` replay (DESIGN.md §6): "every POST accepts an `Idempotency-Key` header (the server stores key→result for replay)". Runs inside the caller's tenant transaction so the stored key and the mutation it guards commit or roll back atomically — the property fast-check exercises (replayed POSTs must converge, never double-apply).

A key reused for a *different* request body/route is rejected (422) rather than silently returning the old result — reusing a key for a different logical request is a client bug.

### §64. OPT-IN ACTOR SCOPING

OPT-IN ACTOR SCOPING. `idempotency_keys` is keyed `(org_id, idempotency_key)` — ORG-scoped — so a replay is answered to whoever presents the key next, whatever they hold. On most routes that is merely surprising; on `POST /role-bindings` it is a read of an authority record by a principal who holds nothing: guess (or observe) an administrator's key, POST any body, and the stored 201 comes back with the binding id, subject, role and scope. Passing the acting principal here folds it into the request hash, so a second actor presenting the same key gets the 422 "already used for a different request" that a body mismatch gets — a refusal that discloses nothing — instead of the first actor's result.

A HASH RATHER THAN A COLUMN, deliberately: the primary key is `(org_id, idempotency_key)` in `db/schema.ts`, so ACTUAL per-actor scoping is a migration (widening the PK) and would let two actors hold the same key at once. This narrows the disclosure without one, and it fails in the safe direction — a legitimate client retrying its own request has its own actor and replays normally.

OPT-IN, not applied to the six other `withIdempotency` callers: their stored results are graph rows those callers already gate with their own `authorize` on the replay path's inputs, and changing the hash basis for a route invalidates any key in flight across an upgrade. Named here so the next census finds the choice rather than the omission.

## `apps/server/src/json-body-parser.test.ts`

### §65. Snapshot every Object.prototype key, not three named ones

A full snapshot of `Object.prototype`'s own property names, captured at module load. Asserting that three named keys are absent only proves those three are absent; this proves NOTHING was added or removed. A leaked pollution would make every later assertion in the run untrustworthy, so it is checked rather than assumed.

### §66. The wiring test for the global JSON content-type parser

THE WIRING TEST for the global `application/json` content-type parser registered in `app.ts`.

Deliberately routed through the real `buildApp` rather than calling the guard directly: `util/safe-json.test.ts` already proves the guard rejects poisoned input, and a guard that is correct but not installed is this repo's dominant failure mode. Delete the `assertNoPrototypePoisoning` call from `app.ts`'s parser and the "REFUSES" cases here die while every test in `util/safe-json.test.ts` stays green — which is the point of having both.

`buildApp` never touches the database at construction time (`pg.Pool` connects lazily), and a body rejected by the content-type parser never reaches a route handler, so this needs no Postgres and belongs in the unit layer.

The probe route is registered by this test rather than borrowed from the application, because the parser is registered per content-type GLOBALLY, not per-route — every route in the process shares the one under test, so any route demonstrates it, and a locally declared one keeps the test independent of route-level auth and schema validation.

### §67. The regression this whole change exists for

The regression this whole change exists for. On the base commit this exact request returned 201 Created from `POST /services` and stored `{"ok":1}` — accepted, silently partially discarded, reported as success. The parser must never again answer 2xx here.

### §68. Was 500 Internal Server Error on the base commit

Was 500 Internal Server Error on the base commit: the parser rethrew a raw `SyntaxError`, which carries no `statusCode`, so `setErrorHandler` fell through to its catch-all and reported a client typo as a server fault.

## `apps/server/src/main.ts`

### §69. Phase 1 — admin/bootstrap connection

Phase 1 — admin/bootstrap connection: migrations + login-role provisioning ONLY (PR #4 security review, CRITICAL 3; pg-boss role added for the M3 tracked security follow-up). Migrations create `scp_app` (NOSUPERUSER, NOBYPASSRLS), `scp_relay`, and `scp_pgboss` (schema-scoped to `pgboss` only, no grants on `public`) and apply RLS; provisioning grants each LOGIN with its runtime password. The admin pool is closed before the server serves anything.

M8 hardening: `SCP_SKIP_MIGRATIONS=true` (the Helm chart's `api`/`worker` Deployments) skips ALL of this — `config.databaseUrl` (admin-capable) is never even connected to from these pods. The chart's migrations Job (`migrate-bin.ts`) runs this exact same work, once, as a pre-upgrade hook, using the admin connection ONLY that Job holds. Every other deployment shape (compose, `pnpm dev`, every E2E script) leaves `SCP_SKIP_MIGRATIONS` unset and keeps this unchanged.

### §70. THE FEDERATION-IDENTITY STARTUP CHECK

THE FEDERATION-IDENTITY STARTUP CHECK (federation/self-origin-check.ts has the full rationale).

Every reconcile candidate query filters on `objects.origin_domain_id = federation_self.domain_id`. If those two ever diverge — a partial restore, an org cloned into a fresh database, a rebuild that recreated the `federation_self` row — every batch comes back empty and ALL coordination for that org stops with no error and no log line. That is the exact shape of the 13-day production outage this codebase already measured, and a green `/healthz` (four lines below) says nothing about it.

WHY HERE, three ways: - AFTER `ensureBootstrapAdmin`, because that is the one code path that creates an org and its first locally-authored objects; running before it would inspect an org that does not exist yet. - BEFORE `app.listen` and before the loops start, so the warning is in the log AHEAD of the first silent tick rather than buried under an hour of ordinary request logging. - UNCONDITIONALLY, not inside the `runsBackgroundWork` guard below. The damage lands on the worker, but the api pod is where an operator looks first, and in the chart's default split topology only one of the two would otherwise say anything. It costs two small reads per org, once per boot — it is emphatically NOT on the reconcile hot path, which was the whole reason a per-tick empty-batch probe was rejected in favour of this.

Read-only and non-fatal: it never repairs the divergence (which side is wrong depends on where the good backup is — an operator decision), and it never blocks boot, exactly like the ephemeral secrets-key and expired-CRL warnings.

### §71. THE SUBPROCESS PLUGIN HOST

THE SUBPROCESS PLUGIN HOST — constructed for EVERY role, including `api`.

It used to be built inside the `all|worker` guard below, next to the loops, so a split api/worker deployment (the Helm chart's default, and how the homelab runs) left `deps.pluginHost` undefined on the api process and `POST /discovery/run` answered 400 "discovery requires a worker-capable process" — on the ONLY process that serves HTTP. Discovery was unreachable in the topology the chart ships, and the operator-facing remediation ("SCP_ROLE=all") is wrong advice: it would ALSO start a second reconcile/watchdog/observe loop set beside the worker's.

The guard conflated two different needs. The LOOPS need pg-boss, the outbox relay and a single-writer role — that is what `all|worker` protects, and it is unchanged below. Discovery needs only the ability to dispatch a plugin for the duration of ONE request. Hosting plugins is not background work, so it does not belong behind a background-work guard.

What stays role-gated is the shared fake-executor INSTANCE: it exists for the coordination loops (coordination/executor-config.ts), so an api-only process starts the host with NO pre-registered instances and pays only for an idle supervisor. Discovery registers its own instance per request either way, so it never depended on that default.

Egress is unchanged and was verified before this landed: the chart's executor NetworkPolicies select every pod of the release rather than the worker alone, and the app-level SSRF egress guard is per-plugin-instance, not per-process. Neither boundary moves because a different process dispatches the plugin.
`runsBackgroundWork(config)` is IMPORTED, not inlined (`background-work.ts`). It used to be an inline `config.role === "all" || config.role === "worker"`, and that made it unreachable by any test: setting it `false` — killing all eleven loops below — left the entire apps/server unit suite green, because nothing can import this file. The predicate is now a pure exported function with its own coverage, and the loops it gates are a registry that is STARTED in a test.

### §72. THE SSE BRIDGE

THE SSE BRIDGE — started for EVERY role, same reasoning as the plugin host just above.

`app.listen()` below is unconditional: every role actually binds an HTTP listener and serves `GET /events/stream` (routes/events.ts is registered in `buildApp` with no role gate), even a pure `worker` process the chart's Service never routes real traffic to. Since the outbox relay no longer calls `sseHub.publish` directly (events/outbox-relay.ts's doc comment — proposal multi-region-instance-resilience.md §7.1 item 1, closing §4-A1), this bridge is the ONLY thing that can ever feed a process's local `sseHub`, in every topology — including a single `role=all` dev/compose process, where the relay and this route already share one process and it would be tempting to think the direct call was still fine there. It was not: keeping it would have meant an event reaching `sseHub` twice on `role=all` (once direct, once via this bridge's own NOTIFY loopback) and zero times on a split api/worker install. One delivery path, used everywhere, is what makes dev/compose actually exercise the production path.

Cheap either way: one more reconnecting LISTEN connection (events/listen-client.ts) per process, idle until an outbox row commits.
TWO SMALL POOLS FOR THE SSE PATH — ONE isolation decision, in two places (review finding SEC-1)

Neither is the request-serving `pool` above, and for the same reason: the SSE path's database load is driven by EVENT VOLUME and CONNECTED-CLIENT COUNT, not by how many API requests are in flight, and both of those are influenceable from outside a request. `pool` has no `max`, so it is pg's default of 10, and `createPool` sets `connectionTimeoutMillis: 5000` (db/client.ts) — so any SSE-driven checkout that competes with request handlers turns into request TIMEOUTS. Isolating them means a starved SSE pool degrades only SSE (stale frames, dropped frames — best-effort is the stream's own contract, ADR-0025 D4), never request serving or coordination.

1. `sseBridgePool` — the bridge's outbox fetches, driven by a Postgres NOTIFY channel any DB login can write to. `max: 2` caps the blast radius of a NOTIFY flood to this pool alone. 2. `sseAuthzPool` — `GET /events/stream`'s PER-FRAME `object:read` walk (routes/events.ts), one tenant transaction per (connection, distinct subject) per memo window. Its `max` is IMPORTED from that route as `SSE_AUTHZ_POOL_MAX` rather than written as a literal here, so the number and the paragraph justifying it (beside `READ_MEMO_TTL_MS`, which sets how often a check recurs) cannot drift apart.

`deps.sseAuthzDb` is assigned AFTER `buildApp`, exactly like `deps.pluginHost`/`deps.boss` (types.ts): the route reads it inside its handler, and no handler can run before `app.listen` far below.

### §73. The pool for the recursive-CTE graph read routes

3. `graphQueryPool` — the recursive-CTE graph read routes (routes/graph.ts). Same isolation rationale as the SSE pools: their cost is driven by graph shape + caller parameters, not by request volume, so a burst of expensive traversals must not starve the request pool and turn other tenants' requests into checkout timeouts. `max` imported as `GRAPH_QUERY_POOL_MAX` so the number and its justification cannot drift. Assigned after `buildApp`, like `sseAuthzDb`.

### §74. Outbox relay + pg-boss worker skeleton (DESIGN.md §8)

Outbox relay + pg-boss worker skeleton (DESIGN.md §8) — only the roles that own background work run them; `role=api` stays a pure request server for everything EXCEPT request-scoped plugin dispatch (see the plugin-host note above). The relay runs on the runtime pool and assumes the outbox-only `scp_relay` role per transaction; pg-boss connects as the schema-scoped `scp_pgboss` login role (M3 tracked security follow-up — pg-boss no longer runs its own schema migrations on the admin/superuser connection).

### §75. M21.4 (ADR-0032 §7): the domain-event stream's real consumers

M21.4 (ADR-0032 §7): the domain-event stream's real consumers. `boss.work()` is a competing consumer, so a feature that reacts to an event registers a ROUTER rather than a second worker on `domain-events` — the router makes one cheap decision and enqueues onto that capability's own queue, worked by the `start…Loop` calls below.

WHICH routers, and under WHICH role guard, is `events/domain-event-registry.ts` — not a literal here. Until M21.7 it was a literal here, and that is precisely why nothing could check it: `main()` runs at module scope, so no test can import this file, so the census that guarded the list had to read this file as TEXT — and text cannot tell a live registration from an unreachable one (an inverted guard leaves the factory's name sitting right there in the source). The registry is a pure value, so `events/domain-event-routers.test.ts` now EXECUTES it for a matrix of configs and asserts what is actually registered, against the set of routers it discovers in the tree. The one thing that census still reads as text is the line below — that this composition root calls `domainEventRouters` at all.

### §76. NATS JetStream EventBus backend toggle

NATS JetStream EventBus backend toggle (DESIGN.md §8 "Scaling insurance", BUILD_AND_TEST.md M3 item 8) — `config.eventBus.backend === "postgres"` (the default) leaves `natsFanout` undefined and the relay's behavior completely unchanged. Connecting is NOT wrapped in try/catch: an explicit `nats` opt-in with an unreachable/misconfigured server must fail boot loudly, not silently degrade to Postgres-only fan-out.

### §77. EVERY BACKGROUND LOOP THIS PROCESS RUNS

EVERY BACKGROUND LOOP THIS PROCESS RUNS — `background-work.ts`'s `BACKGROUND_LOOPS`, not a list of eleven `const`s here, and not eleven matching `.stop()` calls in the `onClose` below.

WHY IT MOVED. This block used to hand-write both halves, and both were unverifiable: nothing can import this file (`main()` runs at module scope), so every test that claimed to check the wiring was matching SUBSTRINGS. Measured 2026-08-17 — flipping this block's own condition to `false`, killing all eleven loops, left `bump-dispatch`, `bump-gate`, `inventory-ingestion` and `domain-event-routers` green at 79/79 and the whole unit suite green. A registry is a pure importable value, so `background-work.test.ts` STARTS it against a probe boss and asserts what actually happened, and a loop that is never registered fails that test rather than shipping inert. Same move, same reason, as M21.7 moving the router list into `domain-event-registry.ts`.

The one link still checked as text is the CALL BELOW — see that test file, which says so.

### §78. When that is set, the app builds its own listener

M9.3 (ADR-0001): when `config.federationServerMtls` is set, `buildApp` (app.ts) already constructed this Fastify instance with `https: {..., requestCert: true, rejectUnauthorized: false}` — the listen call itself is unchanged either way, Fastify just binds an `https.Server` instead of `http.Server` under the hood. Per-route enforcement (rejecting an unauthorized/ unregistered peer on the three federation transport routes) lives in `federation/mtls-enforcement.ts`'s `enforceFederationMtls`, not here. When `federationServerMtls` is unset (the default), this is byte-for-byte the pre-M9.3 plain-HTTP behavior; server-side mTLS enforcement then lives only at the deployment edge (`deploy/helm/templates/ingress.yaml`'s `ingress.mtls` — nginx client-cert-verification annotations, see deploy/helm/README.md's "Federation mTLS" section). D6 / B3 (§7.3) — PROVE the configured secrets master key decrypts this instance's vault BEFORE binding the listener, in production mode. A member cluster (or a restored instance) booting with the wrong key would otherwise serve happily and fail every executor call later, one at a time, with no single loud signal. A throw here fails the process closed. Evaluation mode skips it (an eval stack may legitimately run on an ephemeral key with an empty or throwaway vault).

### §79. GRACEFUL SHUTDOWN ON SIGINT/SIGTERM

GRACEFUL SHUTDOWN ON SIGINT/SIGTERM — newly required by `host.ts`'s process-group kill fix. Plugin subprocesses are now spawned `detached: true` (their own process group, so a hang- timeout SIGKILL can take down a `docker` child with it instead of orphaning it — see that file's `killInstanceProcess` doc comment). The side effect: they no longer sit in THIS process's foreground process group, so a terminal Ctrl-C (`pnpm dev`) no longer reaches them for free the way it used to — nothing here previously called `app.close()` on a signal either, so a plain container SIGTERM (Kubernetes pod termination, pid 1, never a process-group signal) was already not gracefully handled before this change. Both paths now go through the same `onClose` hooks above, which is where `pluginHost.stop()`/`backgroundLoops.stop()`/etc. already live — one graceful-shutdown path instead of relying on OS job-control as an accident of the process tree shape.

### §80. Revocation-list reload without a full restart

M9.3 (ADR-0001 §8): CRL reload without a full restart, so a revocation can take effect in a running (possibly air-gapped) instance by dropping in a new CRL file and signaling this process — no network fetch, matching CLAUDE.md principle 5. Re-runs the SAME loader used at boot (`loadFederationServerMtlsConfig`), so a reload is held to the identical validation (CA/ cert/key still required together, the same warn-vs-hard-fail-on-expiry policy for the CRL); `tls.Server#setSecureContext` atomically swaps the context for all FUTURE handshakes without dropping already-established connections. A reload failure (e.g. an operator drops in a corrupt file) is logged and the PREVIOUS material stays in effect — a bad reload attempt must never take down an already-running, correctly-configured listener.

### §81. BUILD_AND_TEST.md §5.3 — eval-stack demo data

BUILD_AND_TEST.md §5.3 — eval-stack demo data (SCP_SEED_DEMO, off by default; the compose eval stack turns it on). Needs the server actually listening (it talks to itself over HTTP, PUBLIC API ONLY — seed.ts module doc), hence after `app.listen` above, not before. A nice-to-have, not boot-critical: logged and swallowed on failure, never crashes the server. `&& bootstrap`: a process that did not CREATE the admin holds no fresh one-time password, so it cannot log in to seed — the same reason seed.ts already skips when `oneTimePassword` is null. The eval stack that turns this on runs `SCP_ROLE=all`, which does create it.

## `apps/server/src/migrate-bin.ts`

### §82. Standalone migrations entrypoint

Standalone migrations entrypoint (M8 — BUILD_AND_TEST.md §8 M8 item 1, DESIGN.md §16: "Migrations Job (pre-upgrade hook): Drizzle migrations, forward-only, expand/contract pattern for zero-downtime"). `deploy/helm`'s migrations Job runs exactly `node dist/migrate-bin.js` as a Helm `pre-upgrade,pre-install` hook, using the SAME admin/bootstrap `DATABASE_URL` `main.ts`'s Phase 1 already uses — this file performs ONLY that phase (`runMigrations` + the two `provision*Role` calls) and exits, rather than going on to boot the HTTP server or the worker loops.

Deliberately NOT a new `SCP_ROLE` value threaded through `main.ts`: this is a genuinely different process shape (run once, to completion, then exit 0 — the Kubernetes Job model) from `main.ts`'s "boot and serve forever" shape, and keeping them as separate entrypoints means neither has to grow a conditional early-return path the other doesn't need.

Idempotent and safe to run concurrently with itself or with `main.ts`'s own Phase 1 (every existing pod's `main.ts` still runs the identical Phase 1 on its own boot, unchanged — this Job is additive, not a replacement): `runMigrations` only applies migrations Drizzle's own tracking table shows as not-yet-applied, and `provision*Role`'s `ALTER ROLE ... WITH LOGIN PASSWORD` is a plain idempotent SQL statement. Running this Job FIRST, as a pre-upgrade hook (before the new image's `api`/`worker` Deployments roll out), is what makes the zero-downtime expand/contract proof possible: the schema is migrated before any new-version pod exists, so OLD-version pods keep serving traffic against the (expand/contract-compatible) NEW schema for the whole rollout window.

### §83. §7.4 VERSION-SKEW GATE

§7.4 VERSION-SKEW GATE — a CONTRACT-phase deploy (operator sets SCP_MIGRATION_PHASE=contract on the migrations Job) must not run while an OLD-version member cluster is still live, because a contract migration is safe only once every member runs the release that shipped its expand half (N and N+1 only). Fails OPEN on the very first deploy (before 0093 creates the heartbeat table). An expand-phase deploy (the default, SCP_MIGRATION_PHASE unset) never gates — that is exactly the phase you run WHILE old-version pods are still up.

## `apps/server/src/pagination.ts`

### §84. Cursor-based pagination codec shared by every list endpoint

Cursor-based pagination codec shared by every list endpoint (DESIGN.md §6: stable ordering by `(created_at, id)`). Originally lived in `services/objects-service.ts` (M0); factored out here once the generic graph endpoints, type registry, relationships, and audit log all needed the identical codec.

### §85. `null` for anything that is not a well-formed cursor

`null` for anything that is not a well-formed cursor — undecodable base64/JSON, a missing or non-string field, or a `createdAt` that does not parse to a real Date (which would otherwise throw `RangeError: Invalid time value` from `toISOString()` inside the SQL builder). Every caller treats `null` as "no cursor" (the first page), so a garbage cursor gets the first page rather than an Internal Server Error.

### §86. Millisecond keyset pagination, shared so both agree

Millisecond-precision keyset pagination, shared so the WHERE comparison and the ORDER BY are defined ONCE and can never drift apart (a mismatch between them is its own subtle bug).

WHY MILLISECONDS: `created_at` is stored at Postgres MICROSECOND precision, but a pagination cursor round-trips through a JS `Date` (MILLISECOND precision, via `encodeCursor` → `toISOString`). Comparing the RAW column re-includes the boundary row — its sub-millisecond tail is strictly greater than the truncated cursor — so a result set larger than one page whose rows share a `created_at` millisecond (a bulk import committed in ONE transaction, every row stamped with the same `now()`) never advances `nextCursor` and the SDK/CLI `listAll*` iterator loops forever. Truncating the column to `date_trunc('milliseconds', created_at)` makes the sort key exactly what the cursor can carry, so `(created_at_ms, id)` is a stable, terminating keyset.

The `id` column is ALWAYS part of the key (both here and in `keysetOrderBy`): without it, same-millisecond rows are not merely re-visited but silently DROPPED across a page boundary.

## `apps/server/src/seed.integration.test.ts`

### §87. Idempotency is non-negotiable

Idempotency is non-negotiable (M2 seed spec, BUILD_AND_TEST.md §5.3): running the seed logic twice in a row (mirroring "boot the server twice against the same volume") must be a true no-op the second time — same object/relationship ids, no duplicates, no errors. Exercises `seedDemoData` directly (not `loginAndSeedDemoData`/the standalone CLI) against a real listening test server, per this file's own module doc on why that split exists.

## `apps/server/src/seed.ts`

### §88. M2 demo seed

M2 demo seed (BUILD_AND_TEST.md §5.3). This implements the M2-AVAILABLE SUBSET of §5.3's full aspirational "five-minute value" description: a domain, services + components, and ownership/depends_on/consumes edges — all created through the PUBLIC API (never graph/objects-repo.ts or any other repo-layer function directly), using upsert-by-URN (objects) and 409-as-no-op (relationship edges, which have no upsert endpoint) so re-running this function is always a true no-op.

Deliberately DOES NOT seed: an executor connection (ExecutorPlugin/fake-executor land in M3), a policy (M4), or an in-flight change (M3). Those milestones should EXTEND `seedDemoData` below with their own idempotent steps, not replace it.

### §89. Those edges have no upsert-by-urn equivalent

`owns`/`consumes`/`depends_on` edges have no upsert-by-URN equivalent (they're plain creates guarded by a uniqueness constraint) — a second seed run hits 409 Conflict, which is success here, not an error (routes/ownership.ts module doc).

### §90. Creates the M2 demo graph

Creates the M2 demo graph (idempotent — safe to call any number of times against the same org): one domain ("platform"), two services ("checkout", "payments-gateway") and three components under them, one team ("platform-team") owning "checkout", one `depends_on` edge (checkout -> payments-gateway) and one `consumes` edge (checkout-api -> payments-gateway-api). `client` must already be authenticated as a subject with `object:write`/`relationship:write` at the org root (the bootstrap admin, in practice).

### §91. Logs in as the bootstrap admin and seeds demo data

Logs in as the bootstrap admin and runs `seedDemoData` against the server's own public API (`config.internalBaseUrl` — the same "server calls its own API" pattern historically used by the retired `/ui` stub, apps/server/src/routes/ui.ts). Local-auth's one-time bootstrap password is shown exactly once and never stored (auth/local-auth.ts) — so this can only log in when `bootstrap.oneTimePassword` is set, i.e. the admin was freshly created THIS run. If the admin already existed (a prior boot/seed already ran), there's no credential to log in with; that's fine — either the demo data is already there from that prior run, or it never was and this is a known, documented limitation of not persisting the OTP (a deliberate security tradeoff, not a bug).

### §92. `pnpm seed` standalone entrypoint

`pnpm seed` standalone entrypoint (`tsx src/seed.ts`, BUILD_AND_TEST.md §5.4 command table) — a one-command "seed my dev database" tool. Same two-phase admin/runtime connection split as main.ts (PR #4 security review, CRITICAL 3): admin connection for migrations + role provisioning, then the seed writes run as the least-privileged `scp_app` runtime role.

The demo-data step needs a real listening server to call itself over HTTP (PUBLIC API ONLY — module doc above), so this spins one up just for the duration of seeding, then closes it — this script's whole job is to seed and exit, not to serve traffic. Unlike main.ts's `SCP_SEED_DEMO`-gated boot-time step, this runs unconditionally (not gated on that env var) — deliberate seeding is this script's entire purpose.

### §93. Guard `main()` to only run when this module is executed directly

Guard `main()` to only run when this module is executed directly (`tsx src/seed.ts` / `node dist/seed.js`) — NOT when `loginAndSeedDemoData`/`seedDemoData` are imported as a library (main.ts's boot-time `SCP_SEED_DEMO` path, seed.integration.test.ts). ESM has no `require.main === module`; comparing `import.meta.url` to the invoked script path is the standard equivalent.

## `apps/server/src/types.ts`

### §94. A small pool dedicated to the per-frame read checks

A SMALL pool dedicated to `GET /events/stream`'s PER-FRAME `object:read` check (routes/events.ts), assigned by `main.ts` right beside the SSE bridge's own `max: 2` pool.

WHY IT EXISTS. That check is a recursive-CTE permission walk inside a tenant transaction, run once per (connection, distinct subject) per memo window — so it is long-lived, streaming, fan-out-shaped load whose volume is set by how many events the org produces and how many clients are connected, NOT by how many API requests are in flight. Putting it on `db` (the request-serving pool, `max` = pg's default 10) means a bulk import or a reconcile sweep — a stream of DISTINCT subjects, which the memo cannot collapse — competes for connections with ordinary request handlers, and `createPool`'s `connectionTimeoutMillis: 5000` (db/client.ts) turns that contention into REQUEST TIMEOUTS. This is the same property, one layer down, that `main.ts`'s `sseBridgePool` comment already names (review finding SEC-1); the two pools are ONE isolation decision about the SSE path, not two unrelated ones.

OPTIONAL ON PURPOSE. `buildApp` is also called by `openapi:emit` and by every test harness, which construct deps by hand (`{ db, config }`). routes/events.ts falls back to `deps.db` explicitly when this is absent — the fallback is the pre-existing behaviour, so a hand-built deps still serves the stream correctly, just without the isolation.

### §95. A SMALL pool dedicated to the recursive-CTE graph read routes

A SMALL pool dedicated to the recursive-CTE graph read routes (`GET /graph/traverse`, `/graph/query/:name`, `POST /graph/subgraph`, and the org-wide integrity report — routes/graph.ts), assigned by `main.ts` beside the SSE pools and sized by `GRAPH_QUERY_POOL_MAX`.

WHY IT EXISTS. Those handlers run depth-bounded recursive CTEs whose cost is driven by GRAPH SHAPE and the caller's parameters, not by request volume — an authenticated caller can fire several expensive traversals and, on the request-serving `db` pool (pg default max 10, `connectionTimeoutMillis: 5000`), turn every OTHER tenant's ordinary request into a checkout TIMEOUT. Isolating them means a starved graph pool degrades only graph reads, never request serving or coordination — the same isolation decision as `sseAuthzDb`, one route family over.

OPTIONAL ON PURPOSE, exactly like `sseAuthzDb`: hand-built deps (`openapi:emit`, test harnesses) omit it and routes/graph.ts falls back to `deps.db` (correct, just unisolated).

### §96. The process's job-queue handle, present on some roles only

M14.2 (ADR-0009): the process's pg-boss handle, present only on `role === "all" || "worker"` (set by `main.ts` alongside `pluginHost`, once `startPgBoss` has run). The inbound federation poke endpoint (`routes/federation.ts` `POST /federation/poke`) uses it to enqueue an IMMEDIATE federation-sync tick — waking the M14.0 pull loop now rather than at the next interval — WITHOUT doing the pull inline. A pure `role === "api"` process has none, in which case an accepted poke is a no-op-but-accepted (the sparse safety-net + a worker process are the reliability floor).

### §97. The sandboxed CEL evaluator (governance/cel-sandbox.ts)

The sandboxed CEL evaluator (governance/cel-sandbox.ts) — every request-serving process needs one for gate evaluation (routes/changes.ts's accept handler), regardless of whether it also runs the `PluginHost`-requiring reconciliation loop (DESIGN §16's api/worker split; see coordination/gates.ts's module doc). Lazily defaulted to the process-wide shared instance (`getSharedCelSandbox()`) by `buildApp` when the caller doesn't supply one, so every existing `buildApp({db, config})` call site (openapi:emit, tests) keeps compiling unchanged.

### §98. M7: an in-process `PluginHost`

M7: an in-process `PluginHost`. `main.ts` now constructs one for EVERY role, including a pure `role === "api"` process — hosting a plugin for the duration of one request is not background work, so it does not belong behind the background-work guard.

It used to be built inside that guard, which meant a split api/worker deployment (the Helm chart's default) left this undefined on the only process serving HTTP, and `POST /discovery/run` 400'd unconditionally. What remains role-gated is the shared fake-executor INSTANCE, which exists for the coordination loops; an api-only host starts with none, and discovery registers its own per request regardless.

`routes/executors.ts`'s `POST /discovery/run` is the one API route that genuinely needs a live, on-demand plugin call (a `DiscoveryPlugin.discover()` scan) rather than deferring to the reconcile loop. It still 400s rather than crashing if this is somehow absent — `buildApp` is also called directly by tests and `openapi:emit`, which construct deps without a host.

Every other M7 plugin call (executor trigger/status, control evaluate, notification send) runs from worker-side code with its own `host` parameter threaded in — this is deliberately the ONLY route-layer use.

## `apps/server/vitest.config.ts`

### §99. Unit layer (BUILD_AND_TEST.md §4.1)

Unit layer (BUILD_AND_TEST.md §4.1): pure functions, no Docker, milliseconds. Vitest's default test glob (`**\/*.test.ts`) would otherwise also pick up `*.integration.test.ts` files, which need the Testcontainers Postgres from `vitest.integration.config.ts`'s `globalSetup` — exclude them explicitly so `pnpm test` never depends on Docker.

### §100. COVERAGE THRESHOLDS — a RATCHET, not a target

COVERAGE THRESHOLDS — a RATCHET, not a target (owner decision 2026-08-01: "measure, then set the floor"). BUILD_AND_TEST.md §7 claimed "≥80% unit coverage" while thresholds were configured NOWHERE and `pnpm test` ran bare, so nothing had ever been enforced and the number was aspiration presented as policy.

MEASURED 2026-08-01 on this config: statements/lines 15.09%, branches 74.78%, functions 31.58%. The floors below sit a point or two under each, so an ordinary refactor doesn't red CI but a real regression does. RAISE THEM when coverage rises; never lower one to make a red run green.

WHY STATEMENT COVERAGE IS LOW AND WHY THAT IS NOT ALARMING HERE: the denominator is every source file in the package, but this layer is the UNIT layer only — `*.integration.test.ts` is excluded above and runs under `vitest.integration.config.ts`, where the overwhelming majority of this codebase's behaviour is actually exercised (real Postgres via Testcontainers, per CLAUDE.md: "Integration tests run against real PostgreSQL — never a mocked DB"). A high unit-statement number would mean logic had been pulled out of the database layer to be testable without one, which is the opposite of this project's testing strategy. BRANCH coverage (74.78%) is the meaningful figure at this layer: it measures the pure decision logic that unit tests do own.

### §101. RAISED FROM THE 5s DEFAULT BECAUSE COVERAGE IS NOW ON IN CI

RAISED FROM THE 5s DEFAULT BECAUSE COVERAGE IS NOW ON IN CI (stage 4 runs `pnpm test -- --coverage`), and v8 instrumentation is not free for the handful of unit tests that do real cryptography. Measured 2026-08-01: `federation/crl-reload.test.ts` and `federation/crl-parse.test.ts` (real CA + leaf issuance and a live TLS handshake against `setSecureContext`) run in ~500ms uninstrumented and ~5,100ms under coverage — straddling the 5s default, which flaked roughly 1 run in 4.

This is a headroom change, not a slow-test licence: a test that PASSES is unaffected by the timeout, so the only cost is that a genuinely hung test takes longer to be declared dead. If a unit test ever legitimately approaches this, that is a signal it belongs in the integration layer, not a reason to raise the number again.

### §102. The hook budget: a second deadline nobody chose

THE HOOK BUDGET, declared for the reason `@scp/source-census`'s `test-budget-census.test.ts` gives in full: vitest's `hookTimeout` is a SECOND, independent deadline whose implicit default (10,000ms) nobody chose, and the only hook cost this repo has ever measured under CI's load profile — `@scp/cli`'s lazy-import warm-up — was 5,400ms against it. 30,000 is 25x the isolated worst case in the unit layer (1,205ms) and half the un-declarable 60,000ms `onTaskUpdate` RPC deadline a synchronous hook would otherwise be free to cross.

### §103. Enabled in-config and only under CI, not on the command line

ENABLED IN-CONFIG AND ONLY UNDER CI, not `--coverage` on the CI command line. The flag used to be passed as `pnpm test -- --coverage`, and anything after turbo's `--` is folded into the hash of EVERY task in the graph — all 38 `:build` tasks missed cache and re-executed inside the test job (measured 2026-08-31: @scp/server#build completed at t+162s of the unit-test step, delaying this package's suite by exactly that). In-config enablement collects the same coverage with unmodified build hashes.

CI-CONDITIONAL because an unconditional `enabled: true` gates FILTERED runs too — a dev running one test file collects that file's coverage against the whole-package denominator and fails the floor (measured: a single apps/web file run reports 11.55% against the 38% floor and exits 1). Local behaviour therefore stays exactly what it was before this change: bare and filtered runs collect nothing. CI behaviour also stays what it was: every unit run collects and the thresholds bind. `CI` is declared in turbo.json's `test` env list, so a CI run and a local run hash differently and can never replay each other's cached results — behaviour that differs must not share a cache key. `coverage-census.test.ts` (@scp/source-census) asserts every config with thresholds carries exactly this line, so the pairing cannot silently regress.

## `apps/server/vitest.integration.config.ts`

### §104. Integration layer (BUILD_AND_TEST.md §4.2)

Integration layer (BUILD_AND_TEST.md §4.2): real PostgreSQL 16 via Testcontainers, never a mocked DB. One container for the whole run (test-support/global-setup.ts), which migrates a `scp_template` database once.

LEVER 3 — PARALLEL execution via per-worker template-DB isolation (was `singleFork: true`). Each worker fork clones its own private database from `scp_template` (test-support/per-worker-db.ts, a `setupFiles` entry that runs inside every worker), so files in different workers never share the instance-scoped singleton tables, the single `pgboss` schema, or the org-filter-less outbox relay — the three collision classes that previously forced serial execution.

ISOLATION IS PER *FILE*, NOT PER WORKER — measured 2026-08-03. `isolate` defaults to true, so `pool: "forks"` gives each test FILE a fresh child process; `setupFiles` therefore re-runs per file and `provisionWorkerDatabase`'s `DROP DATABASE ... WITH (FORCE)` + `CREATE ... TEMPLATE` runs again. A three-file probe under `SCP_TEST_MAX_FORKS=1` saw the same database NAME (`scp_w1`) holding 1 org in the first file and 0 orgs in the third: same name, recreated contents.

Worth stating because the previous wording ("files WITHIN a worker still run serially against that worker's database") reads as though files SHARE data. They do not, and that sent one investigation chasing a cross-file interference hazard that cannot occur: the reconcile and watchdog loops DO enumerate every org (`runReconcileSweep`, `runWatchdogSweepForAllOrgs` — neither is tenant-scoped, correctly, since production is one instance serving many orgs), but the only orgs in a file's database are the ones that file created.

`maxForks` is capped (default 4) to match the CI runner's core count — which happens to still be 4 on a GitHub-hosted standard `ubuntu-latest` runner, the same number the old homelab ARC pod's CPU limit gave (docs/BUILD_AND_TEST.md §6.1). Override with `SCP_TEST_MAX_FORKS` on a runner with more cores. Locally, raise it to your core count for maximum parallelism.
