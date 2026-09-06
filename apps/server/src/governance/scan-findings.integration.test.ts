import { generateKeyPairSync, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { and, asc, eq } from "drizzle-orm";
import {
  SCAN_FINDINGS_PERSIST_CAP,
  SCAN_FINDINGS_TRANSPORT_KEY,
  SCAN_FINDINGS_TRUNCATED_TRANSPORT_KEY,
  ScanEvidenceSchema,
  asTrustDomainId,
  attachScanFindingsForTransport,
  capScanFindings,
  type ScanFinding
} from "@scp/schemas";
import type { ControlOutcome } from "@scp/plugin-api";
import { deriveRuntimeDatabaseUrl } from "../db/provision.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { controlRuns, scanFindings } from "../db/schema.js";
import { createObject } from "../graph/objects-repo.js";
import { proposeChange } from "../coordination/changes-repo.js";
import { ensureFederationSelf } from "../federation/self-repo.js";
import { pairPeer } from "../federation/peers-repo.js";
import { exportPromotionBundle } from "../federation/promotion-repo.js";
import {
  MANAGED_SCAN_CONTROL_OBJECT_ID,
  runPromotionScanStep,
  type ManagedScanRequest,
  type ManagedScanResult,
  type ManagedScanRunner
} from "../federation/promotion-scan-step.js";
import {
  createIsolatedDomain,
  type IsolatedDomain
} from "../federation/test-support/isolated-domain.js";
import { upsertControlBinding } from "./controls-repo.js";
import { ensureControlRun } from "./control-runner.js";
import type { PluginHost } from "../plugin-host/contract.js";

/**
 * M22.1b — `scan_findings` PERSISTED, AND WIRED AT BOTH VERDICT PRODUCERS (ADR-0033 §7/§7a,
 * migration 0065).
 *
 * M22.1a made both Trivy parse sites derive their counts from one shared `parseTrivyFindings`, so
 * findings finally EXIST at parse time — and nothing wrote them anywhere. Every rule in ADR-0033 is
 * a rule about a FINDING, so a table nobody fills is the whole milestone stalled. The failure mode
 * this file exists to refuse is this repo's dominant one: a component built, tested green against
 * itself, and installed nowhere.
 *
 * SO EVERY TEST HERE DRIVES A PRODUCTION ENTRY POINT. Nothing calls `persistScanFindings` directly:
 *
 *   - `runPromotionScanStep(...)` — the commander's own managed scan (`federation/`).
 *   - `ensureControlRun(...)`     — the ControlPlugin path (`governance/`), where the plugin has no
 *                                   `DATABASE_URL` and hands its findings to the server on the
 *                                   outcome's evidence.
 *
 * MUTATIONS RUN against this file (2026-08-17) — the MEASURED result of each, reverted by an exact
 * inverse edit. Baseline: 14 passed.
 *
 *   M-A  DELETE the `persistScanFindings(...)` call in `governance/control-runner.ts`
 *          -> 3 failed (A1, A2, A3). The plugin-side wiring is INSTALLED, not merely built.
 *   M-B  DELETE the `persistScanFindings(...)` call in `federation/promotion-scan-step.ts`
 *          -> 5 failed (P1, P3, P5, R1, R3). The managed-scan wiring is INSTALLED.
 *             P2 and P4 survive this one BY DESIGN — both assert an ABSENCE of rows, so neither can
 *             ever witness the writer disappearing. That is why M-D exists.
 *   M-C  DELETE the `takeScanFindingsFromTransport` strip in `control-runner.ts` (persist the raw
 *        outcome evidence)
 *          -> 2 failed (A3, A4): the transport key survives onto `control_runs.evidence`, which
 *             federation copies VERBATIM into a promotion bundle. This is the mutation that would
 *             have federated accepted-risk detail ADR-0033 §8 confines to grants.
 *   M-D  `scanMethodCarriesFindings("openscap")` returning `true`
 *          -> 1 failed (P2): an OpenSCAP verdict gains a finding set. The refusal is by METHOD,
 *             which is why P2 hands the openscap runner a NON-EMPTY findings array — a refusal
 *             keyed on "there were no findings to exclude" would pass a broken build.
 *
 *          THIS MUTATION SURVIVED ON ITS FIRST RUN, and the reason is worth writing down: the server
 *          resolves `@scp/schemas` to `dist/`, not `src/`, so editing the source and re-running the
 *          integration suite tests the OLD compiled function. It only went red after
 *          `pnpm --filter @scp/schemas build`. An integration mutation that lives in a workspace
 *          PACKAGE is not applied until that package is rebuilt — a green run after mutating `src`
 *          is green for the wrong reason, not evidence of coverage.
 *   M-E  drop `ON DELETE CASCADE` from `scan_findings_control_run_fk` (migration 0065)
 *          -> 1 failed (R3): findings outlive the verdict they explain.
 *
 * Real PostgreSQL 16 via Testcontainers, in its OWN database (`createIsolatedDomain`), so the RLS
 * probes can hold a raw `scp_app` connection without touching any other file's data.
 */

const IMAGE_DIGEST = `sha256:${"a".repeat(64)}`;
const RPM_DIGEST = `sha256:${"b".repeat(64)}`;

function finding(over: Partial<ScanFinding> = {}): ScanFinding {
  return {
    severity: "high",
    vulnerabilityId: "CVE-2026-1000",
    pkgName: "openssl",
    installedVersion: "1.1.1n",
    fixedVersion: "1.1.1t",
    class: "os-pkgs",
    target: "test-image (alpine 3.20)",
    purl: "pkg:apk/alpine/openssl@1.1.1n",
    ...over
  };
}

/** A `ManagedScanRunner` that returns exactly what the test dictates — the seam the step exposes so
 *  these branches are hermetic (no Docker, no registry, no real Trivy). */
function fixedRunner(
  report: (req: ManagedScanRequest) => ManagedScanResult
): ManagedScanRunner & { requests: ManagedScanRequest[] } {
  const requests: ManagedScanRequest[] = [];
  return {
    requests,
    async scan(req: ManagedScanRequest): Promise<ManagedScanResult> {
      requests.push(req);
      return report(req);
    }
  };
}

describe("M22.1b: scan_findings persisted, at both verdict producers", () => {
  let domain: IsolatedDomain;

  beforeAll(async () => {
    domain = await createIsolatedDomain("scanfindings");
    // `rpm -> openscap` for P2 (the default seed is `rpm -> [trivy]`). `scanner_assignments` is
    // instance-scoped and SELECT-only for the runtime role, so this write runs over the domain's
    // admin connection — the same path routes/scanner-assignments.ts uses in production.
    const adminPool = new pg.Pool({ connectionString: domain.adminUrl });
    try {
      await adminPool.query(
        `INSERT INTO scanner_assignments (executor_type, methods) VALUES ('rpm', '["openscap"]'::jsonb)
           ON CONFLICT (executor_type) DO UPDATE SET methods = EXCLUDED.methods`
      );
    } finally {
      await adminPool.end();
    }
  }, 120_000);

  afterAll(async () => {
    await domain?.close();
  });

  async function proposeArtifactChange(
    digest: string,
    type: "image" | "rpm"
  ): Promise<{ changeId: string }> {
    const target = await withTenantTx(domain.db, domain.orgId, (tx) =>
      createObject(tx, {
        orgId: domain.orgId,
        domainId: null,
        typeId: "service",
        actorObjectId: domain.orgId,
        requestId: `sf-target-${randomUUID()}`,
        name: `sf-target-${randomUUID()}`
      })
    );
    const { change } = await withTenantTx(domain.db, domain.orgId, (tx) =>
      proposeChange(tx, {
        orgId: domain.orgId,
        actorObjectId: domain.orgId,
        requestId: `sf-change-${randomUUID()}`,
        name: `sf-${randomUUID()}`,
        targets: [target.id],
        type,
        sourceRef: { artifact_digest: digest, image: `registry.test/scp/sf@${digest}` }
      })
    );
    return { changeId: change.id };
  }

  async function managedRunFor(changeId: string) {
    const rows = await withTenantTx(domain.db, domain.orgId, (tx) =>
      tx
        .select()
        .from(controlRuns)
        .where(
          and(
            eq(controlRuns.orgId, domain.orgId),
            eq(controlRuns.changeObjectId, changeId),
            eq(controlRuns.controlObjectId, MANAGED_SCAN_CONTROL_OBJECT_ID)
          )
        )
    );
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }

  async function findingsOf(controlRunId: string) {
    return withTenantTx(domain.db, domain.orgId, (tx) =>
      tx
        .select()
        .from(scanFindings)
        .where(
          and(eq(scanFindings.orgId, domain.orgId), eq(scanFindings.controlRunId, controlRunId))
        )
        .orderBy(asc(scanFindings.ordinal))
    );
  }

  // ===========================================================================================
  // PRODUCER B — the commander's own managed scan (federation/promotion-scan-step.ts)
  // ===========================================================================================

  it("P1: a managed trivy verdict PERSISTS its findings, class O, and says so in evidence", async () => {
    const { changeId } = await proposeArtifactChange(IMAGE_DIGEST, "image");
    const runner = fixedRunner(() => ({
      ok: true,
      report: {
        scannedDigest: IMAGE_DIGEST,
        scannerVersion: "0.53.0",
        severityCounts: { critical: 1, high: 1, medium: 0, low: 0 },
        findings: [
          finding({ severity: "critical", vulnerabilityId: "CVE-2026-0001", pkgName: "zlib" }),
          // A finding with NOTHING but a severity — the shape `ScanFindingSchema`'s optionality
          // exists for. It is counted, so it must be persisted; it is simply one no exclusion clause
          // can ever match, which is the safe direction.
          { severity: "high" }
        ]
      }
    }));

    await runPromotionScanStep(
      domain.db,
      { orgId: domain.orgId, changeIdOrUrn: changeId, actorObjectId: domain.orgId },
      runner
    );

    const run = await managedRunFor(changeId);
    const rows = await findingsOf(run.id);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      ordinal: 0,
      severity: "critical",
      vulnerabilityId: "CVE-2026-0001",
      pkgName: "zlib",
      fixedVersion: "1.1.1t",
      class: "os-pkgs",
      purl: "pkg:apk/alpine/openssl@1.1.1n"
    });
    // The identifier-less entry round-trips as NULLs, not as a dropped row.
    expect(rows[1]).toMatchObject({
      ordinal: 1,
      severity: "high",
      vulnerabilityId: null,
      pkgName: null,
      purl: null
    });
    // ADR-0024 §D1 class, per row (ADR-0033 D10). Nothing is excluded until M22.2, so every row is
    // telemetry — the mechanism, honestly parameterised, not a classification faked ahead of it.
    expect(rows.map((r) => r.retentionClass)).toEqual(["O", "O"]);

    // The verdict states WHAT its finding set is, positively.
    const evidence = ScanEvidenceSchema.parse(run.evidence);
    expect(evidence.findingsRecord).toBe("full");
    // ... and `severityCounts` still means WHAT THE SCANNER FOUND (ADR-0033 §2) — untouched.
    expect(evidence.severityCounts).toEqual({ critical: 1, high: 1, medium: 0, low: 0 });
  });

  it("P2: an OpenSCAP verdict can NEVER carry findings — refused by METHOD, not by an empty array", async () => {
    const { changeId } = await proposeArtifactChange(RPM_DIGEST, "rpm");
    // The runner deliberately returns findings ALONGSIDE `openscap`. XCCDF rule-results have no
    // package, purl, `FixedVersion` or `Class`, so this can never happen for real — which is exactly
    // why it is injected here. ADR-0033's consequences list requires this be refused explicitly "and
    // tested, not left to 'there were no findings to exclude'"; a refusal keyed on an empty array
    // would let this through.
    const runner = fixedRunner((req) => {
      expect(req.method).toBe("openscap");
      return {
        ok: true,
        report: {
          scannedDigest: RPM_DIGEST,
          scannerVersion: "1.4.0",
          severityCounts: { critical: 0, high: 0, medium: 2, low: 0 },
          findings: [finding({ severity: "medium" }), finding({ severity: "medium" })]
        }
      };
    });

    await runPromotionScanStep(
      domain.db,
      { orgId: domain.orgId, changeIdOrUrn: changeId, actorObjectId: domain.orgId },
      runner
    );

    const run = await managedRunFor(changeId);
    expect(await findingsOf(run.id)).toHaveLength(0);
    const evidence = ScanEvidenceSchema.parse(run.evidence);
    expect(evidence.scanner).toBe("openscap");
    // SAYS SO, rather than leaving a reader to infer it from an absence that a genuinely clean trivy
    // scan, a pre-M22.1b scan and this case all share.
    expect(evidence.findingsRecord).toBe("unsupported");
  });

  it("P3: a set over the cap is TRUNCATED, and the verdict records that it was", async () => {
    const { changeId } = await proposeArtifactChange(IMAGE_DIGEST, "image");
    const runner = fixedRunner(() => ({
      ok: true,
      report: {
        scannedDigest: IMAGE_DIGEST,
        scannerVersion: "0.53.0",
        severityCounts: { critical: 0, high: SCAN_FINDINGS_PERSIST_CAP + 2, medium: 0, low: 0 },
        findings: Array.from({ length: SCAN_FINDINGS_PERSIST_CAP + 2 }, (_, i) =>
          finding({ vulnerabilityId: `CVE-2026-${i}` })
        )
      }
    }));

    await runPromotionScanStep(
      domain.db,
      { orgId: domain.orgId, changeIdOrUrn: changeId, actorObjectId: domain.orgId },
      runner
    );

    const run = await managedRunFor(changeId);
    const rows = await findingsOf(run.id);
    expect(rows).toHaveLength(SCAN_FINDINGS_PERSIST_CAP);
    const evidence = ScanEvidenceSchema.parse(run.evidence);
    // M22.2 reads THIS to refuse every exclusion for this scan: you cannot except what you did not
    // record.
    expect(evidence.findingsRecord).toBe("truncated");
    // The CAP bounds what is persisted; it never moves what the scanner FOUND.
    expect(evidence.severityCounts.high).toBe(SCAN_FINDINGS_PERSIST_CAP + 2);
  });

  it("P4: a trivy scan that genuinely found nothing is a FULL record of an empty set", async () => {
    const { changeId } = await proposeArtifactChange(IMAGE_DIGEST, "image");
    const runner = fixedRunner(() => ({
      ok: true,
      report: {
        scannedDigest: IMAGE_DIGEST,
        scannerVersion: "0.53.0",
        severityCounts: { critical: 0, high: 0, medium: 0, low: 0 },
        findings: []
      }
    }));

    await runPromotionScanStep(
      domain.db,
      { orgId: domain.orgId, changeIdOrUrn: changeId, actorObjectId: domain.orgId },
      runner
    );

    const run = await managedRunFor(changeId);
    expect(await findingsOf(run.id)).toHaveLength(0);
    // Zero rows, but a materially DIFFERENT claim from P2's `unsupported`: here exclusions are
    // admissible and simply have nothing to act on. Only the marker distinguishes them.
    expect(ScanEvidenceSchema.parse(run.evidence).findingsRecord).toBe("full");
  });

  it("P5: findings are COMMANDER-LOCAL — the promotion bundle keeps counts and carries none", async () => {
    await withTenantTx(domain.db, domain.orgId, (tx) => ensureFederationSelf(tx, domain.orgId));
    const { publicKey } = generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "der" },
      privateKeyEncoding: { type: "pkcs8", format: "der" }
    }) as unknown as { publicKey: Buffer };
    const peerName = `peer-${randomUUID()}`;
    await withTenantTx(domain.db, domain.orgId, (tx) =>
      pairPeer(tx, {
        orgId: domain.orgId,
        domainId: asTrustDomainId(randomUUID()),
        name: peerName,
        role: "outpost",
        publicKey: publicKey.toString("base64")
      })
    );

    const { changeId } = await proposeArtifactChange(IMAGE_DIGEST, "image");
    const outcome = await exportPromotionBundle(domain.db, {
      orgId: domain.orgId,
      peerIdOrName: peerName,
      changeIdOrUrn: changeId,
      scanRunner: fixedRunner(() => ({
        ok: true,
        report: {
          scannedDigest: IMAGE_DIGEST,
          scannerVersion: "0.53.0",
          severityCounts: { critical: 0, high: 0, medium: 0, low: 0 },
          findings: [finding({ severity: "low", vulnerabilityId: "CVE-2026-SECRET" })]
        }
      }))
    });

    expect(outcome.refused, outcome.refused ? outcome.reason : "expected export").toBe(false);
    if (outcome.refused) throw new Error(outcome.reason);

    const run = await managedRunFor(changeId);
    expect(await findingsOf(run.id)).toHaveLength(1);

    // ...and NOT in the signed bundle. `promotion-repo.ts` copies `control_runs.evidence` VERBATIM
    // into `controlOutcomes`, so this is the boundary where a finding left on that column would have
    // federated accepted-risk detail into every domain receiving the journal (ADR-0033 §8).
    const serialized = JSON.stringify(outcome.bundle);
    expect(serialized).not.toContain("CVE-2026-SECRET");
    expect(serialized).not.toContain(SCAN_FINDINGS_TRANSPORT_KEY);
    // The bundle keeps the COUNTS, which is the whole point of the split.
    const scanOutcome = outcome.bundle.controlOutcomes.find(
      (o) => ScanEvidenceSchema.safeParse(o.evidence).success
    );
    expect(scanOutcome).toBeDefined();
    expect(ScanEvidenceSchema.parse(scanOutcome!.evidence).severityCounts).toEqual({
      critical: 0,
      high: 0,
      medium: 0,
      low: 0
    });
  });

  // ===========================================================================================
  // PRODUCER A — the ControlPlugin path (governance/control-runner.ts)
  //
  // The plugin runs in the subprocess plugin host with no `DATABASE_URL`. It transports its capped
  // findings out on the outcome's evidence and the SERVER persists them; the fake host below stands
  // in for that subprocess and returns exactly the record `scan-result-control` builds.
  // ===========================================================================================

  function hostReturning(outcome: ControlOutcome): PluginHost {
    return {
      start: async () => undefined,
      stop: async () => undefined,
      stopInstances: async () => undefined,
      control: () => ({ evaluate: async () => outcome }),
      executor: () => {
        throw new Error("not used");
      },
      discovery: () => {
        throw new Error("not used");
      },
      notification: () => {
        throw new Error("not used");
      },
      federationTransport: () => {
        throw new Error("not used");
      },
      dependencyIndex: () => {
        throw new Error("not used");
      },
      gitFileRead: () => {
        throw new Error("not used");
      }
    } as unknown as PluginHost;
  }

  async function boundControl(): Promise<{ controlObjectId: string; changeObjectId: string }> {
    const control = await withTenantTx(domain.db, domain.orgId, (tx) =>
      createObject(tx, {
        orgId: domain.orgId,
        domainId: null,
        typeId: "control",
        actorObjectId: domain.orgId,
        requestId: `sf-control-${randomUUID()}`,
        name: `sf-control-${randomUUID()}`,
        properties: { category: "security" }
      })
    );
    await withTenantTx(domain.db, domain.orgId, (tx) =>
      upsertControlBinding(tx, {
        orgId: domain.orgId,
        controlObjectId: control.id,
        pluginModule: "scan-result-control",
        pluginInstanceId: `sf-instance-${randomUUID()}`
      })
    );
    const { changeId } = await proposeArtifactChange(IMAGE_DIGEST, "image");
    return { controlObjectId: control.id, changeObjectId: changeId };
  }

  /** Exactly what `scan-result-control` returns: evidence built through `ScanEvidenceSchema`, with
   *  the capped findings attached AFTER the parse (which strips unknown keys). */
  function scanOutcomeWith(findings: ScanFinding[]): ControlOutcome {
    const evidence = ScanEvidenceSchema.parse({
      scanner: "trivy",
      scannerVersion: "0.53.0",
      artifactDigest: IMAGE_DIGEST,
      expectedDigest: IMAGE_DIGEST,
      digestMatch: true,
      severityCounts: { critical: 0, high: findings.length, medium: 0, low: 0 },
      threshold: { maxCritical: 0, maxHigh: 99 }
    });
    return {
      status: "pass",
      detail: "fixture",
      evidence: attachScanFindingsForTransport(
        evidence as unknown as Record<string, unknown>,
        capScanFindings(findings)
      )
    };
  }

  async function runOf(controlObjectId: string, changeObjectId: string) {
    const rows = await withTenantTx(domain.db, domain.orgId, (tx) =>
      tx
        .select()
        .from(controlRuns)
        .where(
          and(
            eq(controlRuns.orgId, domain.orgId),
            eq(controlRuns.changeObjectId, changeObjectId),
            eq(controlRuns.controlObjectId, controlObjectId)
          )
        )
    );
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }

  it("A1: the PLUGIN path persists what the plugin could not write itself", async () => {
    const { controlObjectId, changeObjectId } = await boundControl();
    const host = hostReturning(
      scanOutcomeWith([
        finding({ vulnerabilityId: "CVE-2026-2001" }),
        finding({ vulnerabilityId: "CVE-2026-2002", severity: "low" })
      ])
    );

    const status = await withTenantTx(domain.db, domain.orgId, (tx) =>
      ensureControlRun(tx, host, {
        orgId: domain.orgId,
        changeObjectId,
        controlObjectId,
        gateKind: "lifecycle_edge",
        gateRef: { fromState: "validating", toState: "accepted" },
        context: {}
      })
    );
    expect(status).toBe("pass");

    const run = await runOf(controlObjectId, changeObjectId);
    const rows = await findingsOf(run.id);
    expect(rows.map((r) => r.vulnerabilityId)).toEqual(["CVE-2026-2001", "CVE-2026-2002"]);
    expect(rows.map((r) => r.severity)).toEqual(["high", "low"]);
    expect(rows.map((r) => r.retentionClass)).toEqual(["O", "O"]);
    expect(ScanEvidenceSchema.parse(run.evidence).findingsRecord).toBe("full");
  });

  it("A2: the plugin's OWN truncation flag survives the wire", async () => {
    const { controlObjectId, changeObjectId } = await boundControl();
    const evidence = ScanEvidenceSchema.parse({
      scanner: "trivy",
      scannerVersion: "0.53.0",
      artifactDigest: IMAGE_DIGEST,
      expectedDigest: IMAGE_DIGEST,
      digestMatch: true,
      severityCounts: { critical: 0, high: 9999, medium: 0, low: 0 },
      threshold: { maxCritical: 0, maxHigh: 99999 }
    });
    const host = hostReturning({
      status: "pass",
      evidence: attachScanFindingsForTransport(evidence as unknown as Record<string, unknown>, {
        findings: [finding()],
        truncated: true
      })
    });

    await withTenantTx(domain.db, domain.orgId, (tx) =>
      ensureControlRun(tx, host, {
        orgId: domain.orgId,
        changeObjectId,
        controlObjectId,
        gateKind: "lifecycle_edge",
        gateRef: { fromState: "validating", toState: "accepted" },
        context: {}
      })
    );

    const run = await runOf(controlObjectId, changeObjectId);
    expect(await findingsOf(run.id)).toHaveLength(1);
    expect(ScanEvidenceSchema.parse(run.evidence).findingsRecord).toBe("truncated");
  });

  it("A3: the transport key NEVER lands on control_runs.evidence — the column federation copies", async () => {
    const { controlObjectId, changeObjectId } = await boundControl();
    const host = hostReturning(scanOutcomeWith([finding({ vulnerabilityId: "CVE-2026-LEAK" })]));

    await withTenantTx(domain.db, domain.orgId, (tx) =>
      ensureControlRun(tx, host, {
        orgId: domain.orgId,
        changeObjectId,
        controlObjectId,
        gateKind: "lifecycle_edge",
        gateRef: { fromState: "validating", toState: "accepted" },
        context: {}
      })
    );

    const run = await runOf(controlObjectId, changeObjectId);
    const persisted = run.evidence as Record<string, unknown>;
    expect(persisted).not.toHaveProperty(SCAN_FINDINGS_TRANSPORT_KEY);
    expect(persisted).not.toHaveProperty(SCAN_FINDINGS_TRUNCATED_TRANSPORT_KEY);
    expect(JSON.stringify(persisted)).not.toContain("CVE-2026-LEAK");
    // The findings themselves are on disk in the projection, where they are commander-local.
    expect(await findingsOf(run.id)).toHaveLength(1);
  });

  it("A4: a NON-scan control's evidence records no finding set, even if a payload rides along", async () => {
    const { controlObjectId, changeObjectId } = await boundControl();
    // Evidence that is not a scan verdict at all (webhook-control's shape), with a transport payload
    // bolted on. The server has no METHOD to attribute the findings to, so it records nothing — and
    // still strips the key.
    const host = hostReturning({
      status: "pass",
      evidence: {
        httpStatus: 200,
        [SCAN_FINDINGS_TRANSPORT_KEY]: [finding()],
        [SCAN_FINDINGS_TRUNCATED_TRANSPORT_KEY]: false
      }
    });

    await withTenantTx(domain.db, domain.orgId, (tx) =>
      ensureControlRun(tx, host, {
        orgId: domain.orgId,
        changeObjectId,
        controlObjectId,
        gateKind: "lifecycle_edge",
        gateRef: { fromState: "validating", toState: "accepted" },
        context: {}
      })
    );

    const run = await runOf(controlObjectId, changeObjectId);
    expect(run.evidence).toEqual({ httpStatus: 200 });
    expect(await findingsOf(run.id)).toHaveLength(0);
  });

  // ===========================================================================================
  // TENANCY — ordinary tenant data under RLS (ADR-0033 §7a), NOT the instance-scoped exception
  // M22.2's admission rows are. Probed with a RAW `scp_app` connection: the database's own
  // defenses, independent of whether the repo layer remembers to filter.
  // ===========================================================================================

  describe("tenancy and referential barriers", () => {
    let raw: pg.Client;
    let seededRunId: string;

    beforeAll(async () => {
      const { changeId } = await proposeArtifactChange(IMAGE_DIGEST, "image");
      await runPromotionScanStep(
        domain.db,
        { orgId: domain.orgId, changeIdOrUrn: changeId, actorObjectId: domain.orgId },
        fixedRunner(() => ({
          ok: true,
          report: {
            scannedDigest: IMAGE_DIGEST,
            scannerVersion: "0.53.0",
            severityCounts: { critical: 0, high: 1, medium: 0, low: 0 },
            findings: [finding({ vulnerabilityId: "CVE-2026-TENANT" })]
          }
        }))
      );
      seededRunId = (await managedRunFor(changeId)).id;
      raw = new pg.Client({ connectionString: deriveRuntimeDatabaseUrl(domain.adminUrl) });
      await raw.connect();
    }, 60_000);

    afterAll(async () => {
      await raw?.end();
    });

    it("R1: a session in ANOTHER org sees none of these findings", async () => {
      await raw.query("SELECT set_config('app.current_org_id', $1, false)", [randomUUID()]);
      const seen = await raw.query("SELECT * FROM scan_findings");
      expect(seen.rowCount).toBe(0);
      // Negative control: the SAME raw connection, in the owning org, sees the row — so R1 is
      // proving isolation, not proving that the seed failed.
      await raw.query("SELECT set_config('app.current_org_id', $1, false)", [domain.orgId]);
      const own = await raw.query(
        "SELECT vulnerability_id FROM scan_findings WHERE control_run_id = $1",
        [seededRunId]
      );
      expect(own.rows.map((r) => r.vulnerability_id)).toEqual(["CVE-2026-TENANT"]);
    });

    it("R2: RLS WITH CHECK refuses a row stamped with another org's id (barrier 1)", async () => {
      await raw.query("SELECT set_config('app.current_org_id', $1, false)", [domain.orgId]);
      await expect(
        raw.query(
          `INSERT INTO scan_findings (org_id, control_run_id, ordinal, severity)
             VALUES ($1, $2, 999, 'high')`,
          [randomUUID(), seededRunId]
        )
      ).rejects.toThrow(/row-level security|violates/i);
    });

    it("R2b: the composite FK refuses a finding pointing at another org's control run (barrier 2)", async () => {
      const otherOrg = randomUUID();
      await raw.query("SELECT set_config('app.current_org_id', $1, false)", [otherOrg]);
      // Passes barrier 1 (the row's own org_id matches the session), and is still refused because
      // `(org_id, control_run_id)` names a control run belonging to a different org. 0061 could not
      // build this barrier for its `objects(id)` references and says so; 0065 adds the
      // `(org_id, id)` unique on `control_runs` precisely so this one exists.
      await expect(
        raw.query(
          `INSERT INTO scan_findings (org_id, control_run_id, ordinal, severity)
             VALUES ($1, $2, 0, 'high')`,
          [otherOrg, seededRunId]
        )
      ).rejects.toThrow(/foreign key|scan_findings_control_run_fk/i);
    });

    it("R3: findings never outlive the verdict they explain (ON DELETE CASCADE)", async () => {
      const { changeId } = await proposeArtifactChange(IMAGE_DIGEST, "image");
      await runPromotionScanStep(
        domain.db,
        { orgId: domain.orgId, changeIdOrUrn: changeId, actorObjectId: domain.orgId },
        fixedRunner(() => ({
          ok: true,
          report: {
            scannedDigest: IMAGE_DIGEST,
            scannerVersion: "0.53.0",
            severityCounts: { critical: 0, high: 1, medium: 0, low: 0 },
            findings: [finding()]
          }
        }))
      );
      const run = await managedRunFor(changeId);
      expect(await findingsOf(run.id)).toHaveLength(1);

      // `scp_app` has no DELETE grant on `control_runs` (0010) — a retention job runs as the
      // operator, so the cascade is probed over the admin connection, which is the identity that
      // would actually prune one.
      const adminPool = new pg.Pool({ connectionString: domain.adminUrl });
      try {
        await adminPool.query(`DELETE FROM control_runs WHERE id = $1`, [run.id]);
      } finally {
        await adminPool.end();
      }
      expect(await findingsOf(run.id)).toHaveLength(0);
    });

    it("R4: the retention class column refuses 'P' — no finding is permanent evidence", async () => {
      await raw.query("SELECT set_config('app.current_org_id', $1, false)", [domain.orgId]);
      await expect(
        raw.query(
          `INSERT INTO scan_findings (org_id, control_run_id, ordinal, severity, retention_class)
             VALUES ($1, $2, 500, 'high', 'P')`,
          [domain.orgId, seededRunId]
        )
      ).rejects.toThrow(/scan_findings_retention_class_check|check constraint/i);
      // Negative control: 'E' — the class an EXCLUDED finding takes in M22.2 — is accepted.
      await raw.query(
        `INSERT INTO scan_findings (org_id, control_run_id, ordinal, severity, retention_class)
           VALUES ($1, $2, 501, 'high', 'E')`,
        [domain.orgId, seededRunId]
      );
    });
  });
});
