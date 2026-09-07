import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import type { ScanEvidence } from "@scp/schemas";
import { withTenantTx } from "../db/tenant-tx.js";
import { dependencyLines } from "../db/schema.js";
import {
  upsertComponentDependency,
  upsertDependencyLine
} from "../dependencies/dependency-inventory-repo.js";
import {
  createOrphanComponent,
  createTestOrg,
  listenTestServer,
  testDatabaseUrl,
  waitUntil,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import { SCAN_RULE_TEST_CONTROL_REF } from "./test-support/scan-rule-control.js";

/** M22.4 — THE VENDOR RULE AT THE REAL GATE. See docs/governance.md §395. */

const OPERATOR_TOKEN = "m22-4-operator-token-fixture";
const DIGEST = "sha256:cccc777777777777777777777777777777777777777777777777777777777777";
/** The digest the base image line's head resolves to, and what the component's `FROM` is pinned to
 *  when it is current. Deliberately unrelated to the artifact digest above. */
const BASE_HEAD_DIGEST = "sha256:base1111111111111111111111111111111111111111111111111111111111";
const BASE_OLD_DIGEST = "sha256:base2222222222222222222222222222222222222222222222222222222222";

interface TrivySource {
  url: string;
  close(): Promise<void>;
}

/** A scanner-shaped result with per-result class and identity. See docs/governance.md §396. */
async function startTrivySource(): Promise<TrivySource> {
  const httpServer = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const cls = (url.searchParams.get("cls") ?? "").split(",").filter(Boolean);
    const pkg = (url.searchParams.get("pkg") ?? "").split(",");
    const purl = (url.searchParams.get("purl") ?? "").split(",");
    const sev = (url.searchParams.get("sev") ?? "").split(",");
    // One Trivy `Results[]` entry per finding, because `Class` lives on the RESULT and the fixture
    // needs to mix classes within one document.
    const results = cls.map((c, i) => ({
      Target: `registry.test/app:1.0 (${c})`,
      Class: c,
      Vulnerabilities: [
        {
          VulnerabilityID: `CVE-2026-${9000 + i}`,
          PkgName: pkg[i] ?? `pkg${i}`,
          // Derived from the identifier rather than hardcoded. See docs/governance.md §397.
          InstalledVersion: purl[i]?.includes("@") ? purl[i]!.split("@").pop()! : "1.0.0",
          FixedVersion: "9.9.9",
          Severity: sev[i] ?? "HIGH",
          ...(purl[i] ? { PkgIdentifier: { PURL: purl[i] } } : {})
        }
      ]
    }));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        SchemaVersion: 2,
        ArtifactName: "registry.test/app:1.0",
        ArtifactType: "container_image",
        Metadata: { RepoDigests: [`registry.test/app@${DIGEST}`], ImageID: DIGEST },
        Results: results
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

describe("M22.4 the vendor rule (D1) — on the latest of a major line, at the real gate", () => {
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

  /** THE PRODUCTION WRITE DOOR. See docs/governance.md §398. */
  async function admitVendorLatest() {
    for (const tier of ["platform", "trust_domain"] as const) {
      await operator.instanceScanExclusionAdmissions.put(
        tier,
        { origin: "local", classes: ["vendor_latest"] },
        OPERATOR_TOKEN
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

  interface SeedLine {
    ecosystem: "npm" | "oci";
    coordinate: string;
    major: string;
    resolvedVersion?: string | null;
    resolvedDigest?: string | null;
    /** What the line's head was observed to be. `null` = never observed. */
    latestVersion?: string | null;
    latestDigest?: string | null;
    /** How long ago the head was observed. Omitted = just now. */
    observedAgoMs?: number;
  }

  /** Seed one component's inventory through the real verbs. See docs/governance.md §399. */
  async function seedInventory(orgId: string, componentObjectId: string, lines: SeedLine[]) {
    await withTenantTx(server.deps.db, orgId, async (tx) => {
      for (const spec of lines) {
        const line = await upsertDependencyLine(tx, orgId, {
          ecosystem: spec.ecosystem,
          coordinate: spec.coordinate,
          major: spec.major
        });
        await upsertComponentDependency(tx, orgId, {
          componentObjectId,
          lineId: line.id,
          manifestPath: spec.ecosystem === "oci" ? "Dockerfile" : "package.json",
          declaredVersion: spec.resolvedVersion ?? "unpinned",
          resolvedVersion: spec.resolvedVersion ?? null,
          resolvedDigest: spec.resolvedDigest ?? null
        });
        await tx
          .update(dependencyLines)
          .set({
            latestVersion: spec.latestVersion ?? null,
            latestDigest: spec.latestDigest ?? null,
            latestObservedAt:
              spec.latestVersion === null || spec.latestVersion === undefined
                ? null
                : new Date(Date.now() - (spec.observedAgoMs ?? 0))
          })
          .where(and(eq(dependencyLines.orgId, orgId), eq(dependencyLines.id, line.id)));
      }
    });
  }

  /** The base image line, current: the `FROM` resolves to the same DIGEST the head does. */
  const currentBase: SeedLine = {
    ecosystem: "oci",
    coordinate: "docker.io/library/alpine",
    major: "3",
    resolvedVersion: "3.19.1",
    resolvedDigest: BASE_HEAD_DIGEST,
    latestVersion: "3.19.1",
    latestDigest: BASE_HEAD_DIGEST
  };

  async function vendorExclusionPolicy(admin: ScpClient, name: string, scopeObjectId: string) {
    // M22.8 — the authoring guard. See docs/governance.md §400.
    const scanControlId = SCAN_RULE_TEST_CONTROL_REF;
    return admin.policies.create({
      name,
      properties: {
        scope: { objectRef: scopeObjectId },
        enforcement: "advisory",
        effects: [
          { scanExclusion: { exclude: { class: "vendor_latest" } } },
          { requireControls: [scanControlId] }
        ]
      }
    });
  }

  async function scanControl(
    admin: ScpClient,
    org: TestOrg,
    opts: { suffix: string; cls: string[]; pkg: string[]; purl: string[]; sev: string[] }
  ) {
    const control = await admin.controls.create({
      name: `scan-control-${opts.suffix}`,
      urn: `urn:scp:${org.orgId}:control:${opts.suffix}`,
      properties: { category: "security" }
    });
    const params = new URLSearchParams({
      cls: opts.cls.join(","),
      pkg: opts.pkg.join(","),
      purl: opts.purl.join(","),
      sev: opts.sev.join(",")
    });
    await admin.controls.putBinding(control.id, {
      pluginModule: "scan-result-control",
      pluginInstanceId: `scan-${control.id}`,
      config: { url: `${trivy.url}?${params.toString()}`, expectedDigest: DIGEST }
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

  it("V1: an OS-package finding is excluded when the BASE IMAGE line is at its head by digest — and the gate PASSES", async () => {
    await admitVendorLatest();
    const org = await createTestOrg(server, "vendor-base");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const component = await createOrphanComponent(server, org, "comp-vendor-base");
    await seedInventory(org.orgId, component.id, [currentBase]);

    await vendorExclusionPolicy(admin, "vendor-base", org.orgId);
    const control = await scanControl(admin, org, {
      suffix: "vendor-base",
      cls: ["os-pkgs"],
      pkg: ["openssl"],
      purl: ["pkg:apk/alpine/openssl@3.1.4-r5"],
      sev: ["HIGH"]
    });
    await requireScanControl(admin, "gate-vendor-base", component.id, control.id);

    const change = await admin.changes.propose({
      name: "vendor-base",
      targets: [component.id]
    });
    const run = await waitForControlRun(admin, change.id, control.id, "pass");
    const evidence = run.evidence as unknown as ScanEvidence;
    // `severityCounts` KEEPS MEANING WHAT THE SCANNER FOUND — the invariant that outranks everything
    // else here. Operators author CEL against this field.
    expect(evidence.severityCounts.high).toBe(1);
    // ...and the post-exclusion number, which is the ONLY one the threshold was compared against.
    expect(evidence.effectiveSeverityCounts?.high).toBe(0);
    expect(evidence.exclusions?.appliedCount).toBe(1);
    expect(evidence.exclusions?.applied[0]).toMatchObject({
      class: "vendor_latest",
      pkgName: "openssl"
    });
  });

  it("V2: THE SAME SCAN FAILS when the base image is NOT at its head — the tag agrees, the DIGEST does not", async () => {
    // The non-negotiable of the oci arm, driven end to end: `resolved_version` and `latest_version`
    // are the SAME STRING here, so anything comparing tags would pass this. Only the digest
    // comparison catches it.
    await admitVendorLatest();
    const org = await createTestOrg(server, "vendor-digest");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const component = await createOrphanComponent(server, org, "comp-vendor-digest");
    await seedInventory(org.orgId, component.id, [
      { ...currentBase, resolvedDigest: BASE_OLD_DIGEST }
    ]);

    await vendorExclusionPolicy(admin, "vendor-digest", org.orgId);
    const control = await scanControl(admin, org, {
      suffix: "vendor-digest",
      cls: ["os-pkgs"],
      pkg: ["openssl"],
      purl: ["pkg:apk/alpine/openssl@3.1.4-r5"],
      sev: ["HIGH"]
    });
    await requireScanControl(admin, "gate-vendor-digest", component.id, control.id);

    const change = await admin.changes.propose({
      name: "vendor-digest",
      targets: [component.id]
    });
    const run = await waitForControlRun(admin, change.id, control.id, "fail");
    const evidence = run.evidence as unknown as ScanEvidence;
    expect(evidence.severityCounts.high).toBe(1);
    expect(evidence.effectiveSeverityCounts?.high).toBe(1);
    // The clause WAS admitted and resolved — it simply matched nothing. Proven positively so this is
    // not "the feature was off".
    expect(evidence.exclusions?.clauseCount).toBe(1);
    expect(evidence.exclusions?.appliedCount).toBe(0);
  });

  it("V3: a NULL head and a STALE head each yield no vendor-pass", async () => {
    await admitVendorLatest();
    const org = await createTestOrg(server, "vendor-absent");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });

    // DISTINCT COORDINATES, and this is not cosmetic. See docs/governance.md §401.
    const never = await createOrphanComponent(server, org, "comp-vendor-never");
    await seedInventory(org.orgId, never.id, [
      {
        ...currentBase,
        coordinate: "docker.io/library/alpine-never",
        latestVersion: null,
        latestDigest: null
      }
    ]);
    // (b) observed, but longer ago than three poll cycles (the default poll is daily => 3 days).
    const stale = await createOrphanComponent(server, org, "comp-vendor-stale");
    await seedInventory(org.orgId, stale.id, [
      {
        ...currentBase,
        coordinate: "docker.io/library/alpine-stale",
        observedAgoMs: 4 * 24 * 60 * 60 * 1000
      }
    ]);

    await vendorExclusionPolicy(admin, "vendor-absent", org.orgId);
    for (const [suffix, component] of [
      ["never", never],
      ["stale", stale]
    ] as const) {
      const control = await scanControl(admin, org, {
        suffix: `vendor-${suffix}`,
        cls: ["os-pkgs"],
        pkg: ["openssl"],
        purl: ["pkg:apk/alpine/openssl@3.1.4-r5"],
        sev: ["HIGH"]
      });
      await requireScanControl(admin, `gate-vendor-${suffix}`, component.id, control.id);
      const change = await admin.changes.propose({
        name: `vendor-${suffix}`,
        targets: [component.id]
      });
      const run = await waitForControlRun(admin, change.id, control.id, "fail");
      const evidence = run.evidence as unknown as ScanEvidence;
      expect(evidence.exclusions?.clauseCount, suffix).toBe(1);
      expect(evidence.exclusions?.appliedCount, suffix).toBe(0);
    }
  });

  it("V4: a DECLARED language dependency at head is excused; a TRANSITIVE one on the same scan is not", async () => {
    // Both findings are `lang-pkgs`, both npm, both HIGH, both with a fix. The ONLY difference is
    // that one has an inventory line and the other does not — which is the whole of "a transitive is
    // fixed by moving its direct parent".
    await admitVendorLatest();
    const org = await createTestOrg(server, "vendor-lang");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const component = await createOrphanComponent(server, org, "comp-vendor-lang");
    await seedInventory(org.orgId, component.id, [
      {
        ecosystem: "npm",
        coordinate: "lodash",
        major: "4",
        resolvedVersion: "4.17.21",
        latestVersion: "4.17.21"
      }
    ]);

    await vendorExclusionPolicy(admin, "vendor-lang", org.orgId);
    const control = await scanControl(admin, org, {
      suffix: "vendor-lang",
      cls: ["lang-pkgs", "lang-pkgs"],
      pkg: ["lodash", "minimist"],
      purl: ["pkg:npm/lodash@4.17.21", "pkg:npm/minimist@0.0.8"],
      sev: ["HIGH", "HIGH"]
    });
    await requireScanControl(admin, "gate-vendor-lang", component.id, control.id);

    const change = await admin.changes.propose({
      name: "vendor-lang",
      targets: [component.id]
    });
    const run = await waitForControlRun(admin, change.id, control.id, "fail");
    const evidence = run.evidence as unknown as ScanEvidence;
    expect(evidence.severityCounts.high).toBe(2);
    // ONE excused, ONE surviving — and the survivor is what still blocks.
    expect(evidence.effectiveSeverityCounts?.high).toBe(1);
    expect(evidence.exclusions?.appliedCount).toBe(1);
    expect(evidence.exclusions?.applied[0]).toMatchObject({
      class: "vendor_latest",
      pkgName: "lodash"
    });
  });

  it("V5: WITH NO ADMISSION the very same fixture blocks — the loosening is authorised, never inferred from the data", async () => {
    // No `admitVendorLatest()`. The inventory says the component is perfectly current; the clause is
    // authored; and nothing above admitted the class, so the finding counts. This is the negative
    // control for the whole increment: being up to date is not, by itself, permission.
    const org = await createTestOrg(server, "vendor-unadmitted");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const component = await createOrphanComponent(server, org, "comp-vendor-unadmitted");
    await seedInventory(org.orgId, component.id, [currentBase]);

    await vendorExclusionPolicy(admin, "vendor-unadmitted", org.orgId);
    const control = await scanControl(admin, org, {
      suffix: "vendor-unadmitted",
      cls: ["os-pkgs"],
      pkg: ["openssl"],
      purl: ["pkg:apk/alpine/openssl@3.1.4-r5"],
      sev: ["HIGH"]
    });
    await requireScanControl(admin, "gate-vendor-unadmitted", component.id, control.id);

    const change = await admin.changes.propose({
      name: "vendor-unadmitted",
      targets: [component.id]
    });
    const run = await waitForControlRun(admin, change.id, control.id, "fail");
    // Byte-identical to pre-M22: no clause resolved, so the evidence document gains no keys at all.
    expect(run.evidence).not.toHaveProperty("exclusions");
    expect(run.evidence).not.toHaveProperty("effectiveSeverityCounts");
  });

  it("V6: the FACTS intersect across a multi-target change — one target on a stale base sinks it for both", async () => {
    // A fact is as much a loosening as a clause is (ADR-0033 §3). One verdict is produced for one
    // artifact across the change's whole target set, so if the facts were UNIONED, component A's
    // currency would excuse findings on an artifact that component B is demonstrably behind on.
    await admitVendorLatest();
    const org = await createTestOrg(server, "vendor-multi");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const current = await createOrphanComponent(server, org, "comp-vendor-multi-a");
    const behind = await createOrphanComponent(server, org, "comp-vendor-multi-b");
    await seedInventory(org.orgId, current.id, [currentBase]);
    await seedInventory(org.orgId, behind.id, [
      { ...currentBase, resolvedDigest: BASE_OLD_DIGEST }
    ]);

    await vendorExclusionPolicy(admin, "vendor-multi", org.orgId);
    const control = await scanControl(admin, org, {
      suffix: "vendor-multi",
      cls: ["os-pkgs"],
      pkg: ["openssl"],
      purl: ["pkg:apk/alpine/openssl@3.1.4-r5"],
      sev: ["HIGH"]
    });
    await requireScanControl(admin, "gate-vendor-multi", current.id, control.id);

    const change = await admin.changes.propose({
      name: "vendor-multi",
      targets: [current.id, behind.id]
    });
    const run = await waitForControlRun(admin, change.id, control.id, "fail");
    const evidence = run.evidence as unknown as ScanEvidence;
    // The CLAUSE survived the intersection (both targets admit it), so the block is attributable to
    // the FACTS alone — which is the property under test, and is why this is not just V2 again.
    expect(evidence.exclusions?.clauseCount).toBe(1);
    expect(evidence.exclusions?.appliedCount).toBe(0);
    expect(evidence.effectiveSeverityCounts?.high).toBe(1);
  });
});
