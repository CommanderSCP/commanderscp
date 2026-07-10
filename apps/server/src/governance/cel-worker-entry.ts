/**
 * The `node:worker_threads` entry point `cel-sandbox.ts` spawns (BUILD_AND_TEST.md §8 M4
 * "known-tricky": "the CEL sandbox MUST NOT allow I/O, network, filesystem, process, or unbounded
 * compute"). Deliberately the SMALLEST possible surface: import `cel-js`, receive
 * `{id, expression, context}` messages, call `evaluate()`, post back the result. Nothing else.
 *
 * Why this is a sandbox, concretely:
 *  - `cel-js`'s `evaluate()` parses CEL (a restricted, non-Turing-complete expression grammar —
 *    no loops, no user-defined functions, no assignment) via Chevrotain and interprets the parsed
 *    AST directly; it never calls `eval`/`new Function`/`vm` on the input string, so a CEL
 *    expression cannot become executable JavaScript no matter what text it contains — an injection
 *    attempt like `"a".constructor.constructor('return process')()` cannot spawn a Turing-complete
 *    JS execution: CEL has no way to CALL a function it might resolve with attacker-controlled code.
 *    (Note: cel-js implements member access as JS property access, so a `.constructor` traversal
 *    MAY resolve to a live JS value rather than cleanly parse-erroring — the earlier claim that
 *    "dots can't navigate JS prototype chains" was wrong. The guarantee does NOT rest on that.
 *    Two things make it safe anyway: no host function is registered to invoke, AND every result
 *    crosses back to the parent via `postMessage`'s structured clone, which STRIPS functions and
 *    other non-cloneable/live values — nothing callable can ever return to the host. The unit
 *    suite asserts exactly this: an escape attempt yields either a failed eval or an inert,
 *    JSON-serializable value, never something callable.)
 *  - The THIRD argument to `evaluate()` (a "custom functions" map) is never passed here — this
 *    process registers zero host bindings, so even a syntactically valid CEL function call
 *    (`foo()`) has nothing to invoke. No `context` value this worker is ever given exposes `http`,
 *    `fs`, `secrets`, or any other capability — callers (`governance/evaluate.ts`) only ever pass
 *    plain JSON-shaped policy-evaluation-context data (DESIGN.md §10.1).
 *  - This worker's OWN Node runtime obviously still has `require`/`fs`/`process` available to
 *    real JavaScript — but a CEL expression string can never reach real JavaScript execution in
 *    the first place (previous bullet), so that capability is unreachable from untrusted input.
 *    Running in a separate thread is defense in depth against the *bugs in cel-js itself* (a
 *    parser crash, a pathological input hanging the interpreter, a stack overflow from
 *    adversarial nesting) rather than the sole sandboxing mechanism — `cel-sandbox.ts`'s
 *    hard wall-clock timeout + `terminate()` is what actually bounds compute, since Node cannot
 *    preempt a synchronous loop any other way.
 */
import { parentPort } from "node:worker_threads";
import { evaluate } from "cel-js";

if (!parentPort) {
  throw new Error("cel-worker-entry must run inside a worker_thread");
}

interface EvalRequest {
  id: number;
  expression: string;
  context: Record<string, unknown>;
}

parentPort.on("message", (msg: EvalRequest) => {
  const { id, expression, context } = msg;
  try {
    const value = evaluate(expression, context);
    parentPort!.postMessage({ id, ok: true, value });
  } catch (err) {
    parentPort!.postMessage({
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    });
  }
});

// Signals to `cel-sandbox.ts` that this worker's module graph (tsx transform + `cel-js` +
// `chevrotain`) has finished loading — sent once, after the message handler above is already
// registered so no request racing this signal can be dropped (`node:worker_threads`'
// `MessagePort` buffers messages sent before a listener is attached, but there is no such gap
// here regardless). Cold module load (tsx-transforming this file, importing chevrotain's parser
// generator) is the dominant cost on a freshly spawned worker — often tens to a couple hundred
// ms — and MUST NOT count against a single evaluation's compute-bounding timeout budget
// (cel-sandbox.ts only starts a call's timeout clock once it has actually dispatched to a
// worker that announced `ready`).
parentPort.postMessage({ ready: true });
