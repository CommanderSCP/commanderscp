import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import { ScpClient } from "@scp/sdk";
import type { ComponentPipelineArtifact, GraphObject } from "@scp/schemas";
import { and, eq } from "drizzle-orm";
import { withTenantTx } from "../db/tenant-tx.js";
import { changes } from "../db/schema.js";
import { insertControlRun } from "../governance/controls-repo.js";
import { MANAGED_SCAN_CONTROL_OBJECT_ID } from "../federation/scan-evidence.js";
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
 *   - the reduction keeps the NEWEST row per key even when it is a fail over an older pass (a
 *     "prefer pass" sort would lie), and E6 reads `fail` too: the newer fail is the CURRENT answer of
 *     its control, and every control that has ever answered about the digest must currently pass
 *     (`scan-evidence.ts` property 2 — an older pass never outvotes a newer fail).
 *   - a row from an UNADMITTED producer (`webhook-control` echoing a scan-shaped payload) shows in
 *     `scans[]` (it is a row the change holds) but counts for NOTHING at the gate: `fail`, not `pass`
 *     (property 1 — a scan outcome is identified by its producer, never by the shape of its evidence).
 *   - `managed` is the synthetic control id ALONE: a gateRef claiming `promotionScanStep` on a
 *     random control id reads `managed: false`; the managed id with an empty gateRef reads `true`
 *     with `method` falling back to the scanner.
 *   - a TWO-digest change: a passing digest-bound row for one digest reads `fail` (E6 needs one per
 *     substantive artifact); covering the second flips it to `pass`.
 *   - the INSTANCE FLOOR: an admitted `pass` whose counts breach an operator-authored trust_domain
 *     floor reads `fail` (the export refuses it `below_instance_floor`; the tile is E6's own
 *     predicate, floor included); the floor reset to all-NULL (inert) flips the SAME row to `pass`.
 *   - `POST /changes` 400s a sourceRef planting `promotionExports`/`boundaryBundleChecksums`.
 *
 * MUTATION LOG (each applied ALONE, then reverted)
 * | Mutation | Result |
 * |---|---|
 * | drop the `preferredChangeIds` arm (fallback only) | the pick-preference test FAILS (newer non-current change picked) |
 * | drop the `seen` dedupe in `scanRunsForChange` | the reduction test FAILS (3 scans, and a `fail` row beside the pass) |
 * | `managed: false` always | the reduction test FAILS on the openscap row |
 * | `exportGate` = `runs.length > 0 ? "pass" : "not_run"` | the digest-unbound test FAILS (`pass` where `fail`) |
 * | `exportGate` over `runs.filter(r => ScanEvidenceSchema parses)` ignoring the producer | the webhook-control test FAILS (`pass` where `fail`) |
 * | `exportGate` reads ANY passing digest-bound row (the pre-#245 rule) | the newer-fail test FAILS (`pass` where `fail`) |
 * | skip the `sbom:unparseable` push | the unparseable-sbom test FAILS |
 * | sort rows `pass` first before the reduction | the newer-fail test FAILS (older pass survives) |
 * | `managed: gateRef?.promotionScanStep === true` | the managed-flag test FAILS (impostor reads managed) |
 * | `exportGate = any pass+digestMatch row ? pass : fail` | the two-digest test FAILS (`pass` where `fail`) |
 * | drop the reserved-key check in `routes/changes.ts` | the planted-stamp test FAILS (201) |
 * | `evaluateScanCoverage({ …, instanceFloor: {} })` (compute the floor, pass an empty one) | the instance-floor test FAILS (`pass` where `fail`) |
 */
describe("component pipeline: the artifact and its change-scoped facts (§9.3)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;
  let gamma: GraphObject;

  const uniq = (p: string) => `${p}-${uuidv7()}`;
  const digestOf = (seed: string) => `sha256:${seed.repeat(64).slice(0, 64)}`;

  /** The deployment's operator token — opens the operator-only instance-scan-floor write surface
   *  (M17.5) so the floor case below can author a floor THROUGH THE API, not by admin-pool surgery. */
  const OPERATOR_TOKEN = `pipeline-artifact-operator-${uuidv7()}`;

  /** `scan_requirement_floors` is INSTANCE-GLOBAL and the integration suite runs `singleFork`
   *  against ONE shared Postgres — a floor left behind here would silently tighten every later
   *  suite's gates. Both rows are reset to all-NULL (inert) by the floor case's `finally` AND once
   *  more at teardown, so this file is self-contained wherever it fails. */
  async function clearInstanceFloors(): Promise<void> {
    if (!admin) return;
    const inert = {
      origin: "local" as const,
      maxCritical: null,
      maxHigh: null,
      maxMedium: null,
      maxLow: null
    };
    await admin.instanceScanFloors.put("platform", inert, OPERATOR_TOKEN);
    await admin.instanceScanFloors.put("trust_domain", inert, OPERATOR_TOKEN);
  }

  beforeAll(async () => {
    server = await listenTestServer({ operatorToken: OPERATOR_TOKEN });
    org = await createTestOrg(server, "pipeline-artifact");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    gamma = await admin.deploymentTargets.create({
      name: uniq("gamma"),
      properties: { environment: "gamma" }
    });
  });

  afterAll(async () => {
    await clearInstanceFloors();
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
    /** The ceiling the control says it applied — a TENANT-authored number by default (the
     *  per-binding `config.threshold` fallback), which is exactly why E6 re-checks the counts against
     *  the operator's instance floor rather than trusting `status: pass` alone. */
    threshold?: { maxCritical: number; maxHigh: number; maxMedium?: number; maxLow?: number };
    /** The control the row answers for. Two rows under ONE control are two answers to ONE question
     *  (the newer supersedes); under two controls they are two questions that must BOTH pass. */
    controlObjectId?: string;
    /** WHAT PRODUCED the row — the E6 admission key (`scan-evidence.ts`). Defaults to the
     *  org-pipeline scan control for a bound row and NULL for a managed deposit (the authentic
     *  shapes); pass a module explicitly to seed an unadmitted producer. */
    pluginModule?: string | null;
  };
  async function seedScan(changeId: string, digest: string, over: ScanRow = {}) {
    const scanner = over.scanner ?? "trivy";
    const pluginModule =
      "pluginModule" in over ? over.pluginModule : over.managed ? null : "scan-result-control";
    return withTenantTx(server.deps.db, org.orgId, (tx) =>
      insertControlRun(tx, {
        orgId: org.orgId,
        controlObjectId:
          over.controlObjectId ?? (over.managed ? MANAGED_SCAN_CONTROL_OBJECT_ID : randomUUID()),
        changeObjectId: changeId,
        gateKind: "lifecycle_edge",
        gateRef: over.managed
          ? { promotionScanStep: true, method: scanner, artifactDigest: digest }
          : { fromState: "validating", toState: "accepted" },
        ...(pluginModule === null ? {} : { pluginModule }),
        status: over.status ?? "pass",
        evidence: {
          scanner,
          scannerVersion: "0.55.0",
          artifactDigest: over.scannedDigest ?? digest,
          expectedDigest: digest,
          digestMatch: over.digestMatch ?? true,
          severityCounts: over.counts ?? { critical: 0, high: 2, medium: 5, low: 9 },
          threshold: over.threshold ?? { maxCritical: 0, maxHigh: 2 }
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

    // The org control answers twice: an older fail, then a pass — ONE question, whose CURRENT
    // answer is the pass (that is what lets E6 read `pass` below; two controls would be two
    // questions and the failing one's answer would stand).
    const orgControl = randomUUID();
    const olderFail = await seedScan(change.id, digest, {
      status: "fail",
      counts: { critical: 1, high: 0, medium: 0, low: 0 },
      controlObjectId: orgControl
    });
    const newerPass = await seedScan(change.id, digest, {
      status: "pass",
      controlObjectId: orgControl
    });
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

    expect(
      artifact!.exportGate,
      "every question about the digest currently answers pass: the org control (its newer row) and the managed trivy step"
    ).toBe("pass");
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

  it("the fallback pick is not pushed out of its page by NEWER metadata-only promotion imports (the importer stamps `artifactDigests: []` on every promoted change; the SQL prefilter admits the importer's key only when NON-EMPTY)", async () => {
    const component = await createOrphanComponent(admin, uniq("page-pressure"));
    const carrier = await proposeWith(component.id, { artifactDigest: digestOf("7") });
    expect((await pipelineOf(component.id)).artifact!.changeId).toBe(carrier.id);

    // 30 newer changes, each stamped exactly as the importer stamps a metadata-only promotion
    // (`artifactDigests: []`, no typed set, no origin key) — more than the 25-row page.
    for (let i = 0; i < 30; i++) {
      const c = await proposeWith(component.id, { repo: "acme/config" });
      await withTenantTx(server.deps.db, org.orgId, (tx) =>
        tx
          .update(changes)
          .set({
            sourceRef: {
              repo: "acme/config",
              promotedFromDomain: randomUUID(),
              sourceChangeObjectId: randomUUID(),
              artifactDigests: []
            }
          })
          .where(and(eq(changes.orgId, org.orgId), eq(changes.objectId, c.id)))
      );
    }
    const { artifact } = await pipelineOf(component.id);
    expect(artifact, "the real artifact-carrying change, not a silent null").not.toBeNull();
    expect(artifact!.changeId).toBe(carrier.id);
    expect(artifact!.digests).toEqual([digestOf("7")]);
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

  it("keeps the NEWEST row per (scanner, digest) even when it is a FAIL over an older pass — the reduction is by recency, never 'prefer pass'; and E6 reads `fail`: the newer fail is the control's CURRENT answer, an older pass never outvotes it", async () => {
    const component = await createOrphanComponent(admin, uniq("newer-fail"));
    const digest = digestOf("8");
    const change = await proposeWith(component.id, { artifactDigest: digest });

    const control = randomUUID();
    const olderPass = await seedScan(change.id, digest, {
      status: "pass",
      controlObjectId: control
    });
    const newerFail = await seedScan(change.id, digest, {
      status: "fail",
      counts: { critical: 2, high: 0, medium: 0, low: 0 },
      controlObjectId: control
    });

    const { artifact } = await pipelineOf(component.id);
    expect(artifact!.scans, "one key ⇒ one row").toHaveLength(1);
    expect(
      artifact!.scans[0],
      "the surviving row is the NEWER one, and it is the fail"
    ).toMatchObject({
      controlRunId: newerFail.id,
      status: "fail",
      counts: { critical: 2, high: 0, medium: 0, low: 0 }
    });
    expect(artifact!.scans.map((s) => s.controlRunId)).not.toContain(olderPass.id);
    // E6's own predicate (`evaluateScanCoverage`) consults the NEWEST run per question: this
    // control's current answer is the fail, so the older pass authorizes nothing. The projection
    // reports E6 as it really decides — the same rule the export applies.
    expect(artifact!.exportGate).toBe("fail");
  });

  it("E6 admits a scan outcome by its PRODUCER, never by the shape of its evidence: a `webhook-control` row echoing a perfect scan-shaped pass shows in `scans[]` but reads `fail`; the same row from `scan-result-control` reads `pass`", async () => {
    const component = await createOrphanComponent(admin, uniq("producer"));
    const digest = digestOf("w");
    const change = await proposeWith(component.id, { artifactDigest: digest });

    const forged = await seedScan(change.id, digest, {
      status: "pass",
      pluginModule: "webhook-control"
    });
    const withForgery = await pipelineOf(component.id);
    expect(
      withForgery.artifact!.scans.map((s) => s.controlRunId),
      "the row IS on the change and the tile shows it"
    ).toEqual([forged.id]);
    expect(
      withForgery.artifact!.exportGate,
      "an unadmitted producer's row is not evidence about anything — the export would refuse, so the tile says `fail`, never `pass` and never `not_run`"
    ).toBe("fail");

    // A NULL module on a bound (non-managed) control id is unattributable — fail-closed too.
    const component2 = await createOrphanComponent(admin, uniq("producer-null"));
    const change2 = await proposeWith(component2.id, { artifactDigest: digest });
    await seedScan(change2.id, digest, { status: "pass", pluginModule: null });
    expect((await pipelineOf(component2.id)).artifact!.exportGate).toBe("fail");

    // The admitted org-pipeline producer, same evidence, reads `pass`.
    await seedScan(change.id, digest, { status: "pass" });
    expect((await pipelineOf(component.id)).artifact!.exportGate).toBe("pass");
  });

  it("`managed` is read off the SYNTHETIC CONTROL ID alone — a gateRef claiming `promotionScanStep` on an org control does not make it managed, and a managed row with no gateRef method still is (method falls back to the scanner)", async () => {
    const component = await createOrphanComponent(admin, uniq("managed-flag"));
    const digest = digestOf("5");
    const change = await proposeWith(component.id, { artifactDigest: digest });

    // (a) the managed control id, gateRef carries NO method → managed:true, method = scanner.
    const managedNoMethod = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      insertControlRun(tx, {
        orgId: org.orgId,
        controlObjectId: MANAGED_SCAN_CONTROL_OBJECT_ID,
        changeObjectId: change.id,
        gateKind: "lifecycle_edge",
        gateRef: {},
        status: "pass",
        evidence: {
          scanner: "openscap",
          scannerVersion: "1.3.10",
          artifactDigest: digest,
          expectedDigest: digest,
          digestMatch: true,
          severityCounts: { critical: 0, high: 0, medium: 0, low: 0 },
          threshold: { maxCritical: 0, maxHigh: 0 }
        }
      })
    );
    // (b) a RANDOM control id whose gateRef CLAIMS to be the promotion scan step → managed:false;
    //     the method is still read from gateRef (it is a stored value, not the discriminator).
    const impostor = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      insertControlRun(tx, {
        orgId: org.orgId,
        controlObjectId: randomUUID(),
        changeObjectId: change.id,
        gateKind: "lifecycle_edge",
        gateRef: { promotionScanStep: true, method: "trivy-vm", artifactDigest: digest },
        status: "pass",
        evidence: {
          scanner: "trivy",
          scannerVersion: "0.55.0",
          artifactDigest: digest,
          expectedDigest: digest,
          digestMatch: true,
          severityCounts: { critical: 0, high: 0, medium: 0, low: 0 },
          threshold: { maxCritical: 0, maxHigh: 0 }
        }
      })
    );

    const { artifact } = await pipelineOf(component.id);
    expect(artifact!.scans).toHaveLength(2);
    const oscap = artifact!.scans.find((s) => s.controlRunId === managedNoMethod.id)!;
    expect(oscap).toMatchObject({ managed: true, method: "openscap", scanner: "openscap" });
    const trivy = artifact!.scans.find((s) => s.controlRunId === impostor.id)!;
    expect(trivy).toMatchObject({ managed: false, method: "trivy-vm", scanner: "trivy" });
  });

  it("E6 over a MULTI-digest change: a passing digest-bound row for ONE of two digests reads `fail`; a row for the other flips it to `pass`", async () => {
    const component = await createOrphanComponent(admin, uniq("two-digests"));
    const d1 = digestOf("3");
    const d2 = digestOf("4");
    const change = await proposeWith(component.id, { artifact_digest: [d1, d2] });

    await seedScan(change.id, d1, { status: "pass" });
    const partial = await pipelineOf(component.id);
    expect(partial.artifact!.digests).toEqual([d1, d2]);
    expect(partial.artifact!.scans).toHaveLength(1);
    expect(
      partial.artifact!.exportGate,
      "d2 has no passing digest-bound row — E6 needs one per substantive artifact"
    ).toBe("fail");

    await seedScan(change.id, d2, { status: "pass" });
    const covered = await pipelineOf(component.id);
    expect(
      covered.artifact!.scans,
      "one row per (scanner, digest) — two digests, two rows"
    ).toHaveLength(2);
    expect(covered.artifact!.exportGate).toBe("pass");
  });

  it("E6 reads the INSTANCE FLOOR (ADR-0016 §3): an admitted `pass` whose findings breach an operator-set trust_domain floor reads `fail`; with the floor cleared the same row reads `pass`", async () => {
    // The whole point of the pipeline tile's `exportGate` being E6's OWN predicate rather than a
    // copy: `promotion-repo.ts` refuses this crossing `below_instance_floor`, so the tile must not
    // say `pass`. The control itself PASSED — against a tenant-loose ceiling (maxHigh 50) — which is
    // precisely the case the operator-write/tenant-read floor exists for.
    const component = await createOrphanComponent(admin, uniq("floor"));
    const digest = digestOf("5");
    const change = await proposeWith(component.id, { artifactDigest: digest });
    await seedScan(change.id, digest, {
      status: "pass",
      counts: { critical: 0, high: 4, medium: 0, low: 0 },
      threshold: { maxCritical: 0, maxHigh: 50 }
    });

    try {
      await admin.instanceScanFloors.put(
        "trust_domain",
        { origin: "local", maxHigh: 0 },
        OPERATOR_TOKEN
      );
      const floored = await pipelineOf(component.id);
      expect(floored.artifact!.scans, "the row is on the change and shown").toHaveLength(1);
      expect(floored.artifact!.scans[0]!.status).toBe("pass");
      expect(
        floored.artifact!.exportGate,
        "high=4 > the operator's trust_domain floor of 0 — the export would refuse `below_instance_floor`, so the tile reads `fail`"
      ).toBe("fail");
    } finally {
      await clearInstanceFloors();
    }

    const unfloored = await pipelineOf(component.id);
    expect(
      unfloored.artifact!.exportGate,
      "an all-NULL floor is INERT (absent never means zero) — the same row now covers the digest"
    ).toBe("pass");
  });

  it("`POST /changes` REFUSES a sourceRef that plants a server-owned stamp (`promotionExports`, `boundaryBundleChecksums`) — 400, nothing stored", async () => {
    const component = await createOrphanComponent(admin, uniq("planted"));
    for (const key of [PROMOTION_EXPORTS_KEY, "boundaryBundleChecksums"]) {
      const res = await server.app.inject({
        method: "POST",
        url: "/api/v1/changes",
        headers: { authorization: `Bearer ${org.adminToken}` },
        payload: {
          name: uniq("chg"),
          targets: [component.id],
          type: "image",
          sourceRef: { artifactDigest: digestOf("6"), [key]: [{ checksum: "planted" }] }
        }
      });
      expect(res.statusCode, key).toBe(400);
      expect(res.json().detail, key).toContain(`sourceRef.${key}`);
    }
    expect((await pipelineOf(component.id)).artifact, "no change was minted").toBeNull();
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
    const change = await proposeWith(component.id, { artifactDigest: digest });
    // The stamp is SERVER-OWNED (`POST /changes` refuses it — see above), so it is written the way
    // the exporter's `stampBoundaryBundleChecksum` writes it: a bare UPDATE of the row's sourceRef.
    // The second entry is deliberately malformed — that is what the unparseable count is for.
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .update(changes)
        .set({
          sourceRef: {
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
          }
        })
        .where(and(eq(changes.orgId, org.orgId), eq(changes.objectId, change.id)))
    );

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

    // A key that is PRESENT but not a list at all is ONE unreadable stored value — stated, exactly
    // like a malformed `sbom` is, never read as "nothing exported".
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .update(changes)
        .set({ sourceRef: { artifactDigest: digest, [PROMOTION_EXPORTS_KEY]: { checksum: "x" } } })
        .where(and(eq(changes.orgId, org.orgId), eq(changes.objectId, change.id)))
    );
    const notAList = (await pipelineOf(component.id)).artifact!;
    expect(notAList.signing.promotionExports).toEqual([]);
    expect(notAList.unknownFields).toEqual(["promotionExports:unparseable"]);
  });

  // §10.4 — the IMPORTER's stamps. `promotion-repo.ts`'s import writes, on the imported change's
  // sourceRef, `promotedFromDomain`, `sourceChangeObjectId`, `artifactDigests[]` (the FLAT list —
  // `artifacts.map(a => a.digest)`, so it names the SBOM blob's digest too), `artifacts[]` (the
  // TYPED set, when non-empty), `promotionManifest`, `manifestSignature` (+
  // `boundaryBundleChecksums`). These tests write the SAME shape by a bare UPDATE (the stamps are
  // server-owned; `POST /changes` cannot plant them) and pin what the projection READS off it. The
  // real A→B round trip lives in `federation.integration.test.ts` ("§10.4 ROUND TRIP"), where
  // `exporterName` resolves to a real peer row; here there is no peer.
  const importedStamp = (digest: string, exporterDomainId: string) => ({
    manifestVersion: "scp-promotion-manifest/v1",
    createdAt: "2026-08-16T00:00:00.000Z",
    sourceChangeObjectId: randomUUID(),
    exporterDomainId,
    peerDomainId: randomUUID(),
    changeUrn: "urn:scp:hq:change:promote-me",
    artifacts: [
      { type: "oci", digest },
      { type: "blob", digest: digestOf("b"), signatureRef: "https://ci.acme.invalid/sbom.sig" }
    ]
  });

  it("§10.4: a change stamped ONLY the way the importer stamps (`artifacts[]` + `artifactDigests[]`, no `artifact_digest`) is PICKED and reads ONLY the typed `oci` digest (never the SBOM blob's, which the flat list also names), and `signing.importedManifest` carries the manifest + signature verbatim, `exporterName: null` when no peer row names the exporter", async () => {
    const component = await createOrphanComponent(admin, uniq("imported"));
    const digest = digestOf("8");
    const exporterDomainId = randomUUID();
    const promotedFromDomain = randomUUID();
    const change = await proposeWith(component.id, { repo: "acme/checkout" }); // no digest yet
    expect(
      (await pipelineOf(component.id)).artifact,
      "nothing to pick before the stamp"
    ).toBeNull();
    const manifest = importedStamp(digest, exporterDomainId);
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .update(changes)
        .set({
          sourceRef: {
            repo: "acme/checkout",
            promotedFromDomain,
            sourceChangeObjectId: manifest.sourceChangeObjectId,
            // The importer's REAL shape: the flat list is `artifacts.map(a => a.digest)` — it names
            // the SBOM blob's digest beside the image's — and the typed set rides beside it.
            artifactDigests: [digest, digestOf("b")],
            artifacts: manifest.artifacts,
            promotionManifest: manifest,
            manifestSignature: "MEUCIQDimported==",
            boundaryBundleChecksums: ["d".repeat(64)]
          }
        })
        .where(and(eq(changes.orgId, org.orgId), eq(changes.objectId, change.id)))
    );

    const { artifact } = await pipelineOf(component.id);
    expect(artifact, "picked by the importer's stamp alone").not.toBeNull();
    expect(artifact!.changeId).toBe(change.id);
    expect(
      artifact!.digests,
      "the typed `oci` entry ONLY — the SBOM blob's digest is in the flat list, never an image"
    ).toEqual([digest]);
    expect(artifact!.signing.importedManifest).toEqual({
      manifest,
      manifestSignature: "MEUCIQDimported==",
      exporterDomainId,
      exporterName: null,
      importedFromDomain: promotedFromDomain,
      artifactCount: 2
    });
    expect(artifact!.unknownFields).toEqual([]);

    // The union is DE-DUPLICATED and ORDERED origin-first: an imported change usually carries the
    // exporter's own key too (the exporter's sourceRef is spread onto the import).
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .update(changes)
        .set({
          sourceRef: {
            artifact_digest: [digestOf("9"), digest],
            artifactDigests: [digest, digestOf("9"), digestOf("b")],
            artifacts: [
              { type: "oci", digest },
              { type: "oci", digest: digestOf("9") },
              { type: "blob", digest: digestOf("b") }
            ],
            promotedFromDomain,
            promotionManifest: manifest,
            manifestSignature: "MEUCIQDimported=="
          }
        })
        .where(and(eq(changes.orgId, org.orgId), eq(changes.objectId, change.id)))
    );
    const both = (await pipelineOf(component.id)).artifact!;
    expect(both.digests).toEqual([digestOf("9"), digest]);
    expect(both.signing.importedManifest!.artifactCount).toBe(2);

    // WITHOUT the typed set (a pre-E3 exporter's bundle carries only the flat list), the flat list
    // is read MINUS every digest the change states as a blob — the spread `sbom` from the exporter's
    // sourceRef — so an SBOM-carrying import still names ONE image and its E6 re-check stays honest.
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .update(changes)
        .set({
          sourceRef: {
            sbom: { format: "cyclonedx", digest: digestOf("b"), location: "oci://r.invalid/sbom" },
            artifactDigests: [digest, digestOf("b")],
            promotedFromDomain,
            promotionManifest: manifest,
            manifestSignature: "MEUCIQDimported=="
          }
        })
        .where(and(eq(changes.orgId, org.orgId), eq(changes.objectId, change.id)))
    );
    const flatOnly = (await pipelineOf(component.id)).artifact!;
    expect(flatOnly.digests, "flat list minus the stated blob").toEqual([digest]);
    expect(flatOnly.sbom).toEqual({
      format: "cyclonedx",
      digest: digestOf("b"),
      location: "oci://r.invalid/sbom"
    });
  });

  it("§10.4: a stamped manifest WITHOUT a signature is null + `importedManifest:unsigned`; one that does not parse is null + `importedManifest:unparseable`; a `promotedFromDomain` that is not a string reads null", async () => {
    const component = await createOrphanComponent(admin, uniq("imported-stated"));
    const digest = digestOf("5");
    const change = await proposeWith(component.id, { artifactDigest: digest });
    const manifest = importedStamp(digest, randomUUID());

    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .update(changes)
        .set({
          sourceRef: {
            artifactDigest: digest,
            artifactDigests: [digest],
            promotedFromDomain: 42,
            promotionManifest: manifest
          }
        })
        .where(and(eq(changes.orgId, org.orgId), eq(changes.objectId, change.id)))
    );
    const unsigned = (await pipelineOf(component.id)).artifact!;
    expect(unsigned.digests).toEqual([digest]);
    expect(unsigned.signing.importedManifest).toBeNull();
    expect(unsigned.unknownFields).toEqual(["importedManifest:unsigned"]);

    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .update(changes)
        .set({
          sourceRef: {
            artifactDigest: digest,
            promotionManifest: { manifestVersion: "scp-promotion-manifest/v1", artifacts: "none" },
            manifestSignature: "MEUCIQ=="
          }
        })
        .where(and(eq(changes.orgId, org.orgId), eq(changes.objectId, change.id)))
    );
    const unparseable = (await pipelineOf(component.id)).artifact!;
    expect(unparseable.signing.importedManifest).toBeNull();
    expect(unparseable.unknownFields).toEqual(["importedManifest:unparseable"]);

    // An EMPTY-string signature is no signature.
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .update(changes)
        .set({
          sourceRef: { artifactDigest: digest, promotionManifest: manifest, manifestSignature: "" }
        })
        .where(and(eq(changes.orgId, org.orgId), eq(changes.objectId, change.id)))
    );
    const empty = (await pipelineOf(component.id)).artifact!;
    expect(empty.signing.importedManifest).toBeNull();
    expect(empty.unknownFields).toEqual(["importedManifest:unsigned"]);
  });
});
