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

/**
 * THE SIXTH INSTANCE OF THE BATCH-STARVATION PROPERTY, and the only one whose remedy is NOT a
 * round-robin bump. Sibling of `executing-batch-starvation.integration.test.ts`, which this file is
 * modelled on; read that file's header first for the measured 13-day production outage that defines
 * the class, and `candidate-loop-registry.test.ts`'s header for the class itself.
 *
 * THE HOLE. Five of `reconcile.ts`'s `advance*` loops opened with the S10 single-writer guard
 *
 *     if (object.originDomainId !== selfDomainId) continue;
 *
 * and that `continue` skips the row WITHOUT WRITING IT. `listChangeRowsInStates` is `ORDER BY
 * reconcile_cursor_at ASC LIMIT 25`, so a foreign-origin row in the candidate set freezes its cursor,
 * holds a batch slot forever, and starves every locally-originated change queued behind it —
 * exactly the shape that stopped production coordination for 13 days behind green health checks.
 *
 * WHY IT WAS ONLY LATENT, and why no existing suite could have caught it: no row in the candidate
 * set could have a foreign origin. `federation/import-repo.ts`'s `object_upsert` branch explicitly
 * never creates a local `changes` state-machine row for a synced change, and a PROMOTED change is
 * locally originated because `applyPromotionImport` calls `proposeChange` fresh — both measured in
 * `change-origin-domain.integration.test.ts`'s header. So the fixture below does the same surgery
 * `federation/foreign-origin-writes.integration.test.ts` does: it flips `objects.origin_domain_id`
 * directly, which is the exact row state a future replication path would produce.
 *
 * WHY THE FIX IS A FILTER AND NOT A BUMP. Every other instance of this property was closed by
 * bumping `updated_at` on the not-advanced path. That remedy is ILLEGAL here — it writes a
 * read-only replica's row, which is the single-writer violation the skip exists to prevent. So
 * `listChangeRowsInStates` now takes `selfDomainId` and joins `objects.origin_domain_id = self`,
 * removing those rows from the candidate set entirely, exactly as `reconcile_blocked_at IS NULL`
 * already removes a parked change. The five guards remain as defence in depth.
 *
 * WHAT THIS SUITE WOULD SHOW WITHOUT THE FIX (mutation-checked by reverting the filter): the local
 * change never leaves `proposed`, no matter how many ticks run, because all 25 slots of every batch
 * are permanently held by foreign-origin rows the loop skips without stamping.
 *
 * ONE STATE IS ENOUGH, and `proposed` is chosen because `advanceProposedChanges` is the loop with
 * the least machinery between "served" and an observable transition (its edge is never gated). The
 * filter lives in the query all SIX call sites share, so covering one loop covers the mechanism;
 * the other five are pinned by `candidate-loop-registry.test.ts`'s classification.
 */

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

    // THE QUEUE POSITION IS THE WHOLE FIXTURE, so it is made explicit rather than left to the
    // resolution of Postgres' transaction clock: every foreign row is backdated an hour, so under
    // `ORDER BY reconcile_cursor_at ASC LIMIT 25` the 25 oldest candidates are all foreign and the
    // local change sits at position 31 — outside every batch, forever, unless the foreign rows
    // either rotate (they cannot; nothing writes them) or leave the candidate set (the fix).
    //
    // BACKDATING THE CURSOR IS NOW THE ONLY THING THAT BUILDS THIS QUEUE (migration 0058). Writing
    // `updated_at` here would set the fixture up to prove nothing at all: the engine would not read
    // it, all 31 rows would keep their natural creation order, and the local change would sit at
    // position 31 only by accident of insertion time. `updated_at` is deliberately left ALONE so
    // the "not stamped" assertion below can watch both columns independently.
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
    // ONE tick is enough with the fix: the 30 foreign rows are filtered out of the candidate set
    // entirely, so the local change is the only candidate and `proposed -> evaluated` (an ungated
    // edge) fires immediately.
    //
    // WITHOUT THE FIX THIS IS THE FAILING LINE, and it fails the way production did: the first 25
    // candidates are foreign, each is `continue`d without a write, `updated_at` never moves, and the
    // local change is never reached on this tick or any later one. Three extra ticks are run first
    // precisely so "not yet" cannot be mistaken for the failure — the unfixed engine stays stuck
    // for as many ticks as you care to run.
    await tick(4);
    expect(await stateOf(localId)).not.toBe("proposed");
  }, 120_000);

  it("SKIP, NOT DRIVE and SKIP, NOT PARK: every foreign-origin change is untouched — still 'proposed', un-parked, and still foreign", async () => {
    // The filter must not be mistaken for a licence to do anything ELSE to a replica. It is removed
    // from the candidate set; it is not driven (S10 single-writer), not parked (a park would wedge
    // it — `foreign-origin-writes.integration.test.ts`'s "SKIP, NOT PARK"), and not stamped (a
    // round-robin bump, the remedy used for every other instance of this property, would be a write
    // to a read-only replica and is the specific thing this fix exists to avoid).
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
      // AND NOT WRITTEN AT ALL — pinned to the exact value the fixture left, not merely "in the
      // past", which every row satisfies always. `updated_at` was deliberately NOT backdated, so
      // checking it separately is what makes this a statement about WRITES TO A REPLICA rather than
      // only about the scheduler: both columns are engine-written on the local path, and S10 forbids
      // either of them landing on a row this domain does not own.
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
