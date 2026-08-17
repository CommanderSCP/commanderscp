import { randomUUID, generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { ScpClient } from "@scp/sdk";
import type { DesiredStateManifest } from "@scp/schemas";
import {
  createTestOrg,
  createTestUser,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg,
  type TestUser
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { objects } from "../db/schema.js";
import { upsertObjectByUrn } from "../graph/objects-repo.js";
import { handFillObject } from "../federation/handfill-repo.js";
import { pairPeer } from "../federation/peers-repo.js";
import { initFederationSelf } from "../federation/self-repo.js";
import { asTrustDomainId } from "@scp/schemas";
import { matchPoliciesForTargets } from "./policy-resolve.js";
import { GOVERNANCE_LABEL_PREFIX } from "./governance-labels.js";

/**
 * ================================================================================================
 * THE RESERVED GOVERNANCE LABEL NAMESPACE — INSTALLED, AT EVERY DOOR, AGAINST THE REAL ESCAPE
 * ================================================================================================
 *
 * ## What was broken
 *
 * `governance/policy-resolve.ts`'s `scope.selector.labels` branch matched a policy against
 * `objects.labels` on the target's containment chain. Authoring that policy required `policy:write`
 * AT THE ORG ROOT (`policy-scope-authz.ts`, "precisely because a selector has org-wide blast
 * radius"). Writing the labels it matched on required plain `object:write` at the object — the
 * subject's own owner — against no schema and no reserved namespace. The subject of a constraint
 * could therefore step out of its reach by deleting one map entry, and nothing anywhere said so.
 *
 * ## Why this file is HTTP-level and its unit sibling is not enough
 *
 * `governance-labels.test.ts` proves the guard DECIDES correctly. It cannot prove the guard RUNS.
 * This project's dominant defect is a component that is built, unit-tested green and never
 * installed (CLAUDE.md), and a suite that reaches the guard directly is exactly the shape that
 * cannot tell the two apart. So every case below drives a REAL DOOR — an HTTP request, an IaC
 * apply, a repo function a route calls — and the guard is reached only if it is actually wired in.
 *
 * MUTATION LOG — MEASURED, not predicted. Each was applied ALONE against a green suite, the run
 * recorded, then reverted. Every entry below is the actual failure set.
 *
 *   1. delete `assertMayWriteGovernanceLabels` from `createObject`  → B1, B2, B3, B5, B8
 *   2. delete it from `updateObject`                                → A3, A4, A5
 *   3. delete it from `createRelationship`                          → B6
 *   4. delete it from `handFillObject`                              → B7
 *   5. delete `assertSelectorKeysAreGovernanceLabels` from `createObject` → C1, C3, C5
 *   6. delete it from `updateObject`                                → C2
 *   7. delete `assertSyncScopeSelectorKeys…` from `pairPeer`        → D1
 *   8. delete it from `updatePeerTransport`                         → D2
 *   9. compute the delta over `after`'s keys only (lose REMOVAL)    → A4, A5
 *  10. `isGovernanceLabelKey` returns `true` for every key          → A2, B0, B4, C1, C2, C3, C4, C5, D1, D2
 *  11. delete `assertSelectorKeysAreGovernanceLabels` from `handFillObject` → C4
 *
 * A PART F WAS HERE, AND IT WAS REMOVED BECAUSE ITS MUTATIONS STOPPED KILLING ANYTHING.
 * It added `assertPolicyScopeWithinAuthority` to `createOverlay` and `handFillObject` on the reading
 * that the check's census had missed those two doors, and claimed mutations 9/10 (delete each call
 * site → F1/F2 die). Re-measured after #244 merged, on this tree:
 *   - F2 FAILED outright — `assertGovernanceAuthorityForHandFill` throws FIRST, with a different
 *     message, so the case was asserting a refusal that no longer came from the guard it named.
 *   - F1 PASSED WITH THE CALL SITE DELETED. The refusal was #244's governance-managed org-root
 *     `policy:write` bar all along; F1's assertion (`/policy:write/`) matched either message.
 * #244 closed both doors independently and more strongly, so the added calls could no longer refuse
 * anything — see `federation/overlay-repo.ts` and `federation/handfill-repo.ts` for the argument.
 * The doors' real coverage is `governance-managed-write-doors.integration.test.ts` DOOR 1 and DOOR 5.
 *
 * THREE OF THESE ARE THE POINT, not bookkeeping:
 *   - #5 does NOT kill C4 and #11 does — which is the measured proof that hand-fill runs the
 *     selector refusal FOR ITSELF rather than inheriting the choke point it is exempt from. The
 *     same separation holds for #1 vs #4.
 *   - #9 kills A4 and A5 and nothing else: the removal case is the whole defect, and a delta
 *     written the obvious way (over `after`'s keys) leaves it wide open with 23 of 25 still green.
 *   - #10 kills the CONTROLS (A2, B0, B4). An over-broad namespace refuses ordinary estate
 *     description, which is the failure mode option (b) in the proposal was rejected for.
 *
 * A5's failure under #2 and #11 is a genuine cascade, not a flake: A4's refusal is what leaves the
 * governance label on the row for A5 to still be governed by. That coupling is deliberate — A5
 * asserts REACH, not a status code.
 *
 * ## The actor
 *
 * `operator` is the built-in **Operator** role at the org root: `drizzle/0002` gives it
 * `object:write` + `relationship:write`, and `drizzle/0010` grants `policy:write` to
 * Administrator/Owner ONLY. It is precisely the "component's own owner" of the report. CASE B0 is
 * the control that earns every 403 below — without it this whole file passes just as well against a
 * token holding no permissions at all.
 */
describe("governance labels: the namespace is enforced at every local write door (Testcontainers)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;
  let operator: TestUser;
  let operatorClient: ScpClient;
  /** The governed service — labelled by the admin, selected by the policy, owned by the operator. */
  let serviceId: string;
  let serviceUrn: string;
  let componentId: string;

  const GOV_TIER = `${GOVERNANCE_LABEL_PREFIX}tier`;

  /**
   * The refusal's `detail`, from an SDK call OR a direct repo call.
   *
   * A `ScpApiError`'s `message` and a `ProblemError`'s `message` are both only the RFC 9457 TITLE
   * ("Bad Request", "Forbidden"), so `.rejects.toThrow(/…/)` against the message would pass for any
   * refusal the server could ever produce — the "green for the wrong reason" shape this repo has
   * paid for repeatedly. Every assertion below reads the detail instead.
   */
  async function refusalDetail(call: Promise<unknown>): Promise<string> {
    return call.then(
      () => {
        throw new Error("expected the call to be refused, but it succeeded");
      },
      (err: unknown) => {
        const problem = (err as { problem?: { detail?: string }; detail?: string }).problem;
        return problem?.detail ?? (err as { detail?: string }).detail ?? "";
      }
    );
  }

  async function asOperator(method: "POST" | "PUT", url: string, payload: Record<string, unknown>) {
    return server.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${operator.token}` },
      payload
    });
  }

  async function labelsOf(id: string): Promise<Record<string, unknown>> {
    const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select({ labels: objects.labels }).from(objects).where(eq(objects.id, id))
    );
    return (rows[0]?.labels ?? {}) as Record<string, unknown>;
  }

  async function liveRowsByUrn(typeId: string, urn: string) {
    return withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select({ id: objects.id, labels: objects.labels })
        .from(objects)
        .where(
          and(
            eq(objects.orgId, org.orgId),
            eq(objects.typeId, typeId),
            eq(objects.urn, urn),
            isNull(objects.deletedAt)
          )
        )
    );
  }

  /** Does ANY policy still reach this object, via the label selector? The function the defect is
   *  in, asked the question the defect is about — never a proxy for it. */
  async function selectorPoliciesReaching(targetId: string): Promise<string[]> {
    const matched = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      matchPoliciesForTargets(tx, {
        orgId: org.orgId,
        targetObjectIds: [targetId],
        actorObjectId: org.orgId
      })
    );
    return matched.filter((m) => m.matchedAt.via === "selector").map((m) => m.name);
  }

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "gov-labels");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    operator = await createTestUser(server, org, [{ role: "Operator", scope: org.orgId }]);
    operatorClient = new ScpClient({ baseUrl: server.baseUrl, token: operator.token });

    const service = await admin.services.create({ name: `svc-${randomUUID().slice(0, 8)}` });
    serviceId = service.id;
    serviceUrn = service.urn;
    const component = await admin.components.create({
      name: `cmp-${randomUUID().slice(0, 8)}`,
      service: service.id
    });
    componentId = component.id;

    // Hand-fill needs a paired peer, and pairing needs this instance's own federation identity.
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      initFederationSelf(tx, {
        orgId: org.orgId,
        name: `gov-labels-${randomUUID().slice(0, 8)}`,
        role: "outpost"
      })
    );
  }, 240_000);

  afterAll(async () => {
    await server?.close();
  });

  // ---------------------------------------------------------------------------------------------
  // PART A — THE REPORTED ESCAPE, END TO END. Everything else in this file is mechanism; this is
  // the property.
  // ---------------------------------------------------------------------------------------------

  it("CASE A1: an operator-set governance label + a selector-scoped policy really does govern the component", async () => {
    // SecOps labels the SERVICE (not each component) — `labelsMatch` runs over the whole containment
    // chain, which is what keeps org-root authority from meaning a per-component labelling chore.
    await admin.object("service").update(serviceId, { labels: { [GOV_TIER]: "pci" } });
    await admin.policies.create({
      name: "pci-approvals",
      properties: {
        scope: { selector: { labels: { [GOV_TIER]: "pci" } } },
        enforcement: "required",
        effects: [{ requireApprovals: { count: 2, fromRole: "Approver", scope: "organization" } }]
      }
    });

    // The premise of the whole file: governance reach is REAL before anyone tries to escape it. If
    // this ever goes red, every 403 below is guarding nothing.
    expect(await selectorPoliciesReaching(componentId)).toContain("pci-approvals");
  });

  it("CASE A2: the operator CAN still describe their own estate — ordinary labels are untouched", async () => {
    // The control that stops this file from passing because labels became read-only for everyone,
    // which would "fix" the evasion by breaking the product.
    const res = await asOperator(
      "PUT",
      `/api/v1/objects/service/${encodeURIComponent(serviceUrn)}`,
      {
        name: (await admin.object("service").get(serviceId)).name,
        labels: { [GOV_TIER]: "pci", team: "payments", env: "prod" }
      }
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(await labelsOf(serviceId)).toMatchObject({ team: "payments", env: "prod" });
  });

  it("CASE A3: the operator cannot CHANGE the governance label's value", async () => {
    const res = await asOperator(
      "PUT",
      `/api/v1/objects/service/${encodeURIComponent(serviceUrn)}`,
      {
        name: (await admin.object("service").get(serviceId)).name,
        labels: { [GOV_TIER]: "public", team: "payments" }
      }
    );
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain(GOV_TIER);
    expect(await labelsOf(serviceId)).toMatchObject({ [GOV_TIER]: "pci" });
  });

  it("CASE A4: THE ESCAPE — omitting the label from a full-replacement write is refused, and the policy still reaches", async () => {
    // This is the report, exactly: a full-replacement write that simply does not mention the key.
    // No API called `deleteLabel`; the attack is an omission, which is why the guard compares
    // against the STORED row rather than inspecting the request.
    const res = await asOperator(
      "PUT",
      `/api/v1/objects/service/${encodeURIComponent(serviceUrn)}`,
      {
        name: (await admin.object("service").get(serviceId)).name,
        labels: { team: "payments" }
      }
    );
    expect(res.statusCode).toBe(403);

    // A refusal that still wrote the row is not a refusal — and the only assertion that matters is
    // the one about GOVERNANCE REACH, not about the row.
    expect(await labelsOf(serviceId)).toMatchObject({ [GOV_TIER]: "pci" });
    expect(await selectorPoliciesReaching(componentId)).toContain("pci-approvals");
  });

  it("CASE A5: the operator cannot escape by re-labelling the COMPONENT either — the chain is the reach", async () => {
    // The selector matches at every ancestor. A component owner clearing their own labels does not
    // reach the service's assertion, so this must fail for the ORDINARY reason (nothing to remove)
    // rather than accidentally succeeding at removing the wrong thing.
    // Through the STRICT typed route: `/objects/component` refuses service-member types outright
    // (`graph/service-member-types.ts`), so using it here would pass for the wrong reason.
    const component = await admin.object("component").get(componentId);
    const res = await asOperator("PUT", `/api/v1/components/${encodeURIComponent(component.urn)}`, {
      name: component.name,
      service: serviceUrn,
      labels: {}
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(await selectorPoliciesReaching(componentId)).toContain("pci-approvals");
  });

  it("CASE A6: an org-root policy:write holder CAN set and clear governance labels — the bar is authority, not immutability", async () => {
    const svc = await admin
      .object("service")
      .create({ name: `svc-adm-${randomUUID().slice(0, 8)}` });
    await admin.object("service").update(svc.id, { labels: { [GOV_TIER]: "pci" } });
    expect(await labelsOf(svc.id)).toMatchObject({ [GOV_TIER]: "pci" });
    // ...and REMOVE it. Without this, the guard could be "governance labels are write-once" and
    // every other case here would still pass.
    await admin.object("service").update(svc.id, { labels: {} });
    expect(await labelsOf(svc.id)).toEqual({});
  });

  // ---------------------------------------------------------------------------------------------
  // PART B — THE WRITE DOORS. `routes/*.ts` alone admits `labels` on eighteen handlers, and three
  // doors reach `createObject` without passing through `typed-registries.ts` at all.
  // ---------------------------------------------------------------------------------------------

  it("CASE B0 (CONTROL): the operator really does hold object:write — so every 403 here is about the namespace", async () => {
    const res = await asOperator("POST", "/api/v1/objects/service", {
      name: `b0-${randomUUID().slice(0, 8)}`,
      labels: { tier: "pci" }
    });
    expect(res.statusCode, res.body).toBe(201);
  });

  it("CASE B1: POST /objects/{type} — 403, and nothing is written", async () => {
    const name = `b1-${randomUUID().slice(0, 8)}`;
    const res = await asOperator("POST", "/api/v1/objects/service", {
      name,
      labels: { [GOV_TIER]: "pci" }
    });
    expect(res.statusCode).toBe(403);
    expect(await liveRowsByUrn("service", `urn:scp:${org.orgId}:service:${name}`)).toHaveLength(0);
  });

  it("CASE B2: PUT /objects/{type}/{urn} on a NEW urn — 403 (the upsert's create branch)", async () => {
    const name = `b2-${randomUUID().slice(0, 8)}`;
    const urn = `urn:scp:${org.orgId}:service:${name}`;
    const res = await asOperator("PUT", `/api/v1/objects/service/${encodeURIComponent(urn)}`, {
      name,
      labels: { [GOV_TIER]: "pci" }
    });
    expect(res.statusCode).toBe(403);
    expect(await liveRowsByUrn("service", urn)).toHaveLength(0);
  });

  it("CASE B3: POST /components — the door inherited via CreateComponentRequestSchema.extend()", async () => {
    const name = `b3-${randomUUID().slice(0, 8)}`;
    const res = await asOperator("POST", "/api/v1/components", {
      name,
      service: serviceUrn,
      labels: { [GOV_TIER]: "pci" }
    });
    expect(res.statusCode).toBe(403);
    expect(await liveRowsByUrn("component", `urn:scp:${org.orgId}:component:${name}`)).toHaveLength(
      0
    );
  });

  it("CASE B4 (CONTROL): a NEAR-MISS key is an ordinary label — the namespace is a literal prefix", async () => {
    // Both readers compare keys with `===`. A guard that reserved more than the matcher honours
    // would refuse writes for no protection at all; this pins the boundary rather than the wording.
    const res = await asOperator("POST", "/api/v1/objects/service", {
      name: `b4-${randomUUID().slice(0, 8)}`,
      labels: { "scp.governance": "pci", "SCP.GOVERNANCE/tier": "pci", "x-scp.governance/t": "pci" }
    });
    expect(res.statusCode, res.body).toBe(201);
  });

  it("CASE B5: IaC apply — a manifest stamping a governance label is refused, and writes nothing", async () => {
    const stackName = `gov-${randomUUID().slice(0, 8)}`;
    const urn = `urn:scp:${stackName}:service:b5`;
    const manifest: DesiredStateManifest = {
      stackName,
      objects: [{ urn, typeId: "service", name: "b5", labels: { [GOV_TIER]: "pci" } }],
      relationships: []
    };
    const plan = await operatorClient.plans.create(manifest);
    // The refusal lands at APPLY, not at plan: plan computation is read-only and never reaches
    // `createObject`. Either would be fine so long as nothing is written.
    await expect(operatorClient.plans.apply(plan.id)).rejects.toThrow();
    expect(await liveRowsByUrn("service", urn)).toHaveLength(0);
  });

  it("CASE B6: POST /relationships — the edge table has its own labels bag and its own choke point", async () => {
    const a = await admin.object("service").create({ name: `b6a-${randomUUID().slice(0, 8)}` });
    const b = await admin.object("service").create({ name: `b6b-${randomUUID().slice(0, 8)}` });
    const res = await asOperator("POST", "/api/v1/relationships", {
      typeId: "depends_on",
      fromId: a.id,
      toId: b.id,
      labels: { [GOV_TIER]: "pci" }
    });
    expect(res.statusCode).toBe(403);
  });

  it("CASE B7: hand-fill — the door that wears the federationImport flag exempting the choke point", async () => {
    // Driven at the REPO, not over HTTP, and deliberately: `POST /federation/hand-fill` authorizes
    // `federation:write` at the org root, which `drizzle/0012` grants only to Administrator/Owner —
    // and those same roles hold org-root `policy:write`, so no BUILT-IN role can reach this door
    // without also clearing the bar. The refusal exists for a custom role (the `roles` table is
    // org-scoped and operators do define their own) and as defence in depth, and the claim under
    // test is INSTALLATION: `handFillObject` must run the check for itself, because the choke point
    // skips it for `federationImport`. Calling the door proves that; calling the guard would not.
    const domainId = asTrustDomainId(randomUUID());
    const { publicKey } = generateKeyPairSync("ed25519");
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      pairPeer(tx, {
        orgId: org.orgId,
        domainId,
        name: `peer-${domainId.slice(0, 8)}`,
        role: "commander",
        publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64")
      })
    );

    const urn = `urn:scp:${org.orgId}:service:b7-${randomUUID().slice(0, 8)}`;
    expect(
      await refusalDetail(
        withTenantTx(server.deps.db, org.orgId, (tx) =>
          handFillObject(tx, {
            orgId: org.orgId,
            peerIdOrName: domainId,
            typeId: "service",
            urn,
            name: "b7",
            labels: { [GOV_TIER]: "pci" },
            actorObjectId: operator.objectId
          })
        )
      )
    ).toMatch(/reserved governance labels[\s\S]*policy:write/);
    expect(await liveRowsByUrn("service", urn)).toHaveLength(0);
  });

  it("CASE B8: POST /federation/overlays — free-form typeId + labels, authorized with plain object:write", async () => {
    const base = await admin.object("service").create({ name: `b8-${randomUUID().slice(0, 8)}` });
    const urn = `urn:scp:${org.orgId}:service:b8-overlay-${randomUUID().slice(0, 8)}`;
    const res = await asOperator("POST", "/api/v1/federation/overlays", {
      base: base.id,
      typeId: "service",
      name: "b8-overlay",
      urn,
      labels: { [GOV_TIER]: "pci" }
    });
    expect(res.statusCode).toBe(403);
    expect(await liveRowsByUrn("service", urn)).toHaveLength(0);
  });

  it("CASE B9 (EXEMPTION): a verified federation import carries governance labels through untouched", async () => {
    // The width of the skip, and why it is not "imported data is trusted": `import-repo.ts`'s
    // `object_upsert` branch has NO try/catch, so one refusal aborts a whole signed bundle and
    // wedges that channel. A receiving domain also has no standing to referee a document its
    // AUTHORING instance already accepted — the guard is an authoring-time refusal by construction.
    //
    // Driven at the repo with `federationImport` set, because that flag — not the transport — is
    // what the exemption is keyed on, and it is supplied by exactly two modules (`import-repo.ts`
    // and `handfill-repo.ts`, whose unearned share of it CASE B7 closes).
    const urn = `urn:scp:${org.orgId}:service:b9-${randomUUID().slice(0, 8)}`;
    const imported = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      upsertObjectByUrn(tx, {
        orgId: org.orgId,
        typeId: "service",
        actorObjectId: operator.objectId,
        requestId: "b9",
        urn,
        name: "b9",
        labels: { [GOV_TIER]: "pci" },
        federationImport: {
          originDomainId: asTrustDomainId(randomUUID()),
          revision: 1,
          provenance: null
        }
      })
    );
    expect(imported.object.labels).toMatchObject({ [GOV_TIER]: "pci" });
  });

  // ---------------------------------------------------------------------------------------------
  // PART C — THE OTHER HALF: a selector may key on nothing but a governance label. These are 400s
  // about the DOCUMENT, so they are driven by the ADMIN — permission is never the reason.
  // ---------------------------------------------------------------------------------------------

  it("CASE C1: POST /policies — a selector keyed on an ordinary label is refused", async () => {
    expect(
      await refusalDetail(
        admin.policies.create({
          name: `c1-${randomUUID().slice(0, 8)}`,
          properties: {
            scope: { selector: { labels: { tier: "pci" } } },
            enforcement: "required"
          }
        })
      )
    ).toMatch(/reserved governance labels/);
  });

  it("CASE C2: PUT /policies/{urn} — an EDIT into the refused shape is refused too", async () => {
    // `updateObject` replaces `properties` wholesale, so an author blocked at create could otherwise
    // land a compliant policy and re-key its selector one PUT later.
    const name = `c2-${randomUUID().slice(0, 8)}`;
    const created = await admin.policies.create({
      name,
      properties: {
        scope: { selector: { labels: { [GOV_TIER]: "pci" } } },
        enforcement: "required"
      }
    });
    expect(
      await refusalDetail(
        admin.policies.upsertByUrn(created.urn, {
          name,
          properties: { scope: { selector: { labels: { tier: "pci" } } }, enforcement: "required" }
        })
      )
    ).toMatch(/reserved governance labels/);

    const [row] = await liveRowsByUrn("policy", created.urn);
    expect(row).toBeTruthy();
    const stored = await admin.policies.get(created.urn);
    expect(
      (stored.properties as { scope: { selector: { labels: Record<string, string> } } }).scope
        .selector.labels
    ).toEqual({ [GOV_TIER]: "pci" });
  });

  it("CASE C3: IaC apply — the same document through the manifest door", async () => {
    const stackName = `c3-${randomUUID().slice(0, 8)}`;
    const urn = `urn:scp:${stackName}:policy:c3`;
    const plan = await admin.plans.create({
      stackName,
      objects: [
        {
          urn,
          typeId: "policy",
          name: "c3",
          properties: { scope: { selector: { labels: { tier: "pci" } } }, enforcement: "required" }
        }
      ],
      relationships: []
    });
    expect(await refusalDetail(admin.plans.apply(plan.id))).toMatch(/reserved governance labels/);
    expect(await liveRowsByUrn("policy", urn)).toHaveLength(0);
  });

  it("CASE C4: hand-fill — the free-form typeId door, refused on the DOCUMENT", async () => {
    const domainId = asTrustDomainId(randomUUID());
    const { publicKey } = generateKeyPairSync("ed25519");
    await admin.federation.pair({
      domainId,
      name: `c4-${domainId.slice(0, 8)}`,
      role: "commander",
      publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64")
    });
    const urn = `urn:scp:${org.orgId}:policy:c4-${randomUUID().slice(0, 8)}`;
    expect(
      await refusalDetail(
        admin.federation.handFill({
          peer: domainId,
          typeId: "policy",
          urn,
          name: "c4",
          properties: { scope: { selector: { labels: { tier: "pci" } } }, enforcement: "required" }
        })
      )
    ).toMatch(/reserved governance labels/);
    expect(await liveRowsByUrn("policy", urn)).toHaveLength(0);
  });

  it("CASE C5: overlay — a policy overlay is a first-class policy candidate, so it is refused too", async () => {
    const base = await admin.policies.create({
      name: `c5-base-${randomUUID().slice(0, 8)}`,
      properties: { enforcement: "advisory" }
    });
    const urn = `urn:scp:${org.orgId}:policy:c5-overlay-${randomUUID().slice(0, 8)}`;
    expect(
      await refusalDetail(
        admin.federation.createOverlay({
          base: base.id,
          typeId: "policy",
          name: "c5-overlay",
          urn,
          properties: {
            scope: { selector: { labels: { tier: "pci" } } },
            enforcement: "required"
          }
        })
      )
    ).toMatch(/reserved governance labels/);
    expect(await liveRowsByUrn("policy", urn)).toHaveLength(0);
  });

  it("CASE C6 (CONTROL): a compliant selector-scoped policy is accepted at the typed door", async () => {
    // Without this, every case in PART C is satisfied by a route that refuses all selectors, or all
    // policies, or is simply broken.
    const created = await admin.policies.create({
      name: `c6-${randomUUID().slice(0, 8)}`,
      properties: {
        scope: { selector: { labels: { [GOV_TIER]: "pci" } } },
        enforcement: "advisory"
      }
    });
    expect(created.id).toBeTruthy();
  });

  // ---------------------------------------------------------------------------------------------
  // PART D — the OTHER label-keyed decision: which journal entries leave this security domain.
  // ---------------------------------------------------------------------------------------------

  it("CASE D1: pairing a peer with a `custom` scope keyed on an ordinary label is refused", async () => {
    const domainId = asTrustDomainId(randomUUID());
    const { publicKey } = generateKeyPairSync("ed25519");
    expect(
      await refusalDetail(
        admin.federation.pair({
          domainId,
          name: `d1-${domainId.slice(0, 8)}`,
          role: "outpost",
          publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
          syncScope: { mode: "custom", labelSelector: { tier: "gold" } }
        })
      )
    ).toMatch(/reserved governance labels/);
  });

  it("CASE D2: NARROWING an already-paired peer to that scope is refused too", async () => {
    // The half that matters: a peer paired at `full` can be narrowed here without ever passing
    // through a pair.
    const domainId = asTrustDomainId(randomUUID());
    const { publicKey } = generateKeyPairSync("ed25519");
    await admin.federation.pair({
      domainId,
      name: `d2-${domainId.slice(0, 8)}`,
      role: "outpost",
      publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64")
    });
    expect(
      await refusalDetail(
        admin.federation.updatePeer(domainId, {
          syncScope: { mode: "custom", labelSelector: { tier: "gold" } }
        })
      )
    ).toMatch(/reserved governance labels/);
  });

  it("CASE D3 (CONTROL): a `custom` scope keyed on a governance label pairs normally", async () => {
    const domainId = asTrustDomainId(randomUUID());
    const { publicKey } = generateKeyPairSync("ed25519");
    const peer = await admin.federation.pair({
      domainId,
      name: `d3-${domainId.slice(0, 8)}`,
      role: "outpost",
      publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
      syncScope: { mode: "custom", labelSelector: { [GOV_TIER]: "gold" } }
    });
    expect(peer.syncScope).toEqual({ mode: "custom", labelSelector: { [GOV_TIER]: "gold" } });
  });
});
