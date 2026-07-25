import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ServiceBoardResponse } from "@scp/schemas";
import { withTenantTx } from "../db/tenant-tx.js";
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
import { buildServiceBoard } from "./service-board.js";

/**
 * THE THIRD FORM OF THE SAME DEFECT: a fabricated `stable` built not on a replica this domain
 * cannot assess, but on a change this domain WAS NEVER SENT.
 *
 * `service-board-federation.integration.test.ts` pins that a change replicated here read-only is
 * never reported as `stable`; `service-board-precedence.integration.test.ts` pins the converse (an
 * unknown must not displace a real observation). Both assume the change object ARRIVES. It does not
 * when a peer's sync scope withholds it: `status_only` (federation/scope-filter.ts) forwards
 * `change_status` entries — positive evidence that changes exist and are moving on that peer —
 * while forwarding neither the `object_upsert` that carries the change nor its `targets`.
 *
 * So the board's lookup finds nothing, the row falls through to the no-change branch, and the
 * component reads as a confident `stable` — with all-false attention and an empty `unknownFields`,
 * i.e. an all-clear asserted over evidence the domain literally received and could not attach to
 * anything. An operator who chose a confidentiality scope is exactly the person who must not be
 * lied to about what it costs them.
 *
 * WHAT THIS PINS: on a change-blind deployment the board declares its blindness instead of
 * reporting green — per-row (`unknownFields` naming `latestChangeId` and every field that would
 * otherwise read as clean) and board-level (`summary.stable`, `rows[].latestChangeId`). The counts
 * are unchanged (the four buckets must keep summing to `rows.length`); what changes is that they
 * are no longer presented as facts.
 *
 * WHY THE OUTPOST'S OWN SCOPE IS THE ONE NARROWED. `import-repo.ts` re-applies `entryMatchesScope`
 * against the RECEIVER's peer row as defense in depth, so the receiving domain's scope is decisive
 * regardless of what the sender shipped. That is precisely what makes the board's scope-derived
 * treatment sound, and it leaves the commander (still paired at `full`) as an untouched control:
 * the same change, the same moment, reported honestly on the domain that drives it.
 */
describe("service board scope blindness: a change never sent is not a `stable` component (Testcontainers, two databases)", () => {
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
    commander = await createIsolatedDomain("boardBlindCommander");
    outpost = await createIsolatedDomain("boardBlindOutpost");

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
    // Paired at FULL first — the topology below has to replicate, exactly as it would before an
    // operator narrows the scope (a scope change requires a re-sync from sequence 0;
    // scope-filter.ts's own doc comment). Both directions, real exchanged Ed25519 public keys.
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

    // 1. The commander authors the topology and replicates it down while the scope is still full.
    const seeded = await withTenantTx(commander.db, commander.orgId, async (tx) => {
      const service = await createObject(tx, {
        orgId: commander.orgId,
        domainId: null,
        typeId: "service",
        actorObjectId: commander.orgId,
        requestId: "board-blind-service",
        name: "payments-api"
      });
      const component = await createObject(tx, {
        orgId: commander.orgId,
        domainId: null,
        typeId: "component",
        actorObjectId: commander.orgId,
        requestId: "board-blind-component",
        name: "payments-web"
      });
      await createRelationship(tx, {
        orgId: commander.orgId,
        actorObjectId: commander.orgId,
        requestId: "board-blind-contains",
        typeId: "contains",
        fromId: service.id,
        toId: component.id
      });
      return { serviceId: service.id, componentId: component.id };
    });
    serviceId = seeded.serviceId;
    componentId = seeded.componentId;
    await syncToOutpost();

    // 2. The operator narrows the OUTPOST's own peer row to `status_only` — a confidentiality
    //    choice. From here the outpost applies change STATUS and drops change OBJECTS, whatever the
    //    commander ships.
    await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      pairPeer(tx, {
        orgId: outpost.orgId,
        domainId: selfCommander.domainId,
        name: commander.orgName,
        role: "commander",
        publicKey: commanderKey.publicKey,
        syncScope: { mode: "status_only" }
      })
    );

    // 3. The commander proposes a change through the outpost's component and syncs.
    changeId = await withTenantTx(commander.db, commander.orgId, async (tx) => {
      const { change } = await proposeChange(tx, {
        orgId: commander.orgId,
        actorObjectId: commander.orgId,
        requestId: "board-blind-change",
        name: "payments rollout",
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

  it("the premise: the outpost received the change's STATUS and not the change", async () => {
    const found = await withTenantTx(outpost.db, outpost.orgId, async (tx) => {
      const rows = await tx.query.objects.findMany({
        where: (t, { eq, and }) => and(eq(t.orgId, outpost.orgId), eq(t.typeId, "change"))
      });
      return rows;
    });
    // No change object crossed the boundary — arm 2 of `latestChangeByComponent` has nothing to
    // find, which is exactly why the row would otherwise read as a clean `stable`.
    expect(found).toHaveLength(0);

    // ...while the component and its service DID (replicated before the scope was narrowed), so the
    // board is genuinely projecting this component and not silently skipping it.
    const component = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      getObjectByIdOrUrnAnyType(tx, outpost.orgId, componentId)
    );
    expect(component.originDomainId).toBe(selfCommander.domainId);
    expect(outpostBoard.rows.map((r) => r.component.id)).toEqual([componentId]);
  });

  it("REGRESSION: the row does not assert an all-clear it cannot observe", () => {
    const row = outpostBoard.rows.find((r) => r.component.id === componentId);
    expect(row, "the component must still project a row").toBeDefined();

    // The shape is unchanged (nothing here can be fabricated into a change that was never sent)...
    expect(row!.latestChangeId).toBeNull();
    expect(row!.attention.blocked).toBe(false);
    expect(row!.waves).toEqual([]);

    // ...but every one of those zeros is now NAMED as unobservable rather than passed off as an
    // observation. `latestChangeId` first: whether a change is rolling through this component at
    // all is the fact this domain cannot see.
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
    // Board-level, because the evidence (a `change_status` entry carrying no `targets`) cannot be
    // attributed to any particular component — see service-board.ts's header.
    expect(outpostBoard.unknownFields).toContain("summary.stable");
    expect(outpostBoard.unknownFields).toContain("rows[].latestChangeId");

    // The count is still emitted for shape stability — the four buckets sum to rows.length, as
    // `service-board-federation.integration.test.ts` pins — which is precisely why declaring it
    // unobservable, rather than silently re-bucketing it, is the honest move.
    const s = outpostBoard.summary;
    expect(s.stable).toBe(1);
    expect(s.releasing + s.blocked + s.stable + s.notDrivenHere).toBe(outpostBoard.rows.length);
  });

  it("CONTROL: the commander, which can see everything, claims no ignorance", () => {
    const row = commanderBoard.rows.find((r) => r.component.id === componentId);
    expect(row, "the component must project a row on the commander too").toBeDefined();

    // The same component, the same moment: a real change, driven here, with nothing unobservable
    // about it. An unknown must never displace an observation — including this one.
    expect(row!.latestChangeId).toBe(changeId);
    expect(row!.driver).toEqual({ drivenHere: true, originDomainId: null });
    expect(row!.unknownFields).toEqual([]);
    expect(commanderBoard.unknownFields).not.toContain("summary.stable");
    expect(commanderBoard.summary.releasing).toBe(1);
    expect(commanderBoard.summary.stable).toBe(0);
  });
});
