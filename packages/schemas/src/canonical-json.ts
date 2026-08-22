/**
 * THE canonical JSON serializer for this repo — one implementation, deliberately.
 *
 * Before this module existed there were FIVE byte-for-byte copies of the same `sortKeysDeep`
 * helper (`@scp/schemas`'s `federation-journal.ts`, `apps/server`'s `util/canonical-json.ts` and
 * `coordination/decisions-repo.ts` and `coordination/test-support/counting-cel-sandbox.ts`, and
 * `@scp/iac`'s `canonical.ts`), each carrying a comment explaining that it was "vendored" or
 * "duplicated" to avoid a module-boundary violation. They all shared one bug (below), and fixing
 * it in four of five places would have been the classic outcome this repo's census rule exists to
 * prevent. `@scp/schemas` is the lowest common dependency of every one of those call sites, and
 * this module is pure — no `node:crypto`, no I/O — so it is safe in the browser build too.
 *
 * ## Why the key-sort exists at all
 *
 * A canonical form must be independent of key INSERTION order, because the same content reaches
 * these functions through paths that do not agree on it: a `jsonb` column does not preserve the
 * author's key order, so a hash computed at write time over an in-memory object literal would not
 * match the same hash recomputed at verify time over the row read back. Sorting recursively makes
 * the serialization a function of content alone.
 *
 * ## The bug this module fixes: canonicalization was not TOTAL
 *
 * The old shape was `Object.keys(src).sort().reduce((acc, key) => { acc[key] = ...; return acc },
 * {})`. `JSON.parse` makes `__proto__` an **own, enumerable data property**, so `Object.keys`
 * yields it — but `acc[key] = value` on a `{}` accumulator goes through the `__proto__` **setter
 * inherited from `Object.prototype`**, which does not store anything. Two consequences, both
 * measured on `origin/main` before this change:
 *
 *   1. The subtree VANISHES from the canonical string. `{"ok":1}` and
 *      `{"ok":1,"__proto__":{...arbitrarily large...}}` canonicalized to the byte-identical
 *      `{"ok":1}` — therefore the same sha256 `rowHash` and the same Ed25519 signature. A
 *      signature that does not cover what a peer can smuggle past it is not a signature;
 *      `verifyJournalChain`, documented as "the fail-closed gate a tampered or truncated segment
 *      must never pass", passed such a segment.
 *   2. The RETURNED object had its prototype silently swapped to the attacker's object. For input
 *      `{"ok":1,"__proto__":{"isAdmin":true}}` the result reported `Object.keys() === ["ok"]`
 *      while `result.isAdmin === true`. (This does not mutate the global `Object.prototype` — the
 *      setter retargets the receiver — but it hands every downstream reader an object whose
 *      inherited members an attacker chose.)
 *
 * ## Why REPRESENT rather than THROW, and why not `Object.defineProperty`
 *
 * `Object.create(null)` accumulator. The accumulator then inherits no `__proto__` accessor, so
 * `out[key] = value` is an ordinary data-property write for every key including `__proto__`, and
 * `JSON.stringify` emits it. Canonicalization becomes total: distinct input, distinct output.
 *
 * Not `Object.defineProperty` on a normal `{}`: that produces an object carrying `__proto__` as an
 * own data property with `Object.prototype` still in its chain — a pollution gadget that would
 * travel onward through the SDK to the CLI and the web app the first time anything `Object.assign`s
 * it. A null-prototype object is not that gadget, and in any case the only value that escapes this
 * module is a STRING; {@link canonicalizeDeep} is exported solely for the one caller that must
 * embed the sorted form inside a larger literal it immediately stringifies.
 *
 * Not THROW either, at this layer. Refusal belongs at the boundary — `apps/server`'s
 * `util/safe-json.ts` rejects poisoned JSON at the two doors that admit foreign bytes (the HTTP
 * body parser and the `.scpbundle` reader), which is where a refusal can become a 400 or a
 * recorded file refusal.
 *
 * THIS PARAGRAPH USED TO OVERSTATE ITS CASE, and the overstatement is corrected here rather than
 * quietly deleted. It claimed that throwing from a fail-closed VERIFY path (`verifyJournalChain`,
 * `restatesDecision`) "would convert a `valid: false` into an unhandled exception in the
 * federation inbox loop". Measured: it would not. `verifySegment` (`apps/server`'s
 * `federation/import-repo.ts`) ALREADY throws `conflict(...)` when verification fails, and
 * `inbox-loop.ts` catches it — a 409 `ProblemError` becomes a structured `refuseFile` carrying its
 * Decision, anything else falls to the `deferFile` arm, and one level up there is a
 * containment catch for the genuinely unanticipated throw. So the real cost of throwing here is
 * narrower than claimed: a tampered segment would be DEFERRED AND RETRIED every tick under an
 * unstructured message, instead of REFUSED ONCE with a Decision an operator can read. Bad, and
 * not the availability collapse the old sentence described.
 *
 * THE DECISION STANDS ON A STRONGER ARGUMENT — the one that was actually measured. A boundary
 * check cannot cover this module's inputs, because not all of them cross a boundary.
 * `sync_journal.payload` and `decisions.input_context` are `jsonb` columns; content grafted
 * straight into one of them by SQL — a compromised or buggy writer, a restored dump, an operator
 * with a psql prompt — passes through NEITHER door by construction, and is read back and
 * canonicalized as if it had. Only a TOTAL canonicalizer covers that input, and a canonicalizer
 * that throws is not total. The integrity fix is that the canonical string covers everything;
 * boundary rejection is defence in depth on top of totality, not a substitute for it.
 *
 * ## Compatibility guarantee
 *
 * For every input containing no own `__proto__` key anywhere, the output is BYTE-IDENTICAL to the
 * five implementations this replaces — including their quirks (a `Date` has no own enumerable
 * keys, so it canonicalizes to `{}`; `undefined` at the top level yields `undefined`, not a
 * string). That is not incidental: stored `row_hash`/`content_hash` values on live estates were
 * computed with the old code and must keep verifying. `canonical-json.test.ts` pins it by running
 * the verbatim old implementation side by side over a corpus.
 */

/**
 * Recursively key-sorted structural copy. Objects come back with a **null prototype** and may
 * therefore carry an own `__proto__` key.
 *
 * Prefer {@link canonicalJson}. This is exported only for `canonicalizeJournalEntry`, which needs
 * the sorted PAYLOAD as a value inside a larger fixed-field-order literal that it stringifies in
 * one go. Never spread, `Object.assign`, or otherwise merge the result into a normal object: doing
 * so with an own `__proto__` key present is exactly the pollution step this module avoids.
 */
export function canonicalizeDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeDeep);
  if (value !== null && typeof value === "object") {
    const src = value as Record<string, unknown>;
    // `Object.create(null)`, NOT `{}` — see this module's doc comment. On a `{}` accumulator the
    // write below would hit `Object.prototype`'s `__proto__` setter for that one key and store
    // nothing, silently dropping the subtree from the canonical form.
    const out = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(src).sort()) out[key] = canonicalizeDeep(src[key]);
    return out;
  }
  return value;
}

/**
 * Deterministic JSON serialization: recursively sorted object keys, total over its input.
 *
 * Returns `undefined` (not the string `"undefined"`) for values `JSON.stringify` cannot represent
 * at the top level — `undefined`, functions, symbols — matching both `JSON.stringify` and the five
 * implementations this replaces. The `string` return type is the one the call sites have always
 * declared; it is preserved rather than widened so this stays a drop-in.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalizeDeep(value));
}
