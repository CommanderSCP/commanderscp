import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { SyncBundleSchema, type JournalEntryKind, type SyncBundle } from "@scp/schemas";
import { mkdtempTrackedForFile } from "@scp/test-tmpdir";
import { withTenantTx } from "../db/tenant-tx.js";
import {
  changePlans,
  changeWaves,
  changeWaveTargets,
  federationPeerObservations,
  syncJournal
} from "../db/schema.js";
import { createObject } from "../graph/objects-repo.js";
import { ensureInstanceKey } from "../governance/attestation.js";
import { proposeChange } from "../coordination/changes-repo.js";
import { updateWaveTargetObserved } from "../coordination/wave-targets-repo.js";
import {
  applyHookRunObservation,
  claimHookRun,
  findHookRun
} from "../coordination/pipeline-hook-runs.js";
import { ensureFederationSelf, type FederationSelf } from "./self-repo.js";
import { pairPeer } from "./peers-repo.js";
import { getCursor } from "./cursors-repo.js";
import { exportSyncBundle } from "./export-repo.js";
import { importSyncBundle } from "./import-repo.js";
import { appendJournalEntry } from "./journal-repo.js";
import { createIsolatedDomain, type IsolatedDomain } from "./test-support/isolated-domain.js";

/**
 * D3/D4 (pipeline-mockup-data.md §5.3): the OUTPOST observes, the COMMANDER learns.
 *
 * What each test here is really for:
 *  - the channel works over BOTH transports — an in-process bundle (the live mTLS pull's payload)
 *    and a bundle FILE read back off disk (the air-gap handoff), because a JSON round trip is where
 *    a `Date` that should have been a string shows up;
 *  - an unchanged re-poll appends NOTHING (the volume bound is the feature, not a detail);
 *  - provenance on the commander is the commander's, even when the payload tries to supply it;
 *  - an OLDER peer meeting the new kind loses one entry and not the bundle — asserted by sending a
 *    kind no version of this code knows, which is what an older peer sees when it meets this one;
 *  - the monotone rule holds, so out-of-order bundle delivery cannot walk a run backwards.
 */
describe("wave-target observations federate upward (Testcontainers, two databases)", () => {
  let outpost: IsolatedDomain;
  let commander: IsolatedDomain;
  let selfOutpost: FederationSelf;
  let selfCommander: FederationSelf;
  let bundleDir: string;

  beforeAll(async () => {
    outpost = await createIsolatedDomain("obsOutpost");
    commander = await createIsolatedDomain("obsCommander");
    bundleDir = await mkdtempTrackedForFile(path.join(os.tmpdir(), "scp-obs-bundle-"));

    selfOutpost = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      ensureFederationSelf(tx, outpost.orgId)
    );
    selfCommander = await withTenantTx(commander.db, commander.orgId, (tx) =>
      ensureFederationSelf(tx, commander.orgId)
    );

    // Real pairing both ways with the real exchanged Ed25519 keys — the import verifies a signature,
    // so a fixture that skipped this would be testing nothing about the channel.
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
  }, 240_000);

  afterAll(async () => {
    await outpost?.close();
    await commander?.close();
  });

  /** One outpost -> commander sync. `transport: "file"` serialises the bundle to a `.scpbundle` on
   *  disk and parses it back through `SyncBundleSchema` exactly as `inbox-loop.ts` does for an
   *  air-gapped handoff — the second transport, and the one that would expose a payload field that
   *  only survives in memory. */
  async function syncUp(transport: "live-pull" | "file" = "live-pull"): Promise<{
    applied: number;
    bundle: SyncBundle;
  }> {
    const cursor = await withTenantTx(commander.db, commander.orgId, (tx) =>
      getCursor(tx, commander.orgId, selfOutpost.domainId, selfOutpost.domainId)
    );
    const bundle = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      exportSyncBundle(tx, outpost.orgId, commander.orgName, cursor.sequence)
    );
    let delivered: SyncBundle = bundle;
    if (transport === "file") {
      const file = path.join(bundleDir, `${randomUUID()}.scpbundle`);
      await writeFile(file, JSON.stringify(bundle), "utf8");
      delivered = SyncBundleSchema.parse(JSON.parse(await readFile(file, "utf8")));
    }
    const result = await withTenantTx(commander.db, commander.orgId, (tx) =>
      importSyncBundle(
        tx,
        commander.orgId,
        delivered,
        transport === "file" ? "bundle" : "live-pull"
      )
    );
    return { applied: result.appliedEntries, bundle };
  }

  /** A change WITH a compiled plan at the outpost: the domain that coordinates it is the only one
   *  with wave-target rows, which is the whole reason this channel exists. The plan rows are inserted
   *  directly (the compiler needs a topology and executors this test is not about); every write under
   *  test below goes through the real `updateWaveTargetObserved`. */
  async function seedDrivenChange(label: string): Promise<{
    changeId: string;
    componentId: string;
    targetId: string;
  }> {
    return withTenantTx(outpost.db, outpost.orgId, async (tx) => {
      const component = await createObject(tx, {
        orgId: outpost.orgId,
        domainId: null,
        typeId: "component",
        actorObjectId: outpost.orgId,
        requestId: `obs-${label}-component`,
        name: `${label}-${randomUUID().slice(0, 8)}`
      });
      const { change } = await proposeChange(tx, {
        orgId: outpost.orgId,
        actorObjectId: outpost.orgId,
        requestId: `obs-${label}-change`,
        name: `${label} release`,
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
      return { changeId: change.id, componentId: component.id, targetId: target!.id };
    });
  }

  const journalKinds = (domain: IsolatedDomain, kind: JournalEntryKind | string) =>
    withTenantTx(domain.db, domain.orgId, (tx) =>
      tx
        .select()
        .from(syncJournal)
        .where(and(eq(syncJournal.orgId, domain.orgId), eq(syncJournal.entryKind, kind)))
    );

  const observationsAt = (domain: IsolatedDomain, changeObjectId: string) =>
    withTenantTx(domain.db, domain.orgId, (tx) =>
      tx
        .select()
        .from(federationPeerObservations)
        .where(
          and(
            eq(federationPeerObservations.orgId, domain.orgId),
            eq(federationPeerObservations.changeObjectId, changeObjectId)
          )
        )
    );

  it("1. an observed rollout at the outpost REACHES the commander, with receiver-stamped provenance", async () => {
    const { changeId, componentId, targetId } = await seedDrivenChange("rollout");
    await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      updateWaveTargetObserved(tx, outpost.orgId, targetId, "observing", {
        revision: "9f2a1c4",
        rollout: { phase: "Progressing", step: 2, weight: 40 }
      })
    );

    const entries = (await journalKinds(outpost, "wave_target_observed")).filter(
      (row) => (row.payload as { changeObjectId?: string }).changeObjectId === changeId
    );
    expect(entries.length, "the outpost journalled nothing for a reading it took").toBe(1);
    // NO PROVENANCE ON THE WIRE, by construction. If a future edit adds a `peerDomainId` or a
    // `source` to the payload, this is the assertion that says why it must not.
    expect(Object.keys(entries[0]!.payload as object).sort()).toEqual([
      "attempt",
      "changeObjectId",
      "observedAt",
      "rollout",
      "status",
      "subject",
      "targetObjectId",
      "type",
      "waveIndex"
    ]);

    await syncUp();

    const [row] = await observationsAt(commander, changeId);
    expect(row, "the commander has no reading for a change it was told about").toBeTruthy();
    expect(row!.subject).toBe("target");
    expect(row!.targetObjectId).toBe(componentId);
    expect(row!.status).toBe("observing");
    expect(row!.observation).toEqual({ rollout: { phase: "Progressing", step: 2, weight: 40 } });
    // PROVENANCE IS THE RECEIVER'S: the peer is the domain whose signature this bundle verified
    // against, and `received_at` is the commander's own clock, not the sender's `observed_at`.
    expect(row!.peerDomainId).toBe(selfOutpost.domainId);
    expect(row!.receivedAt.getTime()).toBeGreaterThanOrEqual(row!.observedAt.getTime());
  });

  it("2. an UNCHANGED re-poll appends nothing — the same status and the same rollout", async () => {
    const { changeId, targetId } = await seedDrivenChange("repoll");
    const reading = { revision: "abc", rollout: { phase: "Progressing", step: 1, weight: 20 } };
    for (let i = 0; i < 4; i += 1) {
      await withTenantTx(outpost.db, outpost.orgId, (tx) =>
        updateWaveTargetObserved(tx, outpost.orgId, targetId, "observing", reading)
      );
    }
    const forChange = (await journalKinds(outpost, "wave_target_observed")).filter(
      (row) => (row.payload as { changeObjectId?: string }).changeObjectId === changeId
    );
    // FOUR polls, ONE entry. This is the whole volume argument: the journal grows with transitions,
    // never with poll ticks or elapsed time.
    expect(forChange.length).toBe(1);

    // …and a real change still travels.
    await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      updateWaveTargetObserved(tx, outpost.orgId, targetId, "observing", {
        ...reading,
        rollout: { phase: "Progressing", step: 2, weight: 60 }
      })
    );
    const afterWeightMove = (await journalKinds(outpost, "wave_target_observed")).filter(
      (row) => (row.payload as { changeObjectId?: string }).changeObjectId === changeId
    );
    expect(afterWeightMove.length, "a weight move is a change and must be reported").toBe(2);
  });

  it("3. the same channel works over the AIR-GAP transport: a bundle written to a file and read back", async () => {
    const { changeId, targetId } = await seedDrivenChange("airgap");
    await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      updateWaveTargetObserved(tx, outpost.orgId, targetId, "succeeded", {
        rollout: { phase: "Healthy", step: 5, weight: 100 }
      })
    );

    const { applied } = await syncUp("file");
    expect(applied).toBeGreaterThan(0);

    const [row] = await observationsAt(commander, changeId);
    expect(row, "the reading did not survive a JSON round trip through a bundle file").toBeTruthy();
    expect(row!.status).toBe("succeeded");
    expect(row!.observation).toEqual({ rollout: { phase: "Healthy", step: 5, weight: 100 } });
    expect(row!.peerDomainId).toBe(selfOutpost.domainId);
  });

  it("4. a hook run reports EVERY forward transition and no re-reads (D3), and lands as one row", async () => {
    const { changeId, componentId } = await seedDrivenChange("hookrun");
    const identity = {
      orgId: outpost.orgId,
      changeObjectId: changeId,
      hookId: "post-deploy-smoke",
      waveIndex: 0
    };
    await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      claimHookRun(tx, {
        ...identity,
        componentObjectId: componentId,
        targetObjectId: componentId,
        kind: "postDeploy",
        pluginInstanceId: "fake-instance"
      })
    );
    const claimed = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      findHookRun(tx, identity)
    );
    // pending -> running, then TWO more polls that re-read `running`, then the terminal edge.
    for (const phase of ["running", "running", "running", "succeeded"] as const) {
      const current = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
        findHookRun(tx, identity)
      );
      await withTenantTx(outpost.db, outpost.orgId, (tx) =>
        applyHookRunObservation(tx, outpost.orgId, current!, phase, new Date())
      );
    }

    const runEntries = (await journalKinds(outpost, "wave_target_observed")).filter((row) => {
      const p = row.payload as { subject?: string; hookId?: string };
      return p.subject === "hook_run" && p.hookId === "post-deploy-smoke";
    });
    // THREE: the claim (`pending`), the first `running`, and the terminal. The two re-reads of
    // `running` appended nothing, which is the ceiling D3's sizing table states (≤3 per run).
    expect(runEntries.map((row) => (row.payload as { status: string }).status)).toEqual([
      "pending",
      "running",
      "succeeded"
    ]);
    expect(claimed!.status).toBe("pending");

    await syncUp();
    const rows = (await observationsAt(commander, changeId)).filter(
      (row) => row.subject === "hook_run"
    );
    // ONE ROW, at the LATEST status — three entries, one row. The identity's `UNIQUE NULLS NOT
    // DISTINCT` is what makes the replica's size proportional to runs rather than to transitions.
    expect(rows.length).toBe(1);
    expect(rows[0]!.status).toBe("succeeded");
    expect(rows[0]!.hookId).toBe("post-deploy-smoke");
    expect(rows[0]!.hookKind).toBe("postDeploy");
  });

  it("5. a LATER bundle carrying an earlier reading cannot walk the commander backwards", async () => {
    const { changeId } = await seedDrivenChange("monotone");
    const targetObjectId = randomUUID();
    const importOne = async (status: string, observedAt: string) => {
      await withTenantTx(outpost.db, outpost.orgId, (tx) =>
        appendJournalEntry(tx, {
          orgId: outpost.orgId,
          entryKind: "wave_target_observed",
          contentHash: `test-${randomUUID()}`,
          payload: {
            subject: "target",
            changeObjectId: changeId,
            targetObjectId,
            type: "configuration",
            waveIndex: 0,
            status,
            attempt: 1,
            observedAt
          }
        })
      );
      await syncUp();
    };
    await importOne("succeeded", "2026-09-19T10:00:00.000Z");
    // The air-gap case: a bundle produced BEFORE the one above, delivered after it.
    await importOne("observing", "2026-09-19T09:00:00.000Z");
    // And the harder case — a NEWER timestamp, still a walk back from a settled outcome.
    await importOne("observing", "2026-09-19T11:00:00.000Z");

    const rows = (await observationsAt(commander, changeId)).filter(
      (row) => row.targetObjectId === targetObjectId
    );
    expect(rows.length).toBe(1);
    expect(rows[0]!.status, "a terminal reading was walked back by a later bundle").toBe(
      "succeeded"
    );
  });

  it("6. an entry kind the receiver does not understand costs ONE entry, not the bundle", async () => {
    const { changeId, targetId } = await seedDrivenChange("olderpeer");
    // THE OLDER-PEER CASE, from the only side that can be tested: a kind no version of this code
    // knows is exactly what `wave_target_observed` looks like to a peer that predates it. Appended
    // through the real journal writer, so it is inside the signed hash chain like any other entry.
    await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      appendJournalEntry(tx, {
        orgId: outpost.orgId,
        entryKind: "wave_target_observed_v2_from_the_future" as JournalEntryKind,
        contentHash: `test-${randomUUID()}`,
        payload: { subject: "target", changeObjectId: changeId, whatever: true }
      })
    );
    // A MALFORMED payload of the KNOWN kind takes the same one-entry cost by a different door
    // (`safeParse`), so both are pinned here.
    await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      appendJournalEntry(tx, {
        orgId: outpost.orgId,
        entryKind: "wave_target_observed",
        contentHash: `test-${randomUUID()}`,
        payload: { subject: "target", changeObjectId: changeId, status: 42 }
      })
    );
    // …and a GOOD reading after both, which is the assertion that matters: the import did not wedge.
    await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      updateWaveTargetObserved(tx, outpost.orgId, targetId, "succeeded", {
        rollout: { phase: "Healthy" }
      })
    );

    const before = await withTenantTx(commander.db, commander.orgId, (tx) =>
      getCursor(tx, commander.orgId, selfOutpost.domainId, selfOutpost.domainId)
    );
    const { applied } = await syncUp();
    const after = await withTenantTx(commander.db, commander.orgId, (tx) =>
      getCursor(tx, commander.orgId, selfOutpost.domainId, selfOutpost.domainId)
    );

    expect(applied).toBeGreaterThan(0);
    // The cursor moved PAST the unknown and the malformed entries. A receiver that treated either as
    // fatal would stop here forever and every later bundle would be refused.
    expect(after.sequence).toBeGreaterThan(before.sequence);
    const rows = await observationsAt(commander, changeId);
    expect(rows.length, "the good reading behind two bad entries never landed").toBe(1);
    expect(rows[0]!.status).toBe("succeeded");
  });

  it("8. a DOMAIN-LOCAL change's execution is not reported at all (ADR-0031 §5)", async () => {
    const { changeId, targetId } = await withTenantTx(outpost.db, outpost.orgId, async (tx) => {
      const local = await createObject(tx, {
        orgId: outpost.orgId,
        domainId: null,
        typeId: "component",
        actorObjectId: outpost.orgId,
        requestId: "obs-domainlocal-component",
        name: `local-${randomUUID().slice(0, 8)}`,
        domainLocal: true
      });
      // A change whose targets are domain-local is itself domain-local (`changes-repo.ts`), and
      // `createObject` therefore skips its journal entry. Its EXECUTION must be withheld by the
      // same rule — this channel is younger than that rule, which is exactly how such a hole gets
      // opened.
      const { change } = await proposeChange(tx, {
        orgId: outpost.orgId,
        actorObjectId: outpost.orgId,
        requestId: "obs-domainlocal-change",
        name: "local infra tweak",
        targets: [local.id]
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
          targetObjectId: local.id,
          type: "infrastructure",
          status: "triggered",
          attempt: 1
        })
        .returning();
      return { changeId: change.id, targetId: target!.id };
    });

    await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      updateWaveTargetObserved(tx, outpost.orgId, targetId, "succeeded", {
        rollout: { phase: "Healthy", weight: 100 }
      })
    );

    // Withheld at the SOURCE: no entry is written at all, so there is nothing for a scope filter to
    // have to catch and nothing in the chain to leak if one is ever widened.
    const entries = (await journalKinds(outpost, "wave_target_observed")).filter(
      (row) => (row.payload as { changeObjectId?: string }).changeObjectId === changeId
    );
    expect(entries.length, "a domain-local release reported its execution upward").toBe(0);

    await syncUp();
    expect(await observationsAt(commander, changeId)).toEqual([]);
  });

  it("7. a payload that TRIES to supply provenance does not get to", async () => {
    const { changeId } = await seedDrivenChange("forged");
    const targetObjectId = randomUUID();
    const impostor = randomUUID();
    await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      appendJournalEntry(tx, {
        orgId: outpost.orgId,
        entryKind: "wave_target_observed",
        contentHash: `test-${randomUUID()}`,
        payload: {
          subject: "target",
          changeObjectId: changeId,
          targetObjectId,
          type: "configuration",
          waveIndex: 0,
          status: "succeeded",
          attempt: 1,
          observedAt: new Date().toISOString(),
          // Every one of these is a claim the sender is not entitled to make.
          peerDomainId: impostor,
          source: "executor_observed",
          receivedAt: "2000-01-01T00:00:00.000Z"
        }
      })
    );
    await syncUp();

    const rows = (await observationsAt(commander, changeId)).filter(
      (row) => row.targetObjectId === targetObjectId
    );
    expect(rows.length).toBe(1);
    expect(rows[0]!.peerDomainId, "a sender picked its own provenance").toBe(selfOutpost.domainId);
    expect(rows[0]!.peerDomainId).not.toBe(impostor);
    expect(rows[0]!.receivedAt.getFullYear()).toBeGreaterThan(2000);
  });
});
