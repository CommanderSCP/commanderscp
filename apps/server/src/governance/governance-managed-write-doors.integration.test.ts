import { generateKeyPairSync, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { ScpApiError, ScpClient } from "@scp/sdk";
import {
  createOrphanComponent,
  createTestOrg,
  createTestUser,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg,
  type TestUser
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { objects, roleBindings, roles } from "../db/schema.js";
import {
  GOVERNANCE_MANAGED_OBJECT_TYPE_IDS,
  PROJECTION_BOUND_OBJECT_TYPE_IDS
} from "./governance-managed-types.js";

/** THE `policy:write` DOOR CENSUS. See docs/governance.md §156. */

/** An UNSCOPED, `required` policy: org-wide blast radius with an unmeetable approval quorum. */
const ORG_WIDE_POLICY_PROPERTIES = {
  enforcement: "required",
  effects: [{ requireApprovals: { count: 99, fromRole: "Owner", scope: "organization" } }]
} as const;

describe("policy:write door census: a caller-supplied typeId cannot mint governance objects (Testcontainers)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  /** `object:write` + `relationship:write` at the org root, and NO `policy:write` anywhere. */
  let operator: TestUser;
  /** A REAL, PAIRED commander peer for the hand-fill cases. See docs/governance.md §157. */
  let handFillPeer: string;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "gov-doors");
    operator = await createTestUser(server, org, [{ role: "Operator", scope: org.orgId }]);
    handFillPeer = await pairCommanderPeer();
  }, 180_000);

  afterAll(async () => {
    await server?.close();
  });

  /** Live rows of a governance type in this org with this name — "nothing was written". */
  async function governanceRowsByName(typeId: string, name: string) {
    return withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select({ id: objects.id, properties: objects.properties })
        .from(objects)
        .where(
          and(
            eq(objects.orgId, org.orgId),
            eq(objects.typeId, typeId),
            eq(objects.name, name),
            isNull(objects.deletedAt)
          )
        )
    );
  }

  const policyRowsByName = (name: string) => governanceRowsByName("policy", name);

  async function post(url: string, token: string, payload: unknown) {
    return server.app.inject({
      method: "POST",
      url,
      headers: { authorization: `Bearer ${token}` },
      payload: payload as Record<string, unknown>
    });
  }

  /** A subject holding one permission and not the other. See docs/governance.md §158. */
  async function createFederationOnlyUser(): Promise<TestUser> {
    // Viewer, purely so the harness mints the auth row and a live token; `object:read` is not any
    // part of what is under test and grants no write anywhere.
    const user = await createTestUser(server, org, [{ role: "Viewer", scope: org.orgId }]);
    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const roleId = randomUUID();
      await tx.insert(roles).values({
        id: roleId,
        orgId: org.orgId,
        name: `federation-only-${randomUUID().slice(0, 8)}`,
        permissions: ["federation:write"]
      });
      await tx.insert(roleBindings).values({
        id: randomUUID(),
        orgId: org.orgId,
        subjectId: user.objectId,
        roleId,
        scopeObjectId: org.orgId,
        effect: "allow"
      });
    });
    return user;
  }

  /** M25.7 — THE THIRD ACTOR. See docs/governance.md §159. */
  async function createGovernanceNoFreezeUser(): Promise<TestUser> {
    const user = await createTestUser(server, org, [{ role: "Viewer", scope: org.orgId }]);
    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const roleId = randomUUID();
      await tx.insert(roles).values({
        id: roleId,
        orgId: org.orgId,
        name: `governance-no-freeze-${randomUUID().slice(0, 8)}`,
        // Everything the five doors ask for at their own front gates, plus the governance bar the
        // three permission-remedy doors apply. NOT `freeze:write`, and NOT `freeze:override`.
        permissions: [
          "object:read",
          "object:write",
          "relationship:write",
          "policy:write",
          "federation:write"
        ]
      });
      await tx.insert(roleBindings).values({
        id: randomUUID(),
        orgId: org.orgId,
        subjectId: user.objectId,
        roleId,
        scopeObjectId: org.orgId,
        effect: "allow"
      });
    });
    return user;
  }

  /** Pairs a `commander` peer, so a hand-fill can actually reach `upsertObjectByUrn`. */
  async function pairCommanderPeer(): Promise<string> {
    const domainId = randomUUID();
    const { publicKey } = generateKeyPairSync("ed25519");
    const res = await post("/api/v1/federation/peers", org.adminToken, {
      domainId,
      name: `gov-doors-cmdr-${domainId.slice(0, 8)}`,
      role: "commander",
      publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64")
    });
    expect(res.statusCode, res.body).toBe(201);
    return domainId;
  }

  /** A plain, non-governance base object for an overlay to annotate. */
  async function createBaseService(): Promise<string> {
    const res = await post("/api/v1/objects/service", org.adminToken, {
      name: `gov-doors-base-${randomUUID().slice(0, 8)}`
    });
    expect(res.statusCode, res.body).toBe(201);
    return (res.json() as { id: string }).id;
  }

  it("DOOR 1: an Operator cannot mint an org-wide policy through the overlay route", async () => {
    const base = await createBaseService();
    const name = `overlay-escalation-${randomUUID().slice(0, 8)}`;

    const res = await post("/api/v1/federation/overlays", operator.token, {
      base,
      typeId: "policy",
      name,
      properties: ORG_WIDE_POLICY_PROPERTIES
    });

    expect(res.statusCode, res.body).toBe(403);
    // The SPECIFIC violation: the missing permission, named. Not a count, not the prose.
    expect(res.body).toMatch(/policy:write/);
    expect(
      await policyRowsByName(name),
      "a refusal that still stored the row is not a refusal"
    ).toHaveLength(0);
  });

  it("DOOR 1 (control): an Administrator CAN still overlay a policy — the door did not close", async () => {
    // DESIGN §13's canonical overlay case is annotating a commander-distributed global policy, and
    // `assertPolicyOverlayOnlyAddsStrictness` exists only for policy-over-policy overlays. Without
    // this case, DOOR 1 above is satisfied by an overlay route that refuses `policy` outright.
    const basePolicy = await post("/api/v1/policies", org.adminToken, {
      name: `gov-doors-base-policy-${randomUUID().slice(0, 8)}`,
      properties: { enforcement: "advisory" }
    });
    expect(basePolicy.statusCode, basePolicy.body).toBe(201);
    const name = `overlay-legitimate-${randomUUID().slice(0, 8)}`;

    const res = await post("/api/v1/federation/overlays", org.adminToken, {
      base: (basePolicy.json() as { id: string }).id,
      typeId: "policy",
      name,
      properties: { enforcement: "required" }
    });

    expect(res.statusCode, res.body).toBe(201);
    expect(await policyRowsByName(name)).toHaveLength(1);
  });

  it("DOOR 1 (org-root authority): narrow policy:write does not carry — the guard asks at the ORG ROOT", async () => {
    // THIS CASE WAS RE-AIMED IN M21.7. See docs/governance.md §160.
    const base = await createBaseService();
    const narrowPolicyAuthor = await createTestUser(server, org, [
      { role: "Operator", scope: org.orgId },
      { role: "Administrator", scope: base }
    ]);
    const name = `overlay-narrow-authority-${randomUUID().slice(0, 8)}`;

    const res = await post("/api/v1/federation/overlays", narrowPolicyAuthor.token, {
      base,
      typeId: "policy",
      name,
      properties: ORG_WIDE_POLICY_PROPERTIES
    });

    expect(res.statusCode, res.body).toBe(403);
    // The SPECIFIC violation, and the part that distinguishes this case from the one above: the
    // refusal must name the permission AND that it is wanted at the organization root.
    expect(res.body).toMatch(/policy:write/);
    expect(res.body).toMatch(/organization root/);
    expect(await policyRowsByName(name)).toHaveLength(0);
  });

  it("DOOR 1 (control): a non-governance overlay still needs only object:write", async () => {
    // Without this, DOOR 1 is equally satisfied by an overlay route that demands `policy:write`
    // for EVERY type — which would break the feature for every ordinary annotation.
    const base = await createBaseService();
    const res = await post("/api/v1/federation/overlays", operator.token, {
      base,
      typeId: "service",
      name: `overlay-ordinary-${randomUUID().slice(0, 8)}`
    });
    expect(res.statusCode, res.body).toBe(201);
  });

  // DOOR 2 IS GONE. See docs/governance.md §161.

  // DOOR 3 — the generic `/objects/{type}` family. Listed as closed; MEASURED closed, all verbs.

  it("DOOR 3: every write verb of /objects/{type} refuses the governance types", async () => {
    const cases: Array<{ method: "POST" | "PATCH" | "PUT" | "DELETE"; url: string }> = [
      { method: "POST", url: "/api/v1/objects/policy" },
      { method: "PATCH", url: `/api/v1/objects/policy/${randomUUID()}` },
      { method: "PUT", url: "/api/v1/objects/policy/urn:scp:x:policy:y" },
      { method: "DELETE", url: `/api/v1/objects/policy/${randomUUID()}` },
      { method: "POST", url: "/api/v1/objects/control" }
    ];
    for (const c of cases) {
      const res = await server.app.inject({
        method: c.method,
        url: c.url,
        headers: { authorization: `Bearer ${operator.token}` },
        payload: c.method === "DELETE" ? undefined : { name: "generic-door", properties: {} }
      });
      expect(res.statusCode, `${c.method} ${c.url}: ${res.body}`).toBe(403);
      expect(res.body).toMatch(/governance-managed/);
    }
  });

  // DOOR 4 — IaC plan + apply. Listed as closed; MEASURED closed.

  it("DOOR 4: IaC apply refuses an Operator's manifest that declares a policy, and writes nothing", async () => {
    const stackName = `gov-doors-${randomUUID().slice(0, 8)}`;
    const name = `iac-escalation-${randomUUID().slice(0, 8)}`;
    // `POST /plans` takes `{manifest: {...}}` (`CreatePlanRequestSchema`, packages/schemas/src/
    // iac.ts). Spelling the manifest fields at the top level made the route answer 400 for the
    // SHAPE, so the case never reached the door it names — red, but for the wrong reason.
    const plan = await post("/api/v1/plans", operator.token, {
      manifest: {
        stackName,
        objects: [
          {
            urn: `urn:scp:${stackName}:policy:smuggled`,
            typeId: "policy",
            name,
            properties: ORG_WIDE_POLICY_PROPERTIES
          }
        ],
        relationships: []
      }
    });
    expect(plan.statusCode, plan.body).toBe(201);

    const apply = await post(
      `/api/v1/plans/${(plan.json() as { id: string }).id}/apply`,
      operator.token,
      {}
    );
    expect(apply.statusCode, apply.body).toBe(403);
    expect(apply.body).toMatch(/policy:write/);
    expect(await policyRowsByName(name)).toHaveLength(0);
  });

  // The grant-specific cases, carried in on the rebase. See docs/governance.md §162.
  it("DOOR 4b: a policy:write HOLDER cannot mint an ALREADY-APPROVED grant through IaC — the permission mapping was never the defence", async () => {
    // The hole this closes in the permission mapping. See docs/governance.md §163.
    const server: ListeningTestServer = await listenTestServer({});
    try {
      const org: TestOrg = await createTestOrg(server, "gm-grant-iac");
      const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
      const domain = await admin.object("domain").create({ name: "payments" });
      const component = await createOrphanComponent(server, org, "payments-api");

      // A GENUINE `policy:write` HOLDER, scoped to that domain. See docs/governance.md §164.
      const author = await createTestUser(server, org, [
        { role: "Viewer", scope: org.orgId },
        { role: "Administrator", scope: domain.id }
      ]);
      const client = new ScpClient({ baseUrl: server.baseUrl, token: author.token });

      const grantProperties = (status: string, extra: Record<string, unknown> = {}) => ({
        componentId: component.id,
        vulnerabilityId: "CVE-2024-3094",
        tierObjectId: domain.id,
        status,
        reason: "accepted",
        ...extra
      });

      const applyGrant = async (stackName: string, properties: Record<string, unknown>) => {
        const plan = await client.plans.create({
          stackName,
          objects: [
            {
              urn: `urn:scp:${stackName}:scan_override_grant:smuggled`,
              typeId: "scan_override_grant",
              name: `smuggled-${stackName}`,
              domainId: domain.id,
              properties
            }
          ],
          relationships: []
        });
        return client.plans.apply(plan.id);
      };

      // ANTI-VACUITY CONTROL, FIRST. The same actor, the same door, the same type — a `requested`
      // grant. It MUST go through: a grant that authorizes nothing is exactly the record ADR-0033
      // wants raised early, and refusing it would make this case pass for the wrong reason (namely
      // "this actor cannot use IaC on this type at all").
      const okStack = `gm-req-${randomUUID().slice(0, 8)}`;
      await applyGrant(okStack, grantProperties("requested"));
      const afterOk = await admin.object("scan_override_grant").list();
      expect(afterOk.items).toHaveLength(1);

      // ...and now the same manifest with the decision already made.
      for (const [label, properties] of [
        [
          "status: approved",
          grantProperties("approved", { expiresAt: "2999-01-01T00:00:00.000Z" })
        ],
        [
          "a bare future expiry",
          grantProperties("requested", { expiresAt: "2999-01-01T00:00:00.000Z" })
        ],
        ["a forged decider", grantProperties("requested", { decidedByActorId: author.objectId })]
      ] as const) {
        const stackName = `gm-grant-${randomUUID().slice(0, 8)}`;
        await applyGrant(stackName, properties as Record<string, unknown>).then(
          () => {
            throw new Error(`IaC apply must refuse a grant carrying ${label}`);
          },
          (err: unknown) => {
            expect(err, label).toBeInstanceOf(ScpApiError);
          }
        );
      }

      // ASSERT THE ROWS, not the statuses. A refusal that stored the object anyway would satisfy
      // three rejects and leave a live waiver in the graph.
      const stored = await admin.object("scan_override_grant").list();
      expect(stored.items).toHaveLength(1);
      expect(stored.items[0]?.properties).toMatchObject({ status: "requested" });
      expect(stored.items[0]?.properties).not.toHaveProperty("expiresAt");
      expect(stored.items[0]?.properties).not.toHaveProperty("decidedByActorId");

      // And the one that did get through cannot be approved. See docs/governance.md §165.
      await expect(
        admin.scanOverrideGrants.approve(stored.items[0]!.id, {
          expiresAt: "2999-01-01T00:00:00.000Z",
          reason: "approving a grant that names an off-chain authority"
        })
      ).rejects.toBeInstanceOf(ScpApiError);
      const afterApprove = await admin.object("scan_override_grant").list();
      expect(afterApprove.items[0]?.properties).toMatchObject({ status: "requested" });
    } finally {
      await server.close();
    }
  }, 120_000);

  it("DOOR 4c: the UPDATE half — IaC cannot flip an existing grant to approved either", async () => {
    // `updateObject` REPLACES `properties`, so the same door that could mint an approved grant could
    // also flip an already-DENIED one to `approved` — which the `decide` route explicitly refuses
    // ("only a 'requested' grant can be approved"). A guard installed only on the create half would
    // leave the strictly worse of the two open.
    const server: ListeningTestServer = await listenTestServer({});
    try {
      const org: TestOrg = await createTestOrg(server, "gm-grant-update");
      const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
      const component = await createOrphanComponent(server, org, "billing-api");
      const stackName = `gm-upd-${randomUUID().slice(0, 8)}`;
      const urn = `urn:scp:${stackName}:scan_override_grant:standing`;
      const base = {
        componentId: component.id,
        vulnerabilityId: "CVE-2024-3094",
        tierObjectId: org.orgId,
        reason: "accepted"
      };

      const apply = async (properties: Record<string, unknown>) => {
        const plan = await admin.plans.create({
          stackName,
          objects: [
            { urn, typeId: "scan_override_grant", name: `standing-${stackName}`, properties }
          ],
          relationships: []
        });
        return admin.plans.apply(plan.id);
      };

      await apply({ ...base, status: "requested" });
      await expect(
        apply({ ...base, status: "approved", expiresAt: "2999-01-01T00:00:00.000Z" })
      ).rejects.toBeInstanceOf(ScpApiError);

      const stored = await admin.object("scan_override_grant").list();
      expect(stored.items).toHaveLength(1);
      expect(stored.items[0]?.properties).toMatchObject({ status: "requested" });
    } finally {
      await server.close();
    }
  }, 120_000);

  it("DOORS 1+5: HAND-FILL and OVERLAY refuse a decided grant too — the census run filterlessly, not the two doors the docblock named", async () => {
    // The two doors a per-route install always misses. See docs/governance.md §166.
    const server: ListeningTestServer = await listenTestServer({});
    try {
      const org: TestOrg = await createTestOrg(server, "gm-grant-fed");
      const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
      const component = await createOrphanComponent(server, org, "fed-api");
      const decided = {
        componentId: component.id,
        vulnerabilityId: "CVE-2024-3094",
        tierObjectId: org.orgId,
        status: "approved",
        reason: "accepted",
        expiresAt: "2999-01-01T00:00:00.000Z"
      };

      const peerDomainId = randomUUID();
      const { publicKey } = generateKeyPairSync("ed25519");
      await admin.federation.pair({
        domainId: peerDomainId,
        name: `cmdr-${peerDomainId.slice(0, 8)}`,
        role: "commander",
        publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64")
      });

      const handFilledUrn = `urn:scp:${org.orgId}:scan_override_grant:hand-filled`;
      await expect(
        admin.federation.handFill({
          peer: peerDomainId,
          typeId: "scan_override_grant",
          urn: handFilledUrn,
          name: "hand-filled-grant",
          properties: decided
        })
      ).rejects.toBeInstanceOf(ScpApiError);

      const base = await admin.services.create({ name: `svc-${randomUUID().slice(0, 8)}` });
      await expect(
        admin.federation.createOverlay({
          base: base.id,
          typeId: "scan_override_grant",
          name: "overlay-grant",
          urn: `urn:scp:${org.orgId}:scan_override_grant:overlay`,
          properties: decided
        })
      ).rejects.toBeInstanceOf(ScpApiError);

      expect((await admin.object("scan_override_grant").list()).items).toHaveLength(0);

      // CONTROL: the same hand-fill with `status: "requested"` goes through. Without it, the case
      // above is satisfied by a route that refuses every `scan_override_grant`, or that broke.
      const filled = await admin.federation.handFill({
        peer: peerDomainId,
        typeId: "scan_override_grant",
        urn: handFilledUrn,
        name: "hand-filled-grant",
        properties: { ...decided, status: "requested", expiresAt: undefined }
      });
      expect(filled.provenance).toBe("manual");
      const stored = await admin.object("scan_override_grant").list();
      expect(stored.items).toHaveLength(1);
      expect(stored.items[0]?.properties).toMatchObject({ status: "requested" });
    } finally {
      await server.close();
    }
  }, 120_000);

  it("CENSUS: the set's docblock NAMES the federation-import path — the door its previous version omitted", async () => {
    // Deliberately the only source assertion in this file. See docs/governance.md §167.
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(
      new URL("./governance-managed-types.ts", import.meta.url),
      "utf8"
    );
    expect(source).toContain("federation/import-repo.ts");
    expect(source).toContain("object_upsert");
  });

  it("DOOR 5: hand-fill is out of an Operator's reach entirely — it needs federation:write", async () => {
    const name = `handfill-escalation-${randomUUID().slice(0, 8)}`;
    const res = await post("/api/v1/federation/hand-fill", operator.token, {
      peer: handFillPeer,
      typeId: "policy",
      urn: `urn:scp:${org.orgId}:policy:${name}`,
      name,
      properties: ORG_WIDE_POLICY_PROPERTIES
    });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.body).toMatch(/federation:write/);
    expect(await policyRowsByName(name)).toHaveLength(0);
  });

  it("DOOR 5: federation:write is not governance authority — a policy hand-fill still needs policy:write", async () => {
    // The door the census found open, with nobody at it. See docs/governance.md §168.
    const federationOnly = await createFederationOnlyUser();
    for (const typeId of GOVERNANCE_MANAGED_OBJECT_TYPE_IDS) {
      const name = `handfill-${typeId}-${randomUUID().slice(0, 8)}`;
      const res = await post("/api/v1/federation/hand-fill", federationOnly.token, {
        peer: handFillPeer,
        typeId,
        urn: `urn:scp:${org.orgId}:${typeId}:${name}`,
        name,
        properties: ORG_WIDE_POLICY_PROPERTIES
      });
      expect(res.statusCode, `${typeId}: ${res.body}`).toBe(403);
      // THE SPECIFIC VIOLATION, PER TYPE. See docs/governance.md §169.
      expect(res.body).toMatch(
        PROJECTION_BOUND_OBJECT_TYPE_IDS.has(typeId) ? /projection-backed/ : /policy:write/
      );
      expect(await governanceRowsByName(typeId, name)).toHaveLength(0);
    }
  });

  it("DOOR 5 (control): an Administrator's policy hand-fill still lands the row", async () => {
    // Without this, refusing that type outright would satisfy. See docs/governance.md §170.
    const name = `handfill-authorized-${randomUUID().slice(0, 8)}`;
    const res = await post("/api/v1/federation/hand-fill", org.adminToken, {
      peer: handFillPeer,
      typeId: "policy",
      urn: `urn:scp:${org.orgId}:policy:${name}`,
      name,
      properties: ORG_WIDE_POLICY_PROPERTIES
    });
    expect(res.statusCode, res.body).toBe(201);
    expect((res.json() as { provenance?: string }).provenance).toBe("manual");
    expect(await policyRowsByName(name)).toHaveLength(1);
  });

  // THE PROPERTY, ASSERTED ACROSS EVERY DOOR AT ONCE. See docs/governance.md §171.

  interface Door {
    door: string;
    run: (typeId: string, name: string) => Promise<{ statusCode: number; body: string }>;
  }

  /** Every door whose type comes from the request. See docs/governance.md §172. */
  function doorsFor(token: string, handFillActorToken: string = token): Door[] {
    /** The payload must be well-formed for the type. See docs/governance.md §173. */
    const propertiesFor = (typeId: string): Record<string, unknown> =>
      typeId === "freeze"
        ? {
            // The five constitutive fields drizzle/0089 marks `required`, in the exact shapes
            // `governance/freeze-object.ts` writes them — `freezeId` and `scopeObjectId` as real
            // UUIDs (they become `uuid` columns at every receiving instance), the window as ISO
            // instants, ordered.
            freezeId: randomUUID(),
            scopeObjectId: org.orgId,
            name: "smuggled freeze",
            startsAt: new Date(Date.now() - 60_000).toISOString(),
            endsAt: new Date(Date.now() + 86_400_000).toISOString(),
            reason: "minted through a door that is not POST /api/v1/freezes",
            atomic: true
          }
        : ORG_WIDE_POLICY_PROPERTIES;
    return [
      {
        door: "POST /api/v1/federation/overlays",
        run: async (typeId, name) =>
          post("/api/v1/federation/overlays", token, {
            base: await createBaseService(),
            typeId,
            name,
            properties: propertiesFor(typeId)
          })
      },
      {
        door: "POST /api/v1/objects/{type}",
        run: (typeId, name) =>
          post(`/api/v1/objects/${typeId}`, token, {
            name,
            properties: propertiesFor(typeId)
          })
      },
      {
        door: "POST /api/v1/plans + /apply",
        run: async (typeId, name) => {
          const stackName = `gov-prop-${randomUUID().slice(0, 8)}`;
          const plan = await post("/api/v1/plans", token, {
            manifest: {
              stackName,
              objects: [
                {
                  urn: `urn:scp:${stackName}:${typeId}:smuggled`,
                  typeId,
                  name,
                  properties: propertiesFor(typeId)
                }
              ],
              relationships: []
            }
          });
          expect(plan.statusCode, plan.body).toBe(201);
          return post(`/api/v1/plans/${(plan.json() as { id: string }).id}/apply`, token, {});
        }
      },
      {
        door: "POST /api/v1/federation/hand-fill",
        run: (typeId, name) =>
          // A REAL peer: with a nonexistent one this door's `stored it anyway` check below is
          // unfalsifiable, because the write is unreachable whatever the guard does.
          post("/api/v1/federation/hand-fill", handFillActorToken, {
            peer: handFillPeer,
            typeId,
            urn: `urn:scp:${org.orgId}:${typeId}:${name}`,
            name,
            properties: propertiesFor(typeId)
          })
      }
    ];
  }

  it("PROPERTY: no door with a caller-supplied typeId writes a governance object without policy:write", async () => {
    const federationOnly = await createFederationOnlyUser();
    const doors = doorsFor(operator.token, federationOnly.token);

    for (const { door, run } of doors) {
      for (const typeId of GOVERNANCE_MANAGED_OBJECT_TYPE_IDS) {
        const name = `prop-${randomUUID().slice(0, 8)}`;
        const res = await run(typeId, name);
        expect(res.statusCode, `${door} accepted a '${typeId}': ${res.body}`).toBe(403);
        expect(
          await governanceRowsByName(typeId, name),
          `${door} refused a '${typeId}' and stored it anyway`
        ).toHaveLength(0);
      }
    }
  });

  // THE SECOND PROPERTY. See docs/governance.md §174.

  it("PROPERTY (per type): a projection-bound type is REFUSED at every caller-supplied-typeId door, even for an actor holding every permission those doors ask for", async () => {
    const governanceNoFreeze = await createGovernanceNoFreezeUser();
    // A GUARD ON THIS GUARD, like LAYER 0 below: a loop over an empty set passes vacuously.
    expect(
      [...PROJECTION_BOUND_OBJECT_TYPE_IDS].length,
      "PROJECTION_BOUND_OBJECT_TYPE_IDS is empty — this whole case would pass by looping zero times"
    ).toBeGreaterThanOrEqual(1);
    expect([...PROJECTION_BOUND_OBJECT_TYPE_IDS]).toContain("freeze");

    for (const { door, run } of doorsFor(governanceNoFreeze.token)) {
      for (const typeId of PROJECTION_BOUND_OBJECT_TYPE_IDS) {
        const name = `projbound-${randomUUID().slice(0, 8)}`;
        const res = await run(typeId, name);
        expect(
          res.statusCode,
          `${door} accepted a '${typeId}' from an actor with no '${typeId}:write': ${res.body}`
        ).toBe(403);
        expect(
          await governanceRowsByName(typeId, name),
          `${door} refused a '${typeId}' and stored it anyway`
        ).toHaveLength(0);
      }
    }
  });

  it("PROPERTY (per type, control): the SAME actor IS admitted for a type whose bar really is policy:write — so the refusal above is about the TYPE, not the actor", async () => {
    // Without this, an actor who can do nothing would satisfy. See docs/governance.md §175.
    const governanceNoFreeze = await createGovernanceNoFreezeUser();

    const basePolicy = await post("/api/v1/policies", org.adminToken, {
      name: `gov-doors-perbar-base-${randomUUID().slice(0, 8)}`,
      properties: { enforcement: "advisory" }
    });
    expect(basePolicy.statusCode, basePolicy.body).toBe(201);
    const overlayName = `perbar-overlay-${randomUUID().slice(0, 8)}`;
    const overlay = await post("/api/v1/federation/overlays", governanceNoFreeze.token, {
      base: (basePolicy.json() as { id: string }).id,
      typeId: "policy",
      name: overlayName,
      properties: { enforcement: "required" }
    });
    expect(overlay.statusCode, `overlay: ${overlay.body}`).toBe(201);
    expect(await policyRowsByName(overlayName)).toHaveLength(1);

    const handFillName = `perbar-handfill-${randomUUID().slice(0, 8)}`;
    const handFill = await post("/api/v1/federation/hand-fill", governanceNoFreeze.token, {
      peer: handFillPeer,
      typeId: "policy",
      urn: `urn:scp:${org.orgId}:policy:${handFillName}`,
      name: handFillName,
      properties: ORG_WIDE_POLICY_PROPERTIES
    });
    expect(handFill.statusCode, `hand-fill: ${handFill.body}`).toBe(201);
    expect(await policyRowsByName(handFillName)).toHaveLength(1);
  });
});

/** THE COMPLETENESS HALF OF THE CENSUS. See docs/governance.md §176. */
describe("policy:write door census: the CENSUS is complete (source scan, no DB)", () => {
  /** LAYER 0 — A GUARD ON THE GUARD. See docs/governance.md §177. */
  it("LAYER 0: the governance-managed set is non-empty and still holds the four known types", () => {
    const typeIds = [...GOVERNANCE_MANAGED_OBJECT_TYPE_IDS];
    expect(typeIds.length).toBeGreaterThanOrEqual(4);
    // The freeze object is the wire form, by owner decision. See docs/governance.md §178.
    expect(typeIds).toEqual(
      expect.arrayContaining(["policy", "control", "scan_override_grant", "freeze"])
    );
  });

  /** LAYER 1's reviewed table. See docs/governance.md §179. */
  const REVIEWED_OBJECTS_REPO_EXPORTS: Record<string, "WRITE" | "read-only"> = {
    // The four write doors of the choke point. All four touch the `objects` table directly, which
    // the test re-derives from the source rather than believing this table.
    createObject: "WRITE",
    updateObject: "WRITE",
    upsertObjectByUrn: "WRITE",
    deleteObject: "WRITE",
    // Readers and pure helpers — none of them can produce or amend a row.
    canonicalJson: "read-only",
    findObjectByIdOrUrnAnyType: "read-only",
    getObjectByIdOrUrn: "read-only",
    getObjectByIdOrUrnAnyType: "read-only",
    getOrgRootObjectId: "read-only",
    isUuid: "read-only",
    journalEntryKindFor: "read-only",
    listObjects: "read-only",
    resolveContainmentParent: "read-only",
    resolveDomainId: "read-only",
    toGraphObject: "read-only"
  };

  /** LAYER 2's reviewed table: file → why a write to the `objects` table there cannot mint a type. */
  const REVIEWED_OBJECT_TABLE_WRITERS: Record<string, string> = {
    "graph/objects-repo.ts": "the choke point itself — layers 1 and 3 are about exactly this file",
    // Sets `updated_at` on one existing campaign row for round-robin fairness. No insert, no
    // `type_id` in the `set`, and the row is selected by id.
    "coordination/campaign-reconcile.ts": "updatedAt bump on an existing row",
    // Clears `domain_local` / `domain_local_inherited_from` on one existing row (M20.7). Same shape.
    "federation/publish-domain-local.ts": "clears the domain-local columns on an existing row",
    // Sets `managed_by_stack` on rows an IaC apply DECLARES. See docs/governance.md §180.
    "iac/stack-ownership.ts":
      "sets managed_by_stack on already-resolved ids; no insert, no type_id",
    // A verified shared entry converges rather than refusing. See docs/governance.md §181.
    "graph/artifacts-repo.ts":
      "D2a adoption: origin/revision/properties onto one urn-locked artifact row; no insert, no type_id",
    // Raw SQL, and the ONE instance of that class in the tree — listed rather than filtered out
    // precisely because a raw statement is what layers 1 and 3 are structurally blind to. It is a
    // developer load-generator (not wired into any route or worker) and its `type_id` is the SQL
    // literal `'service'`, so no caller chooses it.
    "load-test/graph-scale.ts": "raw bulk INSERT in the load generator, type_id literal 'service'"
  };

  /** LAYER 3's reviewed table. See docs/governance.md §182. */
  const REVIEWED_RUNTIME_TYPEID_WRITE_SITES: Record<string, string[]> = {
    // ---- THE FOUR DOORS: `typeId` comes from the request body or path. -----------------------
    // DOOR 1 — `policy:write` at the org root (M21.7).
    "federation/overlay-repo.ts": ["input.overlayTypeId ×1"],
    // That second door is gone, removed by the increment. See docs/governance.md §183.
    "routes/objects-generic.ts": ["type ×4"],
    // DOOR 4 — `writePermissionFor` demands `policy:write` for every non-`noop` action, plus the
    // declared-scope binding on create/update. `entry.typeId` is the apply-DELETE branch;
    // `target.typeId` is the create and the update.
    "iac/plans-repo.ts": ["entry.typeId ×1", "target.typeId ×2"],
    // DOOR 5 — `policy:write` at the org root (M21.7).
    "federation/handfill-repo.ts": ["input.typeId ×1"],

    // ---- NOT DOORS. See docs/governance.md §184.
    "routes/typed-registries.ts": ["typeId ×4"],
    // The `OUTPOST_OBJECT_TYPE_ID` constant — a literal behind a name — at the create, the delete
    // and both updates.
    "federation/outposts-repo.ts": ["OUTPOST_OBJECT_TYPE_ID ×4"],
    // Journal replay. `typeId` comes from a signature- and chain-verified bundle, not a caller, and
    // `existing.typeId` is re-read from the row being updated. Deliberately exempt from local write
    // guards: `object_upsert` has no try/catch, so one refusal aborts a whole signed bundle
    // (ADR-0032 §6a). A hostile peer is a PAIRING problem, not a permission one.
    "federation/import-repo.ts": ["existing.typeId ×1", "typeId ×2"],
    // The choke point's own internal delegation. See docs/governance.md §185.
    "graph/objects-repo.ts": ["input.typeId ×2"],
    // M22.6's typed grant routes. See docs/governance.md §186.
    "routes/scan-override-grants.ts": ["SCAN_OVERRIDE_GRANT_TYPE_ID ×2"],
    // M25.7's freeze wire form. See docs/governance.md §187.
    "governance/freeze-object.ts": ["FREEZE_OBJECT_TYPE_ID ×2"]
  };

  /** `graph/objects-repo.ts` relative to the scan root — the anchor all three layers share. */
  const CHOKE_POINT = "graph/objects-repo.ts";

  /** The real tree, as `scanRuntimeTypeIdWriteSites` also takes it from the self-test's fixtures. */
  let sources: ScannedSource[];

  beforeAll(async () => {
    const { readdir, readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const nodePath = await import("node:path");
    const srcRoot = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), "..");

    const files: string[] = [];
    async function walk(dir: string): Promise<void> {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = nodePath.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name === "dist") continue;
          // `test-support` mints fixtures, not doors; `.test.ts` is not shipped code.
          if (entry.name === "test-support") continue;
          await walk(full);
        } else if (entry.name.endsWith(".ts") && !entry.name.includes(".test.")) {
          files.push(full);
        }
      }
    }
    await walk(srcRoot);
    sources = await Promise.all(
      files.map(async (file) => ({
        rel: nodePath.relative(srcRoot, file),
        lines: (await readFile(file, "utf8")).split("\n")
      }))
    );
  });

  /** A comment line is not code; every layer skips them so prose cannot trip or silence a scan. */
  const isComment = (line: string) => {
    const t = line.trimStart();
    return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*");
  };

  /** One source file as a scan sees it: path relative to the scan root, and its lines. */
  type ScannedSource = { rel: string; lines: string[] };

  /** What LAYER 3 reports for a matched call whose `typeId` argument it could not resolve. */
  const NO_TYPEID = "<no typeId found>";

  /** How far past a call's first line the walker will look for the end of its argument list. */
  const CALL_WALK_LIMIT = 40;

  /** Resolves the type argument of the write call there. See docs/governance.md §188. */
  function resolveTypeIdArgument(lines: string[], i: number, from: number): string {
    let depth = 0;
    let opened = false;
    /** Non-null once the `typeId:` key is found: the value being accumulated. */
    let value: string | null = null;
    let valueDepth = 0;
    for (let j = i; j < Math.min(i + CALL_WALK_LIMIT, lines.length); j += 1) {
      const line = lines[j]!;
      if (value !== null && j > i) value += " ";
      let k = j === i ? from : 0;
      while (k < line.length) {
        const ch = line[k]!;
        if (ch === "/" && line[k + 1] === "/") break;
        if (ch === '"' || ch === "'" || ch === "`") {
          // A quoted string is opaque: brackets and `//` inside it are text, not structure.
          const start = k;
          k += 1;
          while (k < line.length && line[k] !== ch) k += line[k] === "\\" ? 2 : 1;
          k += 1;
          if (value !== null) value += line.slice(start, k);
          continue;
        }
        const opens = ch === "(" || ch === "{" || ch === "[";
        const closes = ch === ")" || ch === "}" || ch === "]";
        if (value !== null) {
          // Reading the value: it ends at the `,` or `}` that is at ITS OWN depth, so
          // `typeId: pickType(a, b),` is one expression rather than two.
          if (opens) valueDepth += 1;
          else if (closes) {
            if (valueDepth === 0) return value.trim();
            valueDepth -= 1;
          } else if (ch === "," && valueDepth === 0) return value.trim();
          value += ch;
          k += 1;
          continue;
        }
        if (opens) {
          depth += 1;
          opened = true;
          k += 1;
          continue;
        }
        if (closes) {
          depth -= 1;
          k += 1;
          if (opened && depth <= 0) return NO_TYPEID; // the call closed and never named a type
          continue;
        }
        if (
          depth === 2 &&
          line.startsWith("typeId", k) &&
          !/[A-Za-z0-9_$]/.test(line[k - 1] ?? " ")
        ) {
          const after = line.slice(k + "typeId".length);
          const key = /^\s*:/.exec(after);
          if (key) {
            value = "";
            valueDepth = 0;
            k += "typeId".length + key[0].length;
            continue;
          }
          // `{ …, typeId, … }` — the shorthand, including as the last property of a line.
          if (/^\s*[,}]/.test(after) || after.trim() === "") return "typeId";
        }
        k += 1;
      }
    }
    return NO_TYPEID;
  }

  /** The third layer's measurement, extracted for reuse. See docs/governance.md §189. */
  function scanRuntimeTypeIdWriteSites(
    scanned: ScannedSource[],
    writeNames: string[]
  ): Record<string, string[]> {
    const writeCall = new RegExp(String.raw`\b(?:${writeNames.join("|")})\s*\(`);
    // A function's own DECLARATION is not a call site; without this the walker reads the parameter
    // list and reports noise like `string;` as a `typeId` expression.
    const writeDeclaration = new RegExp(
      String.raw`^\s*(?:export\s+)?(?:async\s+)?function\s+(?:${writeNames.join("|")})\s*\(`
    );
    const perFile = new Map<string, Map<string, number>>();
    for (const { rel, lines } of scanned) {
      for (let i = 0; i < lines.length; i += 1) {
        if (isComment(lines[i]!)) continue;
        if (writeDeclaration.test(lines[i]!)) continue;
        const call = writeCall.exec(lines[i]!);
        if (!call) continue;
        const expr = resolveTypeIdArgument(lines, i, call.index);
        if (/^"[a-z0-9-]+"$/.test(expr)) continue; // a literal type cannot be chosen by a caller
        const counts = perFile.get(rel) ?? new Map<string, number>();
        counts.set(expr, (counts.get(expr) ?? 0) + 1);
        perFile.set(rel, counts);
      }
    }
    return Object.fromEntries(
      [...perFile.entries()]
        .map(([rel, counts]) => [
          rel,
          [...counts.entries()].map(([expr, n]) => `${expr} ×${n}`).sort()
        ])
        .sort(([a], [b]) => (a as string).localeCompare(b as string))
    );
  }

  /**
   * LAYER 1's measurement, shared with layer 3: the choke point's exported callables, and which of
   * its top-level functions write the `objects` table directly.
   */
  function scanChokePoint(): { exported: Set<string>; directWriters: Set<string> } {
    const file = sources.find((s) => s.rel === CHOKE_POINT);
    expect(file, `${CHOKE_POINT} was not found by the scan — the anchor moved`).toBeDefined();
    const exported = new Set<string>();
    const directWriters = new Set<string>();
    let enclosing: string | null = null;
    for (const line of file!.lines) {
      const declared = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/.exec(line);
      if (declared) enclosing = declared[1]!;
      const exportedFn = /^export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/.exec(line);
      if (exportedFn) exported.add(exportedFn[1]!);
      const exportedConst = /^export\s+(?:const|let|var)\s+([A-Za-z0-9_$]+)\b/.exec(line);
      if (exportedConst) exported.add(exportedConst[1]!);
      // `export { canonicalJson };` — a re-export is an exported surface like any other.
      const reExport = /^export\s*\{([^}]*)\}/.exec(line);
      if (reExport) {
        for (const part of reExport[1]!.split(",")) {
          const name = part
            .trim()
            .split(/\s+as\s+/)
            .pop()
            ?.trim();
          if (name) exported.add(name);
        }
      }
      if (!isComment(line) && /\.(?:insert|update|delete)\(objects\)/.test(line) && enclosing) {
        directWriters.add(enclosing);
      }
    }
    return { exported, directWriters };
  }

  const sortedNames = (names: Iterable<string>) => [...names].sort();

  it("LAYER 1: the choke point's exported surface is the reviewed one, and every direct writer is classified WRITE", () => {
    const { exported, directWriters } = scanChokePoint();

    // A NEW export here means a new write surface at the choke point — the case the whole-file
    // exemption used to swallow. Classify it in `REVIEWED_OBJECTS_REPO_EXPORTS`: `WRITE` puts every
    // call site of it into LAYER 3's scan, `read-only` states that it cannot produce a row.
    expect(sortedNames(exported)).toEqual(sortedNames(Object.keys(REVIEWED_OBJECTS_REPO_EXPORTS)));

    // And the classification is measured, not trusted: anything that touches the `objects` table
    // itself must be a `WRITE`, so a direct writer cannot be filed away as a reader.
    const misfiled = sortedNames(directWriters).filter(
      (name) => REVIEWED_OBJECTS_REPO_EXPORTS[name] !== "WRITE"
    );
    expect(
      misfiled,
      "these functions write the `objects` table but are not classified WRITE"
    ).toEqual([]);
    expect(
      directWriters.size,
      "no function in the choke point writes the `objects` table — the derivation is measuring nothing"
    ).toBeGreaterThan(0);
  });

  it("LAYER 2: nothing outside the reviewed set writes the objects table at all", () => {
    // Both other layers are anchored on `graph/objects-repo.ts`. A module that went straight at the
    // table — drizzle builder or raw SQL — would be outside both, so it is enumerated here.
    const tableWrite =
      /\.(?:insert|update|delete)\(objects\)|\b(?:insert\s+into|update|delete\s+from)\s+objects\b/i;
    const writers = new Set<string>();
    for (const { rel, lines } of sources) {
      for (const line of lines) {
        if (isComment(line)) continue;
        if (tableWrite.test(line)) writers.add(rel);
      }
    }
    expect(sortedNames(writers)).toEqual(sortedNames(Object.keys(REVIEWED_OBJECT_TABLE_WRITERS)));
  });

  it("LAYER 3: every runtime-valued typeId write site is one the census accounted for", () => {
    expect(
      sources.length,
      "the scan found no source files — it is not scanning anything"
    ).toBeGreaterThan(100);

    const { exported, directWriters } = scanChokePoint();
    // THE PATTERN IS DERIVED, NOT HARDCODED. Three names used to be spelled here, which is why
    // `deleteObject` was missing for as long as it was. The write surface comes from LAYER 1's
    // reviewed classification, unioned with anything measured to write the table — so even if the
    // classification were wrong, a direct writer still pulls its call sites into this scan.
    const writeNames = sortedNames(
      new Set([
        ...Object.entries(REVIEWED_OBJECTS_REPO_EXPORTS)
          .filter(([name, kind]) => kind === "WRITE" && exported.has(name))
          .map(([name]) => name),
        ...directWriters
      ])
    );
    expect(
      writeNames,
      "the derived write surface is empty — this scan would match nothing"
    ).not.toEqual([]);
    const normalize = (table: Record<string, string[]>) =>
      Object.fromEntries(
        Object.entries(table)
          .map(([f, s]) => [f, sortedNames(s)] as const)
          .sort(([a], [b]) => a.localeCompare(b))
      );
    // A NEW entry — a new file, a new expression, or a HIGHER `×N` on one already listed — means a
    // new write door whose type a caller may choose. Do not append it to the table: run the
    // governance question against it first (`isGovernanceManagedObjectType`: refuse the type, or
    // demand `policy:write`), then record the answer above.
    expect(normalize(scanRuntimeTypeIdWriteSites(sources, writeNames))).toEqual(
      normalize(REVIEWED_RUNTIME_TYPEID_WRITE_SITES)
    );
  });

  it("LAYER 3 (self-test): the walker sees each spelling of a write, and says so when it cannot", () => {
    // THE LAYER THAT WATCHES LAYER 3. See docs/governance.md §190.
    const src = (rel: string, lines: string[]): ScannedSource => ({ rel, lines });
    const fixtures: ScannedSource[] = [
      // The ordinary spelling, and the one every real door in the tree uses today.
      src("multi-line.ts", [
        "  const created = await createObject(tx, {",
        "    orgId: input.orgId,",
        "    typeId: input.typeId,",
        "    name: input.name",
        "  });"
      ]),
      // THE MUTATION THAT PROVED THE OLD CLAIM FALSE: the whole call on the call line. The old
      // walker started at the NEXT line and never looked here.
      src("same-line.ts", [
        "  await deleteObject(tx, { ...base, typeId: input.typeId, idOrUrn });"
      ]),
      src("same-line-shorthand.ts", ["  await createObject(tx, { orgId, typeId, name });"]),
      // A nested object's `typeId` is not the call's. The old walker took whichever came first.
      src("nested-literal-first.ts", [
        "  await createObject(tx, {",
        '    properties: mapProperties({ typeId: "service" }),',
        "    typeId: input.typeId,",
        "    name",
        "  });"
      ]),
      // The value is an expression containing a comma — one expression, not two.
      src("call-expression-value.ts", [
        "  await createObject(tx, {",
        "    typeId: pickType(input.a, input.b),",
        "    name",
        "  });"
      ]),
      // TWO sites, one expression: the `Set<string>` this replaced reported a single entry.
      src("two-sites.ts", [
        "  await createObject(tx, { orgId, typeId: input.typeId, name });",
        "  await createObject(tx, {",
        "    orgId,",
        "    typeId: input.typeId,",
        "    name",
        "  });"
      ]),
      // Not doors: a literal type, and a call that is only prose.
      src("literal.ts", [
        "  await createObject(tx, {",
        '    typeId: "component",',
        "    name",
        "  });"
      ]),
      src("commented-out.ts", ["  // await createObject(tx, { typeId: input.typeId });"]),
      // UNRESOLVED, both flavours: the argument object is built elsewhere, or spread in. Neither is
      // silently dropped — both report `NO_TYPEID`, which is in no reviewed table.
      src("built-elsewhere.ts", ["  await createObject(tx, buildInput(request));"]),
      src("spread-only.ts", ["  await createObject(tx, { ...buildInput(request) });"]),
      // KNOWN LIMIT: the write surface is matched BY NAME, so a rename at the import hides the call
      // from the scan entirely. LAYER 1 is the partial backstop — a new write surface at the choke
      // point fails there whatever its call sites look like — but a rename of an EXISTING one does
      // not, and this is where that hole is written down.
      src("aliased-import.ts", [
        "  import { createObject as mintObject } from '../graph/objects-repo.js';",
        "  await mintObject(tx, { orgId, typeId: input.typeId });"
      ])
    ];

    expect(scanRuntimeTypeIdWriteSites(fixtures, ["createObject", "deleteObject"])).toEqual({
      "multi-line.ts": ["input.typeId ×1"],
      "same-line.ts": ["input.typeId ×1"],
      "same-line-shorthand.ts": ["typeId ×1"],
      "nested-literal-first.ts": ["input.typeId ×1"],
      "call-expression-value.ts": ["pickType(input.a, input.b) ×1"],
      "two-sites.ts": ["input.typeId ×2"],
      "built-elsewhere.ts": [`${NO_TYPEID} ×1`],
      "spread-only.ts": [`${NO_TYPEID} ×1`]
      // `literal.ts`, `commented-out.ts` — correctly absent, no caller chooses those types.
      // `aliased-import.ts` — absent, and that one is the KNOWN LIMIT above, not a pass.
    });

    // AND THE OTHER HALF OF "fails loudly": reporting `NO_TYPEID` only fails LAYER 3 for as long as
    // no reviewed table has learned to accept it. The day someone silences an unresolvable site by
    // pasting it into the table instead of spelling the call so it can be read, this says so.
    expect(
      Object.entries(REVIEWED_RUNTIME_TYPEID_WRITE_SITES)
        .flatMap(([file, entries]) => entries.map((entry) => `${file}: ${entry}`))
        .filter((entry) => entry.includes(NO_TYPEID)),
      "an unresolvable write site was reviewed as acceptable — unresolvable no longer fails LAYER 3"
    ).toEqual([]);
  });
});
