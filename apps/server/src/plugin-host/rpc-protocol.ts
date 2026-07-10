/**
 * JSON-RPC 2.0 message shapes for the subprocess plugin host (DESIGN.md §11: "speaking JSON-RPC
 * 2.0 over stdio"). Framing choice: newline-delimited JSON ("ndjson") on the child's stdin
 * (requests in) and stdout (responses + one "ready" notification out) — one complete JSON value
 * per line. Chosen over a length-prefixed/Content-Length framing (as LSP uses) for simplicity
 * (CLAUDE.md's #1 decision priority): Node's pipes are already line-buffer-friendly, our messages
 * are always small (a `TriggerIntent`, an `ExecutorEvent[]`, never a large binary payload — the
 * plugin-api contract is JSON-serializable args/results only), and `readline` gives us the
 * splitting for free on both ends.
 *
 * Shared by host.ts (the parent/caller side, apps/server/src/plugin-host/host.ts) and
 * subprocess-entry.ts (the child/callee side) so both sides agree on one wire shape.
 *
 * CRITICAL: a child's stdout carries ONLY these messages, ever — never a plain log line. Any
 * human-readable logging goes to stderr instead (subprocess-entry.ts's `Logger`), or it would
 * corrupt the RPC stream host.ts is parsing.
 */

export type RpcMethod = "observe" | "trigger" | "status" | "abort" | "describeCapabilities";

export interface RpcRequest {
  jsonrpc: "2.0";
  id: number;
  /** `string`, not `RpcMethod`, on this side deliberately — this is what a subprocess actually
   *  reads off the wire, where nothing guarantees the sender only ever sent a known method; the
   *  callee validates it explicitly (subprocess-entry.ts's dispatch switch). */
  method: string;
  params: unknown;
}

export interface RpcSuccessResponse {
  jsonrpc: "2.0";
  id: number;
  result: unknown;
}

export interface RpcErrorResponse {
  jsonrpc: "2.0";
  id: number;
  error: { code: number; message: string };
}

export type RpcResponse = RpcSuccessResponse | RpcErrorResponse;

/** Sent once, id-less, immediately after the child finishes constructing its plugin + PluginContext
 *  — host.ts's `start()`/restart machinery waits for this before considering an instance callable. */
export interface RpcReadyNotification {
  jsonrpc: "2.0";
  method: "ready";
}

export type RpcMessage = RpcRequest | RpcResponse | RpcReadyNotification;

export function encodeMessage(msg: RpcMessage): string {
  return `${JSON.stringify(msg)}\n`;
}

export function parseMessage(line: string): RpcMessage {
  return JSON.parse(line) as RpcMessage;
}

export function isReadyNotification(msg: RpcMessage): msg is RpcReadyNotification {
  return "method" in msg && msg.method === "ready";
}

export function isResponse(msg: RpcMessage): msg is RpcResponse {
  return "id" in msg && !("method" in msg);
}

export function isErrorResponse(msg: RpcResponse): msg is RpcErrorResponse {
  return "error" in msg;
}
