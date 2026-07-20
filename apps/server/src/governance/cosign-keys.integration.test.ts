import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signBlobDetached, verifyBlobDetached, type GeneratedKeyPair } from "@scp/cosign";
import {
  buildTestServer,
  createTestOrg,
  RawScpAppClient,
  type TestServer
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { putSecret, resolveSecretRefs } from "../secrets/secrets-repo.js";
import {
  ensureInstanceCosignKey,
  getInstanceCosignPublicKey,
  type CosignKeyGenerator
} from "./cosign-keys.js";

/**
 * M17.3 E4 — SCP's cosign MANIFEST-SIGNING keypair management (KEY MANAGEMENT ONLY; no signing of
 * any promotion manifest, no export/gate change — those are E6). Proves the owner-decided posture:
 * the private key lives in a DEDICATED org-scoped RLS table (`instance_cosign_keys`), generated
 * lazily + race-safe, STRUCTURALLY unreachable by `resolveSecretRefs` (so it can never be pulled
 * into a plugin subprocess), never returned over any API, and a real keypair that actually works.
 */
describe("M17.3 E4: cosign signing-keypair management", () => {
  let server: TestServer;
  let orgAId: string;
  let orgBId: string;

  beforeAll(async () => {
    server = await buildTestServer();
    orgAId = (await createTestOrg(server, "cosign-a")).orgId;
    orgBId = (await createTestOrg(server, "cosign-b")).orgId;
  });

  afterAll(async () => {
    await server.close();
  });

  /** A fake generator returning a UNIQUE keypair on every call — so a race that provisions once
   *  is provable: if convergence works, N concurrent callers each MINT a distinct pair but the
   *  table ends with exactly one, and all callers return the identical winning row. */
  function countingFakeGenerator(): { gen: CosignKeyGenerator; calls: () => number } {
    let n = 0;
    const gen: CosignKeyGenerator = async (): Promise<GeneratedKeyPair> => {
      const id = ++n;
      return {
        privateKeyPem: `-----BEGIN ENCRYPTED SIGSTORE PRIVATE KEY-----\nFAKE-PRIVATE-#${id}-DO-NOT-LEAK\n-----END ENCRYPTED SIGSTORE PRIVATE KEY-----\n`,
        publicKeyPem: `-----BEGIN PUBLIC KEY-----\nFAKE-PUBLIC-#${id}\n-----END PUBLIC KEY-----\n`
      };
    };
    return { gen, calls: () => n };
  }

  // -----------------------------------------------------------------------------------------
  // (a) Generated ONCE and race-safe.
  // -----------------------------------------------------------------------------------------
  it("provisions exactly one keypair per org even under concurrent first-use (race-safe)", async () => {
    const org = (await createTestOrg(server, "cosign-race")).orgId;
    const { gen, calls } = countingFakeGenerator();

    // Fire many first-use callers at once; each finds no existing row and mints its own pair.
    const results = await Promise.all(
      Array.from({ length: 6 }, () => ensureInstanceCosignKey(server.deps.db, org, gen))
    );

    // All callers converge on ONE row (same id / public key / fingerprint).
    const firstId = results[0]!.id;
    for (const r of results) {
      expect(r.id).toBe(firstId);
      expect(r.publicKey).toBe(results[0]!.publicKey);
      expect(r.fingerprint).toBe(results[0]!.fingerprint);
    }

    // Even though several distinct pairs were generated, exactly one persisted.
    expect(calls()).toBeGreaterThan(0);
    const raw = await RawScpAppClient.connect();
    await raw.setOrgContext(org);
    const rows = await raw.query("SELECT id FROM instance_cosign_keys WHERE org_id = $1", [org]);
    await raw.close();
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.id).toBe(firstId);

    // A later call is idempotent (fast-path re-read; generator NOT invoked again).
    const before = calls();
    const again = await ensureInstanceCosignKey(server.deps.db, org, gen);
    expect(again.id).toBe(firstId);
    expect(calls()).toBe(before);
  });

  // -----------------------------------------------------------------------------------------
  // (b) RLS org-isolation — one org cannot read another org's cosign key row.
  // -----------------------------------------------------------------------------------------
  it("RLS isolates each org's key row (org B cannot read org A's cosign private key)", async () => {
    const a = countingFakeGenerator();
    const b = countingFakeGenerator();
    const keyA = await ensureInstanceCosignKey(server.deps.db, orgAId, a.gen);
    await ensureInstanceCosignKey(server.deps.db, orgBId, b.gen);

    // Org A sees its own row.
    const rawA = await RawScpAppClient.connect();
    await rawA.setOrgContext(orgAId);
    const ownRow = await rawA.query<{ id: string; private_key: string }>(
      "SELECT id, private_key FROM instance_cosign_keys WHERE org_id = $1",
      [orgAId]
    );
    await rawA.close();
    expect(ownRow.rows).toHaveLength(1);
    expect(ownRow.rows[0]!.id).toBe(keyA.id);

    // Org B, querying for org A's row explicitly, sees NOTHING (RLS filters cross-org).
    const rawB = await RawScpAppClient.connect();
    await rawB.setOrgContext(orgBId);
    const crossOrg = await rawB.query(
      "SELECT * FROM instance_cosign_keys WHERE org_id = $1",
      [orgAId]
    );
    await rawB.close();
    expect(crossOrg.rows).toHaveLength(0);

    // No org context at all → fails closed across every org.
    const rawNone = await RawScpAppClient.connect();
    const none = await rawNone.query("SELECT * FROM instance_cosign_keys");
    await rawNone.close();
    expect(none.rows).toHaveLength(0);
  });

  it("RLS WITH CHECK blocks inserting a cosign key row into another org", async () => {
    const raw = await RawScpAppClient.connect();
    await raw.setOrgContext(orgBId);
    await expect(
      raw.query(
        `INSERT INTO instance_cosign_keys (id, org_id, private_key, public_key)
         VALUES (gen_random_uuid(), $1, 'forged-priv', 'forged-pub')`,
        [orgAId]
      )
    ).rejects.toThrow(/row-level security/i);
    await raw.close();
  });

  // -----------------------------------------------------------------------------------------
  // (c) THE EXFILTRATION GUARD — a secretRef naming the cosign key resolves to NOTHING.
  // -----------------------------------------------------------------------------------------
  it("resolveSecretRefs cannot reach the cosign private key (dedicated table is structurally unreachable)", async () => {
    const org = (await createTestOrg(server, "cosign-exfil")).orgId;
    const masterKey = server.deps.config.secretsMasterKey;
    const { gen } = countingFakeGenerator();
    const pair = await ensureInstanceCosignKey(server.deps.db, org, gen);

    // Author a REAL secret so we prove resolveSecretRefs' mechanism is genuinely live (not just
    // returning {} because it's broken).
    await withTenantTx(server.deps.db, org, (tx) =>
      putSecret(tx, { orgId: org, key: "argocd-token", value: "s3cr3t-token", masterKey })
    );

    // An adversarial executor binding tries every plausible name for the cosign key.
    const resolved = await withTenantTx(server.deps.db, org, (tx) =>
      resolveSecretRefs(
        tx,
        org,
        {
          legit: "argocd-token",
          a1: "cosign-private-key",
          a2: "instance_cosign_keys",
          a3: "private_key",
          a4: pair.fingerprint
        },
        masterKey
      )
    );

    // The real secret resolves; nothing that names the cosign key does.
    expect(resolved.legit).toBe("s3cr3t-token");
    expect(resolved.a1).toBeUndefined();
    expect(resolved.a2).toBeUndefined();
    expect(resolved.a3).toBeUndefined();
    expect(resolved.a4).toBeUndefined();
    // Belt-and-braces: no resolved value is the cosign private key.
    expect(Object.values(resolved)).not.toContain(pair.privateKey);

    // Structural proof: the private key is really stored in `instance_cosign_keys`, and is NOT in
    // the `secrets` table `resolveSecretRefs` queries.
    const raw = await RawScpAppClient.connect();
    await raw.setOrgContext(org);
    const inDedicated = await raw.query<{ private_key: string }>(
      "SELECT private_key FROM instance_cosign_keys WHERE org_id = $1",
      [org]
    );
    const inSecrets = await raw.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM secrets WHERE org_id = $1 AND ciphertext IS NOT NULL",
      [org]
    );
    await raw.close();
    expect(inDedicated.rows[0]!.private_key).toBe(pair.privateKey);
    // The only secrets row for this org is the argocd-token — the cosign key is not among them.
    expect(inSecrets.rows[0]!.n).toBe("1");
  });

  // -----------------------------------------------------------------------------------------
  // (d) The private key is NEVER handed out by the public accessor / any API.
  // -----------------------------------------------------------------------------------------
  it("the public-key accessor returns ONLY the public half, never the private key", async () => {
    const org = (await createTestOrg(server, "cosign-pub")).orgId;
    const { gen } = countingFakeGenerator();
    const full = await ensureInstanceCosignKey(server.deps.db, org, gen);

    const pub = await getInstanceCosignPublicKey(server.deps.db, org, gen);
    expect(pub.publicKey).toBe(full.publicKey);
    expect(pub.fingerprint).toBe(full.fingerprint);
    // The returned object carries no private key, by field name or by value.
    expect((pub as unknown as Record<string, unknown>).privateKey).toBeUndefined();
    expect(Object.values(pub)).not.toContain(full.privateKey);
    expect(JSON.stringify(pub)).not.toContain("PRIVATE");
  });

  // -----------------------------------------------------------------------------------------
  // (e) VALIDITY — the generated/stored keypair actually WORKS (real cosign, keyful/offline).
  // -----------------------------------------------------------------------------------------
  it("the stored keypair round-trips sign -> verify via cosign (proves the key is real)", async () => {
    // A FRESH org (never provisioned with a fake generator elsewhere in this suite) so the REAL
    // generator actually runs and a genuine cosign keypair is what lands in the table.
    const org = (await createTestOrg(server, "cosign-validity")).orgId;
    // Real generator (no injection) — provisions a genuine cosign keypair into the table.
    const pair = await ensureInstanceCosignKey(server.deps.db, org);
    expect(pair.privateKey).toContain("PRIVATE KEY");
    expect(pair.publicKey).toContain("PUBLIC KEY");

    const dir = await mkdtemp(path.join(tmpdir(), "scp-cosign-e4-verify-"));
    try {
      const keyPath = path.join(dir, "cosign.key");
      const pubPath = path.join(dir, "cosign.pub");
      const blobPath = path.join(dir, "manifest-stand-in.txt");
      const sigPath = path.join(dir, "manifest-stand-in.sig");
      await writeFile(keyPath, pair.privateKey, "utf8");
      await writeFile(pubPath, pair.publicKey, "utf8");
      await writeFile(blobPath, "E4 validity probe — not a real promotion manifest\n", "utf8");

      // Sign with the STORED private key (empty password), verify with the STORED public key.
      signBlobDetached(blobPath, sigPath, {
        keyPath,
        pubKeyPath: pubPath,
        password: "",
        isEphemeral: true
      });
      expect(verifyBlobDetached(blobPath, sigPath, pubPath).ok).toBe(true);

      // Negative control: tampering the blob makes verification fail — proving the signature is
      // meaningful, not vacuously accepted.
      await writeFile(blobPath, "tampered content\n", "utf8");
      expect(verifyBlobDetached(blobPath, sigPath, pubPath).ok).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
