import { generateKeyPairSync, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { ScpClient } from "@scp/sdk";
import { asTrustDomainId, type ScanEvidence } from "@scp/schemas";
import pg from "pg";
import { withTenantTx } from "../db/tenant-tx.js";
import { controlRuns } from "../db/schema.js";
import { proposeChange } from "../coordination/changes-repo.js";
import { SCAN_RULE_TEST_CONTROL_REF } from "../governance/test-support/scan-rule-control.js";
import {
  createOrphanComponent,
  createTestOrg,
  createTestUser,
  listenTestServer,
  testDatabaseUrl,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import { ensureFederationSelf } from "./self-repo.js";
import { pairPeer } from "./peers-repo.js";
import { exportPromotionBundle } from "./promotion-repo.js";
import {
  MANAGED_SCAN_CONTROL_OBJECT_ID,
  type ManagedScanRequest,
  type ManagedScanResult,
  type ManagedScanRunner
} from "./promotion-scan-step.js";

/** The exclusion re-check is threaded in at both call sites. See docs/federation.md §513. */

const OPERATOR_TOKEN = "m22-9-boundary-operator-token-fixture";
const ARTIFACT_DIGEST = `sha256:${"d".repeat(64)}`;

/** A `ManagedScanRunner` that records every call and always reports a CLEAN scan — the seam
 *  `runPromotionScanStep` exposes so this branch needs no Docker, no registry and no real Trivy. */
function cleanRunner(): ManagedScanRunner & { requests: ManagedScanRequest[] } {
  const requests: ManagedScanRequest[] = [];
  return {
    requests,
    async scan(req: ManagedScanRequest): Promise<ManagedScanResult> {
      requests.push(req);
      return {
        ok: true,
        report: {
          scannedDigest: req.digest,
          scannerVersion: "0.53.0",
          severityCounts: { critical: 0, high: 0, medium: 0, low: 0 },
          findings: []
        }
      };
    }
  };
}

describe("M22.9: the exclusion-set re-check, at both federation call sites", () => {
  let server: ListeningTestServer;
  /** An ordinary tenant principal carrying the deployment operator token to the M22.9 admission
   *  route — the production write door for the two instance rungs every clause requires. */
  let operator: ScpClient;

  beforeAll(async () => {
    server = await listenTestServer({ operatorToken: OPERATOR_TOKEN });
    const bootstrap = await createTestOrg(server, "boundary-operator");
    operator = new ScpClient({ baseUrl: server.baseUrl, token: bootstrap.adminToken });
    // Instance-scoped and therefore global to this file's database. Admitted ONCE: every case needs
    // the same class, and `PUT` is a whole-set replace.
    await admitAtInstance("approved_override");
  }, 180_000);

  afterAll(async () => {
    // Cleared even though this file gets its own database. See docs/federation.md §514.
    const adminPool = new pg.Pool({ connectionString: testDatabaseUrl() });
    await adminPool.query("DELETE FROM scan_exclusion_admissions").catch(() => undefined);
    await adminPool.end();
    await server?.close();
  });

  async function admitAtInstance(cls: string) {
    for (const tier of ["platform", "trust_domain"] as const) {
      const current = await operator.instanceScanExclusionAdmissions.list();
      const classes = new Set(
        current.filter((a) => a.tier === tier && a.origin === "local").map((a) => a.class)
      );
      classes.add(cls as (typeof current)[number]["class"]);
      await operator.instanceScanExclusionAdmissions.put(
        tier,
        { origin: "local", classes: [...classes] },
        OPERATOR_TOKEN
      );
    }
  }

  // -----------------------------------------------------------------------------------------
  // Fixtures — one self-contained org per case, because a grant is org-wide and every case here
  // moves one.
  // -----------------------------------------------------------------------------------------

  interface Scenario {
    org: TestOrg;
    admin: ScpClient;
    componentId: string;
    peerName: string;
    grantId: string;
  }

  /** An org with an identity, a paired peer and a component. See docs/federation.md §515. */
  async function scenario(label: string): Promise<Scenario> {
    const org = await createTestOrg(server, label);
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });

    const containmentDomain = await admin.object("domain").create({ name: `dom-${label}` });
    const service = await admin
      .object("service")
      .create({ name: `svc-${label}`, domainId: containmentDomain.id });
    const component = await createOrphanComponent(server, org, `comp-${label}`);
    await admin.relationships.create({
      typeId: "contains",
      fromId: service.id,
      toId: component.id
    });

    // M22.8 — a `scanExclusion` rule that requires no scan control is refused at the authoring door
    // (it would be silently inert). `SCAN_RULE_TEST_CONTROL_REF` is a DANGLING reference on purpose:
    // see that constant's own doc — a real bound control would add a control run and change what
    // these cases measure.
    await admin.policies.create({
      name: `clause-${label}`,
      properties: {
        scope: { objectRef: org.orgId },
        enforcement: "advisory",
        effects: [
          { scanExclusion: { exclude: { class: "approved_override" } } },
          { requireControls: [SCAN_RULE_TEST_CONTROL_REF] }
        ]
      }
    });

    // RAISED BY A SECOND PRINCIPAL, because the raiser may not approve their own grant (ADR-0033
    // §6a). `Operator` at the component is the weakest identity that can raise.
    const raiserUser = await createTestUser(server, org, [
      { role: "Viewer", scope: org.orgId },
      { role: "Operator", scope: component.id }
    ]);
    const raiser = new ScpClient({ baseUrl: server.baseUrl, token: raiserUser.token });
    const requested = await raiser.scanOverrideGrants.create({
      componentId: component.id,
      // Approved AT THE ORG ROOT: grants below the `org` authority floor never apply at all
      // (`OVERRIDE_APPROVAL_TIER_FLOOR`), so a service-tier grant would leave the set empty and this
      // file would measure nothing.
      tierObjectId: org.orgId,
      vulnerabilityId: "CVE-2026-9001",
      reason: "no upstream fix"
    });
    const approved = await admin.scanOverrideGrants.approve(requested.id, {
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      reason: "accepted at the org"
    });

    const peerName = `peer-${label}`;
    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      await ensureFederationSelf(tx, org.orgId);
      const { publicKey } = generateKeyPairSync("ed25519", {
        publicKeyEncoding: { type: "spki", format: "der" },
        privateKeyEncoding: { type: "pkcs8", format: "der" }
      }) as unknown as { publicKey: Buffer };
      await pairPeer(tx, {
        orgId: org.orgId,
        domainId: asTrustDomainId(randomUUID()),
        name: peerName,
        role: "outpost",
        publicKey: publicKey.toString("base64")
      });
    });

    return { org, admin, componentId: component.id, peerName, grantId: approved.id };
  }

  /** A promotion carrying ONE substantive OCI artifact — the shape E6 has something to gate. */
  async function proposeArtifactChange(s: Scenario): Promise<string> {
    const { change } = await withTenantTx(server.deps.db, s.org.orgId, (tx) =>
      proposeChange(tx, {
        orgId: s.org.orgId,
        actorObjectId: s.org.orgId,
        requestId: `boundary-${randomUUID()}`,
        name: `boundary-${randomUUID()}`,
        targets: [s.componentId],
        type: "image",
        sourceRef: {
          artifact_digest: ARTIFACT_DIGEST,
          image: `registry.test/scp/x@${ARTIFACT_DIGEST}`
        }
      })
    );
    return change.id;
  }

  function exportTo(s: Scenario, changeId: string, runner: ManagedScanRunner | null) {
    return exportPromotionBundle(server.deps.db, {
      orgId: s.org.orgId,
      peerIdOrName: s.peerName,
      changeIdOrUrn: changeId,
      actorObjectId: s.org.orgId,
      scanRunner: runner
    });
  }

  /** Every managed-scan run deposited for this change, oldest first. */
  async function managedRuns(s: Scenario, changeId: string) {
    return withTenantTx(server.deps.db, s.org.orgId, (tx) =>
      tx
        .select()
        .from(controlRuns)
        .where(
          and(
            eq(controlRuns.orgId, s.org.orgId),
            eq(controlRuns.changeObjectId, changeId),
            eq(controlRuns.controlObjectId, MANAGED_SCAN_CONTROL_OBJECT_ID)
          )
        )
        .orderBy(controlRuns.createdAt)
    );
  }

  /** The refusal Decision the E6 gate commits before it returns — read the way an operator resolving
   *  a `decision_id` would. */
  async function gateDecision(s: Scenario, decisionId: string) {
    return withTenantTx(server.deps.db, s.org.orgId, async (tx) => {
      const rows = await tx.execute<{
        kind: string;
        verdict: string;
        input_context: Record<string, unknown>;
      }>(sql`
        SELECT kind, verdict, input_context FROM decisions
         WHERE org_id = ${s.org.orgId} AND id = ${decisionId}
      `);
      return rows.rows[0];
    });
  }

  it("B1: an artifact scanned under the set that is STILL in force crosses the boundary, and the run carries the set's hash", async () => {
    // THE AGREEING CASE, and the one that catches the export gate's omission. Nothing changes between
    // the scan and the gate: the step resolves the set, stamps its hash on the evidence, and the gate
    // re-resolves the same set and finds the same hash. Hand the gate `undefined` instead and the
    // stamp it just wrote no longer matches, so this export refuses.
    const s = await scenario("boundary-live");
    const changeId = await proposeArtifactChange(s);
    const runner = cleanRunner();

    const outcome = await exportTo(s, changeId, runner);
    expect(outcome.refused, outcome.refused ? outcome.reason : "expected an export").toBe(false);
    expect(runner.requests).toHaveLength(1);

    const runs = await managedRuns(s, changeId);
    expect(runs).toHaveLength(1);
    const evidence = runs[0]!.evidence as unknown as ScanEvidence;
    expect(runs[0]!.status).toBe("pass");
    // THE STAMP EXISTS AND IS NON-EMPTY. Without it the comparison in B2 would be
    // `undefined !== undefined` — false — and every later case would agree for the wrong reason.
    expect(evidence.exclusionSetHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("B2: REVOKING the grant makes the SAME passing run stop authorising the crossing — refused `stale_exclusion_set`, with a Decision", async () => {
    // THE SECURITY PROPERTY. See docs/federation.md §516.
    const s = await scenario("boundary-revoked");
    const changeId = await proposeArtifactChange(s);
    const runner = cleanRunner();

    expect((await exportTo(s, changeId, runner)).refused).toBe(false);
    const before = await managedRuns(s, changeId);
    expect(before).toHaveLength(1);

    const revoked = await s.admin.scanOverrideGrants.revoke(s.grantId, {
      reason: "exploit now in the wild"
    });
    expect(revoked.status).toBe("revoked");

    const outcome = await exportTo(s, changeId, null);
    if (!outcome.refused) throw new Error("expected the export to be REFUSED, and it was not");
    expect(outcome.reason).toContain(ARTIFACT_DIGEST);
    expect(outcome.decisionId).toBeTruthy();

    const decision = await gateDecision(s, outcome.decisionId);
    expect(decision?.kind).toBe("promotion-export-scan-gate");
    expect(decision?.verdict).toBe("block");
    // MACHINE-READABLE, not prose: an operator must be able to tell "the waiver moved" from "nothing
    // scanned this" without parsing a sentence (charter principle 6).
    expect(decision?.input_context.refusalCode).toBe("stale_exclusion_set");
    // `gate.detail` is SPREAD FLAT into `inputContext` (promotion-repo.ts), so both sides of the
    // comparison are readable straight off the Decision — "the set moved" vs "this run predates
    // stamping" without going to the row.
    expect(decision?.input_context.recordedExclusionSetHash).toBe(
      (before[0]!.evidence as unknown as ScanEvidence).exclusionSetHash
    );
    expect(decision?.input_context.expectedExclusionSetHash).toBeTruthy();
    expect(decision?.input_context.expectedExclusionSetHash).not.toBe(
      decision?.input_context.recordedExclusionSetHash
    );

    // AND NOTHING FLIPPED THE RUN. It still says `pass`, exactly as an expired grant leaves a
    // `status: approved` row behind — the refusal is a read-time comparison, not a state machine.
    const after = await managedRuns(s, changeId);
    expect(after).toHaveLength(1);
    expect(after[0]!.status).toBe("pass");
    expect(after[0]!.id).toBe(before[0]!.id);
  });

  it("B3: with the set UNCHANGED the scan step recognises its own stamp and re-scans nothing", async () => {
    // THE SHORT-CIRCUIT'S INSTALLATION PROOF. See docs/federation.md §517.
    const s = await scenario("boundary-stable");
    const changeId = await proposeArtifactChange(s);
    const runner = cleanRunner();

    expect((await exportTo(s, changeId, runner)).refused).toBe(false);
    expect(runner.requests).toHaveLength(1);

    const second = await exportTo(s, changeId, runner);
    expect(second.refused, second.refused ? second.reason : "expected an export").toBe(false);
    expect(runner.requests, "a covering run must suppress the second managed scan").toHaveLength(1);
    // ...and no second row was deposited either, which is the same fact read off the table rather
    // than off the spy.
    expect(await managedRuns(s, changeId)).toHaveLength(1);
  });

  it("B4: a STALE stamp does not short-circuit — the step re-scans under the current set and the crossing then succeeds", async () => {
    // The pair to that case: the refusal is not a wedge. See docs/federation.md §518.
    const s = await scenario("boundary-rescan");
    const changeId = await proposeArtifactChange(s);
    const runner = cleanRunner();

    expect((await exportTo(s, changeId, runner)).refused).toBe(false);
    const first = await managedRuns(s, changeId);
    expect(first).toHaveLength(1);
    const firstHash = (first[0]!.evidence as unknown as ScanEvidence).exclusionSetHash;

    await s.admin.scanOverrideGrants.revoke(s.grantId, { reason: "withdrawn" });

    const outcome = await exportTo(s, changeId, runner);
    expect(outcome.refused, outcome.refused ? outcome.reason : "expected an export").toBe(false);
    expect(runner.requests, "the stale run must NOT have suppressed the re-scan").toHaveLength(2);

    const runs = await managedRuns(s, changeId);
    expect(runs).toHaveLength(2);
    const secondHash = (runs[1]!.evidence as unknown as ScanEvidence).exclusionSetHash;
    // THE SET REALLY DID MOVE — a hash that did not change would make B2 and this case both pass
    // against a gate that never compared anything.
    expect(secondHash).toBeDefined();
    expect(secondHash).not.toBe(firstHash);
  });
});
