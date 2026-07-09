import type { Db } from "./db/client.js";
import type { ServerConfig } from "./config.js";

export interface AppDeps {
  db: Db;
  config: ServerConfig;
}
