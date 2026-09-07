import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { productionSourceFiles, readStripped } from "@scp/source-census";

/** THE ONE POOL FACTORY. See docs/db.md §11. */

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = join(HERE, "..");
const CLIENT_FILE = join(HERE, "client.ts");

const POOL_CONSTRUCTION = /new\s+(?:pg\.)?Pool\s*\(/;

// The test-support trees are Testcontainers-only scaffolding. See docs/db.md §12.
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
