import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { productionSourceFiles, readStripped } from "@scp/source-census";

/**
 * ================================================================================================
 * THE ONE POOL FACTORY — a standing gate against the A6 census reopening
 * ================================================================================================
 *
 * Problem (proposal multi-region-instance-resilience.md §4-A6, §7.1 item 6): `createPool` in
 * `client.ts` is the only place that applies `connectionTimeoutMillis`/`keepAlive`, so a connect
 * against a dead host (mid-failover) fails fast onto the promoted primary instead of hanging at OS
 * TCP patience. Three route files were found constructing `new pg.Pool(...)` directly, bypassing
 * that — this is the census that keeps a fourth one from landing unnoticed.
 *
 * `productionSourceFiles` excludes `*.test.ts`: integration tests legitimately build their own
 * scratch pools against a Testcontainers instance (unrelated to this production failover concern),
 * and `outbox-relay.ts`'s dedicated `new pg.Client` for its LISTEN connection is a `Client`, not a
 * `Pool`, and is out of this item's scope.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = join(HERE, "..");
const CLIENT_FILE = join(HERE, "client.ts");

const POOL_CONSTRUCTION = /new\s+(?:pg\.)?Pool\s*\(/;

// `test-support/` trees (root and nested) are Testcontainers-only scaffolding — bootstrapping a
// throwaway template/scratch database before migrations run, never a request-serving connection —
// and are excluded from the A6 concern the same way `productionSourceFiles` already excludes
// `*.test.ts`. `productionSourceFiles` cannot tell the two apart on filename alone (these files
// don't end in `.test.ts`, since vitest never loads them as test files directly).
function isTestSupportPath(file: string): boolean {
  return relative(SERVER_SRC, file).split("/").includes("test-support");
}

describe("new pg.Pool appears only in db/client.ts", () => {
  const files = productionSourceFiles(SERVER_SRC).filter((file) => !isTestSupportPath(file));

  it("finds production source files to census at all (the census is not vacuous)", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("client.ts itself still constructs the pool (the census target exists)", () => {
    expect(POOL_CONSTRUCTION.test(readStripped(CLIENT_FILE))).toBe(true);
  });

  it("no other production source file constructs a pg.Pool directly", () => {
    const offenders = files
      .filter((file) => file !== CLIENT_FILE)
      .filter((file) => POOL_CONSTRUCTION.test(readStripped(file)))
      .map((file) => relative(SERVER_SRC, file));

    expect(
      offenders,
      "a production file constructs `new pg.Pool(...)` directly instead of calling " +
        "`createPool` from db/client.ts — it will not get connectionTimeoutMillis/keepAlive, " +
        "reopening the A6 census this test guards"
    ).toEqual([]);
  });
});
