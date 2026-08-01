import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import {
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/**
 * ROUTE SHADOWING vs THE DECLARED CONTRACT (ADR-0023's first catch).
 *
 * Fastify prefers a literal static route over a parametric one, so `POST/GET
 * /api/v1/objects/service` — the M0 route — is the ONLY handler that ever runs for that exact
 * path. The SDK, meanwhile, has no idea: `client.object(type)` calls the GENERIC
 * `createObject`/`listObjects` operations for every type including `service`. The generic
 * operation's declared response is a full `GraphObject`, so the shadowing handler is bound by the
 * shadowED operation's contract whether or not anyone remembers it exists.
 *
 * It was not remembered: until ADR-0023 the M0 handler returned five fields, and
 * `client.object("service").create({...}).urn` was `undefined` at runtime while TypeScript
 * insisted it was a `string`. SDK response validation caught it on its first CI run.
 *
 * This file locks both halves:
 *  1. STRUCTURAL — the set of shadowed (parametric, literal) path pairs in the emitted spec is
 *     exactly the one known pair. A new shadowing route added later fails here, with the pair
 *     named, instead of quietly inheriting a contract nobody checked.
 *  2. BEHAVIOURAL — driven through the real SDK, which runs the generic operation's response
 *     validator against the shadowing handler's actual bytes.
 */

const SPEC_PATH = fileURLToPath(
  new URL("../../../../tools/openapi/openapi.v1.json", import.meta.url)
);

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;

interface OpenApiDoc {
  paths: Record<string, Record<string, unknown>>;
}

/** Every (parametric path, literal path that shadows it, shared methods) triple in the spec. */
function shadowedPairs(doc: OpenApiDoc): string[] {
  const paths = Object.keys(doc.paths);
  const methodsOf = (p: string): Set<string> =>
    new Set(HTTP_METHODS.filter((m) => doc.paths[p]?.[m] !== undefined));
  const found: string[] = [];
  for (const parametric of paths) {
    if (!parametric.includes("{")) continue;
    const a = parametric.replace(/^\//, "").split("/");
    for (const literal of paths) {
      if (literal === parametric) continue;
      const b = literal.replace(/^\//, "").split("/");
      if (a.length !== b.length) continue;
      let matches = true;
      let narrower = false;
      for (const [i, aSeg] of a.entries()) {
        const bSeg = b[i] as string;
        if (aSeg.startsWith("{")) {
          if (!bSeg.startsWith("{")) narrower = true;
        } else if (aSeg !== bSeg) {
          matches = false;
          break;
        }
      }
      if (!matches || !narrower) continue;
      const shared = [...methodsOf(parametric)].filter((m) => methodsOf(literal).has(m)).sort();
      if (shared.length > 0) found.push(`${parametric} <- ${literal} [${shared.join(",")}]`);
    }
  }
  return found.sort();
}

describe("route shadowing must honour the shadowed operation's contract (ADR-0023)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "shadowing");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  });

  afterAll(async () => {
    await server?.close();
  });

  it("the spec contains exactly the ONE known shadowed path pair", async () => {
    const doc = JSON.parse(await readFile(SPEC_PATH, "utf8")) as OpenApiDoc;
    // If this list grows, the new route shadows a generic one: its response must satisfy the
    // GENERIC operation's schema too (the SDK will call the generic operation for it), and it
    // needs a case below. Do not just widen this expectation.
    expect(shadowedPairs(doc)).toEqual(["/objects/{type} <- /objects/service [get,post]"]);
  });

  it("`client.object('service').create()` returns a full GraphObject — not the M0 five-field subset", async () => {
    // Goes to the SHADOWING M0 handler on the wire; validated against the SHADOWED generic
    // `createObject` response schema by the SDK. Before ADR-0023 this threw
    // ScpResponseValidationError; before response validation existed it silently resolved with
    // `urn`/`typeId`/`properties` undefined.
    const created = await admin.object("service").create({ name: "shadow-billing" });

    expect(created.typeId).toBe("service");
    expect(created.urn).toMatch(/^urn:scp:[^:]+:service:shadow-billing$/);
    expect(created.domainId).toEqual(expect.any(String));
    expect(created.originDomainId).toEqual(expect.any(String));
    expect(created.properties).toEqual({});
    expect(created.labels).toEqual({});
    expect(created.version).toBe(1);
    expect(created.revision).toBe(1);
    expect(created.provenance).toBeNull();
    expect(created.deletedAt).toBeNull();
    expect(created.updatedAt).toEqual(expect.any(String));
  });

  it("`client.object('service').list()` items are full GraphObjects too (GET is shadowed as well)", async () => {
    await admin.object("service").create({ name: "shadow-checkout" });

    const page = await admin.object("service").list();
    const item = page.items.find((o) => o.name === "shadow-checkout");

    expect(item, "the created service must come back from the list").toBeDefined();
    expect(item!.typeId).toBe("service");
    expect(item!.urn).toMatch(/^urn:scp:[^:]+:service:shadow-checkout$/);
    expect(item!.version).toBe(1);
  });

  it("the M0 wire contract is preserved — `type: 'service'` is still sent", async () => {
    // Widening must stay ADDITIVE: an M0-era client reading `.type` keeps working. The SDK's
    // GraphObject type has no `type` field, so this asserts on the raw bytes.
    const res = await fetch(`${server.baseUrl}/objects/service`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${org.adminToken}`
      },
      body: JSON.stringify({ name: "shadow-m0-shape" })
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.type).toBe("service");
    expect(body.name).toBe("shadow-m0-shape");
    expect(body.createdAt).toEqual(expect.any(String));
  });
});
