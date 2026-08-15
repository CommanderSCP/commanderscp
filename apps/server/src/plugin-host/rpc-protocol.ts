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

/**
 * THE INVENTORY OF EVERY METHOD THAT CROSSES THIS WIRE — one member per `case` in
 * subprocess-entry.ts's `dispatch()`, and one per method on a `plugin-host/contract.ts` client.
 *
 * It is documentation with a compiler behind it rather than a parameter type: `RpcRequest.method` is
 * deliberately a plain `string` (see below), because the callee must be able to receive a method it
 * has never heard of and refuse it explicitly. The union is what makes "which verbs exist" answerable
 * from one place — and it had gone stale, which is exactly the failure mode a list maintained by hand
 * has: M8's four `FederationTransportPlugin` methods and M21.4's three `DependencyIndexPlugin`
 * methods were dispatched by the subprocess and called by the host without ever appearing here. They
 * are added below with M21.4's `readFileAtRef`, so the inventory describes the wire again.
 */
export type RpcMethod =
  | "observe"
  | "trigger"
  | "status"
  | "abort"
  | "describeCapabilities"
  // M4: ControlPlugin's sole method (DESIGN.md §11's ControlPlugin interface) — same host, same
  // wire framing, dispatched by subprocess-entry.ts based on which kind of plugin this instance
  // loaded.
  | "evaluate"
  // M7: DiscoveryPlugin's sole method (github repo/topology scan) and NotificationPlugin's sole
  // method (smtp-notify/webhook-notify) — same host, same wire framing, same dispatch-by-kind.
  | "discover"
  | "send"
  // M8: FederationTransportPlugin (`federation-https` — DESIGN §13).
  | "push"
  | "pull"
  | "exportBundle"
  | "importBundle"
  // M21.4: DependencyIndexPlugin, the per-ecosystem third-party version index (ADR-0032 §7).
  | "listVersions"
  | "resolveDigest"
  | "describeIndex"
  /**
   * M21.4: the GIT-PROVIDER FILE READ (ADR-0032 §7a) — `readFileAtRef`, M21.2's
   * `GitProviderAdapter` hook, reached from the server for the first time.
   *
   * IT IS NOT A FIFTH EXECUTOR VERB, and the distinction is structural rather than stylistic
   * (ADR-0032 §9, charter principle 1). `createExecutorPluginFromAdapter` still does not surface it,
   * so the object an `ExecutorPlugin` instance exposes carries exactly observe/trigger/status/abort
   * — the four-verb set that *is* the enforcement of "coordination, not execution". This method is
   * dispatched from the loaded ADAPTER beside that plugin, and only the three git providers carry
   * one; every other executor answers "this instance has no file-read hook". It only READS: nothing
   * behind it can write a branch, a commit or a PR.
   */
  | "readFileAtRef";

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
