import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpApiError, ScpClient } from "@scp/sdk";
import { withTenantTx } from "../db/tenant-tx.js";
import { containmentChain } from "./containment.js";
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
    const parentDomain = await admin
      .object("domain")
      .create({ name: uniq("policy-parent-domain") });
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
        config: {},
        actorObjectId: org.orgId,
        requestId: "test-setup"
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

  // -----------------------------------------------------------------------------------------
  // AT THE BOUND — the ADR-0037 loudness contract, flipped DELIBERATELY from this test's first
  // life as a hazard pin (M21 crossover, 2026-08-13). Every recursive walk shares one bound
  // (CONTAINMENT_WALK_MAX_DEPTH, six census sites), and before ADR-0037 each STOPPED EXPANDING
  // silently: authz refused deep domain creates with a permission-shaped 403 naming neither
  // depth nor bound, while a component created under the deepest allowed domain got a chain
  // whose depth inversion presented a mid-level domain at "org root" — org-scoped required
  // policies silently stopped matching (the ADR-0026 failure shape), reachable through the
  // public API. Both halves are now LOUD: the walks probe one level past the bound and refuse
  // with the depth named. This test pins that contract from the operator's side.
  // -----------------------------------------------------------------------------------------

  it("AT THE BOUND (ADR-0037): deep creates refuse with the DEPTH named, and a chain that would truncate refuses instead of relabeling", async () => {
    // CONTROL first — a shallow nesting, well under the bound: the convention holds and the org
    // root genuinely sits at index 0. Without this, the deep case could "pass" against a harness
    // where the convention never held at all (vacuous-test discipline).
    const shallowTop = await admin.object("domain").create({ name: uniq("shallow-top") });
    const shallowChildDomain = await admin
      .object("domain")
      .create({ name: uniq("shallow-child"), domainId: shallowTop.id });
    const shallowSvc = await admin.services.create({ name: uniq("svc-shallow") });
    const shallowComponent = await admin.components.create({
      name: uniq("component-shallow"),
      service: shallowSvc.id,
      domainId: shallowChildDomain.id
    });
    const control = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      containmentChain(tx, org.orgId, shallowComponent.id)
    );
    expect(
      control[0]?.typeId,
      "control: under the bound, index 0 must be the organization — otherwise the deep case " +
        "below would be measuring the harness, not the bound"
    ).toBe("organization");
    expect(control.some((r) => r.id === shallowTop.id)).toBe(true);

    // Nest domains until the API refuses. Pre-ADR-0037 this refusal was a permission-shaped 403
    // ("subject … lacks 'object:write' at scope …") naming neither depth nor bound — an operator
    // met it and debugged RBAC. Now the deny-path probe (authz/resolve.ts
    // assertDenyNotTruncated) converts a refusal it cannot vouch for into the loud depth error.
    const domains: { id: string }[] = [];
    let refusal: unknown = null;
    for (let i = 0; i < 14; i++) {
      const parent = domains[domains.length - 1];
      try {
        domains.push(
          await admin
            .object("domain")
            .create({ name: uniq(`deep-d${i}`), ...(parent ? { domainId: parent.id } : {}) })
        );
      } catch (e) {
        refusal = e;
        break;
      }
    }
    expect(
      refusal,
      "nesting past the shared bound must still be refused — if this is null the bound was " +
        "raised without updating this test; move all six census sites together"
    ).not.toBeNull();
    const refusalDetail =
      refusal instanceof ScpApiError
        ? JSON.stringify(refusal.problem ?? refusal.message)
        : String(refusal);
    expect(
      refusalDetail,
      "ADR-0037: the refusal must NAME the depth bound, not masquerade as a missing role"
    ).toContain("supported containment depth");
    expect(refusalDetail).toContain("ADR-0037");
    expect(domains.length).toBeGreaterThanOrEqual(8);

    // The other half of the old hazard: a component created under the deepest allowed domain used
    // to get a silently truncated chain whose inversion presented a mid-level domain as the org
    // root. Now NOTHING is silent — walk back from the deepest domain: every component whose chain
    // would exceed the bound is refused LOUDLY AT CREATE, naming the depth, and the deepest one
    // whose chain FITS must still produce the honest shape (organization at index 0).
    //
    // FLIPPED 2026-08-18 (owner ruling; ADR-0037 Consequences; `containment-depth-doors.
    // integration.test.ts`). This loop used to tolerate EITHER arm — a create refused loudly, OR a
    // create that succeeded and whose chain read then threw — because before the doors counted the
    // row they were writing, a component under the deepest allowed domain WAS created (201) and
    // was refused only when something walked it (M22's governance-reach capture, in an org with a
    // policy; a chain read, otherwise). That second arm is now a FAILURE, not a contract: the door
    // invariant says no write leaves a live row past the bound, so a successful create MUST yield
    // a complete chain. A create-then-409-on-read here means a door went quiet.
    const deepSvc = await admin.services.create({ name: uniq("svc-deep") });
    let sawDepthRefusal = false;
    let honestChain: Awaited<ReturnType<typeof containmentChain>> | null = null;
    let honestDomain: { id: string } | null = null;
    for (let i = domains.length - 1; i >= 0 && !honestChain; i--) {
      const candidate = domains[i];
      if (!candidate) continue;
      let component: { id: string };
      try {
        component = await admin.components.create({
          name: uniq(`component-deep-${i}`),
          service: deepSvc.id,
          domainId: candidate.id
        });
      } catch (e) {
        // The create itself refused at this depth — it must be the LOUD depth refusal (the door's
        // "would exceed", or the authz deny-probe's), never a permission-shaped 403 or a silent
        // success. Step up afterwards.
        const text = e instanceof ScpApiError ? JSON.stringify(e.problem ?? e.message) : String(e);
        expect(text, `create under domains[${i}] refused for a reason other than depth`).toContain(
          "supported containment depth"
        );
        sawDepthRefusal = true;
        continue;
      }
      // A create that LANDED must be readable in full — the door invariant. No try/catch: a walk
      // refusal here is the test failing, and it says which domain the door let through.
      honestChain = await withTenantTx(server.deps.db, org.orgId, (tx) =>
        containmentChain(tx, org.orgId, component.id)
      );
      honestDomain = candidate;
    }
    expect(
      sawDepthRefusal,
      "at least one deep component must be REFUSED loudly at create — if none was, the bound rose " +
        "without this test being updated: move all six census sites together"
    ).toBe(true);
    expect(
      honestChain,
      "some shallower component must still resolve a complete chain"
    ).not.toBeNull();
    expect(
      honestChain![0]?.typeId,
      "a chain that FITS the bound presents the organization at index 0 — the convention the " +
        "loudness exists to keep honest"
    ).toBe("organization");
    expect(honestChain!.find((r) => r.id === honestDomain!.id)).toBeDefined();
  });
});
