import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { withTenantTx } from "../db/tenant-tx.js";
import { objects } from "../db/schema.js";
import {
  CONTAINMENT_DEPTH_DOOR_PHRASE,
  CONTAINMENT_WALK_MAX_DEPTH,
  containmentChain
} from "./containment.js";
import {
  buildTestServer,
  createTestOrg,
  type TestOrg,
  type TestServer
} from "../test-support/harness.js";

/**
 * THE DOOR INVARIANT (owner ruling 2026-08-18; ADR-0037 Consequences): after every write, every live
 * row's LONGEST containment route to the org root — over all four routes, the placement pair counted
 * — is at most `CONTAINMENT_WALK_MAX_DEPTH` (10) hops. A write that would leave ANY live row past it
 * is refused at the door with ONE message shape (400, "would exceed the supported containment depth
 * (10 hops, ADR-0037)"), the resulting depth named, the subtree named when the subtree is the reason.
 *
 * WHY. Since ADR-0037 every recursive walk refuses LOUDLY when a row exists past the bound. That made
 * a row AT hop eleven a row nobody could govern (`containmentChain` throws for it — policy matching,
 * freeze scoping, gate evaluation, ADR-0032 enablement) and, when the eleven-hop route was its ONLY
 * route, a row nobody could read, rename or move back either (RBAC's nothing-found becomes the loud
 * refusal). Measured before this round on the real HTTP doors: `POST /domains {domainId: <a domain
 * at hop ten>}` answered 201, and the org-root admin's own next `GET` of the row and the `PATCH` that
 * would have moved it back both answered **409**. The doors were letting the walks' ceiling be
 * crossed by exactly one row, because the create-side check had been carved out against the
 * PRE-ADR-0037 silently-truncating walk (`graph/containment.ts`'s retired `childIsNew` reasoning).
 *
 * THE FOUR DOORS, and what each case here pins (see `assertContainmentDepthAdmits` for the shared
 * arithmetic `hops(parent) + 1 + height(child) > bound`):
 *
 *   D1  `createObject` `domain_id`     — a domain / service / component created under a hop-ten
 *                                        parent (childIsNew: height 0)
 *   D2  `updateObject` `domain_id` MOVE — the moved row's SUBTREE counts (height walked downward),
 *                                        with one case per ARM of the downward walk: `domain_id`
 *                                        (D2-subtree), `contains` read forwards (D2-contains-arm),
 *                                        a placement naming the row as target (D2-target-arm); the
 *                                        component arm is D3's PUT-service case
 *   D3  `contains` edge                 — a component attached to a hop-ten container, an existing
 *                                        component (with a placement under it) moved to a hop-nine one
 *   D4  a placement's PAIR              — a placement of a hop-ten component, or at a hop-ten target;
 *                                        and its one bypass, federation hand-fill of a `placement`,
 *                                        now refused as the fifth pair-bound door
 *
 * Every refusal has a SHALLOW CONTROL that succeeds, so a refuse-everything mutation goes red; and a
 * row at EXACTLY the bound is asserted readable, because ten is a ceiling, not a ban.
 *
 * MUTATION LOG (each applied ALONE, then reverted — recorded in the round summary too):
 *   | skip refusal 2 when `childIsNew` (the pre-ruling carve-out) | D1 ×3, D4 ×2 and the IaC twin go red |
 *   | delete the downward walk in `assertContainmentDepthAdmits`   | D2-subtree, D2-contains-arm, D2-target-arm and D3-subtree go red |
 *   | neuter the downward walk's `contains` arm (`type_id = 'contains-never'`) | D2-contains-arm goes red (was 29/29 green before it existed — verifier M6b) |
 *   | drop the downward walk's `deploymentTargetId` branch (`OR FALSE`)  | D2-target-arm goes red (was 29/29 green before it existed — verifier M6c) |
 *   | drop the downward walk's `componentId` branch                    | D3-subtree goes red |
 *   | drop the downward walk's `domain_id` arm                         | D2-subtree goes red |
 *   | delete the `assertContainmentDepthAdmits` call in the `contains` door | D3 ×3 go red |
 *   | delete the pair loop in `createPlacement`                    | D4 ×2 go red |
 *   | delete the pair-bound refusal in `handFillObject`             | the hand-fill case goes red (201, a live placement row) |
 *   | refuse everything (`rowDepth > 0`)                            | every control goes red |
 *
 * Run from `apps/server` with the integration config and READ THE FILE LIST vitest prints — the
 * default config excludes `*.integration.test.ts` and a scoped run without it reports green having
 * executed nothing:
 *
 *   DOCKER_HOST=unix://$HOME/.colima/default/docker.sock TESTCONTAINERS_RYUK_DISABLED=true \
 *     npx vitest run --config vitest.integration.config.ts \
 *       src/graph/containment-depth-doors.integration.test.ts
 */
describe("containment depth doors — no write may leave a live row past the bound (ADR-0037, 2026-08-18)", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await buildTestServer();
  });

  afterAll(async () => {
    await server.close();
  });

  interface Res {
    status: number;
    body: string;
    json: () => Record<string, unknown>;
  }

  async function call(
    token: string,
    method: "POST" | "PATCH" | "PUT" | "GET",
    url: string,
    payload?: Record<string, unknown>
  ): Promise<Res> {
    const res = await server.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload === undefined ? {} : { payload })
    });
    return { status: res.statusCode, body: res.body, json: () => res.json() };
  }

  /** The chain org -> d1 -> ... -> d10, built THROUGH the doors. `domains[i - 1]` sits at hop i. */
  async function domainChain(org: TestOrg, prefix: string): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 1; i <= CONTAINMENT_WALK_MAX_DEPTH; i += 1) {
      const parent = ids[ids.length - 1];
      const created = await call(org.adminToken, "POST", "/api/v1/domains", {
        name: `${prefix}-d${i}`,
        ...(parent === undefined ? {} : { domainId: parent })
      });
      expect(created.status, `d${i}: ${created.body}`).toBe(201);
      ids.push(created.json().id as string);
    }
    return ids;
  }

  function hop(domains: string[], n: number): string {
    const id = domains[n - 1];
    if (!id) throw new Error(`no domain at hop ${n}`);
    return id;
  }

  /** The one message shape, asserted the same way at every door. */
  function expectDoorRefusal(
    res: Res,
    child: string | RegExp,
    parent: string,
    depth: number
  ): void {
    expect(res.status, res.body).toBe(400);
    expect(res.body).toContain(CONTAINMENT_DEPTH_DOOR_PHRASE);
    expect(res.body).toContain(`(${CONTAINMENT_WALK_MAX_DEPTH} hops, ADR-0037)`);
    expect(res.body).toContain(parent);
    expect(res.body).toMatch(child);
    expect(res.body).toContain(`depth ${depth}`);
    // NOT the walk's phrase: a door 400 must never read as a walk 409 (`isWalkDepthExceeded`).
    expect(res.body).not.toContain("exceeds the supported containment depth");
  }

  it("a row at EXACTLY the bound is readable by the org admin, and its chain is complete", async () => {
    const org = await createTestOrg(server, "depth-ceiling");
    const domains = await domainChain(org, "ceiling");
    const d10 = hop(domains, 10);
    const read = await call(org.adminToken, "GET", `/api/v1/domains/${d10}`);
    expect(read.status, read.body).toBe(200);
    const chain = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      containmentChain(tx, org.orgId, d10)
    );
    expect(chain[0]?.typeId).toBe("organization");
    expect(Math.max(...chain.map((e) => e.depth))).toBe(CONTAINMENT_WALK_MAX_DEPTH);
  });

  // ---------------------------------------------------------------------------------------------
  // D1 — createObject domain_id
  // ---------------------------------------------------------------------------------------------

  it("D1: a domain created under a hop-ten domain is refused; under hop nine it lands", async () => {
    const org = await createTestOrg(server, "depth-d1-domain");
    const domains = await domainChain(org, "d1dom");
    const d10 = hop(domains, 10);
    const d9 = hop(domains, 9);

    const refused = await call(org.adminToken, "POST", "/api/v1/domains", {
      name: "d1dom-eleventh",
      domainId: d10
    });
    expectDoorRefusal(refused, /object '/, d10, CONTAINMENT_WALK_MAX_DEPTH + 1);

    // CONTROL — a sibling of d10, at hop ten, and readable afterwards.
    const ok = await call(org.adminToken, "POST", "/api/v1/domains", {
      name: "d1dom-tenth-sibling",
      domainId: d9
    });
    expect(ok.status, ok.body).toBe(201);
    const read = await call(org.adminToken, "GET", `/api/v1/domains/${ok.json().id as string}`);
    expect(read.status, read.body).toBe(200);
  });

  it("D1: a service created under a hop-ten domain is refused — the shape that used to be unreadable by everyone", async () => {
    const org = await createTestOrg(server, "depth-d1-service");
    const domains = await domainChain(org, "d1svc");
    const d10 = hop(domains, 10);
    const d9 = hop(domains, 9);

    const refused = await call(org.adminToken, "POST", "/api/v1/services", {
      name: "d1svc-deep",
      domainId: d10
    });
    expectDoorRefusal(refused, /object '/, d10, CONTAINMENT_WALK_MAX_DEPTH + 1);

    const ok = await call(org.adminToken, "POST", "/api/v1/services", {
      name: "d1svc-at-ceiling",
      domainId: d9
    });
    expect(ok.status, ok.body).toBe(201);
    // Readable, because it sits AT the bound and no further: this GET is what answered 409 for the
    // hop-eleven service before the door existed.
    const read = await call(org.adminToken, "GET", `/api/v1/services/${ok.json().id as string}`);
    expect(read.status, read.body).toBe(200);
  });

  it("D1: a component created with domainId at hop ten is refused even though its service is at the root", async () => {
    const org = await createTestOrg(server, "depth-d1-component");
    const domains = await domainChain(org, "d1cmp");
    const d10 = hop(domains, 10);
    const d9 = hop(domains, 9);
    const rootSvc = await call(org.adminToken, "POST", "/api/v1/services", { name: "d1cmp-svc" });
    expect(rootSvc.status, rootSvc.body).toBe(201);
    const svcId = rootSvc.json().id as string;

    // Two routes up: `contains` from a root service (2 hops) and `domain_id` d10 (11 hops). The
    // SHORT route made this row readable by RBAC before the door — and every `containmentChain`
    // consumer still threw for it, which is the invariant's point: the LONGEST route is the one
    // that has to fit.
    const refused = await call(org.adminToken, "POST", "/api/v1/components", {
      name: "d1cmp-deep",
      service: svcId,
      domainId: d10
    });
    expectDoorRefusal(refused, /object '/, d10, CONTAINMENT_WALK_MAX_DEPTH + 1);

    const ok = await call(org.adminToken, "POST", "/api/v1/components", {
      name: "d1cmp-at-ceiling",
      service: svcId,
      domainId: d9
    });
    expect(ok.status, ok.body).toBe(201);
    const chain = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      containmentChain(tx, org.orgId, ok.json().id as string)
    );
    expect(chain[0]?.typeId).toBe("organization");
  });

  it("D1 via IaC apply — the repo-level door covers the twin that never calls the route helper", async () => {
    const org = await createTestOrg(server, "depth-d1-iac");
    const domains = await domainChain(org, "d1iac");
    const d10 = hop(domains, 10);
    const d9 = hop(domains, 9);

    const applyPlanFor = async (domainId: string, label: string): Promise<Res> => {
      const plan = await call(org.adminToken, "POST", "/api/v1/plans", {
        manifest: {
          stackName: `depth-${label}-${domainId.slice(0, 8)}`,
          objects: [
            {
              urn: `urn:scp:${org.orgId}:service:depth-${label}`,
              typeId: "service",
              name: `depth-${label}`,
              domainId
            }
          ],
          relationships: []
        }
      });
      expect(plan.status, plan.body).toBe(201);
      return call(org.adminToken, "POST", `/api/v1/plans/${plan.json().id as string}/apply`);
    };

    const refused = await applyPlanFor(d10, "deep");
    expect(refused.status, refused.body).toBe(400);
    expect(refused.body).toContain(CONTAINMENT_DEPTH_DOOR_PHRASE);

    const ok = await applyPlanFor(d9, "ceiling");
    expect(ok.status, ok.body).toBe(200);
  });

  // ---------------------------------------------------------------------------------------------
  // D2 — updateObject domain_id MOVE, the subtree counted
  // ---------------------------------------------------------------------------------------------

  it("D2: moving a domain with a three-deep subtree under hop seven is refused NAMING the subtree; under hop six it lands and every row stays readable", async () => {
    const org = await createTestOrg(server, "depth-d2-subtree");
    const domains = await domainChain(org, "d2sub");
    const d7 = hop(domains, 7);
    const d6 = hop(domains, 6);

    // D -> e1 -> e2 -> e3, at the root: D at hop 1, e3 at hop 4. height(D) = 3.
    const mk = async (name: string, domainId?: string): Promise<string> => {
      const r = await call(org.adminToken, "POST", "/api/v1/domains", {
        name,
        ...(domainId === undefined ? {} : { domainId })
      });
      expect(r.status, r.body).toBe(201);
      return r.json().id as string;
    };
    const D = await mk("d2sub-D");
    const e1 = await mk("d2sub-e1", D);
    const e2 = await mk("d2sub-e2", e1);
    const e3 = await mk("d2sub-e3", e2);

    // Under d7: D at 8, e3 at 11. The ROW itself fits — only the subtree makes this refuse, and
    // the message has to say so, because "move it nearer the root" alone would send an operator
    // to inspect the destination when the reason is what they are moving.
    const refused = await call(org.adminToken, "PATCH", `/api/v1/domains/${D}`, { domainId: d7 });
    expectDoorRefusal(refused, D, d7, 8);
    expect(refused.body).toContain("its own subtree is at least 3 deep");
    expect(refused.body).toContain(`depth ${8 + 3}`);
    const stillRoot = await call(org.adminToken, "GET", `/api/v1/domains/${D}`);
    expect((stillRoot.json() as { domainId: string | null }).domainId).toBe(org.orgId);

    // Under d6: D at 7, e3 at 10 — exactly the ceiling. The SAME move, one hop shallower, lands.
    const ok = await call(org.adminToken, "PATCH", `/api/v1/domains/${D}`, { domainId: d6 });
    expect(ok.status, ok.body).toBe(200);
    // THE CONSEQUENCE the invariant buys: every row of the moved subtree is still readable by the
    // org admin — e3, at hop ten, is the one that would have answered 409 one hop deeper.
    for (const id of [D, e1, e2, e3]) {
      const read = await call(org.adminToken, "GET", `/api/v1/domains/${id}`);
      expect(read.status, `${id}: ${read.body}`).toBe(200);
    }
    const chain = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      containmentChain(tx, org.orgId, e3)
    );
    expect(Math.max(...chain.map((e) => e.depth))).toBe(CONTAINMENT_WALK_MAX_DEPTH);
  });

  it("D2: a subtree-less row moved under a hop-ten parent is refused (the row itself past the bound); under hop nine it lands", async () => {
    const org = await createTestOrg(server, "depth-d2-row");
    const domains = await domainChain(org, "d2row");
    const d10 = hop(domains, 10);
    const d9 = hop(domains, 9);
    const svc = await call(org.adminToken, "POST", "/api/v1/services", { name: "d2row-svc" });
    expect(svc.status, svc.body).toBe(201);
    const svcId = svc.json().id as string;

    const refused = await call(org.adminToken, "PATCH", `/api/v1/services/${svcId}`, {
      domainId: d10
    });
    expectDoorRefusal(refused, svcId, d10, CONTAINMENT_WALK_MAX_DEPTH + 1);
    expect(refused.body).not.toContain("subtree");

    const ok = await call(org.adminToken, "PATCH", `/api/v1/services/${svcId}`, { domainId: d9 });
    expect(ok.status, ok.body).toBe(200);
    expect((await call(org.adminToken, "GET", `/api/v1/services/${svcId}`)).status).toBe(200);
  });

  // The two D2 cases above hang the moved row's subtree off `domain_id` (D2-subtree) or off nothing
  // (D2-row). The downward walk has THREE MORE arms — `contains` edges read forwards, and a placement
  // naming the row as component or as target — and each arm needs a case whose subtree hangs off THAT
  // arm alone, or deleting the arm leaves the suite green while a hop-eleven row lands (verifier
  // mutations M6b/M6c, 2026-08-18: neutering the `contains` arm or the `deploymentTargetId` arm left
  // 29/29 green; only the `domain_id` and `componentId` arms had a pin). The `componentId` arm is
  // pinned by D3's PUT-service case below; these two pin the other two.

  it("D2 (`contains` arm): moving a service whose subtree hangs off `contains` edges — service -> assembly -> component — is refused naming the subtree; one hop shallower it lands with the component at exactly the ceiling", async () => {
    const org = await createTestOrg(server, "depth-d2-contains-arm");
    const domains = await domainChain(org, "d2con");
    const d8 = hop(domains, 8);
    const d7 = hop(domains, 7);

    // S -> A -> C over `contains` ONLY: the assembly and the component both carry `domainId: null`
    // (the org root), so the moved row's `domain_id` arm finds nothing under S and the ONLY route
    // that can count height(S) = 2 is the forwards `contains` arm.
    const svc = await call(org.adminToken, "POST", "/api/v1/services", { name: "d2con-svc" });
    expect(svc.status, svc.body).toBe(201);
    const svcId = svc.json().id as string;
    const asm = await call(org.adminToken, "POST", "/api/v1/assemblies", { name: "d2con-asm" });
    expect(asm.status, asm.body).toBe(201);
    const asmId = asm.json().id as string;
    const edge = await call(org.adminToken, "POST", "/api/v1/relationships", {
      typeId: "contains",
      fromId: svcId,
      toId: asmId
    });
    expect(edge.status, edge.body).toBe(201);
    const cmp = await call(org.adminToken, "POST", "/api/v1/components", {
      name: "d2con-cmp",
      service: asmId,
      domainId: null
    });
    expect(cmp.status, cmp.body).toBe(201);
    const cmpId = cmp.json().id as string;

    // Under d8: S at 9 (fits), A at 10 (fits), C at 11. Only the `contains` subtree makes this
    // refuse. Before the arm was pinned, neutering it turned this PATCH into a 200 and
    // `containmentChain(C)` into ADR-0037's 409.
    const refused = await call(org.adminToken, "PATCH", `/api/v1/services/${svcId}`, {
      domainId: d8
    });
    expectDoorRefusal(refused, svcId, d8, 9);
    expect(refused.body).toContain("its own subtree is at least 2 deep");
    expect(refused.body).toContain(`depth ${9 + 2}`);
    const still = await call(org.adminToken, "GET", `/api/v1/services/${svcId}`);
    expect((still.json() as { domainId: string | null }).domainId).toBe(org.orgId);

    // Under d7: S at 8, A at 9, C at 10 — the ceiling. The SAME move, one hop shallower, lands, and
    // every row of the moved subtree is still readable with a complete chain.
    const ok = await call(org.adminToken, "PATCH", `/api/v1/services/${svcId}`, { domainId: d7 });
    expect(ok.status, ok.body).toBe(200);
    for (const [url, id] of [
      ["services", svcId],
      ["assemblies", asmId],
      ["components", cmpId]
    ] as const) {
      const read = await call(org.adminToken, "GET", `/api/v1/${url}/${id}`);
      expect(read.status, `${url}/${id}: ${read.body}`).toBe(200);
    }
    const chain = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      containmentChain(tx, org.orgId, cmpId)
    );
    expect(chain[0]?.typeId).toBe("organization");
    expect(chain.some((e) => e.id === d7)).toBe(true);
    expect(Math.max(...chain.map((e) => e.depth))).toBe(CONTAINMENT_WALK_MAX_DEPTH);
  });

  it("D2 (`deploymentTargetId` arm): moving a deployment-target that has a placement under hop nine is refused naming the subtree; under hop eight it lands and the placement's chain is complete at exactly the ceiling", async () => {
    const org = await createTestOrg(server, "depth-d2-target-arm");
    const domains = await domainChain(org, "d2tgt");
    const d9 = hop(domains, 9);
    const d8 = hop(domains, 8);

    // A root deployment-target T with one live placement P (of a root-service component). Nothing
    // has T as its `domain_id` and no `contains` edge leaves T, so height(T) = 1 is visible ONLY
    // through the placement naming T as its deploymentTargetId — route 4, read downwards.
    const rootSvc = await call(org.adminToken, "POST", "/api/v1/services", { name: "d2tgt-svc" });
    expect(rootSvc.status, rootSvc.body).toBe(201);
    const cmp = await call(org.adminToken, "POST", "/api/v1/components", {
      name: "d2tgt-cmp",
      service: rootSvc.json().id as string
    });
    expect(cmp.status, cmp.body).toBe(201);
    const target = await call(org.adminToken, "POST", "/api/v1/deployment-targets", {
      name: "d2tgt-tgt"
    });
    expect(target.status, target.body).toBe(201);
    const targetId = target.json().id as string;
    const placement = await call(org.adminToken, "POST", "/api/v1/placements", {
      component: cmp.json().id as string,
      deploymentTarget: targetId
    });
    expect(placement.status, placement.body).toBe(201);
    const placementId = placement.json().id as string;

    // Under d9: T at 10 (fits), P at 11. Before this arm was pinned, dropping it made this PATCH a
    // 200 and left P a placement no policy, freeze or gate could scope.
    const refused = await call(org.adminToken, "PATCH", `/api/v1/deployment-targets/${targetId}`, {
      domainId: d9
    });
    expectDoorRefusal(refused, targetId, d9, CONTAINMENT_WALK_MAX_DEPTH);
    expect(refused.body).toContain("its own subtree is at least 1 deep");
    expect(refused.body).toContain(`depth ${CONTAINMENT_WALK_MAX_DEPTH + 1}`);
    const still = await call(org.adminToken, "GET", `/api/v1/deployment-targets/${targetId}`);
    expect((still.json() as { domainId: string | null }).domainId).toBe(org.orgId);

    // Under d8: T at 9, P at 10 — the ceiling. Lands, and the placement is readable with a complete
    // chain that runs through T and d8.
    const ok = await call(org.adminToken, "PATCH", `/api/v1/deployment-targets/${targetId}`, {
      domainId: d8
    });
    expect(ok.status, ok.body).toBe(200);
    const read = await call(org.adminToken, "GET", `/api/v1/placements/${placementId}`);
    expect(read.status, read.body).toBe(200);
    const chain = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      containmentChain(tx, org.orgId, placementId)
    );
    expect(chain[0]?.typeId).toBe("organization");
    expect(chain.some((e) => e.id === d8)).toBe(true);
    expect(Math.max(...chain.map((e) => e.depth))).toBe(CONTAINMENT_WALK_MAX_DEPTH);
  });

  // ---------------------------------------------------------------------------------------------
  // D3 — the `contains` edge
  // ---------------------------------------------------------------------------------------------

  it("D3: a component attached to a hop-ten container is refused; attached to a hop-nine one it lands", async () => {
    const org = await createTestOrg(server, "depth-d3-attach");
    const domains = await domainChain(org, "d3att");
    const svcAt10 = await call(org.adminToken, "POST", "/api/v1/services", {
      name: "d3att-svc-10",
      domainId: hop(domains, 9)
    });
    expect(svcAt10.status, svcAt10.body).toBe(201);
    const svcAt9 = await call(org.adminToken, "POST", "/api/v1/services", {
      name: "d3att-svc-9",
      domainId: hop(domains, 8)
    });
    expect(svcAt9.status, svcAt9.body).toBe(201);
    const svc10 = svcAt10.json().id as string;
    const svc9 = svcAt9.json().id as string;

    // `domainId: null` — the org root — so the `domain_id` half of the create (D1) is a provable
    // no-op and the ONLY thing that can refuse is the `contains` door. Before the ruling this was
    // the M22 fixture's own shape and answered 201 (in a policy-less org).
    const refused = await call(org.adminToken, "POST", "/api/v1/components", {
      name: "d3att-deep",
      service: svc10,
      domainId: null
    });
    expectDoorRefusal(refused, /object '/, svc10, CONTAINMENT_WALK_MAX_DEPTH + 1);
    const list = await call(org.adminToken, "GET", `/api/v1/components?limit=100`);
    expect(list.status, list.body).toBe(200);
    expect(JSON.stringify(list.json())).not.toContain("d3att-deep");

    const ok = await call(org.adminToken, "POST", "/api/v1/components", {
      name: "d3att-at-ceiling",
      service: svc9,
      domainId: null
    });
    expect(ok.status, ok.body).toBe(201);
    const chain = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      containmentChain(tx, org.orgId, ok.json().id as string)
    );
    expect(chain[0]?.typeId).toBe("organization");
    expect(Math.max(...chain.map((e) => e.depth))).toBe(CONTAINMENT_WALK_MAX_DEPTH);
  });

  it("D3: PUT /components/{id}/service — an EXISTING component carries its placement with it: refused at hop nine WITH the subtree named, allowed without the placement", async () => {
    const org = await createTestOrg(server, "depth-d3-move");
    const domains = await domainChain(org, "d3mv");
    const svcAt9 = await call(org.adminToken, "POST", "/api/v1/services", {
      name: "d3mv-svc-9",
      domainId: hop(domains, 8)
    });
    expect(svcAt9.status, svcAt9.body).toBe(201);
    const svc9 = svcAt9.json().id as string;
    const rootSvc = await call(org.adminToken, "POST", "/api/v1/services", { name: "d3mv-root" });
    expect(rootSvc.status, rootSvc.body).toBe(201);
    const target = await call(org.adminToken, "POST", "/api/v1/deployment-targets", {
      name: "d3mv-tgt"
    });
    expect(target.status, target.body).toBe(201);

    // `placed`: a root-service component WITH a placement (height 1). `bare`: without (height 0).
    const placed = await call(org.adminToken, "POST", "/api/v1/components", {
      name: "d3mv-placed",
      service: rootSvc.json().id as string
    });
    expect(placed.status, placed.body).toBe(201);
    const placedId = placed.json().id as string;
    const placement = await call(org.adminToken, "POST", "/api/v1/placements", {
      component: placedId,
      deploymentTarget: target.json().id as string
    });
    expect(placement.status, placement.body).toBe(201);
    const bare = await call(org.adminToken, "POST", "/api/v1/components", {
      name: "d3mv-bare",
      service: rootSvc.json().id as string
    });
    expect(bare.status, bare.body).toBe(201);
    const bareId = bare.json().id as string;

    // Under a hop-nine service the component sits at ten (fits) and its placement at eleven: the
    // SUBTREE is the reason, and the message says so.
    const refused = await call(org.adminToken, "PUT", `/api/v1/components/${placedId}/service`, {
      service: svc9
    });
    expectDoorRefusal(refused, placedId, svc9, CONTAINMENT_WALK_MAX_DEPTH);
    expect(refused.body).toContain("its own subtree is at least 1 deep");
    // Nothing moved: the placed component still hangs off the root service.
    const chainPlaced = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      containmentChain(tx, org.orgId, placedId)
    );
    expect(chainPlaced.some((e) => e.id === svc9)).toBe(false);

    // CONTROL — the same move for the component without a placement lands, at exactly the ceiling.
    const ok = await call(org.adminToken, "PUT", `/api/v1/components/${bareId}/service`, {
      service: svc9
    });
    expect(ok.status, ok.body).toBe(200);
    const chainBare = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      containmentChain(tx, org.orgId, bareId)
    );
    expect(chainBare.some((e) => e.id === svc9)).toBe(true);
    expect(Math.max(...chainBare.map((e) => e.depth))).toBe(CONTAINMENT_WALK_MAX_DEPTH);
  });

  it("D3: POST /relationships {contains} — the generic edge door — refuses an assembly under a hop-ten service and admits it under hop nine", async () => {
    const org = await createTestOrg(server, "depth-d3-generic");
    const domains = await domainChain(org, "d3gen");
    const svcAt10 = await call(org.adminToken, "POST", "/api/v1/services", {
      name: "d3gen-svc-10",
      domainId: hop(domains, 9)
    });
    expect(svcAt10.status, svcAt10.body).toBe(201);
    const svcAt9 = await call(org.adminToken, "POST", "/api/v1/services", {
      name: "d3gen-svc-9",
      domainId: hop(domains, 8)
    });
    expect(svcAt9.status, svcAt9.body).toBe(201);
    const mkAssembly = async (name: string): Promise<string> => {
      const r = await call(org.adminToken, "POST", "/api/v1/assemblies", { name });
      expect(r.status, r.body).toBe(201);
      return r.json().id as string;
    };
    const asmA = await mkAssembly("d3gen-asm-a");
    const asmB = await mkAssembly("d3gen-asm-b");

    const refused = await call(org.adminToken, "POST", "/api/v1/relationships", {
      typeId: "contains",
      fromId: svcAt10.json().id as string,
      toId: asmA
    });
    expectDoorRefusal(refused, asmA, svcAt10.json().id as string, CONTAINMENT_WALK_MAX_DEPTH + 1);

    const ok = await call(org.adminToken, "POST", "/api/v1/relationships", {
      typeId: "contains",
      fromId: svcAt9.json().id as string,
      toId: asmB
    });
    expect(ok.status, ok.body).toBe(201);
  });

  // ---------------------------------------------------------------------------------------------
  // D4 — the placement pair
  // ---------------------------------------------------------------------------------------------

  it("D4: a placement of a hop-ten COMPONENT is refused (route 3); of a hop-nine one it lands", async () => {
    const org = await createTestOrg(server, "depth-d4-component");
    const domains = await domainChain(org, "d4cmp");
    const rootSvc = await call(org.adminToken, "POST", "/api/v1/services", { name: "d4cmp-svc" });
    expect(rootSvc.status, rootSvc.body).toBe(201);
    const target = await call(org.adminToken, "POST", "/api/v1/deployment-targets", {
      name: "d4cmp-tgt"
    });
    expect(target.status, target.body).toBe(201);
    const targetId = target.json().id as string;
    const mkComponent = async (name: string, domainId: string): Promise<string> => {
      const r = await call(org.adminToken, "POST", "/api/v1/components", {
        name,
        service: rootSvc.json().id as string,
        domainId
      });
      expect(r.status, r.body).toBe(201);
      return r.json().id as string;
    };
    const cmpAt10 = await mkComponent("d4cmp-10", hop(domains, 9));
    const cmpAt9 = await mkComponent("d4cmp-9", hop(domains, 8));

    // Route 3 puts the placement one hop under its component: eleven. Route 4 (the target, at the
    // root) is two hops and would have let RBAC read it — which is exactly why this was 201 before,
    // while `containmentChain` of the new placement threw.
    const refused = await call(org.adminToken, "POST", "/api/v1/placements", {
      component: cmpAt10,
      deploymentTarget: targetId
    });
    expectDoorRefusal(refused, /object '/, cmpAt10, CONTAINMENT_WALK_MAX_DEPTH + 1);
    const none = await call(org.adminToken, "GET", `/api/v1/placements?component=${cmpAt10}`);
    expect(none.status, none.body).toBe(200);
    expect((none.json() as { items: unknown[] }).items).toHaveLength(0);

    const ok = await call(org.adminToken, "POST", "/api/v1/placements", {
      component: cmpAt9,
      deploymentTarget: targetId
    });
    expect(ok.status, ok.body).toBe(201);
    const chain = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      containmentChain(tx, org.orgId, ok.json().id as string)
    );
    expect(chain[0]?.typeId).toBe("organization");
    expect(Math.max(...chain.map((e) => e.depth))).toBe(CONTAINMENT_WALK_MAX_DEPTH);
  });

  it("D4: a placement AT a hop-ten DEPLOYMENT-TARGET is refused (route 4); at a hop-nine one it lands", async () => {
    const org = await createTestOrg(server, "depth-d4-target");
    const domains = await domainChain(org, "d4tgt");
    const rootSvc = await call(org.adminToken, "POST", "/api/v1/services", { name: "d4tgt-svc" });
    expect(rootSvc.status, rootSvc.body).toBe(201);
    const cmp = await call(org.adminToken, "POST", "/api/v1/components", {
      name: "d4tgt-cmp",
      service: rootSvc.json().id as string
    });
    expect(cmp.status, cmp.body).toBe(201);
    const cmpId = cmp.json().id as string;
    const mkTarget = async (name: string, domainId: string): Promise<string> => {
      const r = await call(org.adminToken, "POST", "/api/v1/deployment-targets", {
        name,
        domainId
      });
      expect(r.status, r.body).toBe(201);
      return r.json().id as string;
    };
    const tgtAt10 = await mkTarget("d4tgt-10", hop(domains, 9));
    const tgtAt9 = await mkTarget("d4tgt-9", hop(domains, 8));

    const refused = await call(org.adminToken, "POST", "/api/v1/placements", {
      component: cmpId,
      deploymentTarget: tgtAt10
    });
    expectDoorRefusal(refused, /object '/, tgtAt10, CONTAINMENT_WALK_MAX_DEPTH + 1);

    const ok = await call(org.adminToken, "POST", "/api/v1/placements", {
      component: cmpId,
      deploymentTarget: tgtAt9
    });
    expect(ok.status, ok.body).toBe(201);
    expect(
      (await call(org.adminToken, "GET", `/api/v1/placements/${ok.json().id as string}`)).status
    ).toBe(200);
  });

  // ---------------------------------------------------------------------------------------------
  // D4's ONE bypass — federation hand-fill (closed 2026-08-18)
  // ---------------------------------------------------------------------------------------------

  it("hand-fill: a placement cannot be hand-filled at all (fifth pair-bound door) — the one path that used to plant a hop-eleven placement past D4; a non-pair-bound hand-fill through the same paired peer still lands", async () => {
    const org = await createTestOrg(server, "depth-handfill");
    const domains = await domainChain(org, "hf");
    const rootSvc = await call(org.adminToken, "POST", "/api/v1/services", { name: "hf-svc" });
    expect(rootSvc.status, rootSvc.body).toBe(201);
    const cmpAt10 = await call(org.adminToken, "POST", "/api/v1/components", {
      name: "hf-cmp-10",
      service: rootSvc.json().id as string,
      domainId: hop(domains, 9)
    });
    expect(cmpAt10.status, cmpAt10.body).toBe(201);
    const cmpId = cmpAt10.json().id as string;
    const target = await call(org.adminToken, "POST", "/api/v1/deployment-targets", {
      name: "hf-tgt"
    });
    expect(target.status, target.body).toBe(201);
    const targetId = target.json().id as string;

    // A REAL, PAIRED commander peer, so the ONLY thing between the request and a live row is the
    // refusal under test (`handFillObject` runs its type refusals BEFORE the peer lookup — with a
    // made-up peer the case would be green on the 404 whatever the guard did).
    const peerDomainId = randomUUID();
    const { publicKey } = generateKeyPairSync("ed25519");
    const peer = await call(org.adminToken, "POST", "/api/v1/federation/peers", {
      domainId: peerDomainId,
      name: `hf-cmdr-${peerDomainId.slice(0, 8)}`,
      role: "commander",
      publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64")
    });
    expect(peer.status, peer.body).toBe(201);

    // MEASURED before the fix: this answered 201 (D4 lives in `createPlacement`, which hand-fill
    // never reaches; hand-fill passes no `domainId`, so `createObject`'s org-root shortcut skipped
    // D1 too), `POST /placements` of the SAME pair answered the door's 400, and `containmentChain`
    // of the hand-filled row threw ADR-0037's 409 while `GET /placements/{id}` answered 200.
    const urn = `urn:scp:${org.orgId}:placement:hf-deep`;
    const refused = await call(org.adminToken, "POST", "/api/v1/federation/hand-fill", {
      peer: peerDomainId,
      typeId: "placement",
      urn,
      name: "hf-deep",
      properties: { componentId: cmpId, deploymentTargetId: targetId }
    });
    expect(refused.status, refused.body).toBe(403);
    expect(refused.body).toContain("cannot be hand-filled");
    expect(refused.body).toContain("/api/v1/placements");
    // Nothing landed — no live placement in this org at all, so no row past the bound either.
    const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select({ id: objects.id })
        .from(objects)
        .where(
          and(
            eq(objects.orgId, org.orgId),
            eq(objects.typeId, "placement"),
            isNull(objects.deletedAt)
          )
        )
    );
    expect(rows).toHaveLength(0);
    // And the same pair through the real door is D4's refusal, not a 201.
    const viaDoor = await call(org.adminToken, "POST", "/api/v1/placements", {
      component: cmpId,
      deploymentTarget: targetId
    });
    expectDoorRefusal(viaDoor, /object '/, cmpId, CONTAINMENT_WALK_MAX_DEPTH + 1);

    // CONTROL — hand-fill itself still works through this peer for a type that is not pair-bound,
    // so a refuse-everything reading of the new guard goes red here.
    const ok = await call(org.adminToken, "POST", "/api/v1/federation/hand-fill", {
      peer: peerDomainId,
      typeId: "service",
      urn: `urn:scp:${org.orgId}:service:hf-shadow`,
      name: "hf-shadow"
    });
    expect(ok.status, ok.body).toBe(201);
  });
});
