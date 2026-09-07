# util

Long-form reference for the **util** subsystem — the rationale, hazards and open items that
used to sit inline. Each source file below carries a one-line headline at the site and points here.

> Partial: 7 of 7 multi-line comment blocks in this subsystem are here. The rest are
> still inline, pending a hand-written one-line headline.

## Files

- [`apps/server/src/util/canonical-json.ts`](#apps-server-src-util-canonical-json-ts) — §1–§1
- [`apps/server/src/util/safe-json.test.ts`](#apps-server-src-util-safe-json-test-ts) — §2–§3
- [`apps/server/src/util/safe-json.ts`](#apps-server-src-util-safe-json-ts) — §4–§7

## `apps/server/src/util/canonical-json.ts`

### §1. Deterministic JSON serialization

Deterministic JSON serialization (recursively sorted object keys) for content-equality checks and signed payloads (`governance/attestation.ts`'s Ed25519 attestations).

NO LONGER AN IMPLEMENTATION — a re-export of the single canonicalizer in `@scp/schemas/canonical-json`, which is where the behaviour and the reasoning now live (read that module's doc comment before changing anything here). This file survives only as a stable import path: it exists in the first place to avoid a module-import cycle (M6's `federation/journal-repo.ts` needs `governance/attestation.ts`'s `ensureInstanceKey` to sign journal rows, and `graph/objects-repo.ts` needs `journal-repo.ts`'s `appendJournalEntry` — had `attestation.ts` imported this helper FROM `objects-repo.ts`, that would close the cycle objects-repo -> journal-repo -> attestation -> objects-repo), and a dozen call sites import it from here.

The four sibling copies of this helper that used to exist elsewhere in the repo all shared one defect: canonicalization silently DROPPED any `__proto__` subtree, so two different payloads hashed and signed identically. Collapsing them to one implementation is what makes that a single fix rather than four — do not re-vendor it.

## `apps/server/src/util/safe-json.test.ts`

### §2. TOTALITY OVER GRAPHS `JSON.parse` CANNOT PRODUCE

TOTALITY OVER GRAPHS `JSON.parse` CANNOT PRODUCE.

`assertNoPrototypePoisoning` is EXPORTED, so its callers are not limited to the two doors that hand it fresh `JSON.parse` output. Before the visited set, a single cyclic argument made it spin forever — measured: still running at 20 s, hard-killed — which is the guard becoming the denial of service it exists to prevent, inside the process that serves every route.

A NON-TERMINATING WALK CANNOT BE CAUGHT BY A TEST TIMEOUT: it is synchronous, so it blocks the event loop and vitest never gets to fire one. (Measured: with the visited set deleted, this file ran past 300 s and had to be killed — it does not fail, it hangs, and a hang that wedges CI is a bad gate even though it is a loud one.) So the cases below count node VISITS through an enumerable getter and trip a budget instead. With the visited set each node is examined once; delete it and the budget throws in milliseconds and the named test fails cleanly.

### §3. Snapshot every Object.prototype key, not three named ones

A full snapshot of `Object.prototype`'s own property names, captured at module load. Asserting that three named keys are absent only proves those three are absent; this proves NOTHING was added or removed. A leaked pollution would make every later assertion in the run untrustworthy, so it is checked rather than assumed.

## `apps/server/src/util/safe-json.ts`

### §4. JSON parsing that REFUSES prototype-poisoned input

JSON parsing that REFUSES prototype-poisoned input — the admission control on the two doors through which foreign bytes become JavaScript objects in this process: the HTTP body parser (`app.ts`) and the `.scpbundle` reader (`federation/inbox-loop.ts`).

## Why this module exists rather than a dependency

Fastify's DEFAULT `application/json` parser is `secure-json-parse` with `onProtoPoisoning: "error"` and `onConstructorPoisoning: "error"` (both defaults; see `fastify/lib/config-validator.js`'s `defaultInitOptions`). `app.ts` replaces that parser wholesale in order to capture `rawBody` for webhook signature verification, and the replacement was a plain `JSON.parse` — so the protection was gone from EVERY route, while the replacement's comment claimed it "behaves identically to Fastify's own default JSON parser for every OTHER route". Measured on the base commit: `POST /services` with `properties: {"ok":1,"__proto__":{…}}` returned 201 Created.

The obvious repair is to import `secure-json-parse` directly. It cannot be done here. `secure-json-parse@4.1.0` is present in the local pnpm STORE (Fastify depends on it) and pinned in `pnpm-lock.yaml`, but `pnpm add secure-json-parse --offline` fails with `ERR_PNPM_NO_OFFLINE_META`: resolving a new DIRECT dependency edge needs the registry METADATA document, which the offline mirror does not carry. Adding it would therefore require a network fetch at install time, which charter principle 5 (air-gap and self-hosting are first-class, "everything — CI included — must run offline") forbids. So the check is implemented here, with no new dependency.

## Equivalence to `secure-json-parse`

`assertNoPrototypePoisoning` implements the same two rules as that library's `scan()` at `protoAction: "error"` / `constructorAction: "error"`, and applies them to the PARSED value rather than to the source text. The library uses a regex over the raw text only as a fast path to skip the walk; correctness in both comes from the walk. Checking post-parse is if anything stricter, because `JSON.parse` has already resolved escape sequences — `"__proto_ _"` is an ordinary `__proto__` key by the time it is examined, with no escape spelling left to enumerate.

## Why refuse rather than strip

`"remove"` (delete the key and carry on) accepts a request while silently discarding part of it, which is what the base commit already did by accident — 201 Created for a body that was only partly stored. A caller cannot tell the difference between "stored" and "silently dropped", so the only honest answers are "take all of it" or "take none of it".

Refusal at the boundary is DEFENCE IN DEPTH, not the integrity fix. The integrity fix is that `@scp/schemas/canonical-json` is now total, because content also reaches canonicalization from federation peers and from disk, not only through these two doors.

### §5. Rejects a forbidden key anywhere, iteratively for 64 MiB bodies

Throws `PrototypePoisoningError` if `value` contains a forbidden own key anywhere in its object graph. TOTAL over every input, including ones no `JSON.parse` can produce.

Iterative rather than recursive on purpose: the `.scpbundle` door accepts bodies up to 64 MiB, and a deeply nested document must be REJECTED by this guard, never turned into a `RangeError: Maximum call stack size exceeded` from the guard itself.

## Why the visited set, when both call sites pass `JSON.parse` output

They do, and `JSON.parse` output is a tree, and `secure-json-parse` — the library this reimplements — has no visited set either for exactly that reason. But this function is EXPORTED, and an export's precondition is only as strong as the next caller's memory of it. Without a visited set, one cyclic argument makes it spin forever: `const a = {}; a.self = a; assertNoPrototypePoisoning(a)` was still running at 20 s and had to be hard-killed, and with the two lines below deleted this package's own test file ran past 300 s. That is a guard turning into the denial of service it exists to prevent, in the process that serves every route.

A visited `WeakSet` is chosen over three alternatives:

- A NODE BUDGET would need a number, and any number is either small enough to refuse a legitimate multi-thousand-entry bundle (the reason `bodyLimit` is 64 MiB) or large enough that a cyclic graph still burns seconds of CPU before hitting it. It also converts a programming mistake into an input rejection, which is the wrong verdict for the wrong party. - MAKING THE PRECONDITION UNMISSABLE AT THE SIGNATURE (a branded `AcyclicJson` parameter) puts the burden on every call site to prove something the callee can establish for itself in one `WeakSet`, and cannot be enforced at all against JavaScript callers coming through the plugin host. - ALLOCATING THE SET LAZILY, only once a walk has passed some node count, measures as free (100k walks over a 4253-node document: 13.76 s untracked, 13.82 s lazy, 23.92 s `WeakSet`, 23.60 s `Set`). It was still rejected: it reintroduces the arbitrary number, and the cost it saves is not one anything here can feel. Same benchmark in absolute terms — a 74-byte API body costs 0.9 us to `JSON.parse` and 0.6 us to walk, and the tracking is ~43 % of that walk; extrapolated to a full 64 MiB bundle the tracking adds roughly 0.2 s to an import that already parses, signature-verifies and writes the whole thing. Simplicity is decision priority 1 in the charter; the number is recorded here so a future reader with a real hot-path problem knows exactly what to reach for.

It changes NOTHING for tree input: a tree visits each node identity exactly once, so nothing is ever skipped that would otherwise have been examined. For the shared-subtree DAGs a non-JSON caller can build it is a strict improvement — those were re-walked once per inbound edge before, exponentially so for a diamond chain.

### §6. A bare `constructor` data property stays accepted

Same rule `secure-json-parse` applies for `constructorAction: "error"`: a bare `{"constructor": "text"}` is harmless and must stay accepted (it is an ordinary own data property — `Object.prototype.constructor` is a data property, not an accessor, so nothing is dropped and nothing is redefined). Only a `constructor` carrying its own `prototype` is the gadget shape.

### §7. `JSON.parse`, then {@link assertNoPrototypePoisoning}

`JSON.parse`, then `assertNoPrototypePoisoning`.

Throws a plain `SyntaxError` for malformed JSON and a `PrototypePoisoningError` for poisoned JSON — the caller decides how each becomes a response or a refusal record.
