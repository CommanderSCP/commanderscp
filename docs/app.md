# app

Reference for `apps/server/src/app.ts`. The source carries a one-line headline at each site and points here.

> Partial: 4 of 9 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. Builds (but does not start listening on) the Fastify app

Builds (but does not start listening on) the Fastify app. Never touches the database at construction time — `pg.Pool` connects lazily — so `openapi:emit` can boot route definitions without a DB (BUILD_AND_TEST.md §8 M0).

## §2. Global body ceiling (http-limits.ts)

Global body ceiling (http-limits.ts). Modest by default so a small route (e.g. /auth/login) can't be handed a huge JSON body that blocks the event loop in the synchronous JSON.parse + prototype-poisoning walk below. The two doors that ingest large payloads — POST /federation/imports (a `.scpbundle` as one JSON body) and POST /change-sources/:kind/report (an open-ended IaC planJson) — opt UP to LARGE_BODY_LIMIT_BYTES per-route. Both limits are finite and explicit (never unbounded — the oversized-payload DoS a bundle parser must defend against), and enforced by Fastify BEFORE the body reaches JSON.parse or any route code. (2026-08-31 security review; the global was previously a flat 64 MiB for bundles' sake.)

## §3. A FRAMEWORK-RAISED CLIENT ERROR KEEPS THE STATUS THE FRAMEWORK GAVE IT

A FRAMEWORK-RAISED CLIENT ERROR KEEPS THE STATUS THE FRAMEWORK GAVE IT. Everything Fastify refuses before a route handler runs — unsupported media type, oversized body, a `content-length` that does not match the bytes — arrived here with a correct `statusCode` that this handler used to drop on the floor, answering 415/413/400 conditions with 500. `frameworkClientProblem` (errors.ts) carries the full census, and the reason it is narrower than a bare `err.statusCode` read: `undici`'s errors carry an UPSTREAM response's status under that same property name.

Logged at `info`, not `error`: these are the caller's mistakes, and the whole harm of the old behaviour was that a client typo looked like a server fault to everything downstream of the logs as well as to the client.

## §4. THE PRODUCER DECLARATION'S AUTHORING SURFACE

THE PRODUCER DECLARATION'S AUTHORING SURFACE (ADR-0032 §7e). Without this line `declareDependencyLineProducer` has no non-test caller, `dependency_line_producers` stays empty, and the INTERNAL half of dependency subscriptions cannot fire in production at all — that is the defect the route exists to close, so deleting this registration must turn `dependency-producers.integration.test.ts`'s "WIRING" case red rather than merely removing a convenience.
