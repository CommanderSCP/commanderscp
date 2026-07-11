import { randomUUID, generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { SyncBundle, SyncScope } from "@scp/schemas";
import { withTenantTx } from "../db/tenant-tx.js";
import { roleBindings, roles } from "../db/schema.js";
import { createObject, getObjectByIdOrUrnAnyType, updateObject } from "../graph/objects-repo.js";
import { ensureInstanceKey } from "../governance/attestation.js";
import { ensureFederationSelf, type FederationSelf } from "./self-repo.js";
import { pairPeer } from "./peers-repo.js";
import { exportSyncBundle } from "./export-repo.js";
import { importSyncBundle } from "./import-repo.js";
import { exportPromotionBundle, importPromotionBundle } from "./promotion-repo.js";
import { getCursor } from "./cursors-repo.js";
import { createOverlay, getMergedOverlayView } from "./overlay-repo.js";
import { handFillObject } from "./handfill-repo.js";
import { proposeChange } from "../coordination/changes-repo.js";
import { materializeApprovalRequest, castApprovalVote } from "../governance/approvals-repo.js";
import { createIsolatedDomain, type IsolatedDomain } from "./test-support/isolated-domain.js";
import {
  computeBundleChecksum,
  signBundleChecksum,
  computeJournalRowHash,
  signJournalRowHash
} from "@scp/schemas/federation-journal";
import type { PromotionBundle } from "@scp/schemas";

/**
 * M6 Federation Basics — Testcontainers integration coverage (BUILD_AND_TEST.md §8 M6 DoD).
 *
 * Each "domain" is a GENUINELY SEPARATE Postgres DATABASE (test-support/isolated-domain.ts),
 * within the same Testcontainers container — faithfully matching DESIGN.md §13's real topology
 * (two federation domains are two separate SCP instances, each with its OWN database; there is no
 * shared `objects` table between them). This also sidesteps a real structural fact this milestone
 * surfaced: `objects.id` is a single GLOBAL primary key (not composite with `org_id`), which is
 * completely safe within one instance's one database but would collide the moment two "domains"
 * sharing ONE physical table tried to replicate the SAME id (exactly what federation import does
 * by design, for single-writer authority) into each other's rows.
 *
 * The real two-domain E2E (scripts/e2e-m6.sh) additionally proves this holds across two actually
 * separate scpd+postgres COMPOSE stacks with no network path between them at all; this file
 * covers the cryptographic/authority logic exhaustively at the integration layer, where
 * Testcontainers makes tight iteration and adversarial tampering easy to express.
 */

/** Rebuilds a promotion bundle's OUTER checksum/signature over tampered content, using the
 *  EXPORTING domain's real key — simulating "the exporting domain itself included a bad
 *  attestation" (a bug, or a malicious/compromised exporter), which is a DIFFERENT threat than
 *  "someone tampered with an otherwise-legitimate bundle in transit" (already covered by the
 *  sync-bundle tamper tests). Without this, mutating `bundle.approvals` post-hoc leaves the OUTER
 *  checksum stale, so `importPromotionBundle`'s bundle-level check rejects it before ever
 *  reaching the per-attestation validation this is meant to exercise. */
function resignPromotionBundle(
  bundle: PromotionBundle,
  exporterPrivateKeyB64: string
): PromotionBundle {
  const checksumPayload = {
    header: bundle.header,
    change: bundle.change,
    controlOutcomes: bundle.controlOutcomes,
    approvals: bundle.approvals,
    artifactDigests: bundle.artifactDigests
  };
  const checksum = computeBundleChecksum(checksumPayload);
  const bundleSignature = signBundleChecksum(exporterPrivateKeyB64, checksum);
  return { ...bundle, checksum, bundleSignature };
}

/** A fresh Ed25519 keypair in the same base64-DER encoding federation stores keys in — used to
 *  model a NEW key a peer rotates TO (the attacker never holds its private half). */
function generateEd25519KeypairB64(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64")
  };
}

async function pair(
  a: IsolatedDomain,
  b: IsolatedDomain,
  role: "child" | "parent",
  syncScope?: SyncScope
) {
  const key = await withTenantTx(b.db, b.orgId, (tx) => ensureInstanceKey(tx, b.orgId));
  const self = await withTenantTx(b.db, b.orgId, (tx) => ensureFederationSelf(tx, b.orgId));
  await withTenantTx(a.db, a.orgId, (tx) =>
    pairPeer(tx, {
      orgId: a.orgId,
      domainId: self.domainId,
      name: b.orgName,
      role,
      publicKey: key.publicKey,
      syncScope
    })
  );
}

/** A minimal graph `user` object + role binding — everything `castApprovalVote`'s eligibility
 *  check needs, without the full login/session machinery `test-support/harness.ts`'s
 *  `createTestUser` provides (irrelevant here — every federation call in this file goes straight
 *  through repo functions, never HTTP). */
async function createApprover(
  domain: IsolatedDomain,
  roleName: string
): Promise<{ objectId: string }> {
  const objectId = await withTenantTx(domain.db, domain.orgId, async (tx) => {
    const userObject = await createObject(tx, {
      orgId: domain.orgId,
      domainId: null,
      typeId: "user",
      actorObjectId: domain.orgId,
      requestId: "test-approver-setup",
      name: `approver-${randomUUID()}`
    });
    const role = await tx.query.roles.findFirst({
      where: and(isNull(roles.orgId), eq(roles.name, roleName))
    });
    if (!role) throw new Error(`built-in role '${roleName}' not found`);
    await tx.insert(roleBindings).values({
      id: uuidv7(),
      orgId: domain.orgId,
      subjectId: userObject.id,
      roleId: role.id,
      scopeObjectId: domain.orgId,
      effect: "allow"
    });
    return userObject.id;
  });
  return { objectId };
}

describe("M6 Federation: two-domain sync (Testcontainers)", () => {
  let domainA: IsolatedDomain;
  let domainB: IsolatedDomain;
  let selfA: FederationSelf;
  let selfB: FederationSelf;

  beforeAll(async () => {
    domainA = await createIsolatedDomain("domainA");
    domainB = await createIsolatedDomain("domainB");

    selfA = await withTenantTx(domainA.db, domainA.orgId, (tx) =>
      ensureFederationSelf(tx, domainA.orgId)
    );
    selfB = await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      ensureFederationSelf(tx, domainB.orgId)
    );

    // Pairing is always initiated FROM each side (DESIGN §13 child-initiated-only, or an
    // out-of-band exchange for air-gapped peers) — never a live handshake one side pushes onto
    // the other. Both sides register each other explicitly with the real exchanged public keys.
    await pair(domainA, domainB, "child");
    await pair(domainB, domainA, "parent");
  }, 60_000);

  afterAll(async () => {
    await domainA.close();
    await domainB.close();
  });

  it("two-domain round trip: export A -> import B -> graph equivalence, as a read-only replica", async () => {
    const created = await withTenantTx(domainA.db, domainA.orgId, (tx) =>
      createObject(tx, {
        orgId: domainA.orgId,
        domainId: null,
        typeId: "service",
        actorObjectId: domainA.orgId,
        requestId: "t-create",
        name: "billing-service",
        properties: { tier: "critical" }
      })
    );

    const bundle = await withTenantTx(domainA.db, domainA.orgId, (tx) =>
      exportSyncBundle(tx, domainA.orgId, domainB.orgName)
    );
    expect(bundle.entries.length).toBeGreaterThan(0);

    const result = await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      importSyncBundle(tx, domainB.orgId, bundle)
    );
    expect(result.appliedEntries).toBe(bundle.entries.length);

    const replica = await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      getObjectByIdOrUrnAnyType(tx, domainB.orgId, created.id)
    );
    expect(replica.urn).toBe(created.urn);
    expect(replica.name).toBe("billing-service");
    expect(replica.properties.tier).toBe("critical");
    // The replica carries A's domain id as its authoritative origin — never B's own.
    expect(replica.originDomainId).toBe(selfA.domainId);
    expect(replica.originDomainId).not.toBe(selfB.domainId);
  });

  it("double-import is a no-op: re-applying the exact same bundle changes nothing and reports it as skipped", async () => {
    const bundle = await withTenantTx(domainA.db, domainA.orgId, (tx) =>
      exportSyncBundle(tx, domainA.orgId, domainB.orgName)
    );
    const first = await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      importSyncBundle(tx, domainB.orgId, bundle)
    );
    const second = await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      importSyncBundle(tx, domainB.orgId, bundle)
    );
    expect(second.appliedEntries).toBe(0);
    expect(second.skippedEntries).toBe(bundle.entries.length);
    expect(second.lastAppliedSequence).toBe(first.lastAppliedSequence);
  });

  it("interrupted-transfer resume from cursor: two genuinely separate exports, applied sequentially, converge exactly like one full import", async () => {
    // Chunk 1: create + export + import ONE object — this is "the transfer that completed before
    // the interruption." A signed bundle's checksum covers ALL of its own entries, so a realistic
    // resume is a SECOND, independently-signed export continuing from the cursor the first one
    // left behind — not a client-side slice of one bundle (which would invalidate its signature).
    const cursorStart = await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      getCursor(tx, domainB.orgId, selfA.domainId, selfA.domainId)
    );
    await withTenantTx(domainA.db, domainA.orgId, (tx) =>
      createObject(tx, {
        orgId: domainA.orgId,
        domainId: null,
        typeId: "service",
        actorObjectId: domainA.orgId,
        requestId: "t-r1",
        name: "resume-svc-1"
      })
    );
    const chunk1 = await withTenantTx(domainA.db, domainA.orgId, (tx) =>
      exportSyncBundle(tx, domainA.orgId, domainB.orgName, cursorStart.sequence)
    );
    expect(chunk1.entries.length).toBeGreaterThan(0);
    const applied1 = await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      importSyncBundle(tx, domainB.orgId, chunk1)
    );
    expect(applied1.appliedEntries).toBe(chunk1.entries.length);

    // Chunk 2 ("the resumed transfer"): a SECOND object, a SECOND independently-signed export,
    // continuing from where chunk 1's cursor left off — proving resumability without needing to
    // fabricate an internally-inconsistent bundle.
    await withTenantTx(domainA.db, domainA.orgId, (tx) =>
      createObject(tx, {
        orgId: domainA.orgId,
        domainId: null,
        typeId: "service",
        actorObjectId: domainA.orgId,
        requestId: "t-r2",
        name: "resume-svc-2"
      })
    );
    const cursorAfterChunk1 = await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      getCursor(tx, domainB.orgId, selfA.domainId, selfA.domainId)
    );
    expect(cursorAfterChunk1.sequence).toBe(chunk1.header.throughSequence);
    const chunk2 = await withTenantTx(domainA.db, domainA.orgId, (tx) =>
      exportSyncBundle(tx, domainA.orgId, domainB.orgName, cursorAfterChunk1.sequence)
    );
    const applied2 = await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      importSyncBundle(tx, domainB.orgId, chunk2)
    );
    expect(applied2.appliedEntries).toBe(chunk2.entries.length);
    expect(applied2.lastAppliedSequence).toBe(chunk2.header.throughSequence);

    // Re-applying chunk 1 now (simulating a retried/duplicated resume request) is still a no-op —
    // resumability composes with idempotency, exactly as the DoD requires.
    const replay = await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      importSyncBundle(tx, domainB.orgId, chunk1)
    );
    expect(replay.appliedEntries).toBe(0);
  });

  it("SECURITY: a tampered segment (broken hash chain — content mutated after signing) is rejected; applies nothing", async () => {
    await withTenantTx(domainA.db, domainA.orgId, (tx) =>
      createObject(tx, {
        orgId: domainA.orgId,
        domainId: null,
        typeId: "service",
        actorObjectId: domainA.orgId,
        requestId: "t-tamper1",
        name: "tamper-chain-svc"
      })
    );
    const cursor = await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      getCursor(tx, domainB.orgId, selfA.domainId, selfA.domainId)
    );
    const bundle = await withTenantTx(domainA.db, domainA.orgId, (tx) =>
      exportSyncBundle(tx, domainA.orgId, domainB.orgName, cursor.sequence)
    );
    expect(bundle.entries.length).toBeGreaterThan(0);

    const tampered: SyncBundle = {
      ...bundle,
      entries: bundle.entries.map((e, i) =>
        i === bundle.entries.length - 1
          ? { ...e, payload: { ...e.payload, name: "INJECTED-NAME" } }
          : e
      )
    };

    // `ProblemError.message` is always just the RFC 9457 title ("Conflict") — the actual reason
    // lives on `.detail` (errors.ts), so assertions match against that, not `.message`.
    await expect(
      withTenantTx(domainB.db, domainB.orgId, (tx) => importSyncBundle(tx, domainB.orgId, tampered))
    ).rejects.toMatchObject({ status: 409, detail: expect.stringMatching(/checksum mismatch/) });

    // Nothing from this bundle applied — cursor unchanged.
    const cursorAfter = await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      getCursor(tx, domainB.orgId, selfA.domainId, selfA.domainId)
    );
    expect(cursorAfter.sequence).toBe(cursor.sequence);
  });

  it("SECURITY: a tampered signature (checksum recomputes correctly, but bundleSignature is forged/wrong) is rejected", async () => {
    await withTenantTx(domainA.db, domainA.orgId, (tx) =>
      createObject(tx, {
        orgId: domainA.orgId,
        domainId: null,
        typeId: "service",
        actorObjectId: domainA.orgId,
        requestId: "t-tamper2",
        name: "tamper-sig-svc"
      })
    );
    const cursor = await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      getCursor(tx, domainB.orgId, selfA.domainId, selfA.domainId)
    );
    const bundle = await withTenantTx(domainA.db, domainA.orgId, (tx) =>
      exportSyncBundle(tx, domainA.orgId, domainB.orgName, cursor.sequence)
    );

    const forged: SyncBundle = {
      ...bundle,
      bundleSignature: Buffer.from("not-a-real-signature").toString("base64")
    };

    await expect(
      withTenantTx(domainB.db, domainB.orgId, (tx) => importSyncBundle(tx, domainB.orgId, forged))
    ).rejects.toMatchObject({
      status: 409,
      detail: expect.stringMatching(/signature verification failed/)
    });
  });

  it("SECURITY: single-writer authority — domain B cannot locally mutate a replica object it doesn't own", async () => {
    const created = await withTenantTx(domainA.db, domainA.orgId, (tx) =>
      createObject(tx, {
        orgId: domainA.orgId,
        domainId: null,
        typeId: "service",
        actorObjectId: domainA.orgId,
        requestId: "t-authority",
        name: "authority-svc"
      })
    );
    const cursor = await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      getCursor(tx, domainB.orgId, selfA.domainId, selfA.domainId)
    );
    const bundle = await withTenantTx(domainA.db, domainA.orgId, (tx) =>
      exportSyncBundle(tx, domainA.orgId, domainB.orgName, cursor.sequence)
    );
    await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      importSyncBundle(tx, domainB.orgId, bundle)
    );

    // B attempts an ORDINARY local write (no federationImport context) against the replica.
    await expect(
      withTenantTx(domainB.db, domainB.orgId, (tx) =>
        updateObject(tx, {
          orgId: domainB.orgId,
          typeId: "service",
          actorObjectId: domainB.orgId,
          requestId: "t-attack",
          idOrUrn: created.id,
          name: "hijacked-by-B"
        })
      )
    ).rejects.toMatchObject({ status: 409 });

    const stillA = await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      getObjectByIdOrUrnAnyType(tx, domainB.orgId, created.id)
    );
    expect(stillA.name).toBe("authority-svc");
  });

  it("SECURITY: single-writer authority — a signed bundle cannot forge authorship of a THIRD domain's object on the CREATE path", async () => {
    // The exploit this guards (CRITICAL review finding): a legitimately-paired peer X (domainA)
    // signs a bundle entry for a BRAND-NEW urn whose `originDomainId` claims some OTHER domain P.
    // On the create path `createObject` writes `originDomainId` verbatim (the update-path 409 check
    // only protects EXISTING rows), so without the fix the victim (domainB) would believe P
    // authoritatively owns an object X actually forged — and an inflated revision would then
    // permanently 409-block P's real future updates. A signer may only vouch for its OWN authorship.
    const fabricatedParentDomainId = uuidv7(); // 'P' — a domain X does not own and never signed as
    const forgedUrn = `urn:scp:${domainA.orgName}:service:forged-authorship-${randomUUID()}`;

    await withTenantTx(domainA.db, domainA.orgId, (tx) =>
      createObject(tx, {
        orgId: domainA.orgId,
        domainId: null,
        typeId: "service",
        actorObjectId: domainA.orgId,
        requestId: "t-forge-create",
        urn: forgedUrn,
        name: "forge-create-svc"
      })
    );
    const cursor = await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      getCursor(tx, domainB.orgId, selfA.domainId, selfA.domainId)
    );
    const bundle = await withTenantTx(domainA.db, domainA.orgId, (tx) =>
      exportSyncBundle(tx, domainA.orgId, domainB.orgName, cursor.sequence)
    );
    const targetIdx = bundle.entries.findIndex((e) => e.payload.urn === forgedUrn);
    expect(targetIdx).toBeGreaterThanOrEqual(0);

    // X rewrites the entry to claim P owns the object (BOTH the signed top-level field AND the
    // free-form payload field), then re-signs the entry AND the whole bundle with X's (domainA's)
    // OWN real key — i.e. a perfectly valid signature from a legitimately-paired peer. The chain
    // and signatures all verify; only the authorship binding is forged.
    const aKey = await withTenantTx(domainA.db, domainA.orgId, (tx) =>
      ensureInstanceKey(tx, domainA.orgId)
    );
    const forgedEntries = bundle.entries.map((e, i) => {
      if (i !== targetIdx) return e;
      const tampered = {
        ...e,
        originDomainId: fabricatedParentDomainId,
        payload: { ...e.payload, originDomainId: fabricatedParentDomainId }
      };
      const rowHash = computeJournalRowHash(tampered);
      return { ...tampered, rowHash, signature: signJournalRowHash(aKey.privateKey, rowHash) };
    });
    const checksum = computeBundleChecksum({ header: bundle.header, entries: forgedEntries });
    const forged: SyncBundle = {
      ...bundle,
      entries: forgedEntries,
      checksum,
      bundleSignature: signBundleChecksum(aKey.privateKey, checksum)
    };

    await expect(
      withTenantTx(domainB.db, domainB.orgId, (tx) => importSyncBundle(tx, domainB.orgId, forged))
    ).rejects.toMatchObject({ status: 409, detail: expect.stringMatching(/forged authorship/) });

    // Nothing was written — no object under the forged urn, so certainly none owned by P.
    await expect(
      withTenantTx(domainB.db, domainB.orgId, (tx) =>
        getObjectByIdOrUrnAnyType(tx, domainB.orgId, forgedUrn)
      )
    ).rejects.toThrow();
  });

  it("SECURITY: a bundle whose HEADER was rewritten in transit is rejected (signed checksum now covers the header)", async () => {
    await withTenantTx(domainA.db, domainA.orgId, (tx) =>
      createObject(tx, {
        orgId: domainA.orgId,
        domainId: null,
        typeId: "service",
        actorObjectId: domainA.orgId,
        requestId: "t-hdr",
        name: "header-tamper-svc"
      })
    );
    const cursor = await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      getCursor(tx, domainB.orgId, selfA.domainId, selfA.domainId)
    );
    const bundle = await withTenantTx(domainA.db, domainA.orgId, (tx) =>
      exportSyncBundle(tx, domainA.orgId, domainB.orgName, cursor.sequence)
    );

    // Rewrite header fields (inflate throughSequence, backdate exportedAt) but leave the entries,
    // checksum, and signature untouched — exactly what an in-transit attacker can do to a plaintext
    // bundle. Before the fix the header was unsigned, so this sailed through; now the checksum is
    // recomputed over {header, entries} and no longer matches.
    const rewritten: SyncBundle = {
      ...bundle,
      header: {
        ...bundle.header,
        throughSequence: bundle.header.throughSequence + 1000,
        exportedAt: new Date(0).toISOString()
      }
    };

    await expect(
      withTenantTx(domainB.db, domainB.orgId, (tx) =>
        importSyncBundle(tx, domainB.orgId, rewritten)
      )
    ).rejects.toMatchObject({ status: 409, detail: expect.stringMatching(/checksum mismatch/) });

    const cursorAfter = await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      getCursor(tx, domainB.orgId, selfA.domainId, selfA.domainId)
    );
    expect(cursorAfter.sequence).toBe(cursor.sequence); // nothing applied
  });

  it("SECURITY: a rotated-away (compromised) key cannot get NEW forged entries accepted by backdating exportedAt", async () => {
    const origin = await createIsolatedDomain("rotOrigin");
    const victim = await createIsolatedDomain("rotVictim");
    try {
      const originSelf = await withTenantTx(origin.db, origin.orgId, (tx) =>
        ensureFederationSelf(tx, origin.orgId)
      );
      // origin needs victim registered as a peer so it can export toward it (the ordinary
      // out-of-band exchange); the reverse direction (victim's record of origin) is set up manually
      // below because this test drives origin's KEY ROTATION on victim's side explicitly.
      await pair(origin, victim, "child");
      // origin's REAL signing key K1 (its instance key) — the key that later "leaks" to the attacker.
      const k1 = await withTenantTx(origin.db, origin.orgId, (tx) =>
        ensureInstanceKey(tx, origin.orgId)
      );
      await withTenantTx(victim.db, victim.orgId, (tx) =>
        pairPeer(tx, {
          orgId: victim.orgId,
          domainId: originSelf.domainId,
          name: origin.orgName,
          role: "parent",
          publicKey: k1.publicKey
        })
      );

      // origin authors + exports normally under K1; victim imports it (cursor advances to C0).
      await withTenantTx(origin.db, origin.orgId, (tx) =>
        createObject(tx, {
          orgId: origin.orgId,
          domainId: null,
          typeId: "service",
          actorObjectId: origin.orgId,
          requestId: "rot-1",
          name: "pre-rotation-svc"
        })
      );
      const bundle0 = await withTenantTx(origin.db, origin.orgId, (tx) =>
        exportSyncBundle(tx, origin.orgId, victim.orgName)
      );
      await withTenantTx(victim.db, victim.orgId, (tx) =>
        importSyncBundle(tx, victim.orgId, bundle0)
      );

      // origin rotates its key -> K2. victim re-pairs origin with K2's public half (the out-of-band
      // exchange). This anchors K1.supersededAtSequence = victim's cursor and K2.effectiveFrom there.
      const k2 = generateEd25519KeypairB64();
      await withTenantTx(victim.db, victim.orgId, (tx) =>
        pairPeer(tx, {
          orgId: victim.orgId,
          domainId: originSelf.domainId,
          name: origin.orgName,
          role: "parent",
          publicKey: k2.publicKey
        })
      );

      // The attacker, holding the COMPROMISED old private key K1, authors a NEW object (sequence
      // beyond the rotation anchor) and forges a bundle for it — re-signed with K1 and BACKDATING
      // exportedAt to when K1 was still current, the exact timestamp trick the old code fell for.
      const forgedObj = await withTenantTx(origin.db, origin.orgId, (tx) =>
        createObject(tx, {
          orgId: origin.orgId,
          domainId: null,
          typeId: "service",
          actorObjectId: origin.orgId,
          requestId: "rot-2",
          name: "post-rotation-forged-svc"
        })
      );
      const cursorAtRotation = await withTenantTx(victim.db, victim.orgId, (tx) =>
        getCursor(tx, victim.orgId, originSelf.domainId, originSelf.domainId)
      );
      const rawBundle = await withTenantTx(origin.db, origin.orgId, (tx) =>
        exportSyncBundle(tx, origin.orgId, victim.orgName, cursorAtRotation.sequence)
      );
      const backdatedHeader = { ...rawBundle.header, exportedAt: new Date(0).toISOString() };
      const forgedChecksum = computeBundleChecksum({
        header: backdatedHeader,
        entries: rawBundle.entries
      });
      const forged: SyncBundle = {
        ...rawBundle,
        header: backdatedHeader,
        checksum: forgedChecksum,
        bundleSignature: signBundleChecksum(k1.privateKey, forgedChecksum) // compromised K1
      };

      // Rejected: key selection is anchored to the AUTHENTICATED sequence (beyond the rotation
      // anchor => must be K2), so the K1 signature no longer verifies — backdating exportedAt into
      // K1's old window changes nothing.
      await expect(
        withTenantTx(victim.db, victim.orgId, (tx) => importSyncBundle(tx, victim.orgId, forged))
      ).rejects.toMatchObject({
        status: 409,
        detail: expect.stringMatching(/signature verification failed/)
      });

      // The forged object never landed.
      await expect(
        withTenantTx(victim.db, victim.orgId, (tx) =>
          getObjectByIdOrUrnAnyType(tx, victim.orgId, forgedObj.id)
        )
      ).rejects.toThrow();
    } finally {
      await origin.close();
      await victim.close();
    }
  });

  it("hand-filled parent config reconciles correctly when a signed bundle later arrives", async () => {
    const urn = `urn:scp:${domainA.orgName}:service:handfill-target-${Date.now()}`;

    const handFilled = await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      handFillObject(tx, {
        orgId: domainB.orgId,
        peerIdOrName: domainA.orgName,
        typeId: "service",
        urn,
        name: "guessed-name",
        properties: { guess: true }
      })
    );
    expect(handFilled.provenance).toBe("manual");

    // The REAL object, in A, under the SAME urn, with real content.
    const real = await withTenantTx(domainA.db, domainA.orgId, (tx) =>
      createObject(tx, {
        orgId: domainA.orgId,
        domainId: null,
        typeId: "service",
        actorObjectId: domainA.orgId,
        requestId: "t-real",
        urn,
        name: "real-name",
        properties: { guess: false }
      })
    );

    const cursor = await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      getCursor(tx, domainB.orgId, selfA.domainId, selfA.domainId)
    );
    const bundle = await withTenantTx(domainA.db, domainA.orgId, (tx) =>
      exportSyncBundle(tx, domainA.orgId, domainB.orgName, cursor.sequence)
    );
    await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      importSyncBundle(tx, domainB.orgId, bundle)
    );

    const reconciled = await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      getObjectByIdOrUrnAnyType(tx, domainB.orgId, real.id)
    );
    expect(reconciled.provenance).toBeNull();
    expect(reconciled.name).toBe("real-name");
    expect(reconciled.properties.guess).toBe(false);
  });

  it("overlay round-trip: B annotates A's replicated policy via `annotates`; merged view renders; base is never mutated", async () => {
    const basePolicy = await withTenantTx(domainA.db, domainA.orgId, (tx) =>
      createObject(tx, {
        orgId: domainA.orgId,
        domainId: null,
        typeId: "policy",
        actorObjectId: domainA.orgId,
        requestId: "t-policy",
        name: "org-wide-security",
        properties: { enforcement: "advisory", effects: [] }
      })
    );
    const cursor = await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      getCursor(tx, domainB.orgId, selfA.domainId, selfA.domainId)
    );
    const bundle = await withTenantTx(domainA.db, domainA.orgId, (tx) =>
      exportSyncBundle(tx, domainA.orgId, domainB.orgName, cursor.sequence)
    );
    await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      importSyncBundle(tx, domainB.orgId, bundle)
    );

    const { overlay } = await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      createOverlay(tx, {
        orgId: domainB.orgId,
        actorObjectId: domainB.orgId,
        requestId: "t-overlay",
        baseIdOrUrn: basePolicy.id,
        overlayTypeId: "policy",
        overlayName: "domainB-stricter",
        overlayProperties: { enforcement: "required" }
      })
    );
    expect(overlay.originDomainId).toBe(selfB.domainId); // the overlay itself IS locally owned

    const view = await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      getMergedOverlayView(tx, domainB.orgId, basePolicy.id)
    );
    expect(view.overlays).toHaveLength(1);
    expect(view.merged.enforcement).toBe("required"); // stricter overlay wins

    // The base object itself, re-read from A, is untouched.
    const baseStillOriginal = await withTenantTx(domainA.db, domainA.orgId, (tx) =>
      getObjectByIdOrUrnAnyType(tx, domainA.orgId, basePolicy.id)
    );
    expect(baseStillOriginal.properties.enforcement).toBe("advisory");
    expect(baseStillOriginal.version).toBe(basePolicy.version);
  });

  it("SECURITY: a policy overlay may only ADD strictness, never weaken the base's enforcement", async () => {
    const basePolicy = await withTenantTx(domainA.db, domainA.orgId, (tx) =>
      createObject(tx, {
        orgId: domainA.orgId,
        domainId: null,
        typeId: "policy",
        actorObjectId: domainA.orgId,
        requestId: "t-policy2",
        name: "strict-base",
        properties: { enforcement: "required" }
      })
    );
    const cursor = await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      getCursor(tx, domainB.orgId, selfA.domainId, selfA.domainId)
    );
    const bundle = await withTenantTx(domainA.db, domainA.orgId, (tx) =>
      exportSyncBundle(tx, domainA.orgId, domainB.orgName, cursor.sequence)
    );
    await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      importSyncBundle(tx, domainB.orgId, bundle)
    );

    await expect(
      withTenantTx(domainB.db, domainB.orgId, (tx) =>
        createOverlay(tx, {
          orgId: domainB.orgId,
          actorObjectId: domainB.orgId,
          requestId: "t-weaken",
          baseIdOrUrn: basePolicy.id,
          overlayTypeId: "policy",
          overlayName: "weakening-overlay",
          overlayProperties: { enforcement: "advisory" }
        })
      )
    ).rejects.toMatchObject({
      status: 400,
      detail: expect.stringMatching(/may only ADD strictness/)
    });
  });

  it("sync scope filters honored: a peer scoped to policies_only never receives non-policy objects into its graph", async () => {
    const scopedDomain = await createIsolatedDomain("domainScoped");
    try {
      await pair(domainA, scopedDomain, "child");
      await pair(scopedDomain, domainA, "parent", { mode: "policies_only" });

      const service = await withTenantTx(domainA.db, domainA.orgId, (tx) =>
        createObject(tx, {
          orgId: domainA.orgId,
          domainId: null,
          typeId: "service",
          actorObjectId: domainA.orgId,
          requestId: "t-scope-svc",
          name: "scope-test-svc"
        })
      );
      const policy = await withTenantTx(domainA.db, domainA.orgId, (tx) =>
        createObject(tx, {
          orgId: domainA.orgId,
          domainId: null,
          typeId: "policy",
          actorObjectId: domainA.orgId,
          requestId: "t-scope-pol",
          name: "scope-test-policy",
          properties: { enforcement: "advisory" }
        })
      );

      const bundle = await withTenantTx(domainA.db, domainA.orgId, (tx) =>
        exportSyncBundle(tx, domainA.orgId, scopedDomain.orgName)
      );
      await withTenantTx(scopedDomain.db, scopedDomain.orgId, (tx) =>
        importSyncBundle(tx, scopedDomain.orgId, bundle)
      );

      await expect(
        withTenantTx(scopedDomain.db, scopedDomain.orgId, (tx) =>
          getObjectByIdOrUrnAnyType(tx, scopedDomain.orgId, service.id)
        )
      ).rejects.toThrow();
      const replicatedPolicy = await withTenantTx(scopedDomain.db, scopedDomain.orgId, (tx) =>
        getObjectByIdOrUrnAnyType(tx, scopedDomain.orgId, policy.id)
      );
      expect(replicatedPolicy.urn).toBe(policy.urn);
    } finally {
      await scopedDomain.close();
    }
  });
});

describe("M6 Federation: Promotion Bundles (Testcontainers)", () => {
  let domainA: IsolatedDomain;
  let domainB: IsolatedDomain;
  let selfA: FederationSelf;

  beforeAll(async () => {
    domainA = await createIsolatedDomain("promoteA");
    domainB = await createIsolatedDomain("promoteB");
    selfA = await withTenantTx(domainA.db, domainA.orgId, (tx) =>
      ensureFederationSelf(tx, domainA.orgId)
    );

    await pair(domainA, domainB, "child");
    await pair(domainB, domainA, "parent");
  }, 60_000);

  afterAll(async () => {
    await domainA.close();
    await domainB.close();
  });

  async function proposeApprovedChangeInA(): Promise<{ changeId: string; changeUrn: string }> {
    const target = await withTenantTx(domainA.db, domainA.orgId, (tx) =>
      createObject(tx, {
        orgId: domainA.orgId,
        domainId: null,
        typeId: "service",
        actorObjectId: domainA.orgId,
        requestId: "t-promo-target",
        name: `promo-target-${randomUUID()}`
      })
    );
    // Sync the new target to B too, so the promotion bundle's target resolves there.
    const preBundleCursor = await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      getCursor(tx, domainB.orgId, selfA.domainId, selfA.domainId)
    );
    const targetBundle = await withTenantTx(domainA.db, domainA.orgId, (tx) =>
      exportSyncBundle(tx, domainA.orgId, domainB.orgName, preBundleCursor.sequence)
    );
    await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      importSyncBundle(tx, domainB.orgId, targetBundle)
    );

    const approver = await createApprover(domainA, "Approver");

    const { change } = await withTenantTx(domainA.db, domainA.orgId, (tx) =>
      proposeChange(tx, {
        orgId: domainA.orgId,
        actorObjectId: domainA.orgId,
        requestId: "t-promo-change",
        name: `promote-me-${randomUUID()}`,
        targets: [target.id]
      })
    );
    await withTenantTx(domainA.db, domainA.orgId, async (tx) => {
      const req = await materializeApprovalRequest(tx, {
        orgId: domainA.orgId,
        changeObjectId: change.id,
        policyObjectId: target.id,
        policyVersion: 1,
        effectIndex: 0,
        requiredCount: 1,
        fromRole: "Approver",
        scopeObjectId: domainA.orgId
      });
      await castApprovalVote(tx, {
        orgId: domainA.orgId,
        approvalRequestId: req.id,
        voterObjectId: approver.objectId,
        requestId: "t-promo-vote"
      });
    });

    return { changeId: change.id, changeUrn: change.urn };
  }

  it("a valid approval attestation in a promotion bundle is accepted as evidence, and the local change lands in `proposed`", async () => {
    const { changeId } = await proposeApprovedChangeInA();

    const bundle = await withTenantTx(domainA.db, domainA.orgId, (tx) =>
      exportPromotionBundle(tx, {
        orgId: domainA.orgId,
        peerIdOrName: domainB.orgName,
        changeIdOrUrn: changeId
      })
    );
    expect(bundle.approvals.length).toBe(1);

    const result = await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      importPromotionBundle(tx, domainB.orgId, bundle)
    );
    expect(result.approvalsAccepted).toBe(1);
    expect(result.approvalsRejected).toBe(0);
    expect(result.importedFromDomain).toBe(selfA.domainId);

    const localChange = await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      getObjectByIdOrUrnAnyType(tx, domainB.orgId, result.localChangeObjectId)
    );
    expect(localChange.urn).toBe(result.localChangeUrn);
  });

  it("SECURITY: a promotion bundle with a forged approval attestation (signed by the WRONG key) rejects that approval as evidence, but does not block the import", async () => {
    const { changeId } = await proposeApprovedChangeInA();
    const bundle = await withTenantTx(domainA.db, domainA.orgId, (tx) =>
      exportPromotionBundle(tx, {
        orgId: domainA.orgId,
        peerIdOrName: domainB.orgName,
        changeIdOrUrn: changeId
      })
    );
    expect(bundle.approvals.length).toBe(1);

    // Forge: sign the SAME record with a throwaway key not registered as domain A's, then have
    // domain A's REAL key re-sign the OUTER bundle over this tampered content — isolating "the
    // exporter included a bad attestation" from "someone tampered with a legitimate bundle in
    // transit" (the latter is already covered by the sync-bundle tamper tests above).
    const { generateKeyPairSync, sign: cryptoSign } = await import("node:crypto");
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const attackerPublicKeyB64 = publicKey
      .export({ type: "spki", format: "der" })
      .toString("base64");
    const message = Buffer.from(JSON.stringify(bundle.approvals[0]!.record), "utf8");
    const forgedSignature = cryptoSign(null, message, privateKey).toString("base64");

    const exporterKey = await withTenantTx(domainA.db, domainA.orgId, (tx) =>
      ensureInstanceKey(tx, domainA.orgId)
    );
    const tamperedBundle = resignPromotionBundle(
      {
        ...bundle,
        approvals: [
          { ...bundle.approvals[0]!, signature: forgedSignature, publicKey: attackerPublicKeyB64 }
        ]
      },
      exporterKey.privateKey
    );

    const result = await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      importPromotionBundle(tx, domainB.orgId, tamperedBundle)
    );
    expect(result.approvalsAccepted).toBe(0);
    expect(result.approvalsRejected).toBe(1);
    // The Change itself still lands — approvals are evidence, never a gate on the import itself.
    expect(result.localChangeObjectId).toBeTruthy();
  });

  it("SECURITY: a promotion bundle whose approval binds a DIFFERENT object than the one being promoted is rejected as evidence", async () => {
    const { changeId } = await proposeApprovedChangeInA();
    const bundle = await withTenantTx(domainA.db, domainA.orgId, (tx) =>
      exportPromotionBundle(tx, {
        orgId: domainA.orgId,
        peerIdOrName: domainB.orgName,
        changeIdOrUrn: changeId
      })
    );

    // Re-sign the SAME attestation record but with the URN swapped (binding mismatch) — the
    // per-attestation signature IS valid (genuinely produced by domain A's real key over the
    // tampered record), isolating the `approvedObjectUrn` BINDING check specifically, independent
    // of signature validity. The OUTER bundle is likewise re-signed by A's real key, simulating
    // "the exporter itself attached an attestation for the wrong object" rather than in-transit
    // tampering (already covered above).
    const key = await withTenantTx(domainA.db, domainA.orgId, (tx) =>
      ensureInstanceKey(tx, domainA.orgId)
    );
    const { sign: cryptoSign } = await import("node:crypto");
    const tamperedRecord = {
      ...bundle.approvals[0]!.record,
      approvedObjectUrn: "urn:scp:elsewhere:change:not-this-one"
    };
    const canonical = JSON.stringify(tamperedRecord);
    const derPrivateKey = {
      key: Buffer.from(key.privateKey, "base64"),
      format: "der" as const,
      type: "pkcs8" as const
    };
    const resignature = cryptoSign(null, Buffer.from(canonical, "utf8"), derPrivateKey).toString(
      "base64"
    );

    const tamperedBundle = resignPromotionBundle(
      {
        ...bundle,
        approvals: [
          {
            record: tamperedRecord,
            signature: resignature,
            publicKey: bundle.approvals[0]!.publicKey
          }
        ]
      },
      key.privateKey
    );

    const result = await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      importPromotionBundle(tx, domainB.orgId, tamperedBundle)
    );
    expect(result.approvalsAccepted).toBe(0);
    expect(result.approvalsRejected).toBe(1);
  });
});
