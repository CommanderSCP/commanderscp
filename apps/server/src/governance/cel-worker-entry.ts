/** The worker-thread entry point the sandbox spawns. See docs/governance.md §38. */
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

// Signals to `cel-sandbox.ts` that this worker's module graph. See docs/governance.md §39.
parentPort.postMessage({ ready: true });
