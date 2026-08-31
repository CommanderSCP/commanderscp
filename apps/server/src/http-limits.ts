/**
 * HTTP request body-size ceilings (Fastify `bodyLimit`).
 *
 * The GLOBAL default applies to EVERY route unless it opts up. It is deliberately modest: a small
 * endpoint like `POST /auth/login` has no reason to accept a multi-megabyte body, and letting it
 * would hand a synchronous `JSON.parse` + prototype-poisoning walk (app.ts's pre-auth parser) a
 * huge payload that blocks the event loop — a cheap DoS from an unauthenticated caller. 4 MiB is
 * generous for any normal API JSON (object `properties`, executor `config`, a campaign plan, …)
 * while keeping that parse bounded.
 *
 * Two doors legitimately ingest much larger payloads and opt UP to LARGE per-route:
 *   - POST /federation/imports — a signed `.scpbundle` arrives as one JSON body (routes/federation.ts).
 *   - POST /change-sources/:kind/report — carries an open-ended IaC `planJson` blob (routes/change-sources.ts).
 * LARGE is still a finite, explicit ceiling (not unbounded) — the oversized-payload defense a
 * bundle/plan parser must keep. Historically the GLOBAL was 64 MiB purely to accommodate bundles;
 * moving that 64 MiB to the two routes that need it lets every other route fall back to the modest
 * default. (2026-08-31 security review.)
 */
export const GLOBAL_BODY_LIMIT_BYTES = 4 * 1024 * 1024;
export const LARGE_BODY_LIMIT_BYTES = 64 * 1024 * 1024;
