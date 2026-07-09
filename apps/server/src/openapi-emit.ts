import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDb, createPool } from "./db/client.js";
import { buildOpenApiDocument } from "./openapi/build-document.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = path.resolve(__dirname, "../../../tools/openapi/openapi.v1.json");

/**
 * Boots route definitions without a DB (`pg.Pool` never connects until a query runs) and
 * serializes the OpenAPI 3.1 doc — BUILD_AND_TEST.md §3.2, §8 M0.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  const db = createDb(pool);

  const app = await buildApp({ db, config }, { logger: false });
  await app.ready();

  const document = buildOpenApiDocument(app.routeRegistry);
  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(document, null, 2) + "\n", "utf8");

  await app.close();
  await pool.end();

  console.log(`openapi:emit wrote ${OUTPUT_PATH}`);
}

main().catch((err: unknown) => {
  console.error("openapi:emit failed:", err);
  process.exitCode = 1;
});
