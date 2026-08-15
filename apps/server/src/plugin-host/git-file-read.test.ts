import { afterEach, describe, expect, it } from "vitest";
import { SubprocessPluginHost } from "./host.js";

/**
 * M21.4 (ADR-0032 §7a) — THE GIT-PROVIDER FILE READ CROSSES THE PLUGIN-HOST BOUNDARY.
 *
 * These spawn REAL child processes (like `host.test.ts`) and touch no database, so they belong at
 * the unit layer. They exist because M21.2's `readFileAtRef` was, until this milestone, unreachable
 * from the server: it is a `GitProviderAdapter` hook and deliberately not an `ExecutorPlugin` verb
 * (ADR-0032 §9), and no plugin-host client shape carried a file-read method. Three of the five
 * ADR-0032 §7a ecosystems therefore recorded nothing, every time, under
 * `manifest_reader_unavailable`.
 *
 * WHAT MAKES THESE REAL PROOFS RATHER THAN SHAPE ASSERTIONS. Neither needs a network:
 *
 *  - the POSITIVE test asserts an error message that ONLY `@scp/git-provider-core`'s
 *    `assertSafeRepo` produces, and the github adapter runs it before any HTTP. So seeing that text
 *    means the call travelled server → JSON-RPC → subprocess → `loadPlugin`'s adapter hook and
 *    executed inside it. A stub, a mis-wired dispatch, or a client that never left the server
 *    cannot produce it.
 *  - the NEGATIVE test pins that a non-git module refuses by naming the missing HOOK. Before the
 *    wiring, every module answered `unknown method "readFileAtRef" for an ExecutorPlugin instance`
 *    — which is what the dispatch's default arm still says for a genuinely unknown verb, so the two
 *    outcomes stay distinguishable.
 */

let host: SubprocessPluginHost | undefined;

afterEach(async () => {
  await host?.stop();
  host = undefined;
});

describe("PluginHost.gitFileRead (M21.4, ADR-0032 §7a)", () => {
  it("reaches the git provider ADAPTER'S OWN hook inside the subprocess", async () => {
    host = new SubprocessPluginHost({ callTimeoutMs: 20_000 });
    await host.start([
      {
        id: "github-read",
        module: "github",
        orgId: "org-1",
        scopeKey: "domain-1",
        config: {
          appId: "1",
          installationId: "2",
          owner: "acme",
          repo: "widgets",
          privateKeyPem: "not-used-on-this-path"
        }
      }
    ]);

    // A repo the adapter's own `assertSafeRepo` refuses, checked BEFORE any HTTP — so this proves
    // the hook ran without needing a network the test does not have.
    await expect(
      host.gitFileRead("github-read").readFileAtRef({
        repo: "acme/widgets/../..",
        path: "package.json",
        ref: "main"
      })
    ).rejects.toThrow(/github readFileAtRef: repo .* contains a '\.'\/'\.\.' segment/);
  }, 30_000);

  it("a non-git-provider executor refuses by naming the MISSING HOOK, not an unknown method", async () => {
    host = new SubprocessPluginHost({ callTimeoutMs: 20_000 });
    await host.start([
      { id: "fake-read", module: "fake-executor", orgId: "org-1", scopeKey: "domain-1" }
    ]);

    await expect(
      host.gitFileRead("fake-read").readFileAtRef({ path: "package.json", ref: "main" })
    ).rejects.toThrow(/has no readFileAtRef hook/);
  }, 30_000);

  it("NEGATIVE CONTROL — a genuinely unknown verb still fails as an unknown method", async () => {
    // Keeps the message above from being the answer to everything: if the dispatch ever swallowed
    // unrecognised methods, this would start reporting the file-read refusal too.
    host = new SubprocessPluginHost({ callTimeoutMs: 20_000 });
    await host.start([
      { id: "fake-unknown", module: "fake-executor", orgId: "org-1", scopeKey: "domain-1" }
    ]);

    await expect(
      (
        host as unknown as {
          call(id: string, method: string, params?: unknown): Promise<unknown>;
        }
      ).call("fake-unknown", "writeFileAtRef", {})
    ).rejects.toThrow(/unknown method "writeFileAtRef"/);
  }, 30_000);
});

/**
 * M21.4 MINOR E — instances started from a WORK-LIST need a lifecycle.
 *
 * `stop()` tears down everything; there was no way to stop ONE. The dependency version poll starts
 * an index instance per (ecosystem, org) on demand and, with no partial stop, those children stood
 * for the worker's lifetime — up to five per org on a multi-tenant commander, for a job that runs
 * once a day.
 */
describe("PluginHost.stopInstances (M21.4)", () => {
  it("stops the named instance and leaves the others running", async () => {
    host = new SubprocessPluginHost({ callTimeoutMs: 20_000 });
    await host.start([
      { id: "keep", module: "fake-executor", orgId: "org-1", scopeKey: "domain-1" },
      { id: "drop", module: "fake-executor", orgId: "org-1", scopeKey: "domain-1" }
    ]);

    // Both live: a call on each succeeds.
    await expect(host.executor("keep").describeCapabilities()).resolves.toBeTruthy();
    await expect(host.executor("drop").describeCapabilities()).resolves.toBeTruthy();

    await host.stopInstances(["drop", "never-started"]);

    // The stopped one is FORGOTTEN — the registry no longer holds it, which is also what lets a
    // later sweep start it afresh.
    await expect(host.executor("drop").describeCapabilities()).rejects.toThrow(/drop/);
    // NEGATIVE CONTROL, and the half that makes this mean something: a partial stop that killed
    // everything would pass every assertion above.
    await expect(host.executor("keep").describeCapabilities()).resolves.toBeTruthy();
  }, 30_000);
});
