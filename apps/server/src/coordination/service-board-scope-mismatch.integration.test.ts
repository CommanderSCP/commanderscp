import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ServiceBoardResponse } from "@scp/schemas";
import { withTenantTx } from "../db/tenant-tx.js";
import { createObject, getObjectByIdOrUrnAnyType } from "../graph/objects-repo.js";
import { createRelationship } from "../graph/relationships-repo.js";
import { ensureInstanceKey } from "../governance/attestation.js";
import { ensureFederationSelf, type FederationSelf } from "../federation/self-repo.js";
import { listPeers, pairPeer } from "../federation/peers-repo.js";
import { scopeCarriesChangeObjects } from "../federation/scope-filter.js";
import { listUnattachedChangeStatusInStates } from "../federation/unattached-change-status-repo.js";
import { exportSyncBundle } from "../federation/export-repo.js";
import { importSyncBundle } from "../federation/import-repo.js";
import {
  createIsolatedDomain,
  type IsolatedDomain
} from "../federation/test-support/isolated-domain.js";
import { proposeChange } from "./changes-repo.js";
import { buildServiceBoard } from "./service-board.js";

/** The fourth form, which the scope treatment cannot reach. See docs/coordination.md §869. */
describe("service board scope MISMATCH: a sender narrower than this receiver is still not a `stable` component (Testcontainers, two databases)", () => {
  let commander: IsolatedDomain;
  let outpost: IsolatedDomain;
  let selfCommander: FederationSelf;
  let selfOutpost: FederationSelf;

  let serviceId: string;
  let componentId: string;
  let changeId: string;

  let outpostBoard: ServiceBoardResponse;
  let commanderBoard: ServiceBoardResponse;

  const syncToOutpost = async (): Promise<void> => {
    const bundle = await withTenantTx(commander.db, commander.orgId, (tx) =>
      exportSyncBundle(tx, commander.orgId, outpost.orgName)
    );
    await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      importSyncBundle(tx, outpost.orgId, bundle)
    );
  };

  beforeAll(async () => {
    commander = await createIsolatedDomain("boardMismatchCommander");
    outpost = await createIsolatedDomain("boardMismatchOutpost");

    selfCommander = await withTenantTx(commander.db, commander.orgId, (tx) =>
      ensureFederationSelf(tx, commander.orgId)
    );
    selfOutpost = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      ensureFederationSelf(tx, outpost.orgId)
    );

    const commanderKey = await withTenantTx(commander.db, commander.orgId, (tx) =>
      ensureInstanceKey(tx, commander.orgId)
    );
    const outpostKey = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      ensureInstanceKey(tx, outpost.orgId)
    );

    // Paired at FULL on both sides first — the topology has to replicate before either operator
    // narrows anything (a scope change requires a re-sync from sequence 0; scope-filter.ts's own
    // doc comment).
    await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      pairPeer(tx, {
        orgId: outpost.orgId,
        domainId: selfCommander.domainId,
        name: commander.orgName,
        role: "commander",
        publicKey: commanderKey.publicKey
      })
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

    const seeded = await withTenantTx(commander.db, commander.orgId, async (tx) => {
      const service = await createObject(tx, {
        orgId: commander.orgId,
        domainId: null,
        typeId: "service",
        actorObjectId: commander.orgId,
        requestId: "board-mismatch-service",
        name: "ledger-api"
      });
      const component = await createObject(tx, {
        orgId: commander.orgId,
        domainId: null,
        typeId: "component",
        actorObjectId: commander.orgId,
        requestId: "board-mismatch-component",
        name: "ledger-web"
      });
      await createRelationship(tx, {
        orgId: commander.orgId,
        actorObjectId: commander.orgId,
        requestId: "board-mismatch-contains",
        typeId: "contains",
        fromId: service.id,
        toId: component.id
      });
      return { serviceId: service.id, componentId: component.id };
    });
    serviceId = seeded.serviceId;
    componentId = seeded.componentId;
    await syncToOutpost();

    // The mismatch: two decisions, neither wrong on its own. See docs/coordination.md §870.
    await withTenantTx(commander.db, commander.orgId, (tx) =>
      pairPeer(tx, {
        orgId: commander.orgId,
        domainId: selfOutpost.domainId,
        name: outpost.orgName,
        role: "outpost",
        publicKey: outpostKey.publicKey,
        syncScope: { mode: "status_only" }
      })
    );
    await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      pairPeer(tx, {
        orgId: outpost.orgId,
        domainId: selfCommander.domainId,
        name: commander.orgName,
        role: "commander",
        publicKey: commanderKey.publicKey,
        syncScope: { mode: "changes_only" }
      })
    );

    changeId = await withTenantTx(commander.db, commander.orgId, async (tx) => {
      const { change } = await proposeChange(tx, {
        orgId: commander.orgId,
        actorObjectId: commander.orgId,
        requestId: "board-mismatch-change",
        name: "ledger rollout",
        targets: [componentId]
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
    commanderBoard = await withTenantTx(commander.db, commander.orgId, async (tx) =>
      buildServiceBoard(
        tx,
        commander.orgId,
        await getObjectByIdOrUrnAnyType(tx, commander.orgId, serviceId)
      )
    );
  }, 180_000);

  afterAll(async () => {
    await commander.close();
    await outpost.close();
  });

  it("the premise: no change object crossed, even though the OUTPOST's own scope would accept one", async () => {
    const { changes, peerScope } = await withTenantTx(outpost.db, outpost.orgId, async (tx) => {
      const rows = await tx.query.objects.findMany({
        where: (t, { eq, and }) => and(eq(t.orgId, outpost.orgId), eq(t.typeId, "change"))
      });
      const peers = await listPeers(tx, outpost.orgId);
      return { changes: rows, peerScope: peers[0]!.syncScope };
    });
    expect(changes).toHaveLength(0);

    // THE LOAD-BEARING ASSERTION. The old, scope-derived arm is SILENT here — this outpost's own
    // scope carries change objects, so nothing in `peer.syncScope` hints that anything is missing.
    // Any honesty the board shows below has to come from the evidence, not from this predicate.
    expect(peerScope).toEqual({ mode: "changes_only" });
    expect(scopeCarriesChangeObjects(peerScope)).toBe(true);
  });

  it("the evidence IS persisted: the dropped `change_status` is recorded against the peer", async () => {
    const unattached = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      listUnattachedChangeStatusInStates(tx, outpost.orgId, ["proposed"])
    );
    expect(unattached).toHaveLength(1);
    expect(unattached[0]!.changeObjectId).toBe(changeId);
    expect(unattached[0]!.peerDomainId).toBe(selfCommander.domainId);
    expect(unattached[0]!.lastState).toBe("proposed");
    // The sender withheld the change OBJECT — this is not the receiver's own filter dropping it.
    expect(unattached[0]!.dropReason).toBe("no_local_replica");
    // Propose-time enrichment rides through, so an operator can see WHICH change without holding it.
    expect(unattached[0]!.name).toBe("ledger rollout");
  });

  it("REGRESSION: the row does not assert an all-clear over evidence this domain received", () => {
    const row = outpostBoard.rows.find((r) => r.component.id === componentId);
    expect(row, "the component must still project a row").toBeDefined();

    // Nothing can be fabricated into a change that was never sent...
    expect(row!.latestChangeId).toBeNull();
    expect(row!.attention.blocked).toBe(false);
    expect(row!.waves).toEqual([]);

    // ...but the zeros are NAMED unobservable rather than passed off as observations.
    expect(new Set(row!.unknownFields)).toEqual(
      new Set([
        "latestChangeId",
        "changeState",
        "currentWave",
        "waves",
        "attention.blocked",
        "attention.decisionId",
        "attention.awaitingApproval",
        "attention.emergency"
      ])
    );
  });

  it("the board declares `summary.stable` unobservable, and the counts still add up", () => {
    expect(outpostBoard.unknownFields).toContain("summary.stable");
    expect(outpostBoard.unknownFields).toContain("rows[].latestChangeId");
    // Each path is named ONCE even though a board can be blind for several reasons at once.
    expect(outpostBoard.unknownFields).toEqual([...new Set(outpostBoard.unknownFields)]);

    const s = outpostBoard.summary;
    expect(s.stable).toBe(1);
    expect(s.releasing + s.blocked + s.stable + s.notDrivenHere).toBe(outpostBoard.rows.length);
  });

  it("CONTROL: the commander reports the change it drives as a real, unqualified observation", () => {
    const row = commanderBoard.rows.find((r) => r.component.id === componentId);
    expect(row, "the component must project a row on the commander too").toBeDefined();

    // The same component, the same moment: a real change, driven here, with nothing unobservable
    // about the ROW. An unknown must never displace an observation — including this one.
    expect(row!.latestChangeId).toBe(changeId);
    expect(row!.driver).toEqual({ drivenHere: true, originDomainId: null });
    expect(row!.unknownFields).toEqual([]);
    expect(commanderBoard.summary.releasing).toBe(1);
    expect(commanderBoard.summary.stable).toBe(0);

    // The board-level caveat does fire, and that is correct. See docs/coordination.md §871.
    expect(commanderBoard.unknownFields).toContain("summary.stable");
  });

  it("CONTROL: the commander records no unattached evidence — it is the origin, not a receiver", async () => {
    const unattached = await withTenantTx(commander.db, commander.orgId, (tx) =>
      listUnattachedChangeStatusInStates(tx, commander.orgId, [
        "proposed",
        "evaluated",
        "coordinated",
        "waiting",
        "executing",
        "validating"
      ])
    );
    expect(unattached).toEqual([]);
  });
});
