import { afterEach, describe, expect, it } from "vitest";
import { SubprocessPluginHost } from "./host.js";

/** The git file read crosses the plugin-host boundary. See docs/plugin-host.md §40. */

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

/** Instances started from a work list need a lifecycle. See docs/plugin-host.md §41. */
describe("PluginHost.stopInstances (M21.4)", () => {
  it("stops the named instance and leaves the others running", async () => {
    host = new SubprocessPluginHost({ callTimeoutMs: 20_000 });
    await host.start([
      { id: "keep", module: "fake-executor", orgId: "org-1", scopeKey: "domain-1" },
      { id: "drop", module: "fake-executor", orgId: "org-1", scopeKey: "domain-1" }
    ]);

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
