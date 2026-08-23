import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * THE INSTALL-SITE GATE for M23.1c's `assertManagedTimeoutSchemas()`.
 *
 * `call-policy.test.ts` proves the assertion WORKS. This proves it is CALLED — and the distinction
 * is this repository's single most common defect (CLAUDE.md: "a component correctly built, well
 * tested, and installed nowhere", six instances in one recent milestone, one of them a live RCE).
 * A boot check that nothing invokes is a comment with a stack trace.
 *
 * The check therefore has to be exercised the way production reaches it: by IMPORTING the module
 * that owns the allowlist. `coordination/executor-bindings-repo.ts` calls it at module load, beside
 * `assertEveryModuleHasManifest`, so this test replaces one managed plugin's manifest with an
 * unbounded one and asserts the IMPORT ITSELF rejects.
 *
 * DELETE THE `assertManagedTimeoutSchemas()` LINE FROM `executor-bindings-repo.ts` AND THIS TEST
 * FAILS BY NAME — the import resolves happily and `.rejects` has nothing to catch. Nothing else in
 * the suite would notice: `call-policy.ts` would simply stop treating `managed-scan` as managed and
 * hand its `trigger` the 10s hang detector back, which is the original defect, restored on one
 * plugin, green.
 */
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
