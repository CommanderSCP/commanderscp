import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import type { ScanEvidence } from "@scp/schemas";
import { withTenantTx } from "../db/tenant-tx.js";
import { controlRuns } from "../db/schema.js";
import { proposeChange } from "../coordination/changes-repo.js";
import { evaluateWaveGate } from "../coordination/gates.js";
import { prewarmGovernanceForChange } from "./gate-orchestrator.js";
import { getSharedCelSandbox } from "./cel-sandbox.js";
import { testDatabaseUrl } from "../test-support/harness.js";
import {
  createOrphanComponent,
  createTestOrg,
  createTestUser,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import { SCAN_RULE_TEST_CONTROL_REF } from "./test-support/scan-rule-control.js";

/**
 * M22.7 — THE ACTUATOR (ADR-0033 §10). The lever behind the signal.
 *
 * Everything M22 built before this increment produces a FACT and moves nothing. A control outcome is
 * cached and deliberately treated as a historical fact, so a grant approved after a change's gate has
 * already run is inert on that change **forever**: the operator sees an approved grant, the gate
 * keeps refusing, and nothing connects the two. BUILD_AND_TEST.md §8 M22 names this "the increment
 * this project most reliably forgets" and prescribes the proof exactly — *grant an exclusion after a
 * change has already failed its gate, assert it subsequently passes; delete the force forwarding and
 * this test must die.*
 *
 * THE LOOP IS OFF (`withPluginHost`, not `withReconcileLoop`) AND THAT IS DELIBERATE. Every test here
 * counts `control_runs` rows and asserts that a second evaluation creates one — or, for the stability
 * cases, that it creates none. A live reconcile loop is a COMPETING CONSUMER for exactly that work
 * and would make those counts non-deterministic. `prewarmGovernanceForChange` and `evaluateWaveGate`
 * are driven directly because they ARE the production entry points: `coordination/reconcile.ts`
 * calls the first once per tick for every `validating` change (`advanceValidatingChanges`) and the
 * second once per tick for every pending wave (`advanceExecutingChanges`), with exactly these
 * arguments. Driving them here is running the loop's body without the loop's scheduler.
 *
 * MUTATIONS RUN against this file (2026-08-17) — the MEASURED result of each, each applied ALONE
 * against a passing suite and reverted by an exact inverse edit. Baseline: 8 passed. Nothing below is
 * a prediction; where a measurement contradicted the guess that motivated the test, the measurement
 * is what is written.
 *
 *   M-1  DELETE `force` from the PREWARM's `ensureControlRuns` call (gate-orchestrator.ts)
 *          -> 3 failed (A1, A6, A7). THE INSTALLATION PROOF for the lifecycle-edge site: the grant
 *             resolves, the hash differs, and the cached verdict is handed back anyway.
 *   M-2  DELETE `force` from the EVALUATE site's `ensureControlRuns` call (same file)
 *          -> 1 failed (A2), and ONLY A2. Two call sites, two proofs: wiring one and not the other
 *             is the precise mistake M22.2's own measured mutation M-2 found in the threading.
 *   M-3  DELETE the `exclusionSetHash` stamp in `control-runner.ts`
 *          -> 3 failed (A1, A3, A7). NOTE WHAT SURVIVED: A2, A5 and A6 stayed green, because with
 *             nothing recorded every scan run looks stale and the gate force-re-runs on every pass —
 *             which still produces the RIGHT VERDICT. The damage is entirely amplification, and A3 is
 *             the only test that can see it. A suite of nothing but "the grant takes effect" cases
 *             would have called this mutation harmless.
 *   M-4  `scanExclusionSetHash` folds `Date.now()` into the digest
 *          -> 2 failed (A3, A7). The re-run storm: a control re-evaluated, and a row inserted, on
 *             every single ~1s tick for as long as the change is parked.
 *   M-5  `scanExclusionSetChangedForGate` compares EVERY cached run, not just ones whose evidence
 *        parses as `ScanEvidence`
 *          -> 1 failed (A8), and only A8. A non-scan control beside a scan control would be forced to
 *             re-run for as long as any clause exists anywhere in the org. A8 was written for this
 *             mutation after A4 turned out NOT to catch it: with nothing authored the expected hash is
 *             `undefined` too, so the comparison agrees by accident.
 *   M-6  revert `ensureControlRun`'s `latestControlRunForGate` to the gate-agnostic
 *        `latestControlRun` (M22.0a)
 *          -> 1 failed (A5), and only A5. The lifecycle-edge pass made while the grant was live
 *             authorises the later wave, long after the grant lapsed.
 *   M-7  `scanExclusionSetHash` returns a fixed string instead of `undefined` for an empty set
 *          -> 1 failed (A4). Every deployment that authored no exclusion would start writing a key it
 *             never had into evidence that is copied verbatim into signed promotion bundles.
 *
 * MUTATIONS RUN for A9/A10 (M22.6 review round, 2026-08-18). Baseline: 10 passed.
 *
 *   M-8  the D3 authority bar reads NO ceiling (`requiredOverrideApprovalTier(undefined)` in
 *        `scan-requirements.ts`'s `attachApprovedOverrides`)
 *          -> 4 failed: A9 here, plus O7/O8/O9 in
 *             `scan-declared-override-exclusions.integration.test.ts`. ONE deletion, both producers —
 *             which is the whole reason that resolution lives in the resolver rather than being
 *             threaded in from each gate site (see that function's docblock for the measurement that
 *             forced the change).
 *   M-9  the EARLIER, threaded design: `ceiling: undefined` at the PREWARM call site only
 *          -> before A9/A10 existed, NOTHING failed anywhere. That is why this pair is here: every
 *             case in the M22.5/M22.6 gate file is driven through the EVALUATE site, so the cached
 *             run the host-less accept edge reads was completely unguarded and completely green.
 *
 * Instance-scoped `scan_exclusion_admissions` rows are GLOBAL to the deployment and the integration
 * suite runs `singleFork` against ONE shared Postgres, so a row left behind would silently admit
 * loosenings in every later suite. They are cleared in an `afterEach` that runs regardless of
 * outcome, and once more at teardown.
 */

const OPERATOR_TOKEN = "m22-7-operator-token-fixture";
const MATCH_DIGEST = "sha256:aaaa888888888888888888888888888888888888888888888888888888888888";

interface TrivySource {
  url: string;
  close(): Promise<void>;
}

/** Loopback-only Trivy fixture (never the internet). Every entry carries a `FixedVersion`, so
 *  `no_fix_available` can never be the class that excluded a finding here. */
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

describe("M22.7 — the actuator: a grant approved after the gate ran actually moves the gate", () => {
  let server: ListeningTestServer;
  let trivy: TrivySource;
  let adminPool: pg.Pool;
  /** An ordinary tenant principal carrying the deployment operator token to the M22.9 admission
   *  route — the production write door for the two instance rungs. */
  let operator: ScpClient;

  beforeAll(async () => {
    trivy = await startTrivySource();
    server = await listenTestServer({
      operatorToken: OPERATOR_TOKEN,
      // The plugin host WITHOUT the reconcile loop — see this file's header. The host is real and
      // runs the real `scan-result-control` subprocess; only the scheduler is absent.
      withPluginHost: true,
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

  async function clearInstanceAdmissions() {
    await adminPool?.query("DELETE FROM scan_exclusion_admissions").catch(() => undefined);
  }

  afterEach(clearInstanceAdmissions);

  afterAll(async () => {
    await clearInstanceAdmissions();
    await adminPool?.end();
    await server?.close();
    await trivy?.close();
  });

  async function buildChain(org: TestOrg, admin: ScpClient, label: string) {
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
    return { containmentDomain, service, component };
  }

  async function overrideClause(admin: ScpClient, name: string, scopeObjectId: string) {
    // M22.8 — the authoring guard (`governance/scan-rule-authoring-guard.ts`) refuses a
    // `scanExclusion` rule that requires no scan control: such a document is silently inert,
    // because the six-tier resolution is reached only inside `if (allControlIds.length > 0)`.
    // `SCAN_RULE_TEST_CONTROL_REF` is a DANGLING reference on purpose — see that constant's own
    // doc: a real bound control would add a control run and change what these tests measure.
    const scanControlId = SCAN_RULE_TEST_CONTROL_REF;
    return admin.policies.create({
      name,
      properties: {
        scope: { objectRef: scopeObjectId },
        enforcement: "advisory",
        effects: [
          { scanExclusion: { exclude: { class: "approved_override" } } },
          { requireControls: [scanControlId] }
        ]
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
    const params = new URLSearchParams({ cve: opts.cve.join(","), pkg: opts.pkg.join(",") });
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

  async function proposeStaticChange(org: TestOrg, componentId: string, label: string) {
    const { change } = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      proposeChange(tx, {
        orgId: org.orgId,
        actorObjectId: org.orgId,
        requestId: `${label}-${randomUUID()}`,
        name: `${label}-${randomUUID()}`,
        targets: [componentId]
      })
    );
    return change;
  }

  /** ONE reconcile-tick's worth of governance prewarm, exactly as `advanceValidatingChanges` calls
   *  it. Runs the real subprocess plugin host. */
  async function prewarmTick(org: TestOrg, changeId: string, componentId: string) {
    const host = server.deps.pluginHost;
    expect(host, "the prewarm needs the real subprocess plugin host").toBeDefined();
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      prewarmGovernanceForChange(tx, getSharedCelSandbox(), host!, {
        orgId: org.orgId,
        changeObjectId: changeId,
        targetObjectIds: [componentId],
        actorObjectId: org.orgId
      })
    );
  }

  /** ONE reconcile-tick's worth of wave-boundary gate evaluation, exactly as
   *  `advanceExecutingChanges` calls it. */
  async function waveTick(org: TestOrg, changeId: string, componentId: string, waveIndex: number) {
    const host = server.deps.pluginHost;
    expect(host, "the wave gate needs the real subprocess plugin host").toBeDefined();
    return withTenantTx(server.deps.db, org.orgId, (tx) =>
      evaluateWaveGate(
        tx,
        {
          orgId: org.orgId,
          changeObjectId: changeId,
          actorObjectId: org.orgId,
          emergency: false,
          topologyObjectId: null,
          waveIndex,
          targetObjectIds: [componentId]
        },
        { sandbox: getSharedCelSandbox(), host: host! }
      )
    );
  }

  async function runsFor(org: TestOrg, changeId: string) {
    return withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(controlRuns)
        .where(and(eq(controlRuns.orgId, org.orgId), eq(controlRuns.changeObjectId, changeId)))
        .orderBy(asc(controlRuns.createdAt), asc(controlRuns.id))
    );
  }

  function evidenceOf(row: { evidence: unknown }): ScanEvidence {
    return row.evidence as ScanEvidence;
  }

  /**
   * TWO PRINCIPALS, because the raiser may not be the approver (ADR-0033 §6a, owner decision
   * 2026-08-18). Every call here used to raise and approve as `admin`, which the separation-of-duties
   * refusal answers 400 to — seven cases in this file went red at once when it landed, which is the
   * measurement that says the guard reaches the real route.
   *
   * The raiser is `Operator` at the component: exactly the `object:write` the raise route asks for
   * and nothing more, so these fixtures keep proving that raising is open (it authorizes nothing)
   * while approving is not.
   */
  async function approvedGrant(
    org: TestOrg,
    admin: ScpClient,
    componentId: string,
    tierObjectId: string,
    vulnerabilityId: string
  ) {
    const raiserUser = await createTestUser(server, org, [
      { role: "Viewer", scope: org.orgId },
      { role: "Operator", scope: componentId }
    ]);
    const raiser = new ScpClient({ baseUrl: server.baseUrl, token: raiserUser.token });
    const requested = await raiser.scanOverrideGrants.create({
      componentId,
      vulnerabilityId,
      tierObjectId,
      reason: "no upstream fix yet"
    });
    return admin.scanOverrideGrants.approve(requested.id, {
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      reason: "accepted risk, reviewed"
    });
  }

  // ===========================================================================================
  // A1 / A2 — THE INSTALLATION PROOF, once per call site
  // ===========================================================================================

  it("A1: a grant approved AFTER the change already failed its gate makes the NEXT prewarm pass — the lifecycle-edge actuator", async () => {
    // ADR-0033 §10's prescribed proof, verbatim: "grant an exclusion after a change has already
    // failed its gate, assert it subsequently passes". Delete `force` at the prewarm call site and
    // the second tick returns the cached `fail` and this test dies — which is the whole point of
    // writing it this way round rather than granting first and asserting a pass.
    await admitAtInstance("approved_override");
    const org = await createTestOrg(server, "act-grant-after");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const { component } = await buildChain(org, admin, "grant-after");

    await overrideClause(admin, "clause-after", org.orgId);
    const control = await scanControl(admin, org, {
      suffix: "act-after",
      cve: ["CVE-2026-9101"],
      pkg: ["openssl"]
    });
    await requireScanControl(admin, "gate-after", component.id, control.id);
    const change = await proposeStaticChange(org, component.id, "act-after");

    // TICK 1 — no grant exists. The scanner's one HIGH breaches the fail-closed 0/0 default.
    await prewarmTick(org, change.id, component.id);
    const afterFirst = await runsFor(org, change.id);
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]!.status).toBe("fail");
    expect(evidenceOf(afterFirst[0]!).exclusions?.appliedCount).toBe(0);
    const firstHash = evidenceOf(afterFirst[0]!).exclusionSetHash;
    expect(
      firstHash,
      "a clause was admitted, so the run records the set it ran under"
    ).toBeTruthy();

    // THE HUMAN ACT, after the verdict. Nothing else about the change moves.
    await approvedGrant(org, admin, component.id, org.orgId, "CVE-2026-9101");

    // TICK 2 — identical call, identical arguments. The resolved set now differs from the one the
    // cached run was produced under, so the control is re-run rather than re-read.
    await prewarmTick(org, change.id, component.id);
    const afterSecond = await runsFor(org, change.id);
    expect(afterSecond).toHaveLength(2);
    const latest = afterSecond[1]!;
    expect(latest.status).toBe("pass");
    const evidence = evidenceOf(latest);
    // `severityCounts` still says what the scanner found; only the comparison used the other number.
    expect(evidence.severityCounts.high).toBe(1);
    expect(evidence.effectiveSeverityCounts?.high).toBe(0);
    expect(evidence.exclusions?.appliedCount).toBe(1);
    // ...and the new run records a DIFFERENT set, which is what stops it re-running a third time.
    expect(evidence.exclusionSetHash).toBeTruthy();
    expect(evidence.exclusionSetHash).not.toBe(firstHash);
    // The cached run the host-less accept edge reads is now the passing one.
    expect(latest.gateKind).toBe("lifecycle_edge");
    expect(latest.gateRef).toMatchObject({ fromState: "validating", toState: "accepted" });
  });

  it("A2: the same holds at a WAVE BOUNDARY — a wave parked behind a failing scan is released by a grant approved while it waited", async () => {
    // A SECOND CALL SITE, not a duplicate of A1. `prewarmGovernanceForChange` and
    // `evaluateGovernanceGate` each call `ensureControlRuns` independently, and M22.0a keys their
    // runs separately on purpose. Measured: removing `force` from the evaluate site alone fails only
    // this test, and removing it from the prewarm site alone leaves this one green.
    await admitAtInstance("approved_override");
    const org = await createTestOrg(server, "act-wave");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const { component } = await buildChain(org, admin, "wave");

    await overrideClause(admin, "clause-wave", org.orgId);
    const control = await scanControl(admin, org, {
      suffix: "act-wave",
      cve: ["CVE-2026-9201"],
      pkg: ["zlib"]
    });
    await requireScanControl(admin, "gate-wave", component.id, control.id);
    const change = await proposeStaticChange(org, component.id, "act-wave");

    const blocked = await waveTick(org, change.id, component.id, 0);
    expect(blocked.verdict).toBe("block");

    await approvedGrant(org, admin, component.id, org.orgId, "CVE-2026-9201");

    const released = await waveTick(org, change.id, component.id, 0);
    expect(released.verdict).toBe("allow");
    const rows = await runsFor(org, change.id);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.status)).toEqual(["fail", "pass"]);
    expect(rows.every((r) => r.gateKind === "wave_boundary")).toBe(true);
  });

  // ===========================================================================================
  // A3 / A4 — THE OTHER HALF: a lever that pulls itself every tick is a different production bug
  // ===========================================================================================

  it("A3: an UNCHANGED exclusion set re-runs NOTHING — a stable set settles after one run", async () => {
    // The counterweight to A1, and it is not politeness. The gate this rides on is evaluated on
    // EVERY reconcile tick (~1s) for every parked change; a comparison that could not agree with
    // itself would re-run the plugin and insert a `control_runs` row forever — the measured
    // 1.44 GB/day write-amplification pattern (ADR-0024 §D0) reproduced in a new table. Folding
    // anything time-varying into the digest fails exactly here.
    await admitAtInstance("approved_override");
    const org = await createTestOrg(server, "act-stable");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const { component } = await buildChain(org, admin, "stable");

    await overrideClause(admin, "clause-stable", org.orgId);
    // A LIVE GRANT with a real expiry is in force throughout — the case most likely to leak a clock
    // reading into the digest, since `expiresAt` is the one timestamp the resolved set carries.
    await approvedGrant(org, admin, component.id, org.orgId, "CVE-2026-9301");
    const control = await scanControl(admin, org, {
      suffix: "act-stable",
      cve: ["CVE-2026-9301"],
      pkg: ["openssl"]
    });
    await requireScanControl(admin, "gate-stable", component.id, control.id);
    const change = await proposeStaticChange(org, component.id, "act-stable");

    await prewarmTick(org, change.id, component.id);
    const first = await runsFor(org, change.id);
    expect(first).toHaveLength(1);
    expect(first[0]!.status).toBe("pass");

    // Three more ticks. A production change parks for hours; this is the same question asked four
    // times, and the answer must be "already answered".
    await prewarmTick(org, change.id, component.id);
    await prewarmTick(org, change.id, component.id);
    await prewarmTick(org, change.id, component.id);
    const after = await runsFor(org, change.id);
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(first[0]!.id);
  });

  it("A4: with NOTHING authored the evidence gains no key and nothing is ever re-run — byte-identical to pre-M22", async () => {
    // The default deployment. No admission, no clause: the resolver returns nothing, the hash is
    // `undefined`, the stamp writes no key, and `undefined !== undefined` is false so the comparison
    // never forces. A comparison that treated "no hash recorded" as "stale" would re-run every
    // control in the estate on every tick.
    const org = await createTestOrg(server, "act-nothing");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const { component } = await buildChain(org, admin, "nothing");

    const control = await scanControl(admin, org, {
      suffix: "act-nothing",
      cve: ["CVE-2026-9401"],
      pkg: ["openssl"]
    });
    await requireScanControl(admin, "gate-nothing", component.id, control.id);
    const change = await proposeStaticChange(org, component.id, "act-nothing");

    await prewarmTick(org, change.id, component.id);
    await prewarmTick(org, change.id, component.id);
    const rows = await runsFor(org, change.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.evidence).not.toHaveProperty("exclusionSetHash");
    expect(rows[0]!.evidence).not.toHaveProperty("exclusions");
    expect(rows[0]!.evidence).not.toHaveProperty("effectiveSeverityCounts");
  });

  it("A8: a NON-SCAN control beside a scan control is never dragged into the re-run — the comparison is by evidence SHAPE", async () => {
    // The second amplification case, and the reason the comparison identifies a scan verdict by
    // `ScanEvidenceSchema.safeParse` rather than by control id or plugin module. Anything that is not
    // a scan verdict carries no `exclusionSetHash` and never will; comparing it against a non-empty
    // expected hash would force it to re-run on EVERY tick for as long as any clause exists anywhere
    // in the org — a permanent storm on controls that have nothing to do with scanning.
    //
    // The stand-in is a required control with NO binding, whose run `ensureControlRun` writes with
    // `evidence: {}`. That is a real shape (a stale `requireControls` reference), it is the exact
    // shape a `webhook-control` verdict shares for this comparison's purposes — neither parses — and
    // it needs no second plugin fixture.
    await admitAtInstance("approved_override");
    const org = await createTestOrg(server, "act-nonscan");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const { component } = await buildChain(org, admin, "nonscan");

    await overrideClause(admin, "clause-nonscan", org.orgId);
    await approvedGrant(org, admin, component.id, org.orgId, "CVE-2026-9801");
    const control = await scanControl(admin, org, {
      suffix: "act-nonscan",
      cve: ["CVE-2026-9801"],
      pkg: ["openssl"]
    });
    const unbound = await admin.controls.create({
      name: "unbound-control-nonscan",
      urn: `urn:scp:${org.orgId}:control:act-nonscan-unbound`,
      properties: { category: "security" }
    });
    await admin.policies.create({
      name: "gate-nonscan",
      properties: {
        scope: { objectRef: component.id },
        enforcement: "required",
        effects: [{ requireControls: [control.id, unbound.id] }]
      }
    });
    const change = await proposeStaticChange(org, component.id, "act-nonscan");

    await prewarmTick(org, change.id, component.id);
    const first = await runsFor(org, change.id);
    expect(first).toHaveLength(2);
    // The scan verdict carries a hash; the unbound control's run carries no evidence at all.
    const unboundRun = first.find((r) => r.controlObjectId === unbound.id)!;
    expect(unboundRun.evidence).not.toHaveProperty("exclusionSetHash");

    await prewarmTick(org, change.id, component.id);
    await prewarmTick(org, change.id, component.id);
    expect(await runsFor(org, change.id)).toHaveLength(2);
  });

  // ===========================================================================================
  // A5 — THE M22.0a CASE: an expiry only binds if a LATER crossing re-asks
  // ===========================================================================================

  it("A5: a grant valid during validating and EXPIRED before the production wave does not let that wave through", async () => {
    // The DoD case that proves the cache key carries GATE IDENTITY. The lifecycle-edge run below is
    // a genuine, authorized `pass` — made while the grant was live. The wave boundary is a DIFFERENT
    // crossing and must ask again; keyed without gate identity (pre-M22.0a) it would reuse that pass
    // and ship a production wave on a waiver that lapsed weeks earlier.
    //
    // The clock is wound forward by editing the STORED expiry rather than sleeping: the approve
    // route refuses a past `expiresAt` at authoring time, which is why this cannot go through it.
    await admitAtInstance("approved_override");
    const org = await createTestOrg(server, "act-expired");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const { component } = await buildChain(org, admin, "expired");

    await overrideClause(admin, "clause-expired", org.orgId);
    const grant = await approvedGrant(org, admin, component.id, org.orgId, "CVE-2026-9501");
    const control = await scanControl(admin, org, {
      suffix: "act-expired",
      cve: ["CVE-2026-9501"],
      pkg: ["openssl"]
    });
    await requireScanControl(admin, "gate-expired", component.id, control.id);
    const change = await proposeStaticChange(org, component.id, "act-expired");

    await prewarmTick(org, change.id, component.id);
    const validating = await runsFor(org, change.id);
    expect(validating).toHaveLength(1);
    expect(validating[0]!.status).toBe("pass");
    expect(validating[0]!.gateKind).toBe("lifecycle_edge");

    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      await tx.execute(sql`
        UPDATE objects
           SET properties = jsonb_set(properties, '{expiresAt}', '"2020-01-01T00:00:00.000Z"'::jsonb)
         WHERE org_id = ${org.orgId} AND id = ${grant.id}
      `);
    });

    const wave = await waveTick(org, change.id, component.id, 1);
    expect(wave.verdict).toBe("block");

    const all = await runsFor(org, change.id);
    // Exactly ONE new run: the wave asked its own question once. More would mean the actuator is
    // churning; fewer would mean it reused the lifecycle-edge answer.
    expect(all).toHaveLength(2);
    const waveRun = all[1]!;
    expect(waveRun.gateKind).toBe("wave_boundary");
    expect(waveRun.gateRef).toMatchObject({ waveIndex: 1 });
    expect(waveRun.status).toBe("fail");
    // The exclusion was refused because the grant lapsed, not because no clause was in force: a
    // clause WAS admitted and applied to nothing.
    expect(evidenceOf(waveRun).exclusions?.appliedCount).toBe(0);
    // ...and the grant is still sitting there saying `approved`. Nothing flipped it; nothing needed
    // to (there is no sweeper in this tree — ADR-0033 §6a).
    const stored = await admin.scanOverrideGrants.listForComponent(component.id);
    expect(stored[0]?.status).toBe("approved");
  });

  it("A6: REVOKING a grant re-blocks a change whose gate had already passed — the actuator tightens as well as loosens", async () => {
    // The security half, and the one an actuator built only for the happy path would miss. Without
    // forcing, a revoked grant leaves a cached `pass` standing for the life of the change: the
    // operator revokes, the UI says revoked, and the gate keeps letting it through. This direction
    // matters more than A1's, because A1's failure mode is an inconvenience and this one is a live
    // vulnerability shipping under a waiver that was withdrawn.
    await admitAtInstance("approved_override");
    const org = await createTestOrg(server, "act-revoke");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const { component } = await buildChain(org, admin, "revoke");

    await overrideClause(admin, "clause-revoke", org.orgId);
    const grant = await approvedGrant(org, admin, component.id, org.orgId, "CVE-2026-9601");
    const control = await scanControl(admin, org, {
      suffix: "act-revoke",
      cve: ["CVE-2026-9601"],
      pkg: ["openssl"]
    });
    await requireScanControl(admin, "gate-revoke", component.id, control.id);
    const change = await proposeStaticChange(org, component.id, "act-revoke");

    await prewarmTick(org, change.id, component.id);
    const passing = await runsFor(org, change.id);
    expect(passing).toHaveLength(1);
    expect(passing[0]!.status).toBe("pass");

    await admin.scanOverrideGrants.revoke(grant.id, { reason: "exploit now in the wild" });

    await prewarmTick(org, change.id, component.id);
    const after = await runsFor(org, change.id);
    expect(after).toHaveLength(2);
    expect(after[1]!.status).toBe("fail");
    expect(evidenceOf(after[1]!).exclusions?.appliedCount).toBe(0);
  });

  // ===========================================================================================
  // A7 — the hash describes the SET, and says so
  // ===========================================================================================

  it("A7: two changes resolving the SAME set record the SAME hash, and a different set records a different one", async () => {
    // What the recorded value MEANS, pinned at the real gate rather than in a unit test over a
    // hand-built object: it is a function of the resolved exclusion set and of nothing else — not of
    // the change, not of the control, not of when the run happened. If it varied per change, the
    // comparison would still work by accident (it only ever compares a run against its own
    // successor) while being useless for every other purpose the field claims to serve.
    await admitAtInstance("approved_override");
    const org = await createTestOrg(server, "act-hash");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const { component } = await buildChain(org, admin, "hash-a");
    const other = await buildChain(org, admin, "hash-b");

    // ONE org-scoped clause covers both components, and neither has a grant — so the two targets
    // resolve to the same set.
    await overrideClause(admin, "clause-hash", org.orgId);
    const controlA = await scanControl(admin, org, {
      suffix: "act-hash-a",
      cve: ["CVE-2026-9701"],
      pkg: ["openssl"]
    });
    const controlB = await scanControl(admin, org, {
      suffix: "act-hash-b",
      cve: ["CVE-2026-9702"],
      pkg: ["zlib"]
    });
    await requireScanControl(admin, "gate-hash-a", component.id, controlA.id);
    await requireScanControl(admin, "gate-hash-b", other.component.id, controlB.id);

    const changeA = await proposeStaticChange(org, component.id, "act-hash-a");
    const changeB = await proposeStaticChange(org, other.component.id, "act-hash-b");
    await prewarmTick(org, changeA.id, component.id);
    await prewarmTick(org, changeB.id, other.component.id);

    const hashA = evidenceOf((await runsFor(org, changeA.id))[0]!).exclusionSetHash;
    const hashB = evidenceOf((await runsFor(org, changeB.id))[0]!).exclusionSetHash;
    expect(hashA).toBeTruthy();
    expect(hashA).toBe(hashB);

    // Now give ONE of them a grant. Its set changes; the other's does not.
    await approvedGrant(org, admin, component.id, org.orgId, "CVE-2026-9701");
    await prewarmTick(org, changeA.id, component.id);
    await prewarmTick(org, changeB.id, other.component.id);
    const runsA = await runsFor(org, changeA.id);
    const runsB = await runsFor(org, changeB.id);
    expect(runsA).toHaveLength(2);
    expect(runsB, "B's set did not move, so B did not re-run").toHaveLength(1);
    expect(evidenceOf(runsA[1]!).exclusionSetHash).not.toBe(hashA);
  });

  // ===========================================================================================
  // A9 / A10 — D3'S AUTHORITY BAR AT *THIS* CALL SITE (M22.6 review round)
  //
  // WHY HERE AND NOT ONLY IN `scan-declared-override-exclusions.integration.test.ts`: measured, not
  // assumed. Threading the resolved ceiling into the exclusion resolver is a TWO-CALL-SITE wiring,
  // and the first mutation run against the bar found that setting the PREWARM site's `ceiling` to
  // `undefined` left every case in that file green — the reconcile-loop tests there are driven
  // through the EVALUATE site. That is the identical shape M-1/M-2 above record for `force`, one
  // increment later, and it is why this pair exists: the prewarm's run is the one that gets CACHED
  // and later read by the host-less accept edge, so an unbarred grant here authorises the edge a
  // human actually clicks.
  // ===========================================================================================

  /** An org-anchored policy that requires the REAL scan control and sets the ceiling in the same
   *  document — `scan-rule-authoring-guard.ts` refuses a `scanThreshold` that requires no scan
   *  control, and one document makes the contributing tier unambiguous (`org`). */
  async function orgCeiling(admin: ScpClient, name: string, orgRootId: string, controlId: string) {
    return admin.policies.create({
      name,
      properties: {
        scope: { objectRef: orgRootId },
        enforcement: "required",
        effects: [{ requireControls: [controlId] }, { scanThreshold: { maxHigh: 0 } }]
      }
    });
  }

  /** A9/A10 share every step but one: WHICH object the grant names as its tier. Extracted so the
   *  pair cannot drift on anything else, which is the only way the contrast means something. */
  async function prewarmWithGrantAt(
    label: string,
    tierOf: (chain: { service: { id: string }; component: { id: string } }, orgId: string) => string
  ) {
    await admitAtInstance("approved_override");
    const org = await createTestOrg(server, `act-bar-${label}`);
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const chain = await buildChain(org, admin, `bar-${label}`);

    await overrideClause(admin, `clause-bar-${label}`, org.orgId);
    const control = await scanControl(admin, org, {
      suffix: `act-bar-${label}`,
      cve: ["CVE-2026-9801"],
      pkg: ["openssl"]
    });
    // THE CEILING IS SET AT ORG — the rule the grant would be waiving.
    await orgCeiling(admin, `ceiling-bar-${label}`, org.orgId, control.id);
    const grant = await approvedGrant(
      org,
      admin,
      chain.component.id,
      tierOf(chain, org.orgId),
      "CVE-2026-9801"
    );

    const change = await proposeStaticChange(org, chain.component.id, `act-bar-${label}`);
    await prewarmTick(org, change.id, chain.component.id);
    const runs = await runsFor(org, change.id);
    expect(runs).toHaveLength(1);
    return { run: runs[0]!, evidence: evidenceOf(runs[0]!), grant };
  }

  it("A9: at the PREWARM site, a grant approved BELOW the tier that set the ceiling excludes nothing", async () => {
    const { run, evidence } = await prewarmWithGrantAt("below", (chain) => chain.service.id);
    expect(run.status).toBe("fail");
    expect(evidence.severityCounts.high).toBe(1);
    expect(evidence.effectiveSeverityCounts?.high).toBe(1);
    expect(evidence.exclusions?.appliedCount).toBe(0);
  });

  it("A10: the SAME grant approved AT that tier does exclude — the pair that makes A9 able to fail for the right reason", async () => {
    const { run, evidence, grant } = await prewarmWithGrantAt("at", (_chain, orgId) => orgId);
    expect(run.status).toBe("pass");
    expect(evidence.effectiveSeverityCounts?.high).toBe(0);
    expect(evidence.exclusions?.appliedCount).toBe(1);
    expect(evidence.exclusions?.applied[0]?.grantObjectId).toBe(grant.id);
  });
});
