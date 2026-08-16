import { generateKeyPairSync, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { ScpClient } from "@scp/sdk";
import { asTrustDomainId } from "@scp/schemas";
import { withTenantTx } from "../db/tenant-tx.js";
import { initFederationSelf } from "../federation/self-repo.js";
import { upsertObjectByUrn } from "../graph/objects-repo.js";
import {
  createOrphanComponent,
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/**
 * pipeline-substrate-registry-scan.md §10.2 — WHICH OUTPOST EACH TARGET IS PART OF, by the owner's
 * TRUST-DOMAIN RULE: the `outpost` object whose `properties.peerDomainId` equals the target's own
 * `origin_domain_id`. Through the real HTTP route against real Postgres.
 *
 * WHAT EACH TEST PINS, AND WHY IT IS NOT VACUOUS
 *   - `self`: a locally-authored target reads this instance's federation NAME (initialised here to a
 *     value that is neither the org id nor any peer's name — so "always self" or "peer name" fail).
 *   - `outpost`: a target hand-filled under a paired outpost peer that HAS an `outpost` object reads
 *     that object's id/name/trustTier — on a PLACED stage AND on an UNPLACED stage (one literal feeds
 *     both arrays; a fix applied to one array fails the other).
 *   - `peer-without-outpost`: a target under a paired peer with NO outpost object names the PEER, id
 *     null, tier null — a second paired peer, so it cannot pass by "the only peer has an outpost".
 *   - `unknown-domain`: a target whose origin is a domain this instance never paired with carries the
 *     raw origin id and nothing else — and does NOT read as `self`.
 *   - the outpost's `trustTier` is READ off the object (`il5`), never defaulted; a peer whose object
 *     declares NO tier reads null.
 *
 * MUTATION LOG (each applied ALONE, then reverted)
 * | Mutation | Result |
 * |---|---|
 * | `outpostOf` returns `self` for every origin | outpost, peer-without-outpost and unknown-domain tests FAIL |
 * | resolve `outpost` from the peers list alone (ignore outpost objects) | the outpost test FAILS (`state`, id null) |
 * | push `outpost` into `stages[]` only | the unplaced half of the outpost test FAILS (zod response validation refuses the missing required field) |
 * | default `trustTier` to `"commercial"` when absent | the tierless test FAILS |
 * | key `outpostByPeer` on the object's `name` instead of `properties.peerDomainId` | the outpost test FAILS — the object is named differently from the peer on purpose |
 */
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

  /** Pairs an OUTPOST-role peer through the real API; returns its trust-domain id + name. */
  async function pairOutpostPeer(label: string): Promise<{ id: string; name: string }> {
    const id = randomUUID();
    const name = `${label}-${id.slice(0, 8)}`;
    await admin.federation.pair({ domainId: id, name, role: "outpost", publicKey: publicKeyB64() });
    return { id, name };
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
    state: "outpost" | "self" | "peer-without-outpost" | "unknown-domain";
    id: string | null;
    name: string | null;
    trustTier: string | null;
    peerDomainId: string | null;
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

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "pipeline-target-outpost");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    // This instance is the COMMANDER, under a name that is neither the org id nor a peer's.
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      initFederationSelf(tx, { orgId: org.orgId, name: SELF_NAME, role: "commander" })
    );
  }, 120_000);

  afterAll(async () => {
    await server?.close();
  });

  it("`self` — a locally-authored target names THIS instance, id/tier/peer null", async () => {
    const target = await admin.deploymentTargets.create({
      name: uniq("hq-target"),
      properties: { environment: "prod" }
    });
    const component = await createOrphanComponent(admin, uniq("self-target"));
    await admin.placements.create({ component: component.id, deploymentTarget: target.id });

    const p = await pipelineOf(component.id);

    expect(p.stages).toHaveLength(1);
    expect(p.stages[0]!.outpost).toEqual({
      state: "self",
      id: null,
      name: SELF_NAME,
      trustTier: null,
      peerDomainId: null
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
    const component = await createOrphanComponent(admin, uniq("field-component"));
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
      peerDomainId: peer.id
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
    const component = await createOrphanComponent(admin, uniq("highside-component"));
    await admin.placements.create({ component: component.id, deploymentTarget: target.id });

    const p = await pipelineOf(component.id);

    expect(p.stages).toHaveLength(1);
    expect(p.stages[0]!.outpost).toEqual({
      state: "peer-without-outpost",
      id: null,
      name: peer.name,
      trustTier: null,
      peerDomainId: peer.id
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
    const component = await createOrphanComponent(admin, uniq("stranger-component"));
    await admin.placements.create({ component: component.id, deploymentTarget: target.id });

    const p = await pipelineOf(component.id);

    expect(p.stages).toHaveLength(1);
    expect(p.stages[0]!.outpost).toEqual({
      state: "unknown-domain",
      id: null,
      name: null,
      trustTier: null,
      peerDomainId: foreign
    });
  });

  it("an outpost object that declares NO tier reads `trustTier: null` — never defaulted", async () => {
    const peer = await pairOutpostPeer("eu-edge");
    const config = await admin.federation.createOutpost({ peerDomainId: peer.id });
    const target = await targetUnderPeer(peer, "edge-cluster");
    const component = await createOrphanComponent(admin, uniq("edge-component"));
    await admin.placements.create({ component: component.id, deploymentTarget: target.id });

    const p = await pipelineOf(component.id);

    expect(p.stages[0]!.outpost).toEqual({
      state: "outpost",
      id: config.objectId,
      name: config.name,
      trustTier: null,
      peerDomainId: peer.id
    });
  });
});
