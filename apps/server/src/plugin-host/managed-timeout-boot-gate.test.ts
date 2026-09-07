import { afterEach, describe, expect, it, vi } from "vitest";

/** The install-site gate for the boot-time schema assertion. See docs/plugin-host.md §66. */
describe("the managed timeoutMs ceiling is asserted AT BOOT, not merely asserted somewhere", () => {
  afterEach(() => {
    vi.doUnmock("@scp/plugin-managed-scan");
    vi.resetModules();
  });

  it("importing executor-bindings-repo THROWS when a managed manifest has no timeoutMs ceiling", async () => {
    vi.resetModules();
    vi.doMock("@scp/plugin-managed-scan", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@scp/plugin-managed-scan")>();
      return {
        ...actual,
        // Byte-for-byte the shape all three managed plugins shipped before M23.1c: a floor and no
        // ceiling, so a tenant could set 2^31.
        manifest: {
          id: "managed-scan",
          kind: "executor",
          version: "0.1.0",
          configSchema: {
            type: "object",
            additionalProperties: false,
            properties: { timeoutMs: { type: "integer", minimum: 1000, default: 600_000 } }
          }
        }
      };
    });

    await expect(import("../coordination/executor-bindings-repo.js")).rejects.toThrow(
      /managed-scan/
    );
  });

  it("and imports cleanly against the manifests as shipped — the refusal above is not unconditional", async () => {
    vi.resetModules();
    const mod = await import("../coordination/executor-bindings-repo.js");
    expect(mod.KNOWN_EXECUTOR_MODULES).toContain("managed-scan");
  });
});
