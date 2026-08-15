import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
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

  // -----------------------------------------------------------------------------------------
  // AT THE BOUND — what nesting actually buys before the walk's ceiling (M21 crossover,
  // 2026-08-13). Every containment/scope recursion in this repo carries a hardcoded
  // `depth < 10` that STOPS EXPANDING rather than erroring (six sites, filterless census:
  // containment.ts:294, named-queries.ts:194, policy-resolve.ts:87, authz/resolve.ts:123/:137/
  // :194 — the last three being the hand-synced `scopeExpandCte` copy containment.ts:14-18
  // warns about). `containmentChain` then inverts depths (`maxDepth - depth`), so past the bound
  // it doesn't look broken — the outermost SURVIVING ancestor is presented at depth 0, the
  // position the convention comment labels "org root". An over-deep chain therefore masquerades
  // as a shallower org whose root is a mid-level domain, and org-scoped policies silently stop
  // matching: the exact failure shape this codebase has paid for twice (fail-open service
  // freeze; 11 dormant required prod gates). The budget is SHARED across kinds — the deepest
  // pre-nesting shape (placement→component→assembly→service→domain→org) already spends 5 of 10,
  // so subdomain nesting has roughly five levels of headroom. M21's enablement resolution
  // (governance/scan-requirements.ts) walks this same chain and inherits the same ceiling.
  //
  // This test RECORDS the truncate-and-relabel behaviour so it is discovered here and not in an
  // estate. It is a pin, not an endorsement: if the bound is ever raised or made loud, all six
  // sites move together, and this test's expectations flip deliberately.
  // -----------------------------------------------------------------------------------------

  it("AT THE BOUND: authz refuses deep DOMAIN creates (fail-closed, permission-shaped error) — but does NOT protect component creates, so the chain relabel IS reachable via the public API", async () => {
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

    // Nest domains until the API refuses — MEASURING the ceiling instead of assuming it. What was
    // expected here was containmentChain's silent truncate-and-relabel; what the first run found
    // is that a DIFFERENT copy of the same `depth < 10` bound gets there first: the authz scope
    // expansion (authz/resolve.ts:123/:137/:194, the hand-synced scopeExpandCte). The org-root
    // admin's own role binding stops resolving once the walk from the new object's scope can no
    // longer reach the org root within 10 hops, so the CREATE is refused 403 — fail-CLOSED, the
    // safe direction, but with a PERMISSION-shaped detail ("subject … lacks 'object:write' at
    // scope …") that names neither depth nor the bound. An operator meeting it will debug RBAC,
    // not nesting. (Measured 2026-08-13 on a live instance too: 11 domains create fine, the 12th
    // 403s; the harness org refuses one level earlier — the exact ceiling depends on where the
    // walk seeds, which is itself evidence that nothing about it is announced.)
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
      "nesting past the shared depth-10 bound must be REFUSED by authz scope expansion — if this " +
        "is now null, the bound moved or went loud: update the six-site census " +
        "(containment.ts:294, named-queries.ts:194, policy-resolve.ts:87, authz/resolve.ts:123/" +
        ":137/:194) and re-measure, don't just bump the loop"
    ).not.toBeNull();
    expect(String(refusal)).toContain("Forbidden");
    expect(domains.length).toBeGreaterThanOrEqual(8);

    // THE TWO BOUNDS DIVERGE — measured, and this is the live half of the finding. The authz
    // ceiling above refuses deep DOMAIN creates, but a COMPONENT create under the deepest
    // ALLOWED domain still passes authz (its write-permission walk evidently seeds/joins
    // differently than the new-domain case) — and that component's containment chain already
    // exceeds containmentChain's own `depth < 10`. So the truncate-and-relabel behaviour is
    // REACHABLE THROUGH THE PUBLIC API: no direct DB writes, no exotic path — ~10 nested domains
    // (allowed), one component at the bottom (allowed), and the chain silently drops the
    // outermost ancestors and presents a MID-LEVEL DOMAIN at index 0, the position the inversion
    // comment labels "org root". Everything that reads this chain — policy scope matching, freeze
    // scoping, M21's enablement resolution — sees a shallower org whose root is wrong, with no
    // error anywhere. Org-scoped `required` policies silently stop matching for exactly the
    // components most deeply nested: the ADR-0026 failure shape, reachable by construction.
    //
    // This pin is a RECORD of that hazard, not an endorsement. When the bound is made loud or
    // raised (all six census sites together), the expectations below flip deliberately.
    const deepSvc = await admin.services.create({ name: uniq("svc-deep") });
    let deepComponent: { id: string } | null = null;
    let componentDomain: { id: string } | null = null;
    for (let i = domains.length - 1; i >= 0 && !deepComponent; i--) {
      const candidate = domains[i];
      if (!candidate) continue;
      try {
        deepComponent = await admin.components.create({
          name: uniq(`component-deep-${i}`),
          service: deepSvc.id,
          domainId: candidate.id
        });
        componentDomain = candidate;
      } catch {
        // 403 at this depth too — step up one domain and retry; the claim is about the deepest
        // shape the API actually hands out.
      }
    }
    expect(deepComponent, "no component creatable under ANY probe domain — harness broke").not.toBeNull();
    const deepest = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      containmentChain(tx, org.orgId, deepComponent!.id)
    );
    expect(
      deepest[0]?.typeId,
      "MEASURED 2026-08-13: the deepest API-creatable component's chain presents a mid-level " +
        "domain at index 0 (the relabel). If this now reads 'organization', the bound was fixed " +
        "or raised — update the six-site census and the escalation note in outpost-ui.md §5, and " +
        "flip this pin to assert the honest chain"
    ).toBe("domain");
    // MEASURED SHAPE — quieter than a plain drop. The deep route-1 walk (component → d[i] → … →
    // d0 → org) truncates before reaching the org, so maxDepth belongs to a DOMAIN — but the org
    // still arrives via the component's SHORT route (service `contains` hop, then the service's
    // own domain_id), at a small raw depth. After the `maxDepth - depth` inversion, the org is
    // therefore PRESENT but DISPLACED to a nonzero position while a top-level domain occupies
    // index 0. Nothing is missing; the ORDER is wrong — every row accounted for, and every caller
    // reading "index 0 = org root" scopes against the wrong object. That is the quietest possible
    // failure shape: no gap to notice, no error to catch, just a chain whose root labels lie.
    const orgRow = deepest.find((r) => r.typeId === "organization");
    expect(
      orgRow,
      "the org still arrives via the component's short service route — if it is now absent " +
        "entirely, the truncation got louder, which changes the escalation, not the hazard"
    ).toBeDefined();
    expect(
      orgRow!.depth,
      "the org must sit at a NONZERO depth — displaced from the root position the convention " +
        "assigns it"
    ).toBeGreaterThan(0);
    // The component's own domain IS present (near end of the walk) — the chain looks healthy
    // from below, which is what makes the masquerade quiet.
    expect(deepest.find((r) => r.id === componentDomain!.id)).toBeDefined();
  });
});
