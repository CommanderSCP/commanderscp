import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { ScpClient } from "@scp/sdk";
import { createTestOrg, listenTestServer } from "../test-support/harness.js";

/**
 * BUILD_AND_TEST.md §8 M1 DoD (e): "fast-check property tests: randomized PUT upsert-by-URN
 * sequences and replayed Idempotency-Key POSTs converge to identical graph state on all write
 * endpoints." One shared org (writes are independent per random URN/key, so tests don't collide)
 * with a modest `numRuns` — each run is a handful of real HTTP round trips against a real
 * Postgres, not a pure in-memory check.
 */
describe("idempotency: fast-check convergence properties", () => {
  it("PUT upsert-by-URN: replaying the final write of a random sequence is a true no-op", async () => {
    const server = await listenTestServer();
    try {
      const org = await createTestOrg(server, "idempotency-put");
      const client = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });

      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.record({
              name: fc.string({ minLength: 1, maxLength: 24 }).filter((s) => s.trim().length > 0),
              tier: fc.constantFrom("low", "mid", "high")
            }),
            { minLength: 1, maxLength: 6 }
          ),
          async (bodies) => {
            const urn = `urn:scp:${org.orgId}:service:idem-put-${randomUUID()}`;
            let last;
            for (const body of bodies) {
              last = await client.object("service").upsertByUrn(urn, { name: body.name, properties: { tier: body.tier } });
            }
            if (!last) throw new Error("unreachable: bodies is non-empty");

            const finalBody = bodies[bodies.length - 1];
            if (!finalBody) throw new Error("unreachable");

            // Replaying the exact same terminal body must not change state further, however
            // many times it's repeated.
            const replay1 = await client
              .object("service")
              .upsertByUrn(urn, { name: finalBody.name, properties: { tier: finalBody.tier } });
            const replay2 = await client
              .object("service")
              .upsertByUrn(urn, { name: finalBody.name, properties: { tier: finalBody.tier } });

            expect(replay1.version).toBe(last.version);
            expect(replay2.version).toBe(last.version);
            expect(replay1.name).toBe(finalBody.name);
            expect(replay1.properties.tier).toBe(finalBody.tier);
            expect(replay1).toEqual(replay2);

            // Fetching independently agrees with what the upserts returned (no drift between
            // the write response and subsequent reads).
            const fetched = await client.object("service").get(urn);
            expect(fetched).toEqual(replay2);
          }
        ),
        { numRuns: 15 }
      );
    } finally {
      await server.close();
    }
  });

  it("PUT upsert-by-URN: applying the same sequence to two fresh URNs is deterministic", async () => {
    const server = await listenTestServer();
    try {
      const org = await createTestOrg(server, "idempotency-put-det");
      const client = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });

      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.string({ minLength: 1, maxLength: 24 }).filter((s) => s.trim().length > 0), {
            minLength: 1,
            maxLength: 5
          }),
          async (names) => {
            const runOnce = async (urn: string) => {
              let result;
              for (const name of names) result = await client.object("service").upsertByUrn(urn, { name });
              return result;
            };
            const a = await runOnce(`urn:scp:${org.orgId}:service:idem-det-a-${randomUUID()}`);
            const b = await runOnce(`urn:scp:${org.orgId}:service:idem-det-b-${randomUUID()}`);
            expect(a?.name).toBe(b?.name);
            expect(a?.version).toBe(b?.version);
          }
        ),
        { numRuns: 15 }
      );
    } finally {
      await server.close();
    }
  });

  it("Idempotency-Key: replayed POST /objects/{type} converges — exactly one object, identical response", async () => {
    const server = await listenTestServer();
    try {
      const org = await createTestOrg(server, "idempotency-key-object");
      const client = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });

      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 1, maxLength: 24 }).filter((s) => s.trim().length > 0),
          fc.integer({ min: 2, max: 4 }),
          async (nameSuffix, replayCount) => {
            // Unique per fc *run* (not just per replay within a run): two different property
            // runs must never collide on the same auto-derived URN — that's a real, expected
            // conflict (org-scoped URN uniqueness), completely orthogonal to idempotency-key
            // replay, which is what this property is actually about.
            const name = `idem-${randomUUID()}-${nameSuffix}`;
            const idempotencyKey = randomUUID();
            const responses = [];
            for (let i = 0; i < replayCount; i++) {
              responses.push(await client.object("service").create({ name }, { idempotencyKey }));
            }
            const first = responses[0];
            for (const r of responses) expect(r).toEqual(first);

            const listed = await client.object("service").list({ limit: 100 });
            const matching = listed.items.filter((o) => o.id === first?.id);
            expect(matching).toHaveLength(1);
          }
        ),
        { numRuns: 10 }
      );
    } finally {
      await server.close();
    }
  });

  it("Idempotency-Key: replayed POST /relationships converges — exactly one relationship, identical response", async () => {
    const server = await listenTestServer();
    try {
      const org = await createTestOrg(server, "idempotency-key-rel");
      const client = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });

      await fc.assert(
        fc.asyncProperty(fc.integer({ min: 2, max: 4 }), async (replayCount) => {
          // Fresh 'from'/'to' per fc *run* — the (org, type, from, to) tuple is globally unique
          // (relationships_org_type_from_to_key), so reusing the same pair across separate
          // property runs would conflict on the run's first (non-replayed) call regardless of
          // idempotency-key behavior, which isn't what this property is testing.
          const from = await client.object("service").create({ name: `idem-rel-from-${randomUUID()}` });
          const to = await client.object("service").create({ name: `idem-rel-to-${randomUUID()}` });
          const idempotencyKey = randomUUID();
          const responses = [];
          for (let i = 0; i < replayCount; i++) {
            responses.push(
              await client.relationships.create(
                { typeId: "depends_on", fromId: from.id, toId: to.id },
                { idempotencyKey }
              )
            );
          }
          const first = responses[0];
          for (const r of responses) expect(r).toEqual(first);

          const listed = await client.relationships.list({ fromId: from.id, toId: to.id, limit: 50 });
          expect(listed.items).toHaveLength(1);
        }),
        { numRuns: 8 }
      );
    } finally {
      await server.close();
    }
  });

  it("Idempotency-Key: replayed POST /type-registry/object-types converges — one type registered", async () => {
    const server = await listenTestServer();
    try {
      const org = await createTestOrg(server, "idempotency-key-type");
      const client = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });

      await fc.assert(
        fc.asyncProperty(fc.integer({ min: 2, max: 4 }), async (replayCount) => {
          const idempotencyKey = randomUUID();
          const typeId = `idem-type-${randomUUID().slice(0, 8)}`;
          const responses = [];
          for (let i = 0; i < replayCount; i++) {
            responses.push(
              await client.typeRegistry.objectTypes.create({ id: typeId, displayName: "Idem Type" }, { idempotencyKey })
            );
          }
          const first = responses[0];
          for (const r of responses) expect(r).toEqual(first);

          // Usable immediately, exactly once registered (a second, non-idempotent create for the
          // same id must now conflict).
          await expect(
            client.typeRegistry.objectTypes.create({ id: typeId, displayName: "Different" })
          ).rejects.toThrow();
        }),
        { numRuns: 8 }
      );
    } finally {
      await server.close();
    }
  });

  it("Idempotency-Key reused with a DIFFERENT body is rejected, not silently replayed", async () => {
    const server = await listenTestServer();
    try {
      const org = await createTestOrg(server, "idempotency-key-mismatch");
      const client = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
      const idempotencyKey = randomUUID();

      await client.object("service").create({ name: "first-body" }, { idempotencyKey });
      await expect(client.object("service").create({ name: "different-body" }, { idempotencyKey })).rejects.toThrow();
    } finally {
      await server.close();
    }
  });
});
