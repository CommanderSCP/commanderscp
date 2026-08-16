import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import { ScpClient } from "@scp/sdk";
import type { ComponentPipelineArtifact, GraphObject } from "@scp/schemas";
import { withTenantTx } from "../db/tenant-tx.js";
import { insertControlRun } from "../governance/controls-repo.js";
import { MANAGED_SCAN_CONTROL_OBJECT_ID } from "../federation/promotion-scan-step.js";
import { PROMOTION_EXPORTS_KEY } from "../federation/boundary-bundle-ref.js";
import { compileAndPersistPlan } from "./plan-service.js";
import {
  createOrphanComponent,
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/**
 * pipeline-substrate-registry-scan.md §9.3 — the `artifact` field of a component's pipeline, through
 * the real HTTP route against real Postgres.
 *
 * WHAT EACH TEST PINS, AND WHY IT IS NOT VACUOUS
 *   - the PICK: a digest-carrying change is found through the component's `properties.targets`
 *     (the fallback arm) AND a change the stages already show (a compiled plan's wave target) is
 *     preferred over a NEWER digest-carrying change the stages do not show — so "newest of the
 *     component at all" alone fails.
 *   - digests + SBOM read VERBATIM off `sourceRef` (`artifactDigest`, the report's key), the SBOM's
 *     origin `signatureRef` surfaced under `signing.originSignatureRefs` — and NOTHING under
 *     `promotionExports` until an export stamps one (this org never exports).
 *   - scan REDUCTION: three `control_runs` rows over one digest — an older org-pipeline `fail`, a
 *     newer org-pipeline `pass` (same scanner ⇒ same key ⇒ only the newest survives), and a MANAGED
 *     `openscap` pass (the synthetic control id) — reduce to TWO rows, one flagged `managed`, and E6's
 *     own predicate reads `pass`. Returning every row (3) or misreading `managed` both fail.
 *   - E6 read-only: a change whose only scan row is digest-UNBOUND reads `fail` (evidence exists,
 *     covers nothing); no rows at all reads `not_run`.
 *   - `artifact: null` for a component whose changes carry no digest, and for one with no change.
 *   - an UNPARSEABLE `sbom` reads null + `unknownFields: ["sbom:unparseable"]`, digests intact.
 *   - a stored `promotionExports[]` entry that does not parse is COUNTED under `unknownFields`,
 *     the parseable one beside it still rendered with `peerName: null` (no peer row here).
 *
 * MUTATION LOG (each applied ALONE, then reverted)
 * | Mutation | Result |
 * |---|---|
 * | drop the `preferredChangeIds` arm (fallback only) | the pick-preference test FAILS (newer non-current change picked) |
 * | drop the `seen` dedupe in `scanRunsForChange` | the reduction test FAILS (3 scans, and a `fail` row beside the pass) |
 * | `managed: false` always | the reduction test FAILS on the openscap row |
 * | `exportGate` = `outcomes.length > 0 ? "pass" : "not_run"` | the digest-unbound test FAILS (`pass` where `fail`) |
 * | skip the `sbom:unparseable` push | the unparseable-sbom test FAILS |
 */
describe("component pipeline: the artifact and its change-scoped facts (§9.3)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;
  let gamma: GraphObject;

  const uniq = (p: string) => `${p}-${uuidv7()}`;
  const digestOf = (seed: string) => `sha256:${seed.repeat(64).slice(0, 64)}`;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "pipeline-artifact");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    gamma = await admin.deploymentTargets.create({
      name: uniq("gamma"),
      properties: { environment: "gamma" }
    });
  });

  afterAll(async () => {
    await server?.close();
  });

  async function pipelineOf(componentId: string): Promise<{
    artifact: ComponentPipelineArtifact | null | undefined;
    stages: { current: { changeId: string } | null }[];
  }> {
    const res = await server.app.inject({
      method: "GET",
      url: `/api/v1/components/${componentId}/pipeline`,
      headers: { authorization: `Bearer ${org.adminToken}` }
    });
    expect(res.statusCode, "the pipeline route must answer").toBe(200);
    return res.json();
  }

  /** A change of `componentId` with the given `sourceRef` — through the public API, exactly the way
   *  a first-party report's canonical keys end up on the row. */
  async function proposeWith(componentId: string, sourceRef: Record<string, unknown> | undefined) {
    return admin.changes.propose({
      name: uniq("chg"),
      targets: [componentId],
      type: "image",
      ...(sourceRef ? { sourceRef } : {})
    });
  }

  type ScanRow = {
    status?: "pass" | "fail";
    scanner?: "trivy" | "openscap" | "trivy-vm";
    digestMatch?: boolean;
    scannedDigest?: string;
    managed?: boolean;
    counts?: { critical: number; high: number; medium: number; low: number };
  };
  async function seedScan(changeId: string, digest: string, over: ScanRow = {}) {
    const scanner = over.scanner ?? "trivy";
    return withTenantTx(server.deps.db, org.orgId, (tx) =>
      insertControlRun(tx, {
        orgId: org.orgId,
        controlObjectId: over.managed ? MANAGED_SCAN_CONTROL_OBJECT_ID : randomUUID(),
        changeObjectId: changeId,
        gateKind: "lifecycle_edge",
        gateRef: over.managed
          ? { promotionScanStep: true, method: scanner, artifactDigest: digest }
          : { fromState: "validating", toState: "accepted" },
        status: over.status ?? "pass",
        evidence: {
          scanner,
          scannerVersion: "0.55.0",
          artifactDigest: over.scannedDigest ?? digest,
          expectedDigest: digest,
          digestMatch: over.digestMatch ?? true,
          severityCounts: over.counts ?? { critical: 0, high: 2, medium: 5, low: 9 },
          threshold: { maxCritical: 0, maxHigh: 2 }
        }
      })
    );
  }

  const sbom = {
    format: "cyclonedx",
    specVersion: "1.5",
    digest: digestOf("b"),
    location: "https://ci.acme.invalid/sbom/checkout-api.cdx.json",
    mediaType: "application/vnd.cyclonedx+json",
    signatureRef: "https://ci.acme.invalid/sbom/checkout-api.cdx.json.sig",
    scanner: "syft",
    scannerVersion: "1.18.0",
    generatedAt: "2026-08-15T10:00:00.000Z"
  };

  it("`artifact: null` when no change of the component carries a digest — and when it has no change at all", async () => {
    const bare = await createOrphanComponent(admin, uniq("no-change"));
    expect((await pipelineOf(bare.id)).artifact, "emitted as null, not omitted").toBeNull();

    const digestless = await createOrphanComponent(admin, uniq("no-digest"));
    await proposeWith(digestless.id, { repo: "acme/checkout", commit: "abc" });
    await proposeWith(digestless.id, undefined);
    expect(
      (await pipelineOf(digestless.id)).artifact,
      "changes exist but none carries an artifact digest — 'no artifact yet'"
    ).toBeNull();
  });

  it("reads digests + SBOM verbatim off the picked change; nothing scanned ⇒ `not_run`; nothing exported ⇒ no promotionExports; the SBOM's origin signatureRef is the only signature ref", async () => {
    const component = await createOrphanComponent(admin, uniq("artifact"));
    const digest = digestOf("a");
    const change = await proposeWith(component.id, { artifactDigest: digest, sbom });

    const { artifact } = await pipelineOf(component.id);
    expect(artifact).not.toBeNull();
    expect(artifact!.changeId).toBe(change.id);
    expect(artifact!.changeName).toBe(change.name);
    expect(artifact!.digests).toEqual([digest]);
    expect(artifact!.sbom, "the typed reference, field for field").toEqual(sbom);
    expect(artifact!.scans).toEqual([]);
    expect(artifact!.exportGate).toBe("not_run");
    expect(artifact!.signing.promotionExports).toEqual([]);
    expect(artifact!.signing.originSignatureRefs).toEqual([sbom.signatureRef]);
    expect(artifact!.unknownFields).toEqual([]);
  });

  it("reduces the change's scan rows to the NEWEST per (scanner, digest), flags the managed one, and reads E6's own verdict: `pass`", async () => {
    const component = await createOrphanComponent(admin, uniq("scans"));
    const digest = digestOf("c");
    const change = await proposeWith(component.id, { artifact_digest: [digest] });

    const olderFail = await seedScan(change.id, digest, {
      status: "fail",
      counts: { critical: 1, high: 0, medium: 0, low: 0 }
    });
    const newerPass = await seedScan(change.id, digest, { status: "pass" });
    const managed = await seedScan(change.id, digest, { scanner: "openscap", managed: true });

    const { artifact } = await pipelineOf(component.id);
    expect(artifact!.digests, "string[] form of the canonical key reads the same").toEqual([
      digest
    ]);
    expect(artifact!.scans, "three rows, two keys — the older trivy row is gone").toHaveLength(2);
    expect(artifact!.scans.map((s) => s.controlRunId)).not.toContain(olderFail.id);

    const trivy = artifact!.scans.find((s) => s.scanner === "trivy")!;
    expect(trivy).toMatchObject({
      method: "trivy",
      scanner: "trivy",
      scannerVersion: "0.55.0",
      digest,
      digestMatch: true,
      status: "pass",
      counts: { critical: 0, high: 2, medium: 5, low: 9 },
      threshold: { maxCritical: 0, maxHigh: 2 },
      controlRunId: newerPass.id,
      managed: false
    });
    expect(trivy.evaluatedAt).toBe(newerPass.createdAt.toISOString());

    const oscap = artifact!.scans.find((s) => s.scanner === "openscap")!;
    expect(oscap, "the synthetic control id IS the managed discriminator").toMatchObject({
      method: "openscap",
      controlRunId: managed.id,
      managed: true
    });

    expect(artifact!.exportGate, "a passing digest-bound row exists for the one digest").toBe(
      "pass"
    );
  });

  it("E6 read-only: a scan row that is not digest-bound reads `fail` (evidence exists, covers nothing)", async () => {
    const component = await createOrphanComponent(admin, uniq("unbound"));
    const digest = digestOf("d");
    const change = await proposeWith(component.id, { artifactDigest: digest });
    await seedScan(change.id, digest, { digestMatch: false, scannedDigest: digestOf("e") });

    const { artifact } = await pipelineOf(component.id);
    expect(artifact!.scans).toHaveLength(1);
    expect(artifact!.scans[0]!.digestMatch).toBe(false);
    expect(artifact!.exportGate).toBe("fail");
  });

  it("prefers a change the STAGES show over a newer digest-carrying change they do not; among the fallback the newest wins", async () => {
    const component = await createOrphanComponent(admin, uniq("pick"));
    await admin.placements.create({ component: component.id, deploymentTarget: gamma.id });
    const topo = await admin.object("release-topology").create({
      name: uniq("topo"),
      properties: { waves: [{ name: "gamma", mode: "parallel", targets: [gamma.id] }] }
    });
    await admin.relationships.create({
      typeId: "releases_via",
      fromId: component.id,
      toId: topo.id
    });

    // Fallback arm first: two digest-carrying changes, neither compiled — the NEWER is picked.
    const older = await proposeWith(component.id, { artifactDigest: digestOf("1") });
    const newer = await proposeWith(component.id, { artifactDigest: digestOf("2") });
    expect((await pipelineOf(component.id)).artifact!.changeId).toBe(newer.id);

    // Now compile the OLDER one so the gamma stage's `current` is it. The stage shows `older`;
    // the artifact must describe the same change, not the newer one nobody released.
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      compileAndPersistPlan(tx, {
        orgId: org.orgId,
        changeObjectId: older.id,
        targetObjectIds: [component.id],
        topologyObjectId: topo.id,
        topologyVersion: null
      })
    );
    const p = await pipelineOf(component.id);
    expect(p.stages[0]!.current?.changeId, "precondition: the stage shows the older change").toBe(
      older.id
    );
    expect(p.artifact!.changeId, "the tile and the journey describe the same change").toBe(
      older.id
    );
    expect(p.artifact!.digests).toEqual([digestOf("1")]);
  });

  it("an unparseable `sbom` reads null and is STATED under unknownFields — the digests are unaffected", async () => {
    const component = await createOrphanComponent(admin, uniq("bad-sbom"));
    const digest = digestOf("f");
    await proposeWith(component.id, {
      artifactDigest: digest,
      // `format` outside the enum, no `location`: fails SbomRefSchema, but still carries a string
      // digest (the export reader would still carry it as a blob — that leniency is the export's).
      sbom: { format: "swid", digest: digestOf("9") }
    });

    const { artifact } = await pipelineOf(component.id);
    expect(artifact!.digests).toEqual([digest]);
    expect(artifact!.sbom).toBeNull();
    expect(artifact!.unknownFields).toEqual(["sbom:unparseable"]);
  });

  it("renders a stored promotionExports[] stamp with `peerName: null` when no peer row exists, and COUNTS an unparseable one", async () => {
    const component = await createOrphanComponent(admin, uniq("stamped"));
    const digest = digestOf("7");
    const peerDomainId = randomUUID();
    const manifest = {
      manifestVersion: "scp-promotion-manifest/v1",
      createdAt: "2026-08-16T00:00:00.000Z",
      sourceChangeObjectId: randomUUID(),
      exporterDomainId: randomUUID(),
      peerDomainId,
      changeUrn: "urn:scp:x:change:y",
      artifacts: [{ type: "oci", digest }]
    };
    await proposeWith(component.id, {
      artifactDigest: digest,
      [PROMOTION_EXPORTS_KEY]: [
        {
          peerDomainId,
          exportedAt: "2026-08-16T00:00:01.000Z",
          checksum: "c".repeat(64),
          manifest,
          manifestSignature: "MEUCIQ==",
          keyFingerprint: "ab".repeat(32)
        },
        { checksum: "not-a-record" }
      ]
    });

    const { artifact } = await pipelineOf(component.id);
    expect(artifact!.signing.promotionExports).toEqual([
      {
        peerDomainId,
        peerName: null,
        exportedAt: "2026-08-16T00:00:01.000Z",
        checksum: "c".repeat(64),
        manifest,
        manifestSignature: "MEUCIQ==",
        keyFingerprint: "ab".repeat(32)
      }
    ]);
    expect(artifact!.unknownFields).toEqual(["promotionExports:unparseable"]);
  });
});
