import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { objects } from "../db/schema.js";
import { withTenantTx } from "../db/tenant-tx.js";
import {
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/**
 * ADOPTION, AND THE THEFT IT IS NOT (proposal section 9, increment 7).
 *
 * Two halves of one read of `managed_by_stack`:
 *
 *  1. **Adoption is legal and VISIBLE.** A stack may claim an object no stack manages — that is how
 *     an existing estate comes under IaC, and the whole purpose of `scp iac export`. Section 9
 *     requires the plan to SAY SO, because it is the one action whose blast radius is invisible from
 *     the manifest alone: the manifest looks identical whether the URN is new or forty other things
 *     already point at it.
 *
 *  2. **Cross-stack adoption is refused.** Before this, `stampObjectStackOwnership`'s predicate was
 *     `managed_by_stack IS NULL OR <> $stack`, so an apply re-stamped ANY object in its diff,
 *     including one another stack owned — its own header treated that as the design. The effect was
 *     silent takeover, after which the losing stack's next apply either proposes deleting rows it no
 *     longer owns, or proposes nothing for an object it still believes it manages.
 *
 * MUTATION LOG - each applied, watched fail, reverted, watched pass (MEASURED)
 * | Mutation | Result |
 * |---|---|
 * | `computePlanDiff` stops collecting ownership conflicts | (3) FAILS — the thief's plan computes and the takeover proceeds |
 * | `prepareApplyChecks` skips `assertNoStackTheftAtApply` | (4) FAILS — a plan computed while the object was unmanaged still steals it after another stack claimed it. (3) stays GREEN, which is the point of having both doors: plan-time alone does not cover the review-then-apply gap. |
 * | the `adopted` qualifier is never set | (1) and (2) FAIL — an adoption becomes indistinguishable from an ordinary update |
 */
describe("IaC adoption and stack-theft refusal", () => {
  let server: ListeningTestServer;
  let org: TestOrg;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "adopt");
  });

  afterAll(async () => {
    await server.close();
  });

  async function plan(manifest: Record<string, unknown>) {
    const res = await server.app.inject({
      method: "POST",
      url: "/api/v1/plans",
      headers: { authorization: `Bearer ${org.adminToken}` },
      payload: { manifest } as never
    });
    return { status: res.statusCode, body: res.body === "" ? {} : (res.json() as never) };
  }

  async function apply(planId: string) {
    const res = await server.app.inject({
      method: "POST",
      url: `/api/v1/plans/${planId}/apply`,
      headers: { authorization: `Bearer ${org.adminToken}` }
    });
    return { status: res.statusCode, body: res.body === "" ? {} : (res.json() as never) };
  }

  function serviceManifest(stackName: string, urn: string, name: string, props = {}) {
    return {
      stackName,
      objects: [{ urn, typeId: "service", name, properties: props }],
      relationships: []
    };
  }

  /** An object no stack manages — created through the ordinary typed door, exactly as a
   *  pre-IaC estate's objects were. */
  async function unmanagedService(label: string) {
    const res = await server.app.inject({
      method: "POST",
      url: "/api/v1/objects/service",
      headers: { authorization: `Bearer ${org.adminToken}` },
      payload: { name: `svc-${label}-${randomUUID().slice(0, 8)}` } as never
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as { id: string; urn: string; name: string };
  }

  async function ownerOf(urn: string): Promise<string | null> {
    const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select({ managedByStack: objects.managedByStack })
        .from(objects)
        .where(and(eq(objects.orgId, org.orgId), eq(objects.urn, urn)))
    );
    return rows[0]?.managedByStack ?? null;
  }

  it("(1) claiming an UNMANAGED object is marked `adopted`, and the reason says so", async () => {
    const existing = await unmanagedService("a");
    expect(await ownerOf(existing.urn)).toBeNull();

    const stackName = `stack-${randomUUID().slice(0, 8)}`;
    const created = await plan(
      serviceManifest(stackName, existing.urn, existing.name, { tier: "gold" })
    );
    expect(created.status).toBe(201);

    const entry = (created.body as { diff: { objects: { adopted?: boolean; reason: string }[] } })
      .diff.objects[0];
    expect(entry?.adopted).toBe(true);
    expect(entry?.reason).toContain("ADOPTING");

    const applied = await apply((created.body as { id: string }).id);
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    expect(await ownerOf(existing.urn)).toBe(stackName);
  });

  it("(2) the noop+adopted branch is reachable exactly where the LABELS LIE — which is why the column exists", async () => {
    const existing = await unmanagedService("b");
    const stackName = `stack-${randomUUID().slice(0, 8)}`;

    // MEASURED CORRECTION to this case's first version, which expected a plain adoption to be a
    // `noop`: it is not, and cannot be. `managedLabels()` is merged into the diff target, so
    // adopting an unmanaged object always changes `labels` at minimum and therefore always shows as
    // an `update`. Asserting `noop` there was asserting something false about the design.
    //
    // The branch IS reachable, and only through the hazard `managed_by_stack` was introduced for
    // (drizzle/0068): someone hand-writes the descriptive labels onto an object at plain
    // `object:write`, so the labels claim IaC ownership while the server-written column says
    // nobody owns it. The declared state then matches byte-for-byte — a genuine `noop` — while
    // ownership still changes on apply. Calling that a plain no-op would hide the only thing that
    // happens, which is precisely the "a description is not an assertion" failure.
    const patched = await server.app.inject({
      method: "PATCH",
      url: `/api/v1/objects/service/${existing.id}`,
      headers: { authorization: `Bearer ${org.adminToken}` },
      payload: {
        labels: { "scp:managed-by": "iac", "scp:stack": stackName }
      } as never
    });
    expect(patched.statusCode, patched.body).toBe(200);
    // The labels say managed; the column still says nobody.
    expect(await ownerOf(existing.urn)).toBeNull();

    const created = await plan(serviceManifest(stackName, existing.urn, existing.name));
    const entry = (
      created.body as { diff: { objects: { action: string; adopted?: boolean; reason: string }[] } }
    ).diff.objects[0];
    expect(entry?.action).toBe("noop");
    expect(entry?.adopted).toBe(true);
    expect(entry?.reason).toContain("ADOPTING");

    await apply((created.body as { id: string }).id);
    // The apply stamped the COLUMN, which is what any later prune will read — not the labels that
    // were already there.
    expect(await ownerOf(existing.urn)).toBe(stackName);
  });

  it("(3) a stack claiming ANOTHER stack's object is refused at PLAN time, naming the owner", async () => {
    const existing = await unmanagedService("c");
    const first = `stack-first-${randomUUID().slice(0, 8)}`;
    const firstPlan = await plan(serviceManifest(first, existing.urn, existing.name));
    await apply((firstPlan.body as { id: string }).id);
    expect(await ownerOf(existing.urn)).toBe(first);

    const thief = `stack-thief-${randomUUID().slice(0, 8)}`;
    const stolen = await plan(
      serviceManifest(thief, existing.urn, existing.name, { tier: "gold" })
    );
    expect(stolen.status).toBe(409);
    const detail = (stolen.body as { detail: string }).detail;
    expect(detail).toContain(existing.urn);
    // Names the OWNER, so the operator knows which manifest to change rather than only that
    // something is wrong.
    expect(detail).toContain(first);

    expect(await ownerOf(existing.urn)).toBe(first);
  });

  it("(4) a plan computed while the object was unmanaged CANNOT steal it after another stack claims it", async () => {
    const existing = await unmanagedService("d");

    // Plan computed FIRST, while the object is genuinely adoptable — so the stored diff says
    // `adopted` and plan-time refusal has already passed.
    const late = `stack-late-${randomUUID().slice(0, 8)}`;
    const latePlan = await plan(serviceManifest(late, existing.urn, existing.name));
    expect(latePlan.status).toBe(201);

    // …then another stack claims it in between review and apply.
    const winner = `stack-winner-${randomUUID().slice(0, 8)}`;
    const winPlan = await plan(serviceManifest(winner, existing.urn, existing.name));
    await apply((winPlan.body as { id: string }).id);
    expect(await ownerOf(existing.urn)).toBe(winner);

    // The stale plan is refused at APPLY, against live ownership. This is the door that matters:
    // the stored diff still says `adopted`, and trusting it would make the guard exactly as stale
    // as the thing it guards against.
    const applied = await apply((latePlan.body as { id: string }).id);
    expect(applied.status).toBe(409);
    expect(await ownerOf(existing.urn)).toBe(winner);
  });
});
