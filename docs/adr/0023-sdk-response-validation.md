# ADR-0023: Validate API responses at the SDK boundary

**Status:** Accepted (owner-decided 2026-07-30)
**Relates to:** [PROJECT_CHARTER.md](../../PROJECT_CHARTER.md) principle 3 (API-first parity — the UI and CLI consume only the generated SDK) and principle 5 (air-gap and self-hosting are first-class); [DESIGN.md §15](../DESIGN.md) (`@scp/sdk` — generated core plus a thin handwritten layer); PR #155 (the four review rounds this ADR is the answer to)

## Context

`@hey-api/openapi-ts` emits **types, not runtime checks**. A field the OpenAPI contract declares required-not-optional is therefore *typed* as always present and *is not* always present: under version skew — a newer client against an older instance, or an older client against a newer one — the instance can simply not send it. TypeScript is satisfied; the first bare dereference downstream throws `TypeError: Cannot read properties of undefined`, in whichever component happened to touch the field first, with nothing in the stack naming the response, the operation, or the field. `apps/web/src/routes/outpost-settings.tsx` states the rule verbatim in a comment; the rule was known, written down, and still not held.

**Four consecutive review rounds on PR #155 each found a fresh instance of exactly this defect:**

| Round | Site | Field |
|---|---|---|
| 3 | `apps/web/src/routes/outposts.tsx:493` | `peer.syncScope` |
| 4 | `apps/web/src/routes/outpost-detail.tsx:130` | `peer.syncScope` |
| 4 | `packages/cli/src/cli.ts:343` | `peer.syncScope` |
| 5 | `apps/web/src/routes/federation-status.tsx:171` | `peer.syncScope` — a **third** recurrence of the same field, white-screening the entire `/federation` page (measured `innerHTML` length 0) |
| 5 | `packages/cli/src/cli.ts:237` | `syncScope.mode` |
| 5 | `packages/cli/src/cli.ts:358` | `unknownFields` |
| 5 | `packages/cli/src/cli.ts:419+` | the report of a destructive verb dying mid-print |

The shape of the failure is as informative as the count: each round the web site was fixed and the CLI twin one file over survived, or the reverse. **Seven censuses stopped short.** The census is not the problem; the *bound* is. Nothing structural stopped the eighth instance, so there would have been an eighth instance.

## Decision

**Validate every `/v1` response at the SDK boundary, so a malformed response fails once — loudly, and naming the operation and the field — instead of surfacing as a `TypeError` somewhere downstream.**

### 1. The check is generated, per operation, into the one path every call already takes

`packages/sdk/openapi-ts.config.ts` enables two things the generator already ships:

```ts
{ name: "zod", requests: false, definitions: false, metadata: false },
{ name: "@hey-api/sdk", validator: { response: "zod" } }
```

The `zod` plugin emits a runtime schema per operation *response* (`src/generated/zod.gen.ts`); the `@hey-api/sdk` plugin attaches it to that operation as `responseValidator`, which the generated client awaits on the 2xx JSON path, after `JSON.parse` and before any response transformer. All **204 operations** are covered, by construction — there is no per-operation opt-in and therefore no operation that can be forgotten. `types.gen.ts` is byte-identical to before, so the `/v1` contract is unchanged (oasdiff job 3b is unaffected).

#### The bound, stated exactly: 204/204 **spec'd** operations — not 100% of what the SPA parses

This decision is worth only what its bound is worth, so the bound is stated as a limit rather than as a headline. "204/204" counts the operations in `tools/openapi/openapi.v1.json`. It is **not** a claim that every byte this product parses off the network is validated, and one live surface is outside it:

- **`GET /events/stream` was not in the spec at all.** The SSE feed was not a generated operation, had no generated schema, and never passed through `responseValidator`. `apps/web/src/lib/use-event-stream.ts` did `JSON.parse(event.data) as RelayedEvent` and then dereferenced `payload.subject` with no runtime check — a bare cast of network bytes, exactly the class this ADR abolishes everywhere else. This ADR did not close it, and closing it was tracked separately.

  **CLOSED (SSE API parity, ADR-0025).** The route now declares a `text/event-stream` 200 whose frame schema is `RelayedEventSchema`, so the generator emits a `streamEvents` operation carrying a `responseValidator` that the generated SSE client awaits **per frame**; `apps/web` consumes it through `client.events.stream()`. The bound above therefore now reads as stated with no exception: every byte the SPA parses off the network goes through a generated operation.

The distinction matters because the next census will read this section: any surface that does not go through a generated operation is untouched by this decision, however complete the operation count is.

`requests`, `definitions` and `metadata` are off: only responses are validated, and emitting request and component schemas would double the generated bytes for no benefit here.

### 2. Validation is check-only, never rewriting

The generated client **discards** the validator's return value. Zod therefore cannot strip, coerce, or reorder the payload: callers receive the server's bytes as parsed. This matters in the forward direction of version skew — a *newer* instance sending a field this SDK has never heard of validates fine and the field reaches the caller intact.

### 3. The failure names the operation and the field

The generated client swallows a `responseValidator` rejection into its ordinary error channel: with `throwOnError` unset it returns `{ error: ZodError, data: undefined, response }` with `response.status === 200`. Left alone, that is *worse* than nothing — `unwrap()` would flatten it into a generic `ScpApiError("CommanderSCP API error")` carrying neither the operation nor the field, i.e. the same mystery this ADR exists to abolish.

So `packages/sdk/src/response-validation.ts` registers **one error interceptor** on the client that `ScpClient` builds. The interceptor runs inside the generated client's own catch, where the resolved request options still carry the operation's method and templated URL, and rewrites the `ZodError` into `ScpResponseValidationError`:

```
CommanderSCP API response failed contract validation for GET /federation/status (HTTP 200):
peers.0.peer.syncScope (invalid_type: Invalid input: expected object, received undefined).
The instance returned a body that does not match the OpenAPI contract this SDK was generated
from — most likely a version skew between this client and the instance.
```

- **Operation** = `${method} ${templated path}` — the OpenAPI coordinates of the call. The generated `responseValidator` closure does not carry the `operationId`, and the interceptor is the only layer that still knows which request produced the error.
- **Field** = the zod issue path joined with `.`, indices included (`peers.0.peer.syncScope`), plus the issue code. Every failing field is retained on `error.issues`; the message enumerates the first five.

**Unions have to be flattened, or the promise is void exactly where it matters most.** The generator emits `z.union([...])` for any operation declaring two 2xx codes — all **11 upsert-by-urn operations** (200 updated / 201 created: `/objects/{type}/{urn}`, `/domains/{urn}`, `/services/{urn}`, `/deployment-targets/{urn}`, `/teams/{urn}`, `/groups/{urn}`, `/users/{urn}`, `/service-accounts/{urn}`, `/components/{urn}`, `/policies/{urn}`, `/controls/{urn}`), i.e. the write path `packages/iac` drives — plus `POST /federation/bundles/import`. zod 4 collapses a failed union into a **single** top-level issue `{ code: 'invalid_union', path: [], message: 'Invalid input' }` and hides the per-branch issues in a nested `errors: ZodIssue[][]`, one array per branch. Reading only `error.issues` therefore diagnosed a `PUT /objects/{type}/{urn}` 200 missing the required `urn` as `<root> (invalid_union: Invalid input)` — naming no field at all. `expandIssue` flattens the branch issues, prefixing each with the union issue's own path, and dedupes: every branch of an upsert union independently reports the same missing field, and un-deduplicated the repeats would fill the five-issue message budget.

#### The generated client's one bypass, and where the fix has to live

`client.gen.ts` short-circuits **any** successful response with `status === 204` **or** `Content-Length: 0` to `{}` and returns — before the `responseValidator` call further down the same branch. A 200 whose body a proxy stripped was therefore never validated, and `unwrap()` handed the caller `{}`, every field of which reads as `undefined` while typed present. Measured end to end: serving `GET /federation/status` as HTTP 200 + `Content-Length: 0` made `scp federation status` exit **0** and print "Self: not initialized — run `scp federation init` / No paired peers." — a confident falsehood about federation state. The shipped Fastify server cannot produce that response; a proxy, ingress or CDN in front of an instance can, and that is this product's deployment shape.

`client.gen.ts` is a **generated** file, so the fix cannot live there. `installEmptyBodyValidation` registers a **response** interceptor — the earliest point inside the same `try` that survives regeneration — which, on an empty 2xx, asks the operation's own validator whether an absent body satisfies its contract. The four operations that genuinely answer 204 No Content (`zLogoutResponse`, `zAddInitiativeCampaignResponse`, `zDeleteSecretResponse`, `zDeleteNotificationBindingResponse`) are `z.void()` and pass; everything else fails with `code: "empty_body"`. There is deliberately no hardcoded allowlist to drift as operations are added, and deliberately no mirror of the generated `parseAs` gate: a 204 carrying no `Content-Type` resolves to `parseAs: 'stream'` there and hands the caller `null`, and every 2xx in `openapi.v1.json` that declares content declares `application/json` and nothing else.

`unwrap()`/`unwrapVoid()` rethrow `ScpResponseValidationError` untouched. Every other error — RFC 9457 problem bodies, network failures — passes through the interceptor unchanged and stays `ScpApiError`.

### 4. Consumers need no changes

Nothing in `apps/web/src` or `packages/cli/src` deep-imports `generated/`; both go through `ScpClient` (`apps/web/src/lib/client.ts`, `packages/cli/src/client-factory.ts`). Blast radius on call sites is zero, and both consumers already handle a thrown error better than they handle a `TypeError`:

- the CLI's top-level handler (`packages/cli/src/bin.ts`) prints one formatted line and exits 1;
- the web's react-query (`retry: false`) turns it into a **query error state**, not a render-time crash — strictly better than today's `TypeError`, which unmounts the tree.

### 5. What it caught immediately

On its **first CI run** the boundary rejected a live contract violation that had been shipping since M1 — and that no call-site census could have found, because the field was not merely absent under skew, it was never sent at all.

Fastify prefers a literal static route over a parametric one, so `POST/GET /api/v1/objects/service` (the M0 route) is the only handler that ever runs for that exact path. The SDK has no idea: `client.object(type)` calls the **generic** `createObject`/`listObjects` operations for every type, `service` included, and those declare a full `GraphObject` response. The M0 handler returned a five-field subset. Net effect:

```ts
const svc = await client.object("service").create({ name: "billing" });
svc.urn        // typed `string`; `undefined` at runtime, always
svc.typeId     // ditto — and .domainId, .properties, .labels, .version, .revision, …
```

`objects-service.ts`'s own module doc already stated the rule this broke — the static route "must carry full parity …, not a stripped subset". It carried parity on the *request* side only, and nothing checked the other half.

Fixed by widening `ServiceObjectSchema` to `GraphObjectSchema.extend({ type: "service" })` — additive within `/v1` (properties added, none removed or renamed, M0's `type` kept; confirmed with the vendored oasdiff) and free at runtime, since the row underneath was always a plain `service`-typed graph object.

A mechanical census over the emitted spec — for every parametric path, every literal path that shadows it on a shared method — reports **exactly one** such pair in the whole API. `apps/server/src/routes/objects-service-shadowing.integration.test.ts` pins that set, so a future shadowing route fails there with the pair named rather than quietly inheriting a contract nobody checked.

## Rejected alternatives

**Ship the census as the bound.** This is what the previous seven attempts did. A census is a snapshot: it fixes the instances present on the day it is run and leaves nothing behind that stops the next one. Four review rounds is the measurement of its half-life. Rejected on evidence, not taste.

**A custom ESLint rule banning bare dereference of schema-required fields.** Hard to express (it needs the response type's provenance, not just its TypeScript shape), certain to produce false positives on the legitimately-optional/nullable fields the contract *does* declare, and — decisively — it does nothing about an **already-malformed response**. A lint rule can force a guard to be written; it cannot make a missing field's absence diagnosable, and the guarded code still renders something wrong rather than reporting something broken.

**A handwritten validating wrapper around the SDK.** It would have to re-enumerate 204 operation→schema pairs by hand: the same census that has failed seven times, now with a maintenance burden and a drift risk. Rejected for the same reason as the census.

**Throwing from inside the generated client (`throwOnError: true`).** Would rethrow the bare `ZodError` — no operation, and a changed error contract for every existing `ScpApiError` call site. Rejected: the diagnosis has to be added, not just the throw.

**Validating requests too.** Out of scope. The server validates its own inputs (Fastify + Zod); the defect being fixed is one-directional.

## Air-gap and offline

No new dependency is fetched, at build time or at run time (charter principle 5):

- the `zod` plugin **ships inside `@hey-api/openapi-ts`**, already a devDependency;
- `zod@4` is already in the lockfile via `@scp/schemas` and already in the shipped web bundle;
- generation reads the **committed local spec** `tools/openapi/openapi.v1.json`, never the network;
- the generated `zod.gen.ts` is a committed codegen artifact, so the existing codegen-drift gate covers it automatically.

Runtime cost, measured: schemas construct once at module load; a passing parse of a 500-item list response is sub-millisecond. Bundle cost is roughly **+9 KB gzip** on a 320 KB gzip web bundle (+2.9%) — the emitted schemas are highly repetitive and compress hard.

## Consequences

- A version-skew response fails **once**, at the boundary, with the operation and the field in the message — instead of N times, downstream, as anonymous `TypeError`s.
- `?? []`-style guards for fields the contract legitimately declares `.nullable()`/`.optional()` remain load-bearing and are **unaffected**: those values validate successfully and are passed through. Response validation constrains what the contract *promises*; it does not remove the need to handle what the contract explicitly permits to be absent.
- A **spec that is wrong about the server** now fails visibly rather than silently. That is the intended direction — a contract nobody can rely on is worth less than one that fails loudly — but it means a spec/implementation divergence becomes a client-visible error, which is a good reason to keep the emitted spec honest.
- The spec inlines every shape (`tools/openapi/openapi.v1.json` has 0 `$ref`s and 0 `components.schemas`), so each response schema is duplicated per operation. Emitting components via `fastify-type-provider-zod`'s registry support would shrink both the spec and `zod.gen.ts` substantially. **Out of scope here; worth a follow-up issue.**

## Verification

`packages/sdk/src/response-validation.test.ts` drives the **real generated client** against a loopback-only HTTP server, over `GET /federation/status` — the very operation all four review rounds kept re-finding:

1. a response missing a required field rejects with `ScpResponseValidationError` naming `GET /federation/status` and `peers.0.peer.syncScope`, in both the typed fields and `error.message`;
2. a missing required **array** field (`recentTransfers`, the round-4 site) is named the same way;
3. the failure is **not swallowed** — the call does not resolve (not even to `undefined`), and exactly one request is made;
4. it is not disguised as a generic `ScpApiError`;
5. a well-formed response is returned **untouched**, including a field the SDK does not know about;
6. an RFC 9457 problem response is still an `ScpApiError`;
7. a **union**-schema operation (`PUT /objects/{type}/{urn}`, 200 | 201) missing the required `urn` names `urn`, not `<root>`, and lists each field once rather than once per branch;
8. an empty 2xx (`Content-Length: 0`, and a bare 204) on an operation whose contract declares a body **rejects**, while `POST /auth/logout` — `z.void()` — still succeeds under both.

Mutation-proven — each mutation was actually applied and the run watched:

| Mutation | Result |
|---|---|
| strip all 204 `responseValidator:` lines from `sdk.gen.ts` (i.e. as if `validator: { response: "zod" }` were never set) | tests 1–4 red, 5–6 green |
| skip `installResponseValidationErrors(this.client)` in `ScpClient` | tests 1–4 red, 5–6 green |
| delete the `ScpResponseValidationError` rethrow branch from `unwrap()`/`unwrapVoid()` | tests 1–4 red, 5–6 green |
| stop flattening `issue.errors` in `toIssues` | both union tests red |
| stop deduplicating flattened issues | the once-per-branch test red |
| skip `installEmptyBodyValidation(client)` | both empty-body rejection tests red |
| probe the validator with `{}` instead of `undefined` | both `z.void()` tests red |

Tests 5–6 staying green under every mutation is itself the point: they assert the paths validation must *not* change.

**What the SPA does with the rejection is a separate guarantee, separately pinned.** Validation makes the failure loud and single; it does not make it *visible*. react-query turns a rejected `queryFn` into `isError`, a state — so a page that branches only on `isLoading` and `data` renders an empty card for exactly the fault the boundary exists to report, and the diagnosis dies in the query cache. `apps/web/src/routes/federation-status-crash.test.tsx` and `outposts-crash.test.tsx` both drive a **real `ScpClient`** over a stubbed `fetch` (mocking the client would stub out the half that decides whether the other half is reachable) and pin that `/federation` and `/outposts` render the operation and the offending field rather than an empty table or, worse, "No outpost or retrans peers are paired yet" — a fabricated statement of federation state produced by a failure the SDK had already diagnosed in full.

`apps/server/src/routes/objects-service-shadowing.integration.test.ts` covers the shadowing violation of §5 end to end against real Postgres, through the real SDK. It is mutation-proven the same way: restoring `toServiceObject`'s five-field return turns 3 of its 4 cases red, the SDK-driven ones with `ScpResponseValidationError`.
