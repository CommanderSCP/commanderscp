import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { BoundarySegment, PromotionBundle } from "@scp/schemas";
import { signBlob, verifyBlob } from "@scp/cosign";
import { canonicalStringify } from "@scp/schemas/federation-journal";
import { withTenantTx } from "../db/tenant-tx.js";
import { roleBindings, roles } from "../db/schema.js";
import { createObject } from "../graph/objects-repo.js";
import { ensureInstanceKey } from "../governance/attestation.js";
import { ensureInstanceCosignKey, getInstanceCosignPublicKey } from "../governance/cosign-keys.js";
import { materializeApprovalRequest, castApprovalVote } from "../governance/approvals-repo.js";
import { ensureFederationSelf, type FederationSelf } from "../federation/self-repo.js";
import { pairPeer } from "../federation/peers-repo.js";
import { getCursor } from "../federation/cursors-repo.js";
import { exportSyncBundle } from "../federation/export-repo.js";
import { importSyncBundle } from "../federation/import-repo.js";
import { exportPromotionBundle, importPromotionBundle } from "../federation/promotion-repo.js";
import type { ArtifactRegistryReader, ResolvedBlob } from "../federation/artifact-verify.js";
import {
  createIsolatedDomain,
  type IsolatedDomain
} from "../federation/test-support/isolated-domain.js";
import {
  boundaryBundleChecksumsOf,
  promotionExportsOf
} from "../federation/boundary-bundle-ref.js";
import {
  getChange,
  getChangeRow,
  proposeChange,
  stampBoundaryBundleChecksum
} from "./changes-repo.js";
import { listDecisionsForSubject } from "./decisions-repo.js";
import { buildBoundarySegment } from "./boundary-segment.js";
import { runPreDeployArtifactGate } from "./pre-deploy-gate.js";

/**
 * M16.1 DoD — THE UNIVERSAL BOUNDARY SEGMENT over TWO FEDERATED DOMAINS (real Postgres via
 * Testcontainers, real Ed25519 federation crypto, real cosign).
 *
 * `docs/BUILD_AND_TEST.md` M16 "Done / verified by": *integration proves the pipeline surfaces a
 * REAL transfer + a real/absent validation outcome per change; never a fabricated pass.*
 *
 * The two domains are two GENUINELY SEPARATE Postgres databases (`test-support/isolated-domain.ts`)
 * — the faithful topology, because the whole point of this suite is that the COMMANDER's database
 * does not contain, and cannot contain, the outpost's observations. If both "domains" shared one
 * database the central claim would be untestable.
 *
 *   domainA = the COMMANDER (exports the promotion bundle)
 *   domainB = the receiving OUTPOST (imports it, and validates before deploy — ADR-0011)
 *
 * The artifact is a `blob` (the build-time SBOM shape), which lets the REAL cosign sign/verify path
 * run with an injected {@link ArtifactRegistryReader} and no registry container: `verifyOne`'s blob
 * branch hashes the resolved bytes against the manifest-authorized digest and then runs a real
 * `cosign verify-blob` against the EXPORTER's distributed public key. Nothing here touches the
 * internet.
 *
 * The load-bearing assertion is `commanderNeverClaimsVerified` below, applied after EVERY scenario.
 */

/** Every commander-side segment observed anywhere in this file, accumulated across scenarios. */
const commanderSegmentsSeen: { scenario: string; segment: BoundarySegment }[] = [];

/**
 * THE DoD's EXPLICIT ASSERTION: in NO scenario does a commander-side `boundarySegment` report the
 * validate phase as verified.
 *
 * The commander physically cannot know: validation happens at the receiving outpost, and no
 * federation journal entry kind carries a verification outcome back (a `change_status` payload
 * carries lifecycle plus the change's opaque `sourceRef`, no field of which is verification-shaped,
 * and imported `audit_segment` entries are discarded on import). So the only honest answers are
 * `not_reported` plus a `validate.state` entry in `unknownFields`.
 */
function commanderNeverClaimsVerified(scenario: string, segment: BoundarySegment): void {
  commanderSegmentsSeen.push({ scenario, segment });
  expect(segment.validate.state, `commander must not claim a verdict in: ${scenario}`).toBe(
    "not_reported"
  );
  expect(segment.validate.state).not.toBe("verified");
  expect(segment.validate.decisionId).toBeNull();
  expect(segment.unknownFields).toContain("validate.state");
}

describe("M16.1 boundary segment: two federated domains (Testcontainers)", () => {
  let commander: IsolatedDomain;
  let outpost: IsolatedDomain;
  /** A SECOND receiving peer. Exists only so the "one change, several peers" case — the case the
   *  `boundaryBundleChecksums` LIST shape exists for — is testable at all (scenario 6). */
  let outpostB: IsolatedDomain;
  let commanderSelf: FederationSelf;
  let commanderCosignPrivateKey: string;

  /** Pairs `from` -> `to`, registering `to`'s real Ed25519 + cosign public keys (the post-E5 setup
   *  the M17.4(a) import verify and the M17.4(b) pre-deploy verify both need). */
  async function pair(
    from: IsolatedDomain,
    to: IsolatedDomain,
    role: "outpost" | "commander"
  ): Promise<void> {
    const key = await withTenantTx(to.db, to.orgId, (tx) => ensureInstanceKey(tx, to.orgId));
    const self = await withTenantTx(to.db, to.orgId, (tx) => ensureFederationSelf(tx, to.orgId));
    const { publicKey: cosignPublicKey } = await getInstanceCosignPublicKey(to.db, to.orgId);
    await withTenantTx(from.db, from.orgId, (tx) =>
      pairPeer(tx, {
        orgId: from.orgId,
        domainId: self.domainId,
        name: to.orgName,
        role,
        publicKey: key.publicKey,
        cosignPublicKey
      })
    );
  }

  beforeAll(async () => {
    commander = await createIsolatedDomain("m161commander");
    outpost = await createIsolatedDomain("m161outpost");
    outpostB = await createIsolatedDomain("m161outpostb");
    commanderSelf = await withTenantTx(commander.db, commander.orgId, (tx) =>
      ensureFederationSelf(tx, commander.orgId)
    );
    await withTenantTx(outpost.db, outpost.orgId, (tx) => ensureFederationSelf(tx, outpost.orgId));
    await withTenantTx(outpostB.db, outpostB.orgId, (tx) =>
      ensureFederationSelf(tx, outpostB.orgId)
    );
    await pair(commander, outpost, "outpost");
    await pair(outpost, commander, "commander");
    await pair(commander, outpostB, "outpost");
    commanderCosignPrivateKey = (await ensureInstanceCosignKey(commander.db, commander.orgId))
      .privateKey;
  }, 180_000);

  afterAll(async () => {
    await commander.close();
    await outpost.close();
    await outpostB.close();
  });

  // -------------------------------------------------------------------------------------------
  // Fixture helpers
  // -------------------------------------------------------------------------------------------

  /** A minimal `user` + Approver role binding, so `castApprovalVote`'s eligibility check passes. */
  async function createApprover(domain: IsolatedDomain): Promise<string> {
    return withTenantTx(domain.db, domain.orgId, async (tx) => {
      const user = await createObject(tx, {
        orgId: domain.orgId,
        domainId: null,
        typeId: "user",
        actorObjectId: domain.orgId,
        requestId: "m161-approver",
        name: `approver-${randomUUID()}`
      });
      const role = await tx.query.roles.findFirst({
        where: and(isNull(roles.orgId), eq(roles.name, "Approver"))
      });
      if (!role) throw new Error("built-in role 'Approver' not found");
      await tx.insert(roleBindings).values({
        id: uuidv7(),
        orgId: domain.orgId,
        subjectId: user.id,
        roleId: role.id,
        scopeObjectId: domain.orgId,
        effect: "allow"
      });
      return user.id;
    });
  }

  /** Creates a promotion target in the commander and REPLICATES it to the outpost, so the promotion
   *  bundle's target resolves there (single-writer authority: same object id both sides). */
  async function createReplicatedTarget(): Promise<string> {
    const target = await withTenantTx(commander.db, commander.orgId, (tx) =>
      createObject(tx, {
        orgId: commander.orgId,
        domainId: null,
        typeId: "service",
        actorObjectId: commander.orgId,
        requestId: "m161-target",
        name: `m161-target-${randomUUID()}`
      })
    );
    const cursor = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      getCursor(tx, outpost.orgId, commanderSelf.domainId, commanderSelf.domainId)
    );
    const syncBundle = await withTenantTx(commander.db, commander.orgId, (tx) =>
      exportSyncBundle(tx, commander.orgId, outpost.orgName, cursor.sequence)
    );
    await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      importSyncBundle(tx, outpost.orgId, syncBundle)
    );
    return target.id;
  }

  /** The signed SBOM blob a promotion carries: real bytes, real digest, real detached cosign
   *  signature made with the COMMANDER's own manifest-signing key (the key the outpost has). */
  async function signedBlob(): Promise<{ bytes: Buffer; digest: string; signature: string }> {
    const bytes = Buffer.from(`{"bomFormat":"CycloneDX","serial":"${randomUUID()}"}`);
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const signature = await signBlob(bytes, commanderCosignPrivateKey);
    return { bytes, digest, signature };
  }

  /** An {@link ArtifactRegistryReader} serving exactly the bytes/signature it is given — the seam
   *  the production `LocationRegistryReader` fills from the outpost's local registry. Injecting it
   *  keeps the REAL cosign verification while needing no registry container and no network. */
  function readerServing(
    blob: { bytes: Buffer; signature: string } | null
  ): ArtifactRegistryReader {
    return {
      resolveOci: async () => null,
      resolveBlob: async (): Promise<ResolvedBlob | null> =>
        blob ? { bytes: blob.bytes, signature: blob.signature } : null
    };
  }

  /** Propose an APPROVED change in the commander that tracks one signed SBOM blob — everything
   *  {@link promoteBlobChange} does EXCEPT the export, so a test can drive the export itself (e.g.
   *  to two peers at once). (A `blob` is EXEMPT from the M17.3 E6 export scan gate — it IS the
   *  scan's output — so the gate passes vacuously and no scan seeding is needed.) */
  async function approvedBlobChange(): Promise<{
    changeId: string;
    blob: { bytes: Buffer; digest: string; signature: string };
  }> {
    const targetId = await createReplicatedTarget();
    const approverId = await createApprover(commander);
    const blob = await signedBlob();

    const { change } = await withTenantTx(commander.db, commander.orgId, (tx) =>
      proposeChange(tx, {
        orgId: commander.orgId,
        actorObjectId: commander.orgId,
        requestId: `m161-change-${randomUUID()}`,
        name: `m161 promotion ${randomUUID().slice(0, 8)}`,
        targets: [targetId],
        sourceRef: {
          sbom: {
            digest: blob.digest,
            location: `https://sbom.invalid/${blob.digest}`,
            format: "cyclonedx",
            signatureRef: `https://sbom.invalid/${blob.digest}.sig`
          }
        }
      })
    );
    await withTenantTx(commander.db, commander.orgId, async (tx) => {
      const req = await materializeApprovalRequest(tx, {
        orgId: commander.orgId,
        changeObjectId: change.id,
        policyObjectId: targetId,
        policyVersion: 1,
        effectIndex: 0,
        requiredCount: 1,
        fromRole: "Approver",
        scopeObjectId: commander.orgId
      });
      await castApprovalVote(tx, {
        orgId: commander.orgId,
        approvalRequestId: req.id,
        voterObjectId: approverId,
        requestId: `m161-vote-${randomUUID()}`
      });
    });

    return { changeId: change.id, blob };
  }

  /** {@link approvedBlobChange} + the export of it to `peer` as a promotion bundle. */
  async function exportTo(peer: IsolatedDomain, changeId: string): Promise<PromotionBundle> {
    const outcome = await exportPromotionBundle(commander.db, {
      orgId: commander.orgId,
      peerIdOrName: peer.orgName,
      changeIdOrUrn: changeId
    });
    if (outcome.refused) throw new Error(`unexpected export refusal: ${outcome.reason}`);
    return outcome.bundle;
  }

  async function promoteBlobChange(): Promise<{
    commanderChangeId: string;
    bundle: PromotionBundle;
    blob: { bytes: Buffer; digest: string; signature: string };
  }> {
    const { changeId, blob } = await approvedBlobChange();
    return { commanderChangeId: changeId, bundle: await exportTo(outpost, changeId), blob };
  }

  const segmentAt = async (domain: IsolatedDomain, changeId: string) =>
    withTenantTx(domain.db, domain.orgId, async (tx) =>
      buildBoundarySegment(tx, domain.orgId, await getChange(tx, domain.orgId, changeId))
    );

  const runGateAtOutpost = (changeId: string, reader: ArtifactRegistryReader) =>
    withTenantTx(outpost.db, outpost.orgId, (tx) => getChangeRow(tx, outpost.orgId, changeId)).then(
      (row) => runPreDeployArtifactGate(outpost.db, outpost.orgId, row, reader)
    );

  // -------------------------------------------------------------------------------------------
  // (1) THE REAL TRANSFER, both sides — and the commander's honest silence about validation.
  // -------------------------------------------------------------------------------------------

  it("surfaces a REAL transfer per change on BOTH sides, joined by the real bundle checksum", async () => {
    const { commanderChangeId, bundle } = await promoteBlobChange();

    // --- COMMANDER SIDE, right after export. -------------------------------------------------
    const exported = await segmentAt(commander, commanderChangeId);
    expect(exported).not.toBeNull();
    // A REAL transfer: the hop is the actual `bundle_transfers` row, carrying the actual Ed25519
    // checksum of the bundle that was produced — the per-change join (M16.1 I1), not a placeholder.
    expect(exported!.transfer.state).toBe("exported");
    expect(exported!.transfer.hops).toHaveLength(1);
    expect(exported!.transfer.hops[0]).toMatchObject({
      direction: "export",
      status: "created",
      checksum: bundle.checksum,
      // drizzle/0087 — an ordinary `.scpbundle` promotion export, threaded from the ledger row
      // through `boundary-segment.ts` — never the retrans byte-relay channel.
      channel: "metadata"
    });
    expect(exported!.transfer.observedAt).toEqual(expect.any(String));
    // THE INSERT-ONLY LEDGER: `created` is the only status this side can ever hold, so the handoff
    // is declared unobservable rather than rendered as a delivery.
    expect(exported!.unknownFields).toContain("transfer.handoff");
    commanderNeverClaimsVerified("after export, before import", exported!);

    // --- OUTPOST SIDE, after import. ---------------------------------------------------------
    const imported = await importPromotionBundle(outpost.db, outpost.orgId, bundle);
    const received = await segmentAt(outpost, imported.localChangeObjectId);
    expect(received).not.toBeNull();
    expect(received!.transfer.state).toBe("received");
    expect(received!.transfer.hops).toHaveLength(1);
    expect(received!.transfer.hops[0]).toMatchObject({
      direction: "import",
      status: "confirmed",
      checksum: bundle.checksum,
      // drizzle/0087 — the metadata leg, same as the export side of this same bundle.
      channel: "metadata"
    });
    // The receiving side observed the arrival itself, so nothing about the transfer is unknown here.
    expect(received!.unknownFields).not.toContain("transfer.handoff");

    // NOT YET VERIFIED — a real local observation of an absence, and emphatically not a pass: the
    // outpost's pre-deploy verify has not run. This is the state the ADR calls "not yet verified".
    expect(received!.validate.state).toBe("not_yet_verified");
    expect(received!.validate.decisionId).toBeNull();
    expect(received!.unknownFields).not.toContain("validate.state");

    // ...and the commander's view is UNCHANGED by the outpost having received and not-yet-verified
    // it. That is the point: the two databases are separate and nothing flows back.
    commanderNeverClaimsVerified(
      "after the outpost imported it",
      (await segmentAt(commander, commanderChangeId))!
    );
  }, 240_000);

  // -------------------------------------------------------------------------------------------
  // (2) A REAL validation outcome at the receiving outpost — and STILL nothing at the commander.
  // -------------------------------------------------------------------------------------------

  it("surfaces a REAL `verified` outcome at the receiving outpost — while the commander still says 'not reported'", async () => {
    const { commanderChangeId, bundle, blob } = await promoteBlobChange();
    const imported = await importPromotionBundle(outpost.db, outpost.orgId, bundle);

    // The genuine M17.4(b) pre-deploy verify, with the real bytes and the real detached cosign
    // signature resolvable: real `cosign verify-blob` against the EXPORTER's distributed key.
    const gate = await runGateAtOutpost(imported.localChangeObjectId, readerServing(blob));
    expect(gate.blocked).toBe(false);
    expect(gate.decisionId).toEqual(expect.any(String)); // M16.1 I2 — the pass is now RECORDED.

    const verified = await segmentAt(outpost, imported.localChangeObjectId);
    expect(verified!.validate.state).toBe("verified");
    expect(verified!.validate.decisionId).toBe(gate.decisionId);
    expect(verified!.validate.observedAt).toEqual(expect.any(String));
    expect(verified!.validate.authorizedArtifactCount).toBe(1);
    expect(verified!.unknownFields).toEqual([]); // the outpost can see everything it reports

    // THE CENTRAL CLAIM. A real verification just succeeded — at the OUTPOST. The commander has no
    // data path to that outcome, so its segment is byte-for-byte as honest as before.
    commanderNeverClaimsVerified(
      "after the outpost genuinely verified the artifacts",
      (await segmentAt(commander, commanderChangeId))!
    );
  }, 240_000);

  // -------------------------------------------------------------------------------------------
  // (3) A REFUSED validation is surfaced as a refusal — never as unknown, never as a pass.
  // -------------------------------------------------------------------------------------------

  it("surfaces a REFUSED validation with its decision_id, and the commander still says 'not reported'", async () => {
    const { commanderChangeId, bundle } = await promoteBlobChange();
    const imported = await importPromotionBundle(outpost.db, outpost.orgId, bundle);

    // Bytes absent from the reachable registry — the fail-closed case. A real block Decision.
    const gate = await runGateAtOutpost(imported.localChangeObjectId, readerServing(null));
    expect(gate.blocked).toBe(true);

    const refused = await segmentAt(outpost, imported.localChangeObjectId);
    expect(refused!.validate.state).toBe("refused");
    // Charter principle 6: the refusal is explainable — the Decision id is on the wire.
    expect(refused!.validate.decisionId).toBe(gate.decisionId);
    expect(refused!.transfer.state).toBe("received"); // the transfer really did happen

    // THE COUNT IS NULL ON A REFUSAL. This promotion authorized exactly ONE artifact and ZERO were
    // verified — the bytes were absent. The count is sourced from the Decision's
    // `inputContext.authorizedArtifacts`, i.e. the set the gate was ASKED to check, which on a
    // block still contains every artifact that failed. Reporting `1` beside a refusal states an
    // artifact count where nothing verified, which is exactly the claim class this segment exists
    // to prevent — and the API is the parity surface (charter principle 3), so a correct schema doc
    // and a correct UI label do not excuse it. Suppressed at the source instead.
    expect(refused!.validate.authorizedArtifactCount).toBeNull();
    // ...and the refusal's real artifact story stays reachable, via the Decision the id points at.
    const blockDecision = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      listDecisionsForSubject(tx, outpost.orgId, imported.localChangeObjectId)
    ).then((ds) => ds.find((d) => d.id === gate.decisionId));
    expect(blockDecision?.verdict).toBe("block");
    expect((blockDecision?.inputContext.authorizedArtifacts as unknown[]).length).toBe(1);
    expect((blockDecision?.inputContext.failing as unknown[]).length).toBe(1);

    commanderNeverClaimsVerified(
      "after the outpost REFUSED the artifacts",
      (await segmentAt(commander, commanderChangeId))!
    );
  }, 240_000);

  // -------------------------------------------------------------------------------------------
  // (4) A DOMAIN-LOCAL change has NO segment — absent, not a fabricated empty pass.
  // -------------------------------------------------------------------------------------------

  it("returns NO segment for a domain-local change — absent, not an empty pass", async () => {
    const targetId = await createReplicatedTarget();
    const { change } = await withTenantTx(commander.db, commander.orgId, (tx) =>
      proposeChange(tx, {
        orgId: commander.orgId,
        actorObjectId: commander.orgId,
        requestId: `m161-local-${randomUUID()}`,
        name: `m161 domain-local ${randomUUID().slice(0, 8)}`,
        targets: [targetId]
      })
    );

    // Never exported, never imported: it has not crossed a boundary, so there IS no segment. The
    // alternative — an all-green empty segment — would be the fabrication this milestone exists to
    // prevent, and `null` is what the UI turns into an explicit "has not crossed a domain boundary".
    expect(await segmentAt(commander, change.id)).toBeNull();
  }, 120_000);

  // -------------------------------------------------------------------------------------------
  // (6) ONE CHANGE, SEVERAL PEERS — the case the checksum LIST shape exists for, CONCURRENTLY.
  //
  // `stampBoundaryBundleChecksum` is a read-modify-write of the opaque JSONB `changes.sourceRef`,
  // and `exportPromotionBundle` takes no per-change advisory lock (unlike reconcile, which guards
  // every change with `tryAcquireChangeCoordinationLock`). Under READ COMMITTED an UNLOCKED read
  // lets two exporters both see the pre-stamp value; the second blocks on the row lock at UPDATE
  // time but still writes from its stale snapshot, silently erasing the first peer's checksum.
  // The segment would then show ONE hop where TWO real exports happened — a real transfer deleted
  // from the read model whose entire purpose is to not overclaim, and a direct contradiction of
  // `boundary-bundle-ref.ts`'s "Several peers => several checksums, hence a list."
  // -------------------------------------------------------------------------------------------

  it("two OVERLAPPING stamps of one change both survive — the second must not clobber the first", async () => {
    // The deterministic form of the race, driven at the repo seam so the interleaving is exact
    // rather than hoped for: tx1 stamps and STAYS OPEN holding the row's write lock while tx2
    // starts. Under READ COMMITTED tx2's read returns the pre-tx1 committed value (`[]`) no matter
    // when within this window it lands, so an UNLOCKED read makes the loss certain here, not
    // probabilistic. `FOR UPDATE` instead parks tx2 AT THE READ until tx1 commits, after which it
    // re-reads `[A]` and appends.
    const { changeId } = await approvedBlobChange();
    const CHECKSUM_A = `a${"0".repeat(63)}`;
    const CHECKSUM_B = `b${"0".repeat(63)}`;

    let second!: Promise<void>;
    await withTenantTx(commander.db, commander.orgId, async (tx) => {
      await stampBoundaryBundleChecksum(tx, commander.orgId, changeId, CHECKSUM_A);
      second = withTenantTx(commander.db, commander.orgId, (tx2) =>
        stampBoundaryBundleChecksum(tx2, commander.orgId, changeId, CHECKSUM_B)
      );
      // Long enough for tx2 to reach its read; tx1 does not commit until this resolves, so the
      // window tx2 must land inside is bounded below by this sleep and not by scheduler luck.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    });
    await second;

    const row = await withTenantTx(commander.db, commander.orgId, (tx) =>
      getChangeRow(tx, commander.orgId, changeId)
    );
    // BOTH, in order. Not `[CHECKSUM_B]` — that is the lost update.
    expect(boundaryBundleChecksumsOf(row.sourceRef)).toEqual([CHECKSUM_A, CHECKSUM_B]);
  }, 240_000);

  it("exporting ONE change to TWO peers CONCURRENTLY keeps both real hops in the segment", async () => {
    // The same race through the PRODUCTION path: two genuinely concurrent `exportPromotionBundle`
    // calls for one change to two different air-gapped peers — the ordinary shape of a fan-out
    // export, not a contrived one.
    //
    // WHAT THIS TEST IS AND IS NOT. It is the end-to-end net: it proves the two real exports really
    // do compose through `exportPromotionBundle` -> `stampBoundaryBundleChecksum` and that the
    // segment shows both hops. It is NOT the race detector — its interleaving is at the scheduler's
    // mercy (verified: with the `FOR UPDATE` removed, THIS test still passed while the
    // deterministic one above went red). The deterministic test is what pins the fix; this one
    // pins the production wiring around it, and can only ever fail if something is genuinely wrong.
    const { changeId } = await approvedBlobChange();
    const [bundleA, bundleB] = await Promise.all([
      exportTo(outpost, changeId),
      exportTo(outpostB, changeId)
    ]);
    expect(bundleA.checksum).not.toBe(bundleB.checksum); // different peers ⇒ different bundles

    const row = await withTenantTx(commander.db, commander.orgId, (tx) =>
      getChangeRow(tx, commander.orgId, changeId)
    );
    expect(boundaryBundleChecksumsOf(row.sourceRef).sort()).toEqual(
      [bundleA.checksum, bundleB.checksum].sort()
    );

    // ...and therefore the SEGMENT reports both hops. This is the user-visible consequence: with
    // one checksum lost, `listTransfersByChecksums` returns one row and the segment silently drops
    // a real export.
    const segment = await segmentAt(commander, changeId);
    expect(segment!.transfer.state).toBe("exported");
    expect(segment!.transfer.hops).toHaveLength(2);
    expect(segment!.transfer.hops.map((h) => h.checksum).sort()).toEqual(
      [bundleA.checksum, bundleB.checksum].sort()
    );
    expect(new Set(segment!.transfer.hops.map((h) => h.peerDomainId)).size).toBe(2);
    commanderNeverClaimsVerified("after a concurrent fan-out export to two peers", segment!);
  }, 240_000);

  // -------------------------------------------------------------------------------------------
  // (7) §9.4 (pipeline-substrate-registry-scan.md) — WHAT THE COMMANDER SIGNED is persisted at
  // export, beside the checksum, under the SAME lock. Before this the exporter kept nothing of the
  // manifest or its signature (only the importer did), so the commander could say "exported" and
  // never "signed what, for whom, with which key".
  // -------------------------------------------------------------------------------------------

  it("§9.4: exporting ONE change to TWO peers stamps TWO `promotionExports[]` records, and each manifestSignature verifies with the instance public key", async () => {
    const { changeId } = await approvedBlobChange();
    const [bundleA, bundleB] = await Promise.all([
      exportTo(outpost, changeId),
      exportTo(outpostB, changeId)
    ]);

    const row = await withTenantTx(commander.db, commander.orgId, (tx) =>
      getChangeRow(tx, commander.orgId, changeId)
    );
    const stamped = promotionExportsOf(row.sourceRef);
    expect(stamped.unparseable, "every stamp parses back through the stamp schema").toBe(0);
    expect(
      stamped.entries,
      "two exports ⇒ two records — the concurrent one was not clobbered"
    ).toHaveLength(2);

    // Each record is THE record of its export: keyed to the same checksum the ledger join carries,
    // addressed to that peer, holding the very manifest + signature the bundle carried.
    for (const bundle of [bundleA, bundleB]) {
      const rec = stamped.entries.find((e) => e.checksum === bundle.checksum);
      expect(rec, `a record for checksum ${bundle.checksum}`).toBeDefined();
      expect(rec!.peerDomainId).toBe(bundle.header.peerDomainId);
      expect(rec!.exportedAt).toBe(bundle.header.exportedAt);
      expect(rec!.manifest).toEqual(bundle.promotionManifest);
      expect(rec!.manifestSignature).toBe(bundle.manifestSignature);
    }
    expect(new Set(stamped.entries.map((e) => e.peerDomainId)).size).toBe(2);
    // The two lists share the join key — a checksum in one is in the other.
    expect(boundaryBundleChecksumsOf(row.sourceRef).sort()).toEqual(
      stamped.entries.map((e) => e.checksum).sort()
    );

    // The signature is REAL and verifies against the instance key whose fingerprint the record names.
    const cosignPub = await getInstanceCosignPublicKey(commander.db, commander.orgId);
    for (const rec of stamped.entries) {
      expect(rec.keyFingerprint).toBe(cosignPub.fingerprint);
      expect(
        await verifyBlob(
          canonicalStringify(rec.manifest),
          rec.manifestSignature,
          cosignPub.publicKey
        ),
        "the persisted signature verifies over the persisted manifest"
      ).toBe(true);
      // Negative control: the persisted signature is bound to THIS manifest, not any manifest.
      const other = stamped.entries.find((e) => e.checksum !== rec.checksum)!;
      expect(
        await verifyBlob(
          canonicalStringify(other.manifest),
          rec.manifestSignature,
          cosignPub.publicKey
        )
      ).toBe(false);
    }

    // The exported PAYLOAD never carries the local stamps — one peer's signed manifest is not
    // another peer's business, and a re-export stays byte-identical to a first export.
    // (`bundleB` was gathered concurrently, so assert on a THIRD, strictly-later export.)
    const again = await exportTo(outpost, changeId);
    expect(again.change.sourceRef).not.toHaveProperty("promotionExports");
    expect(again.change.sourceRef).not.toHaveProperty("boundaryBundleChecksums");
    // ...and that third export is a THIRD record (a new `exportedAt` ⇒ a new checksum ⇒ a new
    // export, appended after the two — append order is the wire's "newest last").
    const rowAfter = await withTenantTx(commander.db, commander.orgId, (tx) =>
      getChangeRow(tx, commander.orgId, changeId)
    );
    const after = promotionExportsOf(rowAfter.sourceRef).entries;
    expect(after).toHaveLength(3);
    expect(after[2]!.checksum).toBe(again.checksum);
  }, 240_000);

  // -------------------------------------------------------------------------------------------
  // (5) THE DoD's EXPLICIT ASSERTION, restated over everything the suite observed.
  // -------------------------------------------------------------------------------------------

  it("EXPLICIT DoD ASSERTION: in NO scenario did a commander-side segment report the validate phase as verified", () => {
    // Guards against the whole file silently degrading into vacuity (e.g. every scenario failing to
    // produce a commander segment at all): the census must be non-empty AND cover the scenarios in
    // which a REAL verification, and a REAL refusal, happened at the outpost.
    expect(commanderSegmentsSeen.length).toBeGreaterThanOrEqual(4);
    expect(commanderSegmentsSeen.map((s) => s.scenario)).toContain(
      "after the outpost genuinely verified the artifacts"
    );
    expect(commanderSegmentsSeen.map((s) => s.scenario)).toContain(
      "after the outpost REFUSED the artifacts"
    );
    for (const { scenario, segment } of commanderSegmentsSeen) {
      expect(segment.validate.state, scenario).not.toBe("verified");
      expect(segment.validate.decisionId, scenario).toBeNull();
      expect(segment.validate.authorizedArtifactCount, scenario).toBeNull();
      expect(segment.unknownFields, scenario).toContain("validate.state");
      // The transfer half of the same rule: an exporting instance never claims the peer received it.
      expect(
        segment.transfer.hops.every((h) => h.status === "created"),
        scenario
      ).toBe(true);
    }
  });
});
