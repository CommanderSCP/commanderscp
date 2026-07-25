import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
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
 * REGRESSION: the service board must never FABRICATE an all-clear on a domain that does not drive
 * the change (the "not driven here" honesty rule).
 *
 * THE DEFECT this pins, reproduced side-by-side on two genuinely separate Postgres databases (the
 * `createIsolatedDomain` topology `federation.integration.test.ts` uses — real pairing, real signed
 * `exportSyncBundle` -> `importSyncBundle`), same service, same moment:
 *
 *   commander -> { releasing: 1, blocked: 0, stable: 0 }, changeState 'proposed'
 *   outpost   -> { releasing: 0, blocked: 0, stable: 1 }, latestChangeId null      <-- the lie
 *
 * The outpost reported STABLE — green — while a release was in flight through its own components.
 * Not an empty view: a fabricated all-clear, synthesized from tables the outpost never had. Every
 * table the board reads for a row's detail (`change_plans`/`change_waves`/`change_wave_targets`,
 * `changes`, `decisions`, `approval_requests`, `freezes`) is a LOCAL projection that never rides the
 * sync journal, so the old `latestChangeIdByComponent` join found nothing and the row fell through
 * to `stable` with all-false attention.
 *
 * WHAT THE OUTPOST GENUINELY KNOWS (so the honest state is "not driven here", NOT a bare "unknown"):
 *   - the change's graph OBJECT replicates (`objects-repo.ts` emits `object_upsert` for `change`);
 *   - `properties.targets` — the resolved component object ids `proposeChange` stamps on that object
 *     — replicates verbatim with it, giving a real component -> change edge;
 *   - `objects.origin_domain_id` is the cryptographically verified exporter, so
 *     `origin_domain_id !== self.domainId` IS, by construction, "this domain does not drive it";
 *   - `properties.federationState` carries the lifecycle state the origin last reported.
 *
 * WHAT IT GENUINELY CANNOT KNOW: waves, block Decisions, approvals, and any freeze the driving
 * domain declared. Those are named in `row.unknownFields` rather than emitted as false/[]/null and
 * called an observation.
 *
 * The assertions below are POSITIVE on purpose — asserting only "not stable" would also pass on an
 * empty view, which is precisely the failure mode this test exists to distinguish.
 */
describe("service board honesty across a federation link (Testcontainers, two databases)", () => {
  let commander: IsolatedDomain;
  let outpost: IsolatedDomain;
  let selfCommander: FederationSelf;
  let selfOutpost: FederationSelf;

  let serviceId: string;
  let componentId: string;
  let changeId: string;

  let commanderBoard: ServiceBoardResponse;
  let outpostBoard: ServiceBoardResponse;

  beforeAll(async () => {
    commander = await createIsolatedDomain("boardCommander");
    outpost = await createIsolatedDomain("boardOutpost");

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

    // A service containing one component, and a change targeting that component — all authored on
    // the COMMANDER, which is the domain that drives it.
    const seeded = await withTenantTx(commander.db, commander.orgId, async (tx) => {
      const service = await createObject(tx, {
        orgId: commander.orgId,
        domainId: null,
        typeId: "service",
        actorObjectId: commander.orgId,
        requestId: "board-fed-service",
        name: "checkout-api"
      });
      const component = await createObject(tx, {
        orgId: commander.orgId,
        domainId: null,
        typeId: "component",
        actorObjectId: commander.orgId,
        requestId: "board-fed-component",
        name: "checkout-web"
      });
      await createRelationship(tx, {
        orgId: commander.orgId,
        actorObjectId: commander.orgId,
        requestId: "board-fed-contains",
        typeId: "contains",
        fromId: service.id,
        toId: component.id
      });
      const { change } = await proposeChange(tx, {
        orgId: commander.orgId,
        actorObjectId: commander.orgId,
        requestId: "board-fed-change",
        name: "checkout-web v2",
        targets: [component.id]
      });
      return { serviceId: service.id, componentId: component.id, changeId: change.id };
    });
    serviceId = seeded.serviceId;
    componentId = seeded.componentId;
    changeId = seeded.changeId;

    // Real signed bundle, real import — the outpost now holds the service, the component and the
    // change as read-only replicas of the commander's.
    const bundle = await withTenantTx(commander.db, commander.orgId, (tx) =>
      exportSyncBundle(tx, commander.orgId, outpost.orgName)
    );
    const imported = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      importSyncBundle(tx, outpost.orgId, bundle)
    );
    expect(imported.appliedEntries).toBeGreaterThan(0);

    // SAME SERVICE, SAME MOMENT — the two boards the defect report measured side by side.
    commanderBoard = await withTenantTx(commander.db, commander.orgId, async (tx) =>
      buildServiceBoard(
        tx,
        commander.orgId,
        await getObjectByIdOrUrnAnyType(tx, commander.orgId, serviceId)
      )
    );
    outpostBoard = await withTenantTx(outpost.db, outpost.orgId, async (tx) =>
      buildServiceBoard(
        tx,
        outpost.orgId,
        await getObjectByIdOrUrnAnyType(tx, outpost.orgId, serviceId)
      )
    );
  }, 120_000);

  afterAll(async () => {
    await commander.close();
    await outpost.close();
  });

  it("the outpost really is a separate database holding the change as a REPLICA (the premise)", async () => {
    const replica = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      getObjectByIdOrUrnAnyType(tx, outpost.orgId, changeId)
    );
    expect(replica.typeId).toBe("change");
    expect(replica.originDomainId).toBe(selfCommander.domainId);
    expect(replica.originDomainId).not.toBe(selfOutpost.domainId);
    // The correlation key the honest lookup rides on, replicated verbatim.
    expect(replica.properties.targets).toEqual([componentId]);
    // ...and the lifecycle state the commander reported through the journal.
    expect(replica.properties.federationState).toBe("proposed");

    // THE DEFECT'S MECHANISM, pinned: the outpost has NO local state-machine or plan rows for this
    // change (`import-repo.ts` deliberately never creates a local `changes` row on import), so the
    // old plan/wave-only lookup found nothing and the row fell through to `stable`. Any future
    // change that makes these non-empty would invalidate this test's premise, not just its result.
    const local = await withTenantTx(outpost.db, outpost.orgId, async (tx) => {
      const changeRows = await tx.execute<{ n: string }>(
        sql`SELECT count(*)::text AS n FROM changes WHERE org_id = ${outpost.orgId}::uuid`
      );
      const targetRows = await tx.execute<{ n: string }>(
        sql`SELECT count(*)::text AS n FROM change_wave_targets WHERE org_id = ${outpost.orgId}::uuid`
      );
      return { changes: changeRows.rows[0]!.n, waveTargets: targetRows.rows[0]!.n };
    });
    expect(local).toEqual({ changes: "0", waveTargets: "0" });
  });

  it("the COMMANDER (which drives the change) reports it in flight", () => {
    expect(commanderBoard.summary).toEqual({
      releasing: 1,
      blocked: 0,
      stable: 0,
      notDrivenHere: 0
    });
    const row = commanderBoard.rows.find((r) => r.component.id === componentId);
    expect(row).toBeDefined();
    expect(row!.latestChangeId).toBe(changeId);
    expect(row!.changeState).toBe("proposed");
    expect(row!.driver).toEqual({ drivenHere: true, originDomainId: null });
    // The commander DOES drive it, so its empties are real observations, not unknowns.
    expect(row!.unknownFields).toEqual([]);
  });

  it("REGRESSION: the OUTPOST does not fabricate `stable` — it reports the release as not driven here", () => {
    // The exact lie: a stable/green count for a component whose release is in flight.
    expect(outpostBoard.summary.stable).toBe(0);
    // Asserted POSITIVELY — "not stable" alone would also hold for an empty view.
    expect(outpostBoard.summary).toEqual({
      releasing: 0,
      blocked: 0,
      stable: 0,
      notDrivenHere: 1
    });

    const row = outpostBoard.rows.find((r) => r.component.id === componentId);
    expect(row, "the outpost must still project the component as a row").toBeDefined();

    // What the outpost CAN say, said: the change exists, it is the commander's, and the commander
    // last reported it `proposed`.
    expect(row!.latestChangeId).toBe(changeId);
    expect(row!.driver).toEqual({
      drivenHere: false,
      originDomainId: selfCommander.domainId
    });
    expect(row!.changeState).toBe("proposed");
    expect(row!.changeName).toBe("checkout-web v2");

    // What it CANNOT say, named rather than fabricated. The zero values still ride the wire for
    // shape stability, but every one of them is declared unobservable.
    expect(new Set(row!.unknownFields)).toEqual(
      new Set([
        "currentWave",
        "waves",
        "attention.blocked",
        "attention.decisionId",
        "attention.awaitingApproval",
        "attention.emergency",
        "activeFreeze"
      ])
    );
  });

  it("the two boards disagree in exactly the honest way — same service, same moment", () => {
    const onCommander = commanderBoard.rows.find((r) => r.component.id === componentId)!;
    const onOutpost = outpostBoard.rows.find((r) => r.component.id === componentId)!;

    // Both name the SAME change and the SAME reported state — no divergence of fact.
    expect(onOutpost.latestChangeId).toBe(onCommander.latestChangeId);
    expect(onOutpost.changeState).toBe(onCommander.changeState);
    // They differ only in AUTHORITY, and therefore in what each may assert.
    expect(onCommander.driver!.drivenHere).toBe(true);
    expect(onOutpost.driver!.drivenHere).toBe(false);
    expect(onCommander.unknownFields).toEqual([]);
    expect(onOutpost.unknownFields.length).toBeGreaterThan(0);
    // Neither board counts the row as stable while the release is in flight.
    expect(commanderBoard.summary.stable + outpostBoard.summary.stable).toBe(0);
  });

  it("a component with NO change at all is still an honest `stable` (the fix does not over-fire)", async () => {
    const untouchedId = await withTenantTx(commander.db, commander.orgId, async (tx) => {
      const component = await createObject(tx, {
        orgId: commander.orgId,
        domainId: null,
        typeId: "component",
        actorObjectId: commander.orgId,
        requestId: "board-fed-untouched",
        name: "checkout-docs"
      });
      await createRelationship(tx, {
        orgId: commander.orgId,
        actorObjectId: commander.orgId,
        requestId: "board-fed-contains-2",
        typeId: "contains",
        fromId: serviceId,
        toId: component.id
      });
      return component.id;
    });

    const bundle = await withTenantTx(commander.db, commander.orgId, (tx) =>
      exportSyncBundle(tx, commander.orgId, outpost.orgName)
    );
    await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      importSyncBundle(tx, outpost.orgId, bundle)
    );

    const board = await withTenantTx(outpost.db, outpost.orgId, async (tx) =>
      buildServiceBoard(
        tx,
        outpost.orgId,
        await getObjectByIdOrUrnAnyType(tx, outpost.orgId, serviceId)
      )
    );
    const untouched = board.rows.find((r) => r.component.id === untouchedId);
    expect(untouched).toBeDefined();
    expect(untouched!.latestChangeId).toBeNull();
    expect(untouched!.driver).toBeNull();
    expect(untouched!.unknownFields).toEqual([]);
    expect(board.summary.stable).toBe(1);
    expect(board.summary.notDrivenHere).toBe(1);
    // The four buckets stay mutually exclusive and sum to rows.length.
    const s = board.summary;
    expect(s.releasing + s.blocked + s.stable + s.notDrivenHere).toBe(board.rows.length);
  });
});
