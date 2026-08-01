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

## Alternatives rejected

- **Declare the operation but leave the UI on `EventSource`.** Half the fix: the sweep exemption could go, but the UI would still bypass the SDK and still cast unvalidated bytes — principle 3 and ADR-0023's hole both survive. The owner explicitly chose the full fix.
- **Hand-roll a `fetch` wrapper in `apps/web` and call it SDK-consumed.** Rejected on principle and unnecessary in fact: the generator produces a usable SSE surface, so `client.events.stream()` is a real generated operation with a real validator, not a wrapper wearing the SDK's name.
- **Rely on the generated client's own retry.** Rejected — it covers only the error case (D3). Leaving it on *in addition* to the outer loop was also rejected: two nested backoff policies with different state would be untestable as one behaviour.
- **Model the stream as an array response or a long-poll.** Rejected — it would misdescribe the transport in the contract, and consumers reading the spec would build the wrong client.
