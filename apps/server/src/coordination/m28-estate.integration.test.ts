import {
  constants as cryptoConstants,
  createHash,
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
  createTestUser,
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
import * as infraLaneModule from "./infra-lane-trigger-parameters.js";
import { AUTHORED_APPLICATION_PARAMETER } from "./deploy-lane-trigger-parameters.js";

/**
 * M28.5 — THE CROSS-CUTTING PROOF: one estate exercising all four executor lanes TOGETHER, against
 * the REAL reconcile loop and the REAL plugins, so no lane can be green while it is unreachable in
 * the presence of the others — the M27.9 lesson ("built, never installed") restated as a standing
 * gate rather than a one-off census.
 *
 * ONE org, ONE reconcile loop, ONE subprocess plugin host. Four lanes, each driven by a real change
 * proposed through the public API:
 *
 *   LANE 1 (build)  — an `rpm`-Typed component, bound to `scp-build-rpm-v1` on an Argo Workflows
 *                      execution-system, publishing to a package-repo registry. Its source repo is
 *                      both allowlisted on the execution system and declared as the component's own
 *                      `rpm` source mapping (ADR-0053 addendum, R1+R2 — landed alongside M28.3).
 *   LANE 2 (ops)    — an infrastructure product, enrolled and pinned, whose host-ops run is
 *                      submitted to `scp-ops-v1` on the SAME Argo Workflows execution-system and
 *                      completed by a real sealed one-time redemption (not stubbed).
 *   LANE 3 (deploy) — a component SCP did not import, deployed via an authored Argo CD Application
 *                      + Rollout whose steps are the release topology's wave plan.
 *   LANE 4 (infra)  — a `prod-us-east-1` deployment-target, bound to `scp-infra-plan-v1` on the SAME
 *                      Argo Workflows execution-system, whose infrastructure repo is likewise
 *                      allowlisted: a plan is submitted and persisted as evidence, ACCEPTED BY A
 *                      NON-PROPOSER (separation of duties, ADR-0056), and only then applied via
 *                      `scp-infra-apply-v1` bound to that plan's digest.
 *
 * Argo itself is not run (it needs a cluster, and each lane's own integration test already proves
 * the wiring against a real counterparty where one exists — `rpm-build-lane.integration.test.ts`'s
 * Docker leg, `ops-argo-run.e2e.integration.test.ts`'s real sshd, `infra-lane.integration.test.ts`'s
 * real OpenTofu run). What is under test here is coexistence: that all four lanes' seams are wired
 * into the SAME reconcile loop at the SAME time, proved two ways —
 *
 *   (a) each lane's change completes against a loopback stand-in that only reports success once
 *       the lane-specific submission actually reached it, and
 *   (b) a SPY on each lane's exported derivation (`buildLaneTriggerParameters`,
 *       `opsLaneTriggerParameters`, `deployLaneTriggerParameters`, `infraLaneTriggerParameters`)
 *       shows it was CALLED by `reconcile.ts` during this run, and its own returned value is what
 *       the executor received — not merely present in the same file.
 *
 * The standing gate: delete any one lane's `await ...TriggerParameters(...)` call in
 * `reconcile.ts` and that lane's spy assertion goes red immediately — never called, because nothing
 * routes to it — independent of whether the OTHER lanes still work. `packages/source-census`'s
 * `m28-lanes-reachability.test.ts` is the cheap, no-database half of the same property.
 */

const ARGO_NAMESPACE = "scp-argo-workflows";
const RPM_REPO = "acme/scp-widget";
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
const INFRA_ENVIRONMENT = "prod-us-east-1";
const INFRA_REPO = "acme/infra";
const INFRA_COMMIT = "e".repeat(40);
const INFRA_PATH = "infra";
/** The GLOBAL output name each plan-evidence field is exported as (matches
 *  `@scp/plugin-argo-workflows`'s `PLAN_OUTPUT_PARAMETERS` and the shipped script's contract). */
const INFRA_PLAN_OUTPUT = {
  digest: "scpPlanDigest",
  add: "scpPlanAdd",
  change: "scpPlanChange",
  destroy: "scpPlanDestroy"
} as const;

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

/** A loopback Argo Workflows API serving the build lane (`scp-build-rpm-v1`), the ops-Argo lane
 *  (`scp-ops-v1`) AND the infra lane (`scp-infra-plan-v1`/`scp-infra-apply-v1`) — one estate, one
 *  Argo Workflows execution-system, exactly as production would route several catalog templates
 *  through the same server. Every Workflow reports `Succeeded` by default EXCEPT an `scp-ops-v1`
 *  run, which starts `Running` — a real Workflow cannot finish before its pod redeems, and the
 *  redeem door refuses a change that is no longer executing — until the test explicitly flips it
 *  after redemption completes. An infra submission additionally carries GLOBAL OUTPUTS once the
 *  test registers them (`outputsOverride`) — the plan-evidence contract `@scp/plugin-argo-workflows`
 *  reads (`scpPlanDigest`/`scpPlanAdd`/`scpPlanChange`/`scpPlanDestroy`). */
function startArgoWorkflowsStandIn(): Promise<{
  srv: Server;
  url: string;
  submissions: WorkflowSubmission[];
  phaseOverride: Map<string, string>;
  outputsOverride: Map<string, Record<string, string>>;
  templateReads: string[];
}> {
  const submissions: WorkflowSubmission[] = [];
  const phaseOverride = new Map<string, string>();
  const outputsOverride = new Map<string, Record<string, string>>();
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
        const outputs = outputsOverride.get(name);
        res.end(
          JSON.stringify({
            metadata: { name, uid: randomUUID() },
            status: {
              phase,
              progress: "1/1",
              ...(outputs
                ? {
                    outputs: {
                      parameters: Object.entries(outputs).map(([n, value]) => ({ name: n, value }))
                    }
                  }
                : {})
            }
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
      resolve({
        srv,
        url: `http://127.0.0.1:${port}`,
        submissions,
        phaseOverride,
        outputsOverride,
        templateReads
      });
    });
  });
}

describe("M28.5 — one estate exercises the build, host-ops, deployment and infrastructure lanes together", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;
  let anonymous: ScpClient;
  /** A second subject with `change:accept` but no propose on the infra plan — separation of duties
   *  (ADR-0056): the proposer of a plan may not accept it themselves. */
  let approver: ScpClient;
  let argo: Server;
  let argoUrl: string;
  let argoSubmissions: WorkflowSubmission[];
  let argoPhaseOverride: Map<string, string>;
  let argoOutputsOverride: Map<string, Record<string, string>>;
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
  const infraLaneResults: Awaited<ReturnType<typeof infraLaneModule.infraLaneTriggerParameters>>[] =
    [];
  const buildLaneOriginal = buildLaneModule.buildLaneTriggerParameters;
  const opsLaneOriginal = opsLaneModule.opsLaneTriggerParameters;
  const deployLaneOriginal = deployLaneModule.deployLaneTriggerParameters;
  const infraLaneOriginal = infraLaneModule.infraLaneTriggerParameters;
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
  const infraLaneSpy = vi
    .spyOn(infraLaneModule, "infraLaneTriggerParameters")
    .mockImplementation(async (...args) => {
      const result = await infraLaneOriginal(...args);
      infraLaneResults.push(result);
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
  let infraPlanSubmission: WorkflowSubmission | undefined;
  let infraApplySubmission: WorkflowSubmission | undefined;
  let infraPlanDigest: string | undefined;

  beforeAll(async () => {
    // ADR-0003's two layers: the operator allowlist (here) AND the system's declared intent
    // (`allowInternalEgress` below). Set before boot so the resolver reads it.
    process.env.SCP_INTERNAL_EGRESS_HOSTS = "127.0.0.1";
    const argoStandIn = await startArgoWorkflowsStandIn();
    argo = argoStandIn.srv;
    argoUrl = argoStandIn.url;
    argoSubmissions = argoStandIn.submissions;
    argoPhaseOverride = argoStandIn.phaseOverride;
    argoOutputsOverride = argoStandIn.outputsOverride;
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
    const approverUser = await createTestUser(server, org, [
      { role: "Administrator", scope: org.orgId }
    ]);
    approver = new ScpClient({ baseUrl: server.baseUrl, token: approverUser.token });

    // ONE Argo Workflows execution-system serves the build, ops-Argo AND infra lanes — the same
    // way one org's Argo Workflows deployment would host every SCP catalog template it is pinned to.
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
    // THE SYSTEM'S SOURCE ALLOWLIST (owner ruling R1, ADR-0053/ADR-0056): the repos this estate's
    // build and infrastructure may run from with this system's credentials. `secret:write`.
    await admin.executors.putSourceAllowlist(argoSystemId, [RPM_REPO, INFRA_REPO]);

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
    infraLaneSpy.mockRestore();
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

  /** PER-CHANGE, not per-target: the infra lane proposes TWO changes (plan, then apply) against the
   *  SAME deployment-target, so `waveTargetOf`'s "latest row for this target" would be ambiguous
   *  right at the moment the second change's row is still being created. Matches
   *  `infra-lane.integration.test.ts`'s own `waveTargetOf`. */
  async function waveTargetForChange(changeId: string) {
    return (await admin.changes.explain(changeId)).plan?.waves.flatMap((w) => w.targets)[0];
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
    // WHOSE CODE IS BUILT (ADR-0053 addendum, R1+R2): the component declares its rpm source, and
    // the system's allowlist (set in beforeAll) allows that repo to run with its credentials.
    await admin.changeSources.createMapping("github", {
      repoPattern: RPM_REPO,
      component: component.id,
      type: "rpm"
    } as Parameters<typeof admin.changeSources.createMapping>[1]);

    const before = argoSubmissions.length;
    const change = await admin.changes.propose({
      name: `rpm release ${randomUUID().slice(0, 6)}`,
      targets: [component.id],
      type: "rpm",
      sourceRef: { repo: RPM_REPO, ref: "refs/heads/main", commit: RPM_COMMIT }
    });

    rpmSubmission = await waitUntil(
      async () =>
        argoSubmissions.slice(before).find((s) => s.parameters["changeObjectId"] === change.id) ??
        undefined,
      { describe: "the argo-workflows plugin submits the rpm build workflow", timeoutMs: 30_000 }
    );
    expect(rpmSubmission.resourceName).toBe("scp-build-rpm-v1");
    expect(rpmSubmission.parameters).toMatchObject({
      sourceRepo: RPM_REPO,
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

  it("LANE 4 (infra) — prod-us-east-1 plans, is ACCEPTED BY A NON-PROPOSER, and applies through Argo Workflows", async () => {
    const target = await admin.deploymentTargets.create({
      name: `${INFRA_ENVIRONMENT}-${randomUUID().slice(0, 6)}`,
      properties: {
        environment: INFRA_ENVIRONMENT,
        infrastructurePath: INFRA_PATH,
        // Declared ON THE TARGET, never taken from the change — ADR-0056 verification probe C.
        infrastructureRepo: INFRA_REPO
      }
    });
    await admin.executors.putBinding(target.id, {
      executionSystemId: argoSystemId,
      type: "infrastructure",
      externalRef: "scp-infra-plan-v1"
    });

    // PLAN.
    const planBefore = argoSubmissions.length;
    const plan = await admin.changes.propose({
      name: `infra plan ${randomUUID().slice(0, 6)}`,
      targets: [target.id],
      type: "infrastructure",
      sourceRef: { repo: INFRA_REPO, ref: "refs/heads/main", commit: INFRA_COMMIT }
    });

    infraPlanSubmission = await waitUntil(
      async () =>
        argoSubmissions.slice(planBefore).find((s) => s.parameters["changeObjectId"] === plan.id) ??
        undefined,
      { describe: "the argo-workflows plugin submits the infra plan workflow", timeoutMs: 30_000 }
    );
    expect(infraPlanSubmission.resourceName).toBe("scp-infra-plan-v1");
    expect(infraPlanSubmission.parameters).toMatchObject({
      environment: INFRA_ENVIRONMENT,
      infraPath: INFRA_PATH,
      sourceRepo: INFRA_REPO,
      sourceCommit: INFRA_COMMIT,
      changeObjectId: plan.id,
      targetObjectId: target.id
    });
    expect(infraPlanSubmission.parameters).not.toHaveProperty("planDigest");

    // The plan evidence a REAL `scp-infra.sh` run would have written as global outputs — the
    // real-counterparty leg belongs to `infra-lane.integration.test.ts`, not this estate.
    infraPlanDigest = createHash("sha256")
      .update(`m28-5-estate:${infraPlanSubmission.workflowName}`)
      .digest("hex");
    argoOutputsOverride.set(infraPlanSubmission.workflowName, {
      [INFRA_PLAN_OUTPUT.digest]: infraPlanDigest,
      [INFRA_PLAN_OUTPUT.add]: "1",
      [INFRA_PLAN_OUTPUT.change]: "0",
      [INFRA_PLAN_OUTPUT.destroy]: "0"
    });

    const plannedTarget = await waitUntil(
      async () => {
        const t = await waveTargetForChange(plan.id);
        return t?.status === "succeeded" ? t : undefined;
      },
      { describe: "the infra plan wave target reaches succeeded", timeoutMs: 30_000 }
    );
    expect(plannedTarget.observed?.plan).toMatchObject({ add: 1, change: 0, destroy: 0 });
    expect(plannedTarget.observed?.plan?.ref).toBe(infraPlanDigest);
    await waitUntil(
      async () => ((await admin.changes.get(plan.id)).state === "validating" ? true : undefined),
      { describe: "the infra plan change reaches validating", timeoutMs: 30_000 }
    );

    // SEPARATION OF DUTIES (ADR-0056): the plan's own proposer cannot accept it.
    await expect(admin.changes.accept(plan.id, "approving my own plan")).rejects.toMatchObject({
      status: 409
    });
    expect((await admin.changes.get(plan.id)).state).toBe("validating");

    // A NON-PROPOSER accepts it.
    await approver.changes.accept(plan.id, "reviewed the prod-us-east-1 plan");

    // APPLY, bound to the accepted plan's digest.
    const applyBefore = argoSubmissions.length;
    const apply = await admin.changes.propose({
      name: `infra apply ${randomUUID().slice(0, 6)}`,
      targets: [target.id],
      type: "infrastructure",
      properties: { infrastructure: { applyPlan: plan.id } }
    });

    infraApplySubmission = await waitUntil(
      async () =>
        argoSubmissions
          .slice(applyBefore)
          .find((s) => s.parameters["changeObjectId"] === apply.id) ?? undefined,
      { describe: "the argo-workflows plugin submits the infra apply workflow", timeoutMs: 30_000 }
    );
    expect(infraApplySubmission.resourceName).toBe("scp-infra-apply-v1");
    expect(infraApplySubmission.parameters).toMatchObject({
      planDigest: infraPlanDigest,
      planChangeObjectId: plan.id,
      sourceRepo: INFRA_REPO,
      sourceCommit: INFRA_COMMIT,
      environment: INFRA_ENVIRONMENT,
      changeObjectId: apply.id
    });

    argoOutputsOverride.set(infraApplySubmission.workflowName, {
      [INFRA_PLAN_OUTPUT.digest]: infraPlanDigest,
      [INFRA_PLAN_OUTPUT.add]: "0",
      [INFRA_PLAN_OUTPUT.change]: "0",
      [INFRA_PLAN_OUTPUT.destroy]: "0"
    });

    const appliedTarget = await waitUntil(
      async () => {
        const t = await waveTargetForChange(apply.id);
        return t?.status === "succeeded" ? t : undefined;
      },
      { describe: "the infra apply wave target reaches succeeded", timeoutMs: 30_000 }
    );
    expect(appliedTarget.observed?.plan?.ref).toBe(infraPlanDigest);
    await waitUntil(
      async () => ((await admin.changes.get(apply.id)).state === "validating" ? true : undefined),
      { describe: "the infra apply change reaches validating", timeoutMs: 30_000 }
    );
  }, 90_000);

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
    expect(
      infraLaneSpy,
      "infraLaneTriggerParameters was never called — the infra lane's reconcile wiring is missing"
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

    // Infra: the derivation's OWN output for the APPLY carries the same plan digest the loopback
    // stand-in reported as evidence — the bound an approved plan is bound to.
    expect(infraPlanSubmission, "fixture check: lane 4's plan must have run").toBeDefined();
    expect(infraApplySubmission, "fixture check: lane 4's apply must have run").toBeDefined();
    const infraApplyResult = infraLaneResults.find(
      (r) =>
        r?.kind === "trigger" &&
        r.phase === "apply" &&
        r.parameters["changeObjectId"] === infraApplySubmission!.parameters["changeObjectId"]
    );
    expect(
      infraApplyResult,
      "infraLaneTriggerParameters never derived this run's apply trigger"
    ).toBeDefined();
    expect(infraApplyResult!.kind).toBe("trigger");
    if (infraApplyResult!.kind === "trigger") {
      for (const [key, value] of Object.entries(infraApplyResult!.parameters)) {
        expect(
          infraApplySubmission!.parameters[key],
          `submission carries derived infra key '${key}'`
        ).toBe(value);
      }
      expect(infraApplyResult!.parameters["planDigest"]).toBe(infraPlanDigest);
    }
  });

  // ============================================================================================
  // NOT COVERED BY THIS FILE, DELIBERATELY:
  //   * Each lane's OWN edge cases (refusals, recipe overrides, template-tamper detection, replay/
  //     single-use redemption probes, ADR-0008 driving-vs-authoring edge cases, plan supersession,
  //     re-apply no-op, source-allowlist mismatches) — those are `rpm-build-lane.integration.test.ts`,
  //     `ops-argo-lane.integration.test.ts`, `argocd-authored-deployment.integration.test.ts` and
  //     `infra-lane.integration.test.ts`'s job, not this file's.
  //   * A real counterparty for the rpm build, the ops host, or the OpenTofu plan/apply —
  //     `rpm-build-lane.integration.test.ts` (Docker), `ops-argo-run.e2e.integration.test.ts`
  //     (Docker + a real sshd) and `infra-lane.integration.test.ts` (Docker + a real OpenTofu run)
  //     already prove those; running them again here would only slow this file down for no new proof.
  //   * Concurrent (as opposed to sequential) multi-lane reconcile ticks — the four lanes here run
  //     one `it()` at a time against a shared reconcile loop, which proves coexistence (no lane's
  //     wiring is torn down for another to run) but not simultaneity within one tick.
  // ============================================================================================
});
