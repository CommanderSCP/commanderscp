import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
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
        throughSequence: 4
      })
    );
    await setLastImportAge(5);

    const result = await board();
    expect(result.asOf).not.toBeNull();
    expect(result.asOf!.peerDomainId).toBe(peerDomainId);
    expect(result.asOf!.peerName).toBe("commander-1");
    expect(result.asOf!.at).not.toBeNull();
    // No live pull ever stamped `lastPullSuccessAt`, so this bundle is correctly attributed to the
    // file/push/inbox path rather than to a pull that never happened.
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
});
