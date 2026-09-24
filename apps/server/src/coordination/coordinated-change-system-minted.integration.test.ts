import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import {
  createTestOrg,
  createTestUser,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg,
  type TestUser
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { objects } from "../db/schema.js";
import { SYSTEM_MINTED_OBJECT_TYPE_IDS } from "../graph/system-minted-types.js";

/** CENSUS INSTANCE 8.6 — the correlation GROUP could be pre-seeded by its own subject.
 *
 *  `coordination/correlation.ts`'s `linkToCoordinatedChange` finds a group by
 *  `labels ->> 'correlationKey'` or mints one. `labels` is tenant-writable at `object:write`, and
 *  `coordinated-change` had no door refusing it — so an `object:write` holder could mint a
 *  `coordinated-change` carrying a chosen key and the next real correlation would link into THEIR
 *  object. Same property as ADR-0034's, one subsystem over: a decision keyed on something its own
 *  subject can write. */

describe("a coordinated-change is system-minted (Testcontainers)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  /** `object:write` + `relationship:write` at the org root — the attacker in 8.6, and an ordinary
   *  role rather than a contrived one. */
  let operator: TestUser;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "sys-minted");
    operator = await createTestUser(server, org, [{ role: "Operator", scope: org.orgId }]);
  }, 180_000);

  afterAll(async () => {
    await server?.close();
  });

  async function rowsOfType(typeId: string) {
    return withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select({ id: objects.id, labels: objects.labels })
        .from(objects)
        .where(
          and(eq(objects.orgId, org.orgId), eq(objects.typeId, typeId), isNull(objects.deletedAt))
        )
    );
  }

  it("THE CAPTURE: an Operator cannot pre-seed a group carrying a chosen correlationKey", async () => {
    const key = `captured-${randomUUID().slice(0, 8)}`;
    const res = await server.app.inject({
      method: "POST",
      url: "/api/v1/objects/coordinated-change",
      headers: { authorization: `Bearer ${operator.token}` },
      payload: { name: `Coordinated: ${key}`, labels: { correlationKey: key } }
    });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.body).toMatch(/system-minted/);
    // ...and nothing was written, so the lookup cannot find it later either.
    expect(await rowsOfType("coordinated-change")).toEqual([]);
  });

  it("every write verb of /objects/{type} refuses it, not just POST", async () => {
    const cases: Array<{ method: "POST" | "PATCH" | "PUT" | "DELETE"; url: string }> = [
      { method: "POST", url: "/api/v1/objects/coordinated-change" },
      { method: "PATCH", url: `/api/v1/objects/coordinated-change/${randomUUID()}` },
      { method: "PUT", url: "/api/v1/objects/coordinated-change/urn:scp:x:coordinated-change:y" },
      { method: "DELETE", url: `/api/v1/objects/coordinated-change/${randomUUID()}` }
    ];
    for (const c of cases) {
      const res = await server.app.inject({
        method: c.method,
        url: c.url,
        headers: { authorization: `Bearer ${operator.token}` },
        payload: c.method === "DELETE" ? undefined : { name: "by-hand", labels: {} }
      });
      expect(res.statusCode, `${c.method} ${c.url}: ${res.body}`).toBe(403);
      expect(res.body).toMatch(/system-minted/);
    }
  });

  it("NEGATIVE CONTROL: the same door still accepts an ordinary type from the same caller", async () => {
    // Without this, the refusals above are equally satisfied by a door that refuses everything, or
    // by an Operator whose token simply does not work.
    // `execution-system`, not `component`: the generic door refuses a component for an unrelated
    // reason (it must belong to a service), so using one would have made this control pass on the
    // wrong refusal — it did, on the first run. NO properties: an execution system's properties
    // need `secret:write` (ADR-0056 addendum 3), which an Operator does not hold.
    const res = await server.app.inject({
      method: "POST",
      url: "/api/v1/objects/execution-system",
      headers: { authorization: `Bearer ${operator.token}` },
      payload: { name: `ordinary-${randomUUID().slice(0, 8)}` }
    });
    expect(res.statusCode, res.body).toBe(201);
  });

  it("the refusal names a DIFFERENT rule from the governance-managed one", async () => {
    // The two refusals mean different things: governance-managed routes you to a typed door,
    // system-minted says there is no door. Collapsing them would send an operator looking for a
    // `/api/v1/coordinated-changes` route that does not and should not exist.
    const res = await server.app.inject({
      method: "POST",
      url: "/api/v1/objects/coordinated-change",
      headers: { authorization: `Bearer ${operator.token}` },
      payload: { name: "x", labels: {} }
    });
    expect(res.body).not.toMatch(/governance-managed/);
    expect(res.body).toMatch(/no door for creating/);
  });

  it("the set is non-empty and names the type the correlation lookup actually reads", () => {
    expect(SYSTEM_MINTED_OBJECT_TYPE_IDS.size).toBeGreaterThan(0);
    expect(SYSTEM_MINTED_OBJECT_TYPE_IDS.has("coordinated-change")).toBe(true);
  });
});
