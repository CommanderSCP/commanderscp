import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { and, eq, isNull, sql } from "drizzle-orm";
import { ScpApiError, ScpClient } from "@scp/sdk";
import type { DesiredStateManifest } from "@scp/schemas";
import {
  createTestOrg,
  createTestUser,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { objects, relationships } from "../db/schema.js";

/** THE `member_of` SUBSET RULE IS AT THE CHOKE POINT, NOT AT THE ROUTE. See docs/iac.md §28. */
describe("the member_of subset rule is enforced on the IaC apply path (role-binding-door §2a)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "iac-memberof");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  });

  afterAll(async () => {
    await server?.close();
  });

  async function objectIdByUrn(urn: string): Promise<string> {
    const row = await withTenantTx(server.deps.db, org.orgId, async (tx) =>
      tx.query.objects.findFirst({
        where: (t, { eq: e, and: a }) => a(e(t.orgId, org.orgId), e(t.urn, urn))
      })
    );
    if (!row) throw new Error(`no object with urn '${urn}'`);
    return row.id;
  }

  async function liveMemberOfEdges(fromId: string, toId: string) {
    return withTenantTx(server.deps.db, org.orgId, async (tx) =>
      tx
        .select({ id: relationships.id })
        .from(relationships)
        .where(
          and(
            eq(relationships.orgId, org.orgId),
            eq(relationships.typeId, "member_of"),
            eq(relationships.fromId, fromId),
            eq(relationships.toId, toId),
            isNull(relationships.deletedAt)
          )
        )
    );
  }

  it("IaC apply cannot mint the escalating edge either — and CAN mint the harmless one", async () => {
    const stackName = `memberof-${uuidv7().slice(0, 8)}`;
    const groupUrn = `urn:scp:${stackName}:group:power`;
    const plainUrn = `urn:scp:${stackName}:group:plain`;

    // The estate, applied by the Owner: two groups. The JOINER is not declared here — it is a real
    // logged-in principal created by the harness, because the actor and the joiner must be the same
    // subject for this to be the self-join the finding measured.
    const base: DesiredStateManifest = {
      stackName,
      objects: [
        { urn: groupUrn, typeId: "group", name: `power-${stackName}` },
        { urn: plainUrn, typeId: "group", name: `plain-${stackName}` }
      ],
      relationships: []
    };
    const basePlan = await admin.plans.create(base);
    await admin.plans.apply(basePlan.id);

    const powerGroupId = await objectIdByUrn(groupUrn);
    const plainGroupId = await objectIdByUrn(plainUrn);

    // STEP 1 of the chain — bind Owner to the power group. Written raw because this is a FIXTURE:
    // it is the state a legitimate operator's `POST /role-bindings` produces ("bind SecurityOfficer
    // to the security team"), and the route suite is where that grant itself is measured.
    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      await tx.execute(sql`
        INSERT INTO role_bindings (id, org_id, subject_id, role_id, scope_object_id, effect)
        SELECT gen_random_uuid(), ${org.orgId}::uuid, ${powerGroupId}::uuid, rl.id,
               ${org.orgId}::uuid, 'allow'
        FROM roles rl WHERE rl.org_id IS NULL AND rl.name = 'Owner'
      `);
    });

    // The attacker: an org-root Operator. It holds `relationship:write` at every object in the org,
    // so `prepareApplyChecks`' both-endpoint bar — the only relationship authority IaC apply has —
    // is satisfied at both ends, exactly as it is on `POST /relationships`.
    const operator = await createTestUser(server, org, [{ role: "Operator", scope: org.orgId }]);
    const operatorClient = new ScpClient({ baseUrl: server.baseUrl, token: operator.token });
    // The joiner's graph object must be nameable by URN for the manifest to reference it. The
    // harness mints users without one, so it is stamped here — this is fixture plumbing, not the
    // thing under test.
    const joinerUrn = `urn:scp:${stackName}:user:attacker`;
    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      await tx
        .update(objects)
        .set({ urn: joinerUrn })
        .where(and(eq(objects.orgId, org.orgId), eq(objects.id, operator.objectId)));
    });

    // THE HARMLESS EDGE FIRST — the admission half, and the proof that this actor can drive an IaC
    // apply that writes a `member_of` edge at all. Without it a refusal below could mean the
    // Operator cannot apply plans, cannot write edges, or cannot reach these objects.
    const harmless: DesiredStateManifest = {
      ...base,
      relationships: [{ typeId: "member_of", fromUrn: joinerUrn, toUrn: plainUrn }]
    };
    const harmlessPlan = await operatorClient.plans.create(harmless);
    await operatorClient.plans.apply(harmlessPlan.id);
    expect(
      await liveMemberOfEdges(operator.objectId, plainGroupId),
      "an Operator must still be able to declare ordinary group membership in IaC"
    ).toHaveLength(1);

    // THE ESCALATING EDGE — identical shape, identical actor, identical door. The only difference is
    // that THIS group holds a role binding the Operator does not hold.
    const escalating: DesiredStateManifest = {
      ...base,
      relationships: [
        { typeId: "member_of", fromUrn: joinerUrn, toUrn: plainUrn },
        { typeId: "member_of", fromUrn: joinerUrn, toUrn: groupUrn }
      ]
    };
    const escalatingPlan = await operatorClient.plans.create(escalating);
    const failure = await operatorClient.plans
      .apply(escalatingPlan.id)
      .then(() => null)
      .catch((err: unknown) => err);
    expect(failure, "the escalating apply must be REFUSED, not resolved").toBeInstanceOf(
      ScpApiError
    );
    const problem = failure as ScpApiError;
    expect(problem.status, JSON.stringify(problem.problem)).toBe(403);
    // §2a's refusal and not the both-endpoint `relationship:write` bar, read off the message rather
    // than inferred from the status code — both throw 403.
    expect(JSON.stringify(problem.problem)).toContain("no-escalation subset rule");

    // THE EDGE DID NOT LAND, read from the table. An apply that wrote the row and threw afterwards
    // would satisfy the status assertion and leave the estate escalated.
    expect(await liveMemberOfEdges(operator.objectId, powerGroupId)).toHaveLength(0);
  });
});
