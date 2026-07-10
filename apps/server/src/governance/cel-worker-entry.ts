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
 *    attempt like `"a".constructor.constructor('return process')()` is just an invalid/nonsensical
 *    CEL parse (dots may only navigate CEL identifiers/fields, not JS prototype chains) and fails
 *    or evaluates to an identifier-not-found error, never real JS execution.
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
