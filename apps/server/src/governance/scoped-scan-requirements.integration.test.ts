import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpApiError, ScpClient } from "@scp/sdk";
import type { ScanThresholdContribution } from "@scp/schemas";
import { withTenantTx } from "../db/tenant-tx.js";
import { mergeScanThresholds } from "./scan-requirements.js";
import {
  createOrphanComponent,
  createTestOrg,
  listenTestServer,
  waitUntil,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/**
 * M17.5 — SCOPED SCAN-REQUIREMENT POLICIES (ADR-0016), the BUILD_AND_TEST.md §8 M17 "Integration
 * (scoped scan)" definition of done, proven at the REAL gate against real Postgres.
 *
 * Every assertion here is end-to-end through the public API and the real governance gate: a real
 * `policy` graph object, the real `matchPoliciesForTargets`/`containmentChain` walk, the real
 * instance-scoped floor table under real RLS, the real subprocess plugin host running the real
 * `scan-result-control` against a real (loopback) Trivy-shaped result. Nothing here asserts on a
 * hand-built merge input — the merged ceiling is read back out of the CONTROL RUN EVIDENCE the gate
 * actually persisted, which is the only place a tautology could not hide.
 *
 * The six tiers, top-down:
 *
 *   platform -> trust domain (partition) -> org -> containment domain -> service -> component
 *
 * TWO SENSES OF "DOMAIN": `trust_domain` is the ambient federation boundary ABOVE org (an
 * instance-scoped floor row, no `org_id`); `containment_domain` is the intra-org `domain` OBJECT
 * TYPE BELOW org (an ordinary graph node). The fixture below builds BOTH, in the same chain, so the
 * two can be told apart in the resolved contributor list rather than taken on faith.
 */

const OPERATOR_TOKEN = "m17-5-operator-token-fixture";
const MATCH_DIGEST = "sha256:cccc222222222222222222222222222222222222222222222222222222222222";

interface TrivySource {
  url: string;
  close(): Promise<void>;
}

/** Loopback-only Trivy result fixture (never the internet) — the verdict is encoded in the query
 *  string so one server backs every binding in this file. Same shape/rationale as the M17.1 suite's. */
async function startTrivySource(): Promise<TrivySource> {
  const httpServer = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const digest = url.searchParams.get("digest") ?? MATCH_DIGEST;
    const sev = (url.searchParams.get("sev") ?? "").split(",").filter(Boolean);
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
            Vulnerabilities: sev.map((s, i) => ({ VulnerabilityID: `CVE-2026-${7000 + i}`, Severity: s }))
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

async function waitForControlRun(admin: ScpClient, changeId: string, controlId: string, status: string) {
  return waitUntil(
    async () => {
      const runs = await admin.controlRuns.listForChange(changeId);
      const run = runs.items.find((r) => r.controlObjectId === controlId);
      return run?.status === status ? run : undefined;
    },
    { describe: `control ${controlId} on change ${changeId} reports '${status}'`, timeoutMs: 25_000 }
  );
}

async function assertStaysExecuting(admin: ScpClient, changeId: string, graceMs = 3_000): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, graceMs));
  expect((await admin.changes.get(changeId)).state).toBe("executing");
}

async function expectApiError(fn: () => Promise<unknown>): Promise<ScpApiError> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof ScpApiError) return err;
    throw err;
  }
  throw new Error("expected an ScpApiError, but the call succeeded");
}

interface ScanEvidenceShape {
  threshold: { maxCritical: number; maxHigh: number; maxMedium?: number; maxLow?: number };
  thresholdSource?: string;
  thresholdContributors?: ScanThresholdContribution[];
}

describe("M17.5 scoped scan-requirement policies (six tiers, most-restrictive-wins)", () => {
  let server: ListeningTestServer;
  let trivy: TrivySource;
  let operator: ScpClient;

  beforeAll(async () => {
    trivy = await startTrivySource();
    server = await listenTestServer({
      withEventRelay: true,
      withReconcileLoop: true,
      operatorToken: OPERATOR_TOKEN,
      pluginHostOptions: { callTimeoutMs: 15_000, restartBackoffBaseMs: 50, maxRestartBackoffMs: 300 }
    });
    // The operator credential is deployment-level, but the route still requires an authenticated
    // principal, so the operator client logs in as SOME org's admin. That is deliberately not what
    // authorizes the write — proven by the tenant-cannot-write test below, where the very same
    // client without the token is refused.
    const bootstrap = await createTestOrg(server, "m17-5-operator-home");
    operator = new ScpClient({ baseUrl: server.baseUrl, token: bootstrap.adminToken });
  });

  afterAll(async () => {
    await server?.close();
    await trivy?.close();
  });

  // -----------------------------------------------------------------------------------------
  // Fixture builders
  // -----------------------------------------------------------------------------------------

  /** Replaces BOTH instance-scoped floor rows. Instance floors are global to the deployment, so
   *  every test sets exactly the floors it needs (a `null` clears a ceiling, which then stops
   *  contributing — "no floor" is never read as 0). */
  async function setInstanceFloors(opts: {
    platform?: { maxCritical?: number; maxHigh?: number; maxMedium?: number; maxLow?: number };
    trustDomain?: { maxCritical?: number; maxHigh?: number; maxMedium?: number; maxLow?: number };
  }): Promise<void> {
    const body = (t?: Record<string, number>) => ({
      origin: "local" as const,
      maxCritical: t?.maxCritical ?? null,
      maxHigh: t?.maxHigh ?? null,
      maxMedium: t?.maxMedium ?? null,
      maxLow: t?.maxLow ?? null
    });
    await operator.instanceScanFloors.put("platform", body(opts.platform), OPERATOR_TOKEN);
    await operator.instanceScanFloors.put("trust_domain", body(opts.trustDomain), OPERATOR_TOKEN);
  }

  /** org root -> containment domain -> service -> component, with the component reachable from BOTH
   *  the service (`contains`) and the org root (its own `domain_id`) — the real four-tier chain the
   *  org-and-below resolver walks. */
  async function buildChain(admin: ScpClient, label: string) {
    const containmentDomain = await admin.object("domain").create({ name: `dom-${label}` });
    const service = await admin.object("service").create({ name: `svc-${label}`, domainId: containmentDomain.id });
    const component = await createOrphanComponent(admin, `comp-${label}`);
    await admin.relationships.create({ typeId: "contains", fromId: service.id, toId: component.id });
    return { containmentDomain, service, component };
  }

  /** A policy carrying ONLY a `scanThreshold` effect, scoped at one object — the org-and-below
   *  authoring surface (graph-native policy data, charter principle 2). */
  async function scanFloorPolicy(
    admin: ScpClient,
    name: string,
    scopeObjectId: string,
    threshold: Record<string, number>
  ) {
    return admin.policies.create({
      name,
      properties: {
        scope: { objectRef: scopeObjectId },
        enforcement: "advisory",
        effects: [{ scanThreshold: threshold }]
      }
    });
  }

  /** A real `control` bound to the real `scan-result-control` plugin. `configThreshold` is left
   *  UNSET by default, so the ONLY ceiling in play is the one the gate resolved and threaded. */
  async function scanControl(
    admin: ScpClient,
    org: TestOrg,
    opts: { suffix: string; severities: string[]; configThreshold?: Record<string, number> }
  ) {
    const control = await admin.controls.create({
      name: `scan-control-${opts.suffix}`,
      urn: `urn:scp:${org.orgId}:control:${opts.suffix}`,
      properties: { category: "security" }
    });
    const params = new URLSearchParams({ digest: MATCH_DIGEST, sev: opts.severities.join(",") });
    await admin.controls.putBinding(control.id, {
      pluginModule: "scan-result-control",
      pluginInstanceId: `scan-${control.id}`,
      config: {
        url: `${trivy.url}?${params.toString()}`,
        expectedDigest: MATCH_DIGEST,
        ...(opts.configThreshold ? { threshold: opts.configThreshold } : {})
      }
    });
    return control;
  }

  async function requireScanControl(admin: ScpClient, name: string, scopeObjectId: string, controlId: string) {
    return admin.policies.create({
      name,
      properties: {
        scope: { objectRef: scopeObjectId },
        enforcement: "required",
        effects: [{ requireControls: [controlId] }]
      }
    });
  }

  // -----------------------------------------------------------------------------------------
  // (a) The effective threshold is the per-severity MIN across ALL SIX tiers — read back out of
  //     the evidence the REAL gate persisted.
  // -----------------------------------------------------------------------------------------

  it("(a) effective threshold = per-severity MIN across all six tiers — platform, trust domain (partition), org, containment domain, service, component — as recorded in the gate's own scan evidence", async () => {
    // Each tier sets exactly ONE severity to a distinctive value, and every tier sets a LOOSER
    // value for the others. If the merge were anything other than a per-severity MIN over the
    // whole set — a "most specific wins" override, a first-wins, a last-wins — at least one
    // severity below would come out wrong.
    await setInstanceFloors({
      platform: { maxCritical: 90, maxHigh: 90, maxMedium: 90, maxLow: 90 },
      trustDomain: { maxHigh: 80, maxMedium: 80, maxLow: 80 }
    });

    const org = await createTestOrg(server, "six-tier");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const { containmentDomain, service, component } = await buildChain(admin, "six-tier");

    await scanFloorPolicy(admin, "floor-org", org.orgId, { maxMedium: 7, maxLow: 70 });
    await scanFloorPolicy(admin, "floor-containment-domain", containmentDomain.id, { maxLow: 6, maxCritical: 60 });
    await scanFloorPolicy(admin, "floor-service", service.id, { maxCritical: 5, maxHigh: 50 });
    await scanFloorPolicy(admin, "floor-component", component.id, { maxHigh: 4 });

    // A verdict comfortably inside the merged ceiling, so the outcome is `pass` and the evidence is
    // recorded on a change that also PROMOTES (i.e. this is the real gate, not a parked one).
    const control = await scanControl(admin, org, { suffix: "six-tier", severities: ["MEDIUM", "LOW"] });
    await requireScanControl(admin, "scan-gate", component.id, control.id);

    const change = await admin.changes.propose({ name: "six-tier-change", targets: [component.id] });
    const run = await waitForControlRun(admin, change.id, control.id, "pass");
    const evidence = run.evidence as unknown as ScanEvidenceShape;

    // THE ASSERTION: per-severity MIN across all six tiers.
    //   maxCritical: platform 90, containment-domain 60, service 5            -> 5
    //   maxHigh:     platform 90, trust-domain 80, service 50, component 4    -> 4
    //   maxMedium:   platform 90, trust-domain 80, org 7                      -> 7
    //   maxLow:      platform 90, trust-domain 80, org 70, containment-dom 6   -> 6
    expect(evidence.threshold).toEqual({ maxCritical: 5, maxHigh: 4, maxMedium: 7, maxLow: 6 });
    expect(evidence.thresholdSource).toBe("scoped");

    // ...and every one of the six tiers is named as a contributor, so a Decision can explain WHICH
    // tier set which ceiling (charter principle 6). Note `trust_domain` — never bare `domain` — is
    // distinct from the `containment_domain` tier, which is the intra-org `domain` object type.
    const tiers = new Set((evidence.thresholdContributors ?? []).map((c) => c.tier));
    expect([...tiers].sort()).toEqual(
      ["component", "containment_domain", "org", "platform", "service", "trust_domain"].sort()
    );
  });

  // -----------------------------------------------------------------------------------------
  // (b) A COMPONENT floor tighter than its org's BLOCKS a promotion the org floor alone passes —
  //     both arms run at the REAL gate, so this is not a merge-function tautology.
  // -----------------------------------------------------------------------------------------

  it("(b) a COMPONENT floor tighter than its org's blocks a promotion the org floor alone would have passed — proven with both arms at the real gate", async () => {
    await setInstanceFloors({}); // no instance floors — this test is purely about org vs component

    // ARM 1 — org floor ONLY (maxHigh: 5). Two HIGHs are inside it: the change PROMOTES.
    const orgA = await createTestOrg(server, "org-floor-only");
    const adminA = new ScpClient({ baseUrl: server.baseUrl, token: orgA.adminToken });
    const chainA = await buildChain(adminA, "arm1");
    await scanFloorPolicy(adminA, "floor-org", orgA.orgId, { maxHigh: 5 });
    const controlA = await scanControl(adminA, orgA, { suffix: "arm1", severities: ["HIGH", "HIGH"] });
    await requireScanControl(adminA, "scan-gate", chainA.component.id, controlA.id);

    const changeA = await adminA.changes.propose({ name: "arm1-change", targets: [chainA.component.id] });
    const runA = await waitForControlRun(adminA, changeA.id, controlA.id, "pass");
    expect((runA.evidence as unknown as ScanEvidenceShape).threshold.maxHigh).toBe(5);
    await waitUntil(async () => ((await adminA.changes.get(changeA.id)).state === "validating" ? true : undefined), {
      describe: `change ${changeA.id} reaches 'validating'`,
      timeoutMs: 25_000
    });
    expect((await adminA.changes.promote(changeA.id)).state).toBe("promoted");

    // ARM 2 — the SAME org floor, plus a COMPONENT floor that TIGHTENS maxHigh to 0. Identical
    // verdict, identical everything else: the component tier is the only difference.
    const orgB = await createTestOrg(server, "component-tightens");
    const adminB = new ScpClient({ baseUrl: server.baseUrl, token: orgB.adminToken });
    const chainB = await buildChain(adminB, "arm2");
    await scanFloorPolicy(adminB, "floor-org", orgB.orgId, { maxHigh: 5 });
    await scanFloorPolicy(adminB, "floor-component", chainB.component.id, { maxHigh: 0 });
    const controlB = await scanControl(adminB, orgB, { suffix: "arm2", severities: ["HIGH", "HIGH"] });
    await requireScanControl(adminB, "scan-gate", chainB.component.id, controlB.id);

    const changeB = await adminB.changes.propose({ name: "arm2-change", targets: [chainB.component.id] });
    const runB = await waitForControlRun(adminB, changeB.id, controlB.id, "fail");
    const evidenceB = runB.evidence as unknown as ScanEvidenceShape;
    expect(evidenceB.threshold.maxHigh).toBe(0); // the component TIGHTENED the org's 5 to 0
    expect(runB.detail).toMatch(/exceeds/i);

    // The wave never starts, and the block is an audited Decision naming the failed control.
    await assertStaysExecuting(adminB, changeB.id);
    const explained = await adminB.changes.explain(changeB.id);
    const gateBlock = explained.decisions.find((d) => d.kind === "gate" && d.verdict === "block");
    expect(gateBlock, "a blocked promotion must persist a Decision (charter principle 6)").toBeDefined();
    const policyEntry = ((gateBlock!.reasonTree as { policies?: Array<Record<string, unknown>> }).policies ?? []).find(
      (p) => p.name === "scan-gate"
    );
    const controlEffect = (
      policyEntry!.effects as Array<{ kind: string; satisfied: boolean; detail: Record<string, unknown> }>
    ).find((e) => e.kind === "requireControls");
    expect(controlEffect?.satisfied).toBe(false);
    expect(controlEffect?.detail.outcome).toBe("fail");
  });

  // -----------------------------------------------------------------------------------------
  // (c) The instance-scoped floors apply to EVERY org on the deployment.
  // -----------------------------------------------------------------------------------------

  it("(c) the instance-scoped floors (platform + trust domain) apply to EVERY org on the deployment — and tighten a per-binding config threshold that would otherwise have passed", async () => {
    await setInstanceFloors({ platform: { maxHigh: 0 } });

    // Both orgs deliberately configure a LOOSE per-binding threshold (maxHigh: 99). Under M17.1
    // that alone would have passed a verdict with one HIGH. The instance floor must tighten it —
    // in BOTH orgs, neither of which authored anything instance-wide.
    for (const label of ["tenant-one", "tenant-two"]) {
      const org = await createTestOrg(server, label);
      const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
      const chain = await buildChain(admin, label);
      const control = await scanControl(admin, org, {
        suffix: label,
        severities: ["HIGH"],
        configThreshold: { maxCritical: 99, maxHigh: 99 }
      });
      await requireScanControl(admin, "scan-gate", chain.component.id, control.id);

      const change = await admin.changes.propose({ name: `${label}-change`, targets: [chain.component.id] });
      const run = await waitForControlRun(admin, change.id, control.id, "fail");
      const evidence = run.evidence as unknown as ScanEvidenceShape;
      expect(evidence.threshold.maxHigh, `${label} must be bound by the platform floor`).toBe(0);
      expect(evidence.thresholdSource).toBe("scoped");
      expect((evidence.thresholdContributors ?? []).some((c) => c.tier === "platform")).toBe(true);
      await assertStaysExecuting(admin, change.id);
    }

    // ...and every org SEES the same instance floors through the tenant-facing read.
    const orgC = await createTestOrg(server, "tenant-three");
    const adminC = new ScpClient({ baseUrl: server.baseUrl, token: orgC.adminToken });
    const floors = await adminC.instanceScanFloors.list();
    expect(floors.find((f) => f.tier === "platform")?.maxHigh).toBe(0);
    expect(floors.map((f) => f.tier).sort()).toEqual(["platform", "trust_domain"]);
  });

  // -----------------------------------------------------------------------------------------
  // (d) NO tenant can write the instance floors, loosen the resolved floor, or see across to
  //     another tenant — driven through a REAL tenant transaction under RLS, not a mock.
  // -----------------------------------------------------------------------------------------

  it("(d) no tenant can WRITE the instance floors — the write is refused by RLS on a real tenant transaction (scp_app, NOBYPASSRLS) and by the API without the operator token", async () => {
    await setInstanceFloors({ platform: { maxHigh: 0 } });

    const org = await createTestOrg(server, "tenant-cannot-write");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });

    // 1. THE DATABASE ITSELF. `server.deps.db` is the request-serving pool authenticating as the
    //    least-privileged `scp_app` login role (NOSUPERUSER, NOBYPASSRLS), and `withTenantTx` sets
    //    `app.current_org_id` exactly as a real request does. This is the strongest possible form
    //    of the assertion: even with full application-layer cooperation, the write cannot land.
    for (const [what, statement] of [
      ["INSERT", sql`INSERT INTO scan_requirement_floors (tier, origin, max_high) VALUES ('platform', 'federated', 99)`],
      ["UPDATE", sql`UPDATE scan_requirement_floors SET max_high = 99`],
      ["DELETE", sql`DELETE FROM scan_requirement_floors`]
    ] as const) {
      await expect(
        withTenantTx(server.deps.db, org.orgId, (tx) => tx.execute(statement)),
        `a tenant transaction must not be able to ${what} an instance-scoped scan floor`
      ).rejects.toThrow();
    }

    // 2. ...while the tenant-READ works on that same connection, under the same RLS policy — so the
    //    refusal above is genuinely write-specific, not the table being unreachable.
    const readBack = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.execute<{ tier: string; max_high: number | null }>(
        sql`SELECT tier, max_high FROM scan_requirement_floors ORDER BY tier`
      )
    );
    expect(readBack.rows.find((r) => r.tier === "platform")?.max_high).toBe(0);

    // 3. THE API. The tenant's own org admin — the most privileged tenant principal there is —
    //    cannot author a floor, because no RBAC permission grants it.
    const err = await expectApiError(() =>
      admin.instanceScanFloors.put("platform", { origin: "local", maxHigh: 99 }, "not-the-operator-token")
    );
    expect(err.status).toBe(403);

    // The floor is unchanged after all of that.
    expect((await admin.instanceScanFloors.list()).find((f) => f.tier === "platform")?.maxHigh).toBe(0);
  });

  it("(d) a tenant cannot LOOSEN the resolved floor — an org-scoped policy asking for a laxer ceiling than the platform floor changes nothing at the real gate", async () => {
    await setInstanceFloors({ platform: { maxHigh: 0 } });

    const org = await createTestOrg(server, "tenant-cannot-loosen");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const chain = await buildChain(admin, "loosen");

    // The tenant authors the laxest thing it can, at EVERY tier it controls.
    await scanFloorPolicy(admin, "loosen-org", org.orgId, { maxCritical: 999, maxHigh: 999 });
    await scanFloorPolicy(admin, "loosen-domain", chain.containmentDomain.id, { maxHigh: 999 });
    await scanFloorPolicy(admin, "loosen-service", chain.service.id, { maxHigh: 999 });
    await scanFloorPolicy(admin, "loosen-component", chain.component.id, { maxHigh: 999 });

    const control = await scanControl(admin, org, {
      suffix: "loosen",
      severities: ["HIGH"],
      configThreshold: { maxCritical: 999, maxHigh: 999 }
    });
    await requireScanControl(admin, "scan-gate", chain.component.id, control.id);

    const change = await admin.changes.propose({ name: "loosen-change", targets: [chain.component.id] });
    const run = await waitForControlRun(admin, change.id, control.id, "fail");
    // MIN(0, 999, 999, 999, 999, 999) = 0. A child may only TIGHTEN.
    expect((run.evidence as unknown as ScanEvidenceShape).threshold.maxHigh).toBe(0);
    await assertStaysExecuting(admin, change.id);
  });

  it("(d) one tenant's scan-requirement policies never reach another tenant's gate", async () => {
    await setInstanceFloors({}); // no instance floors, so ONLY per-org policy data is in play

    const orgX = await createTestOrg(server, "isolation-x");
    const adminX = new ScpClient({ baseUrl: server.baseUrl, token: orgX.adminToken });
    const chainX = await buildChain(adminX, "iso-x");
    // X sets a draconian org-wide ceiling.
    await scanFloorPolicy(adminX, "floor-org", orgX.orgId, { maxHigh: 0, maxMedium: 0, maxLow: 0 });

    const orgY = await createTestOrg(server, "isolation-y");
    const adminY = new ScpClient({ baseUrl: server.baseUrl, token: orgY.adminToken });
    const chainY = await buildChain(adminY, "iso-y");
    // Y sets nothing at all. If X's policies leaked across, Y's MEDIUM verdict would fail.
    const controlY = await scanControl(adminY, orgY, {
      suffix: "iso-y",
      severities: ["MEDIUM", "MEDIUM"],
      configThreshold: { maxCritical: 0, maxHigh: 0 }
    });
    await requireScanControl(adminY, "scan-gate", chainY.component.id, controlY.id);
    const changeY = await adminY.changes.propose({ name: "iso-y-change", targets: [chainY.component.id] });
    const runY = await waitForControlRun(adminY, changeY.id, controlY.id, "pass");
    // No tier contributed for Y — so the gate threaded nothing, the control fell back to Y's own
    // per-binding config, and X's ceilings are nowhere in Y's evidence.
    expect((runY.evidence as unknown as ScanEvidenceShape).thresholdSource).toBe("config");
    expect((runY.evidence as unknown as ScanEvidenceShape).thresholdContributors).toBeUndefined();
    expect((runY.evidence as unknown as ScanEvidenceShape).threshold.maxMedium).toBeUndefined();

    // ...and X's own gate really was bound by X's own ceiling (so the fixture isn't vacuous).
    const controlX = await scanControl(adminX, orgX, { suffix: "iso-x", severities: ["MEDIUM"] });
    await requireScanControl(adminX, "scan-gate", chainX.component.id, controlX.id);
    const changeX = await adminX.changes.propose({ name: "iso-x-change", targets: [chainX.component.id] });
    const runX = await waitForControlRun(adminX, changeX.id, controlX.id, "fail");
    expect((runX.evidence as unknown as ScanEvidenceShape).threshold.maxMedium).toBe(0);
  });

  // -----------------------------------------------------------------------------------------
  // (e) ORDER-INDEPENDENCE — the property ADR-0016 §4 leans on to make the documented
  //     containment-domain-vs-service ordering tie (containment.ts:60-73) harmless.
  // -----------------------------------------------------------------------------------------

  it("(e) resolution is ORDER-INDEPENDENT: the same tier set authored in a different order yields an identical effective threshold at the real gate", async () => {
    await setInstanceFloors({ platform: { maxCritical: 3, maxHigh: 9 }, trustDomain: { maxHigh: 2, maxMedium: 8 } });

    // Two orgs with IDENTICAL tier contributions, authored in OPPOSITE order. Creation order is
    // what drives `listPolicyCandidates`' row order, and therefore the order contributions reach
    // the merge — the only lever a test can actually pull on the real gate.
    const resolved: Array<ScanEvidenceShape["threshold"]> = [];
    for (const [label, order] of [
      ["forward", ["org", "containment_domain", "service", "component"]],
      ["reverse", ["component", "service", "containment_domain", "org"]]
    ] as const) {
      const org = await createTestOrg(server, `order-${label}`);
      const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
      const chain = await buildChain(admin, `order-${label}`);
      const byTier: Record<string, { id: string; threshold: Record<string, number> }> = {
        org: { id: org.orgId, threshold: { maxCritical: 7, maxMedium: 4 } },
        containment_domain: { id: chain.containmentDomain.id, threshold: { maxLow: 5, maxHigh: 6 } },
        service: { id: chain.service.id, threshold: { maxCritical: 1, maxLow: 9 } },
        component: { id: chain.component.id, threshold: { maxMedium: 3, maxHigh: 9 } }
      };
      for (const tier of order) {
        const spec = byTier[tier]!;
        await scanFloorPolicy(admin, `floor-${tier}`, spec.id, spec.threshold);
      }

      const control = await scanControl(admin, org, { suffix: `order-${label}`, severities: [] });
      await requireScanControl(admin, "scan-gate", chain.component.id, control.id);
      const change = await admin.changes.propose({ name: `order-${label}-change`, targets: [chain.component.id] });
      const run = await waitForControlRun(admin, change.id, control.id, "pass");
      resolved.push((run.evidence as unknown as ScanEvidenceShape).threshold);
    }

    // MIN over the whole set, regardless of visit order:
    //   maxCritical: platform 3, org 7, service 1        -> 1
    //   maxHigh:     platform 9, trust 2, dom 6, comp 9  -> 2
    //   maxMedium:   trust 8, org 4, comp 3              -> 3
    //   maxLow:      dom 5, service 9                    -> 5
    expect(resolved[0]).toEqual({ maxCritical: 1, maxHigh: 2, maxMedium: 3, maxLow: 5 });
    expect(resolved[1]).toEqual(resolved[0]);
  });

  it("(e) the merge itself is order-independent under EVERY permutation of its contributors", async () => {
    // The gate test above can only exercise two orderings; the merge is where the property lives,
    // so pin it exhaustively. This is the reason no precedence/ordering logic may ever be added to
    // the resolver: the documented containment-domain-vs-service tie would make it undefined.
    const contributors: ScanThresholdContribution[] = [
      { tier: "platform", source: "instance:platform:local", threshold: { maxCritical: 3, maxHigh: 9 } },
      { tier: "trust_domain", source: "instance:trust_domain:local", threshold: { maxHigh: 2, maxMedium: 8 } },
      { tier: "org", source: "policy:org", threshold: { maxCritical: 7, maxMedium: 4 } },
      { tier: "containment_domain", source: "policy:dom", threshold: { maxLow: 5, maxHigh: 6 } },
      { tier: "service", source: "policy:svc", threshold: { maxCritical: 1, maxLow: 9 } },
      { tier: "component", source: "policy:comp", threshold: { maxMedium: 3, maxHigh: 9 } }
    ];
    const expected = { maxCritical: 1, maxHigh: 2, maxMedium: 3, maxLow: 5 };

    const permute = <T,>(items: T[]): T[][] =>
      items.length <= 1
        ? [items]
        : items.flatMap((item, i) =>
            permute([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest])
          );

    const permutations = permute(contributors);
    expect(permutations).toHaveLength(720);
    for (const permutation of permutations) {
      expect(mergeScanThresholds(permutation).threshold).toEqual(expected);
    }
  });

  // -----------------------------------------------------------------------------------------
  // Regression guard: with NO tier contributing, the M17.1 behaviour is byte-for-byte unchanged.
  // -----------------------------------------------------------------------------------------

  it("with no tier contributing a ceiling, the gate threads nothing and the control falls back to its per-binding config.threshold (M17.1, unchanged)", async () => {
    await setInstanceFloors({});

    const org = await createTestOrg(server, "no-scoped-floor");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const chain = await buildChain(admin, "fallback");
    const control = await scanControl(admin, org, {
      suffix: "fallback",
      severities: ["MEDIUM"],
      configThreshold: { maxCritical: 0, maxHigh: 0, maxMedium: 0 }
    });
    await requireScanControl(admin, "scan-gate", chain.component.id, control.id);

    const change = await admin.changes.propose({ name: "fallback-change", targets: [chain.component.id] });
    const run = await waitForControlRun(admin, change.id, control.id, "fail");
    const evidence = run.evidence as unknown as ScanEvidenceShape;
    expect(evidence.threshold).toEqual({ maxCritical: 0, maxHigh: 0, maxMedium: 0 });
    expect(evidence.thresholdSource).toBe("config");
    expect(evidence.thresholdContributors).toBeUndefined();
  });
});
