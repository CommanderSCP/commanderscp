# ADR-0025: The live event stream is a declared operation — SSE API parity, and who owns reconnection

**Status:** **Accepted (owner-decided 2026-08-01 — the full fix: declare the operation AND migrate the UI off `EventSource`, then delete the sweep exemption).** Implemented in this change.
**Relates to:** charter principle 3 (API-first parity — "the UI and CLI consume only the generated SDK; nothing may bypass the public API"); principle 6 (explainability); DESIGN.md §6, §8, §14, §15; [ADR-0023](0023-sdk-response-validation.md) (SDK response validation — this closes the one surface that ADR named as outside its bound); `apps/web/e2e/openapi-conformance.ts` (the no-bypass sweep)

---

## Context

`GET /api/v1/events/stream` (M2, DESIGN.md §6/§8) was the platform's only endpoint outside the contract pipeline. It was registered as a raw `app.get` that the OpenAPI emitter never saw, on the stated ground that "SSE is a raw streaming response, not a JSON request/response pair the contract pipeline models." Three separate places in the tree had grown a comment explaining the resulting hole rather than closing it:

1. **The no-bypass sweep** (`apps/web/e2e/openapi-conformance.ts`) carried an exemption list — `UNDECLARED_BY_DESIGN` — with exactly one entry, plus two unit tests pinning it in both directions. The sweep captures every request the browser makes and asserts each is a declared operation; without the carve-out it failed on every run, because `RootLayout` opens the stream on **every page**.
2. **ADR-0023** stated its own bound as "204/204 *spec'd* operations — not 100% of what the SPA parses", and named this stream as the one live surface outside it: `JSON.parse(event.data) as RelayedEvent` is a bare cast of network bytes, the exact class that ADR abolishes everywhere else.
3. **`eslint.config.mjs`** banned the `EventSource` global across `apps/web` and then re-permitted it for one file via a trailing override block.

So the gap was well-described and structurally fenced, but it was still a charter-principle-3 violation: one surface where the UI spoke to the API without the SDK, over an undeclared URL, parsing unvalidated bytes.

The blocker was believed to be the generator. It is not: `@hey-api/openapi-ts` 0.99 detects `text/event-stream` on a response (`hasOperationSse`) and switches the emitted call onto `client.sse.get`, and `@hey-api/client-fetch` already ships `createSseClient` — frame parsing, `Last-Event-ID` tracking, and a `responseValidator` hook — in the committed generated core.

## Decisions taken

### D1. The 200 is declared as `text/event-stream`, from a Zod schema, like everything else

`RelayedEventSchema` (`packages/schemas/src/events.ts`) is the frame contract. The route declares it through `config.openapi.eventStream`, which `openapi/build-document.ts` emits as `content: { "text/event-stream": … }`.

It is **not** declared as a Fastify `schema.response[200]`, because Fastify's response schema drives serialization of one reply body and an SSE handler writes frames to `reply.raw` itself — there is no single body to serialize. Only the error responses (401/403) are Fastify-serialized. This keeps the contract source singular (a Zod schema in `@scp/schemas`) while being honest that the *transport* is not a request/response pair.

### D2. `apps/web` consumes it through the SDK, and the `EventSource` exemption is deleted, not narrowed

`client.events.stream()` returns an async iterator of contract-validated `RelayedEvent`s. The eslint override block is removed and the ban now applies to every file with no exceptions; `UNDECLARED_BY_DESIGN` and its `isExempt` filter are removed from the sweep, which now requires *every* captured call to be declared. The two tests that pinned the exemption are replaced by one asserting the stream is declared and passes on its own merits — deleting them outright would have left nothing to fail if a regression dropped the declaration.

### D3. Reconnection is owned by the SDK, explicitly, and tested by killing connections

This is the decision with real risk in it. `EventSource` reconnects for free; the generated `createSseClient` **does not fully replace it**. Its retry loop runs only from its `catch`, so a connection that ends **cleanly** — a rolling restart, an idle proxy hangup, a `scpd` redeploy — reaches `done`, exits the loop, and the iterator simply finishes. A UI migrated onto the raw generated call would go permanently silent after the first orderly restart, with no error anywhere and nothing appearing broken. That is a strictly worse failure than the gap being closed.

So each connection is opened with `sseMaxRetryAttempts: 1`, reducing the generated client to "one attempt, then finish", and **one** reconnect policy lives in `packages/sdk/src/event-stream.ts`: reconnect forever by default, always wait at least the base delay (a server that instantly closes cannot be hot-looped), exponential backoff while reconnects deliver nothing, backoff reset by any productive connection, resume with `Last-Event-ID` from the last event actually yielded, and stop only on the caller's `AbortSignal`.

`packages/sdk/src/event-stream.test.ts` drives the real `ScpClient` → real generated operation → real `createSseClient` → real `fetch` against a loopback server speaking the exact frame format `routes/events.ts` writes, and kills the connection **both** ways: `socket.destroy()` mid-stream, and a clean `res.end()`. Three mutations were confirmed to fail it: reconnecting only on error, dropping the `Last-Event-ID` header, and not aborting the connection when the consumer stops iterating.

### D4. `Last-Event-ID` is accepted and ignored by the server, and that is stated

`sseHub` is an in-process fan-out of live rows with no per-connection replay buffer, so a reconnecting client resumes at "now" and re-syncs through the query cache it invalidates. This is exactly the behaviour before this change (`EventSource` sent the header too, and it was equally ignored) — it is now written down in `routes/events.ts` rather than left to be inferred from the absence of code. Replay would require durable per-connection cursors over the outbox; it is not proposed here.

## Consequences

- **ADR-0023's bound now reads with no exception.** Every byte the SPA parses off the network goes through a generated operation with a `responseValidator`; the SSE client awaits it **per frame**, so a malformed frame drops the connection instead of reaching a component as a cast.
- **A malformed frame is a connection-level failure, not a per-frame skip.** Validation failure propagates through the generated client's error path, ending that connection; the reconnect policy then reopens with backoff. A server persistently emitting off-contract frames therefore reconnects at the 30s ceiling rather than hot-looping — loud enough to diagnose, bounded enough not to stampede.
- **The SSE error path does not run `ScpClient`'s error interceptor.** `makeSseFn` calls `createSseClient` directly and does not invoke response/error interceptors, so a frame rejection surfaces to `EventStreamOptions.onError` as a raw `ZodError` rather than an `ScpResponseValidationError`. Sharpening that is a possible follow-up; it does not affect the validation guarantee itself.
- **The emitter gained one concept** (`openapi.eventStream`). Any future streaming endpoint declares itself the same way rather than opting out of the contract.

## Multi-process delivery (M26.1)

**Status:** implemented, proposal [multi-region-instance-resilience.md](../proposals/multi-region-instance-resilience.md) §7.1 item 1, closing its §4-A1 finding.

This ADR's D4 stated the stream's contract ("no per-connection replay buffer... re-syncs through the query cache it invalidates") without there ever having been a code path that invalidated anything on reconnect, and without the outbox relay and the SSE route being able to run in different processes at all — the relay published into `sseHub` directly, an in-process `EventEmitter`, and under the default chart topology (`api`×N + `worker`×N) that call could never reach the process actually holding a connected client's `sseHub`. Both gaps are closed together, because they were really one gap: "best-effort, no replay" only means something once delivery can cross a process boundary in the first place.

- **NOTIFY-transported fan-out.** The relay issues `pg_notify('scp_sse_events', …)` from *inside* the same transaction as its batch (`events/outbox-relay.ts`), so delivery is atomic with the COMMIT. A new bridge (`events/sse-bridge.ts`) holds one reconnecting `LISTEN scp_sse_events` per process and republishes into that process's own `sseHub` — started in *every* process, because `main.ts`'s `app.listen()` is itself unconditional (every role serves `GET /events/stream`, even a `worker` pod the chart's Service never routes real traffic to). The relay no longer calls `sseHub.publish` directly anywhere: NOTIFY is now the *only* delivery path, in every topology including a single `role=all` process where the two used to share memory directly — one path everywhere is what makes dev/compose exercise the same code a split install runs.
- **The reconnecting LISTEN client is shared, not duplicated.** `events/listen-client.ts` is the fix for this ADR's neighbouring finding (§4-A5: the relay's own wake `LISTEN` never reconnected after a Postgres blip, silently and permanently demoting it to a 1s poll). Both the relay's wake listener and the new bridge use it.
- **Resync-on-reconnect semantics.** Every LISTEN (re)connection — including the very first, not only recoveries — makes the bridge broadcast a synthetic, schema-valid `RelayedEvent` (`type: "scp.sse.resync"`, `source: "scp"`, empty `data`) to every org this process currently has a connected client for. `apps/web/src/lib/use-event-stream.ts` invalidates the whole TanStack Query cache on that type, **and independently** on its own stream's `onOpen` (a new callback on `packages/sdk/src/event-stream.ts`'s `resilientEventStream`, fired on every successful `open()` including the first) — the two triggers are not redundant: a browser-to-api-pod network blip that never touched the bridge's own LISTEN connection reconnects the client's stream with no server-side resync frame at all, so the client needs its own signal too.
- **Restated, explicitly, because it is easy to misread the above as replay:** this remains best-effort with **no replay**. Nothing durably tracks which frames a given client actually saw; the resync frame carries no data and names nothing that changed. Cache invalidation — a full, unscoped re-fetch of whatever queries the UI cares about — is the *only* catch-up mechanism, exactly as D4 always said it would be. What changed in M26.1 is that a reconnection is now reliably *detected and signalled at all*, on both sides of the process boundary; it did not add a smaller-grained way to catch up.
- **The NOTIFY payload is a pointer, never the event (review finding F1).** The relay's NOTIFY carries only `{id, orgId}` — `orgId` strictly as a non-authoritative observability hint — and the bridge *always* re-derives the event from the authoritative `outbox` row by id, under the same narrowly-scoped `SET LOCAL ROLE scp_relay` escalation the relay itself uses (`scp_relay` is `NOBYPASSRLS`, granted only `SELECT`/`UPDATE` on `outbox` — extending that reviewed escalation to every SSE-serving process widens no blast radius). This replaces the initial M26.1 design, where an envelope ≤7000 bytes rode in the payload and only oversized rows were fetched: Postgres `NOTIFY` is not channel-access-controlled, so *any* DB login (including `scp_pgboss`, which has zero `outbox` grants by design) could inject a schema-valid frame with an `orgId` of its choosing into any tenant's live SSE stream. With one fetch path for every event, a frame no outbox row backs delivers nothing; the standing gate is `events/sse-bridge-notify-authenticity.integration.test.ts`. A side benefit: payload size is now independent of event size, so the ~8000-byte NOTIFY cap needs no split handling.

## Alternatives rejected

- **Declare the operation but leave the UI on `EventSource`.** Half the fix: the sweep exemption could go, but the UI would still bypass the SDK and still cast unvalidated bytes — principle 3 and ADR-0023's hole both survive. The owner explicitly chose the full fix.
- **Hand-roll a `fetch` wrapper in `apps/web` and call it SDK-consumed.** Rejected on principle and unnecessary in fact: the generator produces a usable SSE surface, so `client.events.stream()` is a real generated operation with a real validator, not a wrapper wearing the SDK's name.
- **Rely on the generated client's own retry.** Rejected — it covers only the error case (D3). Leaving it on *in addition* to the outer loop was also rejected: two nested backoff policies with different state would be untestable as one behaviour.
- **Model the stream as an array response or a long-poll.** Rejected — it would misdescribe the transport in the contract, and consumers reading the spec would build the wrong client.
