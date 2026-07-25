import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import type { ServiceBoardResponse } from "@scp/schemas";
import { withTenantTx } from "../db/tenant-tx.js";
import { changeWaves } from "../db/schema.js";
import { createObject, getObjectByIdOrUrnAnyType } from "../graph/objects-repo.js";
import { createRelationship } from "../graph/relationships-repo.js";
import { ensureInstanceKey } from "../governance/attestation.js";
import { ensureFederationSelf, type FederationSelf } from "../federation/self-repo.js";
import { pairPeer } from "../federation/peers-repo.js";
import { exportSyncBundle } from "../federation/export-repo.js";
import { importSyncBundle } from "../federation/import-repo.js";
import {
  createIsolatedDomain,
  type IsolatedDomain
} from "../federation/test-support/isolated-domain.js";
import { proposeChange } from "./changes-repo.js";
import { compileAndPersistPlan } from "./plan-service.js";
import { buildServiceBoard } from "./service-board.js";

/**
 * REGRESSION, THE OTHER DIRECTION. `service-board-federation.integration.test.ts` pins that an
 * honest UNKNOWN must not be reported as a comforting `stable`. This file pins the converse, which
 * is the SAME defect with the arrow reversed: an honest unknown must never DISPLACE a real
 * observation.
 *
 * THE DEFECT, reproduced on the repo's two-database federation topology: an outpost drives its OWN
 * change against one of its components, compiles a plan, and a wave FAILS — the one operational fact
 * that outpost genuinely holds. A commander-origin change then replicates in, targeting the same
 * component. The board merged its two lookups by "whichever `created_at` is greater", and for a
 * REPLICA that key is FABRICATED: `objects.created_at` is `defaultNow()` at IMPORT time (the
 * `object_upsert` journal payload carries no createdAt), so every freshly imported change outranks
 * every pre-existing local one. The row flipped into the not-driven-here bucket, `summary.blocked`
 * fell to 0, and the outpost operator lost the failure their own instance had observed — replaced by
 * a row that says, correctly but uselessly, "another domain drives this and I cannot see it."
 *
 * THE FIX this pins: a STRICT FALLBACK. The planned arm — everything this domain compiled and rolled
 * itself — is authoritative for any component it covers; the declared (graph-object) arm answers
 * ONLY for components the planned arm returns nothing for. There is no cross-clock comparison left,
 * in either direction.
 *
 * The board below asserts BOTH behaviours in one response, since they must coexist: the
 * locally-driven blocked component keeps its observation, while a component whose only change is the
 * commander's is still honestly reported as not driven here.
 */
describe("service board precedence: an observation outranks a replica (Testcontainers, two databases)", () => {
  let commander: IsolatedDomain;
  let outpost: IsolatedDomain;
  let selfCommander: FederationSelf;
  let selfOutpost: FederationSelf;

  let serviceId: string;
  /** Targeted by BOTH the outpost's own failed change and (later, newer) a commander change. */
  let sharedComponentId: string;
  /** Targeted ONLY by a commander change — the not-driven-here control. */
  let commanderOnlyComponentId: string;
  /**
   * Targeted by a PLAN-LESS local change AND (later, newer by import time) a commander replica.
   * Neither side compiled a plan, so arm 1 is silent and arm 2 alone decides — the case where the
   * fabricated ordering key still applied after the arm-1/arm-2 fallback landed.
   */
  let contestedComponentId: string;
  let contestedLocalChangeId: string;
  let localChangeId: string;
  let replicaChangeId: string;

  let outpostBoard: ServiceBoardResponse;

  const syncToOutpost = async (): Promise<void> => {
    const bundle = await withTenantTx(commander.db, commander.orgId, (tx) =>
      exportSyncBundle(tx, commander.orgId, outpost.orgName)
    );
    await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      importSyncBundle(tx, outpost.orgId, bundle)
    );
  };

  beforeAll(async () => {
    commander = await createIsolatedDomain("boardPrecCommander");
    outpost = await createIsolatedDomain("boardPrecOutpost");

    selfCommander = await withTenantTx(commander.db, commander.orgId, (tx) =>
      ensureFederationSelf(tx, commander.orgId)
    );
    selfOutpost = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      ensureFederationSelf(tx, outpost.orgId)
    );

    // Real pairing, both directions, with the real exchanged Ed25519 public keys.
    const commanderKey = await withTenantTx(commander.db, commander.orgId, (tx) =>
      ensureInstanceKey(tx, commander.orgId)
    );
    await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      pairPeer(tx, {
        orgId: outpost.orgId,
        domainId: selfCommander.domainId,
        name: commander.orgName,
        role: "commander",
        publicKey: commanderKey.publicKey
      })
    );
    const outpostKey = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      ensureInstanceKey(tx, outpost.orgId)
    );
    await withTenantTx(commander.db, commander.orgId, (tx) =>
      pairPeer(tx, {
        orgId: commander.orgId,
        domainId: selfOutpost.domainId,
        name: outpost.orgName,
        role: "outpost",
        publicKey: outpostKey.publicKey
      })
    );

    // 1. The commander authors the topology (service + two components) and replicates it down.
    const seeded = await withTenantTx(commander.db, commander.orgId, async (tx) => {
      const service = await createObject(tx, {
        orgId: commander.orgId,
        domainId: null,
        typeId: "service",
        actorObjectId: commander.orgId,
        requestId: "board-prec-service",
        name: "checkout-api"
      });
      const shared = await createObject(tx, {
        orgId: commander.orgId,
        domainId: null,
        typeId: "component",
        actorObjectId: commander.orgId,
        requestId: "board-prec-shared",
        name: "checkout-web"
      });
      const commanderOnly = await createObject(tx, {
        orgId: commander.orgId,
        domainId: null,
        typeId: "component",
        actorObjectId: commander.orgId,
        requestId: "board-prec-commander-only",
        name: "checkout-worker"
      });
      const contested = await createObject(tx, {
        orgId: commander.orgId,
        domainId: null,
        typeId: "component",
        actorObjectId: commander.orgId,
        requestId: "board-prec-contested",
        name: "checkout-cache"
      });
      for (const [i, component] of [shared, commanderOnly, contested].entries()) {
        await createRelationship(tx, {
          orgId: commander.orgId,
          actorObjectId: commander.orgId,
          requestId: `board-prec-contains-${i}`,
          typeId: "contains",
          fromId: service.id,
          toId: component.id
        });
      }
      return {
        serviceId: service.id,
        sharedId: shared.id,
        commanderOnlyId: commanderOnly.id,
        contestedId: contested.id
      };
    });
    serviceId = seeded.serviceId;
    sharedComponentId = seeded.sharedId;
    commanderOnlyComponentId = seeded.commanderOnlyId;
    contestedComponentId = seeded.contestedId;
    await syncToOutpost();

    // 2. The OUTPOST drives its own change against the shared component, compiles a plan, and a wave
    //    FAILS. This is the outpost's own observation — the one thing it can genuinely see.
    localChangeId = await withTenantTx(outpost.db, outpost.orgId, async (tx) => {
      const { change } = await proposeChange(tx, {
        orgId: outpost.orgId,
        actorObjectId: outpost.orgId,
        requestId: "board-prec-local-change",
        name: "outpost hotfix",
        targets: [sharedComponentId]
      });
      const plan = await compileAndPersistPlan(tx, {
        orgId: outpost.orgId,
        changeObjectId: change.id,
        targetObjectIds: [sharedComponentId],
        topologyObjectId: null,
        topologyVersion: null
      });
      await tx
        .update(changeWaves)
        .set({ status: "failed" })
        .where(and(eq(changeWaves.orgId, outpost.orgId), eq(changeWaves.id, plan.waves[0]!.id)));
      return change.id;
    });

    // 2b. The outpost also proposes a PLAN-LESS change against the contested component. No plan is
    //     compiled, so arm 1 never sees it and arm 2 alone decides that component — but it is still
    //     a change this domain drives, with a real propose-time createdAt.
    contestedLocalChangeId = await withTenantTx(outpost.db, outpost.orgId, async (tx) => {
      const { change } = await proposeChange(tx, {
        orgId: outpost.orgId,
        actorObjectId: outpost.orgId,
        requestId: "board-prec-contested-local",
        name: "outpost cache tweak",
        targets: [contestedComponentId]
      });
      return change.id;
    });

    // 3. THEN the commander proposes changes of its own — one against the SAME component (the
    //    displacer), one against the commander-only component — and replicates both down. Both land
    //    on the outpost with an import-time `objects.created_at`, i.e. NEWER than the local change.
    replicaChangeId = await withTenantTx(commander.db, commander.orgId, async (tx) => {
      const { change } = await proposeChange(tx, {
        orgId: commander.orgId,
        actorObjectId: commander.orgId,
        requestId: "board-prec-replica-change",
        name: "commander rollout",
        targets: [sharedComponentId]
      });
      await proposeChange(tx, {
        orgId: commander.orgId,
        actorObjectId: commander.orgId,
        requestId: "board-prec-commander-only-change",
        name: "worker rollout",
        targets: [commanderOnlyComponentId]
      });
      await proposeChange(tx, {
        orgId: commander.orgId,
        actorObjectId: commander.orgId,
        requestId: "board-prec-contested-commander",
        name: "commander cache rollout",
        targets: [contestedComponentId]
      });
      return change.id;
    });
    await syncToOutpost();

    outpostBoard = await withTenantTx(outpost.db, outpost.orgId, async (tx) =>
      buildServiceBoard(
        tx,
        outpost.orgId,
        await getObjectByIdOrUrnAnyType(tx, outpost.orgId, serviceId)
      )
    );
  }, 180_000);

  afterAll(async () => {
    await commander.close();
    await outpost.close();
  });

  it("the premise: the replica really is newer BY THE KEY THE OLD MERGE COMPARED", async () => {
    const [replica, times] = await withTenantTx(outpost.db, outpost.orgId, async (tx) => {
      const replicaRow = await getObjectByIdOrUrnAnyType(tx, outpost.orgId, replicaChangeId);
      const times = await tx.execute<{ replica_at: Date | string; local_at: Date | string }>(sql`
        SELECT
          (SELECT created_at FROM objects WHERE id = ${replicaChangeId}::uuid) AS replica_at,
          (SELECT created_at FROM changes WHERE object_id = ${localChangeId}::uuid) AS local_at
      `);
      return [replicaRow, times.rows[0]!] as const;
    });

    // The replica is genuinely the commander's, holding the shared component as a target.
    expect(replica.originDomainId).toBe(selfCommander.domainId);
    expect(replica.properties.targets).toEqual([sharedComponentId]);

    // ...and its LOCAL `objects.created_at` is the IMPORT time — later than the local change's
    // `changes.created_at`. That is the fabricated ordering key the old max-by-createdAt merge used
    // to let this replica displace the outpost's own failed change.
    const replicaAt = new Date(times.replica_at as string).getTime();
    const localAt = new Date(times.local_at as string).getTime();
    expect(replicaAt).toBeGreaterThan(localAt);
  });

  it("REGRESSION: the outpost's own observed `blocked` is NOT displaced by the newer replica", () => {
    const row = outpostBoard.rows.find((r) => r.component.id === sharedComponentId);
    expect(row, "the shared component must still project a row").toBeDefined();

    // The row still reports what this instance ACTUALLY OBSERVED — asserted positively, field by
    // field, because "blocked is still 1" alone would also hold for the wrong change.
    expect(row!.latestChangeId).toBe(localChangeId);
    expect(row!.changeName).toBe("outpost hotfix");
    expect(row!.driver).toEqual({ drivenHere: true, originDomainId: null });
    expect(row!.attention.blocked).toBe(true);
    expect(row!.waves.length).toBeGreaterThan(0);
    expect(row!.waves.some((w) => w.status === "failed")).toBe(true);
    // It drives this change, so its empties are observations: nothing is declared unobservable.
    expect(row!.unknownFields).toEqual([]);

    // The count an operator scans first — the exact number the defect drove to 0.
    expect(outpostBoard.summary.blocked).toBe(1);
  });

  it("...and the ORIGINAL fix still holds in the same response: the commander-only component is not-driven-here", () => {
    const row = outpostBoard.rows.find((r) => r.component.id === commanderOnlyComponentId);
    expect(row).toBeDefined();
    expect(row!.driver).toEqual({
      drivenHere: false,
      originDomainId: selfCommander.domainId
    });
    expect(row!.changeName).toBe("worker rollout");
    expect(row!.unknownFields).toContain("attention.blocked");

    // Both behaviours in ONE board: one real local observation, one honest unknown, nothing stable.
    // Three components, three distinct honest outcomes in ONE response:
    //   shared     -> blocked        (a real local observation, arm 1)
    //   contested  -> releasing      (a real local observation, arm 2, driver class beat import time)
    //   commanderOnly -> notDrivenHere (an honest unknown)
    // Nothing is `stable`: not one component is genuinely settled, and none is claimed to be.
    expect(outpostBoard.summary).toEqual({
      releasing: 1,
      blocked: 1,
      stable: 0,
      notDrivenHere: 1
    });
    const s = outpostBoard.summary;
    expect(s.releasing + s.blocked + s.stable + s.notDrivenHere).toBe(outpostBoard.rows.length);
  });

  it("ARM 2: a plan-less LOCAL change outranks a newer replica — driver class beats import time", () => {
    // Neither domain compiled a plan for this component, so the authoritative arm-1 lookup is silent
    // and arm 2 alone decides. Both candidates sit in the SAME table, ordered by `objects.created_at`
    // — but the replica's is its IMPORT time, so it is always "newer" than a local change proposed
    // before the bundle arrived. Ranking by driver class first makes the surviving createdAt
    // comparison same-clock, so the change this domain actually drives wins.
    const row = outpostBoard.rows.find((r) => r.component.id === contestedComponentId);
    expect(row).toBeDefined();
    expect(row!.latestChangeId).toBe(contestedLocalChangeId);
    expect(row!.changeName).toBe("outpost cache tweak");
    expect(row!.driver?.drivenHere).toBe(true);
    // A driven-here row is a real observation: its state is known, so it is NOT an unknown row.
    expect(row!.unknownFields ?? []).not.toContain("changeState");
  });

  it("freeze visibility is declared board-level on a federated instance (freezes never ride the journal)", () => {
    // Freezes are a local projection that is never journaled, so a freeze declared in the commander
    // is invisible here for EVERY row — including the one the outpost drives. That is a property of
    // the deployment, not of any row's driver, so it is stated once at the response level. Without
    // it a driven-here row's `activeFreeze: null` would read as "no freeze applies".
    expect(outpostBoard.unknownFields).toEqual(
      expect.arrayContaining(["serviceFreeze", "rows[].activeFreeze"])
    );
  });
});
