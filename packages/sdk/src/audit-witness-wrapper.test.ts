import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScpClient } from "./client.js";
import { ScpResponseValidationError } from "./errors.js";

/**
 * Federation audit witness (multi-region-instance-resilience.md §7.2.7) —
 * `client.federation.listAuditWitnesses()`, the post-failover peers-witness comparison's read
 * surface (resilience runbook §7.2 step 5). The route already existed; only the hand-written
 * `ScpClient` wrapper (and the CLI command on top of it) was missing.
 *
 * Driven through the REAL generated client against a loopback HTTP server, same harness as
 * `dependency-read-surface-wrappers.test.ts` — DELETE THE WIRING: this test dies if the wrapper
 * line is removed from `client.ts`, points at the wrong generated request, or drops the
 * `originDomainId` query param on the way through.
 */

function wellFormedAuditWitnesses(): unknown {
  return {
    items: [
      {
        originDomainId: "peer-domain-1",
        sequence: 1,
        auditEventId: "55555555-5555-4555-8555-555555555555",
        contentHash: "deadbeef",
        witnessedAt: "2026-08-30T12:00:00.000Z"
      }
    ]
  };
}

describe("SDK wiring: client.federation.listAuditWitnesses()", () => {
  let server: Server;
  let baseUrl: string;
  let body: unknown;
  let requests: { method: string | undefined; url: string | undefined }[];

  beforeEach(async () => {
    requests = [];
    server = createServer((req, res) => {
      requests.push({ method: req.method, url: req.url });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    );
  });

  function client(): ScpClient {
    return new ScpClient({ baseUrl });
  }

  it("GETs /federation/audit-witnesses with the query param and returns items", async () => {
    body = wellFormedAuditWitnesses();

    const result = await client().federation.listAuditWitnesses("peer-domain-1");

    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("GET");
    const url = new URL(requests[0]?.url ?? "", baseUrl);
    expect(url.pathname).toBe("/federation/audit-witnesses");
    expect(url.searchParams.get("originDomainId")).toBe("peer-domain-1");
    expect(result).toEqual((wellFormedAuditWitnesses() as { items: unknown[] }).items);
  });

  it("sits behind the response validator (ADR-0023) — a body missing `items` is refused", async () => {
    const malformed = wellFormedAuditWitnesses() as { items?: unknown };
    delete malformed.items;
    body = malformed;
    const err = (await client()
      .federation.listAuditWitnesses("peer-domain-1")
      .catch((e: unknown) => e)) as ScpResponseValidationError;
    expect(err).toBeInstanceOf(ScpResponseValidationError);
    expect(err.operation).toBe("GET /federation/audit-witnesses");
    expect(err.issues.map((i) => i.path)).toContain("items");
  });
});
