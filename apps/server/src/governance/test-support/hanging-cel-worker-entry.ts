/**
 * Test-only worker entry that receives messages but never responds — lets
 * `cel-sandbox.test.ts` exercise `CelSandbox`'s hard-timeout/terminate path deterministically,
 * without depending on being able to construct a genuinely slow real CEL expression (cel-js has
 * no loop/sleep construct to hang itself with, by design — see cel-sandbox.test.ts's comment).
 */
import { parentPort } from "node:worker_threads";

if (!parentPort) {
  throw new Error("hanging-cel-worker-entry must run inside a worker_thread");
}

parentPort.on("message", () => {
  // Deliberately never postMessage a reply.
});

// Announce readiness immediately so `CelSandbox.evaluate()`'s per-call timeout (not the
// separate, much longer ready-wait timeout) is what the test actually exercises.
parentPort.postMessage({ ready: true });
