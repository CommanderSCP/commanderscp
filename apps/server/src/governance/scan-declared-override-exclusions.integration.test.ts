import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ScpApiError, ScpClient } from "@scp/sdk";
import type { ScanEvidence } from "@scp/schemas";
import { asTrustDomainId } from "@scp/schemas";
import { withTenantTx } from "../db/tenant-tx.js";
import { upsertObjectByUrn } from "../graph/objects-repo.js";
import { FEDERATION_IMPORT_ACTOR_ID } from "../federation/import-repo.js";
import { testDatabaseUrl } from "../test-support/harness.js";
import {
  createOrphanComponent,
  createTestOrg,
  createTestUser,
  listenTestServer,
  waitUntil,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import { SCAN_RULE_TEST_CONTROL_REF } from "./test-support/scan-rule-control.js";

/**
 * M22.5 (component-declared facts, D2) and M22.6 (the override request, D3/D4) — PROVEN AT THE REAL
 * GATE, and at the real authoring doors.
 *
 * The pure predicates are pinned in `packages/schemas/src/scan-exclusion-declared-override.test.ts`
 * and the pure folds in `scan-declared-facts.test.ts`. NEITHER of those can tell you whether the
 * thing is WIRED — this repo's dominant defect is a component built, tested green against itself,
 * and installed nowhere — so every test below drives a PRODUCTION entry point:
 *
 *   - the real lifecycle gate, through the real subprocess plugin host running the real
 *     `scan-result-control` against a real loopback Trivy-shaped result;
 *   - the real component write route, for the declaration's strict door;
 *   - the real `/scan-override-grants` routes, for raising, approving, denying and revoking;
 *   - the real generic `/objects/{type}` endpoint, for the governance-managed refusal.
 *
 * Nothing here calls `resolveEffectiveScanExclusionsForTargets`, `applyScanExclusions` or either
 * fact resolver directly.
 *
 * MUTATIONS RUN against this file (2026-08-17) — the MEASURED result of each, each applied ALONE
 * against a passing suite and reverted by an exact inverse edit. Baseline: 10 passed. Nothing below
 * is a prediction.
 *
 *   M-1  DELETE the `attachDeclaredFacts` call in `resolveEffectiveScanExclusionsForTargets`
 *          -> 1 failed (D1). THE INSTALLATION PROOF for M22.5: the declarations resolve and reach
 *             nothing.
 *   M-2  DELETE the `attachApprovedOverrides` call, same function
 *          -> 1 failed (O1). The installation proof for M22.6.
 *   M-3  replace the `(properties->>'expiresAt')::timestamptz > at` SQL window with `true`
 *          -> 1 failed (O2). An expired grant would authorise a promotion — the whole reason expiry
 *             is a read-time window and not a status a (non-existent) job flips.
 *   M-4  approve authorizes `object:write` at the COMPONENT instead of `policy:write` at the TIER
 *          -> 1 failed (O4). The waiver becomes available to exactly the party it constrains.
 *   M-5  remove `scan_override_grant` from `GOVERNANCE_MANAGED_OBJECT_TYPE_IDS`
 *          -> 1 failed here (O6) + 1 in `governance-managed-write-doors.integration.test.ts` (the
 *             set-membership guard). NOTE what did NOT fail: that file's DOOR 1 and DOOR 2 stayed
 *             green, because they loop over a set the type had just left. That is precisely why the
 *             membership guard exists as its own case.
 *   M-6  delete BOTH `assertValidComponentSecurityDeclarations` calls in `graph/objects-repo.ts`
 *          -> 1 failed (D4).
 *   M-7  `declaredFactPredicate` accepts a clause with `declaredFact` and NO `declaredValue`
 *          -> 1 failed (D3) — but ONLY AFTER `pnpm -w build`. The first run of this mutation passed
 *             the whole suite, because `scan-result-control` runs in a SUBPROCESS that loads the
 *             BUILT `@scp/schemas`, so a source-only edit to that package is invisible here. Any
 *             future mutation of `packages/schemas` must rebuild before it is measured; the unit
 *             suite caught this one immediately, which is why both exist.
 * MUTATIONS RUN for the D3 review round (2026-08-18, cases O7-O11). Baseline: 15 passed.
 *
 *   M-9   the authority bar grants every candidate (`applyOverrideAuthorityBar`'s two refusals)
 *           -> 2 failed (O7, O9) + 3 in `scan-override-authority.test.ts`.
 *   M-10  `requiredOverrideApprovalTier` always returns the bottom rung
 *           -> 3 failed (O7, O8, O9). O8 fails on the RECORDED bar, which is why the bar is in the
 *              Decision and not only in the filter.
 *   M-11  `attachApprovedOverrides` derives the bar from NO ceiling
 *           -> 3 failed here (O7, O8, O9) + A9 in `scan-exclusion-actuator.integration.test.ts`.
 *   M-12  DELETE `assertOverrideTierStanding` at the RAISE route
 *           -> 1 failed (O10), and only O10.
 *   M-13  DELETE the instance-floor refusal at APPROVE
 *           -> 1 failed (O11), and only O11.
 *   M-14  the DECIDE route's `updateObject` passes `scanOverrideGrantDecision: false`
 *           -> 1 failed (O1). THE ANTI-VACUITY MUTATION for the internal bypass: without it the flag
 *              could have been dead code and every refusal above would still have looked correct.
 *   M-15  `scanExclusionsForDecision` stops recording `overrideRequiredTier` /
 *         `overridesRefusedForAuthority`
 *           -> 4 failed (O1, O7, O8, O9).
 *   M-16  `scanExclusionsForDecision` stops recording the grant's DERIVED `grantTier`
 *           -> 1 failed (O1).
 *
 *   M-8  drop `declaredFacts` and `approvedOverrides` from `scanExclusionsForDecision`
 *          -> 2 failed (D1, O1). The exclusion applies and the Decision cannot explain why.
 *
 * MUTATION RUN for O13 — the guarded `::timestamptz` cast (2026-08-18). Baseline: 17 passed.
 *
 *   M-17  UNWRAP the `CASE ... ~ ISO_TIMESTAMP_TEXT_PATTERN` in `scan-override-grants.ts`'s live-grant
 *         window back to the bare `(properties->>'expiresAt')::timestamptz` cast
 *           -> 1 failed (O13), and ONLY O13; the other 16 passed. It fails by TIMEOUT rather than by
 *              an assertion, and that is the defect's own shape rather than a weak test: the cast
 *              throws inside the gate's query, so no control run is ever written and there is nothing
 *              to assert against. Nothing else in this file notices, because a peer's row is the only
 *              way to reach a non-ISO `expiresAt` — every LOCAL door refuses the field outright.
 *
 * Instance-scoped `scan_exclusion_admissions` rows are GLOBAL to the deployment and the integration
 * suite runs `singleFork` against ONE shared Postgres, so a row left behind would silently admit
 * loosenings in every later suite. They are cleared in an `afterEach` that runs regardless of
 * outcome, and once more at teardown.
 */

const OPERATOR_TOKEN = "m22-5-operator-token-fixture";
const MATCH_DIGEST = "sha256:cccc777777777777777777777777777777777777777777777777777777777777";

interface TrivySource {
  url: string;
  close(): Promise<void>;
}

/** Loopback-only Trivy fixture (never the internet). Every entry carries a `FixedVersion`, so the
 *  `no_fix_available` class can never be the thing that excluded a finding here — if one of these
 *  scans passes, it passed for the class under test. */
async function startTrivySource(): Promise<TrivySource> {
  const httpServer = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const cve = (url.searchParams.get("cve") ?? "").split(",").filter(Boolean);
    const pkg = (url.searchParams.get("pkg") ?? "").split(",");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        SchemaVersion: 2,
        ArtifactName: "registry.test/app:1.0",
        ArtifactType: "container_image",
        Metadata: { RepoDigests: [`registry.test/app@${MATCH_DIGEST}`], ImageID: MATCH_DIGEST },
        Results: [
          {
            Target: "registry.test/app:1.0 (alpine 3.19)",
            Class: "os-pkgs",
            Vulnerabilities: cve.map((id, i) => ({
              VulnerabilityID: id,
              PkgName: pkg[i] || `pkg${i}`,
              Severity: "HIGH",
              FixedVersion: "9.9.9"
            }))
          }
        ]
      })
    );
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/scan`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      })
  };
}

describe("M22.5/M22.6 — declared facts and approved overrides, at the real gate", () => {
  let server: ListeningTestServer;
  let trivy: TrivySource;
  let adminPool: pg.Pool;
  /** An ordinary tenant principal carrying the deployment operator token to the M22.9 admission
   *  route — the production write door for the two instance rungs. */
  let operator: ScpClient;

  beforeAll(async () => {
    trivy = await startTrivySource();
    server = await listenTestServer({
      withEventRelay: true,
      withReconcileLoop: true,
      operatorToken: OPERATOR_TOKEN,
      pluginHostOptions: {
        callTimeoutMs: 15_000,
        restartBackoffBaseMs: 50,
        maxRestartBackoffMs: 300
      }
    });
    // The ADMIN connection is kept for TEARDOWN and for the rows this feature does not own. It is
    // no longer how an admission is authored — see `admitAtInstance` below (M22.9).
    adminPool = new pg.Pool({ connectionString: testDatabaseUrl() });
    const bootstrap = await createTestOrg(server, "admission-operator");
    operator = new ScpClient({ baseUrl: server.baseUrl, token: bootstrap.adminToken });
  }, 180_000);

  /**
   * THE PRODUCTION WRITE DOOR (M22.9). This used to `INSERT INTO scan_exclusion_admissions` over the
   * admin pool, which made the suite green while the two instance rungs every clause requires — and
   * that NO policy can ever contribute — had no writer outside these tests. The whole exclusion
   * dimension was inert on a real deployment. It now goes through
   * `PUT /api/v1/instance/scan-exclusion-admissions/{tier}` with the deployment operator token,
   * exactly as an operator would; delete that route's registration in `app.ts` and every admitting
   * test in this file dies. The PUT is a whole-set REPLACE, so this unions with what is already
   * admitted rather than clobbering an earlier call in the same test.
   */
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

  /** M22.6 (D3) — the operator-authored instance FLOOR, the same table `readInstanceScanFloors`
   *  reads. Written over the ADMIN connection because `routes/instance-scan-floors.ts` requires the
   *  deployment operator token and executes over the admin connection for exactly this reason: the
   *  request-serving `scp_app` role holds no write grant and no write RLS policy exists for it. */
  async function setInstanceFloor(
    tier: "platform" | "trust_domain",
    column: string,
    value: number
  ) {
    await adminPool.query(
      `INSERT INTO scan_requirement_floors (tier, origin, ${column})
         VALUES ($1, 'local', $2)
       ON CONFLICT (tier, origin) DO UPDATE SET ${column} = EXCLUDED.${column}`,
      [tier, value]
    );
  }

  async function clearInstanceAdmissions() {
    await adminPool?.query("DELETE FROM scan_exclusion_admissions").catch(() => undefined);
    await adminPool?.query("DELETE FROM scan_requirement_floors").catch(() => undefined);
  }

  afterEach(clearInstanceAdmissions);

  afterAll(async () => {
    await clearInstanceAdmissions();
    await adminPool?.end();
    await server?.close();
    await trivy?.close();
  });

  // -----------------------------------------------------------------------------------------
  // Fixtures
  // -----------------------------------------------------------------------------------------

  /**
   * A SECOND PRINCIPAL TO RAISE WITH, because the raiser may not be the approver (ADR-0033 §6a,
   * owner decision 2026-08-18).
   *
   * Every case below used to raise AND approve as `admin`, which the separation-of-duties refusal
   * now answers 400 to — seven of them went red at once when it landed, which is the measurement
   * that says the guard reaches the real route rather than only the unit under it.
   *
   * `Operator` at the component supplies exactly the `object:write` the raise route asks for and
   * NOTHING else — deliberately the weakest identity that can raise, so these fixtures keep proving
   * that raising is open (it authorizes nothing) while approving is not. `Viewer` at the org root
   * supplies the reads the SDK needs to resolve the component on the way in.
   */
  async function raiserFor(org: TestOrg, componentId: string): Promise<ScpClient> {
    const user = await createTestUser(server, org, [
      { role: "Viewer", scope: org.orgId },
      { role: "Operator", scope: componentId }
    ]);
    return new ScpClient({ baseUrl: server.baseUrl, token: user.token });
  }

  async function buildChain(admin: ScpClient, label: string) {
    const containmentDomain = await admin.object("domain").create({ name: `dom-${label}` });
    const service = await admin
      .object("service")
      .create({ name: `svc-${label}`, domainId: containmentDomain.id });
    const component = await createOrphanComponent(admin, `comp-${label}`);
    await admin.relationships.create({
      typeId: "contains",
      fromId: service.id,
      toId: component.id
    });
    return { containmentDomain, service, component };
  }

  async function exclusionPolicy(
    admin: ScpClient,
    name: string,
    scopeObjectId: string,
    effect: Record<string, unknown>
  ) {
    // M22.8 — the authoring guard (`governance/scan-rule-authoring-guard.ts`) refuses a
    // `scanExclusion` rule that requires no scan control: such a document is silently inert,
    // because the six-tier resolution is reached only inside `if (allControlIds.length > 0)`.
    // `SCAN_RULE_TEST_CONTROL_REF` is a DANGLING reference on purpose — see that constant's own
    // doc: a real bound control would add a control run and change what these tests measure.
    // `admit`-only stays untouched — it is an admission, not a rule about a finding (exempt).
    const requires =
      effect.exclude === undefined
        ? []
        : [
            {
              requireControls: [SCAN_RULE_TEST_CONTROL_REF]
            }
          ];
    return admin.policies.create({
      name,
      properties: {
        scope: { objectRef: scopeObjectId },
        enforcement: "advisory",
        effects: [{ scanExclusion: effect }, ...requires]
      }
    });
  }

  async function scanControl(
    admin: ScpClient,
    org: TestOrg,
    opts: { suffix: string; cve: string[]; pkg: string[] }
  ) {
    const control = await admin.controls.create({
      name: `scan-control-${opts.suffix}`,
      urn: `urn:scp:${org.orgId}:control:${opts.suffix}`,
      properties: { category: "security" }
    });
    const params = new URLSearchParams({
      cve: opts.cve.join(","),
      pkg: opts.pkg.join(",")
    });
    await admin.controls.putBinding(control.id, {
      pluginModule: "scan-result-control",
      pluginInstanceId: `scan-${control.id}`,
      config: { url: `${trivy.url}?${params.toString()}`, expectedDigest: MATCH_DIGEST }
    });
    return control;
  }

  async function requireScanControl(
    admin: ScpClient,
    name: string,
    scopeObjectId: string,
    controlId: string
  ) {
    return admin.policies.create({
      name,
      properties: {
        scope: { objectRef: scopeObjectId },
        enforcement: "required",
        effects: [{ requireControls: [controlId] }]
      }
    });
  }

  async function waitForControlRun(
    admin: ScpClient,
    changeId: string,
    controlId: string,
    status: "pass" | "fail"
  ) {
    return waitUntil(
      async () => {
        const matching = (await admin.controlRuns.listForChange(changeId)).items
          .filter((r) => r.controlObjectId === controlId && r.status === status)
          .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
        return matching[0];
      },
      { describe: `control ${controlId} on ${changeId} reports '${status}'`, timeoutMs: 25_000 }
    );
  }

  /**
   * The gate Decision's own record of the exclusion set, read from the `decisions` table the way an
   * operator resolving a `decision_id` would.
   *
   * EVERY decision for the change is scanned, not the latest one, and that is a measured correction
   * rather than caution: a change writes SEVERAL `transition` decisions on its way through, and the
   * LAST one is `coordinated -> executing`, whose `inputContext.gate` is `{gatesBound: 0}` — it runs
   * no policy gate at all. Reading only the newest row therefore reports "no exclusions recorded" for
   * a change whose gate recorded them perfectly well one transition earlier.
   */
  async function gateDecisionExclusions(org: TestOrg, changeId: string) {
    return withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const rows = await tx.execute<{ input_context: Record<string, unknown> }>(sql`
        SELECT input_context FROM decisions
         WHERE org_id = ${org.orgId} AND subject_id = ${changeId}
         ORDER BY created_at ASC
      `);
      for (const row of rows.rows) {
        const gate = row.input_context?.gate as Record<string, unknown> | undefined;
        const exclusions = (gate?.scanExclusions ?? row.input_context?.scanExclusions) as
          Record<string, unknown> | undefined;
        if (exclusions) return exclusions;
      }
      return undefined;
    });
  }

  // ===========================================================================================
  // M22.5 — the component-declared fact
  // ===========================================================================================

  it("D1: an ADMITTED declared_fact clause plus a matching component declaration excludes at the real gate, and the DECLARED VALUE lands verbatim in evidence AND in the Decision", async () => {
    await admitAtInstance("declared_fact");
    const org = await createTestOrg(server, "decl-pass");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const { component } = await buildChain(admin, "decl-pass");

    // THE COMPONENT AUTHORS THE OVERRIDE — through the real component write route, at plain
    // `object:write`, which is exactly D2's accepted seam.
    await admin.components.update(component.id, {
      properties: { security: { declarations: { egress: "none" } } }
    });
    // ...AND A TIER HOLDING `policy:write` AUTHORS WHAT THAT ASSERTION MEANS. The component never
    // authors this half.
    await exclusionPolicy(admin, "clause-decl", org.orgId, {
      exclude: {
        class: "declared_fact",
        // NARROWED, and now required to be (M22.4 review round): a `declared_fact` clause with NO
        // narrowing matcher was a bare `() => true` that excluded EVERY finding at EVERY severity,
        // while the tiers above had consented only to the CLASS and could not see the blast radius.
        // It is refused at the authoring door and inert at read time. Every finding these cases scan
        // is `curl`, so naming it changes nothing they assert.
        pkgName: "curl",
        declaredFact: "egress",
        declaredValue: "none",
        reason: "not reachable from any network"
      }
    });

    const control = await scanControl(admin, org, {
      suffix: "decl-pass",
      cve: ["CVE-2026-7001"],
      pkg: ["curl"]
    });
    await requireScanControl(admin, "gate-decl", component.id, control.id);

    const change = await admin.changes.propose({ name: "decl-pass", targets: [component.id] });
    const run = await waitForControlRun(admin, change.id, control.id, "pass");
    const evidence = run.evidence as unknown as ScanEvidence;

    // `severityCounts` STILL says what the scanner found — every CEL condition authored against it
    // keeps its meaning. Only the threshold comparison used the post-exclusion number.
    expect(evidence.severityCounts.high).toBe(1);
    expect(evidence.effectiveSeverityCounts?.high).toBe(0);
    expect(evidence.exclusions?.applied[0]).toMatchObject({
      class: "declared_fact",
      declaredFact: "egress",
      declaredValue: "none",
      reason: "not reachable from any network"
    });

    // ADR-0033 §6 guard 2 — an auditor reading the DECISION sees the assertion, not just the class.
    const decisionExclusions = await gateDecisionExclusions(org, change.id);
    expect(decisionExclusions?.declaredFacts).toEqual([{ key: "egress", value: "none" }]);
  });

  it("D2: the SAME declaration with NO instance admission excludes nothing — the component cannot author its own admission", async () => {
    // The negative control for D1, and the whole of ADR-0033 §6 guard 1. Everything is identical
    // except the two instance admission rows.
    const org = await createTestOrg(server, "decl-unadmitted");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const { component } = await buildChain(admin, "decl-unadmitted");

    await admin.components.update(component.id, {
      properties: { security: { declarations: { egress: "none" } } }
    });
    await exclusionPolicy(admin, "clause-unadmitted", org.orgId, {
      exclude: {
        class: "declared_fact",
        pkgName: "curl",
        declaredFact: "egress",
        declaredValue: "none"
      }
    });
    const control = await scanControl(admin, org, {
      suffix: "decl-unadmitted",
      cve: ["CVE-2026-7002"],
      pkg: ["curl"]
    });
    await requireScanControl(admin, "gate-unadmitted", component.id, control.id);

    const change = await admin.changes.propose({
      name: "decl-unadmitted",
      targets: [component.id]
    });
    const run = await waitForControlRun(admin, change.id, control.id, "fail");
    expect((run.evidence as unknown as ScanEvidence).severityCounts.high).toBe(1);
    // No admission => no clause => the evidence document gains NO new keys at all.
    expect(run.evidence).not.toHaveProperty("exclusions");
    expect(run.evidence).not.toHaveProperty("effectiveSeverityCounts");
  });

  it("D3: a clause naming the KEY but not the VALUE excludes nothing, even though the component declared that key", async () => {
    // Without this, a component could excuse itself by writing a property whose CONTENT nobody
    // constrained — `egress: internet` would satisfy `{declaredFact: "egress"}` just as well as
    // `egress: none`.
    await admitAtInstance("declared_fact");
    const org = await createTestOrg(server, "decl-halfclause");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const { component } = await buildChain(admin, "decl-halfclause");

    await admin.components.update(component.id, {
      properties: { security: { declarations: { egress: "internet" } } }
    });
    await exclusionPolicy(admin, "clause-halfclause", org.orgId, {
      // `pkgName` narrows; the POINT of this case is that `declaredFact` without `declaredValue`
      // still excuses nothing. Narrowing is a separate requirement from the key/value rule, and
      // without it the authoring door would refuse this clause before the rule could be shown.
      exclude: { class: "declared_fact", pkgName: "curl", declaredFact: "egress" }
    });
    const control = await scanControl(admin, org, {
      suffix: "decl-halfclause",
      cve: ["CVE-2026-7003"],
      pkg: ["curl"]
    });
    await requireScanControl(admin, "gate-halfclause", component.id, control.id);

    const change = await admin.changes.propose({
      name: "decl-halfclause",
      targets: [component.id]
    });
    const run = await waitForControlRun(admin, change.id, control.id, "fail");
    // A clause WAS admitted (so the evidence carries the dimension) and it applied to NOTHING.
    expect((run.evidence as unknown as ScanEvidence).exclusions?.appliedCount).toBe(0);
  });

  it("D4: the real component write route REFUSES a misspelled declaration bag, and stores nothing", async () => {
    // Strict at the local author's door, open on the wire (drizzle/0075). `{"declarationz": …}`
    // would otherwise be stored happily and read by the gate as NO declarations, leaving the author
    // believing they had declared something — a mistake that is always fail-closed and therefore
    // never surfaces as an incident, only as a rule that mysteriously never fires.
    const org = await createTestOrg(server, "decl-strict");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const { component } = await buildChain(admin, "decl-strict");

    await expect(
      admin.components.update(component.id, {
        properties: { security: { declarationz: { egress: "none" } } }
      })
    ).rejects.toBeInstanceOf(ScpApiError);

    await expect(
      admin.components.update(component.id, {
        properties: { security: { declarations: { egress: "none" }, egress: "none" } }
      })
    ).rejects.toBeInstanceOf(ScpApiError);

    // A refusal that still stored the row would satisfy a status assertion and nothing else.
    const after = await admin.components.get(component.id);
    expect(after.properties).not.toHaveProperty("security");

    // The well-formed shape goes through the same door unharmed — a guard that refused everything
    // would also pass the two assertions above.
    const ok = await admin.components.update(component.id, {
      properties: { security: { declarations: { egress: "none" } } }
    });
    expect(ok.properties).toMatchObject({ security: { declarations: { egress: "none" } } });
  });

  // ===========================================================================================
  // M22.6 — the override request
  // ===========================================================================================

  it("O1: a RAISED and APPROVED grant excludes exactly its finding, and evidence names the grant, its authority and its expiry", async () => {
    await admitAtInstance("approved_override");
    const org = await createTestOrg(server, "grant-pass");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const { component } = await buildChain(admin, "grant-pass");

    await exclusionPolicy(admin, "clause-grant", org.orgId, {
      exclude: { class: "approved_override" }
    });

    // RAISED at the component, then APPROVED at the ORG — and the org rather than the service is
    // the whole of the D3 floor made visible (owner decision, 2026-08-18). This case named
    // `service.id` until that floor landed and the grant stopped applying, which is correct and is
    // the behaviour change to know about: NO clause here authors a `scanThreshold`, so the bar has
    // no tier contributor to derive from and sits on the floor. A service-tier grant is below it.
    //
    // Read together with O7/O8: a grant below the bar is refused and a grant at-or-above it applies.
    // The floor's effect is that "at-or-above" now starts at `org` even when nothing set a ceiling,
    // because the gate is still enforcing one the contributors cannot see.
    const requested = await (
      await raiserFor(org, component.id)
    ).scanOverrideGrants.create({
      componentId: component.id,
      vulnerabilityId: "CVE-2026-7101",
      tierObjectId: org.orgId,
      reason: "no upstream fix; compensating control in place"
    });
    expect(requested.status).toBe("requested");
    const approved = await admin.scanOverrideGrants.approve(requested.id, {
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      reason: "accepted until the vendor ships 4.2"
    });
    expect(approved.status).toBe("approved");

    // TWO findings, ONE grant: the granted CVE is excused and the other is not. A blanket waiver
    // would pass both, and the run would still be a `pass` — so the second CVE is what makes this
    // test able to fail for the right reason.
    const control = await scanControl(admin, org, {
      suffix: "grant-pass",
      cve: ["CVE-2026-7101", "CVE-2026-7102"],
      pkg: ["openssl", "zlib"]
    });
    await requireScanControl(admin, "gate-grant", component.id, control.id);

    const change = await admin.changes.propose({ name: "grant-pass", targets: [component.id] });
    const run = await waitForControlRun(admin, change.id, control.id, "fail");
    const evidence = run.evidence as unknown as ScanEvidence;
    expect(evidence.severityCounts.high).toBe(2);
    expect(evidence.effectiveSeverityCounts?.high).toBe(1);
    expect(evidence.exclusions?.appliedCount).toBe(1);
    expect(evidence.exclusions?.applied[0]).toMatchObject({
      class: "approved_override",
      vulnerabilityId: "CVE-2026-7101",
      grantObjectId: approved.id,
      grantTierObjectId: org.orgId
    });
    expect(evidence.exclusions?.applied[0]?.grantExpiresAt).toBe(approved.expiresAt);

    const decisionExclusions = await gateDecisionExclusions(org, change.id);
    expect(decisionExclusions?.approvedOverrides).toEqual([
      {
        grantObjectId: approved.id,
        vulnerabilityId: "CVE-2026-7101",
        tierObjectId: org.orgId,
        // M22.6 (D3) — the DERIVED tier of the named object, read off this component's containment
        // chain by the resolver. The id says which object was named; this says what it actually IS.
        grantTier: "org",
        expiresAt: approved.expiresAt
      }
    ]);
    // ...and the BAR it was measured against. No `scanThreshold` is authored anywhere in this org and
    // no instance floor is set — and the bar is still `org`, NOT the bottom rung. That is the D3
    // floor (owner decision, 2026-08-18): "no tier contributed a ceiling" is not "no ceiling is
    // enforced", because the control binding's `config.threshold` and the scan plugin's shipped
    // fail-closed 0/0 are both in force and neither is authorable below `org`.
    expect(decisionExclusions?.overrideRequiredTier).toBe("org");
    expect(decisionExclusions?.overridesRefusedForAuthority).toBeUndefined();
  });

  it("O2: an EXPIRED grant authorises nothing — the window is applied at READ time, with no job having flipped anything", async () => {
    // THE TEST THAT PROVES EXPIRY IS REAL. There is no sweeper anywhere in this tree and no
    // `boss.schedule` to build one on, so a design that needed one would ship a grant that never
    // expires. The row below is left `status: "approved"` and untouched except for its timestamp —
    // exactly the state a live grant is in the second after it lapses.
    await admitAtInstance("approved_override");
    const org = await createTestOrg(server, "grant-expired");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const { service, component } = await buildChain(admin, "grant-expired");

    await exclusionPolicy(admin, "clause-expired", org.orgId, {
      exclude: { class: "approved_override" }
    });
    const requested = await (
      await raiserFor(org, component.id)
    ).scanOverrideGrants.create({
      componentId: component.id,
      vulnerabilityId: "CVE-2026-7201",
      tierObjectId: service.id,
      reason: "temporary"
    });
    const approved = await admin.scanOverrideGrants.approve(requested.id, {
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      reason: "one day only"
    });
    // Wind the clock forward by editing the STORED expiry rather than sleeping. The approve route
    // deliberately refuses a past `expiresAt` at authoring time, which is why this cannot be done
    // through it.
    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      await tx.execute(sql`
        UPDATE objects
           SET properties = jsonb_set(properties, '{expiresAt}', '"2020-01-01T00:00:00.000Z"'::jsonb)
         WHERE org_id = ${org.orgId} AND id = ${approved.id}
      `);
    });

    const control = await scanControl(admin, org, {
      suffix: "grant-expired",
      cve: ["CVE-2026-7201"],
      pkg: ["openssl"]
    });
    await requireScanControl(admin, "gate-expired", component.id, control.id);

    const change = await admin.changes.propose({ name: "grant-expired", targets: [component.id] });
    const run = await waitForControlRun(admin, change.id, control.id, "fail");
    const evidence = run.evidence as unknown as ScanEvidence;
    expect(evidence.severityCounts.high).toBe(1);
    expect(evidence.exclusions?.appliedCount).toBe(0);
    // ...and the grant is still sitting there saying `approved`, which is the point: nothing flipped
    // it, and nothing needed to.
    const stored = await admin.scanOverrideGrants.listForComponent(component.id);
    expect(stored[0]?.status).toBe("approved");
  });

  it("O3: a REVOKED grant stops excluding immediately", async () => {
    await admitAtInstance("approved_override");
    const org = await createTestOrg(server, "grant-revoked");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const { service, component } = await buildChain(admin, "grant-revoked");

    await exclusionPolicy(admin, "clause-revoked", org.orgId, {
      exclude: { class: "approved_override" }
    });
    const requested = await (
      await raiserFor(org, component.id)
    ).scanOverrideGrants.create({
      componentId: component.id,
      vulnerabilityId: "CVE-2026-7301",
      tierObjectId: service.id,
      reason: "pending vendor patch"
    });
    const approved = await admin.scanOverrideGrants.approve(requested.id, {
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      reason: "granted"
    });
    const revoked = await admin.scanOverrideGrants.revoke(approved.id, {
      reason: "exploit now in the wild"
    });
    expect(revoked.status).toBe("revoked");

    const control = await scanControl(admin, org, {
      suffix: "grant-revoked",
      cve: ["CVE-2026-7301"],
      pkg: ["openssl"]
    });
    await requireScanControl(admin, "gate-revoked", component.id, control.id);

    const change = await admin.changes.propose({ name: "grant-revoked", targets: [component.id] });
    const run = await waitForControlRun(admin, change.id, control.id, "fail");
    expect((run.evidence as unknown as ScanEvidence).exclusions?.appliedCount).toBe(0);
  });

  it("O4: approval standing is the TIER THAT SET THE RULE — a component-scoped Administrator may RAISE but not APPROVE", async () => {
    // D3, at the real authority model and with no new one. `scopeExpandCte` walks UPWARD from the
    // named object, so a binding at the component never reaches its service — while the same actor
    // holds every permission needed to raise the request at that component. If this ever passes,
    // the waiver has become available to the party it was meant to constrain.
    const org = await createTestOrg(server, "grant-authz");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const { service, component } = await buildChain(admin, "grant-authz");

    const componentAdmin = await createTestUser(server, org, [
      { role: "Administrator", scope: component.id }
    ]);
    const scoped = new ScpClient({ baseUrl: server.baseUrl, token: componentAdmin.token });

    // RAISING works: this is the component owner reporting a finding they cannot fix.
    const requested = await scoped.scanOverrideGrants.create({
      componentId: component.id,
      vulnerabilityId: "CVE-2026-7401",
      tierObjectId: service.id,
      reason: "no fix from the vendor"
    });
    expect(requested.status).toBe("requested");

    // APPROVING does not: `policy:write` is required AT THE SERVICE, and this Administrator holds
    // it only at the component below it.
    await expect(
      scoped.scanOverrideGrants.approve(requested.id, {
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        reason: "self-approval attempt"
      })
    ).rejects.toBeInstanceOf(ScpApiError);

    // The org-root Owner, whose authority is strictly ABOVE the service, can.
    const approved = await admin.scanOverrideGrants.approve(requested.id, {
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      reason: "reviewed by SecOps"
    });
    expect(approved.status).toBe("approved");
  });

  it("O5: every act writes a Decision AND a high-severity hash-chained audit event — the freeze.override shape, never the approvals shape", async () => {
    // Casting an approval vote writes a row and NO audit event today. A surface whose entire purpose
    // is to tolerate a known vulnerability cannot inherit that gap.
    const org = await createTestOrg(server, "grant-audit");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const { service, component } = await buildChain(admin, "grant-audit");

    const requested = await (
      await raiserFor(org, component.id)
    ).scanOverrideGrants.create({
      componentId: component.id,
      vulnerabilityId: "CVE-2026-7501",
      tierObjectId: service.id,
      reason: "raised for review"
    });
    await admin.scanOverrideGrants.approve(requested.id, {
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      reason: "approved with compensating control"
    });

    const events = (await admin.auditEvents.list({ limit: 200 })).items.filter(
      (e) => e.subjectId === requested.id
    );
    // The ACT's own events, distinct from the `scan_override_grant.create`/`.update` events
    // `createObject`/`updateObject` write for every graph object. Those record that a ROW changed;
    // these record that an AUTHORITY tolerated a vulnerability, and only the second kind carries the
    // mandatory reason and the Decision link.
    const actions = events
      .map((e) => e.action)
      .filter((a) => a.startsWith("scan_override."))
      .sort();
    expect(actions).toEqual(["scan_override.approve", "scan_override.request"]);
    // MANDATORY REASON, and it is the reason the actor actually gave — not a generic label.
    const approveEvent = events.find((e) => e.action === "scan_override.approve");
    expect(approveEvent?.reason).toBe("approved with compensating control");
    // ...linked to a Decision, so `decision_id` resolves to the full explanation.
    expect(approveEvent?.decisionId).toBeTruthy();

    const decisions = await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const rows = await tx.execute<{ verdict: string }>(sql`
        SELECT verdict FROM decisions
         WHERE org_id = ${org.orgId} AND subject_id = ${requested.id} AND kind = 'scan_override_grant'
         ORDER BY created_at ASC
      `);
      return rows.rows.map((r) => r.verdict);
    });
    expect(decisions).toEqual(["requested", "approved"]);

    // A MANDATORY NON-EMPTY REASON is enforced, not documented.
    await expect(
      admin.scanOverrideGrants.create({
        componentId: component.id,
        vulnerabilityId: "CVE-2026-7502",
        tierObjectId: service.id,
        reason: ""
      })
    ).rejects.toBeInstanceOf(ScpApiError);
  });

  it("O6: a grant is a GOVERNANCE-MANAGED type — the generic /objects endpoint refuses it, so nobody writes `status: approved` directly", async () => {
    // Without this, a holder of plain `object:write` at their own component could write
    // `{status: "approved", expiresAt: "2099-…"}` through the generic endpoint and grant themselves
    // the waiver these routes exist to arbitrate.
    const org = await createTestOrg(server, "grant-generic");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const { service, component } = await buildChain(admin, "grant-generic");

    await expect(
      admin.object("scan_override_grant").create({
        name: "self-granted",
        properties: {
          componentId: component.id,
          vulnerabilityId: "CVE-2026-7601",
          tierObjectId: service.id,
          status: "approved",
          expiresAt: "2099-01-01T00:00:00.000Z"
        }
      })
    ).rejects.toBeInstanceOf(ScpApiError);

    const listed = await admin.object("scan_override_grant").list();
    expect(listed.items).toHaveLength(0);
  });

  // ===========================================================================================
  // M22.6 REVIEW ROUND — D3 IS ENFORCED, NOT MERELY ASSERTED
  //
  // Until this round `tierObjectId` was chosen freely by the REQUESTER and read afterwards only for
  // PRESENCE. Because `authz/resolve.ts`'s `scopeExpandCte` expands UPWARD, naming a LOWER object
  // strictly WIDENED the set of principals whose bindings satisfied the approve check — so the party
  // seeking a waiver selected the authority that granted it, and a service lead could approve away a
  // ceiling set at org or platform while the audit trail truthfully recorded "under authority of
  // '<service>'".
  //
  // O7/O8 are a MATCHED PAIR and must be read together: identical org, identical ceiling, identical
  // clause, identical finding, identical grant — the ONLY difference is which rung the grant was
  // approved at. O9 proves the same bar is re-derived at the gate from a rule authored AFTER the
  // approval. O10/O11 are the authoring doors.
  // ===========================================================================================

  /** An org-anchored policy that BOTH requires the real scan control and sets the ceiling — one
   *  document, because `scan-rule-authoring-guard.ts` refuses a `scanThreshold` that requires no
   *  scan control, and because it makes the contributing tier unambiguous (`org`). */
  async function orgCeilingAndControl(
    admin: ScpClient,
    name: string,
    orgRootId: string,
    controlId: string
  ) {
    return admin.policies.create({
      name,
      properties: {
        scope: { objectRef: orgRootId },
        enforcement: "required",
        effects: [{ requireControls: [controlId] }, { scanThreshold: { maxHigh: 0 } }]
      }
    });
  }

  it("O7: a grant approved BELOW the tier that set the ceiling does NOT apply — the finding is still counted and the Decision says why", async () => {
    await admitAtInstance("approved_override");
    const org = await createTestOrg(server, "grant-below");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const { service, component } = await buildChain(admin, "grant-below");

    await exclusionPolicy(admin, "clause-below", org.orgId, {
      exclude: { class: "approved_override" }
    });
    const control = await scanControl(admin, org, {
      suffix: "grant-below",
      cve: ["CVE-2026-7301"],
      pkg: ["openssl"]
    });
    // THE CEILING IS SET AT ORG. That is the rule the grant would be waiving.
    await orgCeilingAndControl(admin, "ceiling-below", org.orgId, control.id);

    // The grant names the SERVICE — an object genuinely on the component's chain, and one the
    // requester could plausibly hold `policy:write` at. Under the old code this was enough.
    const requested = await (
      await raiserFor(org, component.id)
    ).scanOverrideGrants.create({
      componentId: component.id,
      vulnerabilityId: "CVE-2026-7301",
      tierObjectId: service.id,
      reason: "no upstream fix"
    });
    const approved = await admin.scanOverrideGrants.approve(requested.id, {
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      reason: "accepted at the service"
    });
    expect(approved.status).toBe("approved");

    const change = await admin.changes.propose({ name: "grant-below", targets: [component.id] });
    const run = await waitForControlRun(admin, change.id, control.id, "fail");
    const evidence = run.evidence as unknown as ScanEvidence;
    // THE ROW, not the status: the finding was counted, so nothing was excluded.
    expect(evidence.severityCounts.high).toBe(1);
    expect(evidence.effectiveSeverityCounts?.high).toBe(1);
    expect(evidence.exclusions?.appliedCount).toBe(0);

    const decisionExclusions = await gateDecisionExclusions(org, change.id);
    expect(decisionExclusions?.approvedOverrides).toBeUndefined();
    expect(decisionExclusions?.overrideRequiredTier).toBe("org");
    // A POSITIVE record of the refusal. "No exclusion applied" and "a live grant was refused for
    // authority" are different facts, and only the second tells the approver why their signed
    // accepted-risk record did nothing.
    expect(decisionExclusions?.overridesRefusedForAuthority).toEqual([
      { grantObjectId: approved.id, tier: "service", reason: "tier_below_required" }
    ]);
  });

  it("O8: the SAME grant approved AT the tier that set the ceiling does apply — the pair that makes O7 able to fail for the right reason", async () => {
    // Byte-for-byte O7 with one substitution: `tierObjectId` is the org root rather than the service.
    // If the bar were not being enforced, O7 would pass too and only this case would look meaningful.
    await admitAtInstance("approved_override");
    const org = await createTestOrg(server, "grant-at");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const { component } = await buildChain(admin, "grant-at");

    await exclusionPolicy(admin, "clause-at", org.orgId, {
      exclude: { class: "approved_override" }
    });
    const control = await scanControl(admin, org, {
      suffix: "grant-at",
      cve: ["CVE-2026-7301"],
      pkg: ["openssl"]
    });
    await orgCeilingAndControl(admin, "ceiling-at", org.orgId, control.id);

    const requested = await (
      await raiserFor(org, component.id)
    ).scanOverrideGrants.create({
      componentId: component.id,
      vulnerabilityId: "CVE-2026-7301",
      tierObjectId: org.orgId, // the org ROOT object — `local-auth.ts` gives it the org's own id
      reason: "no upstream fix"
    });
    const approved = await admin.scanOverrideGrants.approve(requested.id, {
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      reason: "accepted at the org"
    });

    const change = await admin.changes.propose({ name: "grant-at", targets: [component.id] });
    const run = await waitForControlRun(admin, change.id, control.id, "pass");
    const evidence = run.evidence as unknown as ScanEvidence;
    expect(evidence.severityCounts.high).toBe(1);
    expect(evidence.effectiveSeverityCounts?.high).toBe(0);
    expect(evidence.exclusions?.appliedCount).toBe(1);
    expect(evidence.exclusions?.applied[0]?.grantObjectId).toBe(approved.id);

    const decisionExclusions = await gateDecisionExclusions(org, change.id);
    expect(decisionExclusions?.overrideRequiredTier).toBe("org");
    expect(decisionExclusions?.overridesRefusedForAuthority).toBeUndefined();
  });

  it("O9: an INSTANCE FLOOR set AFTER the approval makes the grant inert — the bar is re-derived at every gate, from the rule as it stands now", async () => {
    // The escalation in the objection, exactly: a platform floor, a grant approved at the service.
    // The floor is set AFTER the approval on purpose — so the approve-time refusal cannot be what is
    // being measured, and only the gate's re-derivation can produce this outcome.
    //
    // The floor names `maxLow`, a severity the finding does not even have. That is deliberate: it
    // proves the bar is the most senior tier that set ANY ceiling, not the tier whose value happens
    // to BIND. Excluding a finding lowers the COUNT, which loosens every ceiling on that severity at
    // once, so a junior tier must not be able to defeat a senior one indirectly.
    await admitAtInstance("approved_override");
    const org = await createTestOrg(server, "grant-floor");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const { service, component } = await buildChain(admin, "grant-floor");

    await exclusionPolicy(admin, "clause-floor", org.orgId, {
      exclude: { class: "approved_override" }
    });
    const control = await scanControl(admin, org, {
      suffix: "grant-floor",
      cve: ["CVE-2026-7401"],
      pkg: ["openssl"]
    });
    await requireScanControl(admin, "gate-floor", component.id, control.id);

    // Approved while nothing outranks the service — this is O1's configuration, which PASSES.
    const requested = await (
      await raiserFor(org, component.id)
    ).scanOverrideGrants.create({
      componentId: component.id,
      vulnerabilityId: "CVE-2026-7401",
      tierObjectId: service.id,
      reason: "no upstream fix"
    });
    const approved = await admin.scanOverrideGrants.approve(requested.id, {
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      reason: "accepted at the service"
    });

    // THE OPERATOR ACT, after the approval. Nothing about the grant moves.
    await setInstanceFloor("platform", "max_low", 5);

    const change = await admin.changes.propose({ name: "grant-floor", targets: [component.id] });
    const run = await waitForControlRun(admin, change.id, control.id, "fail");
    const evidence = run.evidence as unknown as ScanEvidence;
    expect(evidence.severityCounts.high).toBe(1);
    expect(evidence.effectiveSeverityCounts?.high).toBe(1);
    expect(evidence.exclusions?.appliedCount).toBe(0);

    const decisionExclusions = await gateDecisionExclusions(org, change.id);
    expect(decisionExclusions?.overrideRequiredTier).toBe("platform");
    expect(decisionExclusions?.overridesRefusedForAuthority).toEqual([
      { grantObjectId: approved.id, tier: "service", reason: "tier_below_required" }
    ]);

    // ...and the grant row is untouched, still saying `approved`. Nothing flipped it; the gate simply
    // does not honour it, which is the same shape expiry uses (O2).
    const stored = await admin.scanOverrideGrants.listForComponent(component.id);
    expect(stored[0]?.status).toBe("approved");
  });

  it("O10: RAISING a request whose tierObjectId is not on the component's containment chain is refused, and stores nothing", async () => {
    const org = await createTestOrg(server, "grant-offchain");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const mine = await buildChain(admin, "grant-mine");
    const theirs = await buildChain(admin, "grant-theirs");

    // A perfectly real service the requester may well hold `policy:write` at — and a total stranger
    // to this component. Resolving the id proved only that the row exists, which was the whole hole.
    await expect(
      admin.scanOverrideGrants.create({
        componentId: mine.component.id,
        vulnerabilityId: "CVE-2026-7501",
        tierObjectId: theirs.service.id,
        reason: "no upstream fix"
      })
    ).rejects.toBeInstanceOf(ScpApiError);

    const stored = await admin.scanOverrideGrants.listForComponent(mine.component.id);
    expect(stored).toHaveLength(0);

    // The same call naming an object that IS on the chain goes through unharmed — a guard that
    // refused everything would satisfy the assertion above and nothing else.
    const ok = await admin.scanOverrideGrants.create({
      componentId: mine.component.id,
      vulnerabilityId: "CVE-2026-7501",
      tierObjectId: mine.service.id,
      reason: "no upstream fix"
    });
    expect(ok.status).toBe("requested");
  });

  it("O11: APPROVING is refused while an instance floor outranks the named tier — and the row stays `requested`", async () => {
    const org = await createTestOrg(server, "grant-floor-door");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const { service, component } = await buildChain(admin, "grant-floor-door");

    const requested = await admin.scanOverrideGrants.create({
      componentId: component.id,
      vulnerabilityId: "CVE-2026-7601",
      tierObjectId: service.id,
      reason: "no upstream fix"
    });

    await setInstanceFloor("platform", "max_critical", 0);

    await expect(
      admin.scanOverrideGrants.approve(requested.id, {
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        reason: "trying to waive a platform floor from the service"
      })
    ).rejects.toBeInstanceOf(ScpApiError);

    // ASSERT THE ROW. A 4xx with the properties written anyway is the failure mode a status
    // assertion cannot see.
    const stored = await admin.scanOverrideGrants.listForComponent(component.id);
    expect(stored[0]?.status).toBe("requested");
    expect(stored[0]?.expiresAt).toBeNull();
    expect(stored[0]?.decidedByActorId).toBeNull();

    // DENY is NOT refused: taking a waiver back must never be harder than making one.
    const denied = await admin.scanOverrideGrants.deny(requested.id, { reason: "not accepted" });
    expect(denied.status).toBe("denied");
  });
  it("O12: the RAISER may not APPROVE their own grant — and deny/revoke stay open to them", async () => {
    // SEPARATION OF DUTIES (owner decision, 2026-08-18). The escalation D3 exists to stop needs two
    // things to go wrong: an authority bar that does not bind, and one actor holding both halves of
    // the act. O7-O9 cover the bar. This covers the actor.
    //
    // It is NOT a substitute for the bar and the assertions say so: a SECOND principal with the same
    // standing approves the very same grant successfully at the end, which is the point — this rule
    // constrains WHO signs, never WHETHER the waiver is permissible.
    await admitAtInstance("approved_override");
    const org = await createTestOrg(server, "grant-sod");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const { service, component } = await buildChain(admin, "grant-sod");

    // ONE identity that can both raise and approve: Operator at the component supplies the
    // `object:write` the raise route wants, Administrator at the service the `policy:write` the
    // approve route wants. Without the refusal this actor completes the whole act alone.
    const both = await createTestUser(server, org, [
      { role: "Viewer", scope: org.orgId },
      { role: "Operator", scope: component.id },
      { role: "Administrator", scope: service.id }
    ]);
    const selfDealer = new ScpClient({ baseUrl: server.baseUrl, token: both.token });

    const requested = await selfDealer.scanOverrideGrants.create({
      componentId: component.id,
      vulnerabilityId: "CVE-2026-7601",
      tierObjectId: service.id,
      reason: "raised by the same hand that will try to sign it"
    });
    expect(requested.status).toBe("requested");

    await expect(
      selfDealer.scanOverrideGrants.approve(requested.id, {
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        reason: "signing my own waiver"
      })
    ).rejects.toBeInstanceOf(ScpApiError);

    // ASSERT THE ROW, not just the rejection. A refusal that updated the object anyway would leave a
    // live waiver behind while returning 400 — the shape `governance-managed-write-doors` had to
    // learn to check for.
    const afterRefusal = await admin.scanOverrideGrants.listForComponent(component.id);
    expect(afterRefusal).toHaveLength(1);
    expect(afterRefusal[0]?.status).toBe("requested");
    expect(
      afterRefusal[0]?.expiresAt,
      "a refused approval must not have opened a window"
    ).toBeNull();
    expect(afterRefusal[0]?.decidedByActorId).toBeNull();

    // THE NEGATIVE CONTROL, and the reason this case cannot pass for the wrong reason: the identical
    // grant, the identical tier, approved by a DIFFERENT subject, goes through. Without this the
    // test above is equally satisfied by an approve route that is simply broken.
    const approved = await admin.scanOverrideGrants.approve(requested.id, {
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      reason: "accepted by a second principal"
    });
    expect(approved.status).toBe("approved");

    // ...and REVOKE is open to the raiser, deliberately. Withdrawing a waiver must never be harder
    // than granting one, so the refusal is approve-only.
    const revoked = await selfDealer.scanOverrideGrants.revoke(approved.id, {
      reason: "withdrawn by the requester"
    });
    expect(revoked.status).toBe("revoked");
  });

  it("O13: a PEER'S grant with an uncastable `expiresAt` does not take the gate out — it is simply not live", async () => {
    // THE DEFECT THIS PINS. The live-grant window casts `properties->>'expiresAt'` to `timestamptz`
    // inside the gate's own query. `expiresAt` is refused at every LOCAL door, but the M22.6
    // authoring guard deliberately EXEMPTS `federationImport` — a throw on that path aborts a peer's
    // whole signed bundle — and the registered `property_schema` types the field only as
    // `{"type": "string"}`, deliberately (0075 §1: typing it would move the failure from one grant to
    // the whole channel). So a peer can legitimately deliver `expiresAt: "never"`.
    //
    // With a BARE cast, that one row throws inside EVERY gate evaluation for the org — the reconcile
    // prewarm, the wave boundary, `POST /policy-evaluate` and the commander promotion scan — so no
    // change in the org can be validated or advanced until an operator finds it. Fail-OPEN by way of
    // a crash, reachable from across a trust boundary. The resolver now wraps the cast in a
    // `CASE ... ~ pattern`, exactly as `graph/containment.ts` wraps its `::uuid`.
    //
    // WHY THE ROW IS PLANTED THROUGH `upsertObjectByUrn` WITH `federationImport` RATHER THAN A RAW
    // INSERT, and what that does and does not buy. It is the exact function `import-repo.ts`'s
    // `object_upsert` branch calls, with the same actor and the same context shape, so this exercises
    // the REAL import writer and the REAL registry validation — which is the precondition the whole
    // finding rests on: if `property_schema` refused `"never"`, no such row could exist and the guard
    // would be unreachable. A raw `INSERT INTO objects` would prove nothing about that and is exactly
    // the shortcut that let the exclusion dimension ship green and inert. What it does NOT do is
    // drive a signed bundle end to end — `verifyBundleSignature`/`verifyJournalChain` are upstream of
    // this function and are covered by `federation/federation.integration.test.ts`; duplicating a
    // two-domain fixture here would not exercise one additional line of the resolver.
    await admitAtInstance("approved_override");
    const org = await createTestOrg(server, "grant-poison");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const { component } = await buildChain(admin, "grant-poison");

    await exclusionPolicy(admin, "clause-poison", org.orgId, {
      exclude: { class: "approved_override" }
    });

    // A GOOD grant beside the poisoned one, approved AT THE ORG so it clears the D3 authority floor
    // (`OVERRIDE_APPROVAL_TIER_FLOOR`; a grant approved lower can never apply — see O7). Without it
    // this case passes for the wrong reason: a gate that resolved NO overrides at all would also
    // "not throw", and would say nothing about whether the guard let the healthy row through.
    const requested = await (
      await raiserFor(org, component.id)
    ).scanOverrideGrants.create({
      componentId: component.id,
      vulnerabilityId: "CVE-2026-7801",
      tierObjectId: org.orgId,
      reason: "no upstream fix"
    });
    const approved = await admin.scanOverrideGrants.approve(requested.id, {
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      reason: "accepted"
    });

    // ...and now the peer's row. `status: "approved"`, the same component, and a tier that clears the
    // same floor the good grant clears — so the ONLY thing standing between it and the exclusion set
    // is the expiry window. Anything less would let this case pass because of a second refusal.
    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      await upsertObjectByUrn(tx, {
        orgId: org.orgId,
        typeId: "scan_override_grant",
        actorObjectId: FEDERATION_IMPORT_ACTOR_ID,
        requestId: `federation-import:${randomUUID()}`,
        urn: `urn:scp:${org.orgId}:scan_override_grant:from-a-peer`,
        name: "from-a-peer",
        properties: {
          componentId: component.id,
          vulnerabilityId: "CVE-2026-7802",
          tierObjectId: org.orgId,
          status: "approved",
          reason: "authored by a peer running a looser build",
          expiresAt: "never"
        },
        // The peer's claimed authority. `upsertObjectByUrn` only ever COMPARES this against the
        // stored row's `origin_domain_id` (it never resolves it), so an unpaired id is the whole of
        // what the create branch needs — the same stand-in `governance-reach.integration.test.ts`
        // uses. Branded per ADR-0021 D4: a TRUST domain id, not a containment one.
        federationImport: {
          originDomainId: asTrustDomainId(randomUUID()),
          revision: 1,
          provenance: null
        }
      });
    });

    // THE GATE RUNS. Two findings, one legitimately excused, one covered only by the poisoned row.
    const control = await scanControl(admin, org, {
      suffix: "grant-poison",
      cve: ["CVE-2026-7801", "CVE-2026-7802"],
      pkg: ["openssl", "zlib"]
    });
    await requireScanControl(admin, "gate-poison", component.id, control.id);
    const change = await admin.changes.propose({ name: "grant-poison", targets: [component.id] });
    const run = await waitForControlRun(admin, change.id, control.id, "fail");

    // IT PRODUCED A VERDICT AT ALL. That is the assertion the guard exists for — with a bare cast
    // this line is never reached, because the query throws out of the gate and no run is ever
    // written (the wait times out instead).
    const evidence = run.evidence as unknown as ScanEvidence;
    expect(evidence.severityCounts.high).toBe(2);

    // FAIL-CLOSED, not fail-open: the good grant excused its finding, the poisoned one excused
    // nothing. A guard that swallowed the malformed value as "no expiry = unlimited" would show 0.
    expect(evidence.effectiveSeverityCounts?.high).toBe(1);
    expect(evidence.exclusions?.appliedCount).toBe(1);
    expect(evidence.exclusions?.applied[0]).toMatchObject({
      class: "approved_override",
      vulnerabilityId: "CVE-2026-7801",
      grantObjectId: approved.id
    });

    // THE DECISION AGREES. A row dropped by the SQL window is not "refused for authority" — it never
    // became a candidate — so the Decision must list exactly one grant and no authority refusal. This
    // distinguishes the guard from a bar that happened to reject the poisoned row for some other
    // reason, which would satisfy the counts above and mean the cast was never exercised.
    const decisionExclusions = await gateDecisionExclusions(org, change.id);
    expect(decisionExclusions?.approvedOverrides).toEqual([
      {
        grantObjectId: approved.id,
        vulnerabilityId: "CVE-2026-7801",
        tierObjectId: org.orgId,
        grantTier: "org",
        expiresAt: approved.expiresAt
      }
    ]);
    expect(decisionExclusions?.overridesRefusedForAuthority).toBeUndefined();
  });
});
