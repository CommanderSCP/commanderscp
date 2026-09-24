import {
  constants as cryptoConstants,
  generateKeyPairSync,
  privateDecrypt,
  randomUUID
} from "node:crypto";
import { createServer, type Server } from "node:http";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ScpClient } from "@scp/sdk";
import type { TrustDomainId } from "@scp/schemas";
import {
  startArgoCdStandIn,
  type ArgoCdStandIn,
  type StandInApplication
} from "@scp/plugin-testkit";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
  waitUntil,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { changeWaveTargets, objects } from "../db/schema.js";
import { generateEphemeralSshKeypair } from "./ssh-credentials.js";
import * as buildLaneModule from "./build-trigger-parameters.js";
import * as opsLaneModule from "./ops-lane-trigger-parameters.js";
import * as deployLaneModule from "./deploy-lane-trigger-parameters.js";
import { AUTHORED_APPLICATION_PARAMETER } from "./deploy-lane-trigger-parameters.js";

/**
 * M28.5 — THE CROSS-CUTTING PROOF: one estate exercising the build, host-ops and deployment lanes
 * TOGETHER, against the REAL reconcile loop and the REAL plugins, so no lane can be green while it
 * is unreachable in the presence of the others — the M27.9 lesson ("built, never installed")
 * restated as a standing gate rather than a one-off census.
 *
 * (The infrastructure buildout lane, M28.3, slots in once its PR merges — see the note at the
 * bottom of this file. Its absence here is a known, temporary gap, not an oversight.)
 *
 * ONE org, ONE reconcile loop, ONE subprocess plugin host. Three lanes, each driven by a real
 * change proposed through the public API:
 *
 *   LANE 1 (build)  — an `rpm`-Typed component, bound to `scp-build-rpm-v1` on an Argo Workflows
 *                      execution-system, publishing to a package-repo registry.
 *   LANE 2 (ops)    — an infrastructure product, enrolled and pinned, whose host-ops run is
 *                      submitted to `scp-ops-v1` on the SAME Argo Workflows execution-system and
 *                      completed by a real sealed one-time redemption (not stubbed).
 *   LANE 3 (deploy) — a component SCP did not import, deployed via an authored Argo CD Application
 *                      + Rollout whose steps are the release topology's wave plan.
 *
 * Argo itself is not run (it needs a cluster, and each lane's own integration test already proves
 * the wiring against a real counterparty where one exists — `rpm-build-lane.integration.test.ts`'s
 * Docker leg, `ops-argo-run.e2e.integration.test.ts`'s real sshd). What is under test here is
 * coexistence: that all four lanes' seams are wired into the SAME reconcile loop at the SAME time,
 * proved two ways —
 *
 *   (a) each lane's change completes against a loopback stand-in that only reports success once
 *       the lane-specific submission actually reached it, and
 *   (b) a SPY on each lane's exported derivation (`buildLaneTriggerParameters`,
 *       `opsLaneTriggerParameters`, `deployLaneTriggerParameters`) shows it was CALLED by
 *       `reconcile.ts` during this run, and its own returned value is what the executor received —
 *       not merely present in the same file.
 *
 * The standing gate: delete any one lane's `await ...TriggerParameters(...)` call in
 * `reconcile.ts` and that lane's spy assertion goes red immediately — never called, because nothing
 * routes to it — independent of whether the OTHER lanes still work. `packages/source-census`'s
 * `m28-lanes-reachability.test.ts` is the cheap, no-database half of the same property.
 */

const ARGO_NAMESPACE = "scp-argo-workflows";
const RPM_SPEC = "packaging/scp-widget.spec";
const RPM_COMMIT = "c".repeat(40);
const RUNNER_DIGEST = `sha256:${"a".repeat(64)}`;
const REDEEM_URL = "https://commanderscp-api.scp.svc:8443";
const PIN_SOURCE = ["10.42.0.0/16"];
const ARGOCD_AUTHORING = {
  repoURL: "https://gitea.example/platform/gitops.git",
  path: "charts/scp-authored-manifests",
  targetRevision: "carrier-v1",
  project: "scp-authored",
  namespaces: ["shop", "shop-gamma"]
};

interface WorkflowSubmission {
  resourceName: string;
  workflowName: string;
  parameters: Record<string, string>;
}

/** scp-ops-v1 exactly as the chart renders it (mirrors ops-argo-lane.integration.test.ts's fixture
 *  — copied rather than imported so this file's read-back check is its own, independent proof). */
function opsCatalogTemplate(): unknown {
  return {
    metadata: { name: "scp-ops-v1" },
    spec: {
      serviceAccountName: "scp-ops",
      entrypoint: "run",
      activeDeadlineSeconds: 600,
      podMetadata: { labels: { "commanderscp.io/catalog": "ops" } },
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 1000,
        runAsGroup: 1000,
        fsGroup: 1000,
        seccompProfile: { type: "RuntimeDefault" }
      },
      arguments: { parameters: [{ name: "opsRunTokenSealed" }, { name: "opsRunId", value: "" }] },
      templates: [
        {
          name: "run",
          inputs: { parameters: [{ name: "opsRunTokenSealed" }, { name: "opsRunId" }] },
          volumes: [
            { name: "work", emptyDir: {} },
            { name: "tmp", emptyDir: {} },
            { name: "sealing", secret: { secretName: "scp-ops-sealing", defaultMode: 288 } },
            {
              name: "catalog-pubkey",
              secret: { secretName: "scp-ops-catalog-pubkey", defaultMode: 288 }
            }
          ],
          container: {
            image: `registry.example.com/scp/scp-runner-ops:v1@${RUNNER_DIGEST}`,
            command: ["/usr/local/bin/run.sh"],
            securityContext: {
              runAsNonRoot: true,
              runAsUser: 1000,
              runAsGroup: 1000,
              readOnlyRootFilesystem: true,
              allowPrivilegeEscalation: false,
              privileged: false,
              seccompProfile: { type: "RuntimeDefault" },
              capabilities: { drop: ["ALL"] }
            },
            env: [
              { name: "SCP_OPS_API_URL", value: REDEEM_URL },
              {
                name: "SCP_OPS_RUN_TOKEN_SEALED",
                value: "{{inputs.parameters.opsRunTokenSealed}}"
              },
              {
                name: "SCP_OPS_SEALING_KEY_FILE",
                value: "/var/run/scp-ops/sealing/sealing-key.pem"
              },
              { name: "SCP_OPS_CATALOG_VERIFY", value: "required" },
              { name: "SCP_OPS_CATALOG_PUBKEY", value: "/var/run/scp-ops/catalog/cosign.pub" },
              { name: "HOME", value: "/work" }
            ],
            volumeMounts: [
              { name: "work", mountPath: "/work" },
              { name: "tmp", mountPath: "/tmp" },
              { name: "sealing", mountPath: "/var/run/scp-ops/sealing", readOnly: true },
              { name: "catalog-pubkey", mountPath: "/var/run/scp-ops/catalog", readOnly: true }
            ]
          }
        }
      ]
    }
  };
}

/** A loopback Argo Workflows API serving BOTH the build lane (`scp-build-rpm-v1`) and the ops-Argo
 *  lane (`scp-ops-v1`) — one estate, one Argo Workflows execution-system, exactly as production
 *  would route two catalog templates through the same server. Every Workflow reports `Succeeded`
 *  by default EXCEPT an `scp-ops-v1` run, which starts `Running` — a real Workflow cannot finish
 *  before its pod redeems, and the redeem door refuses a change that is no longer executing — until
 *  the test explicitly flips it after redemption completes. */
function startArgoWorkflowsStandIn(): Promise<{
  srv: Server;
  url: string;
  submissions: WorkflowSubmission[];
  phaseOverride: Map<string, string>;
  templateReads: string[];
}> {
  const submissions: WorkflowSubmission[] = [];
  const phaseOverride = new Map<string, string>();
  const templateReads: string[] = [];

  const srv = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      const url = req.url ?? "";

      if (
        req.method === "GET" &&
        url === `/api/v1/workflow-templates/${ARGO_NAMESPACE}/scp-ops-v1`
      ) {
        templateReads.push(url);
        res.end(JSON.stringify(opsCatalogTemplate()));
        return;
      }

      if (req.method === "POST" && url === `/api/v1/workflows/${ARGO_NAMESPACE}/submit`) {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          resourceKind: string;
          resourceName: string;
          submitOptions?: { parameters?: string[] };
        };
        const parameters = Object.fromEntries(
          (body.submitOptions?.parameters ?? []).map((p) => {
            const i = p.indexOf("=");
            return [p.slice(0, i), p.slice(i + 1)];
          })
        );
        const workflowName = `${body.resourceName}-${submissions.length + 1}`;
        submissions.push({ resourceName: body.resourceName, workflowName, parameters });
        res.end(JSON.stringify({ metadata: { name: workflowName, uid: randomUUID() } }));
        return;
      }

      const get = new RegExp(`^/api/v1/workflows/${ARGO_NAMESPACE}/([^/?]+)$`).exec(url);
      if (req.method === "GET" && get) {
        const name = get[1]!;
        const defaultPhase = name.startsWith("scp-ops-v1-") ? "Running" : "Succeeded";
        const phase = phaseOverride.get(name) ?? defaultPhase;
        res.end(
          JSON.stringify({
            metadata: { name, uid: randomUUID() },
            status: { phase, progress: "1/1" }
          })
        );
        return;
      }

      res.end(JSON.stringify({ items: [] }));
    });
  });

  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ srv, url: `http://127.0.0.1:${port}`, submissions, phaseOverride, templateReads });
    });
  });
}

describe("M28.5 — one estate exercises the build, host-ops and deployment lanes together", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;
  let anonymous: ScpClient;
  let argo: Server;
  let argoUrl: string;
  let argoSubmissions: WorkflowSubmission[];
  let argoPhaseOverride: Map<string, string>;
  let argoTemplateReads: string[];
  let argoSystemId: string;
  let argoCd: ArgoCdStandIn;
  let argocdSystemId: string;
  const prevEgressHosts = process.env.SCP_INTERNAL_EGRESS_HOSTS;

  const sealing = generateKeyPairSync("rsa", { modulusLength: 3072 });
  const sealingPublicPem = sealing.publicKey.export({ type: "spki", format: "pem" }).toString();

  function unseal(sealed: string): string {
    return privateDecrypt(
      {
        key: sealing.privateKey,
        padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256"
      },
      Buffer.from(sealed, "base64")
    ).toString("utf8");
  }

  // ---- THE STANDING GATE'S SPIES — installed once, for the whole estate run. Each wraps the real
  // implementation (pass-through) so the estate behaves exactly as production would; they exist to
  // observe, not to fake. Deleting a lane's call in reconcile.ts leaves its spy uncalled. ----------
  const buildLaneResults: Awaited<ReturnType<typeof buildLaneModule.buildLaneTriggerParameters>>[] =
    [];
  const opsLaneResults: Awaited<ReturnType<typeof opsLaneModule.opsLaneTriggerParameters>>[] = [];
  const deployLaneResults: Awaited<
    ReturnType<typeof deployLaneModule.deployLaneTriggerParameters>
  >[] = [];
  const buildLaneOriginal = buildLaneModule.buildLaneTriggerParameters;
  const opsLaneOriginal = opsLaneModule.opsLaneTriggerParameters;
  const deployLaneOriginal = deployLaneModule.deployLaneTriggerParameters;
  const buildLaneSpy = vi
    .spyOn(buildLaneModule, "buildLaneTriggerParameters")
    .mockImplementation(async (...args) => {
      const result = await buildLaneOriginal(...args);
      buildLaneResults.push(result);
      return result;
    });
  const opsLaneSpy = vi
    .spyOn(opsLaneModule, "opsLaneTriggerParameters")
    .mockImplementation(async (...args) => {
      const result = await opsLaneOriginal(...args);
      opsLaneResults.push(result);
      return result;
    });
  const deployLaneSpy = vi
    .spyOn(deployLaneModule, "deployLaneTriggerParameters")
    .mockImplementation(async (...args) => {
      const result = await deployLaneOriginal(...args);
      deployLaneResults.push(result);
      return result;
    });

  // Captured by each lane's own test, read back by the standing-gate test at the end.
  let rpmSubmission: WorkflowSubmission | undefined;
  let opsSubmission: WorkflowSubmission | undefined;
  let deployedApplication: StandInApplication | undefined;
  /** The AUTHORED body for the production placement — pre-sync, exactly what
   *  `deployLaneTriggerParameters` returned, before Argo CD's controller adds `status`. Compared
   *  against the spy's own captured return value in the standing-gate test below. */
  let deployedAuthoredBody: StandInApplication | undefined;

  beforeAll(async () => {
    // ADR-0003's two layers: the operator allowlist (here) AND the system's declared intent
    // (`allowInternalEgress` below). Set before boot so the resolver reads it.
    process.env.SCP_INTERNAL_EGRESS_HOSTS = "127.0.0.1";
    const argoStandIn = await startArgoWorkflowsStandIn();
    argo = argoStandIn.srv;
    argoUrl = argoStandIn.url;
    argoSubmissions = argoStandIn.submissions;
    argoPhaseOverride = argoStandIn.phaseOverride;
    argoTemplateReads = argoStandIn.templateReads;
    argoCd = await startArgoCdStandIn();

    server = await listenTestServer({
      withEventRelay: true,
      withReconcileLoop: true,
      pluginHostOptions: {
        callTimeoutMs: 8_000,
        restartBackoffBaseMs: 50,
        maxRestartBackoffMs: 300
      }
    });
    org = await createTestOrg(server, "m28-5-estate");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    anonymous = new ScpClient({ baseUrl: server.baseUrl });

    // ONE Argo Workflows execution-system serves BOTH the build and ops-Argo lanes — the same way
    // one org's Argo Workflows deployment would host every SCP catalog template it is pinned to.
    const argoSystem = await admin.object("execution-system").create({
      name: `argo-workflows-${randomUUID().slice(0, 8)}`,
      properties: {
        kind: "argo-workflows",
        serverUrl: argoUrl,
        namespace: ARGO_NAMESPACE,
        allowInternalEgress: true
      }
    });
    argoSystemId = argoSystem.id;

    await admin.secrets.put("m28-5-argocd-token", { value: "stand-in-token" });
    const argocdSystem = await admin.object("execution-system").create({
      name: `argocd-${randomUUID().slice(0, 8)}`,
      properties: {
        kind: "argocd",
        serverUrl: argoCd.url,
        tokenSecretKey: "m28-5-argocd-token",
        allowInternalEgress: true,
        authoring: ARGOCD_AUTHORING
      }
    });
    argocdSystemId = argocdSystem.id;
  }, 180_000);

  afterAll(async () => {
    buildLaneSpy.mockRestore();
    opsLaneSpy.mockRestore();
    deployLaneSpy.mockRestore();
    await server?.close();
    await new Promise<void>((ok) => argo?.close(() => ok()));
    await argoCd?.close();
    if (prevEgressHosts === undefined) delete process.env.SCP_INTERNAL_EGRESS_HOSTS;
    else process.env.SCP_INTERNAL_EGRESS_HOSTS = prevEgressHosts;
  });

  async function waveTargetOf(targetId: string) {
    const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(changeWaveTargets)
        .where(
          and(
            eq(changeWaveTargets.orgId, org.orgId),
            eq(changeWaveTargets.targetObjectId, targetId)
          )
        )
    );
    return rows.sort((a, b) => String(a.id).localeCompare(String(b.id))).at(-1);
  }

  it("LANE 1 (build) — an rpm component promotes through Argo Workflows to a package repo", async () => {
    const component = await createTestComponent(admin, { name: `rpm-${randomUUID().slice(0, 8)}` });
    await admin.components.update(component.id, { properties: { rpmSpec: RPM_SPEC } });
    const registry = await admin.object("execution-system").create({
      name: `registry-${randomUUID().slice(0, 8)}`,
      domainLocal: true,
      properties: {
        kind: "gitea",
        serverUrl: "http://gitea.example.invalid:3000",
        packageFormats: ["oci", "rpm"]
      }
    });
    await admin.relationships.create({
      typeId: "publishes_to",
      fromId: component.id,
      toId: registry.id,
      properties: { repository: "acme/el9" }
    });
    await admin.executors.putBinding(component.id, {
      executionSystemId: argoSystemId,
      type: "rpm",
      externalRef: "scp-build-rpm-v1"
    });

    const before = argoSubmissions.length;
    const change = await admin.changes.propose({
      name: `rpm release ${randomUUID().slice(0, 6)}`,
      targets: [component.id],
      type: "rpm",
      sourceRef: { repo: "acme/scp-widget", ref: "refs/heads/main", commit: RPM_COMMIT }
    });

    rpmSubmission = await waitUntil(
      async () =>
        argoSubmissions.slice(before).find((s) => s.parameters["changeObjectId"] === change.id) ??
        undefined,
      { describe: "the argo-workflows plugin submits the rpm build workflow", timeoutMs: 30_000 }
    );
    expect(rpmSubmission.resourceName).toBe("scp-build-rpm-v1");
    expect(rpmSubmission.parameters).toMatchObject({
      sourceRepo: "acme/scp-widget",
      sourceCommit: RPM_COMMIT,
      rpmSpec: RPM_SPEC,
      packageRepository: "acme/el9"
    });
    for (const key of ["imageDestination", "imageRepository", "dockerfile"]) {
      expect(rpmSubmission.parameters).not.toHaveProperty(key);
    }

    await waitUntil(
      async () => ((await waveTargetOf(component.id))?.status === "succeeded" ? true : undefined),
      { describe: "the rpm wave target reaches succeeded", timeoutMs: 30_000 }
    );
  }, 60_000);

  it("LANE 2 (ops) — a host-ops run is submitted to Argo, and a real sealed one-time redemption completes it", async () => {
    const fleet = await createTestComponent(admin, { name: `fleet-${randomUUID().slice(0, 8)}` });
    await admin.infrastructureMembers.report(fleet.id, [
      { memberId: "i-001", address: "10.0.1.1" },
      { memberId: "i-002", address: "10.0.1.2" }
    ]);
    const [row] = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select({ d: objects.originDomainId }).from(objects).where(eq(objects.id, fleet.id))
    );
    const domainId = row!.d as TrustDomainId;
    // ENROLMENT and the PIN, both through the public door — a domain must be enrolled before it can
    // be pinned, and the pin is the only thing that makes an Argo run token deliverable anywhere.
    await admin.sshCa.enrol(domainId, "OOB console on the management VLAN");
    await admin.sshCa.pinArgoOps(domainId, {
      serverUrl: argoUrl,
      namespace: ARGO_NAMESPACE,
      templateRef: "scp-ops-v1",
      sealingPublicKey: sealingPublicPem,
      sourceAddresses: PIN_SOURCE,
      runnerImageDigest: RUNNER_DIGEST,
      redeemUrl: REDEEM_URL
    });
    await admin.executors.putBinding(fleet.id, {
      executionSystemId: argoSystemId,
      type: "configuration",
      externalRef: "scp-ops-v1"
    });

    const before = argoSubmissions.length;
    // The change id is not read again below — completion is asserted target-side (`waveTargetOf`),
    // the same way `rpm-build-lane.integration.test.ts` does.
    await admin.changes.propose({
      name: `ops-${randomUUID().slice(0, 8)}`,
      targets: [fleet.id],
      properties: { ops: { role: "os_package", arguments: { name: "htop", state: "present" } } }
    });

    opsSubmission = await waitUntil(async () => argoSubmissions.slice(before)[0], {
      describe: "the argo-workflows plugin submits the host-ops workflow",
      timeoutMs: 30_000
    });
    expect(opsSubmission.resourceName).toBe("scp-ops-v1");
    // THE EXACT KEY SET — a host, a role or a credential here would be readable by anyone who can
    // list Workflows.
    expect(Object.keys(opsSubmission.parameters).sort()).toEqual(["opsRunId", "opsRunTokenSealed"]);
    expect(
      argoTemplateReads.length,
      "the plugin read the template back before submitting"
    ).toBeGreaterThan(0);

    // THE SEALED, ONE-TIME REDEMPTION — run for real, not stubbed: unseal with the pin's own
    // private key, present a fresh pod key, and get back a certificate over THAT key.
    const token = unseal(opsSubmission.parameters["opsRunTokenSealed"]!);
    const pod = generateEphemeralSshKeypair();
    const redeemed = await anonymous.opsRuns.redeem(token, pod.openSshPublicKey);
    expect(redeemed.certificate.startsWith("ssh-ed25519-cert-v01@openssh.com ")).toBe(true);
    expect(redeemed.roleArguments).toEqual({ name: "htop", state: "present" });

    // Now let the Workflow report done — the redeem door required it in flight; the wave target
    // completing requires Argo to say so.
    argoPhaseOverride.set(opsSubmission.workflowName, "Succeeded");
    await waitUntil(
      async () => ((await waveTargetOf(fleet.id))?.status === "succeeded" ? true : undefined),
      { describe: "the ops wave target reaches succeeded", timeoutMs: 30_000 }
    );
  }, 60_000);

  it("LANE 3 (deploy) — SCP authors an Argo CD Application + Rollout whose steps are the wave plan", async () => {
    const gamma = await admin.deploymentTargets.create({
      name: `gamma-${randomUUID().slice(0, 6)}`,
      properties: { environment: "gamma", namespace: "shop-gamma" }
    });
    const prod = await admin.deploymentTargets.create({
      name: `production-${randomUUID().slice(0, 6)}`,
      properties: { environment: "production", namespace: "shop" }
    });
    const component = await createTestComponent(admin, {
      name: `checkout-${randomUUID().slice(0, 6)}`,
      properties: {
        deployment: { image: "ghcr.io/acme/checkout:1.4.0", containerPort: 8080, replicas: 2 }
      }
    });
    const placementIdOf: Record<string, string> = {};
    for (const target of [gamma, prod]) {
      const placement = await admin.placements.create({
        component: component.id,
        deploymentTarget: target.id
      });
      placementIdOf[target.id] = placement.id;
      await admin.executors.putBinding(placement.id, { executionSystemId: argocdSystemId });
    }
    const topology = await admin.object("release-topology").create({
      name: `topo-${randomUUID().slice(0, 8)}`,
      properties: {
        waves: [
          {
            name: "gamma",
            mode: "parallel",
            targets: [gamma.id],
            rollout: {
              strategy: "canary",
              steps: [{ weightPercent: 50, pauseSeconds: 15 }, { weightPercent: 100 }]
            }
          },
          {
            name: "prod",
            mode: "parallel",
            targets: [prod.id],
            rollout: {
              strategy: "canary",
              steps: [{ weightPercent: 25, pauseSeconds: 30 }, { weightPercent: 100 }]
            }
          }
        ]
      }
    });

    const before = new Set(argoCd.applications.keys());
    const digest = `sha256:${"d".repeat(64)}`;
    const change = await admin.changes.propose({
      name: "release checkout",
      targets: [component.id],
      topology: topology.id,
      sourceRef: { artifact_digest: digest }
    });

    await waitUntil(
      async () => {
        const state = (await admin.changes.get(change.id)).state;
        return ["validating", "accepted"].includes(state) ? state : undefined;
      },
      { describe: "the deploy-lane change settles", timeoutMs: 60_000, intervalMs: 250 }
    );

    const created = [...argoCd.applications.keys()].filter((n) => !before.has(n));
    expect(created).toHaveLength(2);
    deployedApplication = [...argoCd.applications.values()].find(
      (a) => a.metadata.labels?.["commanderscp.io/target"] === placementIdOf[prod.id]
    );
    expect(
      deployedApplication,
      "an Application authored for the production placement"
    ).toBeDefined();
    deployedAuthoredBody = argoCd.authoredBodies.find(
      (b) => b.metadata.labels?.["commanderscp.io/target"] === placementIdOf[prod.id]
    );
    expect(
      deployedAuthoredBody,
      "the authored (pre-sync) body for the production placement"
    ).toBeDefined();
    expect(deployedApplication!.spec?.project).toBe("scp-authored");
    expect(deployedApplication!.spec?.destination).toEqual({
      server: "https://kubernetes.default.svc",
      namespace: "shop"
    });

    const rollout = [...argoCd.cluster.values()].find(
      (m) => m.kind === "Rollout" && (m.metadata as { namespace?: string }).namespace === "shop"
    );
    expect(rollout, "Argo CD's controller applied the authored Rollout").toBeDefined();
    const steps = (rollout!.spec as { strategy?: { canary?: { steps?: unknown[] } } }).strategy
      ?.canary?.steps;
    expect(steps).toEqual([{ setWeight: 25 }, { pause: { duration: "30s" } }, { setWeight: 100 }]);

    // ADR-0008 §3 — no write shape other than the four the stand-in allows ever reached Argo CD;
    // in particular nothing PROMOTED or otherwise DROVE the Rollout's state.
    expect(argoCd.violations).toEqual([]);
  }, 60_000);

  it("STANDING GATE — each lane's derivation was CALLED by reconcile during this run, and its OWN output is what reached the executor (delete any lane's reconcile wiring and this goes red)", () => {
    expect(
      buildLaneSpy,
      "buildLaneTriggerParameters was never called — the build lane's reconcile wiring is missing"
    ).toHaveBeenCalled();
    expect(
      opsLaneSpy,
      "opsLaneTriggerParameters was never called — the ops-Argo lane's reconcile wiring is missing"
    ).toHaveBeenCalled();
    expect(
      deployLaneSpy,
      "deployLaneTriggerParameters was never called — the deploy lane's reconcile wiring is missing"
    ).toHaveBeenCalled();

    // Not merely called — the VALUE each derivation returned is what actually reached the plugin
    // submission this estate captured independently, over loopback, above.
    expect(rpmSubmission, "fixture check: lane 1 must have run first").toBeDefined();
    const buildResultForRpm = buildLaneResults.find((r) => r?.["packageRepository"] === "acme/el9");
    expect(
      buildResultForRpm,
      "buildLaneTriggerParameters never derived the rpm destination this run submitted"
    ).toBeDefined();
    for (const [key, value] of Object.entries(buildResultForRpm!)) {
      expect(rpmSubmission!.parameters[key], `submission carries derived key '${key}'`).toBe(value);
    }

    expect(opsSubmission, "fixture check: lane 2 must have run").toBeDefined();
    const opsResultForRun = opsLaneResults.find(
      (r) => r?.["opsRunId"] === opsSubmission!.parameters["opsRunId"]
    );
    expect(
      opsResultForRun,
      "opsLaneTriggerParameters never derived the material this run's Workflow carried"
    ).toBeDefined();
    expect(opsResultForRun!["opsRunTokenSealed"]).toBe(
      opsSubmission!.parameters["opsRunTokenSealed"]
    );

    expect(deployedAuthoredBody, "fixture check: lane 3 must have run").toBeDefined();
    const deployResultForProd = deployLaneResults.find(
      (r) =>
        (r?.parameters[AUTHORED_APPLICATION_PARAMETER] as StandInApplication | undefined)?.metadata
          .name === deployedAuthoredBody!.metadata.name
    );
    expect(
      deployResultForProd,
      "deployLaneTriggerParameters never authored the production Application this run created"
    ).toBeDefined();
    // EXACT: the derivation's OWN return value is what Argo CD received — not a lookalike computed
    // separately, but the identical object that crossed from reconcile.ts into the plugin submission.
    expect(deployResultForProd!.parameters[AUTHORED_APPLICATION_PARAMETER]).toEqual(
      deployedAuthoredBody
    );
  });

  // ============================================================================================
  // NOT COVERED BY THIS FILE, DELIBERATELY:
  //   * LANE 4 (infrastructure plan -> approve -> apply, M28.3) — its PR (#415) is not yet merged
  //     to main. It slots in here as a fourth `it()` following the same shape (propose against a
  //     `deployment-target` carrying `properties.environment = "prod-us-east-1"`, an approval by a
  //     non-proposer, then apply) plus a fourth spy on `infraLaneTriggerParameters`, once it lands.
  //   * Each lane's OWN edge cases (refusals, recipe overrides, template-tamper detection, replay/
  //     single-use redemption probes, ADR-0008 driving-vs-authoring edge cases) — those are
  //     `rpm-build-lane.integration.test.ts`, `ops-argo-lane.integration.test.ts` and
  //     `argocd-authored-deployment.integration.test.ts`'s job, not this file's.
  //   * A real counterparty for the rpm build or the ops host — `rpm-build-lane.integration.test.ts`
  //     (Docker) and `ops-argo-run.e2e.integration.test.ts` (Docker + a real sshd) already prove
  //     those; running them again here would only slow this file down for no new proof.
  // ============================================================================================
});
