import { randomUUID, generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { ScpApiError, ScpClient } from "@scp/sdk";
import { asTrustDomainId } from "@scp/schemas";
import {
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { federationPeerKeys, federationPeers, objects, syncJournal } from "../db/schema.js";
import { initFederationSelf } from "./self-repo.js";

/**
 * M16.2 phase A (E1) — THE `outpost` GRAPH OBJECT AND THE AUTHORITY-SPLIT RULE, end to end through
 * the GENERATED SDK against real Postgres.
 *
 * Read `federation/outpost-binding.ts` for the rule this file checks. In one line: the
 * `federation_peers` ROW owns transport identity/reachability, the `outpost` GRAPH OBJECT owns
 * commander-declared config (`trustTier`) plus the `peerDomainId` binding, and NEITHER can express
 * the other's fields. The two direction tests below are the reviewer's handle on it:
 *
 *   * a CONFIG write appends exactly one `object_upsert` journal row and leaves `federation_peers` +
 *     `federation_peer_keys` byte-identical;
 *   * a TRANSPORT write (the E4 PATCH) appends NO journal row at all and leaves the object's
 *     `version`/`revision` untouched.
 *
 * Every write here goes through `ScpClient` (charter principle 3 — the UI/CLI consume only the
 * generated SDK). Raw DB reads are used ONLY for assertions the API deliberately does not expose
 * (journal rows, key windows), never to set up state a route could set up.
 */
describe("M16.2 E1: the `outpost` builtin object type + the authority split (Testcontainers)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;
  /** A paired peer holding role `outpost` — the anchor a config object must bind to. */
  let outpostPeerId: string;

  /**
   * Asserts an SDK call fails with a specific HTTP status AND a `detail` matching `detail` — the
   * SDK's `Error.message` is only the problem TITLE ("Bad Request"), so asserting on the message
   * alone would pass for any 400 and pin nothing. The status pins the CLASS of refusal; the detail
   * pins WHICH guard fired.
   */
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

  /** A fresh Ed25519 public key in the base64-DER encoding federation stores keys in. */
  function publicKeyB64(): string {
    const { publicKey } = generateKeyPairSync("ed25519");
    return publicKey.export({ format: "der", type: "spki" }).toString("base64");
  }

  /** Pairs a peer through the real API (never a repo call) and returns its trust-domain id. */
  async function pairPeerViaApi(role: "outpost" | "commander" | "retrans"): Promise<string> {
    const domainId = randomUUID();
    await admin.federation.pair({
      domainId,
      name: `${role}-${domainId.slice(0, 8)}`,
      role,
      publicKey: publicKeyB64()
    });
    return domainId;
  }

  async function journalRows(): Promise<{ entryKind: string; payload: unknown }[]> {
    return withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select({ entryKind: syncJournal.entryKind, payload: syncJournal.payload })
        .from(syncJournal)
        .where(eq(syncJournal.orgId, org.orgId))
    );
  }

  async function outpostObjectRows() {
    return withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(objects)
        .where(
          and(
            eq(objects.orgId, org.orgId),
            eq(objects.typeId, "outpost"),
            isNull(objects.deletedAt)
          )
        )
    );
  }

  async function peerKeyRows(peerDomainId: string) {
    return withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(federationPeerKeys)
        .where(
          and(
            eq(federationPeerKeys.orgId, org.orgId),
            eq(federationPeerKeys.peerDomainId, asTrustDomainId(peerDomainId))
          )
        )
    );
  }

  async function peerRow(peerDomainId: string) {
    const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(federationPeers)
        .where(
          and(
            eq(federationPeers.orgId, org.orgId),
            eq(federationPeers.id, asTrustDomainId(peerDomainId))
          )
        )
    );
    return rows[0];
  }

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "outpost-object");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    // This instance is the COMMANDER — the only side that may author outpost config.
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      initFederationSelf(tx, {
        orgId: org.orgId,
        name: `commander-${randomUUID().slice(0, 8)}`,
        role: "commander"
      })
    );
    outpostPeerId = await pairPeerViaApi("outpost");
  }, 120_000);

  afterAll(async () => {
    await server?.close();
  });

  it("creating an outpost config object lands EXACTLY ONE sync_journal row with entry_kind='object_upsert'", async () => {
    const before = await journalRows();

    const config = await admin.federation.createOutpost({
      peerDomainId: outpostPeerId,
      trustTier: "il5"
    });
    expect(config.peerDomainId).toBe(outpostPeerId);
    expect(config.trustTier).toBe("il5");
    // A tier WAS asserted, so nothing is unknown on this row.
    expect(config.unknownFields).toEqual([]);

    const after = await journalRows();
    const added = after.slice(before.length);
    // EXACTLY ONE `object_upsert` — this is the whole point of the owner's graph-object decision:
    // outpost config rides the entry kind the importer already applies for any registered type. No
    // new entry kind, no change to `JournalEntryKindSchema` (9 kinds, none peer-shaped), and no
    // peer-row write pretending it will travel.
    //
    // The accompanying `audit_segment` is the ordinary audit piggyback EVERY audited mutation gets
    // (`audit/audit-repo.ts` appends one on the single call site all mutations funnel through), so
    // the honest assertion is this exact pair, appended in this order — not "one row total".
    expect(added.map((row) => row.entryKind)).toEqual(["audit_segment", "object_upsert"]);
    expect(added.filter((row) => row.entryKind === "object_upsert")).toHaveLength(1);
    const upsert = added.find((row) => row.entryKind === "object_upsert");
    const payload = upsert?.payload as { typeId?: string; properties?: Record<string, unknown> };
    expect(payload.typeId).toBe("outpost");
    // The BINDING and the TIER are what travel — and nothing else. A transport field in this payload
    // would mean the object had become a second, journaled authority for peer transport.
    expect(payload.properties).toEqual({ peerDomainId: outpostPeerId, trustTier: "il5" });
  });

  it("an unbound peerDomainId is REFUSED (400) and writes nothing", async () => {
    const unpaired = randomUUID();
    const before = await outpostObjectRows();
    await expectApiError(
      admin.federation.createOutpost({ peerDomainId: unpaired }),
      400,
      /neither a paired federation peer nor this instance's own trust domain/i
    );
    expect(await outpostObjectRows()).toHaveLength(before.length);
  });

  it("a peer whose federation role is not `outpost` is REFUSED (400)", async () => {
    // A `commander` peer is the instance this side reports UP to — declaring an outpost trust tier
    // about it is nonsense, and silently storing it would put declared config on a peer no Outposts
    // view will ever render.
    const commanderPeer = await pairPeerViaApi("commander");
    await expectApiError(
      admin.federation.createOutpost({ peerDomainId: commanderPeer }),
      400,
      /role 'commander', not 'outpost'/i
    );
  });

  it("a SECOND config object for the same peer CONFLICTS (409) — the binding is one-to-one", async () => {
    const before = await outpostObjectRows();
    await expectApiError(
      admin.federation.createOutpost({ peerDomainId: outpostPeerId, name: "second-try" }),
      409,
      /already has an outpost config object/i
    );
    expect(await outpostObjectRows()).toHaveLength(before.length);
  });

  // ==========================================================================================
  // pipeline-substrate-registry-scan.md §10.5 — THE CO-LOCATED OUTPOST (owner, 2026-08-16). The
  // second accepted binding shape: `peerDomainId` = THIS instance's own trust domain. Everything
  // else stays fail-closed (the two 400s above still hold — measured in this same file), the 1:1
  // rule applies to self exactly as to a peer (409), and every read surface states "this instance"
  // rather than joining to a peer row that does not exist.
  //
  // MUTATION LOG (each applied ALONE, then reverted)
  // | Mutation | Result |
  // |---|---|
  // | `const isSelf = false` in outpost-binding.ts | the create below FAILS 400 ("neither a paired federation peer nor…") |
  // | drop the clash scan for self (`if (!isSelf && blocking[0])`) | the second-object case FAILS (201, not 409) |
  // | `peerIsSelf: originIsSelf` in toOutpostConfig | passes here (both true on the commander) — pinned as DIFFERENT by outpost-config-sync's replica, where origin is foreign and peer is self |
  // | omit `selfOutpost` from status-repo | the status case FAILS (undefined) |
  // ==========================================================================================
  it("§10.5: `peerDomainId` = THIS instance's own domain is ACCEPTED (201) — the co-located outpost — named after self by default, `peerIsSelf: true`, resolvable by GET, listed, and on `federation.status().selfOutpost`", async () => {
    const self = await admin.federation.self();
    const before = await outpostObjectRows();

    const config = await admin.federation.createOutpost({
      peerDomainId: self.domainId,
      trustTier: "commercial"
    });
    expect(config.peerDomainId).toBe(self.domainId);
    // No peer row to take a name from — the default is this instance's OWN federation name.
    expect(config.name).toBe(self.name);
    expect(config.trustTier).toBe("commercial");
    expect(config.peerIsSelf, "the wire states the binding is to self").toBe(true);
    expect(config.originIsSelf, "…and this instance authored it").toBe(true);
    expect(await outpostObjectRows()).toHaveLength(before.length + 1);

    // The single GET resolves it through the same binding — the page the pipeline's outpost link
    // opens (`/federation/outposts/{self}`) has something to render.
    const viaGet = await admin.federation.getOutpost(self.domainId);
    expect(viaGet.objectId).toBe(config.objectId);
    expect(viaGet.peerIsSelf).toBe(true);
    // Listed beside the peer-bound records, with the flag; peer-bound records read false.
    const listed = await admin.federation.listOutposts();
    expect(listed.find((c) => c.objectId === config.objectId)?.peerIsSelf).toBe(true);
    expect(listed.find((c) => c.peerDomainId === outpostPeerId)?.peerIsSelf).toBe(false);
    // The status surface carries it as `selfOutpost` — it can never be a `peers[]` entry (no peer
    // row), and the Outposts page reads it from there.
    const status = await admin.federation.status();
    expect(status.selfOutpost?.objectId).toBe(config.objectId);
    expect(status.selfOutpost?.trustTier).toBe("commercial");
    expect(status.peers.some((p) => p.peer.id === self.domainId), "self is not a peer").toBe(false);
  });

  it("§10.5: a SECOND self-bound object CONFLICTS (409) — 1:1 per domain holds for self as for a peer", async () => {
    const self = await admin.federation.self();
    const before = await outpostObjectRows();
    await expectApiError(
      admin.federation.createOutpost({ peerDomainId: self.domainId, name: "second-self" }),
      409,
      /already has an outpost config object/i
    );
    expect(await outpostObjectRows()).toHaveLength(before.length);
  });

  it("§10.5: the unbound refusal names BOTH accepted shapes — a paired `outpost` peer or this instance's own domain id", async () => {
    const self = await admin.federation.self();
    await expectApiError(
      admin.federation.createOutpost({ peerDomainId: randomUUID() }),
      400,
      new RegExp(`neither a paired federation peer nor this instance's own trust domain \\('${self.domainId}'\\)`)
    );
  });

  it("a tier is NEVER fabricated: created without one, `trustTier` is null and declared unknown", async () => {
    const peer = await pairPeerViaApi("outpost");
    const config = await admin.federation.createOutpost({ peerDomainId: peer });
    // F3 — `trustTier` has no source anywhere but an operator's assertion. Absent must stay absent:
    // not "", not "commercial", not any default. And absence must be DECLARED, so a UI renders an
    // honest unknown rather than a clean reading (the `unknownFields` contract).
    expect(config.trustTier).toBeNull();
    expect(config.unknownFields).toContain("trustTier");

    // The property is genuinely ABSENT from the stored object, not present-and-null.
    const rows = await outpostObjectRows();
    const stored = rows.find(
      (row) => (row.properties as { peerDomainId?: string }).peerDomainId === peer
    );
    expect(stored).toBeDefined();
    expect(Object.keys(stored?.properties as object)).toEqual(["peerDomainId"]);

    // …and it still reads as unknown through the status surface, where the Overview will read it.
    const status = await admin.federation.status();
    const peerStatus = status.peers.find((entry) => entry.peer.id === peer);
    expect(peerStatus?.trustTier ?? null).toBeNull();
    expect(peerStatus?.unknownFields ?? []).toContain("trustTier");

    // A later PATCH is how a tier gets asserted — and then it is no longer unknown.
    const patched = await admin.federation.updateOutpost(peer, { trustTier: "fedramp-high" });
    expect(patched.trustTier).toBe("fedramp-high");
    expect(patched.unknownFields).toEqual([]);
  });

  // ==========================================================================================
  // N6 (review round 5) — 'THE REQUEST BODIES ADMIT ONLY THE KNOWN FIELDS' IS A REFUSAL, NOT A STRIP.
  //
  // Measured before the fix: `POST /api/v1/federation/outposts` with an extra `somePhaseBProperty`
  // answered 201 and stored `{trustTier, peerDomainId}` — zod's default object parse dropped the key.
  // Nothing false was stored, so the honesty claim survived; but drizzle/0043, ADR-0022 and
  // `outpost-binding.ts` all described a REFUSAL an operator never saw, and a NEWER CLIENT writing a
  // phase-B property to an OLDER commander got a success and lost its field with no signal. That is a
  // real hazard for a product whose premise is version skew across domains. Both bodies are now
  // `z.strictObject`. The asymmetry with the JOURNAL is deliberate and is pinned by
  // `outpost-config-sync.integration.test.ts`: strict at the operator's door, OPEN on the wire.
  // ==========================================================================================

  it("N6: an unknown property on CREATE is REFUSED (400), not silently stripped, and writes nothing", async () => {
    const peer = await pairPeerViaApi("outpost");
    const before = await outpostObjectRows();
    await expectApiError(
      admin.federation.createOutpost({
        peerDomainId: peer,
        trustTier: "commercial",
        somePhaseBProperty: { nested: true }
      } as never),
      400,
      /somePhaseBProperty|unrecognized|not allowed|additional/i
    );
    // The whole write is refused — no half-accepted object with the operator's field missing.
    expect(await outpostObjectRows()).toHaveLength(before.length);
    await expectApiError(admin.federation.getOutpost(peer), 404, /has no outpost config object/i);
  });

  it("N6: an unknown property on PATCH is REFUSED (400) — including `peerDomainId`, which the docs call not-patchable", async () => {
    const peer = await pairPeerViaApi("outpost");
    const created = await admin.federation.createOutpost({ peerDomainId: peer, trustTier: "il5" });
    await expectApiError(
      admin.federation.updateOutpost(peer, { somePhaseBProperty: "x" } as never),
      400,
      /somePhaseBProperty|unrecognized|not allowed|additional/i
    );
    // `peerDomainId` was previously accepted-and-dropped, which reads to a client as a successful
    // re-bind. It is the object's identity, so saying so out loud is materially clearer.
    await expectApiError(
      admin.federation.updateOutpost(peer, { peerDomainId: randomUUID() } as never),
      400,
      /peerDomainId|unrecognized|not allowed|additional/i
    );
    // Neither refusal touched the object.
    const after = await admin.federation.getOutpost(peer);
    expect(after.objectId).toBe(created.objectId);
    expect(after.version).toBe(created.version);
    expect(after.trustTier).toBe("il5");
  });

  it("N6: an INVENTED tier is refused too — the enum is the API's, and it is exactly ADR-0022's five members", async () => {
    const peer = await pairPeerViaApi("outpost");
    await expectApiError(
      admin.federation.createOutpost({ peerDomainId: peer, trustTier: "top-secret" } as never),
      400,
      /trustTier|invalid|expected/i
    );
    // Every member the glossary/ADR-0022 alignment settled on IS accepted — the same list the CLI
    // help now derives from (`packages/cli/src/outpost-cli-surface.test.ts`), so a tier an operator
    // is TOLD to type can never be one the API rejects.
    for (const tier of ["commercial", "govcloud", "fedramp-high", "il5", "airgap"] as const) {
      const p = await pairPeerViaApi("outpost");
      const config = await admin.federation.createOutpost({ peerDomainId: p, trustTier: tier });
      expect(config.trustTier).toBe(tier);
      expect(config.unknownFields).toEqual([]);
    }
  });

  // ==========================================================================================
  // THE AUTHORITY-SPLIT RULE, asserted in BOTH directions.
  // ==========================================================================================

  it("AUTHORITY SPLIT ①: a CONFIG write journals one entry and leaves the peer row + key window byte-identical", async () => {
    const peerBefore = await peerRow(outpostPeerId);
    const keysBefore = await peerKeyRows(outpostPeerId);
    const journalBefore = await journalRows();

    await admin.federation.updateOutpost(outpostPeerId, { trustTier: "commercial" });

    const peerAfter = await peerRow(outpostPeerId);
    // The object cannot express transport, so a config edit cannot touch it. Compared field by field
    // rather than by object identity so a future column addition still fails loudly here.
    expect(peerAfter?.baseUrl).toBe(peerBefore?.baseUrl ?? null);
    expect(peerAfter?.syncScope).toEqual(peerBefore?.syncScope);
    expect(peerAfter?.deliveryTarget).toEqual(peerBefore?.deliveryTarget ?? null);
    expect(peerAfter?.pokeMode).toBe(peerBefore?.pokeMode);
    expect(peerAfter?.name).toBe(peerBefore?.name);
    expect(peerAfter?.role).toBe(peerBefore?.role);
    expect(peerAfter?.pairedAt.toISOString()).toBe(peerBefore?.pairedAt.toISOString());
    // Key windows untouched: no new row, nothing superseded.
    const keysAfter = await peerKeyRows(outpostPeerId);
    expect(keysAfter).toHaveLength(keysBefore.length);
    expect(
      keysAfter.map((row) => `${row.id}:${row.publicKey}:${String(row.supersededAt)}`)
    ).toEqual(keysBefore.map((row) => `${row.id}:${row.publicKey}:${String(row.supersededAt)}`));
    // …and the config edit DID travel: one more `object_upsert` (plus its ordinary audit segment).
    const journalAfter = await journalRows();
    const added = journalAfter.slice(journalBefore.length);
    expect(added.map((row) => row.entryKind)).toEqual(["audit_segment", "object_upsert"]);
  });

  it("AUTHORITY SPLIT ②: a TRANSPORT write journals NOTHING and leaves the config object's version/revision untouched", async () => {
    const objectBefore = (await outpostObjectRows()).find(
      (row) => (row.properties as { peerDomainId?: string }).peerDomainId === outpostPeerId
    );
    expect(objectBefore).toBeDefined();
    const journalBefore = await journalRows();

    await admin.federation.updatePeer(outpostPeerId, {
      baseUrl: "https://outpost.example.test",
      syncScope: { mode: "changes_only" }
    });

    // F1, made visible: peer state CANNOT ride the journal — `peers-repo.ts` never appends an entry
    // and no entry kind could carry one. This is precisely why commander-origin outpost CONFIG had to
    // be a graph object; if this assertion ever flips, that reasoning needs revisiting, not patching.
    expect(await journalRows()).toHaveLength(journalBefore.length);

    const objectAfter = (await outpostObjectRows()).find(
      (row) => (row.properties as { peerDomainId?: string }).peerDomainId === outpostPeerId
    );
    expect(objectAfter?.version).toBe(objectBefore?.version);
    expect(objectAfter?.revision).toBe(objectBefore?.revision);
    expect(objectAfter?.properties).toEqual(objectBefore?.properties);

    // The transport write DID land, on its own side of the split.
    const peer = await admin.federation.getPeer(outpostPeerId);
    expect(peer.baseUrl).toBe("https://outpost.example.test");
    expect(peer.syncScope).toEqual({ mode: "changes_only" });
  });

  it("AUTHORITY SPLIT ③: the generic /objects/outpost door is refused — federation config is not writable under bare object:write", async () => {
    const peer = await pairPeerViaApi("outpost");
    // Raw HTTP on purpose: the SDK has no method for this door, and the point is that the door itself
    // refuses (403) rather than that no client offers it.
    const res = await server.app.inject({
      method: "POST",
      url: "/api/v1/objects/outpost",
      headers: { authorization: `Bearer ${org.adminToken}` },
      payload: { name: "side-door", properties: { peerDomainId: peer } }
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatch(/federation\/outposts/);

    // PUT-by-urn, PATCH and DELETE are the same door with different verbs — all four are blocked, so
    // there is no verb-shaped hole (the census failure this project keeps hitting).
    for (const method of ["PUT", "PATCH", "DELETE"] as const) {
      const other = await server.app.inject({
        method,
        url: `/api/v1/objects/outpost/${method === "PUT" ? "urn:scp:x:outpost:y" : peer}`,
        headers: { authorization: `Bearer ${org.adminToken}` },
        payload: method === "DELETE" ? undefined : { name: "side-door", properties: {} }
      });
      expect(other.statusCode).toBe(403);
    }
  });

  it("AUTHORITY SPLIT ④: transportMode is DERIVED from transport CONFIG and stays separate from trustTier", async () => {
    // An outpost with an https base URL reads `dialable` — "a dialable transport is CONFIGURED", never
    // "this peer has been reached" (review round 4: the label used to say `connected`). The tier says
    // nothing about it either way.
    const status = await admin.federation.status();
    const connected = status.peers.find((entry) => entry.peer.id === outpostPeerId);
    expect(connected?.transportMode).toBe("dialable");
    expect(connected?.trustTier).toBe("commercial"); // as PATCHed in ① — and unrelated to the above

    // A peer with NO transport at all is NOT reported as air-gapped: that is a misconfiguration, not
    // a posture, so it is declared unknown instead of guessed.
    const bare = await pairPeerViaApi("outpost");
    const status2 = await admin.federation.status();
    const bareStatus = status2.peers.find((entry) => entry.peer.id === bare);
    expect(bareStatus?.transportMode ?? null).toBeNull();
    expect(bareStatus?.unknownFields ?? []).toContain("transportMode");
  });
});
