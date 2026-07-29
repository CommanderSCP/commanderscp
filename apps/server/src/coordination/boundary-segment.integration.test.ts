import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { BoundarySegment, PromotionBundle } from "@scp/schemas";
import { signBlob } from "@scp/cosign";
import { withTenantTx } from "../db/tenant-tx.js";
import { roleBindings, roles } from "../db/schema.js";
import { createObject } from "../graph/objects-repo.js";
import { ensureInstanceKey } from "../governance/attestation.js";
import {
  ensureInstanceCosignKey,
  getInstanceCosignPublicKey
} from "../governance/cosign-keys.js";
import { materializeApprovalRequest, castApprovalVote } from "../governance/approvals-repo.js";
import { ensureFederationSelf, type FederationSelf } from "../federation/self-repo.js";
import { pairPeer } from "../federation/peers-repo.js";
import { getCursor } from "../federation/cursors-repo.js";
import { exportSyncBundle } from "../federation/export-repo.js";
import { importSyncBundle } from "../federation/import-repo.js";
import {
  exportPromotionBundle,
  importPromotionBundle
} from "../federation/promotion-repo.js";
import type {
  ArtifactRegistryReader,
  ResolvedBlob
} from "../federation/artifact-verify.js";
import {
  createIsolatedDomain,
  type IsolatedDomain
} from "../federation/test-support/isolated-domain.js";
import { getChange, getChangeRow, proposeChange } from "./changes-repo.js";
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
 * federation journal entry kind carries a verification outcome back (`change_status` payloads are
 * lifecycle-only, and imported `audit_segment` entries are discarded on import). So the only honest
 * answers are `not_reported` plus a `validate.state` entry in `unknownFields`.
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
    commanderSelf = await withTenantTx(commander.db, commander.orgId, (tx) =>
      ensureFederationSelf(tx, commander.orgId)
    );
    await withTenantTx(outpost.db, outpost.orgId, (tx) => ensureFederationSelf(tx, outpost.orgId));
    await pair(commander, outpost, "outpost");
    await pair(outpost, commander, "commander");
    commanderCosignPrivateKey = (await ensureInstanceCosignKey(commander.db, commander.orgId))
      .privateKey;
  }, 180_000);

  afterAll(async () => {
    await commander.close();
    await outpost.close();
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
  function readerServing(blob: { bytes: Buffer; signature: string } | null): ArtifactRegistryReader {
    return {
      resolveOci: async () => null,
      resolveBlob: async (): Promise<ResolvedBlob | null> =>
        blob ? { bytes: blob.bytes, signature: blob.signature } : null
    };
  }

  /** Propose an APPROVED change in the commander that tracks one signed SBOM blob, and export it as
   *  a promotion bundle to the outpost. (A `blob` is EXEMPT from the M17.3 E6 export scan gate — it
   *  IS the scan's output — so the gate passes vacuously and no scan seeding is needed.) */
  async function promoteBlobChange(): Promise<{
    commanderChangeId: string;
    bundle: PromotionBundle;
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

    const outcome = await exportPromotionBundle(commander.db, {
      orgId: commander.orgId,
      peerIdOrName: outpost.orgName,
      changeIdOrUrn: change.id
    });
    if (outcome.refused) throw new Error(`unexpected export refusal: ${outcome.reason}`);
    return { commanderChangeId: change.id, bundle: outcome.bundle, blob };
  }

  const segmentAt = async (domain: IsolatedDomain, changeId: string) =>
    withTenantTx(domain.db, domain.orgId, async (tx) =>
      buildBoundarySegment(tx, domain.orgId, await getChange(tx, domain.orgId, changeId))
    );

  const runGateAtOutpost = (changeId: string, reader: ArtifactRegistryReader) =>
    withTenantTx(outpost.db, outpost.orgId, (tx) =>
      getChangeRow(tx, outpost.orgId, changeId)
    ).then((row) => runPreDeployArtifactGate(outpost.db, outpost.orgId, row, reader));

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
      checksum: bundle.checksum
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
      checksum: bundle.checksum
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
    expect(verified!.validate.verifiedArtifactCount).toBe(1);
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
      expect(segment.validate.verifiedArtifactCount, scenario).toBeNull();
      expect(segment.unknownFields, scenario).toContain("validate.state");
      // The transfer half of the same rule: an exporting instance never claims the peer received it.
      expect(segment.transfer.hops.every((h) => h.status === "created"), scenario).toBe(true);
    }
  });
});
