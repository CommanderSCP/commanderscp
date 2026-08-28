import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildTestServer,
  createTestOrg,
  type TestOrg,
  type TestServer
} from "../test-support/harness.js";

/**
 * ================================================================================================
 * `fromRole` AUTHORING-TIME VALIDATION — role-model.md §5 step 6
 * ================================================================================================
 *
 * THE FAILURE IT REPLACES. Since the quorum-bypass fix, `hasRoleAtScope` resolves BUILT-IN role
 * names only. So a policy naming anything else is not merely wrong — it is UNSATISFIABLE: the gate
 * blocks forever, the Decision reads "0 of 1 approvals", and an operator staring at a live binding
 * of a role with exactly that name concludes the approval engine is broken. A typo and a custom
 * role produce an identical symptom, and nothing anywhere states what a legal value is.
 *
 * Entered through HTTP, and through BOTH verbs, because the guard sits at the `objects-repo`
 * choke point precisely so that every writer inherits it — a route-level check would have left the
 * update path and IaC apply able to author the unsatisfiable policy.
 */
describe("a policy's requireApprovals.fromRole must name a built-in role", () => {
  let server: TestServer;
  let org: TestOrg;

  beforeAll(async () => {
    server = await buildTestServer();
    org = await createTestOrg(server, "fromrole");
  });

  afterAll(async () => {
    await server?.app.close();
  });

  function policyBody(fromRole: string, name: string) {
    return {
      name,
      urn: `urn:scp:${org.orgId}:policy:${name}`,
      properties: {
        enforcement: "required",
        effects: [{ requireApprovals: { count: 1, fromRole, scope: "organization" } }]
      }
    };
  }

  // `/api/v1/policies`, NOT `/api/v1/objects/policy`: `policy` is a governance-managed type and the
  // generic object door refuses it outright (403), because that door cannot check the scope
  // authority `policy:write` requires. Writing this test against the generic endpoint would have
  // exercised that refusal instead of this guard — every case would have "failed correctly" for
  // entirely the wrong reason.
  async function createPolicy(fromRole: string, name: string) {
    return server.app.inject({
      method: "POST",
      url: "/api/v1/policies",
      headers: { authorization: `Bearer ${org.adminToken}` },
      payload: policyBody(fromRole, name)
    });
  }

  it("ACCEPTS a built-in role name — the guard narrows authoring, it does not block it", async () => {
    // First and load-bearing: a validator that refused everything would make every assertion below
    // pass while making the policy surface unusable.
    const res = await createPolicy("Approver", `ok-${Date.now()}`);
    expect(res.statusCode, res.body).toBe(201);
  });

  it("REFUSES an unknown role name, and the refusal NAMES it", async () => {
    const res = await createPolicy("Onwer", `typo-${Date.now()}`);
    expect(res.statusCode).toBe(422);
    const detail = res.json().detail as string;
    // The typo case. Naming the offending value is the difference between a fixable refusal and
    // "422 Unprocessable Entity" against a document with a dozen fields.
    expect(detail).toContain("'Onwer'");
  });

  it("the refusal LISTS the catalogue — the legal values were previously stated nowhere", async () => {
    const res = await createPolicy("SomethingElse", `list-${Date.now()}`);
    const detail = res.json().detail as string;
    expect(detail).toContain("Approver");
    expect(detail).toContain("Owner");
  });

  it("REFUSES a role the org could plausibly own — the custom-role case, not just typos", async () => {
    // This is the case the quorum fix creates and this guard closes: 'ReleaseCaptain' is a
    // perfectly reasonable custom role name, and a policy naming it would block forever.
    const res = await createPolicy("ReleaseCaptain", `custom-${Date.now()}`);
    expect(res.statusCode).toBe(422);
    expect(res.json().detail as string).toContain("'ReleaseCaptain'");
  });

  it("guards PATCH — the `updateObject` path, which is a DIFFERENT choke point from create", async () => {
    const name = `patchable-${Date.now()}`;
    const created = await createPolicy("Approver", name);
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id as string;

    const edited = await server.app.inject({
      method: "PATCH",
      url: `/api/v1/policies/${id}`,
      headers: { authorization: `Bearer ${org.adminToken}` },
      payload: {
        properties: {
          enforcement: "required",
          effects: [{ requireApprovals: { count: 1, fromRole: "NotARole", scope: "organization" } }]
        }
      }
    });
    // MEASURED, NOT ASSUMED — and the first version of this test was VACUOUS. It used PUT with a
    // body whose name/urn were rebuilt from a fresh `Date.now()`, so the urn did not match the
    // policy just created; `upsertObjectByUrn` found nothing and took its CREATE branch. Deleting
    // the update guard left the whole file green while deleting the create guard reddened this
    // case — the tell that it was exercising create twice and update never.
    //
    // PATCH is the verb that reaches `updateObject` (routes/typed-registries.ts), so this is the
    // assertion the update choke point actually answers for.
    expect(edited.statusCode, edited.body).toBe(422);
    expect(edited.json().detail as string).toContain("'NotARole'");
  });

  it("guards PUT on an existing urn — whichever branch of the upsert it takes", async () => {
    const name = `puttable-${Date.now()}`;
    const created = await createPolicy("Approver", name);
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id as string;

    const edited = await server.app.inject({
      method: "PUT",
      url: `/api/v1/policies/${id}`,
      headers: { authorization: `Bearer ${org.adminToken}` },
      // The SAME name, so the SAME urn.
      //
      // WHICH BRANCH THIS TAKES IS MEASURED, AND IT IS NOT THE ONE THE OBVIOUS READING SUGGESTS:
      // deleting the CREATE guard reds this case and deleting the UPDATE guard does not, so PUT is
      // answered by `createObject` even against a matching urn. `upsertObjectByUrn` has three
      // branches — create, a direct in-place `UPDATE ... SET` for the hand-filled-id case, and
      // `updateObject` — and this test deliberately does not assert which one runs. It asserts the
      // REFUSAL, which is the property; the PATCH case above is what pins the update choke point.
      payload: policyBody("NotARole", name)
    });
    expect(edited.statusCode, edited.body).toBe(422);
    expect(edited.json().detail as string).toContain("'NotARole'");
  });

  it("a policy with no requireApprovals at all is untouched", async () => {
    const name = `nocontrols-${Date.now()}`;
    const res = await server.app.inject({
      method: "POST",
      url: "/api/v1/policies",
      headers: { authorization: `Bearer ${org.adminToken}` },
      payload: {
        name,
        urn: `urn:scp:${org.orgId}:policy:${name}`,
        properties: {
          enforcement: "advisory",
          effects: [{ requireControls: ["security-scan"] }]
        }
      }
    });
    // The guard must not have opinions about effects it does not govern.
    expect(res.statusCode, res.body).toBe(201);
  });

  it("a non-policy object carrying a lookalike document is untouched", async () => {
    const res = await server.app.inject({
      method: "POST",
      url: "/api/v1/objects/service",
      headers: { authorization: `Bearer ${org.adminToken}` },
      payload: {
        name: `svc-${Date.now()}`,
        properties: {
          effects: [{ requireApprovals: { count: 1, fromRole: "NotARole", scope: "organization" } }]
        }
      }
    });
    // Scoped to `typeId === "policy"`. A service that happens to carry an `effects` property is not
    // a policy and nothing resolves quorums from it, so refusing it would be a guard inventing
    // jurisdiction.
    expect(res.statusCode, res.body).toBe(201);
  });
});
