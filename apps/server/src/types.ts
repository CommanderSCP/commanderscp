import type { Db } from "./db/client.js";
import type { ServerConfig } from "./config.js";
import type { CelSandbox } from "./governance/cel-sandbox.js";

export interface AppDeps {
  db: Db;
  config: ServerConfig;
  /** The sandboxed CEL evaluator (governance/cel-sandbox.ts) — every request-serving process
   *  needs one for gate evaluation (routes/changes.ts's promote handler), regardless of whether
   *  it also runs the `PluginHost`-requiring reconciliation loop (DESIGN §16's api/worker split;
   *  see coordination/gates.ts's module doc). Lazily defaulted to the process-wide shared
   *  instance (`getSharedCelSandbox()`) by `buildApp` when the caller doesn't supply one, so
   *  every existing `buildApp({db, config})` call site (openapi:emit, tests) keeps compiling
   *  unchanged. */
  celSandbox?: CelSandbox;
}
