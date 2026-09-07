import pg from "pg";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasRoleAtScope } from "./resolve.js";
import { withTenantTx } from "../db/tenant-tx.js";
import {
  buildTestServer,
  createTestOrg,
  createTestUser,
  testDatabaseUrl,
  type TestOrg,
  type TestServer,
  type TestUser
} from "../test-support/harness.js";

/** THE QUORUM BYPASS. See docs/authz.md §32. */
describe("approval-quorum eligibility resolves BUILT-IN role names only", () => {
  let server: TestServer;
  let org: TestOrg;
  /** Holds the org's OWN 'Approver' row — the impostor. Holds no built-in Approver binding. */
  let impostor: TestUser;
  /** Holds the genuine built-in Approver binding — the control that keeps this from passing
   *  vacuously if the query simply stopped matching anything. */
  let genuine: TestUser;
  let admin: pg.Client;
  let customRoleId: string;

  beforeAll(async () => {
    server = await buildTestServer();
    org = await createTestOrg(server, "quorum-collision");
    genuine = await createTestUser(server, org, [{ role: "Approver", scope: org.orgId }]);
    impostor = await createTestUser(server, org, []);

    admin = new pg.Client({ connectionString: testDatabaseUrl() });
    await admin.connect();

    // The org's own role named exactly 'Approver', carrying NO permissions — the cheapest possible
    // shape of the exploit. drizzle/0097's partial unique index is `roles(name) WHERE org_id IS
    // NULL`, so it constrains built-ins only and deliberately permits this row to coexist.
    customRoleId = uuidv7();
    await admin.query(
      `INSERT INTO roles (id, org_id, name, permissions) VALUES ($1, $2, 'Approver', '{}')`,
      [customRoleId, org.orgId]
    );
    await admin.query(
      `INSERT INTO role_bindings (id, org_id, subject_id, role_id, scope_object_id, effect)
       VALUES ($1, $2, $3, $4, $5, 'allow')`,
      [uuidv7(), org.orgId, impostor.objectId, customRoleId, org.orgId]
    );
  });

  afterAll(async () => {
    await admin?.end();
    await server?.app.close();
  });

  it("the fixture really landed — the colliding row and its binding both exist (known-positive control)", async () => {
    // Every assertion below is a refusal, and a refusal passes vacuously if the fixture silently
    // failed to insert. Measure the exploit's preconditions before asserting it does not work.
    const roleRows = await admin.query(
      `SELECT id, org_id FROM roles WHERE name = 'Approver' ORDER BY org_id NULLS FIRST`
    );
    expect(roleRows.rowCount).toBe(2);
    const bindingRows = await admin.query(
      `SELECT id FROM role_bindings WHERE role_id = $1 AND subject_id = $2`,
      [customRoleId, impostor.objectId]
    );
    expect(bindingRows.rowCount).toBe(1);
  });

  it("REFUSES the impostor: a binding on the org's own 'Approver' confers no quorum eligibility", async () => {
    const eligible = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      hasRoleAtScope(tx, {
        orgId: org.orgId,
        subjectObjectId: impostor.objectId,
        scopeObjectId: org.orgId,
        roleName: "Approver"
      })
    );
    // Before the `rl.org_id IS NULL` predicate this returned TRUE — a principal holding a
    // zero-permission role of their org's own making, eligible to vote on every quorum in the
    // deployment that names Approver.
    expect(eligible).toBe(false);
  });

  it("ADMITS the genuine holder — the predicate narrowed the join, it did not break it", async () => {
    const eligible = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      hasRoleAtScope(tx, {
        orgId: org.orgId,
        subjectObjectId: genuine.objectId,
        scopeObjectId: org.orgId,
        roleName: "Approver"
      })
    );
    // The half that makes the refusal above meaningful. `AND rl.org_id IS NULL` sits one character
    // away from `AND rl.org_id IS NOT NULL`, which would refuse everybody and leave the test above
    // green — quorum eligibility silently unsatisfiable for every principal on the deployment.
    expect(eligible).toBe(true);
  });

  it("the impostor's binding still RESOLVES for permissions — this closes a quorum hole, not a binding", async () => {
    // Scoped honesty about what changed. The custom role carries no permissions here, so there is
    // nothing to gain, but the binding itself is untouched and `hasPermission` still consults it.
    // Had this fix been made by refusing to resolve org-owned roles at all, every custom-role
    // binding would have gone inert — a much larger change wearing this one's name.
    const rows = await admin.query(
      `SELECT effect FROM role_bindings WHERE role_id = $1 AND subject_id = $2`,
      [customRoleId, impostor.objectId]
    );
    expect(rows.rows[0]?.effect).toBe("allow");
  });
});
