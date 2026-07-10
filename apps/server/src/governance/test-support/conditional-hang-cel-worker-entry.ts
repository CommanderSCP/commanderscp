/**
 * Test-only worker entry that HANGS on the sentinel expression `"__HANG__"` but evaluates every
 * other expression normally via `cel-js`. Unlike `hanging-cel-worker-entry.ts` (which hangs on
 * ANY message, so a respawned worker hangs again), this lets `cel-sandbox.test.ts` prove that the
 * SAME sandbox instance recovers after a timeout: the first call hangs and is terminated, and a
 * subsequent NON-sentinel call against the respawned worker succeeds (MINOR (b) — the pre-fix
 * timeout test only ever proved recovery via a brand-new sandbox, never that a wedged pool healed).
 */
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
    parentPort!.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

parentPort.postMessage({ ready: true });
