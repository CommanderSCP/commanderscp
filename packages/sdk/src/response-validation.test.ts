import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScpClient } from "./client.js";
import { ScpApiError, ScpResponseValidationError } from "./errors.js";

/**
 * ADR-0023 — response validation at the SDK boundary.
 *
 * These tests drive the REAL generated client against a real (loopback-only) HTTP server, so what
 * is under test is the shipped path: `sdk.gen.ts`'s per-operation `responseValidator` → the
 * generated client's error channel → `response-validation.ts`'s interceptor → `unwrap()`.
 *
 * `GET /federation/status` is the operation four consecutive review rounds of PR #155 each found a
 * NEW unguarded dereference in (`peer.syncScope` three times over, `recentTransfers` once). It is
 * the regression the boundary exists to make impossible to reach a component.
 */

const PEER_ID = "11111111-1111-4111-8111-111111111111";

interface JsonObject {
  [key: string]: unknown;
}

function wellFormedStatus(): JsonObject {
  return {
    self: null,
    peers: [
      {
        peer: {
          id: PEER_ID,
          name: "outpost-alpha",
          role: "outpost",
          baseUrl: null,
          syncScope: { mode: "full" },
          publicKey: "pk",
          pairedAt: "2026-07-30T12:00:00Z"
        },
        lastAppliedSequence: 7,
        lastSyncedAt: null,
        recentTransfers: []
      }
    ]
  };
}

/** Deep clone + delete, so each case starts from the same known-good body. */
function statusWithout(mutate: (body: JsonObject) => void): JsonObject {
  const body = wellFormedStatus();
  mutate(body);
  return body;
}

describe("SDK response validation (ADR-0023)", () => {
  let server: Server;
  let baseUrl: string;
  let body: unknown;
  let requestCount: number;

  beforeEach(async () => {
    requestCount = 0;
    server = createServer((_req, res) => {
      requestCount += 1;
      const payload = JSON.stringify(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(payload);
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

  it("rejects a response missing a required field, naming the operation and the field", async () => {
    // The round-3/round-4 regression: a peer whose `syncScope` the instance did not send.
    body = statusWithout((b) => {
      delete ((b.peers as JsonObject[])[0].peer as JsonObject).syncScope;
    });

    const error = await client()
      .federation.status()
      .then(
        () => {
          throw new Error("expected federation.status() to reject");
        },
        (e: unknown) => e
      );

    expect(error).toBeInstanceOf(ScpResponseValidationError);
    const validation = error as ScpResponseValidationError;
    // The OPERATION — without it a version-skew report is unactionable.
    expect(validation.operation).toBe("GET /federation/status");
    expect(validation.method).toBe("GET");
    expect(validation.path).toBe("/federation/status");
    expect(validation.status).toBe(200);
    // The FIELD — the exact path inside the body, not just "something was invalid".
    expect(validation.issues.map((i) => i.path)).toContain("peers.0.peer.syncScope");
    // Both must be legible from `error.message` alone, since that is all a CLI top-level handler
    // (`packages/cli/src/bin.ts`) and a react-query error state ever print.
    expect(validation.message).toContain("GET /federation/status");
    expect(validation.message).toContain("peers.0.peer.syncScope");
  });

  it("names a missing required ARRAY field too (the round-4 `recentTransfers` site)", async () => {
    body = statusWithout((b) => {
      delete (b.peers as JsonObject[])[0].recentTransfers;
    });

    const error = (await client()
      .federation.status()
      .catch((e: unknown) => e)) as ScpResponseValidationError;

    expect(error).toBeInstanceOf(ScpResponseValidationError);
    expect(error.operation).toBe("GET /federation/status");
    expect(error.issues.map((i) => i.path)).toContain("peers.0.recentTransfers");
  });

  it("fails ONCE — one request, one throw, no retry and no silent undefined", async () => {
    body = statusWithout((b) => {
      delete ((b.peers as JsonObject[])[0].peer as JsonObject).syncScope;
    });

    let resolved: unknown = "not-resolved";
    let threw: unknown;
    try {
      resolved = await client().federation.status();
    } catch (e) {
      threw = e;
    }

    // Not swallowed: the call must NOT resolve (to data, or to `undefined`).
    expect(resolved).toBe("not-resolved");
    expect(threw).toBeInstanceOf(ScpResponseValidationError);
    expect(requestCount).toBe(1);
  });

  it("does not disguise a validation failure as a generic API error", async () => {
    body = statusWithout((b) => {
      delete ((b.peers as JsonObject[])[0].peer as JsonObject).syncScope;
    });

    const error = (await client()
      .federation.status()
      .catch((e: unknown) => e)) as Error;

    // `unwrap()` would otherwise coerce the ZodError into `ScpApiError("CommanderSCP API error")`
    // with no field and no operation — the mystery-error outcome this whole change replaces.
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ScpApiError);
    expect(error.message).not.toBe("CommanderSCP API error");
  });

  it("leaves a well-formed response untouched, including fields the SDK does not know about", async () => {
    // Forward compatibility: a NEWER instance sending an extra field must still work, and the
    // payload handed to callers must be the server's, not a validator-rewritten copy.
    const sent = wellFormedStatus();
    (sent.peers as JsonObject[])[0].someFieldFromANewerInstance = { nested: true };
    body = sent;

    const status = await client().federation.status();

    expect(status).toEqual(sent);
    expect(requestCount).toBe(1);
  });

  it("still reports RFC 9457 problem responses as ScpApiError", async () => {
    // The validation branch must not capture the ordinary error path.
    server.removeAllListeners("request");
    server.on("request", (_req, res) => {
      requestCount += 1;
      res.writeHead(403, { "Content-Type": "application/problem+json" });
      res.end(JSON.stringify({ title: "forbidden", status: 403 }));
    });

    const error = (await client()
      .federation.status()
      .catch((e: unknown) => e)) as ScpApiError;

    expect(error).toBeInstanceOf(ScpApiError);
    expect(error).not.toBeInstanceOf(ScpResponseValidationError);
    expect(error.status).toBe(403);
  });
});
