/** JSON-RPC 2.0 message shapes for the subprocess plugin host. See docs/plugin-host.md §92. */

/** THE INVENTORY OF EVERY METHOD THAT CROSSES THIS WIRE. See docs/plugin-host.md §93. */
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
