import { describe, expect, it, vi } from "vitest";
import type { PluginContext, ScopedHttpRequest, ScopedHttpResponse } from "@scp/plugin-api";
import { federationHttpsPlugin } from "./index.js";

function mockContext(handler: (req: ScopedHttpRequest) => ScopedHttpResponse): PluginContext {
  return {
    orgId: "org-1",
    domainId: "domain-1",
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    secrets: { get: vi.fn().mockResolvedValue(undefined) },
    http: { request: vi.fn(async (req) => handler(req)) },
    config: { parentBaseUrl: "https://parent.example.com/api/v1", selfPeerName: "child-domain" }
  };
}

describe("federation-https transport plugin", () => {
  it("pull() dials the parent's /federation/exports (child-initiated) and adapts the bundle into a JournalSegment", async () => {
    let capturedRequest: ScopedHttpRequest | undefined;
    const ctx = mockContext((req) => {
      capturedRequest = req;
      return {
        status: 200,
        headers: {},
        body: {
          header: { exporterDomainId: "parent-domain-id", throughSequence: 42 },
          entries: [{ sequence: 1 }, { sequence: 2 }],
          checksum: "abc123",
          bundleSignature: "sig123"
        }
      };
    });

    const segments = await federationHttpsPlugin.pull(ctx, {
      domainId: "parent-domain-id",
      sequence: 10
    });

    expect(capturedRequest?.method).toBe("POST");
    expect(capturedRequest?.url).toBe("https://parent.example.com/api/v1/federation/exports");
    expect(capturedRequest?.body).toEqual({ peer: "child-domain", sinceSequence: 10 });
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      originDomainId: "parent-domain-id",
      sequence: 42,
      contentHash: "abc123",
      signature: "sig123",
      entries: [{ sequence: 1 }, { sequence: 2 }]
    });
  });

  it("push() dials the parent's /federation/imports (child-initiated) with the given bundle body", async () => {
    let capturedRequest: ScopedHttpRequest | undefined;
    const ctx = mockContext((req) => {
      capturedRequest = req;
      return {
        status: 200,
        headers: {},
        body: {
          peerDomainId: "child",
          appliedEntries: 1,
          skippedEntries: 0,
          lastAppliedSequence: 1
        }
      };
    });

    const segmentWithBundle = {
      originDomainId: "child-domain-id",
      sequence: 1,
      contentHash: "h",
      signature: "s",
      entries: [] as unknown[],
      bundle: { header: { kind: "sync" }, entries: [], checksum: "h", bundleSignature: "s" }
    };
    await federationHttpsPlugin.push(ctx, segmentWithBundle);

    expect(capturedRequest?.method).toBe("POST");
    expect(capturedRequest?.url).toBe("https://parent.example.com/api/v1/federation/imports");
    expect(capturedRequest?.body).toEqual({
      header: { kind: "sync" },
      entries: [],
      checksum: "h",
      bundleSignature: "s"
    });
  });

  it("SECURITY: pull() surfaces a non-2xx parent response as an error rather than silently returning empty", async () => {
    const ctx = mockContext(() => ({ status: 403, headers: {}, body: { title: "Forbidden" } }));
    await expect(
      federationHttpsPlugin.pull(ctx, { domainId: "parent", sequence: 0 })
    ).rejects.toThrow(/403/);
  });

  it("exportBundle()/importBundle() are explicit unimplemented errors, never silent no-ops (the file transport owns this path)", async () => {
    const ctx = mockContext(() => ({ status: 200, headers: {}, body: {} }));
    await expect(federationHttpsPlugin.exportBundle(ctx, { peer: "x" })).rejects.toThrow(
      /file transport/
    );
    await expect(
      federationHttpsPlugin.importBundle(ctx, { path: "x", checksum: "x" })
    ).rejects.toThrow(/file transport/);
  });

  it("throws a clear config error rather than dialing anywhere when parentBaseUrl/selfPeerName are missing", async () => {
    const ctx = mockContext(() => ({ status: 200, headers: {}, body: {} }));
    ctx.config = {};
    await expect(federationHttpsPlugin.pull(ctx, { domainId: "x", sequence: 0 })).rejects.toThrow(
      /config\.parentBaseUrl/
    );
  });
});
