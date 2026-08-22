import { randomUUID } from "node:crypto";
import pg from "pg";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import { withTenantTx } from "../db/tenant-tx.js";
import {
  createOrphanComponent,
  createTestOrg,
  listenTestServer,
  testDatabaseUrl,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/**
 * M22.8 — `GET /components/{idOrUrn}/scan-requirements`, THE READ SURFACE (ADR-0033 §11).
 *
 * WHAT THIS FILE IS FOR. The pure algebra is already pinned in `scan-requirements.test.ts` and the
 * pure application in `packages/schemas/src/supply-chain.test.ts`. Neither can tell you whether the
 * ROUTE exists, whether it is wired to the same resolution the gate uses, or whether it keeps its
 * one promise — that it writes NOTHING. So every test below goes through the HTTP surface via the
 * generated SDK. Nothing here calls `readComponentScanRequirements` directly.
 *
 * THE PROMISE THAT MAKES THIS SURFACE WORTH HAVING is R3: zero Decision rows. `POST /policy-evaluate`
 * runs the real orchestrator and writes one Decision per call with no write suppression, so a UI
 * polling it recreates — per viewer, per interval — the amplification ADR-0024 §D0 exists over. R3
 * asserts both halves against the same database in the same test, because "this one writes nothing"
 * is only meaningful next to "and that one does".
 *
 * MUTATIONS RUN against this file are recorded in the increment report, not predicted here.
 */

const OPERATOR_TOKEN = "m22-8-operator-token-fixture";

describe("M22.8 component scan-requirements read surface", () => {
  let server: ListeningTestServer;
  let adminPool: pg.Pool;
  let operator: ScpClient;

  beforeAll(async () => {
    server = await listenTestServer({ operatorToken: OPERATOR_TOKEN });
    adminPool = new pg.Pool({ connectionString: testDatabaseUrl() });
    const bootstrap = await createTestOrg(server, "m22-8-operator");
    operator = new ScpClient({ baseUrl: server.baseUrl, token: bootstrap.adminToken });
  }, 180_000);

  afterEach(async () => {
    // Both instance-scoped tables are deployment-wide, so a row left behind by one test is an input
    // to the next one's baseline. Cleared in `afterEach` rather than `beforeEach` for the reason
    // `scoped-scan-requirements` documents: a `beforeEach` clear runs before the NEXT test's own
    // setup and would silently erase it.
    await adminPool?.query("DELETE FROM scan_exclusion_admissions").catch(() => undefined);
    await operator?.instanceScanFloors
      .put(
        "platform",
        { origin: "local", maxCritical: null, maxHigh: null, maxMedium: null, maxLow: null },
        OPERATOR_TOKEN
      )
      .catch(() => undefined);
    await operator?.instanceScanFloors
      .put(
        "trust_domain",
        { origin: "local", maxCritical: null, maxHigh: null, maxMedium: null, maxLow: null },
        OPERATOR_TOKEN
      )
      .catch(() => undefined);
  });

  afterAll(async () => {
    await adminPool?.end();
    await server?.close();
  });

  // -----------------------------------------------------------------------------------------
  // Fixtures
  // -----------------------------------------------------------------------------------------

  async function orgWithChain(label: string) {
    const org = await createTestOrg(server, label);
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
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
    return { org, admin, containmentDomain, service, component };
  }

  /** A control bound to the real `scan-result-control` module. Needed because M22.8's own authoring
   *  guard refuses a scan rule that requires no scan control — so every ceiling/clause policy below
   *  names this. The binding's `url` is never fetched: nothing in this file runs a plugin. */
  async function scanControlId(admin: ScpClient, suffix: string): Promise<string> {
    const control = await admin.controls.create({
      name: `scan-control-${suffix}`,
      properties: { category: "security" }
    });
    await admin.controls.putBinding(control.id, {
      pluginModule: "scan-result-control",
      pluginInstanceId: `scan-${control.id}`,
      config: {
        url: "http://127.0.0.1:1/never-fetched",
        expectedDigest: "sha256:" + "0".repeat(64)
      }
    });
    return control.id;
  }

  async function policy(
    admin: ScpClient,
    name: string,
    scopeObjectId: string,
    effects: Record<string, unknown>[],
    condition?: string
  ) {
    // No explicit `urn` — the server derives a name-slug one, and each org below is fresh.
    return admin.policies.create({
      name,
      properties: {
        scope: { objectRef: scopeObjectId },
        enforcement: "advisory",
        ...(condition ? { condition } : {}),
        effects
      }
    });
  }

  /**
   * THE PRODUCTION WRITE DOOR (M22.9). This used to `INSERT INTO scan_exclusion_admissions` over the
   * admin pool, which made the suite green while the two instance rungs every clause requires — and
   * that NO policy can ever contribute — had no writer outside these tests. It now goes through
   * `PUT /api/v1/instance/scan-exclusion-admissions/{tier}` with the deployment operator token, so
   * this read surface is tested against admissions an operator could actually have authored. The
   * PUT is a whole-set REPLACE, so this unions with what is already admitted.
   */
  async function admitAtInstance(tiers: Array<"platform" | "trust_domain">, cls: string) {
    for (const tier of tiers) {
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

  function countDecisions(org: TestOrg): Promise<number> {
    return withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const result = await tx.execute<{ n: string }>(
        sql`SELECT count(*)::text AS n FROM decisions WHERE org_id = ${org.orgId}`
      );
      return Number(result.rows[0]!.n);
    });
  }

  // -----------------------------------------------------------------------------------------
  // R1 — NOTHING AUTHORED. The shipped default, and the state no other surface can show.
  // -----------------------------------------------------------------------------------------

  it("R1 with nothing authored: no ceiling, every exclusion class present, admitted by nobody and effective nowhere", async () => {
    const { admin, component } = await orgWithChain("m22-8-baseline");

    const result = await admin.components.scanRequirements(component.id);

    expect(result.componentId).toBe(component.id);
    expect(result.threshold, "no tier sets a ceiling ⇒ null, never an invented 0/0").toBeNull();
    expect(result.exclusionClauses).toEqual([]);
    expect(result.unevaluatedConditions).toEqual([]);

    // EVERY class is reported even though nobody admitted any. This is the point of the surface:
    // "admission is empty at every tier" is the shipped default and, before this route, was
    // invisible from every API — an operator authoring their first exclusion had no way to learn
    // that it would be inert. Listing only the admitted classes would hide exactly that state.
    expect(result.admittedExclusionClasses.map((c) => c.class).sort()).toEqual([
      "approved_override",
      "declared_fact",
      "no_fix_available",
      "vendor_latest"
    ]);
    for (const cls of result.admittedExclusionClasses) {
      expect(cls.admittedBy, `${cls.class} is admitted by nobody`).toEqual([]);
      expect(cls.effectiveAtTiers, `${cls.class} has effect nowhere`).toEqual([]);
    }

    // The rungs that EXIST for this component. `platform`/`trust_domain` are facts about the
    // deployment and are always represented; `assembly` is not, because this chain has none — and a
    // rung that does not exist is never asked to admit anything (ADR-0033 §1).
    expect(result.representedTiers).toEqual([
      "platform",
      "trust_domain",
      "org",
      "containment_domain",
      "service",
      "component"
    ]);
  });

  // -----------------------------------------------------------------------------------------
  // R2 — the ceiling and its contributors, at their real tiers.
  // -----------------------------------------------------------------------------------------

  it("R2 reports the resolved per-severity MIN and names every contributing tier", async () => {
    const { admin, service, component } = await orgWithChain("m22-8-ceiling");
    const controlId = await scanControlId(admin, "ceiling");
    await operator.instanceScanFloors.put(
      "platform",
      { origin: "local", maxCritical: 9, maxHigh: 9, maxMedium: null, maxLow: null },
      OPERATOR_TOKEN
    );
    await policy(admin, "svc-ceiling", service.id, [
      { scanThreshold: { maxHigh: 0 } },
      { requireControls: [controlId] }
    ]);
    await policy(admin, "comp-ceiling", component.id, [
      { scanThreshold: { maxMedium: 3 } },
      { requireControls: [controlId] }
    ]);

    const result = await admin.components.scanRequirements(component.id);

    expect(result.threshold, "three tiers contribute ⇒ a resolved ceiling").not.toBeNull();
    // Per-severity MIN across the set: platform's 9 for critical, the service's 0 for high (it beats
    // platform's 9), the component's 3 for medium. `maxLow` is unbounded and therefore absent —
    // absent never means 0.
    expect(result.threshold!.threshold).toEqual({ maxCritical: 9, maxHigh: 0, maxMedium: 3 });
    const tiers = result.threshold!.contributors.map((c) => c.tier).sort();
    expect(tiers).toEqual(["component", "platform", "service"]);
    expect(
      result.threshold!.contributors.find((c) => c.tier === "service")!.source,
      "a contributor must NAME its policy, so an operator can go and edit the right one"
    ).toContain("svc-ceiling");
  });

  // -----------------------------------------------------------------------------------------
  // R3 — THE PROMISE. Reads write nothing; `policy-evaluate` writes on every call.
  // -----------------------------------------------------------------------------------------

  it("R3 writes NO Decision — where POST /policy-evaluate writes one per call", async () => {
    const { org, admin, service, component } = await orgWithChain("m22-8-nodecision");
    const controlId = await scanControlId(admin, "nodecision");
    await policy(admin, "svc-ceiling", service.id, [
      { scanThreshold: { maxHigh: 0 } },
      { requireControls: [controlId] }
    ]);

    const before = await countDecisions(org);
    for (let i = 0; i < 3; i += 1) await admin.components.scanRequirements(component.id);
    expect(
      await countDecisions(org),
      "three polls of the read surface must write zero Decision rows"
    ).toBe(before);

    // THE CONTRAST, in the same test and against the same database. Without it "wrote nothing" could
    // be true for an uninteresting reason (nothing in this org ever writes a Decision), and the
    // reason this route exists at all would go unproven.
    const change = await admin.changes.propose({
      name: "m22-8 decision contrast",
      targets: [component.id]
    });
    const afterChange = await countDecisions(org);
    await admin.policyEvaluate(change.id);
    const afterEvaluate = await countDecisions(org);
    expect(
      afterEvaluate,
      "policy-evaluate writes a Decision per call — which is why nobody may poll it"
    ).toBeGreaterThan(afterChange);
  });

  // -----------------------------------------------------------------------------------------
  // R4 — THE MONOTONE AND, read off the surface: an org-level admission is not enough.
  // -----------------------------------------------------------------------------------------

  it("R4 EVERY rung above must consent: org alone reaches nothing, and each rung added reaches exactly one level further", async () => {
    const { admin, org, containmentDomain, component } = await orgWithChain("m22-8-and");
    await policy(admin, "org-admits", org.orgId, [
      // `admit`-ONLY, and deliberately carrying no `requireControls`: an admission is not a rule
      // about a finding, so M22.8's authoring guard exempts it. That exemption is exercised here
      // rather than only asserted in the guard's own suite.
      { scanExclusion: { admit: ["no_fix_available"] } }
    ]);

    const before = await admin.components.scanRequirements(component.id);
    const beforeClass = before.admittedExclusionClasses.find(
      (c) => c.class === "no_fix_available"
    )!;
    expect(beforeClass.admittedBy.map((a) => a.tier)).toEqual(["org"]);
    expect(
      beforeClass.effectiveAtTiers,
      "platform and trust_domain admit nothing, so the AND fails above org and NO tier is effective"
    ).toEqual([]);

    await admitAtInstance(["platform", "trust_domain"], "no_fix_available");

    const after = await admin.components.scanRequirements(component.id);
    const afterClass = after.admittedExclusionClasses.find((c) => c.class === "no_fix_available")!;
    expect(afterClass.admittedBy.map((a) => a.tier).sort()).toEqual([
      "org",
      "platform",
      "trust_domain"
    ]);
    // AND STILL NOT AT THE SERVICE. This is the monotone AND doing its job, and it is the assertion
    // most likely to be got wrong by anyone reasoning from "the org admitted it": a clause at the
    // SERVICE needs every represented tier above it to admit — which includes the CONTAINMENT
    // DOMAIN, and the containment domain has said nothing. A tier that is silent is not consenting.
    expect(afterClass.effectiveAtTiers).toEqual(["org", "containment_domain"]);

    // One more rung of consent reaches exactly one more level. Nothing about the org's admission
    // changed; the domain's own statement is what moved the frontier.
    await policy(admin, "dom-admits", containmentDomain.id, [
      { scanExclusion: { admit: ["no_fix_available"] } }
    ]);
    const withDomain = await admin.components.scanRequirements(component.id);
    expect(
      withDomain.admittedExclusionClasses.find((c) => c.class === "no_fix_available")!
        .effectiveAtTiers,
      "the domain's consent reaches exactly ONE more rung — the service. The COMPONENT is still not " +
        "reachable, because a clause there needs the SERVICE to admit and the service has said " +
        "nothing. Every rung consents for itself; consent is never inherited downward."
    ).toEqual(["org", "containment_domain", "service"]);

    // `platform`/`trust_domain` are never listed as EFFECTIVE tiers: those rungs come from a table
    // with a `class` column and no clause — they can ADMIT and can never CONTRIBUTE.
    expect(withDomain.admittedExclusionClasses[0]!.effectiveAtTiers).not.toContain("platform");

    // NEGATIVE CONTROL: admitting one class admits only that class.
    const other = withDomain.admittedExclusionClasses.find((c) => c.class === "vendor_latest")!;
    expect(other.effectiveAtTiers).toEqual([]);
  });

  // -----------------------------------------------------------------------------------------
  // R5 — a clause that survives the AND is reported with the chain that admitted it.
  // -----------------------------------------------------------------------------------------

  it("R5 reports a surviving clause with its full admitting chain, and drops one whose class nobody admits", async () => {
    const { admin, org, containmentDomain, service, component } =
      await orgWithChain("m22-8-clause");
    const controlId = await scanControlId(admin, "clause");
    // EVERY rung above the clause's tier must admit — the two instance rungs, the org, AND the
    // containment domain. Omitting any one of them leaves the clause inert (R4 pins that directly).
    await admitAtInstance(["platform", "trust_domain"], "no_fix_available");
    await policy(admin, "org-admits", org.orgId, [
      { scanExclusion: { admit: ["no_fix_available"] } }
    ]);
    await policy(admin, "dom-admits", containmentDomain.id, [
      { scanExclusion: { admit: ["no_fix_available"] } }
    ]);
    await policy(admin, "svc-clause", service.id, [
      { scanExclusion: { exclude: { class: "no_fix_available", pkgName: "openssl" } } },
      { requireControls: [controlId] }
    ]);
    // A clause of a class NOBODY admits — the negative control that keeps R5 from passing because
    // "everything is reported".
    await policy(admin, "svc-unadmitted", service.id, [
      { scanExclusion: { exclude: { class: "vendor_latest" } } },
      { requireControls: [controlId] }
    ]);

    const result = await admin.components.scanRequirements(component.id);

    expect(result.exclusionClauses).toHaveLength(1);
    const clause = result.exclusionClauses[0]!;
    expect(clause.clause).toMatchObject({ class: "no_fix_available", pkgName: "openssl" });
    expect(clause.tier).toBe("service");
    expect(clause.source).toContain("svc-clause");
    expect(
      clause.admittedBy.map((a) => a.tier),
      "every rung above the clause's own tier must be named, top-down"
    ).toEqual(["platform", "trust_domain", "org", "containment_domain"]);
  });

  // -----------------------------------------------------------------------------------------
  // R6 — THE OPPOSITE SIGNS. One document, one unevaluated condition, two different answers.
  // -----------------------------------------------------------------------------------------

  it("R6 an unevaluated CEL condition STILL sets its ceiling but yields NO exclusion clause", async () => {
    const { admin, org, containmentDomain, service, component } = await orgWithChain("m22-8-signs");
    const controlId = await scanControlId(admin, "signs");
    // Fully admitted down to the service, so the ONLY reason the clause below can be absent is the
    // unevaluated condition. Without this the test would pass for the wrong reason.
    await admitAtInstance(["platform", "trust_domain"], "no_fix_available");
    await policy(admin, "org-admits", org.orgId, [
      { scanExclusion: { admit: ["no_fix_available"] } }
    ]);
    await policy(admin, "dom-admits", containmentDomain.id, [
      { scanExclusion: { admit: ["no_fix_available"] } }
    ]);
    // ONE policy, ONE condition, BOTH dimensions. If the two shared an error-handling helper — which
    // ADR-0033 §4 forbids in those words — this test could not pass: they would either both appear
    // or both vanish.
    await policy(
      admin,
      "conditional-both",
      service.id,
      [
        { scanThreshold: { maxHigh: 0 } },
        { scanExclusion: { exclude: { class: "no_fix_available" } } },
        { requireControls: [controlId] }
      ],
      "change.emergency == false"
    );

    const result = await admin.components.scanRequirements(component.id);

    // CEILING: kept. Dropping a ceiling turns a fail into a pass, so an unevaluated condition must
    // fail CLOSED — the same sign `ceilingContributorKeys` applies to a condition that errored.
    expect(
      result.threshold?.threshold.maxHigh,
      "the ceiling survives the unevaluated condition"
    ).toBe(0);
    expect(result.threshold!.contributors.some((c) => c.source.includes("conditional-both"))).toBe(
      true
    );

    // EXCLUSION: dropped. Admitting a loosening whose condition could not be evaluated IS the
    // fail-open.
    expect(
      result.exclusionClauses,
      "an unevaluated condition yields NO exclusion — the opposite sign, from the same policy"
    ).toEqual([]);

    // And the policy is NAMED, not silently folded in. A reader who cannot see which statements were
    // treated conservatively cannot tell a conservative answer from a confident one.
    expect(result.unevaluatedConditions).toHaveLength(1);
    expect(result.unevaluatedConditions[0]).toMatchObject({
      name: "conditional-both",
      condition: "change.emergency == false"
    });
  });

  // -----------------------------------------------------------------------------------------
  // R7 — authorization is the ordinary object read, on the component itself.
  // -----------------------------------------------------------------------------------------

  it("R7 refuses a caller with no read authority on the component, and 404s an unknown component", async () => {
    const { admin, component } = await orgWithChain("m22-8-authz");
    const otherOrg = await createTestOrg(server, "m22-8-authz-other");
    const outsider = new ScpClient({ baseUrl: server.baseUrl, token: otherOrg.adminToken });

    // A different tenant's admin is a fully-privileged principal — in THEIR org. The component is
    // simply not visible, so this is a 404 rather than a 403: RLS answers before authorization does.
    await expect(outsider.components.scanRequirements(component.id)).rejects.toThrow();
    await expect(admin.components.scanRequirements(randomUUID())).rejects.toThrow();
  });
});
