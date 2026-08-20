/**
 * JSON parsing that REFUSES prototype-poisoned input — the admission control on the two doors
 * through which foreign bytes become JavaScript objects in this process: the HTTP body parser
 * (`app.ts`) and the `.scpbundle` reader (`federation/inbox-loop.ts`).
 *
 * ## Why this module exists rather than a dependency
 *
 * Fastify's DEFAULT `application/json` parser is `secure-json-parse` with
 * `onProtoPoisoning: "error"` and `onConstructorPoisoning: "error"` (both defaults; see
 * `fastify/lib/config-validator.js`'s `defaultInitOptions`). `app.ts` replaces that parser
 * wholesale in order to capture `rawBody` for webhook signature verification, and the replacement
 * was a plain `JSON.parse` — so the protection was gone from EVERY route, while the replacement's
 * comment claimed it "behaves identically to Fastify's own default JSON parser for every OTHER
 * route". Measured on the base commit: `POST /services` with
 * `properties: {"ok":1,"__proto__":{…}}` returned 201 Created.
 *
 * The obvious repair is to import `secure-json-parse` directly. It cannot be done here.
 * `secure-json-parse@4.1.0` is present in the local pnpm STORE (Fastify depends on it) and pinned
 * in `pnpm-lock.yaml`, but `pnpm add secure-json-parse --offline` fails with
 * `ERR_PNPM_NO_OFFLINE_META`: resolving a new DIRECT dependency edge needs the registry METADATA
 * document, which the offline mirror does not carry. Adding it would therefore require a network
 * fetch at install time, which charter principle 5 (air-gap and self-hosting are first-class,
 * "everything — CI included — must run offline") forbids. So the check is implemented here, with
 * no new dependency.
 *
 * ## Equivalence to `secure-json-parse`
 *
 * {@link assertNoPrototypePoisoning} implements the same two rules as that library's `scan()` at
 * `protoAction: "error"` / `constructorAction: "error"`, and applies them to the PARSED value
 * rather than to the source text. The library uses a regex over the raw text only as a fast path
 * to skip the walk; correctness in both comes from the walk. Checking post-parse is if anything
 * stricter, because `JSON.parse` has already resolved escape sequences — `"__proto_
 * _"` is an ordinary `__proto__` key by the time it is examined, with no escape spelling left
 * to enumerate.
 *
 * ## Why refuse rather than strip
 *
 * `"remove"` (delete the key and carry on) accepts a request while silently discarding part of it,
 * which is what the base commit already did by accident — 201 Created for a body that was only
 * partly stored. A caller cannot tell the difference between "stored" and "silently dropped", so
 * the only honest answers are "take all of it" or "take none of it".
 *
 * Refusal at the boundary is DEFENCE IN DEPTH, not the integrity fix. The integrity fix is that
 * `@scp/schemas/canonical-json` is now total, because content also reaches canonicalization from
 * federation peers and from disk, not only through these two doors.
 */

/** Thrown by {@link assertNoPrototypePoisoning}. A `SyntaxError` subclass so that call sites which
 *  already treat a parse failure as "this input is not acceptable" need no new catch arm — but a
 *  distinct class, so a call site that wants to tell "malformed" from "hostile" apart can. */
export class PrototypePoisoningError extends SyntaxError {
  override readonly name = "PrototypePoisoningError";
  /** `"__proto__"` or `"constructor"` — which rule fired. */
  readonly forbiddenKey: "__proto__" | "constructor";

  constructor(forbiddenKey: "__proto__" | "constructor") {
    super(`Object contains forbidden prototype property: ${forbiddenKey}`);
    this.forbiddenKey = forbiddenKey;
  }
}

/**
 * Throws {@link PrototypePoisoningError} if `value` — typically fresh `JSON.parse` output —
 * contains a forbidden own key anywhere in its object graph.
 *
 * Iterative (breadth-first) rather than recursive on purpose: the `.scpbundle` door accepts bodies
 * up to 64 MiB, and a deeply nested document must be REJECTED by this guard, never turned into a
 * `RangeError: Maximum call stack size exceeded` from the guard itself.
 */
export function assertNoPrototypePoisoning(value: unknown): void {
  // JSON.parse output is a tree — no cycles — so no visited-set is needed.
  const queue: unknown[] = [value];
  while (queue.length > 0) {
    const node = queue.pop();
    if (node === null || typeof node !== "object") continue;

    // `Object.prototype.hasOwnProperty.call`, never `node.hasOwnProperty(...)`: the whole point is
    // that `node`'s own members are attacker-chosen, `hasOwnProperty` included.
    if (Object.prototype.hasOwnProperty.call(node, "__proto__")) {
      throw new PrototypePoisoningError("__proto__");
    }

    // Same rule `secure-json-parse` applies for `constructorAction: "error"`: a bare
    // `{"constructor": "text"}` is harmless and must stay accepted (it is an ordinary own data
    // property — `Object.prototype.constructor` is a data property, not an accessor, so nothing is
    // dropped and nothing is redefined). Only a `constructor` carrying its own `prototype` is the
    // gadget shape.
    if (Object.prototype.hasOwnProperty.call(node, "constructor")) {
      const ctor = (node as { constructor?: unknown }).constructor;
      if (ctor !== null && typeof ctor === "object") {
        if (Object.prototype.hasOwnProperty.call(ctor, "prototype")) {
          throw new PrototypePoisoningError("constructor");
        }
      }
    }

    for (const key of Object.keys(node)) {
      const child = (node as Record<string, unknown>)[key];
      if (child !== null && typeof child === "object") queue.push(child);
    }
  }
}

/**
 * `JSON.parse`, then {@link assertNoPrototypePoisoning}.
 *
 * Throws a plain `SyntaxError` for malformed JSON and a {@link PrototypePoisoningError} for
 * poisoned JSON — the caller decides how each becomes a response or a refusal record.
 */
export function parseJsonRejectingPrototypePoisoning(text: string): unknown {
  const parsed: unknown = JSON.parse(text);
  assertNoPrototypePoisoning(parsed);
  return parsed;
}
