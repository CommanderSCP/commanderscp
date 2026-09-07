/** Test fixture ONLY. See docs/plugin-host.md §105. */
import { encodeMessage } from "../rpc-protocol.js";

const CHUNK = "x".repeat(64 * 1024);

function flood(): void {
  process.stdout.write(CHUNK, () => setImmediate(flood));
}

process.stdout.write(encodeMessage({ jsonrpc: "2.0", method: "ready" }));
flood();
