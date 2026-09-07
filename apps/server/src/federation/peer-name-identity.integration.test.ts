import { randomUUID, generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { ScpApiError, ScpClient } from "@scp/sdk";
import { asTrustDomainId } from "@scp/schemas";
import {
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { syncCursors } from "../db/schema.js";
import { initFederationSelf } from "./self-repo.js";
import { getCursor } from "./cursors-repo.js";

/** A peer name must identify a peer, and a rename is an act. See docs/federation.md §350. */
describe("M16.2 H6/H8: a peer name identifies a peer; a rename declares no scope (Testcontainers)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  function publicKeyB64(): string {
    const { publicKey } = generateKeyPairSync("ed25519");
    return publicKey.export({ format: "der", type: "spki" }).toString("base64");
  }

  async function pairFresh(name: string, syncScope?: { mode: "full" } | { mode: "status_only" }) {
    const domainId = randomUUID();
    await admin.federation.pair({
      domainId,
      name,
      role: "outpost",
      publicKey: publicKeyB64(),
      baseUrl: "https://peer.example.test",
      ...(syncScope ? { syncScope } : {})
    });
    return domainId;
  }

  async function expectApiError(
    call: Promise<unknown>,
    status: number,
    detail: RegExp
  ): Promise<void> {
    await call.then(
      () => {
        throw new Error(`expected the call to fail with HTTP ${status}, but it succeeded`);
      },
      (err: unknown) => {
        expect(err).toBeInstanceOf(ScpApiError);
        const apiError = err as ScpApiError;
        expect(apiError.status).toBe(status);
        expect(apiError.problem?.detail ?? "").toMatch(detail);
      }
    );
  }

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "peer-name-identity");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      initFederationSelf(tx, {
        orgId: org.orgId,
        name: `commander-${randomUUID().slice(0, 8)}`,
        role: "commander"
      })
    );
  }, 120_000);

  afterAll(async () => {
    await server?.close();
  });

  it("H6: renaming a peer onto ANOTHER peer's name is refused (409) — and the transport write does not land", async () => {
    const alpha = await pairFresh("alpha-outpost");
    const beta = await pairFresh("beta-outpost");

    await expectApiError(
      admin.federation.updatePeer(beta, {
        name: "alpha-outpost",
        baseUrl: "https://moved.example.test"
      }),
      409,
      /already named 'alpha-outpost'/i
    );

    // ATOMIC REFUSAL: the whole PATCH is rejected, so the baseUrl that rode along with the rename is
    // not applied either. A partially-applied transport write would be the worse half of this bug.
    const after = await admin.federation.getPeer(beta);
    expect(after.name).toBe("beta-outpost");
    expect(after.baseUrl).toBe("https://peer.example.test");
    // And name resolution is unambiguous: the name still names exactly the peer it always named.
    expect((await admin.federation.getPeer("alpha-outpost")).id).toBe(alpha);
  });

  it("H6: PAIRING a NEW peer under an existing peer's name is refused too — the constraint is not route-local", async () => {
    await pairFresh("gamma-outpost");
    await expectApiError(
      admin.federation.pair({
        domainId: randomUUID(),
        name: "gamma-outpost",
        role: "outpost",
        publicKey: publicKeyB64()
      }),
      409,
      /already named 'gamma-outpost'/i
    );
  });

  it("H6: a RE-pair of the SAME peer under its own name still works — the constraint must not break re-pairing", async () => {
    const delta = await pairFresh("delta-outpost");
    const repaired = await admin.federation.pair({
      domainId: delta,
      name: "delta-outpost",
      role: "outpost",
      publicKey: publicKeyB64(),
      baseUrl: "https://delta-2.example.test"
    });
    expect(repaired.id).toBe(delta);
    expect(repaired.baseUrl).toBe("https://delta-2.example.test");
    // Renaming a peer to a name NOBODY holds is likewise unaffected.
    const renamed = await admin.federation.updatePeer(delta, { name: "delta-renamed" });
    expect(renamed.name).toBe("delta-renamed");
    expect((await admin.federation.getPeer("delta-renamed")).id).toBe(delta);
  });

  it("H8: a PATCH that only renames does NOT issue the one-shot re-anchor permit", async () => {
    const peer = await pairFresh("h8-peer", { mode: "full" });
    const peerDomainId = asTrustDomainId(peer);

    // An ANCHORLESS cursor — the only state `permitCursorReanchor` can touch (drizzle/0042's predicate:
    // `last_applied_row_hash IS NULL AND last_applied_seq > 0`).
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.insert(syncCursors).values({
        orgId: org.orgId,
        peerDomainId,
        originDomainId: peerDomainId,
        lastAppliedSeq: 5,
        lastAppliedRowHash: null
      })
    );

    // The peer's stored scope is ALREADY `full`, so absent-means-preserve resolves this rename to `full`
    // — which is exactly how a rename used to issue a scope-declaration permit.
    await admin.federation.updatePeer(peer, { name: "h8-peer-renamed" });
    const afterRename = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      getCursor(tx, org.orgId, peerDomainId, peerDomainId)
    );
    expect(afterRename.reanchorFromSeq).toBeNull();

    // The DOCUMENTED recovery still works on this route: DECLARING the scope `full` heals the wedged
    // cursor. Removing the `input.syncScope !== undefined` gate makes the assertion above red; removing
    // the whole G8 re-application makes this one red. The two together pin the trigger exactly.
    await admin.federation.updatePeer(peer, { syncScope: { mode: "full" } });
    const afterDeclaration = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      getCursor(tx, org.orgId, peerDomainId, peerDomainId)
    );
    expect(afterDeclaration.reanchorFromSeq).toBe(5);
  });

  it("H9b: a body-supplied `domainId` cannot redirect the PATCH onto another peer", async () => {
    const target = await pairFresh("h9b-target");
    const victim = await pairFresh("h9b-victim");
    const before = await admin.federation.getPeer(victim);

    // The handler used to build. See docs/federation.md §351.
    const res = await server.app.inject({
      method: "PATCH",
      url: `/api/v1/federation/peers/${target}`,
      headers: { authorization: `Bearer ${org.adminToken}` },
      payload: { domainId: victim, baseUrl: "https://redirected.example.test" }
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { id: string }).id).toBe(target);

    // The victim is untouched; the write landed on the peer named in the PATH, and only there.
    const after = await admin.federation.getPeer(victim);
    expect(after.baseUrl).toBe(before.baseUrl);
    expect((await admin.federation.getPeer(target)).baseUrl).toBe(
      "https://redirected.example.test"
    );
  });

  it("H8: narrowing the scope issues nothing either — only a RESULTING `full` may", async () => {
    const peer = await pairFresh("h8-narrow", { mode: "full" });
    const peerDomainId = asTrustDomainId(peer);
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.insert(syncCursors).values({
        orgId: org.orgId,
        peerDomainId,
        originDomainId: peerDomainId,
        lastAppliedSeq: 9,
        lastAppliedRowHash: null
      })
    );
    await admin.federation.updatePeer(peer, { syncScope: { mode: "status_only" } });
    const after = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select({ reanchorFromSeq: syncCursors.reanchorFromSeq })
        .from(syncCursors)
        .where(and(eq(syncCursors.orgId, org.orgId), eq(syncCursors.peerDomainId, peerDomainId)))
    );
    expect(after[0]?.reanchorFromSeq ?? null).toBeNull();
  });
});
