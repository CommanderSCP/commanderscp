import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenantTx } from "../db/tenant-tx.js";
import { createObject } from "../graph/objects-repo.js";
import { ensureInstanceKey } from "../governance/attestation.js";
import { ensureFederationSelf, initFederationSelf, type FederationSelf } from "./self-repo.js";
import { pairPeer } from "./peers-repo.js";
import { exportSyncBundle } from "./export-repo.js";
import { importSyncBundle } from "./import-repo.js";
import { ownJournalTail } from "./journal-repo.js";
import { getFederationStatus } from "./status-repo.js";
import { createIsolatedDomain, type IsolatedDomain } from "./test-support/isolated-domain.js";

/**
 * M16.2 phase A (E3) — PENDING-VS-APPLIED, HONESTLY.
 *
 * The M16.2 Overview asks for "pending-vs-applied" for air-gapped outposts. Grounding established
 * that the APPLIED half cannot be derived at the commander at all: `sync_cursors` records only what
 * WE applied FROM a peer, `export-repo.ts` ships only this domain's own entries (so a return bundle
 * cannot carry our sequences back), and `bundle_transfers` has no production UPDATE path, so an
 * EXPORT row is inserted `created` and never advances. DESIGN §13's "confirmed when a returned bundle
 * carries the outpost's import cursor" is UNBUILT (named future increment M16.4).
 *
 * So the fields E3 adds measure PENDING-EXPORT, and this file proves they measure exactly that — most
 * pointedly by the test that makes the OUTPOST apply the bundle and shows the COMMANDER's numbers do
 * not move. If they did, they would be an apply signal, and their names would be lies.
 *
 * Uses the two-domain harness (two separate Postgres databases) because the import side genuinely
 * needs a second instance; `getFederationStatus` is called directly, exactly as the route does.
 */
describe("M16.2 E3: federation status reports pending-EXPORT, never pending-apply (Testcontainers)", () => {
  let commander: IsolatedDomain;
  let outpost: IsolatedDomain;
  let outpostSelf: FederationSelf;

  async function pair(
    a: IsolatedDomain,
    b: IsolatedDomain,
    role: "commander" | "outpost"
  ): Promise<void> {
    const key = await withTenantTx(b.db, b.orgId, (tx) => ensureInstanceKey(tx, b.orgId));
    const self = await withTenantTx(b.db, b.orgId, (tx) => ensureFederationSelf(tx, b.orgId));
    await withTenantTx(a.db, a.orgId, (tx) =>
      pairPeer(tx, {
        orgId: a.orgId,
        domainId: self.domainId,
        name: b.orgName,
        role,
        publicKey: key.publicKey
      })
    );
  }

  async function commanderStatus() {
    return withTenantTx(commander.db, commander.orgId, (tx) =>
      getFederationStatus(tx, commander.orgId)
    );
  }

  async function outpostPeerStatus() {
    const status = await commanderStatus();
    const peer = status.peers.find((entry) => entry.peer.id === outpostSelf.domainId);
    expect(peer).toBeDefined();
    return { status, peer: peer! };
  }

  /** A local write, purely to advance THIS domain's own journal tail. */
  async function authorLocalObject(name: string): Promise<void> {
    await withTenantTx(commander.db, commander.orgId, (tx) =>
      createObject(tx, {
        orgId: commander.orgId,
        typeId: "service",
        actorObjectId: commander.orgId,
        requestId: `e3-${name}`,
        name
      })
    );
  }

  beforeAll(async () => {
    commander = await createIsolatedDomain("cmdrStat");
    outpost = await createIsolatedDomain("outpStat");
    await withTenantTx(commander.db, commander.orgId, (tx) =>
      initFederationSelf(tx, { orgId: commander.orgId, name: commander.orgName, role: "commander" })
    );
    outpostSelf = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      initFederationSelf(tx, { orgId: outpost.orgId, name: outpost.orgName, role: "outpost" })
    );
    await pair(commander, outpost, "outpost");
    await pair(outpost, commander, "commander");
  }, 120_000);

  afterAll(async () => {
    await commander?.close();
    await outpost?.close();
  });

  it("a peer with NO exports reports null — never 0-as-if-synced — and says so in unknownFields", async () => {
    await authorLocalObject("before-any-export");
    const { status, peer } = await outpostPeerStatus();

    // `0` here would read as "synced through the beginning of history", which is the specific lie
    // this nullability exists to prevent.
    expect(peer.lastExportedThroughSequence).toBeNull();
    expect(peer.lastExportedAt).toBeNull();
    expect(peer.lastExportedBundleChecksum).toBeNull();
    expect(peer.pendingExportEntryCount).toBeNull();
    // …and every one of those nulls is DECLARED, so a UI renders an honest unknown rather than
    // reading "0 pending" / "nothing to send".
    expect(peer.unknownFields).toContain("lastExportedThroughSequence");
    expect(peer.unknownFields).toContain("lastExportedBundleChecksum");
    expect(peer.unknownFields).toContain("pendingExportEntryCount");
    // No confirmed inbound bundle either, so there is no "as of ⟨bundle⟩" identifier to render.
    expect(peer.lastSyncedBundleChecksum).toBeNull();
    expect(peer.unknownFields).toContain("lastSyncedBundleChecksum");

    // The denominator is still reported: this domain HAS authored journal entries, it just has not
    // exported any of them to this peer.
    const tail = await withTenantTx(commander.db, commander.orgId, (tx) =>
      ownJournalTail(tx, commander.orgId)
    );
    expect(status.ownJournalTail).toBe(tail.sequence);
    expect(status.ownJournalTail).toBeGreaterThan(0);
  });

  it("after an export, the fields report the bundle we produced — its sequence, its identity, and zero pending", async () => {
    const bundle = await withTenantTx(commander.db, commander.orgId, (tx) =>
      exportSyncBundle(tx, commander.orgId, outpost.orgName)
    );
    const { status, peer } = await outpostPeerStatus();

    expect(peer.lastExportedThroughSequence).toBe(bundle.header.throughSequence);
    // The bundle's Ed25519 checksum IS the bundle's identity — the only stable per-bundle handle
    // this system has (M16.1 made it the per-change join key), and therefore what an honest
    // "as of ⟨bundle⟩" label names. Established here rather than assumed.
    expect(peer.lastExportedBundleChecksum).toBe(bundle.checksum);
    expect(peer.lastExportedAt).not.toBeNull();
    // Everything authored so far has been put on the wire, so nothing is pending EXPORT. This is not
    // a claim that the outpost applied any of it.
    expect(peer.pendingExportEntryCount).toBe(0);
    expect(status.ownJournalTail).toBe(bundle.header.throughSequence);
    // Nothing about the export family is unknown any more…
    expect(peer.unknownFields).not.toContain("lastExportedThroughSequence");
    expect(peer.unknownFields).not.toContain("pendingExportEntryCount");
    expect(peer.unknownFields).not.toContain("lastExportedBundleChecksum");
    // …but the promised-but-sourceless Overview fields still are, and always will be until something
    // actually observes them.
    expect(peer.unknownFields).toContain("healthRollup");
    expect(peer.unknownFields).toContain("appliedAtPeer");
  });

  it("a new local write makes the gap visible: pendingExportEntryCount counts OUR unexported entries", async () => {
    const beforeStatus = await outpostPeerStatus();
    const exportedThrough = beforeStatus.peer.lastExportedThroughSequence;
    expect(exportedThrough).not.toBeNull();

    await authorLocalObject("after-export-1");
    const { status, peer } = await outpostPeerStatus();

    // The high-water mark did NOT move (we exported nothing new) — the tail did, and the gap is the
    // difference. Computed from the observed tail rather than a magic constant, so the assertion
    // stays true regardless of how many journal entries one create happens to append.
    expect(peer.lastExportedThroughSequence).toBe(exportedThrough);
    expect(peer.pendingExportEntryCount).toBe(status.ownJournalTail! - exportedThrough!);
    expect(peer.pendingExportEntryCount).toBeGreaterThan(0);
  });

  it("THE HONESTY TEST: the outpost APPLYING the bundle does not move the commander's numbers", async () => {
    // Export everything currently pending, then have the outpost genuinely import and apply it.
    const bundle = await withTenantTx(commander.db, commander.orgId, (tx) =>
      exportSyncBundle(tx, commander.orgId, outpost.orgName)
    );
    const before = await outpostPeerStatus();
    expect(before.peer.pendingExportEntryCount).toBe(0);

    const result = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      importSyncBundle(tx, outpost.orgId, bundle)
    );
    expect(result.appliedEntries).toBeGreaterThan(0);

    const after = await outpostPeerStatus();
    // NOT ONE FIELD MOVED. That is the point: these fields measure what THIS side put on the wire,
    // and nothing in the commander's database can observe an apply at the peer. If a future change
    // made any of them respond to the peer's apply, it would be measuring something its name does
    // not claim — and this test would catch it.
    expect(after.peer.lastExportedThroughSequence).toBe(before.peer.lastExportedThroughSequence);
    expect(after.peer.lastExportedBundleChecksum).toBe(before.peer.lastExportedBundleChecksum);
    expect(after.peer.pendingExportEntryCount).toBe(before.peer.pendingExportEntryCount);
    expect(after.peer.lastSyncedAt).toBe(before.peer.lastSyncedAt);
    expect(after.peer.lastSyncedBundleChecksum).toBe(before.peer.lastSyncedBundleChecksum);
    expect(after.peer.unknownFields).toEqual(before.peer.unknownFields);

    // And there is no field NAMED for application AT THE PEER — structurally, not just by
    // convention. `appliedAtPeer` appears only as an UNKNOWN declaration.
    //
    // The pre-existing `lastAppliedSequence` is deliberately not caught by this: it is the INBOUND
    // direction — how far THIS side has applied the PEER's journal, read from our own `sync_cursors`
    // — which is genuinely observable here. Only the outbound direction is unobservable.
    const namedForPeerApply = Object.keys(after.peer).filter((key) =>
      /applied.*(peer|remote|there)|peerapplied|appliedat(?!tempt)/i.test(key)
    );
    expect(namedForPeerApply).toEqual([]);
    expect(Object.keys(after.peer)).toContain("lastAppliedSequence"); // the inbound one, unchanged
  });

  it("the RECEIVING side gets its honest 'as of ⟨bundle⟩': the confirmed import's own checksum", async () => {
    // The one place a bundle identity legitimately means "this much has been applied HERE" is the
    // importer's own database — which is why the inbound label lives on the receiving side.
    const status = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      getFederationStatus(tx, outpost.orgId)
    );
    const commanderPeer = status.peers.find((entry) => entry.peer.role === "commander");
    expect(commanderPeer).toBeDefined();
    expect(commanderPeer!.lastSyncedAt).not.toBeNull();
    expect(commanderPeer!.lastSyncedBundleChecksum).not.toBeNull();
    expect(commanderPeer!.unknownFields).not.toContain("lastSyncedBundleChecksum");
    // The outpost never exports to its commander in this scenario, so ITS export family is the
    // honest-null case — the mirror image of the first test.
    expect(commanderPeer!.lastExportedThroughSequence).toBeNull();
    expect(commanderPeer!.unknownFields).toContain("pendingExportEntryCount");
  });
});
