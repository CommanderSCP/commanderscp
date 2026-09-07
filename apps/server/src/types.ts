import type PgBoss from "pg-boss";
import type { Db } from "./db/client.js";
import type { ServerConfig } from "./config.js";
import type { CelSandbox } from "./governance/cel-sandbox.js";
import type { PluginHost } from "./plugin-host/contract.js";

export interface AppDeps {
  db: Db;
  config: ServerConfig;
  /** A small pool dedicated to the per-frame read checks. See docs/server.md §94. */
  sseAuthzDb?: Db;
  /** A SMALL pool dedicated to the recursive-CTE graph read routes. See docs/server.md §95. */
  graphDb?: Db;
  /** The process's job-queue handle, present on some roles only. See docs/server.md §96. */
  boss?: PgBoss;
  /** The sandboxed CEL evaluator (governance/cel-sandbox.ts). See docs/server.md §97. */
  celSandbox?: CelSandbox;
  /** M7: an in-process `PluginHost`. See docs/server.md §98. */
  pluginHost?: PluginHost;
}
