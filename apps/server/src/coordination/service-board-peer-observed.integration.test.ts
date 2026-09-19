import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import type { ServiceBoardResponse } from "@scp/schemas";
import { withTenantTx } from "../db/tenant-tx.js";
import { changePlans, changeWaves, changeWaveTargets } from "../db/schema.js";
import { createObject, getObjectByIdOrUrnAnyType } from "../graph/objects-repo.js";
import { createRelationship } from "../graph/relationships-repo.js";
import { ensureInstanceKey } from "../governance/attestation.js";
import { ensureFederationSelf, type FederationSelf } from "../federation/self-repo.js";
import { pairPeer } from "../federation/peers-repo.js";
import { getCursor } from "../federation/cursors-repo.js";
import { exportSyncBundle } from "../federation/export-repo.js";
import { importSyncBundle } from "../federation/import-repo.js";
import { appendJournalEntry } from "../federation/journal-repo.js";
import { recordPeerObservation } from "../federation/peer-observations-repo.js";
import {
  createIsolatedDomain,
  type IsolatedDomain
} from "../federation/test-support/isolated-domain.js";
import { proposeChange } from "./changes-repo.js";
import { updateWaveTargetObserved } from "./wave-targets-repo.js";
import { buildServiceBoard } from "./service-board.js";

/**
 * THE COMMANDER'S READ SURFACE for a change driven at an outpost (pipeline-mockup-data.md D3/D4).
 *
 * Three readings have to stay apart, and this file is what keeps them apart:
 *   NOT REPORTED — `peerObserved: null` AND `peerObserved` in `unknownFields`;
 *   REPORTED STALE — present, `freshness.state === "stale"`, with the bound it was judged against;
 *   A REAL READING — present and `fresh`.
 * All three use the vocabulary the board already had (`unknownFields`, `drivenHere`,
 * `federationState`) rather than a second one.
 */
describe("service board: a peer's observations, and the three ways to have none (two databases)", () => {
  let outpost: IsolatedDomain;
  let commander: IsolatedDomain;
  let selfOutpost: FederationSelf;
  let selfCommander: FederationSelf;

  let serviceId: string;
  let componentId: string;
  let changeId: string;
  let targetId: string;

  beforeAll(async () => {
    outpost = await createIsolatedDomain("boardObsOutpost");
    commander = await createIsolatedDomain("boardObsCommander");

    selfOutpost = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      ensureFederationSelf(tx, outpost.orgId)
    );
    selfCommander = await withTenantTx(commander.db, commander.orgId, (tx) =>
      ensureFederationSelf(tx, commander.orgId)
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

    // THE OUTPOST is the driving domain here — it owns the service, the component, the change and
    // (the point) the only wave-target rows that exist anywhere.
    const seeded = await withTenantTx(outpost.db, outpost.orgId, async (tx) => {
      const service = await createObject(tx, {
        orgId: outpost.orgId,
        domainId: null,
        typeId: "service",
        actorObjectId: outpost.orgId,
        requestId: "board-obs-service",
        name: `edge-api-${randomUUID().slice(0, 6)}`
      });
      const component = await createObject(tx, {
        orgId: outpost.orgId,
        domainId: null,
        typeId: "component",
        actorObjectId: outpost.orgId,
        requestId: "board-obs-component",
        name: `edge-web-${randomUUID().slice(0, 6)}`
      });
      await createRelationship(tx, {
        orgId: outpost.orgId,
        actorObjectId: outpost.orgId,
        requestId: "board-obs-contains",
        typeId: "contains",
        fromId: service.id,
        toId: component.id
      });
      const { change } = await proposeChange(tx, {
        orgId: outpost.orgId,
        actorObjectId: outpost.orgId,
        requestId: "board-obs-change",
        name: "edge-web v3",
        targets: [component.id]
      });
      const [plan] = await tx
        .insert(changePlans)
        .values({ id: uuidv7(), orgId: outpost.orgId, changeObjectId: change.id })
        .returning();
      const [wave] = await tx
        .insert(changeWaves)
        .values({ id: uuidv7(), orgId: outpost.orgId, planId: plan!.id, waveIndex: 0 })
        .returning();
      const [target] = await tx
        .insert(changeWaveTargets)
        .values({
          id: uuidv7(),
          orgId: outpost.orgId,
          waveId: wave!.id,
          targetObjectId: component.id,
          type: "configuration",
          status: "triggered",
          attempt: 1
        })
        .returning();
      return {
        serviceId: service.id,
        componentId: component.id,
        changeId: change.id,
        targetId: target!.id
      };
    });
    serviceId = seeded.serviceId;
    componentId = seeded.componentId;
    changeId = seeded.changeId;
    targetId = seeded.targetId;

    await syncUp();
  }, 240_000);

  afterAll(async () => {
    await outpost?.close();
    await commander?.close();
  });

  async function syncUp(): Promise<void> {
    const cursor = await withTenantTx(commander.db, commander.orgId, (tx) =>
      getCursor(tx, commander.orgId, selfOutpost.domainId, selfOutpost.domainId)
    );
    const bundle = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      exportSyncBundle(tx, outpost.orgId, commander.orgName, cursor.sequence)
    );
    await withTenantTx(commander.db, commander.orgId, (tx) =>
      importSyncBundle(tx, commander.orgId, bundle)
    );
  }

  const boardAt = (domain: IsolatedDomain): Promise<ServiceBoardResponse> =>
    withTenantTx(domain.db, domain.orgId, async (tx) =>
      buildServiceBoard(
        tx,
        domain.orgId,
        await getObjectByIdOrUrnAnyType(tx, domain.orgId, serviceId)
      )
    );

  const commanderRow = async () => {
    const board = await boardAt(commander);
    const row = board.rows.find((r) => r.component.id === componentId);
    expect(row, "the commander has no row for the replicated component").toBeDefined();
    return row!;
  };

  it("1. NOT REPORTED: the premise, and how the row says it", async () => {
    const row = await commanderRow();
    // The premise: the commander holds the change as a replica and has no plan rows of its own, so
    // its own wave fields are unobservable — the state every commander was in before this increment.
    expect(row.driver).toEqual({ drivenHere: false, originDomainId: selfOutpost.domainId });
    expect(row.waves).toEqual([]);
    expect(row.peerObserved ?? null, "a reading appeared before anything was sent").toBeNull();
    expect(row.unknownFields).toContain("peerObserved");
  });

  it("2. A REAL READING: the outpost observes, and the commander renders it as FRESH", async () => {
    await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      updateWaveTargetObserved(tx, outpost.orgId, targetId, "observing", {
        revision: "9f2a1c4",
        rollout: { phase: "Progressing", step: 3, weight: 40 }
      })
    );
    await syncUp();

    const row = await commanderRow();
    expect(row.peerObserved, "the reading did not reach the board").not.toBeNull();
    // NOT "not reported" any more — and the path is gone from the unknown list, which is the same
    // signal the board has always used for "this one IS observed".
    expect(row.unknownFields).not.toContain("peerObserved");
    expect(row.peerObserved!.peerDomainId).toBe(selfOutpost.domainId);
    expect(row.peerObserved!.targets).toHaveLength(1);
    const target = row.peerObserved!.targets[0]!;
    expect(target.targetObjectId).toBe(componentId);
    expect(target.status).toBe("observing");
    expect(target.waveIndex).toBe(0);
    // The pips the mockup wants: phase, step, weight — as the peer's executor reported them.
    expect(target.rollout).toEqual({ phase: "Progressing", step: 3, weight: 40 });
    expect(target.freshness.state).toBe("fresh");

    // STILL UNOBSERVABLE, and deliberately: `waves`/`currentWave` summarise a LOCAL plan, and there
    // is none. The peer's facts are attributed to the peer instead of being folded into fields that
    // mean "observed here".
    expect(row.unknownFields).toContain("waves");
    expect(row.unknownFields).toContain("currentWave");
    expect(row.waves).toEqual([]);
  });

  it("3. REPORTED STALE: an hours-old reading is shown, dated, and NOT called current", async () => {
    // The air-gap case, and the reason `stale` has to exist: a bundle handed over on removable media
    // carries a reading that was true when it was taken. Appended through the real journal writer and
    // imported through the real door, so the age is the peer's own `observedAt`, not a mock.
    const oldTarget = randomUUID();
    await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      appendJournalEntry(tx, {
        orgId: outpost.orgId,
        entryKind: "wave_target_observed",
        contentHash: `test-${randomUUID()}`,
        payload: {
          subject: "target",
          changeObjectId: changeId,
          targetObjectId: oldTarget,
          type: "configuration",
          waveIndex: 1,
          status: "observing",
          attempt: 1,
          rollout: { phase: "Progressing", step: 1, weight: 10 },
          observedAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString()
        }
      })
    );
    await syncUp();

    const row = await commanderRow();
    const stale = row.peerObserved!.targets.find((t) => t.targetObjectId === oldTarget);
    expect(stale, "the old reading was dropped instead of dated").toBeDefined();
    expect(stale!.freshness.state).toBe("stale");
    if (stale!.freshness.state === "stale") {
      // Judged against the SAME bound the stage-dependency hold uses for an observed weight (10
      // minutes), so the board and the hold cannot disagree about one row.
      expect(stale!.freshness.staleAfterSeconds).toBe(600);
      expect(stale!.freshness.ageSeconds).toBeGreaterThan(600);
    }
    // A stale reading is a READING: it is present, and it is NOT in the unknown list. "Not reported"
    // stays reserved for the absence.
    expect(row.unknownFields).not.toContain("peerObserved");
    // …and the fresh one beside it is still fresh — one row, two verdicts, per reading.
    const fresh = row.peerObserved!.targets.find((t) => t.targetObjectId === componentId);
    expect(fresh!.freshness.state).toBe("fresh");
  });

  it("5. HEARSAY: a reading from a domain that does NOT drive the change is not shown as its progress", async () => {
    // The replica is keyed by peer, so two peers can hold a row about one change. A reading about
    // the outpost's execution is the outpost's to make; another domain's claim about it is not the
    // row's progress, however well-signed the bundle that carried it was.
    const impostorDomain = randomUUID();
    const impostorTarget = randomUUID();
    await withTenantTx(commander.db, commander.orgId, (tx) =>
      recordPeerObservation(tx, {
        orgId: commander.orgId,
        peerDomainId: impostorDomain as never,
        payload: {
          subject: "target",
          changeObjectId: changeId,
          targetObjectId: impostorTarget,
          type: "configuration",
          waveIndex: 9,
          status: "failed",
          attempt: 1,
          observedAt: new Date().toISOString()
        }
      })
    );

    const row = await commanderRow();
    expect(row.peerObserved!.peerDomainId).toBe(selfOutpost.domainId);
    expect(
      row.peerObserved!.targets.map((t) => t.targetObjectId),
      "another domain's claim was presented as the driving domain's progress"
    ).not.toContain(impostorTarget);
  });

  it("4. the DRIVING domain's own board asks nothing of a peer — `null` with no unknown declared", async () => {
    const board = await boardAt(outpost);
    const row = board.rows.find((r) => r.component.id === componentId);
    expect(row!.driver?.drivenHere).toBe(true);
    // `null` WITHOUT the `unknownFields` path: the question does not apply, which is a different
    // claim from "it applies and nobody told us".
    expect(row!.peerObserved ?? null).toBeNull();
    expect(row!.unknownFields).not.toContain("peerObserved");
  });
});
