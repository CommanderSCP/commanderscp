import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import { withTenantTx } from "../db/tenant-tx.js";
import { matchPoliciesForTargets } from "../governance/policy-resolve.js";
import { resolveBindingForTarget } from "../coordination/binding-resolution.js";
import { upsertExecutorBinding } from "../coordination/executor-bindings-repo.js";
import {
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/**
 * G2 (outpost-ui.md §5, owner decision 2026-08-13): CONTAINMENT DOMAINS NEST — a `domain` object may
 * be created inside another `domain`, first-class rather than an unexercised capability.
 *
 * The proposal's own §5 measured that nothing exercised this before today: `resolveDomainId` never
 * constrained the parent's type, and `containmentChain`'s route 1 (`child.domain_id -> parent`) is
 * already generic across the recursive walk — so a domain-under-domain was always structurally
 * reachable, just never created and never pinned. This file is that census: (a) create + round-trip,
 * (b) M20.5 locality inheritance crossing the domain rung, (c) whether a RESOLVER that walks
 * `domainId` parents actually resolves through the nesting.
 */
describe("nested containment domains (outpost-ui.md §5(b), owner decision 2026-08-13)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  const uniq = (p: string) => `${p}-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "nested-domains");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  }, 120_000);

  afterAll(async () => {
    await server?.close();
  });

  // -----------------------------------------------------------------------------------------
  // (a) create-under-domain, round-tripped.
  // -----------------------------------------------------------------------------------------

  it("a domain object may be created with domainId set to another domain's id, and round-trips", async () => {
    const parent = await admin.object("domain").create({ name: uniq("parent-domain") });
    const child = await admin
      .object("domain")
      .create({ name: uniq("child-domain"), domainId: parent.id });

    expect(child.domainId).toBe(parent.id);

    // Round-trip: re-reading the child still shows the parent — not just the create response.
    const reread = await admin.object("domain").get(child.id);
    expect(reread.domainId).toBe(parent.id);
  });

  // -----------------------------------------------------------------------------------------
  // (b) M20.5 locality inheritance crosses the domain rung.
  // -----------------------------------------------------------------------------------------

  it("M20.5: a child domain created under a domainLocal:true parent inherits locality, without saying so", async () => {
    const parent = await admin
      .object("domain")
      .create({ name: uniq("local-parent-domain"), domainLocal: true });
    expect(parent.domainLocal).toBe(true);

    const child = await admin
      .object("domain")
      .create({ name: uniq("inheriting-child-domain"), domainId: parent.id });
    expect(
      child.domainLocal,
      "a subdomain of a domain-local domain must itself be domain-local (ADR-0031 §6a)"
    ).toBe(true);

    // The induction one hop further: a service created under the CHILD domain also inherits — not
    // because it saw the grandparent, but because the child was itself correctly stamped at its own
    // create (the same one-hop argument domain-local-inheritance.integration.test.ts pins for the
    // service/component rungs).
    const service = await admin
      .object("service")
      .create({ name: uniq("service-under-nested-domain"), domainId: child.id });
    expect(
      service.domainLocal,
      "a service placed in a nested domain-local subdomain inherits too"
    ).toBe(true);
  });

  it("CONTROL: a child domain under an ORDINARY (non-local) parent stays shared", async () => {
    const parent = await admin.object("domain").create({ name: uniq("ordinary-parent-domain") });
    const child = await admin
      .object("domain")
      .create({ name: uniq("ordinary-child-domain"), domainId: parent.id });
    expect(child.domainLocal).toBe(false);
  });

  // -----------------------------------------------------------------------------------------
  // (c) does a RESOLVER that walks domainId parents actually traverse the nesting?
  //
  // Two candidate resolvers, per the section 1 task: executor-binding resolution's org/domain rung,
  // and policy scope expansion. They give OPPOSITE answers, and both are pinned rather than assumed.
  // -----------------------------------------------------------------------------------------

  it("POLICY resolution walks the nesting: a policy scoped at the PARENT domain governs a component whose domain is the CHILD domain", async () => {
    const parentDomain = await admin.object("domain").create({ name: uniq("policy-parent-domain") });
    const childDomain = await admin
      .object("domain")
      .create({ name: uniq("policy-child-domain"), domainId: parentDomain.id });

    // Component's OWN domainId is the child — not reached via a service's contains edge, so this
    // isolates route 1 (domain_id) of containmentChain rather than mixing in route 2 (contains).
    const service = await admin.services.create({ name: uniq("svc-in-child-domain") });
    const component = await admin.components.create({
      name: uniq("component-in-child-domain"),
      service: service.id,
      domainId: childDomain.id
    });
    expect(component.domainId).toBe(childDomain.id);

    const policy = await admin.policies.create({
      name: uniq("parent-domain-policy"),
      properties: {
        scope: { objectRef: parentDomain.id },
        enforcement: "required",
        effects: [{ kind: "requireApproval", quorum: 1, role: "Approver" }]
      }
    });

    const matched = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      matchPoliciesForTargets(tx, {
        orgId: org.orgId,
        targetObjectIds: [component.id],
        actorObjectId: org.orgId
      })
    );

    const hit = matched.find((m) => m.policyObjectId === policy.id);
    expect(
      hit,
      "a policy scoped at the PARENT domain must govern a component whose domain is the CHILD " +
        "domain — containmentChain's route 1 (child.domain_id -> parent) is generic across the " +
        "recursive walk and does not stop at one hop, unlike M20.5's create-time inheritance"
    ).toBeDefined();
    expect(hit!.matchedAt.objectId).toBe(parentDomain.id);
    expect(hit!.matchedAt.via).toBe("objectRef");
    // Two hops up from the component (component -> child domain -> parent domain), so this is a
    // genuine multi-hop nested-domain resolution, not a same-domain coincidence.
    expect(hit!.matchedAt.depth).toBeGreaterThan(0);
  });

  it("FINDING (ADR-0029 D2): executor-BINDING resolution does NOT walk domain at all, nested or not", async () => {
    // binding-resolution.ts:224's own header is explicit: "a binding on a containment `domain` does
    // not resolve" (ADR-0029 D2) — the ladder walks the `contains` edge only (component -> service ->
    // assembly -> org root), and never consults `domain_id`. This is NOT a nesting-specific gap; a
    // binding on a domain does not resolve even ONE hop up under the CURRENT (unnested) model. Pinned
    // here with a real resolution attempt, so the negative is asserted rather than assumed.
    const parentDomain = await admin
      .object("domain")
      .create({ name: uniq("binding-parent-domain") });
    const childDomain = await admin
      .object("domain")
      .create({ name: uniq("binding-child-domain"), domainId: parentDomain.id });
    const service = await admin.services.create({ name: uniq("svc-binding-child-domain") });
    const component = await admin.components.create({
      name: uniq("component-binding-child-domain"),
      service: service.id,
      domainId: childDomain.id
    });

    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      upsertExecutorBinding(tx, {
        orgId: org.orgId,
        targetObjectId: parentDomain.id,
        type: "configuration",
        pluginModule: "test-plugin",
        pluginInstanceId: `test-plugin-${uniq("instance")}`,
        config: {}
      })
    );

    const resolution = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      resolveBindingForTarget(tx, org.orgId, component.id)
    );
    expect(
      resolution.outcome,
      "a binding at the parent domain must NOT resolve for a component under the child domain — " +
        "domain is not a rung this ladder walks (ADR-0029 D2)"
    ).toBe("none");
  });
});
