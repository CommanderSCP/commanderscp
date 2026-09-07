/** A worker that hangs on a sentinel and evaluates the rest. See docs/governance.md §430. */
import { parentPort } from "node:worker_threads";
import { evaluate } from "cel-js";

if (!parentPort) {
  throw new Error("conditional-hang-cel-worker-entry must run inside a worker_thread");
}

interface EvalRequest {
  id: number;
  expression: string;
  context: Record<string, unknown>;
}

parentPort.on("message", (msg: EvalRequest) => {
  const { id, expression, context } = msg;
  if (expression === "__HANG__") {
    // Deliberately never reply — forces the caller's hard-timeout/terminate path.
    return;
  }
  try {
    parentPort!.postMessage({ id, ok: true, value: evaluate(expression, context) });
  } catch (err) {
    parentPort!.postMessage({
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    });
  }
});

parentPort.postMessage({ ready: true });
