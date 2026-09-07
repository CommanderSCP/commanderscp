import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { asTrustDomainId } from "@scp/schemas";
import {
  buildTestServer,
  createTestOrg,
  type TestOrg,
  type TestServer
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { changes, objects } from "../db/schema.js";
import { CountingCelSandbox } from "./test-support/counting-cel-sandbox.js";
import { createInMemoryFakeHost } from "./test-support/fake-plugin-host.js";
import type { PluginHost } from "../plugin-host/contract.js";
import { proposeChange } from "./changes-repo.js";
import { reconcileOrgTick } from "./reconcile.js";
import { ensureFederationSelf } from "../federation/self-repo.js";

/** The sixth starvation instance, and the odd remedy out. See docs/coordination.md §473. */

/** `BATCH_LIMIT` in reconcile.ts. Not exported — pinned here, and asserted against FOREIGN_COUNT
 *  below so raising the real one fails loudly instead of silently shrinking this suite's coverage. */
const ASSUMED_BATCH_LIMIT = 25;
/** Comfortably over the limit: enough foreign-origin rows to own every batch slot with room to
 *  spare, so the local change behind them can only ever be served if they leave the candidate set. */
const FOREIGN_COUNT = 30;

describe("foreign-origin batch starvation: >BATCH_LIMIT replica changes must not own the candidate set", () => {
  let server: TestServer;
  let org: TestOrg;
  let sandbox: CountingCelSandbox;
  let host: PluginHost;
  /** A domain id that is emphatically NOT this instance's own `federation_self.domain_id`. */
  const FOREIGN = asTrustDomainId(randomUUID());

  beforeAll(async () => {
    server = await buildTestServer();
    org = await createTestOrg(server, "foreign-origin-starvation");
    sandbox = new CountingCelSandbox();
    // Nothing in this suite is meant to terminalize; a long auto-succeed keeps any change that does
    // get driven durably in flight rather than completing and freeing a slot mid-assertion.
    host = createInMemoryFakeHost({ autoSucceedAfterMs: 60 * 60_000 });
  }, 120_000);

  afterAll(async () => {
    await sandbox.stop();
    await server?.close();
  });

  async function inject(url: string, payload: Record<string, unknown>) {
    const res = await server.app.inject({
      method: "POST",
      url,
      headers: { authorization: `Bearer ${org.adminToken}` },
      payload
    });
    if (res.statusCode >= 300) throw new Error(`POST ${url} -> ${res.statusCode} ${res.body}`);
    return res.json() as Record<string, unknown>;
  }

  /** One component, shared by every change in this suite — `proposeChange` puts no uniqueness
   *  constraint on targets, and the property under test is about the candidate QUEUE, not about
   *  what any change targets. Keeps a 31-change fixture cheap. */
  let componentId: string;

  /** A change in `proposed`, created in its own transaction so its `reconcile_cursor_at` (which
   *  defaults to `now()`, i.e. Postgres transaction time) is strictly ordered against its
   *  siblings'. */
  async function propose(label: string): Promise<string> {
    return withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const { change } = await proposeChange(tx, {
        orgId: org.orgId,
        actorObjectId: org.orgId,
        requestId: "foreign-origin-starvation",
        name: `change-${label}`,
        targets: [componentId]
      });
      return change.id;
    });
  }

  async function tick(times: number): Promise<void> {
    for (let i = 0; i < times; i++) {
      await reconcileOrgTick(
        server.deps.db,
        org.orgId,
        host,
        sandbox,
        server.deps.config.secretsMasterKey
      );
    }
  }

  async function stateOf(changeObjectId: string): Promise<string> {
    const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select({ state: changes.state })
        .from(changes)
        .where(and(eq(changes.orgId, org.orgId), eq(changes.objectId, changeObjectId)))
    );
    return rows[0]!.state;
  }

  const foreignIds: string[] = [];
  let localId: string;
  /** Each foreign row's `updated_at` as the fixture left it. Captured so the "not stamped" arm can
   *  assert EQUALITY rather than "is in the past" — the latter is true of every row in the table at
   *  every instant, so it would pass on an engine that stamped replicas on every single tick. */
  const foreignUpdatedAt = new Map<string, number>();

  it(`builds ${FOREIGN_COUNT} foreign-origin changes ahead of ONE locally-originated change (fixture)`, async () => {
    const service = await inject("/api/v1/services", { name: "svc-starve" });
    const component = await inject("/api/v1/components", {
      name: "comp-starve",
      service: service.id
    });
    componentId = component.id as string;

    for (let i = 0; i < FOREIGN_COUNT; i++) {
      foreignIds.push(await propose(`f${String(i).padStart(2, "0")}`));
    }
    localId = await propose("local");

    expect(foreignIds).toHaveLength(FOREIGN_COUNT);
    expect(FOREIGN_COUNT).toBeGreaterThan(ASSUMED_BATCH_LIMIT);

    // THE SURGERY. `foreign-origin-writes.integration.test.ts` uses the same statement; it is the
    // row state a replication path that DID create a local `changes` row would produce.
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .update(objects)
        .set({ originDomainId: FOREIGN })
        .where(and(eq(objects.orgId, org.orgId), inArray(objects.id, foreignIds)))
    );

    // ...and it is genuinely foreign: not this instance's own federation identity.
    const self = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      ensureFederationSelf(tx, org.orgId)
    );
    expect(FOREIGN).not.toBe(self.domainId);
    const origins = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .selectDistinct({ origin: objects.originDomainId })
        .from(objects)
        .where(and(eq(objects.orgId, org.orgId), inArray(objects.id, foreignIds)))
    );
    expect(origins.map((o) => o.origin)).toEqual([FOREIGN]);
    expect(
      (
        await withTenantTx(server.deps.db, org.orgId, (tx) =>
          tx
            .select({ origin: objects.originDomainId })
            .from(objects)
            .where(and(eq(objects.orgId, org.orgId), eq(objects.id, localId)))
        )
      )[0]!.origin
    ).toBe(self.domainId);

    // The queue position is the whole fixture, made explicit. See docs/coordination.md §474.
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .update(changes)
        .set({ reconcileCursorAt: new Date(Date.now() - 60 * 60_000) })
        .where(and(eq(changes.orgId, org.orgId), inArray(changes.objectId, foreignIds)))
    );

    for (const id of [...foreignIds, localId]) expect(await stateOf(id)).toBe("proposed");

    const before = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select({ objectId: changes.objectId, updatedAt: changes.updatedAt })
        .from(changes)
        .where(and(eq(changes.orgId, org.orgId), inArray(changes.objectId, foreignIds)))
    );
    for (const row of before) foreignUpdatedAt.set(row.objectId, row.updatedAt.getTime());
    expect(foreignUpdatedAt.size).toBe(FOREIGN_COUNT);
  }, 300_000);

  it("THE REGRESSION: the locally-originated change behind them IS served", async () => {
    // ONE tick is enough with the fix. See docs/coordination.md §475.
    await tick(4);
    expect(await stateOf(localId)).not.toBe("proposed");
  }, 120_000);

  it("SKIP, NOT DRIVE and SKIP, NOT PARK: every foreign-origin change is untouched — still 'proposed', un-parked, and still foreign", async () => {
    // The filter is not a licence for anything else. See docs/coordination.md §476.
    const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select({
          objectId: changes.objectId,
          state: changes.state,
          blockedAt: changes.reconcileBlockedAt,
          updatedAt: changes.updatedAt,
          cursorAt: changes.reconcileCursorAt,
          origin: objects.originDomainId
        })
        .from(changes)
        .innerJoin(objects, eq(changes.objectId, objects.id))
        .where(and(eq(changes.orgId, org.orgId), inArray(changes.objectId, foreignIds)))
    );

    expect(rows).toHaveLength(FOREIGN_COUNT);
    const hourAgoish = Date.now() - 30 * 60_000;
    for (const row of rows) {
      expect(row.state).toBe("proposed");
      expect(row.blockedAt).toBeNull();
      expect(row.origin).toBe(FOREIGN);
      // NOT BUMPED. The fixture backdated the cursor an hour; if any tick had stamped one, it
      // would now be within the last few seconds.
      expect(row.cursorAt.getTime()).toBeLessThan(hourAgoish);
      // AND NOT WRITTEN AT ALL. See docs/coordination.md §477.
      expect(row.updatedAt.getTime()).toBe(foreignUpdatedAt.get(row.objectId));
    }
  }, 120_000);

  it("AUTHORITY RETURNS and they rejoin the queue on their own — the filter is not a park", async () => {
    // The other half of "SKIP, NOT PARK", at batch scale: nothing was written to these rows, so
    // handing authority back is the ONLY intervention needed. No park to clear, no re-propose.
    const self = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      ensureFederationSelf(tx, org.orgId)
    );
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .update(objects)
        .set({ originDomainId: self.domainId })
        .where(and(eq(objects.orgId, org.orgId), inArray(objects.id, foreignIds)))
    );

    // 30 rows against a BATCH_LIMIT of 25, so two ticks are needed even in the healthy case — which
    // is itself the round-robin working: `advanceProposedChanges` transitions every row it serves,
    // so each tick's 25 leave the `proposed` candidate set and the rest lead the next batch.
    await tick(2);

    const stillProposed: string[] = [];
    for (const id of foreignIds) if ((await stateOf(id)) === "proposed") stillProposed.push(id);
    expect(stillProposed).toEqual([]);
  }, 120_000);
});
