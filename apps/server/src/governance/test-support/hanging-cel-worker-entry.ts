/** A worker that receives messages but never responds. See docs/governance.md §431. */
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
