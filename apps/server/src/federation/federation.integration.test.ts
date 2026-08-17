import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { randomUUID, generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import pg from "pg";
import type { SyncBundle, SyncScope } from "@scp/schemas";
import { withTenantTx } from "../db/tenant-tx.js";
import { ProblemError } from "../errors.js";
import { changes, decisions, objects, roleBindings, roles, sourceMappings } from "../db/schema.js";
import { createSourceMapping } from "../coordination/source-mappings-repo.js";
import { createObject, getObjectByIdOrUrnAnyType, updateObject } from "../graph/objects-repo.js";
import { ensureInstanceKey } from "../governance/attestation.js";
import { ensureFederationSelf, type FederationSelf } from "./self-repo.js";
import { pairPeer, listPeers, getPeerByIdOrName, markPokeReceived } from "./peers-repo.js";
import { getFederationStatus } from "./status-repo.js";
import { peerSyncCadence } from "./federation-sync.js";
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
import {
  proposeChange,
  getChange,
  requiresOf,
  stageDependenciesOf
} from "../coordination/changes-repo.js";
import { enforceLocalChangeAuthority } from "../coordination/transition.js";
import { materializeApprovalRequest, castApprovalVote } from "../governance/approvals-repo.js";
import { insertControlRun } from "../governance/controls-repo.js";
import { getInstanceCosignPublicKey } from "../governance/cosign-keys.js";
import { getDecision } from "../coordination/decisions-repo.js";
import { listAuditEvents } from "../audit/audit-repo.js";
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
import { verifyAuditChain } from "@scp/schemas/audit-chain";
import type { ControlOutcomeStatus, PromotionBundle } from "@scp/schemas";
import { PromotionBundleSchema } from "@scp/schemas";
import { TrustDomainId } from "@scp/schemas";
import { asTrustDomainId } from "@scp/schemas";

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
        // M21.7 — authorization-only subject. `service` is not governance-managed, so the
        // `policy:write` check `handFillObject` gained does not fire and any id will do; the
        // governance case is asserted in `governance-managed-write-doors.integration.test.ts`.
        actorObjectId: domainB.orgId,
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

    // M21.7 — a GOVERNANCE overlay now needs a real `policy:write` author, so this case names one
    // instead of passing the org-root OBJECT as its actor. `createOverlay` gained the governance
    // permission check the three type guards beside it always implied (`federation/overlay-repo.ts`
    // — an Operator was minting live org-wide policies through this door), and the org root object
    // holds no role bindings, so the old actor is refused. This case is about overlay MECHANICS
    // (replicated base, merged view, base never mutated) and an authorized author is what lets it
    // reach them; the refusal itself is asserted in
    // `governance/governance-managed-write-doors.integration.test.ts`.
    const policyAuthor = await createApprover(domainB, "Administrator");
    const { overlay } = await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      createOverlay(tx, {
        orgId: domainB.orgId,
        actorObjectId: policyAuthor.objectId,
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
    ).rejects.toMatchObject({
      status: 403,
      detail: expect.stringMatching(/must belong to a service/i)
    });
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

    // M21.7 — an AUTHORIZED policy author (see the overlay round-trip case above for why). The point
    // of this case is that `policy:write` is not a licence to WEAKEN a base policy: the actor clears
    // the new governance permission check and is still refused by
    // `assertPolicyOverlayOnlyAddsStrictness`, with a 400 rather than a 403. Passing an unauthorized
    // actor here would make it green off the permission refusal and prove nothing about strictness.
    const strictnessAuthor = await createApprover(domainB, "Administrator");
    await expect(
      withTenantTx(domainB.db, domainB.orgId, (tx) =>
        createOverlay(tx, {
          orgId: domainB.orgId,
          actorObjectId: strictnessAuthor.objectId,
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
    opts: {
      seedScan?: boolean;
      /** M12 P4B: propose the change WITH a coupling — `provides: ["feature-a"]` and
       *  `requires: [{key: "infra-ready", at: <the change's own freshly-created target>}]` — to
       *  exercise the promotion-import strip (§8 Q2). The target doubles as the `at` scope because
       *  `requires[].at` must resolve in domain A at propose time. */
      coupling?: boolean;
      /** ADR-0028: propose the change with a declared `stageDependencies` naming a second object
       *  in domain A, to exercise the promotion-import strip. A separate object rather than the
       *  change's own target, because a self-declaration mints no `depends_on` edge and would make
       *  the fixture answer an easier question than the real one. A COMPONENT specifically:
       *  `dependsOn` is refused for anything else at propose time, since only a component can be
       *  placed and therefore only a component can ever be held against. */
      stageCoupling?: boolean;
    } = {}
  ): Promise<{
    changeId: string;
    changeUrn: string;
    targetId: string;
    stageDependsOnId: string;
  }> {
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
    const stageDependsOn = await withTenantTx(domainA.db, domainA.orgId, (tx) =>
      createObject(tx, {
        orgId: domainA.orgId,
        domainId: null,
        typeId: "component",
        actorObjectId: domainA.orgId,
        requestId: "t-promo-stage-dep",
        name: `promo-stage-dep-${randomUUID()}`
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
        ...(sourceRef ? { sourceRef } : {}),
        ...(opts.coupling
          ? { provides: ["feature-a"], requires: [{ key: "infra-ready", at: target.id }] }
          : {}),
        ...(opts.stageCoupling
          ? { stageDependencies: [{ dependsOn: stageDependsOn.id, minWeight: 25 }] }
          : {})
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

    return {
      changeId: change.id,
      changeUrn: change.urn,
      targetId: target.id,
      stageDependsOnId: stageDependsOn.id
    };
  }

  /** Insert a `trivy` scan control run for `changeId`. Defaults to the PASSING, digest-bound outcome
   *  the M17.3 E6 export gate re-checks (status pass + digestMatch + scanned digest == promoted); the
   *  overrides let a test seed a FAILED or digest-mismatched outcome to exercise the fail-closed path.
   *
   *  `pluginModule` NAMES THE PRODUCER, and is not fixture decoration. E6 admits a scan outcome by
   *  which control produced it (`scan-evidence.ts`), so a row with no module — which is what this
   *  helper used to write — is no longer evidence about anything. The honest fixture for
   *  "org-pipeline evidence" is the module that actually produces it. The gate's REFUSAL of the
   *  no-module and wrong-module shapes is pinned in `scan-evidence.test.ts` and by the
   *  "webhook-control cannot manufacture a crossing" case below. */
  async function seedScanOutcome(
    changeId: string,
    ociDigest: string,
    over: {
      status?: ControlOutcomeStatus;
      digestMatch?: boolean;
      scannedDigest?: string;
      pluginModule?: string | undefined;
      controlObjectId?: string;
      severityCounts?: { critical: number; high: number; medium: number; low: number };
      /** The ceiling the PRODUCING control applied. A tenant-authored per-binding
       *  `config.threshold` lives here, which is why a `pass` under it is not the boundary's
       *  verdict — see the instance-floor case. */
      threshold?: Record<string, number>;
    } = {}
  ): Promise<void> {
    await withTenantTx(domainA.db, domainA.orgId, (tx) =>
      insertControlRun(tx, {
        orgId: domainA.orgId,
        controlObjectId: over.controlObjectId ?? randomUUID(),
        changeObjectId: changeId,
        gateKind: "lifecycle_edge",
        gateRef: { fromState: "validating", toState: "accepted" },
        pluginModule: "pluginModule" in over ? over.pluginModule : ("scan-result-control" as const),
        status: over.status ?? "pass",
        evidence: {
          scanner: "trivy",
          scannerVersion: "0.50.0",
          artifactDigest: over.scannedDigest ?? ociDigest,
          expectedDigest: ociDigest,
          digestMatch: over.digestMatch ?? true,
          severityCounts: over.severityCounts ?? { critical: 0, high: 0, medium: 0, low: 0 },
          threshold: over.threshold ?? { maxCritical: 0, maxHigh: 0 }
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

  it("S10 PRECONDITION PIN: an imported promotion's change object is LOCALLY originated (origin != provenance), so the single-writer guard permits B to drive it", async () => {
    // THE REGRESSION THIS EXISTS TO PREVENT (S10, `enforceLocalChangeAuthority`'s doc comment):
    // that guard refuses a change whose graph object's `originDomainId` is not this domain. It is
    // only safe to key on `originDomainId` BECAUSE `importPromotionBundle` calls `proposeChange`
    // FRESH in the receiver — control genuinely transfers, and the exporting domain is recorded
    // separately as `changes.imported_from_domain`. A guard keyed on `importedFromDomain` instead
    // would refuse B every verb on every change it ever accepted by promotion. Nothing pinned that
    // precondition before: it was an argument in a comment, and a refactor of `importPromotionBundle`
    // that stamped the exporter as the origin would have broken promotion acceptance silently.
    const { changeId } = await proposeApprovedChangeInA();
    const result = await importPromotionBundle(
      domainB.db,
      domainB.orgId,
      await exportBundleA(changeId)
    );

    const selfB = await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      ensureFederationSelf(tx, domainB.orgId)
    );
    const imported = await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      getObjectByIdOrUrnAnyType(tx, domainB.orgId, result.localChangeObjectId)
    );

    // 1. THE TWO FIELDS ARE DISTINCT, ON THE SAME ROW. Origin is B (authority transferred);
    //    provenance is A (where it came from). A guard reading the wrong one fails right here.
    expect(imported.originDomainId).toBe(selfB.domainId);
    expect(imported.originDomainId).not.toBe(selfA.domainId);
    const [importedRow] = await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      tx
        .select({ importedFromDomain: changes.importedFromDomain })
        .from(changes)
        .where(
          and(eq(changes.orgId, domainB.orgId), eq(changes.objectId, result.localChangeObjectId))
        )
    );
    expect(importedRow!.importedFromDomain).toBe(selfA.domainId);

    // 2. THE GUARD ITSELF ALLOWS IT — asserted against the real function, not inferred from (1).
    //    This is the assertion that would go red if the guard were re-keyed on provenance.
    const authority = await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      enforceLocalChangeAuthority(tx, {
        orgId: domainB.orgId,
        changeObjectId: result.localChangeObjectId,
        originDomainId: imported.originDomainId,
        actorObjectId: domainB.orgId,
        requestId: "s10-precondition-pin"
      })
    );
    expect(authority.ok).toBe(true);

    // 3. NEGATIVE CONTROL: the same guard, same change, keyed on the PROVENANCE domain — i.e. what
    //    the wrong implementation would have passed — is REFUSED. Without this arm, (2) passing
    //    could just mean the guard permits everything.
    const wrongKey = await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      enforceLocalChangeAuthority(tx, {
        orgId: domainB.orgId,
        changeObjectId: result.localChangeObjectId,
        originDomainId: importedRow!.importedFromDomain!,
        actorObjectId: domainB.orgId,
        requestId: "s10-precondition-pin-negative"
      })
    );
    expect(wrongKey.ok).toBe(false);
  });

  it("M12 P4B §8 Q2 round-trip: promotion STRIPS `requires` (imported change can never park in `waiting`), PRESERVES `provides` verbatim, and records the strip Decision", async () => {
    // The change in A carries BOTH halves of a coupling: it provides `feature-a` and requires
    // `infra-ready` at its own target (a real object in A, so propose-time `at` resolution passes).
    const { changeId, targetId } = await proposeApprovedChangeInA(undefined, { coupling: true });

    const bundle = await exportBundleA(changeId);
    // The bundle itself carries the coupling VERBATIM (federation is a properties passthrough) —
    // this is what makes the import-side strip assertion below meaningful rather than vacuous.
    const bundleProps = bundle.change.properties as Record<string, unknown>;
    expect(bundleProps.requires).toEqual([{ key: "infra-ready", at: targetId }]);
    expect(bundleProps.provides).toEqual(["feature-a"]);

    const result = await importPromotionBundle(domainB.db, domainB.orgId, bundle);

    // 1. `requires` is STRIPPED on import (owner ruling: the commander already enforced the
    //    coupling; its promotion IS the go-ahead — re-evaluating locally would be redundant or
    //    deadlock). With zero requirements the routing guard sends the change coordinated ->
    //    executing, never `waiting` (guard behaviour pinned by coupling.integration.test.ts).
    // 2. `provides` is PRESERVED VERBATIM — this pins promotion-repo's properties spread against a
    //    refactor: a promoted infra change must still be able to satisfy a LOCALLY-authored waiter
    //    in the receiving domain.
    const imported = await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      getObjectByIdOrUrnAnyType(tx, domainB.orgId, result.localChangeObjectId)
    );
    const importedProps = imported.properties as Record<string, unknown>;
    expect(importedProps.requires).toBeUndefined();
    expect(importedProps.provides).toEqual(["feature-a"]);
    const parsed = requiresOf(importedProps);
    expect(parsed.requirements).toEqual([]);
    expect(parsed.malformed).toEqual([]);

    // 3. The strip is an engine verdict, so it is EXPLAINABLE (charter principle 6): a Decision in
    //    the SAME import transaction pins the stripped requirements verbatim, with the "satisfied
    //    upstream at commander" rationale.
    const stripDecisions = await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      tx
        .select()
        .from(decisions)
        .where(
          and(
            eq(decisions.orgId, domainB.orgId),
            eq(decisions.subjectId, result.localChangeObjectId),
            eq(decisions.kind, "coupling")
          )
        )
    );
    expect(stripDecisions).toHaveLength(1);
    expect(stripDecisions[0]!.verdict).toBe("allow");
    const inputContext = stripDecisions[0]!.inputContext as Record<string, unknown>;
    expect(inputContext.strippedRequires).toEqual([{ key: "infra-ready", at: targetId }]);
    const reasonTree = stripDecisions[0]!.reasonTree as { summary?: string };
    expect(reasonTree.summary).toContain("requires satisfied upstream at commander");

    // 4. An UNCOUPLED promotion stays byte-identical: no strip Decision is written for it.
    const plain = await proposeApprovedChangeInA();
    const plainResult = await importPromotionBundle(
      domainB.db,
      domainB.orgId,
      await exportBundleA(plain.changeId)
    );
    const plainDecisions = await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      tx
        .select()
        .from(decisions)
        .where(
          and(
            eq(decisions.orgId, domainB.orgId),
            eq(decisions.subjectId, plainResult.localChangeObjectId),
            eq(decisions.kind, "coupling")
          )
        )
    );
    expect(plainDecisions).toHaveLength(0);

    // The imported change's projection row exists and is in `proposed` — the coupling strip never
    // pre-advances the local lifecycle; local gates still apply from the start.
    const importedRow = await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      tx.select().from(changes).where(eq(changes.objectId, result.localChangeObjectId))
    );
    expect(importedRow[0]!.state).toBe("proposed");
  });

  it("ADR-0028 round-trip: promotion STRIPS `stageDependencies`, and records WHY rather than losing the coupling silently", async () => {
    // WHAT THIS PREVENTS. A promoted change is re-proposed LOCALLY with this domain's own origin, so
    // reconcile's foreign-origin skip does not exclude it and the outpost really would evaluate the
    // coupling. But `change_wave_targets`/`observed_state` are journaled by nothing and
    // `relationship_upsert` ships only under sync scope `full`; under any narrower scope the
    // depended-on component is not here at all, every verdict resolves to `not_placed` -> SATISFIED,
    // and the release fires with no hold and NO RECORD — the silent fail-open ADR-0028's own
    // Consequences call the worst available answer. Stripping defers the open federation ruling (D5)
    // instead of shipping it.
    const { changeId, stageDependsOnId } = await proposeApprovedChangeInA(undefined, {
      stageCoupling: true
    });

    const bundle = await exportBundleA(changeId);
    // The bundle carries the declaration VERBATIM (federation is a properties passthrough) — which
    // is what makes the import-side assertion below a real one rather than a vacuous absence.
    const bundleProps = bundle.change.properties as Record<string, unknown>;
    expect(bundleProps.stageDependencies).toEqual([{ dependsOn: stageDependsOnId, minWeight: 25 }]);

    const result = await importPromotionBundle(domainB.db, domainB.orgId, bundle);

    const imported = await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      getObjectByIdOrUrnAnyType(tx, domainB.orgId, result.localChangeObjectId)
    );
    const importedProps = imported.properties as Record<string, unknown>;
    expect(importedProps.stageDependencies).toBeUndefined();
    // Asserted through the READER the hold actually uses, not only the raw key: a strip that left
    // the value somewhere `stageDependenciesOf` still finds would pass a key check and fail here.
    const parsed = stageDependenciesOf(importedProps);
    expect(parsed.stageDependencies).toEqual([]);
    expect(parsed.malformed).toEqual([]);

    // The strip is an engine verdict, so it is EXPLAINABLE (charter principle 6) — recorded under the
    // HOLD's own kind, so the row says which mechanism removed the declaration rather than leaving an
    // unexplained absence. An operator reaches it by the promoted change (`scp change explain <id>`,
    // or `scp decision list --subject-id <change-id>`) or, since ADR-0028 increment 4, without the
    // change id at all: `scp decision list --kind stage_dependency`. That filter now exists — see
    // `promotion-repo.ts`'s note, and `decisions-kind-filter.integration.test.ts` for its own test.
    // The verdict below is what distinguishes THIS row from a hold under the same kind.
    const stripDecisions = await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      tx
        .select()
        .from(decisions)
        .where(
          and(
            eq(decisions.orgId, domainB.orgId),
            eq(decisions.subjectId, result.localChangeObjectId),
            eq(decisions.kind, "stage_dependency")
          )
        )
    );
    expect(stripDecisions).toHaveLength(1);
    expect(stripDecisions[0]!.verdict).toBe("allow");
    const inputContext = stripDecisions[0]!.inputContext as Record<string, unknown>;
    expect(inputContext.strippedStageDependencies).toEqual([
      { dependsOn: stageDependsOnId, minWeight: 25 }
    ]);
    const reasonTree = stripDecisions[0]!.reasonTree as { summary?: string };
    expect(reasonTree.summary).toContain("enforced upstream at the commander");

    // An UNCOUPLED promotion stays byte-identical: no strip Decision is written for it.
    const plain = await proposeApprovedChangeInA();
    const plainResult = await importPromotionBundle(
      domainB.db,
      domainB.orgId,
      await exportBundleA(plain.changeId)
    );
    const plainDecisions = await withTenantTx(domainB.db, domainB.orgId, (tx) =>
      tx
        .select()
        .from(decisions)
        .where(
          and(
            eq(decisions.orgId, domainB.orgId),
            eq(decisions.subjectId, plainResult.localChangeObjectId),
            eq(decisions.kind, "stage_dependency")
          )
        )
    );
    expect(plainDecisions).toHaveLength(0);
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
    expect(
      computeBundleChecksum(promotionChecksumPayload(withoutArtifacts as PromotionBundle))
    ).toBe(bundle.checksum);
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
    expect(
      verifyBundleSignature(oldBundle.checksum, oldBundle.bundleSignature, aKey.publicKey)
    ).toBe(true);

    // BUT M17.4(a) now BINDS artifacts[] via the cosign manifest (which enumerates [oci, sbom]) — so
    // stripping the typed set while the manifest still claims it is a DETECTED set-equality violation
    // (the Ed25519 layer is blind to it; the cosign layer is not). Rejected fail-closed.
    await expect(importPromotionBundle(domainB.db, domainB.orgId, oldBundle)).rejects.toMatchObject(
      { status: 409 }
    );
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
    expect(JSON.stringify(promotionChecksumPayload(bundle))).not.toContain('"artifacts"');
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
    await expect(importPromotionBundle(domainB.db, domainB.orgId, tampered)).rejects.toMatchObject({
      status: 409,
      detail: expect.stringMatching(/checksum mismatch/)
    });
  });

  // -----------------------------------------------------------------------------------------
  // M17.3 (E6) — the CAPSTONE. Export HARD-REFUSES (with a decision_id) every cross-boundary
  // promotion lacking a passing, digest-bound scan for each SUBSTANTIVE artifact (SBOM EXEMPT), and
  // co-signs a SELF-BINDING cosign manifest (no swap vector) that is EXCLUDED from the Ed25519
  // checksum. SCP signs only its OWN manifest (coordinate-not-execute). Uses REAL cosign.
  // -----------------------------------------------------------------------------------------

  it("E6 HARD-GATE: a substantive artifact with a FAILED scan is REFUSED at export with a decision_id", async () => {
    const { changeId } = await proposeApprovedChangeInA(sourceRefWithArtifacts, {
      seedScan: false
    });
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

  // -----------------------------------------------------------------------------------------
  // M20 (ADR-0031 §7) — DOMAIN-LOCALITY IS INERT AT E6, AND THE SECOND EGRESS IS GUARDED.
  //
  // ADR-0031 §7 makes locality VISIBILITY ONLY: it grants no scan exemption, relaxes no gate, and is
  // read by no governance path. That claim is exactly the thing ADR-0018 §1 rejected a per-artifact
  // `dev` bit for — a bit that could be lifted onto a boundary-crossing artifact — so it needs a
  // witness rather than a comment. ADR-0018 §4 imposed the same obligation on its own label.
  //
  // Two complementary properties, and they must not be confused with each other:
  //
  //   (a) INERTNESS. Setting or clearing `domain_local` anywhere changes NO E6 outcome. The refusal
  //       for a missing scan is byte-identical; a passing scan still exports.
  //   (b) ENFORCEMENT AT THE SECOND EGRESS. A domain-local change is refused a crossing OUTRIGHT,
  //       under its OWN decision kind, BEFORE the scan step runs — so it is never "exempted from
  //       scanning", it is denied the crossing. `exportPromotionBundle` does not read the journal,
  //       so §2's never-journal withholding does not reach it; this is the guard that does.
  // -----------------------------------------------------------------------------------------

  it("M20 SECOND EGRESS: a DOMAIN-LOCAL change is refused promotion outright — under its own decision kind", async () => {
    const { changeId, targetId } = await proposeApprovedChangeInA(sourceRefWithArtifacts, {
      seedScan: true // a PASSING scan: the refusal must NOT be the scan gate's
    });
    // Publish-in-reverse is impossible, so the fixture declares locality directly on the change's
    // graph object — the state `proposeChange` would have produced had the target been declared
    // domain-local at create.
    await withTenantTx(domainA.db, domainA.orgId, (tx) =>
      tx
        .update(objects)
        .set({ domainLocal: true })
        .where(and(eq(objects.orgId, domainA.orgId), eq(objects.id, changeId)))
    );

    const outcome = await exportPromotionBundle(domainA.db, {
      orgId: domainA.orgId,
      peerIdOrName: domainB.orgName,
      changeIdOrUrn: changeId
    });
    expect(outcome.refused).toBe(true);
    if (!outcome.refused) throw new Error("expected a locality refusal");
    expect(outcome.reason).toMatch(/domain-local/i);

    const decision = await withTenantTx(domainA.db, domainA.orgId, (tx) =>
      getDecision(tx, domainA.orgId, outcome.decisionId)
    );
    expect(decision.verdict).toBe("block");
    // A DISTINCT kind from `promotion-export-scan-gate`. This is what makes the two refusals
    // impossible to confuse in an audit: a locality refusal is not a scan verdict, and a scan
    // refusal is not a locality one. Reading either as the other is precisely the conflation
    // ADR-0031 §7 exists to prevent.
    expect(decision.kind).toBe("promotion-export-domain-local");
    expect(decision.kind).not.toBe("promotion-export-scan-gate");

    void targetId;
  });

  it("M20 INERTNESS: a domain-local object elsewhere in the org changes NO E6 outcome — refusal is byte-identical", async () => {
    // (a) Baseline: an unscanned promotion is refused, with no domain-local object anywhere near it.
    const baseline = await proposeApprovedChangeInA(sourceRefWithArtifacts, { seedScan: false });
    const before = await exportPromotionBundle(domainA.db, {
      orgId: domainA.orgId,
      peerIdOrName: domainB.orgName,
      changeIdOrUrn: baseline.changeId
    });
    expect(before.refused).toBe(true);
    if (!before.refused) throw new Error("expected refusal");

    // Introduce a domain-local object into the SAME org. If locality were an enforcement input
    // anywhere, this is where it would start to matter.
    await withTenantTx(domainA.db, domainA.orgId, (tx) =>
      createObject(tx, {
        orgId: domainA.orgId,
        domainId: null,
        typeId: "component",
        actorObjectId: domainA.orgId,
        requestId: "inertness-local",
        name: `inert-local-${randomUUID()}`,
        domainLocal: true
      })
    );

    const after = await proposeApprovedChangeInA(sourceRefWithArtifacts, { seedScan: false });
    const afterOutcome = await exportPromotionBundle(domainA.db, {
      orgId: domainA.orgId,
      peerIdOrName: domainB.orgName,
      changeIdOrUrn: after.changeId
    });
    expect(afterOutcome.refused).toBe(true);
    if (!afterOutcome.refused) throw new Error("expected refusal");

    // BYTE-IDENTICAL reasons and the SAME decision kind — the gate did not notice.
    expect(afterOutcome.reason).toBe(before.reason);
    const [d1, d2] = await withTenantTx(domainA.db, domainA.orgId, async (tx) => [
      await getDecision(tx, domainA.orgId, before.decisionId),
      await getDecision(tx, domainA.orgId, afterOutcome.decisionId)
    ]);
    expect(d2.kind).toBe(d1.kind);
    expect(d2.kind).toBe("promotion-export-scan-gate");
  });

  it("M20 INERTNESS: a PASSING scan still exports cleanly with a domain-local object in the org", async () => {
    // The other direction, and the one that stops the test above from passing because promotion is
    // simply broken: locality must not block a legitimate crossing either.
    await withTenantTx(domainA.db, domainA.orgId, (tx) =>
      createObject(tx, {
        orgId: domainA.orgId,
        domainId: null,
        typeId: "component",
        actorObjectId: domainA.orgId,
        requestId: "inertness-local-2",
        name: `inert-local-2-${randomUUID()}`,
        domainLocal: true
      })
    );
    const { changeId } = await proposeApprovedChangeInA(sourceRefWithArtifacts, { seedScan: true });
    const outcome = await exportPromotionBundle(domainA.db, {
      orgId: domainA.orgId,
      peerIdOrName: domainB.orgName,
      changeIdOrUrn: changeId
    });
    expect(outcome.refused).toBe(false);
  });

  it("E6 UNIVERSAL/FAIL-CLOSED: a substantive artifact with NO scan outcome is REFUSED", async () => {
    const { changeId } = await proposeApprovedChangeInA(sourceRefWithArtifacts, {
      seedScan: false
    });
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
    const { changeId } = await proposeApprovedChangeInA(sourceRefWithArtifacts, {
      seedScan: false
    });
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

  it("E6 PRODUCER IDENTITY: a webhook-control row carrying BYTE-PERFECT scan evidence does NOT authorize a crossing — the SAME evidence from scan-result-control does", async () => {
    // THE BYPASS THIS CASE EXISTS TO CLOSE, end to end against a real database.
    //
    // `control_runs.evidence` is persisted VERBATIM from whatever a bound ControlPlugin returns
    // (`governance/control-runner.ts`: `evidence = outcome.evidence ?? {}`), and
    // `@scp/plugin-webhook-control` returns `body.status` and `body.evidence` verbatim from an
    // operator-configured URL. So a `webhook-control` binding pointed at an endpoint answering
    // `{"status":"pass","evidence":{…digestMatch:true, artifactDigest:<the promoted digest>…}}`
    // deposits exactly the row below — and while E6 identified a scan outcome by the SHAPE of its
    // evidence, that row satisfied the boundary gate in full. A control binding is authored at
    // `policy:write` SCOPED AT A CONTROL OBJECT (routes/governance.ts), which is strictly weaker
    // than the operator authority that sets the instance floors ADR-0016 §3 makes tenant-unwritable
    // precisely so a tenant cannot loosen them.
    //
    // THE TWO HALVES DIFFER IN ONE FIELD. Same change shape, same digest, byte-identical evidence —
    // only `plugin_module` differs. That is what makes this a test of the admission rule and not of
    // something incidental about the fixture.
    const forged = await proposeApprovedChangeInA(sourceRefWithArtifacts, { seedScan: false });
    await seedScanOutcome(forged.changeId, OCI_DIGEST, { pluginModule: "webhook-control" });
    const refusal = await exportPromotionBundle(domainA.db, {
      orgId: domainA.orgId,
      peerIdOrName: domainB.orgName,
      changeIdOrUrn: forged.changeId,
      scanRunner: null // the legacy org-pipeline-only path: nothing may manufacture evidence but the row above
    });
    expect(refusal.refused).toBe(true);
    if (!refusal.refused) throw new Error("expected refusal");
    expect(refusal.reason).toContain(OCI_DIGEST);

    // The refusal is EXPLAINABLE as this specific narrowing, not merely as "no scan" (principle 6):
    // an operator must be able to tell "nothing scanned it" from "something did, and was not a
    // scanner".
    const decision = await withTenantTx(domainA.db, domainA.orgId, (tx) =>
      getDecision(tx, domainA.orgId, refusal.decisionId)
    );
    expect(decision.kind).toBe("promotion-export-scan-gate");
    const ctx = decision.inputContext as Record<string, unknown>;
    expect(ctx.refusalCode).toBe("no_scan_outcome");
    expect(ctx.producersSeen).toEqual(["webhook-control"]);

    // ...and the SAME evidence from the admitted org-pipeline ingress exports cleanly.
    const genuine = await proposeApprovedChangeInA(sourceRefWithArtifacts, { seedScan: false });
    await seedScanOutcome(genuine.changeId, OCI_DIGEST, { pluginModule: "scan-result-control" });
    const bundle = await exportBundleA(genuine.changeId);
    expect(bundle.artifacts).toEqual(expect.arrayContaining([{ type: "oci", digest: OCI_DIGEST }]));
  });

  it("E6 RECENCY: a LATER failing scan supersedes an earlier pass (refused) — and a later PASS clears an earlier fail (exports)", async () => {
    // The gate used to accept ANY historical passing row, forever: `controlOutcomes.some(...)` with
    // no ordering. A re-scan that FAILED — new CVEs, a tightened ceiling, an expired ADR-0033 grant
    // — did not supersede it, so an artifact stayed authorized to cross on a verdict that no longer
    // held. Both directions are asserted, because only the pair pins "latest wins": objecting-only
    // supersession would make every re-evaluation a one-way ratchet and leave a fixed artifact
    // permanently blocked.
    const control = randomUUID();

    const stale = await proposeApprovedChangeInA(sourceRefWithArtifacts, { seedScan: false });
    await seedScanOutcome(stale.changeId, OCI_DIGEST, { controlObjectId: control });
    await seedScanOutcome(stale.changeId, OCI_DIGEST, { controlObjectId: control, status: "fail" });
    const refusal = await exportPromotionBundle(domainA.db, {
      orgId: domainA.orgId,
      peerIdOrName: domainB.orgName,
      changeIdOrUrn: stale.changeId,
      scanRunner: null
    });
    expect(refusal.refused).toBe(true);
    if (!refusal.refused) throw new Error("expected refusal");
    const decision = await withTenantTx(domainA.db, domainA.orgId, (tx) =>
      getDecision(tx, domainA.orgId, refusal.decisionId)
    );
    expect((decision.inputContext as Record<string, unknown>).refusalCode).toBe("not_passing");

    const fixed = await proposeApprovedChangeInA(sourceRefWithArtifacts, { seedScan: false });
    await seedScanOutcome(fixed.changeId, OCI_DIGEST, { controlObjectId: control, status: "fail" });
    await seedScanOutcome(fixed.changeId, OCI_DIGEST, { controlObjectId: control });
    const bundle = await exportBundleA(fixed.changeId);
    expect(bundle.artifacts).toEqual(expect.arrayContaining([{ type: "oci", digest: OCI_DIGEST }]));
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
    expect(bundle.promotionManifest!.artifacts.map((a) => a.digest)).toEqual(
      bundle.artifactDigests
    );

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
    await expect(importPromotionBundle(domainB.db, domainB.orgId, oldBundle)).rejects.toMatchObject(
      { status: 409 }
    );
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

  // -----------------------------------------------------------------------------------------
  // M18 (ADR-0018) — THE LEAKAGE TEST. Domain-local dev/beta pipelines are exempt from the E6
  // scan gate ONLY because they never reach `exportPromotionBundle` (no peer target) — the
  // exemption is a property of the PATH, never a per-artifact tag (ADR-0018 §1). This proves the
  // two guarantees the ADR promises: (1) a dev-built digest that IS later promoted to a peer is
  // REFUSED at E6 exactly like any other unscanned artifact, with a block Decision + decision_id
  // hash-chained into the audit log in the same transaction — the "exemption" does not follow the
  // artifact across a boundary (ADR-0018 §2); and (2) an operator-style dev/local classification
  // label is INERT for enforcement — forging or removing it changes NO gate outcome, because
  // `evaluatePromotionScanGate` has exactly two pure inputs (substantive artifacts + control-run
  // scan outcomes) and reads no classification/origin field at all (ADR-0018 §4).
  // -----------------------------------------------------------------------------------------

  const DEV_DIGEST = "sha256:" + "d".repeat(64);

  it("LEAKAGE: a domain-local dev digest with no passing scan is REFUSED at E6 when promoted to a peer, with a block Decision + hash-chained audit event", async () => {
    // Models a digest that was built and deployed by a domain-local dev pipeline (never scanned,
    // because it never crossed a boundary) and is NOW promoted to a federation peer.
    const { changeId } = await proposeApprovedChangeInA(
      { artifact_digest: DEV_DIGEST },
      { seedScan: false }
    );

    const outcome = await exportPromotionBundle(domainA.db, {
      orgId: domainA.orgId,
      peerIdOrName: domainB.orgName,
      changeIdOrUrn: changeId
    });
    expect(outcome.refused).toBe(true);
    if (!outcome.refused) throw new Error("expected refusal");
    expect(outcome.reason).toContain(DEV_DIGEST);

    const decision = await withTenantTx(domainA.db, domainA.orgId, (tx) =>
      getDecision(tx, domainA.orgId, outcome.decisionId)
    );
    expect(decision.verdict).toBe("block");
    expect(decision.kind).toBe("promotion-export-scan-gate");
    expect(decision.subjectId).toBe(changeId);

    // The block's audit event is hash-chained into domain A's audit log, in the SAME transaction
    // as the refusal (promotion-repo.ts). Re-walk the WHOLE chain with the production algorithm
    // (`verifyAuditChain`, the same one `scp audit verify` runs) rather than hand-checking one row
    // — this actually proves the chain links, not merely that a row with the right shape exists.
    const auditEvents = await withTenantTx(domainA.db, domainA.orgId, (tx) =>
      listAuditEvents(tx, domainA.orgId, { limit: 10_000 })
    );
    expect(auditEvents.nextCursor).toBeNull(); // sanity: didn't truncate the chain
    expect(verifyAuditChain(auditEvents.items).valid).toBe(true);

    const blockEvent = auditEvents.items.find((e) => e.decisionId === outcome.decisionId);
    expect(blockEvent).toBeTruthy();
    expect(blockEvent!.action).toBe("federation.promotion.export.blocked");
    expect(blockEvent!.subjectId).toBe(changeId);
    expect(blockEvent!.reason).toContain(DEV_DIGEST);
  });

  it("LABEL INERTNESS: a forged dev/local classification on an UNSCANNED artifact does NOT grant an exemption — still REFUSED, identically to the unlabeled case", async () => {
    // Stuff a plausible operator-label shape (ADR-0018 §4 / ADR-0030 §2) directly onto the change's
    // sourceRef — the most literal "forge the label onto a boundary-crossing artifact" a caller
    // could attempt. The gate must ignore it. The REAL declared column (`source_mappings.
    // classification`, migration 0057) is covered separately below; this case keeps the forged-shape
    // axis, which is the one an attacker actually controls.
    const { changeId } = await proposeApprovedChangeInA(
      { artifact_digest: DEV_DIGEST, classification: "dev", origin: "local", devPipeline: true },
      { seedScan: false }
    );

    const outcome = await exportPromotionBundle(domainA.db, {
      orgId: domainA.orgId,
      peerIdOrName: domainB.orgName,
      changeIdOrUrn: changeId
    });
    expect(outcome.refused).toBe(true);
    if (!outcome.refused) throw new Error("expected refusal");

    // Byte-identical refusal reason to the UNLABELED case — the forged label contributed nothing to
    // the gate's evaluation.
    //
    // The baseline is now PRODUCED rather than quoted. This assertion used to be `toBe(<the exact
    // sentence>)`, which made it a test of the gate's prose: it went red on a gate change that never
    // touched label handling, and it would have stayed green if the unlabeled case had started
    // refusing for some *different* reason that happened to keep the same words. What the case is
    // about is that the two refusals AGREE, so it exports the unlabeled one and compares.
    const { changeId: unlabeledChangeId } = await proposeApprovedChangeInA(
      { artifact_digest: DEV_DIGEST },
      { seedScan: false }
    );
    const unlabeled = await exportPromotionBundle(domainA.db, {
      orgId: domainA.orgId,
      peerIdOrName: domainB.orgName,
      changeIdOrUrn: unlabeledChangeId
    });
    expect(unlabeled.refused).toBe(true);
    if (!unlabeled.refused) throw new Error("expected refusal");
    expect(outcome.reason).toBe(unlabeled.reason);
    expect(outcome.reason).toContain(DEV_DIGEST);
  });

  it("LABEL INERTNESS: a forged dev/local classification alongside a PASSING scan does not alter the exported manifest — the label is not carried anywhere the gate or manifest reads", async () => {
    const { changeId } = await proposeApprovedChangeInA({
      artifact_digest: DEV_DIGEST,
      classification: "dev",
      origin: "local",
      devPipeline: true
    }); // seedScan defaults true — a passing, digest-bound scan exists
    const bundle = await exportBundleA(changeId);

    // Exports exactly like the unlabeled passing case: one oci artifact, self-binding manifest.
    expect(bundle.artifacts).toEqual([{ type: "oci", digest: DEV_DIGEST }]);
    expect(bundle.promotionManifest!.artifacts).toEqual([{ type: "oci", digest: DEV_DIGEST }]);
    // The forged label never enters the MANIFEST or the ARTIFACT SET — it lives only in
    // sourceRef.classification/origin/devPipeline, which neither of those reads.
    expect(JSON.stringify(bundle.promotionManifest)).not.toContain("classification");
    expect(JSON.stringify(bundle.promotionManifest)).not.toContain("devPipeline");

    // CORRECTION (2026-08-01): an earlier version of this comment also claimed the label "never
    // enters the checksum payload". IT DOES — `promotionChecksumPayload` includes `change`
    // wholesale, and the label lives in `change.sourceRef`. That was a false statement sitting
    // next to true assertions, which is the most durable kind of wrong comment, so it is pinned
    // here as a fact rather than deleted.
    //
    // It is not a defect: ADR-0018 §4 permits DESCRIPTIVE labels, and being inside the checksum is
    // the SAFE direction — it means a label cannot be altered in flight without invalidating the
    // signature. Inertness is about what the GATE reads, not about what is covered by integrity
    // protection. The two assertions above, plus the refusal case in the test before this one, are
    // what actually establish it.
    const checksumPayload = JSON.stringify(promotionChecksumPayload(bundle));
    expect(checksumPayload).toContain("classification");
    expect(computeBundleChecksum(promotionChecksumPayload(bundle))).toBe(bundle.checksum);
  });

  it("LABEL INERTNESS (the REAL column): a dev-classified, dev-ref source mapping grants no exemption — refused identically, and identically again once the label is removed", async () => {
    // ADR-0030 §3, the clause this milestone turns on. The previous case forges a label onto a
    // sourceRef; this one uses the GENUINE declared surface — a `source_mappings` row with
    // `classification: 'dev'` and `ref_pattern: 'refs/heads/dev'`, written exactly as an operator
    // writes it — and proves E6 does not read it.
    //
    // The three-way comparison is the point. Refusing once proves little on its own; what proves
    // INERTNESS is that the refusal is BYTE-IDENTICAL with the label present, with it cleared, and
    // with no mapping at all. If `classification` ever became a gate input, exactly one of these
    // three would diverge.
    //
    // WHAT THIS IS MUTATION-PROVEN AGAINST, precisely — because the difference matters. Making the
    // gate honour a dev-branch ORIGIN (`sourceRef.ref` containing "dev" ⇒ pass), which is the
    // rejected alternative in ADR-0018 and the literal reading of the branch-grants-the-exemption
    // direction, REDS this case and nothing else in the file. That is the hazard it exists to catch.
    //
    // The mapping-presence axis is weaker and is NOT claimed as mutation-proven: the change here is
    // built directly by `proposeApprovedChangeInA` rather than correlated FROM this mapping, so the
    // row establishes "a dev-classified mapping exists in the org" rather than "this change came
    // from one". Closing that gap needs a correlation-driven fixture — worth doing when a
    // classification-consuming code path exists to justify it; today none does.
    const component = await withTenantTx(domainA.db, domainA.orgId, (tx) =>
      createObject(tx, {
        orgId: domainA.orgId,
        domainId: null,
        typeId: "component",
        actorObjectId: domainA.orgId,
        requestId: "t-m18-dev-labelled",
        name: `m18-dev-component-${randomUUID()}`
      })
    );
    const devMapping = await withTenantTx(domainA.db, domainA.orgId, (tx) =>
      createSourceMapping(tx, {
        orgId: domainA.orgId,
        sourceKind: `m18-dev-${randomUUID()}`,
        repoPattern: "acme/dev-app",
        refPattern: "refs/heads/dev",
        componentIdOrUrn: component.id,
        type: "configuration",
        classification: "dev"
      })
    );
    expect(devMapping.classification).toBe("dev"); // the label really is set on the row

    const refuseOnce = async () => {
      const { changeId } = await proposeApprovedChangeInA(
        { artifact_digest: DEV_DIGEST, ref: "refs/heads/dev" },
        { seedScan: false }
      );
      const outcome = await exportPromotionBundle(domainA.db, {
        orgId: domainA.orgId,
        peerIdOrName: domainB.orgName,
        changeIdOrUrn: changeId
      });
      expect(outcome.refused).toBe(true);
      if (!outcome.refused) throw new Error("expected refusal");
      return outcome.reason;
    };

    // 1. With the dev label declared on the mapping. The baseline is the FIRST refusal, produced
    //    here rather than quoted as prose: what this case proves is that the three refusals are
    //    identical TO EACH OTHER, and pinning the sentence instead made it a test of the gate's
    //    wording that went red on a gate change which never touched label handling.
    const expectedReason = await refuseOnce();
    expect(expectedReason).toContain(DEV_DIGEST);

    // 2. With the label CLEARED — removing it must not change the outcome either. (An enforcement
    //    input would show up here as the difference between "exempt" and "refused".)
    await withTenantTx(domainA.db, domainA.orgId, (tx) =>
      tx
        .update(sourceMappings)
        .set({ classification: null })
        .where(eq(sourceMappings.id, devMapping.id))
    );
    expect(await refuseOnce()).toBe(expectedReason);

    // 3. With the mapping deleted entirely — the no-label baseline.
    await withTenantTx(domainA.db, domainA.orgId, (tx) =>
      tx.delete(sourceMappings).where(eq(sourceMappings.id, devMapping.id))
    );
    expect(await refuseOnce()).toBe(expectedReason);
  });

  it("LABEL INERTNESS (the REAL column): a dev-classified mapping does not block a PASSING scan from exporting either — inert in BOTH directions", async () => {
    // The other half, and the one a "dev means less trusted, so tighten" misreading would break.
    // The label must not make the gate stricter any more than it makes it looser: it is not an
    // input, so a correctly-scanned dev-labelled promotion exports exactly like any other.
    const component = await withTenantTx(domainA.db, domainA.orgId, (tx) =>
      createObject(tx, {
        orgId: domainA.orgId,
        domainId: null,
        typeId: "component",
        actorObjectId: domainA.orgId,
        requestId: "t-m18-dev-pass",
        name: `m18-dev-pass-${randomUUID()}`
      })
    );
    await withTenantTx(domainA.db, domainA.orgId, (tx) =>
      createSourceMapping(tx, {
        orgId: domainA.orgId,
        sourceKind: `m18-dev-pass-${randomUUID()}`,
        repoPattern: "acme/dev-app",
        refPattern: "refs/heads/dev",
        componentIdOrUrn: component.id,
        type: "configuration",
        classification: "dev"
      })
    );

    const { changeId } = await proposeApprovedChangeInA({
      artifact_digest: DEV_DIGEST,
      ref: "refs/heads/dev"
    }); // seedScan defaults true — a passing, digest-bound scan exists
    const bundle = await exportBundleA(changeId);
    expect(bundle.artifacts).toEqual([{ type: "oci", digest: DEV_DIGEST }]);
  });

  it("the instance-scoped floor is not a LABEL and never exempts — but it does bind at E6 on findings that breach it", async () => {
    // CORRECTED 2026-08-17, and the correction is the interesting part.
    //
    // This case used to assert that "E6 never reads scan_requirement_floors — a completely different
    // mechanism from the E6 boundary gate", and it stayed GREEN through the change that made that
    // sentence false, because every fixture it exercises reports ZERO findings and zero breaches no
    // ceiling. A test that cannot distinguish the property it names from the property it happens to
    // exercise is a test of the fixture. What it genuinely established is the LABEL-INERTNESS half —
    // the floor neither exempts an unscanned artifact nor blocks a clean one — and that half is
    // unchanged and kept below, now beside the case that tells the two apart.
    //
    // WHY THE GATE READS THE FLOOR NOW. The four org-and-below tiers of ADR-0016's chain are
    // tenant-authored policy data, and `scan-result-control` will fall back to a tenant-authored
    // per-binding `config.threshold` when the gate threads no scoped ceiling — so "the control said
    // pass" can mean "pass against a ceiling the beneficiary wrote". The two ABOVE-org tiers are
    // different in kind: `scan_requirement_floors` is operator-write / tenant-read precisely so no
    // tenant can loosen it, and E6 is the operator's boundary. Those, and only those, are re-checked
    // here. The six-tier resolution is deliberately NOT re-run (see `scan-evidence.ts`).
    const adminPool = new pg.Pool({ connectionString: domainA.adminUrl });
    try {
      await adminPool.query(
        `INSERT INTO scan_requirement_floors (tier, origin, max_critical, max_high, max_medium, max_low, note)
         VALUES ('trust_domain', 'local', 0, 0, 0, 0, 'm18-leakage-test: maximally strict floor')
         ON CONFLICT (tier, origin) DO UPDATE SET max_critical = 0, max_high = 0, max_medium = 0, max_low = 0`
      );

      // An UNSCANNED artifact is refused — same as with NO floor configured at all (the floor is not
      // why it refuses; the missing scan is).
      const unscanned = await proposeApprovedChangeInA(
        { artifact_digest: DEV_DIGEST },
        { seedScan: false }
      );
      const refusal = await exportPromotionBundle(domainA.db, {
        orgId: domainA.orgId,
        peerIdOrName: domainB.orgName,
        changeIdOrUrn: unscanned.changeId
      });
      expect(refusal.refused).toBe(true);

      // A CLEAN passing scan EXPORTS regardless of the maximally strict floor — zero findings breach
      // nothing, so the strictest possible ceiling changes no outcome. (This is the assertion the
      // old claim was resting on.)
      const scanned = await proposeApprovedChangeInA({ artifact_digest: DEV_DIGEST });
      const bundle = await exportBundleA(scanned.changeId);
      expect(bundle.artifacts).toEqual([{ type: "oci", digest: DEV_DIGEST }]);

      // AND THE CASE THAT TELLS THE TWO APART: a control that said `pass` — against its own
      // per-binding ceiling of 50 highs, which is what a tenant-authored `config.threshold` looks
      // like — carrying findings that breach the operator's floor of 0. The control's verdict is not
      // the boundary's verdict.
      const dirty = await proposeApprovedChangeInA(
        { artifact_digest: DEV_DIGEST },
        { seedScan: false }
      );
      await seedScanOutcome(dirty.changeId, DEV_DIGEST, {
        severityCounts: { critical: 0, high: 4, medium: 0, low: 0 },
        threshold: { maxCritical: 50, maxHigh: 50 }
      });
      const breached = await exportPromotionBundle(domainA.db, {
        orgId: domainA.orgId,
        peerIdOrName: domainB.orgName,
        changeIdOrUrn: dirty.changeId,
        scanRunner: null
      });
      expect(breached.refused).toBe(true);
      if (!breached.refused) throw new Error("expected refusal");
      const decision = await withTenantTx(domainA.db, domainA.orgId, (tx) =>
        getDecision(tx, domainA.orgId, breached.decisionId)
      );
      expect((decision.inputContext as Record<string, unknown>).refusalCode).toBe(
        "below_instance_floor"
      );
    } finally {
      await adminPool.query(
        `DELETE FROM scan_requirement_floors WHERE note LIKE 'm18-leakage-test:%'`
      );
      await adminPool.end();
    }

    // WITH THE FLOOR REMOVED (the finally above), the identical dirty evidence exports — so the
    // refusal above is attributable to the floor and to nothing else, and a deployment that has
    // authored no floor sees behaviour byte-identical to before this check existed.
    const dirtyNoFloor = await proposeApprovedChangeInA(
      { artifact_digest: DEV_DIGEST },
      { seedScan: false }
    );
    await seedScanOutcome(dirtyNoFloor.changeId, DEV_DIGEST, {
      severityCounts: { critical: 0, high: 4, medium: 0, low: 0 },
      threshold: { maxCritical: 50, maxHigh: 50 }
    });
    const exported = await exportBundleA(dirtyNoFloor.changeId);
    expect(exported.artifacts).toEqual([{ type: "oci", digest: DEV_DIGEST }]);
  });
});

// ---------------------------------------------------------------------------------------------
// M17.4(a) / M15.2 — RECEIVER-side verification of the commander's cosign-signed promotion
// manifest at bundle import (the OUTPOST's universal pre-deploy validation, ADR-0011). ONE gate
// runs at every receiving hop; the outpost NEVER re-scans — receiver-side never-re-scan is
// UNCHANGED; the one scan now executes at the commander before signing, per promotion journey
// (ADR-0020). Fail-closed over signature + set-equality + the tie + self-binding + a downgrade
// defense. Part-(b) (per-artifact
// BYTE verify where the operator-loaded bytes land) runs later as the PRE-DEPLOY gate — see
// coordination/pre-deploy-gate.integration.test.ts; byte TRANSPORT itself remains M15.5.
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
        gateRef: { fromState: "validating", toState: "accepted" },
        // The org-pipeline ingress, named — E6 admits by producer, not by evidence shape.
        pluginModule: "scan-result-control",
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
    const oci =
      typeof sourceRef.artifact_digest === "string" ? sourceRef.artifact_digest : undefined;
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

// ============================================================================================
// M14.1 — per-peer poke-mode flag (ADR-0009; proposal docs/proposals/outpost-poke.md §Config).
// Default-off, tri-state on re-pair (mirrors deliveryTarget), and the pair-time transport-identity
// guard: setting poke-mode TRUE requires an https/mTLS-capable peer baseUrl (full endpoint
// enforcement is M14.2 — here we prove the EARLY pair-time refusal).
// ============================================================================================
describe("M14.1 Federation: per-peer poke-mode (Testcontainers)", () => {
  let commander: IsolatedDomain;
  let peerSelf: FederationSelf;
  let peerKeyPublic: string;

  beforeAll(async () => {
    commander = await createIsolatedDomain("m14PokeCommander");
    // A second domain stands in for the peer being paired — we only need its domainId + a real
    // Ed25519 public key (the pairing exchange values); no live handshake is performed.
    const peer = await createIsolatedDomain("m14PokePeer");
    peerSelf = await withTenantTx(peer.db, peer.orgId, (tx) =>
      ensureFederationSelf(tx, peer.orgId)
    );
    peerKeyPublic = (
      await withTenantTx(peer.db, peer.orgId, (tx) => ensureInstanceKey(tx, peer.orgId))
    ).publicKey;
    await peer.close();
  }, 60_000);

  afterAll(async () => {
    await commander.close();
  });

  const HTTPS_URL = "https://outpost.example.com";
  const HTTP_URL = "http://outpost.example.com";

  async function pairWith(input: {
    baseUrl?: string;
    pokeMode?: boolean;
    name?: string;
    domainId?: TrustDomainId;
  }) {
    const domainId = input.domainId ?? peerSelf.domainId;
    return withTenantTx(commander.db, commander.orgId, (tx) =>
      pairPeer(tx, {
        orgId: commander.orgId,
        domainId,
        // PER-PEER NAME. These cases pair several DISTINCT peers inside one org, and drizzle/0045 makes
        // `(org_id, name)` unique — a peer NAME identifies a peer on every route that accepts one, so two
        // peers may no longer share one. Deriving the name from the domain id keeps each re-pair of the
        // SAME peer stable (a re-pair must still hit the same row) while keeping distinct peers distinct.
        name: input.name ?? `poke-peer-${domainId.slice(0, 8)}`,
        role: "outpost",
        publicKey: peerKeyPublic,
        ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
        ...(input.pokeMode !== undefined ? { pokeMode: input.pokeMode } : {})
      })
    );
  }

  // The guard raises a ProblemError whose 400 title is its `.message`; the specific guard text is
  // the RFC-9457 `.detail`. Assert against `.detail` (not `.message`).
  async function expectGuardRejection(p: Promise<unknown>): Promise<void> {
    let caught: unknown;
    await p.catch((e) => {
      caught = e;
    });
    expect(caught).toBeInstanceOf(ProblemError);
    const err = caught as ProblemError;
    expect(err.status).toBe(400);
    expect(err.detail).toMatch(/poke-mode requires an mTLS\/https peer/);
  }

  it("default (unset) pairs as poll-mode: pokeMode === false", async () => {
    const row = await pairWith({ baseUrl: HTTPS_URL });
    expect(row.pokeMode).toBe(false);
    // And it is visible false through the read paths (list + get-by-name).
    const listed = await withTenantTx(commander.db, commander.orgId, (tx) =>
      listPeers(tx, commander.orgId)
    );
    expect(listed.find((p) => p.id === peerSelf.domainId)?.pokeMode).toBe(false);
  });

  it("pokeMode=true on an https/mTLS peer is persisted and visible", async () => {
    const row = await pairWith({ baseUrl: HTTPS_URL, pokeMode: true });
    expect(row.pokeMode).toBe(true);
    const got = await withTenantTx(commander.db, commander.orgId, (tx) =>
      getPeerByIdOrName(tx, commander.orgId, peerSelf.domainId)
    );
    expect(got.pokeMode).toBe(true);
  });

  it("re-pair WITHOUT pokeMode PRESERVES the existing value (tri-state absent = preserve)", async () => {
    await pairWith({ baseUrl: HTTPS_URL, pokeMode: true });
    // A re-pair supplying neither the field (undefined) must not flip it back to poll.
    const row = await pairWith({ baseUrl: HTTPS_URL });
    expect(row.pokeMode).toBe(true);
  });

  it("re-pair with pokeMode=false explicitly turns it off", async () => {
    await pairWith({ baseUrl: HTTPS_URL, pokeMode: true });
    const row = await pairWith({ baseUrl: HTTPS_URL, pokeMode: false });
    expect(row.pokeMode).toBe(false);
  });

  it("pokeMode=true on a plain-http peer is REJECTED by the pair-time guard", async () => {
    // Fresh peer id so the effective baseUrl is exactly the plain-http one supplied here (a re-pair
    // of an existing https peer would legitimately satisfy the guard from the stored baseUrl).
    await expectGuardRejection(
      pairWith({ domainId: asTrustDomainId(randomUUID()), baseUrl: HTTP_URL, pokeMode: true })
    );
  });

  it("pokeMode=true with NO baseUrl (null) is REJECTED by the pair-time guard", async () => {
    // Fresh, never-paired peer → no existing baseUrl to fall back on → effective baseUrl is null.
    await expectGuardRejection(
      pairWith({ domainId: asTrustDomainId(randomUUID()), pokeMode: true })
    );
  });

  it("the guard honors an EXISTING https baseUrl on re-pair when baseUrl is omitted", async () => {
    // First establish the peer with an https baseUrl (poll-mode).
    await pairWith({ baseUrl: HTTPS_URL, pokeMode: false });
    // Now flip poke-mode on WITHOUT re-supplying baseUrl — the effective (existing) https baseUrl
    // must satisfy the guard.
    const row = await pairWith({ pokeMode: true });
    expect(row.pokeMode).toBe(true);
  });

  // ------------------------------------------------------------------------------------------
  // M14.3 HARDENING — the guard must validate the EFFECTIVE POST-WRITE state, not the input
  // transition. baseUrl and pokeMode MERGE with OPPOSITE rules on re-pair (baseUrl: request wins
  // when present; pokeMode: tri-state, EXISTING wins when absent), so a guard keyed off
  // `input.pokeMode === true` checked a DIFFERENT tuple than the one actually persisted.
  // ------------------------------------------------------------------------------------------

  it("REGRESSION: re-pair downgrading baseUrl to plain-http with pokeMode OMITTED is REJECTED", async () => {
    // THE BUG: pokeMode omitted -> `input.pokeMode === true` was false -> the guard was skipped
    // entirely -> the row was persisted as {baseUrl: 'http://…', pokeMode: true}. The sender would
    // then have dialed it and put the federation bearer on the wire in cleartext. The effective
    // post-write tuple is (pokeMode: true [preserved], baseUrl: http) — it MUST be refused.
    const domainId = asTrustDomainId(randomUUID());
    await pairWith({ domainId, baseUrl: HTTPS_URL, pokeMode: true });
    await expectGuardRejection(pairWith({ domainId, baseUrl: HTTP_URL }));
    // And the stored row is UNCHANGED — the rejected re-pair never downgraded it.
    const got = await withTenantTx(commander.db, commander.orgId, (tx) =>
      getPeerByIdOrName(tx, commander.orgId, domainId)
    );
    expect(got.baseUrl).toBe(HTTPS_URL);
    expect(got.pokeMode).toBe(true);
  });

  it("re-pair to a NEW https baseUrl with pokeMode omitted is ALLOWED and preserves pokeMode=true", async () => {
    // The guard must not over-refuse: an https→https move keeps the invariant, so the tri-state
    // preserve semantics still hold.
    const domainId = asTrustDomainId(randomUUID());
    await pairWith({ domainId, baseUrl: HTTPS_URL, pokeMode: true });
    const row = await pairWith({ domainId, baseUrl: "https://outpost-2.example.com" });
    expect(row.baseUrl).toBe("https://outpost-2.example.com");
    expect(row.pokeMode).toBe(true);
  });

  it("re-pair downgrading to plain-http is ALLOWED when pokeMode is explicitly turned OFF", async () => {
    // The effective tuple is (pokeMode: false, baseUrl: http) — no invariant to violate, so the
    // downgrade is a legitimate operator action.
    const domainId = asTrustDomainId(randomUUID());
    await pairWith({ domainId, baseUrl: HTTPS_URL, pokeMode: true });
    const row = await pairWith({ domainId, baseUrl: HTTP_URL, pokeMode: false });
    expect(row.baseUrl).toBe(HTTP_URL);
    expect(row.pokeMode).toBe(false);
  });

  it("re-pair preserving BOTH (pokeMode omitted, baseUrl omitted) on an https peer stays allowed", async () => {
    // The pure no-op re-pair (an old client that knows neither field) must not start failing.
    const domainId = asTrustDomainId(randomUUID());
    await pairWith({ domainId, baseUrl: HTTPS_URL, pokeMode: true });
    const row = await pairWith({ domainId });
    expect(row.baseUrl).toBe(HTTPS_URL);
    expect(row.pokeMode).toBe(true);
  });

  it("explicit pokeMode=true on a plain-http baseUrl is still REJECTED (unchanged)", async () => {
    const domainId = asTrustDomainId(randomUUID());
    await pairWith({ domainId, baseUrl: HTTPS_URL, pokeMode: true });
    await expectGuardRejection(pairWith({ domainId, baseUrl: HTTP_URL, pokeMode: true }));
  });
});

/**
 * M14.4 fix (N5) — `GET /federation/status` must report the cadence the SCHEDULER is actually
 * running, in the one case where the two used to disagree.
 *
 * The status endpoint was added in M14.4 precisely so an operator could SEE cadence divergence, but
 * it derived `hasClientCerts` from the CHEAP PRESENCE CHECK (`federationClientMtlsConfigured` — are
 * the env paths set?) while the scheduler derives it from the never-throwing RUNTIME PROBE (did the
 * material actually READ off disk?). Those answers differ in exactly the situation owner decision D4
 * exists for: `SCP_FEDERATION_MTLS_CERT_FILE`/`_KEY_FILE` still set, the mounted secret rotated away.
 * The scheduler correctly falls back to the FREQUENT cadence and warns; the endpoint reported
 * `effectiveCadence: 'poke'` — the operator-facing view saying the exact opposite of what the process
 * was doing. Both now call the same probe, so they agree by construction.
 */
describe("M14.4 GET /federation/status effectiveCadence — agrees with the scheduler's D4 probe", () => {
  let domain: IsolatedDomain;
  let peerDomainId: TrustDomainId;
  let certDir: string;
  let realCert: string;
  let realKey: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    domain = await createIsolatedDomain("m144StatusCadence");
    // A proven poke-mode peer: pokeMode set (operator opted in), https baseUrl (the pair-time
    // guard's requirement), a poke ACTUALLY received (D2 satisfied), and never pulled yet — so the
    // ONLY remaining input to the cadence decision is D4's client-cert question.
    const other = await createIsolatedDomain("m144StatusCadencePeer");
    const otherSelf = await withTenantTx(other.db, other.orgId, (tx) =>
      ensureFederationSelf(tx, other.orgId)
    );
    const otherKey = await withTenantTx(other.db, other.orgId, (tx) =>
      ensureInstanceKey(tx, other.orgId)
    );
    peerDomainId = otherSelf.domainId;
    await withTenantTx(domain.db, domain.orgId, async (tx) => {
      await pairPeer(tx, {
        orgId: domain.orgId,
        domainId: peerDomainId,
        name: "proven-poke-peer",
        role: "outpost",
        publicKey: otherKey.publicKey,
        baseUrl: "https://outpost.example.com",
        pokeMode: true
      });
      await markPokeReceived(tx, domain.orgId, peerDomainId);
    });
    await other.close();

    // Real, readable files — the content is irrelevant, only that `readFileSync` SUCCEEDS.
    certDir = await mkdtemp(path.join(tmpdir(), "scp-m144-status-certs-"));
    realCert = path.join(certDir, "client.crt");
    realKey = path.join(certDir, "client.key");
    await writeFile(
      realCert,
      "-----BEGIN CERTIFICATE-----\nnot-a-real-cert\n-----END CERTIFICATE-----\n"
    );
    await writeFile(
      realKey,
      "-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n"
    );

    for (const k of [
      "SCP_FEDERATION_MTLS_CERT_FILE",
      "SCP_FEDERATION_MTLS_KEY_FILE",
      "SCP_FEDERATION_MTLS_CA_FILE"
    ]) {
      savedEnv[k] = process.env[k];
    }
  }, 60_000);

  afterAll(async () => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(certDir, { recursive: true, force: true });
    await domain.close();
  });

  async function statusPeer() {
    const status = await withTenantTx(domain.db, domain.orgId, (tx) =>
      getFederationStatus(tx, domain.orgId)
    );
    const entry = status.peers.find((p) => p.peer.id === peerDomainId);
    expect(entry).toBeDefined();
    return entry!;
  }

  /** The cadence inputs the SCHEDULER sees, reassembled from what the endpoint reported — so the
   *  "status agrees with the scheduler" assertions compare the same peer state, not a second query. */
  function cadenceInputsFrom(entry: Awaited<ReturnType<typeof statusPeer>>) {
    return {
      pokeMode: entry.peer.pokeMode ?? false,
      lastPokeReceivedAt: entry.lastPokeReceivedAt ?? null,
      lastPullAttemptAt: entry.lastPullAttemptAt ?? null,
      lastPullSuccessAt: entry.lastPullSuccessAt ?? null
    };
  }

  it("READABLE cert material: the proven poke-mode peer reports effectiveCadence 'poke'", async () => {
    process.env.SCP_FEDERATION_MTLS_CERT_FILE = realCert;
    process.env.SCP_FEDERATION_MTLS_KEY_FILE = realKey;
    delete process.env.SCP_FEDERATION_MTLS_CA_FILE;

    const entry = await statusPeer();
    expect(entry.peer.pokeMode).toBe(true);
    expect(entry.lastPokeReceivedAt).not.toBeNull();
    expect(entry.effectiveCadence).toBe("poke");
    // The baseline the regression below is measured against: with usable material the SCHEDULER
    // says the same thing.
    expect(peerSyncCadence(cadenceInputsFrom(entry), { hasClientCerts: true })).toBe("poke");
  });

  it("REGRESSION: cert PATHS SET but the FILE IS GONE -> status reports 'poll', matching the scheduler", async () => {
    // THE BUG: the presence check answers "configured" here (both paths are set), so the endpoint
    // reported 'poke' for a peer the scheduler had already dropped back to the frequent cadence.
    process.env.SCP_FEDERATION_MTLS_CERT_FILE = path.join(certDir, "rotated-away.crt");
    process.env.SCP_FEDERATION_MTLS_KEY_FILE = path.join(certDir, "rotated-away.key");

    const entry = await statusPeer();
    // The raw flag is UNCHANGED — poke-mode is still what the operator configured…
    expect(entry.peer.pokeMode).toBe(true);
    // …but the EFFECTIVE cadence is the frequent poll, which is what the process is really doing
    // (D4: both halves of poke-mode fail the same way).
    expect(entry.effectiveCadence).toBe("poll");
    expect(peerSyncCadence(cadenceInputsFrom(entry), { hasClientCerts: false })).toBe("poll");
  });

  it("a HALF-CONFIGURED pair (cert path only) also reports 'poll' — the probe never throws out of status", async () => {
    process.env.SCP_FEDERATION_MTLS_CERT_FILE = realCert;
    delete process.env.SCP_FEDERATION_MTLS_KEY_FILE;

    const entry = await statusPeer();
    expect(entry.effectiveCadence).toBe("poll");
  });
});
