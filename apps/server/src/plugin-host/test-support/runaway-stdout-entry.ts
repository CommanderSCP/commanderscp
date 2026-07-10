/**
 * Test fixture ONLY — never referenced by production code. Deliberately violates the plugin-host
 * wire protocol (DESIGN.md §11 / rpc-protocol.ts: stdout carries ONLY newline-delimited JSON-RPC)
 * by, after announcing `ready` like a real plugin instance, flooding stdout with large newline-free
 * chunks forever. Stands in for a buggy/hung/malicious plugin that never terminates a line.
 *
 * Used by `host.test.ts`'s CRITICAL #4 regression test (PR #7 review: the readline framing had no
 * line-length cap, so a plugin like this would grow the PARENT process's memory unboundedly) via
 * `PluginHostOptions.subprocessEntryPath`, which `host.ts` documents as "overridable for tests
 * only."
 */
import { encodeMessage } from "../rpc-protocol.js";

const CHUNK = "x".repeat(64 * 1024); // 64KB per write, no trailing newline — ever.

function flood(): void {
  process.stdout.write(CHUNK, () => setImmediate(flood));
}

process.stdout.write(encodeMessage({ jsonrpc: "2.0", method: "ready" }));
flood();
