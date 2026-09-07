import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { listenTestServer, type ListeningTestServer } from "../test-support/harness.js";

/** THE SPA SHELL IS SERVED FRESH. See docs/routes.md §413. */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIST_ROOT = path.resolve(__dirname, "../../../web/dist");
const INDEX_HTML = path.join(WEB_DIST_ROOT, "index.html");

/** Captures whatever is on disk now and hands back an exact restore. */
async function withTemporaryIndexHtml(
  run: (write: (html: string) => Promise<void>) => Promise<void>
): Promise<void> {
  let previous: string | undefined;
  try {
    previous = await readFile(INDEX_HTML, "utf8");
  } catch {
    previous = undefined; // not built — we create it, and remove it again below
  }
  await mkdir(WEB_DIST_ROOT, { recursive: true });
  try {
    await run(async (html: string) => {
      await writeFile(INDEX_HTML, html, "utf8");
    });
  } finally {
    if (previous === undefined) {
      await rm(INDEX_HTML, { force: true });
    } else {
      await writeFile(INDEX_HTML, previous, "utf8");
    }
  }
}

const GEN1 = '<!doctype html><html><body><div id="root"></div><!--generation-1--></body></html>';
const GEN2 = '<!doctype html><html><body><div id="root"></div><!--generation-2--></body></html>';

describe("SPA shell freshness: a deep link reflects index.html as it is on disk now", () => {
  it("serves the NEW index.html on a deep link after the file changes under a running server", async () => {
    await withTemporaryIndexHtml(async (write) => {
      await write(GEN1);
      const server: ListeningTestServer = await listenTestServer({});
      try {
        const origin = new URL(server.baseUrl).origin;

        // First request establishes whatever caching the server does — this is the request that
        // used to populate the process-lifetime snapshot.
        const first = await fetch(`${origin}/services/anything`);
        expect(first.status).toBe(200);
        expect(await first.text()).toContain("generation-1");

        // The file changes underneath the running process, exactly as `pnpm --filter @scp/web
        // build` does.
        await write(GEN2);

        const second = await fetch(`${origin}/services/anything`);
        expect(second.status).toBe(200);
        const body = await second.text();
        expect(body).toContain("generation-2");
        expect(body).not.toContain("generation-1");
      } finally {
        await server.close();
      }
    });
  });

  it("`/` and a deep link serve the SAME bytes — the asymmetry itself is what regressed", async () => {
    await withTemporaryIndexHtml(async (write) => {
      await write(GEN1);
      const server: ListeningTestServer = await listenTestServer({});
      try {
        const origin = new URL(server.baseUrl).origin;

        // Prime the deep-link path FIRST, so a reintroduced snapshot would be taken from
        // generation 1 and this test would catch it below.
        expect(await (await fetch(`${origin}/services/anything`)).text()).toContain("generation-1");

        await write(GEN2);

        const root = await fetch(`${origin}/`);
        const deep = await fetch(`${origin}/services/anything`);
        expect(root.status).toBe(200);
        expect(deep.status).toBe(200);
        expect(await deep.text()).toBe(await root.text());
      } finally {
        await server.close();
      }
    });
  });

  it("PREMISE: the sentinel really travels end to end (a generation never written is never served)", async () => {
    await withTemporaryIndexHtml(async (write) => {
      await write(GEN1);
      const server: ListeningTestServer = await listenTestServer({});
      try {
        const origin = new URL(server.baseUrl).origin;
        const body = await (await fetch(`${origin}/services/anything`)).text();
        expect(body).toContain("generation-1");
        expect(body).not.toContain("generation-2");
      } finally {
        await server.close();
      }
    });
  });
});
