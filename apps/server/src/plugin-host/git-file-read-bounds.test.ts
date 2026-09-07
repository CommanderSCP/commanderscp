import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { SubprocessPluginHost } from "./host.js";

/** M21.2 review MAJOR 5, closed. See docs/plugin-host.md §39. */

let host: SubprocessPluginHost | undefined;
let server: Server | undefined;

afterEach(async () => {
  await host?.stop();
  host = undefined;
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

describe("PluginHost.gitFileRead — transport response-size bound (M21.2 review MAJOR 5)", () => {
  it("aborts a contents fetch that never stops sending bytes, rather than buffering it in full", async () => {
    let contentsHits = 0;
    server = createServer((req, res) => {
      const url = req.url ?? "";
      // `apiBase()` prefixes every route with `/api/v1` — matched with `includes` rather than
      // `startsWith` so this fixture does not have to hardcode that prefix.
      if (url.includes("/repos/acme/widgets/commits")) {
        // STEP 1 of gitea's readFileAtRef: resolve `ref` to a commit sha — small, ordinary JSON.
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify([{ sha: "a".repeat(40) }]));
        return;
      }
      if (url.includes("/repos/acme/widgets/contents/")) {
        // STEP 2 — the blob. Writes forever, `res.end()` is NEVER called. A bound enforced only
        // after the stream completes could never observe this response finishing, because it does
        // not: the ONLY way this test can settle is an abort mid-stream.
        contentsHits += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.write('{"type":"file","encoding":"base64","content":"');
        const chunk = "A".repeat(64 * 1024);
        const timer = setInterval(() => {
          if (!res.write(chunk)) {
            // Respect backpressure rather than piling writes into memory on this side of the
            // fixture — the client aborting is what is supposed to stop this, not a write failure.
            res.once("drain", () => {});
          }
        }, 1);
        res.on("close", () => clearInterval(timer));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("could not determine bound port");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    host = new SubprocessPluginHost({ callTimeoutMs: 20_000 });
    await host.start([
      {
        id: "gitea-read",
        module: "gitea",
        orgId: "org-1",
        scopeKey: "domain-1",
        config: {
          baseUrl,
          owner: "acme",
          repo: "widgets",
          tokenPlaintext: "test-pat"
        },
        // Loopback is blocked by default for a tenant module (egress-guard.ts) — `gitea` is
        // deliberately NOT in `OPERATOR_PLANE_MODULES` (subprocess-entry.ts). This test is about
        // the response-size bound, not the egress guard (covered elsewhere), so the grant mirrors
        // `host.test.ts`'s "es-granted" pattern for reaching a loopback fixture on purpose.
        allowInternalEgress: true
      }
    ]);

    await expect(
      host.gitFileRead("gitea-read").readFileAtRef({ path: "big.bin", ref: "main" })
    ).rejects.toThrow(/exceeded the \d+-byte transport ceiling/);

    expect(contentsHits).toBe(1);
  }, 25_000);
});
