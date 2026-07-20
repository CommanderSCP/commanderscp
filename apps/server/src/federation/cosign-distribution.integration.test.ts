import { generateKeyPairSync, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import type { GeneratedKeyPair } from "@scp/cosign";
import { withTenantTx } from "../db/tenant-tx.js";
import { federationPeerKeys, instanceCosignKeys } from "../db/schema.js";
import { ensureInstanceKey } from "../governance/attestation.js";
import { getInstanceCosignPublicKey, type CosignKeyGenerator } from "../governance/cosign-keys.js";
import { ensureFederationSelf, type FederationSelf } from "./self-repo.js";
import { pairPeer, currentPeerKeyRow, getPeerByIdOrName, listPeers } from "./peers-repo.js";
import { getFederationStatus } from "./status-repo.js";
import { createIsolatedDomain, type IsolatedDomain } from "./test-support/isolated-domain.js";

/**
 * M17.3 E5 — DISTRIBUTION of SCP's cosign VERIFICATION public key to peers so they can LATER (E6 /
 * M17.4) verify the commander's cosign-signed promotion manifest. This increment adds NO signing and
 * NO verification — it proves the PLUMBING:
 *
 *  - the LOCAL cosign public key is surfaced by `getFederationStatus`, lazily provisioned, and the
 *    PRIVATE half never appears in status or any API-facing shape;
 *  - pairing CARRIES the peer's cosign pubkey and PERSISTS it onto `federation_peer_keys`, retrievable
 *    per-peer;
 *  - ROTATION (a changed cosign pubkey) reuses the EXISTING supersede/key-window mechanic — the old
 *    cosign key is retained in its superseded window exactly as the Ed25519 key is;
 *  - the exchange is FILE-ONLY / air-gap friendly: one side's status output + the other side's pair
 *    request is sufficient, with NO new transport and no live connection;
 *  - it is ADDITIVE — an OLD pair request lacking a cosign pubkey still pairs, and never strips one.
 *
 * Uses genuinely-separate-database isolated domains (test-support/isolated-domain.ts), matching
 * federation.integration.test.ts, and a FAKE cosign generator (unique offline PEMs, no subprocess).
 */

/** A fake cosign generator returning a UNIQUE keypair per call, whose PRIVATE PEM shouts "PRIVATE"
 *  and "DO-NOT-LEAK" so any accidental exposure is trivially detectable in an assertion. */
function fakeCosignGenerator(tag: string): CosignKeyGenerator {
  let n = 0;
  return async (): Promise<GeneratedKeyPair> => {
    const id = ++n;
    return {
      privateKeyPem: `-----BEGIN ENCRYPTED SIGSTORE PRIVATE KEY-----\nFAKE-${tag}-PRIVATE-#${id}-DO-NOT-LEAK\n-----END ENCRYPTED SIGSTORE PRIVATE KEY-----\n`,
      publicKeyPem: `-----BEGIN PUBLIC KEY-----\nFAKE-${tag}-PUBLIC-#${id}\n-----END PUBLIC KEY-----\n`
    };
  };
}

/** A fresh Ed25519 keypair in federation's base64-DER encoding — a peer's signing identity. */
function ed25519KeypairB64(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64")
  };
}

/** Mirrors the /federation/status route flow: resolve the LOCAL cosign public key OUTSIDE the status
 *  tx (its lazy provisioning runs a cosign subprocess that must never run inside an open tx), then
 *  build the status inside the tx and hand the public key in. Returns both for assertions. */
async function statusWithCosign(domain: IsolatedDomain, gen: CosignKeyGenerator) {
  const cosign = await getInstanceCosignPublicKey(domain.db, domain.orgId, gen);
  const status = await withTenantTx(domain.db, domain.orgId, (tx) =>
    getFederationStatus(tx, domain.orgId, cosign.publicKey)
  );
  return { cosign, status };
}

async function peerKeyRowsBySequence(domain: IsolatedDomain, peerDomainId: string) {
  return withTenantTx(domain.db, domain.orgId, (tx) =>
    tx
      .select()
      .from(federationPeerKeys)
      .where(
        and(
          eq(federationPeerKeys.orgId, domain.orgId),
          eq(federationPeerKeys.peerDomainId, peerDomainId)
        )
      )
      .orderBy(asc(federationPeerKeys.effectiveFromSequence))
  );
}

describe("M17.3 E5: cosign public-key distribution (Testcontainers)", () => {
  let commander: IsolatedDomain;
  let outpost: IsolatedDomain;
  let selfCommander: FederationSelf;
  let selfOutpost: FederationSelf;

  beforeAll(async () => {
    commander = await createIsolatedDomain("e5-commander");
    outpost = await createIsolatedDomain("e5-outpost");
    selfCommander = await withTenantTx(commander.db, commander.orgId, (tx) =>
      ensureFederationSelf(tx, commander.orgId)
    );
    selfOutpost = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      ensureFederationSelf(tx, outpost.orgId)
    );
  }, 60_000);

  afterAll(async () => {
    await commander.close();
    await outpost.close();
  });

  // -----------------------------------------------------------------------------------------
  // (a) getFederationStatus surfaces the LOCAL cosign PUBLIC key, provisioned lazily; the PRIVATE
  //     key never appears in status or any API-facing shape.
  // -----------------------------------------------------------------------------------------
  it("status surfaces the local cosign PUBLIC key, provisioned lazily; private key never leaks", async () => {
    const domain = await createIsolatedDomain("e5-status");
    try {
      const gen = fakeCosignGenerator("STATUS");

      // LAZY: no cosign keypair exists until status is read.
      const before = await withTenantTx(domain.db, domain.orgId, (tx) =>
        tx.select().from(instanceCosignKeys).where(eq(instanceCosignKeys.orgId, domain.orgId))
      );
      expect(before).toHaveLength(0);

      const { cosign, status } = await statusWithCosign(domain, gen);

      // Now provisioned exactly once, and status surfaces its PUBLIC half.
      const after = await withTenantTx(domain.db, domain.orgId, (tx) =>
        tx.select().from(instanceCosignKeys).where(eq(instanceCosignKeys.orgId, domain.orgId))
      );
      expect(after).toHaveLength(1);
      expect(status.self?.cosignPublicKey).toBe(cosign.publicKey);
      expect(status.self?.cosignPublicKey).toContain("PUBLIC KEY");

      // The PRIVATE key is nowhere in the status payload, by field name or by value.
      expect(JSON.stringify(status)).not.toContain("PRIVATE");
      expect(JSON.stringify(status)).not.toContain("DO-NOT-LEAK");
      expect((status.self as unknown as Record<string, unknown>).privateKey).toBeUndefined();
      // ...but the private key really is stored server-side (proving status merely omits it).
      expect(after[0]!.privateKey).toContain("DO-NOT-LEAK");
      expect(after[0]!.publicKey).toBe(cosign.publicKey);
    } finally {
      await domain.close();
    }
  });

  // -----------------------------------------------------------------------------------------
  // (b) Pairing CARRIES + PERSISTS the peer's cosign pubkey onto federation_peer_keys, retrievable
  //     per-peer through every read path.
  // -----------------------------------------------------------------------------------------
  it("pairing persists the peer's cosign pubkey onto federation_peer_keys, retrievable per-peer", async () => {
    const ed = ed25519KeypairB64();
    const peerCosign = "-----BEGIN PUBLIC KEY-----\nPEER-B-COSIGN-PUB\n-----END PUBLIC KEY-----\n";

    await withTenantTx(commander.db, commander.orgId, (tx) =>
      pairPeer(tx, {
        orgId: commander.orgId,
        domainId: selfOutpost.domainId,
        name: outpost.orgName,
        role: "outpost",
        publicKey: ed.publicKey,
        cosignPublicKey: peerCosign
      })
    );

    // Persisted onto the CURRENT key-window row alongside the Ed25519 key.
    const current = await withTenantTx(commander.db, commander.orgId, (tx) =>
      currentPeerKeyRow(tx, commander.orgId, selfOutpost.domainId)
    );
    expect(current?.publicKey).toBe(ed.publicKey);
    expect(current?.cosignPublicKey).toBe(peerCosign);

    // Surfaced by getPeerByIdOrName and listPeers.
    const byId = await withTenantTx(commander.db, commander.orgId, (tx) =>
      getPeerByIdOrName(tx, commander.orgId, selfOutpost.domainId)
    );
    expect(byId.cosignPublicKey).toBe(peerCosign);

    const peers = await withTenantTx(commander.db, commander.orgId, (tx) =>
      listPeers(tx, commander.orgId)
    );
    const found = peers.find((p) => p.id === selfOutpost.domainId);
    expect(found?.cosignPublicKey).toBe(peerCosign);
  });

  // -----------------------------------------------------------------------------------------
  // (c) ROTATION — a re-pair with a CHANGED cosign pubkey supersedes the old window via the EXISTING
  //     path; the old cosign key is retained in its superseded window exactly as the Ed25519 key is.
  // -----------------------------------------------------------------------------------------
  it("a changed cosign pubkey rotates via the existing supersede window (old key retained)", async () => {
    const domain = await createIsolatedDomain("e5-rotate");
    try {
      const peerDomainId = randomUUID();
      const ed = ed25519KeypairB64();
      const cosign1 = "-----BEGIN PUBLIC KEY-----\nROTATE-COSIGN-V1\n-----END PUBLIC KEY-----\n";
      const cosign2 = "-----BEGIN PUBLIC KEY-----\nROTATE-COSIGN-V2\n-----END PUBLIC KEY-----\n";

      // Initial pairing with cosign v1.
      await withTenantTx(domain.db, domain.orgId, (tx) =>
        pairPeer(tx, {
          orgId: domain.orgId,
          domainId: peerDomainId,
          name: "rotating-peer",
          role: "outpost",
          publicKey: ed.publicKey,
          cosignPublicKey: cosign1
        })
      );

      // Re-pair: SAME Ed25519 key, but a CHANGED cosign key — a cosign-only rotation.
      await withTenantTx(domain.db, domain.orgId, (tx) =>
        pairPeer(tx, {
          orgId: domain.orgId,
          domainId: peerDomainId,
          name: "rotating-peer",
          role: "outpost",
          publicKey: ed.publicKey,
          cosignPublicKey: cosign2
        })
      );

      const windows = await peerKeyRowsBySequence(domain, peerDomainId);
      expect(windows).toHaveLength(2);
      // Oldest window: cosign v1, now superseded.
      expect(windows[0]!.cosignPublicKey).toBe(cosign1);
      expect(windows[0]!.supersededAt).not.toBeNull();
      // Current window: cosign v2, live. The Ed25519 key is re-carried verbatim.
      expect(windows[1]!.cosignPublicKey).toBe(cosign2);
      expect(windows[1]!.publicKey).toBe(ed.publicKey);
      expect(windows[1]!.supersededAt).toBeNull();

      const current = await withTenantTx(domain.db, domain.orgId, (tx) =>
        currentPeerKeyRow(tx, domain.orgId, peerDomainId)
      );
      expect(current?.cosignPublicKey).toBe(cosign2);
    } finally {
      await domain.close();
    }
  });

  // -----------------------------------------------------------------------------------------
  // (d) FILE-ONLY / air-gap — the exchange rides the EXISTING out-of-band pairing: one side's status
  //     output + the other side's pair request, with NO new transport and no live connection.
  // -----------------------------------------------------------------------------------------
  it("distribution is file-only: status output + a pair request needs no live connection or new transport", async () => {
    // The commander produces its status (as an operator would run `scp federation status`).
    const commanderKey = await withTenantTx(commander.db, commander.orgId, (tx) =>
      ensureInstanceKey(tx, commander.orgId)
    );
    const { status: commanderStatus } = await statusWithCosign(
      commander,
      fakeCosignGenerator("COMMANDER")
    );
    const commanderCosign = commanderStatus.self?.cosignPublicKey;
    expect(commanderCosign).toBeTruthy();

    // The operator hand-carries that output (a FILE) to the outpost and pairs — no dialing back.
    await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      pairPeer(tx, {
        orgId: outpost.orgId,
        domainId: selfCommander.domainId,
        name: commander.orgName,
        role: "commander",
        publicKey: commanderKey.publicKey,
        cosignPublicKey: commanderCosign ?? undefined
      })
    );

    // The outpost now holds the commander's cosign verification key as the registered trusted value.
    const registered = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      currentPeerKeyRow(tx, outpost.orgId, selfCommander.domainId)
    );
    expect(registered?.cosignPublicKey).toBe(commanderCosign);
  });

  // -----------------------------------------------------------------------------------------
  // (e) ADDITIVE — an OLD pair request lacking a cosign pubkey still pairs (null), and a later
  //     cosign-less re-pair never STRIPS an already-registered cosign key.
  // -----------------------------------------------------------------------------------------
  it("an old pair request without a cosign pubkey still pairs, and never strips an existing one", async () => {
    const domain = await createIsolatedDomain("e5-additive");
    try {
      const peerDomainId = randomUUID();
      const ed = ed25519KeypairB64();

      // Pre-E5-style pairing: no cosign field at all → registered as null, still pairs.
      const paired = await withTenantTx(domain.db, domain.orgId, (tx) =>
        pairPeer(tx, {
          orgId: domain.orgId,
          domainId: peerDomainId,
          name: "legacy-peer",
          role: "outpost",
          publicKey: ed.publicKey
        })
      );
      expect(paired.cosignPublicKey).toBeNull();
      const c0 = await withTenantTx(domain.db, domain.orgId, (tx) =>
        currentPeerKeyRow(tx, domain.orgId, peerDomainId)
      );
      expect(c0?.cosignPublicKey).toBeNull();

      // Now register a cosign key.
      const cosign = "-----BEGIN PUBLIC KEY-----\nADDITIVE-COSIGN\n-----END PUBLIC KEY-----\n";
      await withTenantTx(domain.db, domain.orgId, (tx) =>
        pairPeer(tx, {
          orgId: domain.orgId,
          domainId: peerDomainId,
          name: "legacy-peer",
          role: "outpost",
          publicKey: ed.publicKey,
          cosignPublicKey: cosign
        })
      );

      // A later OLD-client re-pair (metadata only, no cosign field) must PRESERVE it, not strip it.
      await withTenantTx(domain.db, domain.orgId, (tx) =>
        pairPeer(tx, {
          orgId: domain.orgId,
          domainId: peerDomainId,
          name: "legacy-peer-renamed",
          role: "outpost",
          publicKey: ed.publicKey
        })
      );
      const c1 = await withTenantTx(domain.db, domain.orgId, (tx) =>
        currentPeerKeyRow(tx, domain.orgId, peerDomainId)
      );
      expect(c1?.cosignPublicKey).toBe(cosign);
    } finally {
      await domain.close();
    }
  });
});
