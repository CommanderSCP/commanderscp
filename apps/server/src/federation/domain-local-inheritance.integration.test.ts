import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import {
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/**
 * M20.5 (ADR-0031 §6a) — LOCALITY IS INHERITED AT CREATE, ONE HOP, ALONG EITHER CONTAINMENT ROUTE.
 *
 * ## Why this is a door census and not three happy-path cases
 *
 * §6a's one-hop rule is sound only *by induction*: reading the immediate parent equals what a full
 * ancestor walk would return **because every intermediate container was itself stamped at its own
 * create**. The ADR names the precondition explicitly and calls it load-bearing — every create door
 * must funnel through `createObject`'s containment-parent resolution or
 * `createComponentInService`'s container resolution.
 *
 * A door that resolves a parent by itself would produce a **shared object inside a domain-local
 * subtree**: no error, no leak at the moment of creation, and a silent hole the next time that object
 * is journaled. That is the M20.1 eight-door census one level up, and it is why every create door
 * that can name a container is exercised here rather than sampled.
 *
 * ## The two routes, and why both are needed
 *
 * `containment.ts` walks two parent routes, and an object can arrive under a container by either:
 *   - **`domain_id`** — resolved by `createObject` before the insert;
 *   - **`contains`** — the edge does not exist yet when `createObject` runs (it is written *after*
 *     the object), so `createComponentInService` reads the container and threads the flag in.
 *
 * Only testing the first would leave the component path — the one an operator actually uses for
 * "everything under this service is domain-local" — completely unguarded.
 */
describe("M20.5 (ADR-0031 §6a): locality is inherited at create, along both containment routes", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  /** A domain-local containment DOMAIN — route 1's container. */
  let localDomainId: string;
  /** An ordinary containment domain, the control. */
  let sharedDomainId: string;

  const uniq = (p: string) => `${p}-${randomUUID().slice(0, 8)}`;

  async function post(url: string, payload: Record<string, unknown>) {
    return server.app.inject({
      method: "POST",
      url,
      headers: { authorization: `Bearer ${org.adminToken}` },
      payload
    });
  }
  async function put(url: string, payload: Record<string, unknown>) {
    return server.app.inject({
      method: "PUT",
      url,
      headers: { authorization: `Bearer ${org.adminToken}` },
      payload
    });
  }

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "domain-local-inherit");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });

    const localDomain = await admin
      .object("domain")
      .create({ name: uniq("secure-partition"), domainLocal: true });
    localDomainId = localDomain.id;
    expect(localDomain.domainLocal).toBe(true);

    const sharedDomain = await admin.object("domain").create({ name: uniq("ordinary-grouping") });
    sharedDomainId = sharedDomain.id;
    expect(sharedDomain.domainLocal).toBe(false);
  }, 120_000);

  afterAll(async () => {
    await server?.close();
  });

  // ---------------------------------------------------------------------------------------------
  // ROUTE 1 — the `domain_id` parent, across every door that accepts one.
  // ---------------------------------------------------------------------------------------------

  it("POST /objects/{type} — a child of a domain-local container is domain-local without saying so", async () => {
    const res = await post("/api/v1/objects/service", {
      name: uniq("inherited"),
      domainId: localDomainId
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).domainLocal).toBe(true);
  });

  it("POST /objects/{type} — CONTROL: the same call under an ORDINARY container stays shared", async () => {
    // Without this the inheritance test could pass by making everything domain-local, which would be
    // a far worse bug than the one it is guarding against.
    const res = await post("/api/v1/objects/service", {
      name: uniq("not-inherited"),
      domainId: sharedDomainId
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).domainLocal).toBe(false);
  });

  it("POST /{typed-registry} — the factory door inherits too", async () => {
    const res = await post("/api/v1/services", {
      name: uniq("typed-inherited"),
      domainId: localDomainId
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).domainLocal).toBe(true);
  });

  it("PUT /{typed-registry}/{urn} — the upsert CREATE branch inherits", async () => {
    const name = uniq("typed-upsert-inherited");
    const urn = `urn:scp:${org.orgId}:service:${name}`;
    const res = await put(`/api/v1/services/${encodeURIComponent(urn)}`, {
      name,
      domainId: localDomainId
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).domainLocal).toBe(true);
  });

  it("PUT /objects/{type}/{urn} — the generic upsert CREATE branch inherits", async () => {
    const name = uniq("generic-upsert-inherited");
    const urn = `urn:scp:${org.orgId}:service:${name}`;
    const res = await put(`/api/v1/objects/service/${encodeURIComponent(urn)}`, {
      name,
      domainId: localDomainId
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).domainLocal).toBe(true);
  });

  it("POST /objects/service — the LITERAL shadowing route inherits (the door M20.1's census found)", async () => {
    // This route has its own body schema and its own handler, and it silently dropped `domainLocal`
    // entirely until the M20.1 census caught it. It routes through `createServiceObject`, which calls
    // `createObject` — so inheritance reaches it for free, and this asserts that rather than assuming.
    const res = await post("/api/v1/objects/service", {
      name: uniq("shadow-inherited"),
      domainId: localDomainId
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).domainLocal).toBe(true);
  });

  // ---------------------------------------------------------------------------------------------
  // ROUTE 2 — the `contains` parent. The edge does not exist when `createObject` runs.
  // ---------------------------------------------------------------------------------------------

  it("POST /components — a component created into a domain-local SERVICE inherits", async () => {
    const service = await admin
      .object("service")
      .create({ name: uniq("local-service"), domainLocal: true });
    const res = await post("/api/v1/components", {
      name: uniq("component-of-local-service"),
      service: service.id
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).domainLocal).toBe(true);
  });

  it("PUT /components/{urn} — the component upsert CREATE branch inherits from its service", async () => {
    const service = await admin
      .object("service")
      .create({ name: uniq("local-service-2"), domainLocal: true });
    const name = uniq("component-upsert");
    const urn = `urn:scp:${org.orgId}:component:${name}`;
    const res = await put(`/api/v1/components/${encodeURIComponent(urn)}`, {
      name,
      service: service.id
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).domainLocal).toBe(true);
  });

  it("POST /components — CONTROL: a component of an ORDINARY service stays shared", async () => {
    const service = await admin.object("service").create({ name: uniq("shared-service") });
    const res = await post("/api/v1/components", {
      name: uniq("component-of-shared-service"),
      service: service.id
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).domainLocal).toBe(false);
  });

  // ---------------------------------------------------------------------------------------------
  // THE INDUCTION — the property that makes one hop sufficient.
  // ---------------------------------------------------------------------------------------------

  it("INDUCTION: a GRANDCHILD is domain-local, because the intermediate was stamped at its own create", async () => {
    // domain(local) -> service(inherits) -> component(inherits from the service).
    // This is the whole argument for reading only the immediate parent instead of walking
    // `containmentChain`. If the intermediate were NOT stamped, the grandchild would come out shared
    // and the one-hop rule would be unsound — so this test is the induction's base and step together.
    const service = await post("/api/v1/services", {
      name: uniq("intermediate"),
      domainId: localDomainId
    });
    expect(service.statusCode).toBe(201);
    const serviceObj = JSON.parse(service.body);
    expect(serviceObj.domainLocal).toBe(true); // base: the intermediate really is stamped

    const component = await post("/api/v1/components", {
      name: uniq("grandchild"),
      service: serviceObj.id
    });
    expect(component.statusCode).toBe(201);
    expect(JSON.parse(component.body).domainLocal).toBe(true); // step
  });

  // ---------------------------------------------------------------------------------------------
  // THE REFUSAL — an explicit opt-out inside a local subtree.
  // ---------------------------------------------------------------------------------------------

  it("an explicit domainLocal:false inside a domain-local container is REFUSED, not silently overridden", async () => {
    // Both silent options are worse than a 400. Honouring the `false` puts a federating object inside
    // a subtree whose whole point is staying home — its name alone can disclose what the subtree is
    // about. Quietly upgrading it to `true` means an operator who asked for a shared object got a
    // local one and was never told. A refusal at authoring time leaves nobody with a false belief.
    const res = await post("/api/v1/objects/service", {
      name: uniq("opt-out-attempt"),
      domainId: localDomainId,
      domainLocal: false
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).detail).toMatch(/inside a domain-local container/i);
  });

  it("an explicit domainLocal:false under an ORDINARY container is fine — the refusal is scoped", async () => {
    const res = await post("/api/v1/objects/service", {
      name: uniq("explicit-false-ok"),
      domainId: sharedDomainId,
      domainLocal: false
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).domainLocal).toBe(false);
  });

  it("declaring domainLocal:true under an ordinary container still works — inheritance ADDS, never restricts", async () => {
    const res = await post("/api/v1/objects/service", {
      name: uniq("declared-under-shared"),
      domainId: sharedDomainId,
      domainLocal: true
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).domainLocal).toBe(true);
  });
});
