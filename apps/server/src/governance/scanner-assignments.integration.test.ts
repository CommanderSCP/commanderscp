import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpApiError, ScpClient } from "@scp/sdk";
import { ScanEvidenceSchema } from "@scp/schemas";
import { withTenantTx } from "../db/tenant-tx.js";
import { resolveScannersForType } from "./scanner-registry.js";
import {
  createTestOrg,
  listenTestServer,
  type ListeningTestServer
} from "../test-support/harness.js";

/**
 * M13.3a — the SCANNER-ASSIGNMENT REGISTRY end-to-end (ADR-0020 §2, proposal §13.3), against real
 * Postgres under real RLS. The registry MIRRORS `scan_requirement_floors`' instance-scoped posture,
 * so these assertions mirror the M17.5 suite's: operator PUT/GET round-trip, tenant read, and
 * tenant-write refusal driven through a REAL tenant transaction (`scp_app`, NOBYPASSRLS) — not a
 * mock. The last test proves the schema `scanner` widening left the E6 gate fixture parse unchanged.
 */

const OPERATOR_TOKEN = "m13-3a-operator-token-fixture";

async function expectApiError(fn: () => Promise<unknown>): Promise<ScpApiError> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof ScpApiError) return err;
    throw err;
  }
  throw new Error("expected an ScpApiError, but the call succeeded");
}

describe("M13.3a scanner-assignment registry (Testcontainers)", () => {
  let server: ListeningTestServer;
  let operator: ScpClient;

  beforeAll(async () => {
    server = await listenTestServer({ operatorToken: OPERATOR_TOKEN });
    // The operator credential is deployment-level, but the route still requires an authenticated
    // principal, so the operator client logs in as SOME org's admin — deliberately NOT what
    // authorizes the write (proven by the tenant-cannot-write test below).
    const bootstrap = await createTestOrg(server, "m13-3a-operator-home");
    operator = new ScpClient({ baseUrl: server.baseUrl, token: bootstrap.adminToken });
  });

  afterAll(async () => {
    await server?.close();
  });

  it("ships fail-closed seed defaults (image->trivy, configuration->[])", async () => {
    const items = await operator.scannerAssignments.list();
    const byType = new Map(items.map((a) => [a.executorType, a.methods]));
    expect(byType.get("image")).toEqual(["trivy"]);
    expect(byType.get("rpm")).toEqual(["trivy"]);
    expect(byType.get("deb")).toEqual(["trivy"]);
    expect(byType.get("npm")).toEqual(["trivy"]);
    expect(byType.get("infrastructure")).toEqual(["trivy"]);
    // configuration = no managed scanner (fail-closed: E6 refuses unless org-pipeline evidence).
    expect(byType.get("configuration")).toEqual([]);
  });

  it("(operator PUT/GET round-trip) upserts an assignment and reads it back", async () => {
    const put = await operator.scannerAssignments.put(
      { executorType: "image", methods: ["trivy", "openscap"] },
      OPERATOR_TOKEN
    );
    expect(put.executorType).toBe("image");
    expect(put.methods.sort()).toEqual(["openscap", "trivy"]);

    const list = await operator.scannerAssignments.list();
    expect(list.find((a) => a.executorType === "image")?.methods.sort()).toEqual([
      "openscap",
      "trivy"
    ]);

    // An empty methods set CLEARS the assignment (fail-closed).
    const cleared = await operator.scannerAssignments.put(
      { executorType: "image", methods: [] },
      OPERATOR_TOKEN
    );
    expect(cleared.methods).toEqual([]);

    // Restore the seed default so later assertions/suites see a clean instance-global table.
    await operator.scannerAssignments.put({ executorType: "image", methods: ["trivy"] }, OPERATOR_TOKEN);
  });

  it("(resolveScannersForType) resolves seeded, empty, and unknown types against the real table", async () => {
    const org = await createTestOrg(server, "m13-3a-resolve");
    const [image, config, unknown] = await withTenantTx(server.deps.db, org.orgId, async (tx) => [
      await resolveScannersForType(tx, "image"),
      await resolveScannersForType(tx, "configuration"),
      await resolveScannersForType(tx, "not-a-real-type")
    ]);
    expect(image).toEqual(["trivy"]);
    expect(config).toEqual([]);
    expect(unknown).toEqual([]);
  });

  it("(tenant read) a tenant principal sees the assignments — a gate they cannot inspect is not explainable", async () => {
    const org = await createTestOrg(server, "m13-3a-tenant-read");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const items = await admin.scannerAssignments.list();
    expect(items.find((a) => a.executorType === "npm")?.methods).toEqual(["trivy"]);
  });

  it("(RLS) no tenant can WRITE the assignments — refused by RLS on a real tenant transaction AND by the API without the operator token", async () => {
    const org = await createTestOrg(server, "m13-3a-tenant-cannot-write");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });

    // 1. THE DATABASE ITSELF. `server.deps.db` authenticates as the least-privileged `scp_app` login
    //    role (NOSUPERUSER, NOBYPASSRLS); `withTenantTx` sets `app.current_org_id` as a real request
    //    does. Even with full application cooperation the write cannot land.
    for (const [what, statement] of [
      ["INSERT", sql`INSERT INTO scanner_assignments (executor_type, methods) VALUES ('image', '["openscap"]'::jsonb)`],
      ["UPDATE", sql`UPDATE scanner_assignments SET methods = '["openscap"]'::jsonb`],
      ["DELETE", sql`DELETE FROM scanner_assignments`]
    ] as const) {
      await expect(
        withTenantTx(server.deps.db, org.orgId, (tx) => tx.execute(statement)),
        `a tenant transaction must not be able to ${what} a scanner assignment`
      ).rejects.toThrow();
    }

    // 2. ...while the tenant-READ works on that same connection, under the same RLS policy — proving
    //    the refusal above is write-specific, not the table being unreachable.
    const readBack = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.execute<{ executor_type: string }>(
        sql`SELECT executor_type FROM scanner_assignments ORDER BY executor_type`
      )
    );
    expect(readBack.rows.some((r) => r.executor_type === "image")).toBe(true);

    // 3. THE API. The tenant's own org admin — the most privileged tenant principal — cannot author
    //    an assignment, because no RBAC permission grants it (403, not a fallback to a tenant cred).
    const err = await expectApiError(() =>
      admin.scannerAssignments.put({ executorType: "image", methods: ["openscap"] }, "not-the-operator-token")
    );
    expect(err.status).toBe(403);

    // The seed is unchanged after all of that.
    expect((await admin.scannerAssignments.list()).find((a) => a.executorType === "image")?.methods).toEqual([
      "trivy"
    ]);
  });

  it("(gate-invisible widening) a 'trivy' scan-evidence fixture parses UNCHANGED after the enum widening", () => {
    // The exact shape the E6 export gate `safeParse`s (promotion-repo.ts). Proves widening `scanner`
    // to include `openscap` did not disturb the existing gate fixture by one bit.
    const evidence = {
      scanner: "trivy",
      scannerVersion: "0.50.0",
      artifactDigest: "sha256:" + "c".repeat(64),
      expectedDigest: "sha256:" + "c".repeat(64),
      digestMatch: true,
      severityCounts: { critical: 0, high: 0, medium: 0, low: 0 },
      threshold: { maxCritical: 0, maxHigh: 0 }
    };
    const parsed = ScanEvidenceSchema.safeParse(evidence);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.scanner).toBe("trivy");
      expect(parsed.data.digestMatch).toBe(true);
    }
  });
});
