import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildTestServer,
  createTestOrg,
  createTestUser,
  type TestOrg,
  type TestServer
} from "../test-support/harness.js";

/**
 * THE OTHER END OF THE OVER-BROAD ORG-ROOT REFUSAL.
 *
 * `containment-root-source-and-create-rooting.integration.test.ts` pins R1: moving a ROOT-PARENTED
 * object INTO a container the actor owns stopped demanding org-root authority, because the source
 * check's premise ("the source container's holders lose custody") is false for the org root.
 *
 * The MIRROR was never reasoned about. Moving an object BACK OUT to the top level — the destination
 * IS the org root — still demanded org-root authority, so an actor who fully owns a subtree could not
 * move their own object out of it. That is R3, and the argument that settles it runs in exactly the
 * same direction as R1's:
 *
 *   - The destination check exists because "re-parenting X under V hands every holder of a binding
 *     at-or-above V custody of X" (`graph/containment-parent-authz.ts` §1).
 *   - AFTER a move to the top level, X's chain is `X -> org root`, so the holders who would "gain"
 *     custody are the org root's.
 *   - BEFORE it, X's chain ALREADY terminated at the org root — that is the root-reachability
 *     invariant `assertRootedContainmentParent` enforces on every `domain_id` write, create half
 *     included. The org root's holders therefore already held custody of X.
 *
 * So the custodian set STRICTLY SHRINKS across this move — `{X's holders} u {root's holders}` is a
 * subset of `{X's holders} u {every holder on X -> S -> ... -> root}` — and a move that can only
 * remove custodians is not the escalation the check exists to stop. It is the org root and nothing
 * else: every other destination genuinely adds custodians.
 *
 * ## Why the FIRST case in this file is a success and not a refusal
 *
 * An over-broad refusal and a deliberate one look IDENTICAL from a failing test, and this suite is
 * built almost entirely out of refusals — which is structurally blind to refusing too much. The
 * legitimate direction is therefore asserted first and asserted loudest, and the controls below it
 * exist so a "fix" that simply deleted the destination check would not leave the file green.
 *
 * ## What is deliberately NOT exempt, and is pinned here
 *
 *  - A CREATE at the top level. A fresh row has no chain to already contain the org root, so the
 *    "nobody gains" argument does not run: creating a row at the top level really does hand the org
 *    root's holders a row they did not have. That check lives at the create doors (and at
 *    `iac/plans-repo.ts`'s create branch, which authorizes at `entry.target?.domainId ?? orgId`) and
 *    is untouched.
 *  - A move into any ORDINARY container the actor holds nothing at.
 *  - THE MOVE IS NOT FREE. The SOURCE check still runs, so promoting a row to the top level requires
 *    authority over the container it is LEAVING. "Owns the subtree" is the whole entitlement.
 *
 * Pinned on the HTTP doors AND on the IaC apply door, because `iac/plans-repo.ts` carries its own
 * copy of the destination decision and carried the identical defect — a fix in the helper alone was
 * proven insufficient by mutation on the source-side half one round earlier.
 */
describe("moving an object BACK to the top level — the destination-side org-root exemption", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await buildTestServer();
  });

  afterAll(async () => {
    await server.close();
  });

  async function post(
    token: string,
    url: string,
    payload: Record<string, unknown>
  ): Promise<{ status: number; body: string; json: () => Record<string, unknown> }> {
    const res = await server.app.inject({
      method: "POST",
      url,
      headers: { authorization: `Bearer ${token}` },
      payload
    });
    return { status: res.statusCode, body: res.body, json: () => res.json() };
  }

  async function patchService(
    token: string,
    id: string,
    payload: Record<string, unknown>
  ): Promise<{ status: number; body: string }> {
    const res = await server.app.inject({
      method: "PATCH",
      url: `/api/v1/services/${id}`,
      headers: { authorization: `Bearer ${token}` },
      payload
    });
    return { status: res.statusCode, body: res.body };
  }

  async function getService(
    token: string,
    id: string
  ): Promise<{ status: number; body: string; json: () => Record<string, unknown> }> {
    const res = await server.app.inject({
      method: "GET",
      url: `/api/v1/services/${id}`,
      headers: { authorization: `Bearer ${token}` }
    });
    return { status: res.statusCode, body: res.body, json: () => res.json() };
  }

  interface SubtreeFixture {
    org: TestOrg;
    /** The container the movable row currently lives in. The mover owns THIS, and only this. */
    sourceDomainId: string;
    movableId: string;
    movableUrn: string;
    /**
     * Bound Administrator at `sourceDomainId` and NOWHERE ELSE. Authority expands upward, so this
     * one binding covers the container and everything inside it — "owns the subtree" — while
     * holding nothing whatsoever at the org root.
     */
    ownerToken: string;
  }

  async function makeSubtreeFixture(label: string): Promise<SubtreeFixture> {
    const org = await createTestOrg(server, label);
    const source = await post(org.adminToken, "/api/v1/domains", { name: `${label}-source` });
    expect(source.status, source.body).toBe(201);
    const sourceDomainId = source.json().id as string;

    const movable = await post(org.adminToken, "/api/v1/services", {
      name: `${label}-movable`,
      domainId: sourceDomainId
    });
    expect(movable.status, movable.body).toBe(201);
    const movableId = movable.json().id as string;

    // THE FIXTURE ITSELF, ASSERTED. If `domainId` were ignored at create the row would already be at
    // the org root, the "move" below would be a restatement (which is exempt for an entirely
    // different reason) and every case in this file would pass for the wrong reason.
    expect((await getService(org.adminToken, movableId)).json()).toMatchObject({
      domainId: sourceDomainId
    });

    const owner = await createTestUser(server, org, [
      { role: "Administrator", scope: sourceDomainId }
    ]);

    // AND THE ENTITLEMENT ASSERTED TOO: one binding at the container really does reach the row
    // inside it. Without this the mover might be failing/succeeding for a reason unrelated to the
    // subtree it is supposed to own.
    expect((await getService(owner.token, movableId)).status).toBe(200);

    return {
      org,
      sourceDomainId,
      movableId,
      movableUrn: movable.json().urn as string,
      ownerToken: owner.token
    };
  }

  it("PATCH /services/{id} lets a subtree owner move their OWN object out to the top level", async () => {
    const f = await makeSubtreeFixture("root-dest-patch");

    const res = await patchService(f.ownerToken, f.movableId, { domainId: f.org.orgId });
    // Before the fix this answered 403 naming the ORG ROOT as an unheld destination: an actor who
    // owned the object and the container it was leaving, outright, could not take it out of them.
    expect(res.status, res.body).toBe(200);

    const after = await getService(f.org.adminToken, f.movableId);
    expect((after.json() as { domainId: string | null }).domainId).toBe(f.org.orgId);
  });

  it("nobody GAINED custody — the org root's holders already had it, and the mover LOST theirs", async () => {
    // THE PROPERTY THAT MAKES THE EXEMPTION SOUND, asserted rather than argued. Both halves matter:
    // if the first went red the exemption would be handing out custody, and if the second went red
    // the move would be a way to KEEP a row while removing everyone else from it.
    const f = await makeSubtreeFixture("root-dest-custody");

    // The org-root admin could already read and edit it, BEFORE the move, through the containment
    // chain that terminates at the org root. That is the "before" half of the proof, measured.
    expect((await getService(f.org.adminToken, f.movableId)).status).toBe(200);

    expect((await patchService(f.ownerToken, f.movableId, { domainId: f.org.orgId })).status).toBe(
      200
    );

    // Unchanged, as predicted: the org root was on the chain before and is the whole chain after.
    expect((await getService(f.org.adminToken, f.movableId)).status).toBe(200);
    expect(
      (await patchService(f.org.adminToken, f.movableId, { name: "still-owned" })).status
    ).toBe(200);

    // And the custodian set really did SHRINK — the mover's single binding at the source container
    // no longer reaches the row, because the row is no longer inside it. A move that costs the
    // actor their own authority over the row is not an escalation dressed as a field edit.
    expect((await getService(f.ownerToken, f.movableId)).status).toBe(403);
  });

  it("PATCH {domainId: null} — the same move in its commonest wire shape — is allowed too", async () => {
    // `null` on the wire means "the default containment parent", i.e. the org root
    // (`containment-parent-authz.ts`'s module doc). It reaches the SAME destination by a different
    // value, so a fix that keyed on the literal id and not on the resolved destination would leave
    // this red.
    const f = await makeSubtreeFixture("root-dest-null");

    const res = await patchService(f.ownerToken, f.movableId, { domainId: null });
    expect(res.status, res.body).toBe(200);

    const after = await getService(f.org.adminToken, f.movableId);
    expect((after.json() as { domainId: string | null }).domainId).toBe(f.org.orgId);
  });

  it("PUT /services/{urn} — the upsert door's update branch — allows the same promotion", async () => {
    const f = await makeSubtreeFixture("root-dest-put");

    const res = await server.app.inject({
      method: "PUT",
      url: `/api/v1/services/${encodeURIComponent(f.movableUrn)}`,
      headers: { authorization: `Bearer ${f.ownerToken}` },
      payload: { name: "root-dest-put-movable", domainId: f.org.orgId }
    });
    expect(res.statusCode, res.body).toBe(200);

    const after = await getService(f.org.adminToken, f.movableId);
    expect((after.json() as { domainId: string | null }).domainId).toBe(f.org.orgId);
  });

  it("PATCH /objects/service/{id} — the generic door — allows it as well", async () => {
    const f = await makeSubtreeFixture("root-dest-generic");

    const res = await server.app.inject({
      method: "PATCH",
      url: `/api/v1/objects/service/${f.movableId}`,
      headers: { authorization: `Bearer ${f.ownerToken}` },
      payload: { domainId: f.org.orgId }
    });
    expect(res.statusCode, res.body).toBe(200);

    const after = await getService(f.org.adminToken, f.movableId);
    expect((after.json() as { domainId: string | null }).domainId).toBe(f.org.orgId);
  });

  it("POST /plans/{id}/apply — the apply-path twin, which carried the identical refusal — allows it", async () => {
    const f = await makeSubtreeFixture("root-dest-iac");

    // `domainId` is OMITTED, not set to null, and that is the shape that matters here: the manifest
    // schema documents an absent `domainId` as "defaults to the org root", so `resolveDomainId` turns
    // omission into the org root and the diff records a `domainId` change. This is the shape in which
    // the refusal bit IaC hardest — a stack author who never mentioned containment at all was told
    // they lacked authority at a scope their manifest never named.
    const plan = await post(f.org.adminToken, "/api/v1/plans", {
      manifest: {
        stackName: `iac-root-dest-${f.movableId.slice(0, 8)}`,
        objects: [
          {
            urn: f.movableUrn,
            typeId: "service",
            name: "root-dest-iac-movable"
          }
        ],
        relationships: []
      }
    });
    expect(plan.status, plan.body).toBe(201);

    const applied = await server.app.inject({
      method: "POST",
      url: `/api/v1/plans/${plan.json().id as string}/apply`,
      headers: { authorization: `Bearer ${f.ownerToken}` }
    });
    expect(applied.statusCode, applied.body).toBe(200);

    // NOT VACUOUS: if omitting `domainId` were a no-op rather than a move, the apply would answer 200
    // without exercising the destination check at all. This is the assertion that makes the case
    // above mean something.
    const after = await getService(f.org.adminToken, f.movableId);
    expect((after.json() as { domainId: string | null }).domainId).toBe(f.org.orgId);
  });

  // -----------------------------------------------------------------------------------------------
  // The controls — what makes the four cases above a CHECK that was narrowed, not a check deleted
  // -----------------------------------------------------------------------------------------------

  it("the exemption is the ORG ROOT and nothing else — a move into an unheld ordinary container is still refused", async () => {
    // Widen the exemption from "the org root" to "any destination" — or just delete the destination
    // check — and THIS is the case that goes red.
    const f = await makeSubtreeFixture("root-dest-control");
    const stranger = await post(f.org.adminToken, "/api/v1/domains", {
      name: "root-dest-stranger"
    });
    expect(stranger.status, stranger.body).toBe(201);
    const strangerId = stranger.json().id as string;

    const res = await patchService(f.ownerToken, f.movableId, { domainId: strangerId });
    expect(res.status, res.body).toBe(403);
    // Names the DESTINATION: the actor holds the source, so a message naming the source would send
    // them to fix a permission they already have.
    expect(res.body).toContain(strangerId);

    const after = await getService(f.org.adminToken, f.movableId);
    expect((after.json() as { domainId: string | null }).domainId).toBe(f.sourceDomainId);
  });

  it("the SOURCE check still runs on a move to the top level — promotion is not a free move", async () => {
    // The exemption is on the DESTINATION end only. An actor bound at the OBJECT alone — with
    // nothing at the container it sits in — must not be able to promote itself out of that
    // container's custody, and this is the case that goes red if the exemption is written as "skip
    // both ends when the destination is the org root".
    const org = await createTestOrg(server, "root-dest-source-still");
    const source = await post(org.adminToken, "/api/v1/domains", { name: "still-checked-source" });
    expect(source.status, source.body).toBe(201);
    const sourceDomainId = source.json().id as string;

    const movable = await post(org.adminToken, "/api/v1/services", {
      name: "still-checked-movable",
      domainId: sourceDomainId
    });
    expect(movable.status, movable.body).toBe(201);
    const movableId = movable.json().id as string;

    // Bound AT the object and nowhere else — the "whose entire authority is 'write this one object'"
    // actor the module doc names.
    const narrow = await createTestUser(server, org, [{ role: "Administrator", scope: movableId }]);

    const res = await patchService(narrow.token, movableId, { domainId: org.orgId });
    expect(res.status, res.body).toBe(403);
    expect(res.body).toContain(sourceDomainId);

    const after = await getService(org.adminToken, movableId);
    expect((after.json() as { domainId: string | null }).domainId).toBe(sourceDomainId);
  });

  it("a CREATE at the top level is NOT exempt — a fresh row really does hand the org root a new child", async () => {
    // The boundary of the exemption, and the reason it cannot simply be "the org root is never a
    // scope worth checking". A move's destination check is redundant at the org root because the row
    // was already inside the org root's subtree; a CREATE has no such history, so the org root's
    // holders genuinely acquire something. Both create doors are pinned: the HTTP one here, and the
    // IaC one below, which authorizes at `entry.target?.domainId ?? orgId` in its own branch.
    const f = await makeSubtreeFixture("root-dest-create");

    const res = await post(f.ownerToken, "/api/v1/services", { name: "top-level-newcomer" });
    expect(res.status, res.body).toBe(403);

    const iacPlan = await post(f.org.adminToken, "/api/v1/plans", {
      manifest: {
        stackName: `iac-root-create-${f.movableId.slice(0, 8)}`,
        objects: [
          {
            urn: `urn:scp:${f.org.orgName}:service:top-level-newcomer-iac`,
            typeId: "service",
            name: "top-level-newcomer-iac"
          }
        ],
        relationships: []
      }
    });
    expect(iacPlan.status, iacPlan.body).toBe(201);

    const applied = await server.app.inject({
      method: "POST",
      url: `/api/v1/plans/${iacPlan.json().id as string}/apply`,
      headers: { authorization: `Bearer ${f.ownerToken}` }
    });
    expect(applied.statusCode, applied.body).toBe(403);
  });
});
