/** JSON parsing that REFUSES prototype-poisoned input. See docs/util.md §4. */

/** Thrown by {@link assertNoPrototypePoisoning}. A `SyntaxError` subclass so that call sites which
 *  already treat a parse failure as "this input is not acceptable" need no new catch arm — but a
 *  distinct class, so a call site that wants to tell "malformed" from "hostile" apart can. */
export class PrototypePoisoningError extends SyntaxError {
  override readonly name = "PrototypePoisoningError";
  readonly forbiddenKey: "__proto__" | "constructor";

  constructor(forbiddenKey: "__proto__" | "constructor") {
    super(`Object contains forbidden prototype property: ${forbiddenKey}`);
    this.forbiddenKey = forbiddenKey;
  }
}

/** Rejects a forbidden key anywhere, iteratively for 64 MiB bodies. See docs/util.md §5. */
export function assertNoPrototypePoisoning(value: unknown): void {
  // Identity, not structure: two structurally equal siblings are different nodes and both get
  // examined. Only the SAME object reached a second time is skipped, and re-examining it could
  // not reach a verdict the first visit did not.
  const visited = new WeakSet<object>();
  const queue: unknown[] = [value];
  while (queue.length > 0) {
    const node = queue.pop();
    if (node === null || typeof node !== "object") continue;
    if (visited.has(node)) continue;
    visited.add(node);

    // `Object.prototype.hasOwnProperty.call`, never `node.hasOwnProperty(...)`: the whole point is
    // that `node`'s own members are attacker-chosen, `hasOwnProperty` included.
    if (Object.prototype.hasOwnProperty.call(node, "__proto__")) {
      throw new PrototypePoisoningError("__proto__");
    }

    // A bare `constructor` data property stays accepted. See docs/util.md §6.
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

/** `JSON.parse`, then {@link assertNoPrototypePoisoning}. See docs/util.md §7. */
export function parseJsonRejectingPrototypePoisoning(text: string): unknown {
  const parsed: unknown = JSON.parse(text);
  assertNoPrototypePoisoning(parsed);
  return parsed;
}
