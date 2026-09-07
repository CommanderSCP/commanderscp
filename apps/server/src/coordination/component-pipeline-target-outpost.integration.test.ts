import { generateKeyPairSync, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { ScpClient } from "@scp/sdk";
import { asTrustDomainId } from "@scp/schemas";
import { withTenantTx } from "../db/tenant-tx.js";
import { initFederationSelf } from "../federation/self-repo.js";
import { deleteObject, upsertObjectByUrn } from "../graph/objects-repo.js";
import {
  createOrphanComponent,
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/** Which outpost each target is part of, by trust domain. See docs/coordination.md §293. */
describe("component pipeline: which outpost each target is part of (§10.2 trust-domain rule)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;
  const SELF_NAME = `hq-commander-${randomUUID().slice(0, 8)}`;

  const uniq = (p: string) => `${p}-${uuidv7()}`;

  function publicKeyB64(): string {
    const { publicKey } = generateKeyPairSync("ed25519");
    return publicKey.export({ format: "der", type: "spki" }).toString("base64");
  }

  /** Pairs a peer of `role` through the real API; returns its trust-domain id + name. */
  async function pairPeer(
    label: string,
    role: "outpost" | "commander" | "retrans"
  ): Promise<{ id: string; name: string }> {
    const id = randomUUID();
    const name = `${label}-${id.slice(0, 8)}`;
    await admin.federation.pair({ domainId: id, name, role, publicKey: publicKeyB64() });
    return { id, name };
  }
  const pairOutpostPeer = (label: string) => pairPeer(label, "outpost");

  /** A deployment-target planted UNDERNEATH with `originDomainId` as its origin — as `import-repo`
   *  writes a replica — for origins the hand-fill door will not take (a non-outpost peer, self). */
  async function plantTargetUnder(originDomainId: string, slug: string) {
    const name = uniq(slug);
    return withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const { object } = await upsertObjectByUrn(tx, {
        orgId: org.orgId,
        typeId: "deployment-target",
        actorObjectId: org.orgId,
        requestId: `test-plant-${name}`,
        urn: `urn:scp:${org.orgId}:deployment-target:${name}`,
        name,
        properties: { environment: "prod" },
        federationImport: {
          originDomainId: asTrustDomainId(originDomainId),
          revision: 1,
          provenance: null
        }
      });
      return object;
    });
  }

  /** An `outpost` OBJECT planted underneath (a foreign-origin replica or a `provenance:'manual'`
   *  shadow) — the shapes the create door refuses (it 409s any second live claimant, and self is
   *  not a peer) but a database can still HOLD. */
  async function plantOutpostObject(opts: {
    originDomainId: string;
    peerDomainId: string;
    name: string;
    provenance: "manual" | null;
    trustTier?: string;
  }) {
    return withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const { object } = await upsertObjectByUrn(tx, {
        orgId: org.orgId,
        typeId: "outpost",
        actorObjectId: org.orgId,
        requestId: `test-plant-outpost-${opts.name}-${randomUUID()}`,
        urn: `urn:scp:${randomUUID()}:outpost:${opts.peerDomainId}`,
        name: opts.name,
        properties: {
          peerDomainId: opts.peerDomainId,
          ...(opts.trustTier ? { trustTier: opts.trustTier } : {})
        },
        federationImport: {
          originDomainId: asTrustDomainId(opts.originDomainId),
          revision: 1,
          provenance: opts.provenance
        }
      });
      return object;
    });
  }

  async function placedComponentOn(targetId: string, slug: string) {
    const component = await createOrphanComponent(server, org, uniq(slug));
    await admin.placements.create({ component: component.id, deploymentTarget: targetId });
    return component;
  }

  /** `createOutpost` for `peerDomainId`, returning the HTTP status it failed with (0 = it succeeded). */
  async function createOutpostStatus(peerDomainId: string): Promise<number> {
    try {
      await admin.federation.createOutpost({ peerDomainId, trustTier: "il5" });
      return 0;
    } catch (e) {
      return (e as { status?: number }).status ?? -1;
    }
  }

  /** A deployment-target AUTHORED UNDER `peer` (origin = that peer), through the hand-fill door —
   *  the shape a replicated outpost target has at the commander. */
  async function targetUnderPeer(peer: { id: string; name: string }, slug: string) {
    const name = uniq(slug);
    return admin.federation.handFill({
      peer: peer.id,
      typeId: "deployment-target",
      urn: `urn:scp:${org.orgId}:deployment-target:${name}`,
      name,
      properties: { environment: "prod" }
    });
  }

  type Outpost = {
    state: "outpost" | "self" | "peer-without-outpost" | "peer-not-outpost" | "unknown-domain";
    id: string | null;
    name: string | null;
    trustTier: string | null;
    peerDomainId: string | null;
    peerRole: string | null;
  };

  async function pipelineOf(componentId: string) {
    const res = await server.app.inject({
      method: "GET",
      url: `/api/v1/components/${componentId}/pipeline`,
      headers: { authorization: `Bearer ${org.adminToken}` }
    });
    expect(res.statusCode, "the pipeline route must answer").toBe(200);
    return res.json() as {
      stages: { deploymentTarget: { id: string }; outpost: Outpost }[];
      unplacedStages: { deploymentTarget: { id: string }; outpost: Outpost }[];
    };
  }

  async function attachTopology(componentId: string, waves: { name: string; target: string }[]) {
    const topo = await admin.object("release-topology").create({
      name: uniq("topo"),
      properties: {
        waves: waves.map((w) => ({ name: w.name, mode: "parallel", targets: [w.target] }))
      }
    });
    await admin.relationships.create({
      typeId: "releases_via",
      fromId: componentId,
      toId: topo.id
    });
  }

  let selfDomainId: string;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "pipeline-target-outpost");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    // This instance is the COMMANDER, under a name that is neither the org id nor a peer's.
    const self = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      initFederationSelf(tx, { orgId: org.orgId, name: SELF_NAME, role: "commander" })
    );
    selfDomainId = self.domainId;
  }, 120_000);

  afterAll(async () => {
    await server?.close();
  });

  it("`self` — with NO outpost object naming this instance's domain, a locally-authored target names THIS instance, id/tier/peer null (the stated absence, §10.5)", async () => {
    const target = await admin.deploymentTargets.create({
      name: uniq("hq-target"),
      properties: { environment: "prod" }
    });
    const component = await createOrphanComponent(server, org, uniq("self-target"));
    await admin.placements.create({ component: component.id, deploymentTarget: target.id });

    const p = await pipelineOf(component.id);

    expect(p.stages).toHaveLength(1);
    expect(p.stages[0]!.outpost).toEqual({
      state: "self",
      id: null,
      name: SELF_NAME,
      trustTier: null,
      peerDomainId: null,
      peerRole: null
    });
  });

  it("`outpost` — a target authored under a paired peer that HAS an outpost object names it (id, name, trustTier), on the placed AND the unplaced stage", async () => {
    const peer = await pairOutpostPeer("field-outpost");
    // The object is deliberately named differently from the peer: the match is on the object's
    // `properties.peerDomainId` (the trust domain), never on a name.
    const config = await admin.federation.createOutpost({
      peerDomainId: peer.id,
      name: `${peer.name}-config`,
      trustTier: "il5"
    });
    const placedTarget = await targetUnderPeer(peer, "field-cluster");
    const unplacedTarget = await targetUnderPeer(peer, "field-cluster-2");
    const component = await createOrphanComponent(server, org, uniq("field-component"));
    await admin.placements.create({ component: component.id, deploymentTarget: placedTarget.id });
    await attachTopology(component.id, [
      { name: "field", target: placedTarget.id },
      { name: "field-2", target: unplacedTarget.id }
    ]);

    const p = await pipelineOf(component.id);

    const expected: Outpost = {
      state: "outpost",
      id: config.objectId,
      name: `${peer.name}-config`,
      trustTier: "il5",
      peerDomainId: peer.id,
      peerRole: "outpost"
    };
    const placed = p.stages.find((s) => s.deploymentTarget.id === placedTarget.id);
    expect(placed, "the placed stage is on the wire").toBeDefined();
    expect(placed!.outpost).toEqual(expected);
    const unplaced = p.unplacedStages.find((s) => s.deploymentTarget.id === unplacedTarget.id);
    expect(unplaced, "the unplaced stage is on the wire").toBeDefined();
    expect(unplaced!.outpost, "the SAME literal feeds `unplacedStages`").toEqual(expected);
  });

  it("`peer-without-outpost` — a target under a paired peer with NO outpost object names the PEER, id null, tier null", async () => {
    const peer = await pairOutpostPeer("prod-highside");
    const target = await targetUnderPeer(peer, "highside-cluster");
    const component = await createOrphanComponent(server, org, uniq("highside-component"));
    await admin.placements.create({ component: component.id, deploymentTarget: target.id });

    const p = await pipelineOf(component.id);

    expect(p.stages).toHaveLength(1);
    expect(p.stages[0]!.outpost).toEqual({
      state: "peer-without-outpost",
      id: null,
      name: peer.name,
      trustTier: null,
      peerDomainId: peer.id,
      peerRole: "outpost"
    });
  });

  it("`unknown-domain` — a target whose origin is a domain never paired here carries the raw origin id and is NOT read as ours", async () => {
    const foreign = randomUUID();
    const name = uniq("stranger-cluster");
    // A verified-looking replica from a domain this instance holds no peer row for — the state a
    // replica is in before its peer row arrives. Written underneath, as `import-repo` would.
    const target = await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const { object } = await upsertObjectByUrn(tx, {
        orgId: org.orgId,
        typeId: "deployment-target",
        actorObjectId: org.orgId,
        requestId: `test-plant-${name}`,
        urn: `urn:scp:${org.orgId}:deployment-target:${name}`,
        name,
        properties: { environment: "prod" },
        federationImport: {
          originDomainId: asTrustDomainId(foreign),
          revision: 1,
          provenance: null
        }
      });
      return object;
    });
    const component = await createOrphanComponent(server, org, uniq("stranger-component"));
    await admin.placements.create({ component: component.id, deploymentTarget: target.id });

    const p = await pipelineOf(component.id);

    expect(p.stages).toHaveLength(1);
    expect(p.stages[0]!.outpost).toEqual({
      state: "unknown-domain",
      id: null,
      name: null,
      trustTier: null,
      peerDomainId: foreign,
      peerRole: null
    });
  });

  it("an outpost object that declares NO tier reads `trustTier: null` — never defaulted", async () => {
    const peer = await pairOutpostPeer("eu-edge");
    const config = await admin.federation.createOutpost({ peerDomainId: peer.id });
    const target = await targetUnderPeer(peer, "edge-cluster");
    const component = await createOrphanComponent(server, org, uniq("edge-component"));
    await admin.placements.create({ component: component.id, deploymentTarget: target.id });

    const p = await pipelineOf(component.id);

    expect(p.stages[0]!.outpost).toEqual({
      state: "outpost",
      id: config.objectId,
      name: config.name,
      trustTier: null,
      peerDomainId: peer.id,
      peerRole: "outpost"
    });
  });

  it("`peer-not-outpost` — a target under a RETRANS-role peer names the peer with its role, and is NOT `peer-without-outpost`: the outposts API refuses (400) to declare one for it", async () => {
    const peer = await pairPeer("relay", "retrans");
    const target = await plantTargetUnder(peer.id, "relay-cluster");
    const component = await placedComponentOn(target.id, "relay-component");

    const p = await pipelineOf(component.id);

    expect(p.stages[0]!.outpost).toEqual({
      state: "peer-not-outpost",
      id: null,
      name: peer.name,
      trustTier: null,
      peerDomainId: peer.id,
      peerRole: "retrans"
    });
    // The state exists BECAUSE this door is shut: `peer-without-outpost` promises an outpost record
    // can be declared, and for a retrans peer it cannot.
    expect(await createOutpostStatus(peer.id), "createOutpost for a retrans peer").toBe(400);
  });

  it("`peer-not-outpost` — a target under a COMMANDER-role peer (what EVERY commander-authored target reads on an outpost site) — same state, role `commander`, createOutpost 400s", async () => {
    const peer = await pairPeer("hq", "commander");
    const target = await plantTargetUnder(peer.id, "hq-cluster");
    const component = await placedComponentOn(target.id, "hq-component");

    const p = await pipelineOf(component.id);

    expect(p.stages[0]!.outpost).toEqual({
      state: "peer-not-outpost",
      id: null,
      name: peer.name,
      trustTier: null,
      peerDomainId: peer.id,
      peerRole: "commander"
    });
    expect(await createOutpostStatus(peer.id), "createOutpost for a commander peer").toBe(400);
  });

  it("a soft-DELETED outpost object no longer matches — the target falls back to `peer-without-outpost`", async () => {
    const peer = await pairOutpostPeer("del-outpost");
    const config = await admin.federation.createOutpost({
      peerDomainId: peer.id,
      trustTier: "il5"
    });
    const target = await targetUnderPeer(peer, "del-cluster");
    const component = await placedComponentOn(target.id, "del-component");
    expect((await pipelineOf(component.id)).stages[0]!.outpost).toMatchObject({
      state: "outpost",
      id: config.objectId
    });

    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      deleteObject(tx, {
        orgId: org.orgId,
        typeId: "outpost",
        actorObjectId: org.orgId,
        requestId: `test-del-${config.objectId}`,
        idOrUrn: config.objectId
      })
    );

    expect((await pipelineOf(component.id)).stages[0]!.outpost).toEqual({
      state: "peer-without-outpost",
      id: null,
      name: peer.name,
      trustTier: null,
      peerDomainId: peer.id,
      peerRole: "outpost"
    });
  });

  it("TWO live outpost objects on one peer — `byAuthority` picks the VERIFIED replica over an older `provenance:'manual'` shadow, and the outposts API's own pick agrees", async () => {
    const peer = await pairOutpostPeer("dup-outpost");
    // The shadow is created FIRST, so a `list[0]` / created_at pick lands on it — wrongly.
    const shadow = await plantOutpostObject({
      originDomainId: randomUUID(),
      peerDomainId: peer.id,
      name: "shadow-first",
      provenance: "manual",
      trustTier: "commercial"
    });
    // The create door 409s any second live claimant, so the second row is a VERIFIED foreign
    // replica planted underneath, created AFTER the shadow.
    expect(await createOutpostStatus(peer.id), "the create door refuses a second row").toBe(409);
    const verified = await plantOutpostObject({
      originDomainId: randomUUID(),
      peerDomainId: peer.id,
      name: "verified-second",
      provenance: null,
      trustTier: "il5"
    });
    const target = await targetUnderPeer(peer, "dup-cluster");
    const component = await placedComponentOn(target.id, "dup-component");

    const outpost = (await pipelineOf(component.id)).stages[0]!.outpost;

    expect(outpost).toEqual({
      state: "outpost",
      id: verified.id,
      name: "verified-second",
      trustTier: "il5",
      peerDomainId: peer.id,
      peerRole: "outpost"
    });
    expect(outpost.id).not.toBe(shadow.id);
    // GET /federation/outposts/{peer} resolves by the same rule — the page the link opens agrees.
    const viaApi = await admin.federation.getOutpost(peer.id);
    expect(viaApi.objectId).toBe(verified.id);
  });

  it("PRECEDENCE (§10.5, OBJECT-FIRST) — an outpost object naming SELF's domain (the replica shape every OUTPOST SITE holds of its own config) DOES turn a locally-authored target into `outpost <its name>`: the object is decided first, `self` only when none names it", async () => {
    const replicaOrigin = randomUUID();
    const replica = await plantOutpostObject({
      originDomainId: replicaOrigin,
      peerDomainId: selfDomainId,
      name: "replica-of-me",
      provenance: null,
      trustTier: "airgap"
    });
    const target = await admin.deploymentTargets.create({
      name: uniq("mine"),
      properties: { environment: "prod" }
    });
    const component = await placedComponentOn(target.id, "mine-component");

    expect((await pipelineOf(component.id)).stages[0]!.outpost).toEqual({
      state: "outpost",
      id: replica.id,
      name: "replica-of-me",
      trustTier: "airgap",
      peerDomainId: selfDomainId,
      // No peer row for self — the role is this instance's OWN (`federation_self.role`).
      peerRole: "commander"
    });

    // Back to "no self object", so the co-located case below starts from the create door's clean
    // state (a live replica would be a claimant and 409 it). A verified replica is deletable only
    // as its authority would delete it — through the import channel, at a later revision.
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      deleteObject(tx, {
        orgId: org.orgId,
        typeId: "outpost",
        actorObjectId: org.orgId,
        requestId: `test-del-${replica.id}`,
        idOrUrn: replica.id,
        federationImport: {
          originDomainId: asTrustDomainId(replicaOrigin),
          revision: 2,
          provenance: null
        }
      })
    );
    expect((await pipelineOf(component.id)).stages[0]!.outpost.state).toBe("self");
  });

  it("THE HQ OUTPOST (§10.5) — `createOutpost({peerDomainId: self})` is accepted, and every self-origin target reads `outpost <its name> · <tier>` on the placed AND the unplaced stage; a second is 409", async () => {
    const config = await admin.federation.createOutpost({
      peerDomainId: selfDomainId,
      name: "hq-outpost",
      trustTier: "commercial"
    });
    expect(config.peerIsSelf).toBe(true);
    const placedTarget = await admin.deploymentTargets.create({
      name: uniq("hq-gamma"),
      properties: { environment: "gamma" }
    });
    const unplacedTarget = await admin.deploymentTargets.create({
      name: uniq("hq-prod"),
      properties: { environment: "prod" }
    });
    const component = await createOrphanComponent(server, org, uniq("hq-component"));
    await admin.placements.create({ component: component.id, deploymentTarget: placedTarget.id });
    await attachTopology(component.id, [
      { name: "gamma", target: placedTarget.id },
      { name: "prod", target: unplacedTarget.id }
    ]);

    const p = await pipelineOf(component.id);

    const expected: Outpost = {
      state: "outpost",
      id: config.objectId,
      name: "hq-outpost",
      trustTier: "commercial",
      peerDomainId: selfDomainId,
      peerRole: "commander"
    };
    const placed = p.stages.find((s) => s.deploymentTarget.id === placedTarget.id);
    expect(placed, "the placed stage is on the wire").toBeDefined();
    expect(placed!.outpost).toEqual(expected);
    const unplaced = p.unplacedStages.find((s) => s.deploymentTarget.id === unplacedTarget.id);
    expect(unplaced, "the unplaced stage is on the wire").toBeDefined();
    expect(unplaced!.outpost, "the SAME literal feeds `unplacedStages`").toEqual(expected);

    expect(await createOutpostStatus(selfDomainId), "a second self-bound object").toBe(409);
  });
});
