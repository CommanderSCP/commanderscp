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

interface StatusBody extends JsonObject {
  peers: JsonObject[];
}

function wellFormedStatus(): StatusBody {
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

/** The sole `peers[]` entry of a fresh known-good body. */
function onlyPeerEntry(body: StatusBody): JsonObject {
  const entry = body.peers[0];
  if (entry === undefined) throw new Error("fixture invariant: exactly one peer entry");
  return entry;
}

/** That entry's nested `peer` object. */
function onlyPeer(body: StatusBody): JsonObject {
  return onlyPeerEntry(body).peer as JsonObject;
}

/** A fresh known-good body with `mutate` applied — each case starts from the same baseline. */
function statusWith(mutate: (body: StatusBody) => void): StatusBody {
  const body = wellFormedStatus();
  mutate(body);
  return body;
}

/** A body whose only peer is missing `peer.syncScope` — the round-3/4/5 regression. */
function statusMissingSyncScope(): StatusBody {
  return statusWith((b) => {
    delete onlyPeer(b).syncScope;
  });
}

const OBJECT_ID = "22222222-2222-4222-8222-222222222222";

/** A well-formed `GraphObject` — the 200 AND the 201 branch of every upsert-by-urn union. */
function wellFormedObject(): JsonObject {
  return {
    id: OBJECT_ID,
    orgId: OBJECT_ID,
    domainId: null,
    typeId: "service",
    name: "checkout",
    urn: "urn:scp:service:checkout",
    properties: {},
    labels: {},
    originDomainId: OBJECT_ID,
    revision: 1,
    provenance: null,
    // M20.1 (ADR-0031) — required on the wire. Added HERE, in the shared well-formed fixture,
    // rather than to the dedup test's expected issue list: that test's subject is that a union
    // reports each missing field ONCE, and it names the fields it omits by `delete`-ing them
    // explicitly. Keeping its missing set exactly {revision, urn} preserves what it measures;
    // widening the expectation instead would have quietly turned it into a test that also
    // tracks the object's field count.
    domainLocal: false,
    // M20.7 (ADR-0031 §6c). Added HERE, in the shared well-formed fixture, for the same reason
    // `domainLocal` was: the union-dedup test names its omissions by `delete`-ing them, so its
    // missing set must stay exactly {revision, urn}.
    domainLocalInheritedFrom: null,
    version: 1,
    createdAt: "2026-07-30T12:00:00Z",
    updatedAt: "2026-07-30T12:00:00Z",
    deletedAt: null
  };
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
    body = statusMissingSyncScope();

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
    body = statusWith((b) => {
      delete onlyPeerEntry(b).recentTransfers;
    });

    const error = (await client()
      .federation.status()
      .catch((e: unknown) => e)) as ScpResponseValidationError;

    expect(error).toBeInstanceOf(ScpResponseValidationError);
    expect(error.operation).toBe("GET /federation/status");
    expect(error.issues.map((i) => i.path)).toContain("peers.0.recentTransfers");
  });

  it("fails ONCE — one request, one throw, no retry and no silent undefined", async () => {
    body = statusMissingSyncScope();

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
    body = statusMissingSyncScope();

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
    const sent = statusWith((b) => {
      onlyPeerEntry(b).someFieldFromANewerInstance = { nested: true };
    });
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

  // -------------------------------------------------------------------------------------------
  // Unions. `@hey-api`'s zod plugin emits `z.union([...])` for every operation declaring two 2xx
  // codes — all 11 upsert-by-urn operations (200 updated / 201 created), i.e. exactly the write
  // path `packages/iac` drives. zod 4 collapses a failed union into ONE top-level
  // `invalid_union` issue and hides the per-branch issues in a nested `errors: ZodIssue[][]`,
  // so reading `error.issues` alone names NO field and the promise `ScpResponseValidationError`
  // makes ("naming BOTH the operation and the offending field(s)") is void precisely where it
  // matters most.
  // -------------------------------------------------------------------------------------------

  it("names the offending FIELD when the operation's response schema is a union", async () => {
    // `PUT /objects/{type}/{urn}` — 200 | 201, so `zUpsertObjectByUrnResponse` is a `z.union`.
    body = ((): JsonObject => {
      const object = wellFormedObject();
      delete object.urn;
      return object;
    })();

    const error = (await client()
      .object("service")
      .upsertByUrn("urn:scp:service:checkout", { name: "checkout" })
      .catch((e: unknown) => e)) as ScpResponseValidationError;

    expect(error).toBeInstanceOf(ScpResponseValidationError);
    expect(error.operation).toBe("PUT /objects/{type}/{urn}");
    // The regression: before the union issues were flattened this was the whole diagnosis —
    // `<root> (invalid_union: Invalid input)`, naming nothing a human could act on.
    expect(error.issues.map((i) => i.path)).toContain("urn");
    expect(error.issues.map((i) => i.path)).not.toContain("<root>");
    expect(error.message).toContain("PUT /objects/{type}/{urn}");
    expect(error.message).toContain("urn");
  });

  it("lists a union's fields ONCE, not once per branch", async () => {
    // Both branches of the upsert union are the same object shape, so each reports the same two
    // missing fields; un-deduplicated they would fill the 5-issue message budget with repeats.
    body = ((): JsonObject => {
      const object = wellFormedObject();
      delete object.urn;
      delete object.revision;
      return object;
    })();

    const error = (await client()
      .object("service")
      .upsertByUrn("urn:scp:service:checkout", { name: "checkout" })
      .catch((e: unknown) => e)) as ScpResponseValidationError;

    expect(error.issues.map((i) => i.path).sort()).toEqual(["revision", "urn"]);
  });

  it("still accepts a well-formed union response", async () => {
    body = wellFormedObject();

    const object = await client()
      .object("service")
      .upsertByUrn("urn:scp:service:checkout", { name: "checkout" });

    expect(object).toEqual(body);
  });

  // -------------------------------------------------------------------------------------------
  // Empty bodies. `client.gen.ts` returns `{}` for ANY 2xx with `status === 204` or
  // `Content-Length: 0` WITHOUT running `responseValidator` — the one bypass of "fails once".
  // The shipped Fastify server never emits it; a proxy/ingress/CDN in front of an instance can,
  // and that is this product's deployment shape.
  // -------------------------------------------------------------------------------------------

  function serve(status: number, headers: Record<string, string>, payload = ""): void {
    server.removeAllListeners("request");
    server.on("request", (_req, res) => {
      requestCount += 1;
      res.writeHead(status, headers);
      res.end(payload);
    });
  }

  it("rejects a 200 whose body a proxy stripped, instead of returning an empty object", async () => {
    serve(200, { "Content-Type": "application/json", "Content-Length": "0" });

    let resolved: unknown = "not-resolved";
    let threw: unknown;
    try {
      resolved = await client().federation.status();
    } catch (e) {
      threw = e;
    }

    // The measured falsehood this closes: `scp federation status` exited 0 and printed
    // "Self: not initialized / No paired peers" off a `{}` that no validator ever saw.
    expect(resolved).toBe("not-resolved");
    expect(threw).toBeInstanceOf(ScpResponseValidationError);
    const error = threw as ScpResponseValidationError;
    expect(error.operation).toBe("GET /federation/status");
    expect(error.status).toBe(200);
    expect(error.issues.map((i) => i.code)).toContain("empty_body");
    expect(requestCount).toBe(1);
  });

  it("rejects a 204 on an operation whose contract declares a body", async () => {
    serve(204, {});

    const error = (await client()
      .federation.status()
      .catch((e: unknown) => e)) as ScpResponseValidationError;

    expect(error).toBeInstanceOf(ScpResponseValidationError);
    expect(error.operation).toBe("GET /federation/status");
    expect(error.status).toBe(204);
  });

  it("still lets the genuinely body-less operations through (204 No Content)", async () => {
    // `zLogoutResponse` is `z.void()`; so are `zDeleteSecretResponse` and
    // `zDeleteNotificationBindingResponse`. Recognised by asking the
    // operation's own validator whether an absent body satisfies it — not by an allowlist.
    serve(204, {});

    await expect(client().auth.logout()).resolves.toBeUndefined();
    expect(requestCount).toBe(1);
  });

  it("still lets a body-less operation through when the 2xx carries Content-Length: 0", async () => {
    serve(200, { "Content-Type": "application/json", "Content-Length": "0" });

    await expect(client().auth.logout()).resolves.toBeUndefined();
  });
});
