# openapi

Long-form reference for the **openapi** subsystem — the rationale, hazards and open items that
used to sit inline. Each source file below carries a one-line headline at the site and points here.

> Partial: 4 of 4 multi-line comment blocks in this subsystem are here. The rest are
> still inline, pending a hand-written one-line headline.

## Files

- [`apps/server/src/openapi/build-document.test.ts`](#apps-server-src-openapi-build-document-test-ts) — §1–§1
- [`apps/server/src/openapi/build-document.ts`](#apps-server-src-openapi-build-document-ts) — §2–§3
- [`apps/server/src/openapi/registry.ts`](#apps-server-src-openapi-registry-ts) — §4–§4

## `apps/server/src/openapi/build-document.test.ts`

### §1. The SSE contract declaration

The SSE contract declaration (ADR-0025), guarded where it is actually load-bearing.

`text/event-stream` is not decoration: it is the exact key `@hey-api/openapi-ts` keys off (`hasOperationSse`) to emit a streaming operation instead of a request/response one. If the emitter ever fell back to `application/json` for this route the spec would still look plausible, `pnpm gen` would still succeed, and the SDK would silently regress to a one-shot GET that never yields an event — so the media type is asserted directly, in both the synthetic and the real committed document.

## `apps/server/src/openapi/build-document.ts`

### §2. Fastify `/api/v1/orgs/:org/...` -> OpenAPI `/orgs/{org}/...`

Fastify `/api/v1/orgs/:org/...` -> OpenAPI `/orgs/{org}/...`. The `/api/v1` prefix is stripped because it's declared once as `servers[0].url` below — paths are relative to that per the OpenAPI spec (and per what the generated SDK client expects: its `baseUrl` type is inferred from `servers[0].url` and is meant to be combined with a *relative* operation path).

### §3. An SSE 200 is a text/event-stream of frames, not a JSON body

An SSE operation's 200 is a `text/event-stream` of `data:` frames, not a JSON body — the frame schema comes from `openapi.eventStream` because there is no Fastify response schema to read it from (see registry.ts). `text/event-stream` is also the exact marker `@hey-api/openapi-ts` looks for to generate a streaming operation rather than a request/response one, so this one key is what makes the stream SDK-consumable.

## `apps/server/src/openapi/registry.ts`

### §4. Declares the 200 as an SSE stream rather than a JSON body

Declares the 200 response as a Server-Sent Events stream whose `data:` frames match this schema, emitted as `content: { "text/event-stream": … }` instead of `application/json`.

It lives here rather than in `schema.response[200]` because Fastify's response schema drives SERIALIZATION of a single reply body, and an SSE handler writes frames to `reply.raw` itself — there is no one body for Fastify to serialize. The contract is still a Zod schema from `@scp/schemas`, so the generator produces the same operation, type and `responseValidator` it produces for every JSON response (`hasOperationSse` in `@hey-api/openapi-ts` switches the generated call onto `client.sse.get`).
