import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import type { ScanEvidence } from "@scp/schemas";
import { withTenantTx } from "../db/tenant-tx.js";
import { controlRuns, scanFindings } from "../db/schema.js";
import { proposeChange } from "../coordination/changes-repo.js";
import { prewarmGovernanceForChange } from "./gate-orchestrator.js";
import { getSharedCelSandbox } from "./cel-sandbox.js";
import {
  MANAGED_SCAN_CONTROL_OBJECT_ID,
  runPromotionScanStep,
  type ManagedScanRequest,
  type ManagedScanResult,
  type ManagedScanRunner
} from "../federation/promotion-scan-step.js";
import { testDatabaseUrl } from "../test-support/harness.js";
import {
  createOrphanComponent,
  createTestOrg,
  listenTestServer,
  waitUntil,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/**
 * M22.2 — THE EXCLUSION DIMENSION, PROVEN AT THE REAL GATE (ADR-0033 §1–§4, migration 0066).
 *
 * The pure algebra is pinned in `scan-requirements.test.ts` and the pure application in
 * `packages/schemas/src/supply-chain.test.ts`. NEITHER of those can tell you whether the thing is
 * WIRED, and this repo's dominant defect is a component built, tested green against itself, and
 * installed nowhere. So every test in this file drives a PRODUCTION entry point end to end:
 *
 *   - the real lifecycle gate (`prewarmGovernanceForChange` / `evaluateGovernanceGate` via the
 *     reconcile loop), through the real subprocess plugin host running the real
 *     `scan-result-control` against a real loopback Trivy-shaped result;
 *   - the commander's own managed scan (`runPromotionScanStep`), which resolves and applies
 *     exclusions server-side because it has no plugin to thread a context to.
 *
 * Nothing here calls `resolveEffectiveScanExclusions` or `applyScanExclusions` directly.
 *
 * MUTATIONS RUN against this file (2026-08-17) — the MEASURED result of each, reverted afterwards by
 * an exact inverse edit. Baseline: 11 passed. Nothing below is a prediction.
 *
 *   M-1  DROP `scanExclusions` from `buildControlContext`'s returned object (gate-orchestrator.ts)
 *          -> 6 failed (G2, G11, G3, G4, G5, G8). The clauses resolve and never reach the control.
 *   M-2  DROP the `scanExclusions` argument at the PREWARM call site ONLY, leaving the evaluate site
 *        wired
 *          -> 1 failed: G11, AND ONLY G11. This is the measurement that changed the shape of this
 *             file. Every other test's change goes straight to `executing` and its only control run
 *             is a `wave_boundary` one, so the whole suite except G11 proves the EVALUATE site and
 *             says NOTHING about the prewarm — whose run is the one that gets CACHED and read at the
 *             host-less accept edge. G11 exists because this mutation survived without it.
 *   M-3  route exclusions through `ceilingContributorKeys` instead of `exclusionContributorKeys`
 *          -> 1 failed (G4). An unevaluable CEL condition would then ADMIT the clause — the
 *             fail-open this dimension's opposite sign exists to prevent.
 *   M-4  UNION the per-target clause sets instead of intersecting them
 *          -> 1 failed (G5). A clause admitted for component A leaks onto sibling component B.
 *   M-5  restore `firedPolicies: []` in `federation/promotion-scan-step.ts`
 *          -> 2 failed (G6, G7). The commander path stops seeing anything authored below the
 *             instance floors, which is the divergence at the boundary where evidence is FROZEN.
 *             G7 fails too because its `refused: "unsupported"` marker only appears once a clause
 *             was admitted at all.
 *   M-6  `persistScanFindings` writing `scanFindingRetentionClass(false)` unconditionally
 *          -> 1 failed (G8). Excluded findings lose their accepted-risk (class E) retention.
 *
 * Instance-scoped `scan_exclusion_admissions` rows are GLOBAL to the deployment and the integration
 * suite runs `singleFork` against ONE shared Postgres, so a row left behind would silently admit
 * loosenings in every later suite. They are cleared in an `afterEach` that runs regardless of
 * outcome, and once more at teardown.
 */

const OPERATOR_TOKEN = "m22-2-operator-token-fixture";
const MATCH_DIGEST = "sha256:eeee444444444444444444444444444444444444444444444444444444444444";
const MANAGED_DIGEST = "sha256:ffff555555555555555555555555555555555555555555555555555555555555";

interface TrivySource {
  url: string;
  close(): Promise<void>;
}

/**
 * Loopback-only Trivy fixture (never the internet). `sev` seeds the severities; `fix` is a parallel
 * list of `y`/`n` deciding whether that entry carries a `FixedVersion` — the ONE field the
 * `no_fix_available` class reads, and the reason this file cannot reuse M17.5's source, which emits
 * none at all.
 */
async function startTrivySource(): Promise<TrivySource> {
  const httpServer = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const digest = url.searchParams.get("digest") ?? MATCH_DIGEST;
    const sev = (url.searchParams.get("sev") ?? "").split(",").filter(Boolean);
    const fix = (url.searchParams.get("fix") ?? "").split(",");
    const pkg = (url.searchParams.get("pkg") ?? "").split(",");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        SchemaVersion: 2,
        ArtifactName: "registry.test/app:1.0",
        ArtifactType: "container_image",
        Metadata: { RepoDigests: [`registry.test/app@${digest}`], ImageID: digest },
        Results: [
          {
            Target: "registry.test/app:1.0 (alpine 3.19)",
            Class: "os-pkgs",
            Vulnerabilities: sev.map((s, i) => ({
              VulnerabilityID: `CVE-2026-${8000 + i}`,
              PkgName: pkg[i] || `pkg${i}`,
              Severity: s,
              ...(fix[i] === "y" ? { FixedVersion: "9.9.9" } : {})
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

function fixedRunner(report: (req: ManagedScanRequest) => ManagedScanResult): ManagedScanRunner {
  return {
    async scan(req) {
      return report(req);
    }
  };
}

describe("M22.2 scan exclusions — admitted top-down, applied before counting", () => {
  let server: ListeningTestServer;
  let trivy: TrivySource;
  let adminPool: pg.Pool;

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
    // `scan_exclusion_admissions` is operator-write / tenant-read with NO write route yet (the read
    // + write surface lands in M22.8), so the fixture writes it over the ADMIN connection — which is
    // exactly the connection a production operator write would use. Doing it this way also proves
    // the RUNTIME role can READ what it cannot write, since every gate below reads these rows as
    // `scp_app`.
    adminPool = new pg.Pool({ connectionString: testDatabaseUrl() });
  }, 180_000);

  async function admitAtInstance(tiers: Array<"platform" | "trust_domain">, cls: string) {
    for (const tier of tiers) {
      await adminPool.query(
        `INSERT INTO scan_exclusion_admissions (tier, class) VALUES ($1, $2)
           ON CONFLICT (tier, class, origin) DO NOTHING`,
        [tier, cls]
      );
    }
  }

  async function clearInstanceAdmissions() {
    await adminPool?.query("DELETE FROM scan_exclusion_admissions").catch(() => undefined);
  }

  afterEach(async () => {
    await clearInstanceAdmissions();
  });

  afterAll(async () => {
    await clearInstanceAdmissions();
    await adminPool?.end();
    await server?.close();
    await trivy?.close();
  });

  // -----------------------------------------------------------------------------------------
  // Fixtures
  // -----------------------------------------------------------------------------------------

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

  /** A policy carrying ONLY a `scanExclusion` effect — the org-and-below authoring surface for both
   *  halves of the AND (`admit` a class beneath this tier, `exclude` a clause at it). */
  async function exclusionPolicy(
    admin: ScpClient,
    name: string,
    scopeObjectId: string,
    effect: Record<string, unknown>,
    condition?: string
  ) {
    return admin.policies.create({
      name,
      properties: {
        scope: { objectRef: scopeObjectId },
        enforcement: "advisory",
        ...(condition ? { condition } : {}),
        effects: [{ scanExclusion: effect }]
      }
    });
  }

  async function scanFloorPolicy(
    admin: ScpClient,
    name: string,
    scopeObjectId: string,
    threshold: Record<string, number>,
    condition?: string
  ) {
    return admin.policies.create({
      name,
      properties: {
        scope: { objectRef: scopeObjectId },
        enforcement: "advisory",
        ...(condition ? { condition } : {}),
        effects: [{ scanThreshold: threshold }]
      }
    });
  }

  async function scanControl(
    admin: ScpClient,
    org: TestOrg,
    opts: { suffix: string; sev: string[]; fix: string[]; pkg?: string[] }
  ) {
    const control = await admin.controls.create({
      name: `scan-control-${opts.suffix}`,
      urn: `urn:scp:${org.orgId}:control:${opts.suffix}`,
      properties: { category: "security" }
    });
    const params = new URLSearchParams({
      digest: MATCH_DIGEST,
      sev: opts.sev.join(","),
      fix: opts.fix.join(","),
      pkg: (opts.pkg ?? []).join(",")
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

  // ===========================================================================================
  // THE GATE PATH — resolution in gate-orchestrator, application in the plugin.
  // ===========================================================================================

  it("G1: with NOTHING admitted anywhere, a no-fix HIGH still counts and the gate still BLOCKS — byte-identical to pre-M22.2", async () => {
    const org = await createTestOrg(server, "excl-none");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const { component } = await buildChain(admin, "none");

    // A clause IS authored — it simply has no admission above it, which is the shipped default.
    await exclusionPolicy(admin, "clause-none", org.orgId, {
      exclude: { class: "no_fix_available" }
    });
    const control = await scanControl(admin, org, {
      suffix: "excl-none",
      sev: ["HIGH"],
      fix: ["n"],
      pkg: ["openssl"]
    });
    await requireScanControl(admin, "gate-none", component.id, control.id);

    const change = await admin.changes.propose({ name: "excl-none", targets: [component.id] });
    const run = await waitForControlRun(admin, change.id, control.id, "fail");
    const evidence = run.evidence as unknown as ScanEvidence;
    expect(evidence.severityCounts.high).toBe(1);
    // No admission => no clause => the evidence document gains NO new keys at all.
    expect(run.evidence).not.toHaveProperty("exclusions");
    expect(run.evidence).not.toHaveProperty("effectiveSeverityCounts");
  });

  it("G2: an ADMITTED clause excludes before counting, at the real gate, and the run PASSES", async () => {
    await admitAtInstance(["platform", "trust_domain"], "no_fix_available");

    const org = await createTestOrg(server, "excl-admit");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const { component } = await buildChain(admin, "admit");

    // The clause sits at the ORG tier, so the tiers it needs above it are exactly the two instance
    // rungs — both admitted above.
    await exclusionPolicy(admin, "clause-admit", org.orgId, {
      exclude: { class: "no_fix_available", pkgName: "openssl", reason: "upstream has no fix" }
    });
    const control = await scanControl(admin, org, {
      suffix: "excl-admit",
      sev: ["HIGH"],
      fix: ["n"],
      pkg: ["openssl"]
    });
    await requireScanControl(admin, "gate-admit", component.id, control.id);

    const change = await admin.changes.propose({ name: "excl-admit", targets: [component.id] });
    const run = await waitForControlRun(admin, change.id, control.id, "pass");
    const evidence = run.evidence as unknown as ScanEvidence;

    // `severityCounts` STILL says what the scanner found — every CEL condition authored against it
    // keeps its meaning.
    expect(evidence.severityCounts.high).toBe(1);
    // ...and ONLY the threshold comparison used the post-exclusion number.
    expect(evidence.effectiveSeverityCounts?.high).toBe(0);
    expect(evidence.exclusions?.appliedCount).toBe(1);
    expect(evidence.exclusions?.applied[0]).toMatchObject({
      class: "no_fix_available",
      tier: "org",
      severity: "high",
      pkgName: "openssl",
      reason: "upstream has no fix"
    });
  });

  it("G11: THE PREWARM'S OWN RUN carries the exclusions — the run that gets CACHED and read at the host-less accept edge", async () => {
    // MEASURED, and it is why this test exists rather than being folded into G2: G2's change moves
    // straight to `executing` and its ONLY control run is a `wave_boundary` one, so G2 proves the
    // EVALUATE site and NOTHING about the PREWARM site. Threading only the evaluate site is a real
    // and plausible mistake — mutation M-2 in the header removes exactly that argument — and it
    // would leave a loosening working at a wave boundary and silently absent at the edge a human
    // clicks, because `prewarmGovernanceForChange`'s run is the one `readExistingControlOutcomes`
    // reads at the host-less `validating -> accepted` gate.
    //
    // `prewarmGovernanceForChange` IS the production entry point: `coordination/reconcile.ts`
    // `advanceValidatingChanges` calls it with exactly these arguments, once per tick, for every
    // change sitting in `validating`. It is driven directly here because no change in this harness
    // stays in `validating` long enough for a tick to catch it — which is a fixture limitation, not
    // a statement about production, and driving the same function with the same real plugin host
    // and real CEL sandbox exercises the same code path.
    await admitAtInstance(["platform", "trust_domain"], "no_fix_available");

    const org = await createTestOrg(server, "excl-prewarm");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const { component } = await buildChain(admin, "prewarm");

    await exclusionPolicy(admin, "clause-prewarm", org.orgId, {
      exclude: { class: "no_fix_available" }
    });
    const control = await scanControl(admin, org, {
      suffix: "excl-prewarm",
      sev: ["HIGH"],
      fix: ["n"],
      pkg: ["openssl"]
    });
    await requireScanControl(admin, "gate-prewarm", component.id, control.id);

    const { change } = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      proposeChange(tx, {
        orgId: org.orgId,
        actorObjectId: org.orgId,
        requestId: `excl-prewarm-${randomUUID()}`,
        name: `excl-prewarm-${randomUUID()}`,
        targets: [component.id]
      })
    );

    const host = server.deps.pluginHost;
    expect(host, "the prewarm needs the real subprocess plugin host").toBeDefined();
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      prewarmGovernanceForChange(tx, getSharedCelSandbox(), host!, {
        orgId: org.orgId,
        changeObjectId: change.id,
        targetObjectIds: [component.id],
        actorObjectId: org.orgId
      })
    );

    const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(controlRuns)
        .where(and(eq(controlRuns.orgId, org.orgId), eq(controlRuns.changeObjectId, change.id)))
    );
    expect(rows).toHaveLength(1);
    const run = rows[0]!;
    // THE CACHED RUN: keyed on the lifecycle-edge gate identity the accept edge later reads.
    expect(run.gateKind).toBe("lifecycle_edge");
    expect(run.gateRef).toMatchObject({ fromState: "validating", toState: "accepted" });
    expect(run.status).toBe("pass");
    const evidence = run.evidence as unknown as ScanEvidence;
    expect(evidence.severityCounts.high).toBe(1);
    expect(evidence.effectiveSeverityCounts?.high).toBe(0);
    expect(evidence.exclusions?.appliedCount).toBe(1);
  });

  it("G3: THE AND IS TOP-DOWN — a component clause with only the instance rungs admitting has NO effect; add every rung above it and it applies", async () => {
    await admitAtInstance(["platform", "trust_domain"], "no_fix_available");

    const org = await createTestOrg(server, "excl-and");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const { containmentDomain, service, component } = await buildChain(admin, "and");

    await exclusionPolicy(admin, "clause-comp", component.id, {
      exclude: { class: "no_fix_available" }
    });
    const control = await scanControl(admin, org, {
      suffix: "excl-and",
      sev: ["HIGH"],
      fix: ["n"],
      pkg: ["openssl"]
    });
    await requireScanControl(admin, "gate-and", component.id, control.id);

    // ARM 1 — org, containment domain and service are all silent, so the AND fails.
    const blocked = await admin.changes.propose({ name: "excl-and-1", targets: [component.id] });
    const blockedRun = await waitForControlRun(admin, blocked.id, control.id, "fail");
    expect(blockedRun.evidence).not.toHaveProperty("exclusions");

    // ARM 2 — the NEGATIVE CONTROL. Every represented rung above the component now admits the
    // class, and the same clause applies. Only the admissions changed.
    await exclusionPolicy(admin, "admit-org", org.orgId, { admit: ["no_fix_available"] });
    await exclusionPolicy(admin, "admit-dom", containmentDomain.id, {
      admit: ["no_fix_available"]
    });
    await exclusionPolicy(admin, "admit-svc", service.id, { admit: ["no_fix_available"] });

    const allowed = await admin.changes.propose({ name: "excl-and-2", targets: [component.id] });
    const allowedRun = await waitForControlRun(admin, allowed.id, control.id, "pass");
    const evidence = allowedRun.evidence as unknown as ScanEvidence;
    expect(evidence.exclusions?.appliedCount).toBe(1);
    expect(evidence.exclusions?.applied[0]?.tier).toBe("component");
  });

  it("G4: AN UNEVALUABLE CONDITION YIELDS NO EXCLUSION — while the SAME broken condition still supplies a CEILING", async () => {
    // The two dimensions need OPPOSITE error handling (ADR-0033 §4) and must not share a helper.
    // Dropping a CEILING converts a fail into a pass, so an errored contributor is re-admitted
    // there. ADMITTING a loosening whose condition could not be evaluated *is* the fail-open, so it
    // is dropped here. This test fails if either sign is wrong.
    await admitAtInstance(["platform", "trust_domain"], "no_fix_available");

    const org = await createTestOrg(server, "excl-cel");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const { component } = await buildChain(admin, "cel");

    const BROKEN = "nosuchroot.nosuchfield == 1";
    await exclusionPolicy(
      admin,
      "clause-broken",
      org.orgId,
      { exclude: { class: "no_fix_available" } },
      BROKEN
    );
    // A LOOSE ceiling under the SAME broken condition. If the errored contributor were dropped from
    // the ceiling too, the applied maxHigh would fall back to the fail-closed default 0.
    await scanFloorPolicy(admin, "floor-broken", org.orgId, { maxHigh: 9 }, BROKEN);

    const control = await scanControl(admin, org, {
      suffix: "excl-cel",
      sev: ["HIGH"],
      fix: ["n"],
      pkg: ["openssl"]
    });
    await requireScanControl(admin, "gate-cel", component.id, control.id);

    const change = await admin.changes.propose({ name: "excl-cel", targets: [component.id] });
    // The verdict PASSES because the errored CEILING was re-admitted (maxHigh 9), not because
    // anything was excluded.
    const run = await waitForControlRun(admin, change.id, control.id, "pass");
    const evidence = run.evidence as unknown as ScanEvidence;
    expect(evidence.threshold.maxHigh, "the errored ceiling still binds").toBe(9);
    expect(evidence.severityCounts.high).toBe(1);
    // THE ARM THAT MATTERS: nothing was excluded.
    expect(run.evidence).not.toHaveProperty("exclusions");

    // NEGATIVE CONTROL — the same clause WITHOUT a condition does apply, so the refusal above is
    // about the unevaluable condition and not about the fixture.
    await exclusionPolicy(admin, "clause-ok", org.orgId, {
      exclude: { class: "no_fix_available" }
    });
    const ok = await admin.changes.propose({ name: "excl-cel-ok", targets: [component.id] });
    const okRun = await waitForControlRun(admin, ok.id, control.id, "pass");
    expect((okRun.evidence as unknown as ScanEvidence).exclusions?.appliedCount).toBe(1);
  });

  it("G5: EXCLUSIONS NEVER UNION ACROSS TARGETS — a clause anchored in A's containment domain does not reach sibling B", async () => {
    await admitAtInstance(["platform", "trust_domain"], "no_fix_available");

    const org = await createTestOrg(server, "excl-targets");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const a = await buildChain(admin, "targets-a");
    const b = await buildChain(admin, "targets-b");

    // Anchored in A's containment domain, which is NOT on B's chain at all.
    await exclusionPolicy(admin, "admit-org-t", org.orgId, { admit: ["no_fix_available"] });
    await exclusionPolicy(admin, "clause-a-only", a.containmentDomain.id, {
      exclude: { class: "no_fix_available" }
    });

    const control = await scanControl(admin, org, {
      suffix: "excl-targets",
      sev: ["HIGH"],
      fix: ["n"],
      pkg: ["openssl"]
    });
    await requireScanControl(admin, "gate-targets", org.orgId, control.id);

    // BOTH components on one change: the clause is admitted for A and absent for B, so the
    // intersection is empty and NOTHING is excluded. A union here would silently loosen B.
    const shared = await admin.changes.propose({
      name: "excl-two-targets",
      targets: [a.component.id, b.component.id]
    });
    const sharedRun = await waitForControlRun(admin, shared.id, control.id, "fail");
    expect(sharedRun.evidence).not.toHaveProperty("exclusions");

    // NEGATIVE CONTROL: A alone does get the exclusion, so the refusal above is about the target
    // SET and not about the clause being unadmitted.
    const alone = await admin.changes.propose({
      name: "excl-one-target",
      targets: [a.component.id]
    });
    const aloneRun = await waitForControlRun(admin, alone.id, control.id, "pass");
    expect((aloneRun.evidence as unknown as ScanEvidence).exclusions?.appliedCount).toBe(1);
  });

  it("G8: an EXCLUDED finding's row is retention class E; an ordinary one stays O", async () => {
    // ADR-0024 §D1 assigns classes PER ROW, and ADR-0033 D10 splits this table by evidentiary role:
    // an excluded finding explains a live verdict (accepted-risk evidence), an ordinary one is
    // telemetry. Collapsing the two either keeps the highest-cardinality table in the system forever
    // or discards the only per-finding record of why a promotion was allowed.
    await admitAtInstance(["platform", "trust_domain"], "no_fix_available");

    const org = await createTestOrg(server, "excl-retain");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const { component } = await buildChain(admin, "retain");

    await exclusionPolicy(admin, "clause-retain", org.orgId, {
      exclude: { class: "no_fix_available", pkgName: "openssl" }
    });
    // Two findings: `zlib` HAS a fix (ordinary, class O), `openssl` does not (excluded, class E).
    // Both LOW so the verdict is decided by the ceiling, not by this test's point.
    const control = await scanControl(admin, org, {
      suffix: "excl-retain",
      sev: ["LOW", "LOW"],
      fix: ["y", "n"],
      pkg: ["zlib", "openssl"]
    });
    await requireScanControl(admin, "gate-retain", component.id, control.id);

    const change = await admin.changes.propose({ name: "excl-retain", targets: [component.id] });
    const run = await waitForControlRun(admin, change.id, control.id, "pass");
    expect((run.evidence as unknown as ScanEvidence).exclusions?.appliedCount).toBe(1);

    const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(scanFindings)
        .where(and(eq(scanFindings.orgId, org.orgId), eq(scanFindings.controlRunId, run.id)))
        .orderBy(asc(scanFindings.ordinal))
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ pkgName: "zlib", retentionClass: "O" });
    expect(rows[1]).toMatchObject({ pkgName: "openssl", retentionClass: "E" });
  });

  // ===========================================================================================
  // THE COMMANDER'S MANAGED SCAN — resolution AND application server-side, and the `firedPolicies`
  // fix that made anything below the instance floors visible there at all.
  // ===========================================================================================

  it("G6: the promotion scan step resolves the REAL firing set, so an admitted clause applies there too", async () => {
    await admitAtInstance(["platform", "trust_domain"], "no_fix_available");

    const org = await createTestOrg(server, "excl-managed");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const { component } = await buildChain(admin, "managed");

    // Authored at ORG — invisible to this step until M22.2, because it resolved with
    // `firedPolicies: []` and admitted only the instance floors.
    await exclusionPolicy(admin, "clause-managed", org.orgId, {
      exclude: { class: "no_fix_available" }
    });

    const { change } = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      proposeChange(tx, {
        orgId: org.orgId,
        actorObjectId: org.orgId,
        requestId: `excl-managed-${randomUUID()}`,
        name: `excl-managed-${randomUUID()}`,
        targets: [component.id],
        type: "image",
        sourceRef: {
          artifact_digest: MANAGED_DIGEST,
          image: `registry.test/scp/x@${MANAGED_DIGEST}`
        }
      })
    );

    await runPromotionScanStep(
      server.deps.db,
      { orgId: org.orgId, changeIdOrUrn: change.id, actorObjectId: org.orgId },
      fixedRunner(() => ({
        ok: true,
        report: {
          scannedDigest: MANAGED_DIGEST,
          scannerVersion: "0.53.0",
          severityCounts: { critical: 0, high: 1, medium: 0, low: 0 },
          findings: [{ severity: "high", vulnerabilityId: "CVE-2026-77", pkgName: "openssl" }]
        }
      }))
    );

    const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(controlRuns)
        .where(
          and(
            eq(controlRuns.orgId, org.orgId),
            eq(controlRuns.changeObjectId, change.id),
            eq(controlRuns.controlObjectId, MANAGED_SCAN_CONTROL_OBJECT_ID)
          )
        )
    );
    expect(rows).toHaveLength(1);
    const evidence = rows[0]!.evidence as unknown as ScanEvidence;
    // The fail-closed default is maxHigh 0, so this run passes ONLY because the HIGH was excluded.
    expect(rows[0]!.status).toBe("pass");
    expect(evidence.severityCounts.high).toBe(1);
    expect(evidence.effectiveSeverityCounts?.high).toBe(0);
    expect(evidence.exclusions?.appliedCount).toBe(1);
  });

  it("G7: an OPENSCAP verdict is NEVER excluded from — refused by WHAT SCANNED, and it says so", async () => {
    // `parseOscapResult` counts failed XCCDF rule-results: no package, no purl, no FixedVersion, no
    // Class, and no `critical` at all. The refusal must be keyed on the METHOD, never on "there
    // were no findings to exclude" — so this fixture hands the openscap runner a NON-EMPTY findings
    // array, which a length-based guard would happily exclude from.
    await adminPool.query(
      `INSERT INTO scanner_assignments (executor_type, methods) VALUES ('rpm', '["openscap"]'::jsonb)
         ON CONFLICT (executor_type) DO UPDATE SET methods = EXCLUDED.methods`
    );
    try {
      await admitAtInstance(["platform", "trust_domain"], "no_fix_available");

      const org = await createTestOrg(server, "excl-oscap");
      const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
      const { component } = await buildChain(admin, "oscap");
      await exclusionPolicy(admin, "clause-oscap", org.orgId, {
        exclude: { class: "no_fix_available" }
      });

      const digest = `sha256:${"c".repeat(64)}`;
      const { change } = await withTenantTx(server.deps.db, org.orgId, (tx) =>
        proposeChange(tx, {
          orgId: org.orgId,
          actorObjectId: org.orgId,
          requestId: `excl-oscap-${randomUUID()}`,
          name: `excl-oscap-${randomUUID()}`,
          targets: [component.id],
          type: "rpm",
          sourceRef: { artifact_digest: digest, image: `registry.test/scp/o@${digest}` }
        })
      );

      await runPromotionScanStep(
        server.deps.db,
        { orgId: org.orgId, changeIdOrUrn: change.id, actorObjectId: org.orgId },
        fixedRunner(() => ({
          ok: true,
          report: {
            scannedDigest: digest,
            scannerVersion: "1.3.9",
            severityCounts: { critical: 0, high: 1, medium: 0, low: 0 },
            findings: [{ severity: "high", vulnerabilityId: "xccdf_rule_x" }]
          }
        }))
      );

      const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
        tx
          .select()
          .from(controlRuns)
          .where(
            and(
              eq(controlRuns.orgId, org.orgId),
              eq(controlRuns.changeObjectId, change.id),
              eq(controlRuns.controlObjectId, MANAGED_SCAN_CONTROL_OBJECT_ID)
            )
          )
      );
      expect(rows).toHaveLength(1);
      const evidence = rows[0]!.evidence as unknown as ScanEvidence;
      expect(evidence.scanner).toBe("openscap");
      expect(evidence.findingsRecord).toBe("unsupported");
      // STATED, not inferred: the exclusion was refused because of the scanner family.
      expect(evidence.exclusions?.refused).toBe("unsupported");
      expect(evidence.exclusions?.appliedCount).toBe(0);
      // The HIGH still counts, so the verdict still fails closed.
      expect(rows[0]!.status).toBe("fail");
      expect(evidence.effectiveSeverityCounts?.high).toBe(1);
    } finally {
      await adminPool.query(
        `INSERT INTO scanner_assignments (executor_type, methods) VALUES ('rpm', '["trivy"]'::jsonb)
           ON CONFLICT (executor_type) DO UPDATE SET methods = EXCLUDED.methods`
      );
    }
  });

  // ===========================================================================================
  // THE STORAGE CONTRACT
  // ===========================================================================================

  it("G9: the admission table's class CHECK agrees with ScanExclusionClassSchema, and refuses anything else", async () => {
    // Two copies of one list is a cost migration 0066's header states rather than hides. This test
    // is what keeps them from drifting: a fifth class added to the schema and not to the CHECK would
    // be an admission an operator believes they granted and that no row can ever hold.
    for (const cls of ["no_fix_available", "vendor_latest", "declared_fact", "approved_override"]) {
      await expect(
        adminPool.query(
          `INSERT INTO scan_exclusion_admissions (tier, class) VALUES ('platform', $1)`,
          [cls]
        )
      ).resolves.toBeDefined();
    }
    await expect(
      adminPool.query(
        `INSERT INTO scan_exclusion_admissions (tier, class) VALUES ('platform', 'no_fix_availble')`
      )
    ).rejects.toThrow();
    // ...and `domain` is refused too: the literal is `trust_domain`, never the ambiguous spelling.
    await expect(
      adminPool.query(
        `INSERT INTO scan_exclusion_admissions (tier, class) VALUES ('domain', 'no_fix_available')`
      )
    ).rejects.toThrow();
  });

  it("G10: the RUNTIME role can READ admissions and can NEVER write them", async () => {
    // Two independent barriers (DESIGN §4.2): `scp_app` holds SELECT only, and the sole RLS policy
    // is `FOR SELECT`. A gate must be able to resolve exclusions over the ordinary tenant
    // transaction — no privileged connection anywhere on an evaluation path.
    await admitAtInstance(["platform"], "no_fix_available");
    const org = await createTestOrg(server, "excl-rls");
    const read = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.execute<{ tier: string }>(`SELECT tier FROM scan_exclusion_admissions` as never)
    );
    expect(read.rows.length).toBeGreaterThan(0);
    await expect(
      withTenantTx(server.deps.db, org.orgId, (tx) =>
        tx.execute(
          `INSERT INTO scan_exclusion_admissions (tier, class) VALUES ('trust_domain', 'vendor_latest')` as never
        )
      )
    ).rejects.toThrow();
  });
});
