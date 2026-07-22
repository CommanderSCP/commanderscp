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
import {
  exportPromotionBundle,
  importPromotionBundle,
  promotionChecksumPayload
} from "./promotion-repo.js";
import { getCursor } from "./cursors-repo.js";
import { createOverlay, getMergedOverlayView } from "./overlay-repo.js";
import { handFillObject } from "./handfill-repo.js";
import { proposeChange, getChange } from "../coordination/changes-repo.js";
import { materializeApprovalRequest, castApprovalVote } from "../governance/approvals-repo.js";
import { insertControlRun } from "../governance/controls-repo.js";
import { getInstanceCosignPublicKey } from "../governance/cosign-keys.js";
import { getDecision } from "../coordination/decisions-repo.js";
import { verifyBlob } from "@scp/cosign";
import { createIsolatedDomain, type IsolatedDomain } from "./test-support/isolated-domain.js";
import {
  canonicalStringify,
  computeBundleChecksum,
  signBundleChecksum,
  verifyBundleSignature,
  computeJournalRowHash,
  signJournalRowHash
} from "@scp/schemas/federation-journal";
import type { ControlOutcomeStatus, PromotionBundle } from "@scp/schemas";
import { PromotionBundleSchema } from "@scp/schemas";

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
  const checksum = computeBundleChecksum(promotionChecksumPayload(bundle));
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
  role: "outpost" | "commander",
  syncScope?: SyncScope,
  opts: { cosign?: boolean } = {}
) {
  const key = await withTenantTx(b.db, b.orgId, (tx) => ensureInstanceKey(tx, b.orgId));
  const self = await withTenantTx(b.db, b.orgId, (tx) => ensureFederationSelf(tx, b.orgId));
  // M17.3 (E5) / M17.4(a): register b's cosign VERIFICATION public key alongside its Ed25519 key so
  // a receiver can cosign-verify b's promotion manifests. Opt-in — sync-only tests don't need it, and
  // a peer paired WITHOUT it models a genuine pre-E5 peer (the back-compat / downgrade axis).
  const cosignPublicKey = opts.cosign
    ? (await getInstanceCosignPublicKey(b.db, b.orgId)).publicKey
    : undefined;
  await withTenantTx(a.db, a.orgId, (tx) =>
    pairPeer(tx, {
      orgId: a.orgId,
      domainId: self.domainId,
      name: b.orgName,
      role,
      publicKey: key.publicKey,
      ...(cosignPublicKey !== undefined ? { cosignPublicKey } : {}),
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

    // Pairing is always initiated FROM each side (DESIGN §13 outpost-initiated-only, or an
    // out-of-band exchange for air-gapped peers) — never a live handshake one side pushes onto
    // the other. Both sides register each other explicitly with the real exchanged public keys.
    await pair(domainA, domainB, "outpost");
    await pair(domainB, domainA, "commander");
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
      await pair(origin, victim, "outpost");
      // origin's REAL signing key K1 (its instance key) — the key that later "leaks" to the attacker.
      const k1 = await withTenantTx(origin.db, origin.orgId, (tx) =>
        ensureInstanceKey(tx, origin.orgId)
      );
      await withTenantTx(victim.db, victim.orgId, (tx) =>
        pairPeer(tx, {
          orgId: victim.orgId,
          domainId: originSelf.domainId,
          name: origin.orgName,
          role: "commander",
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
          role: "commander",
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

  it("hand-filled commander-origin config reconciles correctly when a signed bundle later arrives", async () => {
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

  it("SECURITY: overlay REFUSES a service-member type (component) — no create-strict side door (M12 P5)", async () => {
    // A base object to annotate (any type). The overlay attempt names `component` as its own type,
    // which would mint an orphan component bypassing POST /components — refused before any write.
    const base = await withTenantTx(domainA.db, domainA.orgId, (tx) =>
      createObject(tx, {
        orgId: domainA.orgId,
        domainId: null,
        typeId: "service",
        actorObjectId: domainA.orgId,
        requestId: "t-overlay-base",
        name: "overlay-base-svc"
      })
    );
    await expect(
      withTenantTx(domainA.db, domainA.orgId, (tx) =>
        createOverlay(tx, {
          orgId: domainA.orgId,
          actorObjectId: domainA.orgId,
          requestId: "t-overlay-comp",
          baseIdOrUrn: base.id,
          overlayTypeId: "component",
          overlayName: "sneaky-component"
        })
      )
    ).rejects.toMatchObject({ status: 403, detail: expect.stringMatching(/must belong to a service/i) });
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
      // The EXPORTER's peer record carries the scope (it decides what to share with this peer) —
      // export-side filtering reads domainA's record of scopedDomain. The importer's record is
      // scoped identically so its defense-in-depth re-filter agrees.
      await pair(domainA, scopedDomain, "outpost", { mode: "policies_only" });
      await pair(scopedDomain, domainA, "commander", { mode: "policies_only" });

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

      // MAJOR review fix (confidentiality): the EXPORTED bundle itself must contain ONLY in-scope
      // (policy) entries — the full-graph objects (the org root, the service) must never be present
      // in the plaintext bundle a scoped peer receives on disk / in transit. Previously the full
      // range was shipped and only filtered at import, leaking everything.
      expect(bundle.entries.length).toBeGreaterThan(0);
      expect(bundle.entries.every((e) => e.entryKind === "policy_upsert")).toBe(true);
      const bundleJson = JSON.stringify(bundle);
      expect(bundleJson).toContain("scope-test-policy");
      expect(bundleJson).not.toContain("scope-test-svc"); // the service never appears, anywhere

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

    // Pair E5-complete (cosign keys exchanged both ways) — the realistic post-E5/E6 setup. domainB's
    // record of domainA carries domainA's cosign key, so M17.4(a) can verify domainA's manifests.
    await pair(domainA, domainB, "outpost", undefined, { cosign: true });
    await pair(domainB, domainA, "commander", undefined, { cosign: true });
  }, 60_000);

  afterAll(async () => {
    await domainA.close();
    await domainB.close();
  });

  async function proposeApprovedChangeInA(
    sourceRef?: Record<string, unknown>,
    opts: { seedScan?: boolean } = {}
  ): Promise<{ changeId: string; changeUrn: string }> {
    const seedScan = opts.seedScan ?? true;
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
        targets: [target.id],
        ...(sourceRef ? { sourceRef } : {})
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

    // M17.3 (E6): the export scan gate HARD-REFUSES any promotion whose substantive artifact lacks a
    // passing, digest-bound scan. When this change tracks an OCI artifact, seed the passing,
    // digest-bound scan outcome the boundary re-check requires so the (non-gate) assertions below can
    // export. Changes with NO substantive artifact need no scan (the gate passes vacuously).
    const seedOci =
      seedScan && sourceRef && typeof sourceRef.artifact_digest === "string"
        ? sourceRef.artifact_digest
        : undefined;
    if (seedOci) await seedPassingScan(change.id, seedOci);

    return { changeId: change.id, changeUrn: change.urn };
  }

  /** Insert a `trivy` scan control run for `changeId`. Defaults to the PASSING, digest-bound outcome
   *  the M17.3 E6 export gate re-checks (status pass + digestMatch + scanned digest == promoted); the
   *  overrides let a test seed a FAILED or digest-mismatched outcome to exercise the fail-closed path. */
  async function seedScanOutcome(
    changeId: string,
    ociDigest: string,
    over: { status?: ControlOutcomeStatus; digestMatch?: boolean; scannedDigest?: string } = {}
  ): Promise<void> {
    await withTenantTx(domainA.db, domainA.orgId, (tx) =>
      insertControlRun(tx, {
        orgId: domainA.orgId,
        controlObjectId: randomUUID(),
        changeObjectId: changeId,
        gateKind: "lifecycle_edge",
        gateRef: { fromState: "validating", toState: "promoted" },
        status: over.status ?? "pass",
        evidence: {
          scanner: "trivy",
          scannerVersion: "0.50.0",
          artifactDigest: over.scannedDigest ?? ociDigest,
          expectedDigest: ociDigest,
          digestMatch: over.digestMatch ?? true,
          severityCounts: { critical: 0, high: 0, medium: 0, low: 0 },
          threshold: { maxCritical: 0, maxHigh: 0 }
        }
      })
    );
  }

  /** The passing, digest-bound scan the gate requires — the default `seedScanOutcome`. */
  async function seedPassingScan(changeId: string, ociDigest: string): Promise<void> {
    await seedScanOutcome(changeId, ociDigest);
  }

  /** Export from domain A and unwrap the success bundle — throws if the gate unexpectedly refused. */
  async function exportBundleA(changeId: string): Promise<PromotionBundle> {
    const outcome = await exportPromotionBundle(domainA.db, {
      orgId: domainA.orgId,
      peerIdOrName: domainB.orgName,
      changeIdOrUrn: changeId
    });
    if (outcome.refused) throw new Error(`unexpected export refusal: ${outcome.reason}`);
    return outcome.bundle;
  }

  it("a valid approval attestation in a promotion bundle is accepted as evidence, and the local change lands in `proposed`", async () => {
    const { changeId } = await proposeApprovedChangeInA();

    const bundle = await exportBundleA(changeId);
    expect(bundle.approvals.length).toBe(1);

    const result = await importPromotionBundle(domainB.db, domainB.orgId, bundle);
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
    const bundle = await exportBundleA(changeId);
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

    const result = await importPromotionBundle(domainB.db, domainB.orgId, tamperedBundle);
    expect(result.approvalsAccepted).toBe(0);
    expect(result.approvalsRejected).toBe(1);
    // The Change itself still lands — approvals are evidence, never a gate on the import itself.
    expect(result.localChangeObjectId).toBeTruthy();
  });

  it("SECURITY: a promotion bundle whose approval binds a DIFFERENT object than the one being promoted is rejected as evidence", async () => {
    const { changeId } = await proposeApprovedChangeInA();
    const bundle = await exportBundleA(changeId);

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

    const result = await importPromotionBundle(domainB.db, domainB.orgId, tamperedBundle);
    expect(result.approvalsAccepted).toBe(0);
    expect(result.approvalsRejected).toBe(1);
  });

  // -----------------------------------------------------------------------------------------
  // M17.3 (E3) — the TYPED artifact set. The crux is COMPATIBILITY: `artifacts[]` is the rich
  // source, `artifactDigests` its backward-compatible flat projection, and the typed set takes
  // NO part in the Ed25519 checksum/signature (EXPAND phase). NO cosign/signing is introduced.
  // -----------------------------------------------------------------------------------------

  const OCI_DIGEST = "sha256:" + "a".repeat(64);
  const SBOM_DIGEST = "sha256:" + "b".repeat(64);
  const sourceRefWithArtifacts = {
    artifact_digest: OCI_DIGEST,
    sbom: {
      format: "cyclonedx",
      digest: SBOM_DIGEST,
      location: "oci://registry.example/app/sbom@" + SBOM_DIGEST,
      signatureRef: "oci://registry.example/app/sbom.sig"
    }
  };

  it("E3: an exported bundle carries a TYPED artifacts[] (oci image + sbom blob) and artifactDigests is its derived projection", async () => {
    const { changeId } = await proposeApprovedChangeInA(sourceRefWithArtifacts);
    const bundle = await exportBundleA(changeId);

    expect(bundle.header.formatVersion).toBe(1); // NOT bumped
    expect(bundle.artifacts).toBeDefined();
    expect(bundle.artifacts).toEqual([
      { type: "oci", digest: OCI_DIGEST },
      {
        type: "blob",
        digest: SBOM_DIGEST,
        location: sourceRefWithArtifacts.sbom.location,
        format: "cyclonedx",
        signatureRef: sourceRefWithArtifacts.sbom.signatureRef
      }
    ]);
    // artifactDigests === artifacts.map(a => a.digest)
    expect(bundle.artifactDigests).toEqual(bundle.artifacts!.map((a) => a.digest));
  });

  it("E3 CHECKSUM-INVARIANCE: the real exported checksum is byte-identical with vs without artifacts[]", async () => {
    const { changeId } = await proposeApprovedChangeInA(sourceRefWithArtifacts);
    const bundle = await exportBundleA(changeId);
    // The exporter's own checksum verifies over the field list that EXCLUDES artifacts.
    expect(computeBundleChecksum(promotionChecksumPayload(bundle))).toBe(bundle.checksum);
    // Stripping artifacts[] leaves the checksum unchanged (it was never in the payload).
    const { artifacts: _dropped, ...withoutArtifacts } = bundle;
    expect(computeBundleChecksum(promotionChecksumPayload(withoutArtifacts as PromotionBundle))).toBe(
      bundle.checksum
    );
  });

  it("E3 CHECKSUM byte-identity holds when artifacts[] is stripped (the field was never in the checksum)", async () => {
    const { changeId } = await proposeApprovedChangeInA(sourceRefWithArtifacts);
    const bundle = await exportBundleA(changeId);
    expect(bundle.artifacts).toBeDefined();

    // Strip artifacts[] entirely from the wire — the Ed25519 checksum/signature STILL verify against
    // the exporter's key (the stripped field was never protected by the checksum — the E3 invariant).
    const { artifacts: _stripped, ...oldShape } = bundle;
    const oldBundle = oldShape as PromotionBundle;
    expect(oldBundle.artifacts).toBeUndefined();
    expect(oldBundle.artifactDigests).toEqual([OCI_DIGEST, SBOM_DIGEST]);

    const aKey = await withTenantTx(domainA.db, domainA.orgId, (tx) =>
      ensureInstanceKey(tx, domainA.orgId)
    );
    expect(computeBundleChecksum(promotionChecksumPayload(oldBundle))).toBe(oldBundle.checksum);
    expect(verifyBundleSignature(oldBundle.checksum, oldBundle.bundleSignature, aKey.publicKey)).toBe(
      true
    );

    // BUT M17.4(a) now BINDS artifacts[] via the cosign manifest (which enumerates [oci, sbom]) — so
    // stripping the typed set while the manifest still claims it is a DETECTED set-equality violation
    // (the Ed25519 layer is blind to it; the cosign layer is not). Rejected fail-closed.
    await expect(
      importPromotionBundle(domainB.db, domainB.orgId, oldBundle)
    ).rejects.toMatchObject({ status: 409 });
  });

  it("E3 OLD->NEW: a v1 bundle with NO artifacts[] imports cleanly (optional, undefined)", async () => {
    const { changeId } = await proposeApprovedChangeInA(); // no sourceRef → no artifacts
    const bundle = await exportBundleA(changeId);
    // No tracked artifacts → the top-level ENVELOPE `artifacts` field is undefined (NOT []), so it
    // is dropped from the CHECKSUM-relevant canonical string and the envelope stays byte-identical to
    // a v1 bundle. (M17.3 E6 adds a checksum-EXCLUDED `promotionManifest` sibling that legitimately
    // enumerates the — here empty — artifact set, so the whole-bundle JSON is no longer the right
    // proxy; assert the E3 invariant precisely on the checksum payload instead.)
    expect(bundle.artifacts).toBeUndefined();
    expect(JSON.stringify(promotionChecksumPayload(bundle))).not.toContain("\"artifacts\"");
    expect(computeBundleChecksum(promotionChecksumPayload(bundle))).toBe(bundle.checksum);
    expect(bundle.artifactDigests).toEqual([]);

    // The manifest binds an EMPTY set and bundle.artifacts is undefined→[] — set-equality + tie both
    // hold, so M17.4(a) verifies and the import lands.
    const result = await importPromotionBundle(domainB.db, domainB.orgId, bundle);
    expect(result.approvalsAccepted).toBe(1);
    expect(result.approvalsRejected).toBe(0);
  });

  it("E3 ROUND-TRIP: export->import preserves the typed set (incl. the SBOM blob) and the derived artifactDigests on the imported change", async () => {
    const { changeId } = await proposeApprovedChangeInA(sourceRefWithArtifacts);
    const bundle = await exportBundleA(changeId);
    // The wire survives a full Zod parse (ingress validation) without losing artifacts[].
    const parsed = PromotionBundleSchema.parse(JSON.parse(JSON.stringify(bundle)));
    expect(parsed.artifacts).toEqual(bundle.artifacts);

    const result = await importPromotionBundle(domainB.db, domainB.orgId, parsed);

    // sourceRef lives on the change row — read it back through getChange.
    const localChange = await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      getChange(tx, domainB.orgId, result.localChangeObjectId)
    );
    const sr = localChange.sourceRef as Record<string, unknown>;
    expect(sr).toBeTruthy();
    // The imported change carries BOTH the derived digests and the typed set.
    expect(sr.artifactDigests).toEqual([OCI_DIGEST, SBOM_DIGEST]);
    const importedArtifacts = sr.artifacts as Array<Record<string, unknown>> | undefined;
    expect(importedArtifacts).toBeDefined();
    const blob = importedArtifacts!.find((a) => a.type === "blob");
    expect(blob?.digest).toBe(SBOM_DIGEST);
    expect(blob?.format).toBe("cyclonedx");
  });

  it("E3 FAIL-CLOSED: tampering with artifactDigests still fails the existing bundle checksum", async () => {
    const { changeId } = await proposeApprovedChangeInA(sourceRefWithArtifacts);
    const bundle = await exportBundleA(changeId);
    // Mutate the protected flat field WITHOUT re-signing → checksum mismatch, rejected fail-closed.
    const tampered: PromotionBundle = {
      ...bundle,
      artifactDigests: [...bundle.artifactDigests, "sha256:" + "e".repeat(64)]
    };
    await expect(
      importPromotionBundle(domainB.db, domainB.orgId, tampered)
    ).rejects.toMatchObject({ status: 409, detail: expect.stringMatching(/checksum mismatch/) });
  });

  // -----------------------------------------------------------------------------------------
  // M17.3 (E6) — the CAPSTONE. Export HARD-REFUSES (with a decision_id) every cross-boundary
  // promotion lacking a passing, digest-bound scan for each SUBSTANTIVE artifact (SBOM EXEMPT), and
  // co-signs a SELF-BINDING cosign manifest (no swap vector) that is EXCLUDED from the Ed25519
  // checksum. SCP signs only its OWN manifest (coordinate-not-execute). Uses REAL cosign.
  // -----------------------------------------------------------------------------------------

  it("E6 HARD-GATE: a substantive artifact with a FAILED scan is REFUSED at export with a decision_id", async () => {
    const { changeId } = await proposeApprovedChangeInA(sourceRefWithArtifacts, { seedScan: false });
    // Seed a FAILED scan for the OCI artifact — a present-but-failing outcome must still refuse.
    await seedScanOutcome(changeId, OCI_DIGEST, { status: "fail" });

    const outcome = await exportPromotionBundle(domainA.db, {
      orgId: domainA.orgId,
      peerIdOrName: domainB.orgName,
      changeIdOrUrn: changeId
    });
    expect(outcome.refused).toBe(true);
    if (!outcome.refused) throw new Error("expected refusal");
    expect(outcome.reason).toContain(OCI_DIGEST);

    // The block persisted an audited Decision that resolves by its decision_id (DESIGN §6/§10.4).
    const decision = await withTenantTx(domainA.db, domainA.orgId, (tx) =>
      getDecision(tx, domainA.orgId, outcome.decisionId)
    );
    expect(decision.verdict).toBe("block");
    expect(decision.kind).toBe("promotion-export-scan-gate");
  });

  it("E6 UNIVERSAL/FAIL-CLOSED: a substantive artifact with NO scan outcome is REFUSED", async () => {
    const { changeId } = await proposeApprovedChangeInA(sourceRefWithArtifacts, { seedScan: false });
    // No scan seeded at all — a MISSING scan refuses exactly like a failed one (universal gate).
    const outcome = await exportPromotionBundle(domainA.db, {
      orgId: domainA.orgId,
      peerIdOrName: domainB.orgName,
      changeIdOrUrn: changeId
    });
    expect(outcome.refused).toBe(true);
    if (!outcome.refused) throw new Error("expected refusal");
    expect(outcome.decisionId).toBeTruthy();
    expect(outcome.reason).toContain(OCI_DIGEST);
  });

  it("E6 DIGEST-BINDING: a passing scan of a DIFFERENT digest does NOT satisfy the gate (refused)", async () => {
    const { changeId } = await proposeApprovedChangeInA(sourceRefWithArtifacts, { seedScan: false });
    // A passing scan, but of some OTHER image — digestMatch true against the WRONG digest must not
    // authorize this artifact (defense-in-depth boundary re-check of M17.1's digest binding).
    const otherDigest = "sha256:" + "f".repeat(64);
    await seedScanOutcome(changeId, otherDigest, { scannedDigest: otherDigest, digestMatch: true });

    const outcome = await exportPromotionBundle(domainA.db, {
      orgId: domainA.orgId,
      peerIdOrName: domainB.orgName,
      changeIdOrUrn: changeId
    });
    expect(outcome.refused).toBe(true);
  });

  it("E6 SIGN: a passing digest-bound scan EXPORTS and carries a cosign-signed SELF-BINDING manifest", async () => {
    const { changeId } = await proposeApprovedChangeInA(sourceRefWithArtifacts); // auto-seeds passing scan
    const bundle = await exportBundleA(changeId);

    expect(bundle.promotionManifest).toBeDefined();
    expect(bundle.manifestSignature).toBeTruthy();
    // The manifest SELF-BINDS this bundle's identity (swap defense).
    expect(bundle.promotionManifest!.sourceChangeObjectId).toBe(bundle.header.sourceChangeObjectId);
    expect(bundle.promotionManifest!.exporterDomainId).toBe(bundle.header.exporterDomainId);
    expect(bundle.promotionManifest!.peerDomainId).toBe(bundle.header.peerDomainId);
    expect(bundle.promotionManifest!.changeUrn).toBe(bundle.change.urn);
    expect(bundle.promotionManifest!.artifacts.map((a) => a.digest)).toEqual(bundle.artifactDigests);

    // verify-blob the manifest with domain A's cosign PUBLIC key (E5) — proves a real signature.
    const cosignPub = await getInstanceCosignPublicKey(domainA.db, domainA.orgId);
    const ok = await verifyBlob(
      canonicalStringify(bundle.promotionManifest),
      bundle.manifestSignature!,
      cosignPub.publicKey
    );
    expect(ok).toBe(true);

    // Negative control: tampering the manifest breaks verification (the signature is meaningful).
    const tamperedManifest = {
      ...bundle.promotionManifest!,
      changeUrn: "urn:scp:elsewhere:change:not-this-one"
    };
    const tamperedOk = await verifyBlob(
      canonicalStringify(tamperedManifest),
      bundle.manifestSignature!,
      cosignPub.publicKey
    );
    expect(tamperedOk).toBe(false);
  });

  it("E6 SBOM-EXEMPT: an unscanned SBOM blob alongside a scanned OCI image still exports", async () => {
    // proposeApprovedChangeInA seeds a passing scan for the OCI digest ONLY — never the SBOM digest.
    const { changeId } = await proposeApprovedChangeInA(sourceRefWithArtifacts);
    const bundle = await exportBundleA(changeId);
    // The SBOM blob is present in the artifact set but was NOT independently scan-gated.
    const blob = bundle.artifacts!.find((a) => a.type === "blob");
    expect(blob?.digest).toBe(SBOM_DIGEST);
    // And the manifest still enumerates BOTH (self-binding covers the full set).
    expect(bundle.promotionManifest!.artifacts.map((a) => a.digest)).toEqual([
      OCI_DIGEST,
      SBOM_DIGEST
    ]);
  });

  it("E6 CHECKSUM-EXCLUDED: the Ed25519 checksum is byte-identical with vs without the manifest fields", async () => {
    const { changeId } = await proposeApprovedChangeInA(sourceRefWithArtifacts);
    const bundle = await exportBundleA(changeId);
    expect(bundle.promotionManifest).toBeDefined();
    // The exporter's own checksum verifies over the payload that EXCLUDES the manifest fields.
    expect(computeBundleChecksum(promotionChecksumPayload(bundle))).toBe(bundle.checksum);
    // Stripping BOTH manifest siblings changes nothing under the checksum (E3 invariant preserved).
    const { promotionManifest: _m, manifestSignature: _s, ...withoutManifest } = bundle;
    expect(
      computeBundleChecksum(promotionChecksumPayload(withoutManifest as PromotionBundle))
    ).toBe(bundle.checksum);
  });

  it("E6 CHECKSUM byte-identity holds when the manifest siblings are stripped (they were never in the checksum)", async () => {
    const { changeId } = await proposeApprovedChangeInA(sourceRefWithArtifacts);
    const bundle = await exportBundleA(changeId);

    // Drop the manifest siblings — the Ed25519 checksum/signature STILL verify (they were never in
    // the checksum payload; the E3/E6 invariant). This is the byte-identity claim only.
    const { promotionManifest: _m, manifestSignature: _s, ...oldShape } = bundle;
    const oldBundle = oldShape as PromotionBundle;
    expect(oldBundle.promotionManifest).toBeUndefined();
    expect(oldBundle.manifestSignature).toBeUndefined();

    const aKey = await withTenantTx(domainA.db, domainA.orgId, (tx) =>
      ensureInstanceKey(tx, domainA.orgId)
    );
    expect(computeBundleChecksum(promotionChecksumPayload(oldBundle))).toBe(oldBundle.checksum);
    expect(
      verifyBundleSignature(oldBundle.checksum, oldBundle.bundleSignature, aKey.publicKey)
    ).toBe(true);

    // BUT domainB paired domainA E5-complete (has its cosign key), so M17.4(a) treats a manifest-less
    // bundle from an E6-capable peer as a DOWNGRADE attack — rejected fail-closed (the receiver refuses
    // to silently accept the strictly-weaker Ed25519-only bundle). The genuine pre-E5 back-compat path
    // (no cosign key registered → ACCEPT) is covered in the M17.4(a) receiver-verify block below.
    await expect(
      importPromotionBundle(domainB.db, domainB.orgId, oldBundle)
    ).rejects.toMatchObject({ status: 409 });
  });

  it("E6 SWAP-DEFENSE: a manifestSignature does NOT verify against a DIFFERENT bundle's manifest", async () => {
    // Two DISTINCT promotions (different change ids / URNs / artifact digests).
    const otherOci = "sha256:" + "1".repeat(64);
    const a = await proposeApprovedChangeInA(sourceRefWithArtifacts);
    const b = await proposeApprovedChangeInA({ artifact_digest: otherOci });
    const bundleA = await exportBundleA(a.changeId);
    const bundleB = await exportBundleA(b.changeId);
    expect(bundleA.promotionManifest!.sourceChangeObjectId).not.toBe(
      bundleB.promotionManifest!.sourceChangeObjectId
    );

    const cosignPub = await getInstanceCosignPublicKey(domainA.db, domainA.orgId);
    // Control: A's signature verifies against A's OWN manifest.
    expect(
      await verifyBlob(
        canonicalStringify(bundleA.promotionManifest),
        bundleA.manifestSignature!,
        cosignPub.publicKey
      )
    ).toBe(true);
    // Attack: A's signature LIFTED onto B's manifest does NOT verify (self-binding broke the swap).
    expect(
      await verifyBlob(
        canonicalStringify(bundleB.promotionManifest),
        bundleA.manifestSignature!,
        cosignPub.publicKey
      )
    ).toBe(false);
  });

  it("E6 EDGE CASE — no substantive artifact: a metadata-only promotion EXPORTS (vacuous pass) with a signed manifest over an empty artifact set", async () => {
    // No sourceRef → no oci/rpm/deb/npm/config/infra artifact to scan. Owner-confirmed behavior: the
    // gate ("every substantive artifact is scanned") is vacuously satisfied, so export PROCEEDS — a
    // config/policy-only promotion is not blocked — and still carries a cosign-signed manifest.
    const { changeId } = await proposeApprovedChangeInA();
    const bundle = await exportBundleA(changeId);
    expect(bundle.artifacts).toBeUndefined(); // no typed artifact set on the envelope
    expect(bundle.promotionManifest).toBeDefined();
    expect(bundle.promotionManifest!.artifacts).toEqual([]); // manifest binds an empty set
    const cosignPub = await getInstanceCosignPublicKey(domainA.db, domainA.orgId);
    expect(
      await verifyBlob(
        canonicalStringify(bundle.promotionManifest),
        bundle.manifestSignature!,
        cosignPub.publicKey
      )
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// M17.4(a) / M15.2 — RECEIVER-side verification of the commander's cosign-signed promotion
// manifest at bundle import (the OUTPOST's universal pre-deploy validation, ADR-0011). ONE gate
// runs at every receiving hop; the outpost NEVER re-scans (trust scan-at-source). Fail-closed over
// signature + set-equality + the tie + self-binding + a downgrade defense. Part-(b) (per-artifact
// origin verify at the outpost's registry) is DEFERRED to M15.5 (the artifact-bytes channel).
// ---------------------------------------------------------------------------------------------
describe("M17.4(a) / M15.2 receiver manifest verification (Testcontainers)", () => {
  let commander: IsolatedDomain; // the exporting commander
  let outpostWithKey: IsolatedDomain; // paired E5-complete (has the commander's cosign key)
  let outpostNoKey: IsolatedDomain; // paired pre-E5 (NO cosign key — the back-compat axis)
  let selfCommander: FederationSelf;

  const OCI = "sha256:" + "c".repeat(64);

  beforeAll(async () => {
    commander = await createIsolatedDomain("m174Commander");
    outpostWithKey = await createIsolatedDomain("m174WithKey");
    outpostNoKey = await createIsolatedDomain("m174NoKey");
    selfCommander = await withTenantTx(commander.db, commander.orgId, (tx) =>
      ensureFederationSelf(tx, commander.orgId)
    );

    // commander ↔ outpostWithKey: E5-complete — the outpost holds the commander's cosign key, so the
    // receiver gate can verify the commander's manifests.
    await pair(commander, outpostWithKey, "outpost", undefined, { cosign: true });
    await pair(outpostWithKey, commander, "commander", undefined, { cosign: true });
    // commander ↔ outpostNoKey: LEGACY — the outpost's record of the commander carries NO cosign key
    // (a genuine pre-E5 peer), so a manifest-less bundle is honest back-compat, not a downgrade.
    await pair(commander, outpostNoKey, "outpost");
    await pair(outpostNoKey, commander, "commander");
  }, 120_000);

  afterAll(async () => {
    await commander.close();
    await outpostWithKey.close();
    await outpostNoKey.close();
  });

  async function seedPassingScan(changeId: string, ociDigest: string): Promise<void> {
    await withTenantTx(commander.db, commander.orgId, (tx) =>
      insertControlRun(tx, {
        orgId: commander.orgId,
        controlObjectId: randomUUID(),
        changeObjectId: changeId,
        gateKind: "lifecycle_edge",
        gateRef: { fromState: "validating", toState: "promoted" },
        status: "pass",
        evidence: {
          scanner: "trivy",
          scannerVersion: "0.50.0",
          artifactDigest: ociDigest,
          expectedDigest: ociDigest,
          digestMatch: true,
          severityCounts: { critical: 0, high: 0, medium: 0, low: 0 },
          threshold: { maxCritical: 0, maxHigh: 0 }
        }
      })
    );
  }

  /** Build a valid, cosign-signed promotion bundle addressed to `receiver`, with the change's target
   *  synced there first so a legit import can resolve it. `sourceRef.artifact_digest` (when present)
   *  is auto scan-gated so the E6 export gate passes. */
  async function buildBundleToward(
    receiver: IsolatedDomain,
    sourceRef: Record<string, unknown>
  ): Promise<PromotionBundle> {
    const target = await withTenantTx(commander.db, commander.orgId, (tx) =>
      createObject(tx, {
        orgId: commander.orgId,
        domainId: null,
        typeId: "service",
        actorObjectId: commander.orgId,
        requestId: "m174-target",
        name: `m174-target-${randomUUID()}`
      })
    );
    // Sync the target (and any not-yet-sent objects) to the receiver from ITS cursor.
    const cursor = await withTenantTx(receiver.db, receiver.orgId, (tx) =>
      getCursor(tx, receiver.orgId, selfCommander.domainId, selfCommander.domainId)
    );
    const syncBundle = await withTenantTx(commander.db, commander.orgId, (tx) =>
      exportSyncBundle(tx, commander.orgId, receiver.orgName, cursor.sequence)
    );
    await withTenantTx(receiver.db, receiver.orgId, (tx) =>
      importSyncBundle(tx, receiver.orgId, syncBundle)
    );

    const { change } = await withTenantTx(commander.db, commander.orgId, (tx) =>
      proposeChange(tx, {
        orgId: commander.orgId,
        actorObjectId: commander.orgId,
        requestId: "m174-change",
        name: `m174-change-${randomUUID()}`,
        targets: [target.id],
        sourceRef
      })
    );
    const oci = typeof sourceRef.artifact_digest === "string" ? sourceRef.artifact_digest : undefined;
    if (oci) await seedPassingScan(change.id, oci);

    const outcome = await exportPromotionBundle(commander.db, {
      orgId: commander.orgId,
      peerIdOrName: receiver.orgName,
      changeIdOrUrn: change.id
    });
    if (outcome.refused) throw new Error(`unexpected export refusal: ${outcome.reason}`);
    return outcome.bundle;
  }

  /** Import and capture the fail-closed 409 (with its surfaced decision_id). */
  async function expectImportBlocked(
    receiver: IsolatedDomain,
    bundle: PromotionBundle
  ): Promise<{ status: number; decisionId?: string; detail?: string }> {
    try {
      await importPromotionBundle(receiver.db, receiver.orgId, bundle);
      throw new Error("expected importPromotionBundle to reject fail-closed");
    } catch (err) {
      const e = err as { status?: number; decisionId?: string; detail?: string };
      expect(e.status).toBe(409);
      return { status: e.status!, decisionId: e.decisionId, detail: e.detail };
    }
  }

  it("(b) a MATCHING bundle imports (signature + set-equality + tie + self-binding all hold)", async () => {
    const bundle = await buildBundleToward(outpostWithKey, { artifact_digest: OCI });
    expect(bundle.promotionManifest).toBeDefined();
    const result = await importPromotionBundle(outpostWithKey.db, outpostWithKey.orgId, bundle);
    expect(result.localChangeObjectId).toBeTruthy();
    expect(result.importedFromDomain).toBe(selfCommander.domainId);
  });

  it("(a) an INJECTED/SUBSTITUTED artifacts[] entry is REJECTED with a block Decision (set-equality)", async () => {
    const bundle = await buildBundleToward(outpostWithKey, { artifact_digest: OCI });
    // Substitute the arrived typed set for a DIFFERENT digest WITHOUT touching the cosign manifest.
    // artifacts[] is EXCLUDED from the Ed25519 checksum, so the envelope still verifies — only the
    // cosign manifest's set-equality catches the swap.
    const injected: PromotionBundle = {
      ...bundle,
      artifacts: [{ type: "oci", digest: "sha256:" + "9".repeat(64) }]
    };
    const blocked = await expectImportBlocked(outpostWithKey, injected);
    expect(blocked.decisionId).toBeTruthy();
    const decision = await withTenantTx(outpostWithKey.db, outpostWithKey.orgId, (tx) =>
      getDecision(tx, outpostWithKey.orgId, blocked.decisionId!)
    );
    expect(decision.verdict).toBe("block");
    expect(decision.kind).toBe("promotion-import-manifest-verify");
  });

  it("(c) a LIFTED manifest (from a different bundle) is REJECTED (self-binding)", async () => {
    const bundleX = await buildBundleToward(outpostWithKey, { artifact_digest: OCI });
    const bundleY = await buildBundleToward(outpostWithKey, {
      artifact_digest: "sha256:" + "2".repeat(64)
    });
    // Lift Y's cosign-signed manifest + signature onto X's bundle. Y's signature verifies over Y's
    // manifest, but Y's manifest binds Y's changeUrn/sourceChangeObjectId — not X's — so self-binding
    // rejects the swap.
    const lifted: PromotionBundle = {
      ...bundleX,
      promotionManifest: bundleY.promotionManifest,
      manifestSignature: bundleY.manifestSignature
    };
    const blocked = await expectImportBlocked(outpostWithKey, lifted);
    expect(blocked.decisionId).toBeTruthy();
  });

  it("(d) a tampered artifactDigests that DIVERGES from the manifest is REJECTED (the tie)", async () => {
    const bundle = await buildBundleToward(outpostWithKey, { artifact_digest: OCI });
    // Tamper the Ed25519-anchored artifactDigests to diverge from the manifest, but leave artifacts[]
    // matching the manifest (so set-equality still passes and the TIE is what catches it). Re-sign the
    // Ed25519 envelope with the commander's REAL key so the transport gate passes and control reaches
    // the manifest verify — isolating the tie from the checksum check.
    const commanderKey = await withTenantTx(commander.db, commander.orgId, (tx) =>
      ensureInstanceKey(tx, commander.orgId)
    );
    const tampered = resignPromotionBundle(
      { ...bundle, artifactDigests: ["sha256:" + "3".repeat(64)] },
      commanderKey.privateKey
    );
    const blocked = await expectImportBlocked(outpostWithKey, tampered);
    expect(blocked.decisionId).toBeTruthy();
    const decision = await withTenantTx(outpostWithKey.db, outpostWithKey.orgId, (tx) =>
      getDecision(tx, outpostWithKey.orgId, blocked.decisionId!)
    );
    expect(decision.reasonTree.summary).toMatch(/anchors diverge|artifactDigests/i);
  });

  it("(e) a genuine pre-E5 bundle (no manifest, peer has NO cosign key) is ACCEPTED (back-compat)", async () => {
    // Metadata-only promotion toward the LEGACY outpost, then strip the E6 manifest siblings to model
    // a genuine pre-E5/E6 Ed25519-only bundle. The legacy outpost has no cosign trust anchor for the
    // commander, so this is honest back-compat — ACCEPT.
    const bundle = await buildBundleToward(outpostNoKey, {});
    const { promotionManifest: _m, manifestSignature: _s, ...oldShape } = bundle;
    const oldBundle = oldShape as PromotionBundle;
    expect(oldBundle.promotionManifest).toBeUndefined();
    const result = await importPromotionBundle(outpostNoKey.db, outpostNoKey.orgId, oldBundle);
    expect(result.localChangeObjectId).toBeTruthy();
  });

  it("(f) DOWNGRADE: no manifest but the peer HAS a cosign key is REJECTED", async () => {
    // Same strip, but toward the E5-complete outpost that DOES hold the commander's cosign key — a
    // manifest-less bundle from an E6-capable peer is a downgrade attack, rejected fail-closed.
    const bundle = await buildBundleToward(outpostWithKey, { artifact_digest: OCI });
    const { promotionManifest: _m, manifestSignature: _s, ...oldShape } = bundle;
    const stripped = oldShape as PromotionBundle;
    const blocked = await expectImportBlocked(outpostWithKey, stripped);
    expect(blocked.decisionId).toBeTruthy();
    const decision = await withTenantTx(outpostWithKey.db, outpostWithKey.orgId, (tx) =>
      getDecision(tx, outpostWithKey.orgId, blocked.decisionId!)
    );
    expect(decision.reasonTree.summary).toMatch(/DOWNGRADE/i);
  });

  it("(g) a BAD manifestSignature is REJECTED (signature)", async () => {
    const bundle = await buildBundleToward(outpostWithKey, { artifact_digest: OCI });
    const other = await buildBundleToward(outpostWithKey, {
      artifact_digest: "sha256:" + "4".repeat(64)
    });
    // Replace the signature with a valid-base64 but WRONG signature (another bundle's) — cosign
    // verify-blob returns false over this manifest, so the gate rejects fail-closed.
    const badSig: PromotionBundle = { ...bundle, manifestSignature: other.manifestSignature };
    const blocked = await expectImportBlocked(outpostWithKey, badSig);
    expect(blocked.decisionId).toBeTruthy();
  });
});
