import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ServiceBoardResponse, TrustDomainId } from "@scp/schemas";
import { withTenantTx } from "../db/tenant-tx.js";
import { bundleTransfers, federationPeers } from "../db/schema.js";
import { createObject, getObjectByIdOrUrnAnyType } from "../graph/objects-repo.js";
import { createRelationship } from "../graph/relationships-repo.js";
import { pairPeer } from "../federation/peers-repo.js";
import { recordBundleTransfer } from "../federation/bundle-transfers-repo.js";
import {
  buildTestServer,
  createTestOrg,
  type TestOrg,
  type TestServer
} from "../test-support/harness.js";
import { buildServiceBoard } from "./service-board.js";

/**
 * DESIGN.md §13's OTHER honesty requirement, the one the board never satisfied: *"the commander UI
 * labels air-gapped domains \"as of &lt;bundle/date&gt;\" and never presents stale data as live
 * status."*
 *
 * Everything the board already says is about what it CAN SEE. Nothing said WHEN what it can see
 * arrived. A board rendering commander-driven changes on an outpost whose last successful sync was
 * three days ago looked byte-identical to one that synced four seconds ago — and the second half of
 * §13's sentence is a general ban, not a commander-only one.
 *
 * WHAT THIS PINS:
 *  1. the `asOf` label exists and names the LIMITING peer, with the transport it arrived over;
 *  2. an upstream WITHIN its own effective cadence produces NO caveat (the negative half — an
 *     always-on caveat is as dishonest as no caveat, and would train operators to ignore it);
 *  3. an upstream OVERDUE by that same cadence produces one, naming the same two board-level fields
 *     the blindness rule names, because it is the same two claims that stop being current;
 *  4. a peer this instance never dials (no baseUrl — the air-gap case §13 is actually about) gets
 *     the LABEL and `stale: null`, never a fabricated `false`.
 *
 * The peer is paired at FULL scope throughout, so the change-blindness arms are silent by
 * construction: any `summary.stable` caveat below can only have come from staleness.
 */
describe("service board staleness: an upstream is labelled, and an overdue one is not passed off as live", () => {
  let server: TestServer;
  let org: TestOrg;
  let serviceId: string;
  const peerDomainId = randomUUID() as TrustDomainId;

  const board = async (): Promise<ServiceBoardResponse> =>
    withTenantTx(server.deps.db, org.orgId, async (tx) =>
      buildServiceBoard(tx, org.orgId, await getObjectByIdOrUrnAnyType(tx, org.orgId, serviceId))
    );

  /** Move the (single) confirmed inbound sync transfer's clock — the freshness anchor. */
  const setLastImportAge = async (seconds: number): Promise<void> => {
    const at = new Date(Date.now() - seconds * 1000);
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .update(bundleTransfers)
        .set({ confirmedAt: at, createdAt: at })
        .where(
          and(eq(bundleTransfers.orgId, org.orgId), eq(bundleTransfers.peerDomainId, peerDomainId))
        )
    );
  };

  beforeAll(async () => {
    server = await buildTestServer();
    org = await createTestOrg(server, "board-staleness");

    serviceId = await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const service = await createObject(tx, {
        orgId: org.orgId,
        domainId: null,
        typeId: "service",
        actorObjectId: org.orgId,
        requestId: "staleness-service",
        name: `billing-api-${randomUUID().slice(0, 8)}`
      });
      const component = await createObject(tx, {
        orgId: org.orgId,
        domainId: null,
        typeId: "component",
        actorObjectId: org.orgId,
        requestId: "staleness-component",
        name: `billing-web-${randomUUID().slice(0, 8)}`
      });
      await createRelationship(tx, {
        orgId: org.orgId,
        actorObjectId: org.orgId,
        requestId: "staleness-contains",
        typeId: "contains",
        fromId: service.id,
        toId: component.id
      });
      return service.id;
    });
  }, 120_000);

  afterAll(async () => {
    await server.close();
  });

  it("the freshness anchor has an index that matches it — this runs per peer on every render", async () => {
    // `lastConfirmedSyncImportAt` orders by `confirmed_at DESC LIMIT 1` on a ledger that only ever
    // grows (no pruning, by design). The pre-existing `(org_id, peer_domain_id, created_at)` index
    // cannot serve that ordering. Asserted against the catalog rather than an EXPLAIN because a
    // planner on a near-empty test table will pick a seq scan regardless — what is checkable, and
    // what actually regressed, is whether drizzle/0041's index is there and matches the predicate.
    const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.execute(
        sql`select indexdef from pg_indexes where tablename = 'bundle_transfers' and indexname = 'bundle_transfers_org_peer_confirmed'`
      )
    );
    const def = String((rows.rows[0] as { indexdef?: string } | undefined)?.indexdef ?? "");
    expect(def, "drizzle/0041's partial index must exist").not.toBe("");
    expect(def).toMatch(/confirmed_at DESC/);
    expect(def).toMatch(/WHERE .*direction = 'import'/);
    expect(def).toMatch(/kind = 'sync'/);
    expect(def).toMatch(/status = 'confirmed'/);
  });

  it("a SINGLE-DOMAIN org claims no as-of at all — its board is a complete local observation", async () => {
    const result = await board();
    expect(result.asOf).toBeNull();
    expect(result.unknownFields).toEqual([]);
  });

  it("a CONNECTED peer within its own cadence: labelled, and NOT caveated", async () => {
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      pairPeer(tx, {
        orgId: org.orgId,
        domainId: peerDomainId,
        name: "commander-1",
        role: "commander",
        baseUrl: "https://commander.example",
        publicKey: "unused-for-this-projection"
      })
    );
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      recordBundleTransfer(tx, {
        orgId: org.orgId,
        peerDomainId,
        direction: "import",
        kind: "sync",
        status: "confirmed",
        sinceSequence: 0,
        throughSequence: 4,
        transport: "bundle",
        channel: "metadata"
      })
    );
    await setLastImportAge(5);

    const result = await board();
    expect(result.asOf).not.toBeNull();
    expect(result.asOf!.peerDomainId).toBe(peerDomainId);
    expect(result.asOf!.peerName).toBe("commander-1");
    expect(result.asOf!.at).not.toBeNull();
    // The transport is READ off the transfer row (drizzle/0041), never inferred from the pull
    // timestamps — that inference reported every real live pull as a bundle import.
    expect(result.asOf!.via).toBe("bundle");
    expect(result.asOf!.expectedWithinSeconds).toBe(60);
    expect(result.asOf!.stale).toBe(false);

    // THE NEGATIVE HALF. A caveat that is always on is exactly as useless as no caveat: it teaches
    // an operator to ignore the one signal that matters. Freeze visibility is unobservable the
    // moment a peer exists (freezes never ride the journal), but nothing about CHANGE visibility is.
    expect(result.unknownFields).not.toContain("summary.stable");
    expect(result.unknownFields).not.toContain("rows[].latestChangeId");
    expect(result.unknownFields).toContain("rows[].activeFreeze");
  });

  it("GRACE: past the raw interval but inside one missed cycle is NOT stale — no per-cycle shouting", async () => {
    // 90s on a 60s cadence. The due-gate only admits the next pull once a full interval has elapsed
    // since the last ATTEMPT, and the anchor is stamped when the import CONFIRMS, so a perfectly
    // healthy peer crosses 60s of age on EVERY cycle. Using the cadence verbatim made this board
    // caveat itself once a minute, forever, on a working system.
    await setLastImportAge(90);
    const result = await board();
    expect(result.asOf!.ageSeconds).toBeGreaterThanOrEqual(90);
    expect(result.asOf!.expectedWithinSeconds).toBe(60);
    expect(result.asOf!.stale).toBe(false);
    expect(result.unknownFields).not.toContain("summary.stable");
  });

  it("a transfer recorded before the transport column reads `unknown` — never a guessed transport", async () => {
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .update(bundleTransfers)
        .set({ transport: null })
        .where(
          and(eq(bundleTransfers.orgId, org.orgId), eq(bundleTransfers.peerDomainId, peerDomainId))
        )
    );
    expect((await board()).asOf!.via).toBe("unknown");

    // Restore — the cases below assert the bundle attribution.
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .update(bundleTransfers)
        .set({ transport: "bundle" })
        .where(
          and(eq(bundleTransfers.orgId, org.orgId), eq(bundleTransfers.peerDomainId, peerDomainId))
        )
    );
  });

  it("OVERDUE by its own cadence: the board stops presenting the count as an observation", async () => {
    await setLastImportAge(3600);

    const result = await board();
    expect(result.asOf!.stale).toBe(true);
    expect(result.asOf!.ageSeconds).toBeGreaterThanOrEqual(3600);
    expect(result.asOf!.expectedWithinSeconds).toBe(60);

    // The same two claims the blindness rule retracts, for the same reason: a newer change may
    // already exist upstream that this instance has simply not been sent yet.
    expect(result.unknownFields).toContain("summary.stable");
    expect(result.unknownFields).toContain("rows[].latestChangeId");
    // Named once, even though a board can be both blind and stale.
    expect(result.unknownFields).toEqual([...new Set(result.unknownFields)]);

    // The counts are still emitted for shape stability — which is precisely why declaring them
    // unobservable, rather than silently re-bucketing, is the honest move.
    const s = result.summary;
    expect(s.releasing + s.blocked + s.stable + s.notDrivenHere).toBe(result.rows.length);
  });

  it("an AIR-GAPPED peer gets the §13 LABEL and `stale: null` — never a fabricated `false`", async () => {
    // The air-gap shape: no baseUrl, so this instance schedules no pulls for it and the live-pull
    // columns stay NULL forever. Its state IS a week old; that is not a fault, and there is no
    // cadence for it to be late against.
    //
    // Written directly rather than through `pairPeer`, deliberately: `pairPeer`'s update path is
    // `baseUrl: input.baseUrl ?? existing.baseUrl`, so a re-pair can never CLEAR a baseUrl. Going
    // through the repo here would silently leave the connected URL in place and quietly turn this
    // into a second copy of the previous case.
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .update(federationPeers)
        .set({ baseUrl: null })
        .where(and(eq(federationPeers.orgId, org.orgId), eq(federationPeers.id, peerDomainId)))
    );
    await setLastImportAge(7 * 86_400);

    const result = await board();
    expect(result.asOf!.via).toBe("bundle");
    expect(result.asOf!.at).not.toBeNull();
    expect(result.asOf!.expectedWithinSeconds).toBeNull();
    expect(result.asOf!.stale).toBeNull();
    // `null` is NOT "fresh", and it is not "stale" either — so it must not drive the change-visibility
    // caveat. The label itself is the whole guarantee §13 grants here, and it is present above.
    expect(result.unknownFields).not.toContain("summary.stable");
  });

  it("a scheduled peer that has NEVER delivered anything is not `stale: false`, even brand new", async () => {
    // Restore the dialled shape and un-confirm every transfer: a peer this instance polls, from
    // which nothing has ever landed. Un-confirmed rather than deleted because the transfer ledger is
    // append-only for the runtime role (no DELETE grant) — and `lastConfirmedSyncImportAt` keys on
    // `status = 'confirmed'`, so this is the same state a peer that never delivered would be in.
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .update(federationPeers)
        .set({ baseUrl: "https://commander.example", pairedAt: new Date() })
        .where(and(eq(federationPeers.orgId, org.orgId), eq(federationPeers.id, peerDomainId)))
    );
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .update(bundleTransfers)
        .set({ status: "created", confirmedAt: null })
        .where(
          and(eq(bundleTransfers.orgId, org.orgId), eq(bundleTransfers.peerDomainId, peerDomainId))
        )
    );

    const result = await board();
    expect(result.asOf!.via).toBe("never");
    expect(result.asOf!.at).toBeNull();
    // Paired seconds ago, so nothing is overdue BY THE CLOCK — which is exactly how this used to
    // report `stale: false`. Freshness is a claim about DELIVERED data, and none has been delivered.
    expect(result.asOf!.ageSeconds).toBeLessThan(60);
    expect(result.asOf!.stale).toBe(true);
    expect(result.unknownFields).toContain("summary.stable");
  });
});

/**
 * THE MASKING CASE — the defect the previous pass introduced while fixing a different one.
 *
 * `limitingUpstreamFreshness` was corrected to return the OLDEST reading (so a barely-late connected
 * peer could no longer mask an ancient air-gapped one in the LABEL). But the board then derived its
 * staleness caveat from that single returned reading's own `stale`, and the oldest reading is very
 * often the air-gapped one — whose `stale` is `null` by design, because no cadence applies to it.
 * Result: a peer that is genuinely, badly overdue lost its caveat entirely, in exactly the incident
 * the caveat exists to catch.
 *
 * TWO PEERS, both at FULL scope so neither blindness arm can fire:
 *   A — a commander on the 60s cadence whose last import confirmed an HOUR ago  → `stale: true`.
 *   B — air-gapped (no baseUrl), 21 days old                                    → `stale: null`,
 *       and OLDER, so it wins the label.
 * The label must still be B (the true freshness bound) AND the caveat must still fire for A.
 */
describe("service board staleness: an overdue peer is not masked by an older one that has no cadence", () => {
  let server: TestServer;
  let org: TestOrg;
  let serviceId: string;
  const overduePeerId = randomUUID() as TrustDomainId;
  const airGappedPeerId = randomUUID() as TrustDomainId;

  const seedPeer = async (args: {
    peerDomainId: TrustDomainId;
    name: string;
    baseUrl: string | null;
    ageSeconds: number;
  }): Promise<void> => {
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      pairPeer(tx, {
        orgId: org.orgId,
        domainId: args.peerDomainId,
        name: args.name,
        role: "commander",
        // `pairPeer` cannot CLEAR a baseUrl (`input.baseUrl ?? existing.baseUrl`), so the air-gapped
        // peer is paired without one from the start rather than cleared afterwards.
        ...(args.baseUrl ? { baseUrl: args.baseUrl } : {}),
        publicKey: "unused-for-this-projection"
      })
    );
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      recordBundleTransfer(tx, {
        orgId: org.orgId,
        peerDomainId: args.peerDomainId,
        direction: "import",
        kind: "sync",
        status: "confirmed",
        sinceSequence: 0,
        throughSequence: 4,
        transport: "bundle",
        channel: "metadata"
      })
    );
    const at = new Date(Date.now() - args.ageSeconds * 1000);
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .update(bundleTransfers)
        .set({ confirmedAt: at, createdAt: at })
        .where(
          and(
            eq(bundleTransfers.orgId, org.orgId),
            eq(bundleTransfers.peerDomainId, args.peerDomainId)
          )
        )
    );
  };

  beforeAll(async () => {
    server = await buildTestServer();
    org = await createTestOrg(server, "board-staleness-mask");

    serviceId = await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const service = await createObject(tx, {
        orgId: org.orgId,
        domainId: null,
        typeId: "service",
        actorObjectId: org.orgId,
        requestId: "mask-service",
        name: `masking-api-${randomUUID().slice(0, 8)}`
      });
      const component = await createObject(tx, {
        orgId: org.orgId,
        domainId: null,
        typeId: "component",
        actorObjectId: org.orgId,
        requestId: "mask-component",
        name: `masking-web-${randomUUID().slice(0, 8)}`
      });
      await createRelationship(tx, {
        orgId: org.orgId,
        actorObjectId: org.orgId,
        requestId: "mask-contains",
        typeId: "contains",
        fromId: service.id,
        toId: component.id
      });
      return service.id;
    });

    await seedPeer({
      peerDomainId: overduePeerId,
      name: "commander-overdue",
      baseUrl: "https://commander.example",
      ageSeconds: 3600
    });
    await seedPeer({
      peerDomainId: airGappedPeerId,
      name: "outpost-airgapped",
      baseUrl: null,
      ageSeconds: 21 * 86_400
    });
  }, 120_000);

  afterAll(async () => {
    await server.close();
  });

  it("REGRESSION: the label is the true oldest bound, AND the overdue peer still gets its caveat", async () => {
    const result = await withTenantTx(server.deps.db, org.orgId, async (tx) =>
      buildServiceBoard(tx, org.orgId, await getObjectByIdOrUrnAnyType(tx, org.orgId, serviceId))
    );

    // The premise: the OLDEST peer is the one with no cadence, so its own `stale` is null.
    expect(result.asOf!.peerDomainId).toBe(airGappedPeerId);
    expect(result.asOf!.expectedWithinSeconds).toBeNull();
    expect(result.asOf!.stale).toBeNull();

    // ...and the caveat fires anyway, because a DIFFERENT peer is overdue. Reading it off the label
    // above (`asOf.stale === true`) yielded an empty caveat here — a confident `stable` count over a
    // commander that has been silent for an hour.
    expect(result.unknownFields).toContain("summary.stable");
    expect(result.unknownFields).toContain("rows[].latestChangeId");
  });
});
