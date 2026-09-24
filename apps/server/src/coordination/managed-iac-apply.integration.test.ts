import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import { resolveRunnerImage } from "@scp/plugin-testkit";
import { mkdtempTrackedForFile } from "@scp/test-tmpdir";
import {
  createTestOrg,
  createTestUser,
  listenTestServer,
  waitUntil,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { decisions } from "../db/schema.js";

/**
 * M28.3b — MODE C APPLY, UNDER THE SAME GATE (ADR-0056 addendum 4).
 *
 * Before this, nothing in production set `iacAction`, so every managed-iac run was a plan and no
 * plan could ever be applied. Now a managed-iac plan is recorded like the Argo lane's, its
 * acceptance is its approval (by someone other than its proposer), and an apply change naming it
 * runs `iacAction: "apply"` with the approved digest — which the plugin checks against the plan in
 * the workspace before it launches anything.
 *
 * THE REAL COUNTERPARTY: the real reconcile loop, the real `@scp/plugin-managed-iac` in the real
 * subprocess plugin host, and each run in the real `scp-runner-iac` container with OpenTofu's local
 * backend. The configuration is `terraform_data` (built into OpenTofu, so no provider download and
 * no network). It is written into the plugin's per-(org, target) workspace directly, which is where
 * managed-iac reads configuration from in production — a campaign recipe cannot target managed-iac.
 */

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNNER_IAC_CONTEXT = resolve(__dirname, "../../../../apps/runner-iac");

const MAIN_TF = (content: string) =>
  [
    'resource "terraform_data" "network" {',
    `  input = "${content}"`,
    "}",
    "",
    'output "network" {',
    "  value = terraform_data.network.output",
    "}",
    ""
  ].join("\n");

async function dockerAvailable(): Promise<boolean> {
  try {
    await execFileAsync("docker", ["info"], { timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}

let dockerReady = false;
/** A visible skip locally, never in CI (the integration job has Docker). */
function requireDocker(ctx: { skip: () => void }): boolean {
  if (dockerReady) return true;
  if (process.env.CI) {
    throw new Error("[managed-iac-apply] CI is set and no Docker daemon is reachable");
  }
  console.warn("[managed-iac-apply] no reachable Docker daemon — the real runner did NOT run");
  ctx.skip();
  return false;
}

describe("M28.3b: managed-iac (Mode C) apply of an accepted plan", { timeout: 300_000 }, () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;
  /** A second subject with `change:accept`: a plan's proposer (admin) may not accept it. */
  let approver: ScpClient;
  let workspaceRoot = "";
  const prevRunnerImage = process.env.SCP_MANAGED_IAC_RUNNER_IMAGE;
  const prevWorkspaceRoot = process.env.SCP_MANAGED_IAC_WORKSPACE_ROOT;

  beforeAll(async () => {
    dockerReady = await dockerAvailable();
    workspaceRoot = await mkdtempTrackedForFile(join(tmpdir(), "scp-managed-iac-apply-"));
    process.env.SCP_MANAGED_IAC_WORKSPACE_ROOT = workspaceRoot;
    process.env.SCP_MANAGED_IAC_RUNNER_IMAGE = dockerReady
      ? await resolveRunnerImage({
          refEnvVar: "SCP_RUNNER_IAC_IMAGE_REF",
          localTag: "scp-runner-iac:m28-3b-integration",
          context: RUNNER_IAC_CONTEXT
        })
      : "scp-runner-iac:absent";
    server = await listenTestServer({
      withEventRelay: true,
      withReconcileLoop: true,
      pluginHostOptions: { callTimeoutMs: 120_000, restartBackoffBaseMs: 50, maxRestartBackoffMs: 300 }
    });
    org = await createTestOrg(server, "m28-3b-managed-iac");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const approverUser = await createTestUser(server, org, [
      { role: "Administrator", scope: org.orgId }
    ]);
    approver = new ScpClient({ baseUrl: server.baseUrl, token: approverUser.token });
  }, 600_000);

  afterAll(async () => {
    await server?.close();
    if (prevRunnerImage === undefined) delete process.env.SCP_MANAGED_IAC_RUNNER_IMAGE;
    else process.env.SCP_MANAGED_IAC_RUNNER_IMAGE = prevRunnerImage;
    if (prevWorkspaceRoot === undefined) delete process.env.SCP_MANAGED_IAC_WORKSPACE_ROOT;
    else process.env.SCP_MANAGED_IAC_WORKSPACE_ROOT = prevWorkspaceRoot;
  });

  /** The plugin's workspace for a target bound with no externalRef (mirrors `workspaceDirFor`). */
  const workspaceOf = (targetId: string) => {
    const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_");
    return join(workspaceRoot, safe(org.orgId), safe(targetId));
  };

  async function managedIacTarget(content: string) {
    const target = await admin.deploymentTargets.create({ name: `miac-${randomUUID().slice(0, 6)}` });
    await admin.executors.putBinding(target.id, {
      pluginModule: "managed-iac",
      pluginInstanceId: `miac-${randomUUID().slice(0, 8)}`,
      config: {},
      type: "infrastructure"
    });
    await mkdir(workspaceOf(target.id), { recursive: true });
    await writeFile(join(workspaceOf(target.id), "main.tf"), MAIN_TF(content), "utf8");
    return target;
  }

  const proposePlan = (targetId: string) =>
    admin.changes.propose({
      name: `plan ${randomUUID().slice(0, 6)}`,
      targets: [targetId],
      type: "infrastructure"
    });
  const proposeApply = (targetId: string, planChangeId: string) =>
    admin.changes.propose({
      name: `apply ${randomUUID().slice(0, 6)}`,
      targets: [targetId],
      type: "infrastructure",
      properties: { infrastructure: { applyPlan: planChangeId } }
    });

  const waveTargetOf = async (changeId: string) =>
    (await admin.changes.explain(changeId)).plan?.waves.flatMap((w) => w.targets)[0];
  const settled = (changeId: string) =>
    waitUntil(
      async () => {
        const t = await waveTargetOf(changeId);
        return t && (t.status.endsWith("_refused") || ["succeeded", "failed"].includes(t.status))
          ? t
          : undefined;
      },
      { describe: `change ${changeId}'s wave target settles`, timeoutMs: 240_000 }
    );
  const waitForState = (changeId: string, state: string) =>
    waitUntil(
      async () => ((await admin.changes.get(changeId)).state === state ? true : undefined),
      { describe: `change ${changeId} reaches '${state}'`, timeoutMs: 60_000 }
    );
  const gatesOf = async (changeId: string) =>
    (
      await withTenantTx(server.deps.db, org.orgId, (tx) =>
        tx.select().from(decisions).where(eq(decisions.subjectId, changeId))
      )
    ).map((d) => (d.inputContext as { gate?: string } | null)?.gate);

  async function stateOf(targetId: string): Promise<string | undefined> {
    try {
      const raw = await readFile(join(workspaceOf(targetId), "terraform.tfstate"), "utf8");
      const state = JSON.parse(raw) as {
        resources?: { instances: { attributes: { input: { value: string } } }[] }[];
      };
      return state.resources?.[0]?.instances[0]?.attributes.input.value;
    } catch {
      return undefined;
    }
  }
  const historyOf = async (targetId: string) =>
    readdir(join(workspaceOf(targetId), "state-history")).catch(() => [] as string[]);

  /** A plan, run for real, accepted by the approver. */
  async function acceptedPlanAt(targetId: string) {
    const plan = await proposePlan(targetId);
    const t = await settled(plan.id);
    expect(t.status, JSON.stringify(t)).toBe("succeeded");
    expect(t.observed?.plan?.ref).toMatch(/^[0-9a-f]{64}$/);
    await waitForState(plan.id, "validating");
    await approver.changes.accept(plan.id, "reviewed the plan");
    return { plan, digest: t.observed!.plan!.ref };
  }

  it("PLAN → ACCEPT → APPLY: the accepted plan is applied for real, and a re-apply is a no-op", async (ctx) => {
    if (!requireDocker(ctx)) return;
    const target = await managedIacTarget("network-v1");
    const { plan, digest } = await acceptedPlanAt(target.id);
    // A plan is recorded like the Argo lane's — which is what the apply is built from.
    expect(await gatesOf(plan.id)).toContain("infra_plan_trigger");
    expect(await stateOf(target.id), "a PLAN applied something").toBeUndefined();

    const apply = await proposeApply(target.id, plan.id);
    const t = await settled(apply.id);
    expect(t.status, JSON.stringify(t)).toBe("succeeded");
    expect(t.observed?.plan?.ref, "the apply reports the plan it applied").toBe(digest);
    expect(await stateOf(target.id), "the accepted plan was not applied").toBe("network-v1");
    expect(await gatesOf(apply.id)).toContain("infra_apply_trigger");
    const history = await historyOf(target.id);

    // RE-APPLY: nothing launched, success recorded with the reason.
    const again = await proposeApply(target.id, plan.id);
    const t2 = await settled(again.id);
    expect(t2.status).toBe("succeeded");
    expect(await gatesOf(again.id)).toContain("infra_apply_noop");
    expect(await historyOf(target.id), "a second apply ran").toEqual(history);
  });

  it("an apply of a plan that is NOT ACCEPTED is refused — nothing launched, a Decision", async (ctx) => {
    if (!requireDocker(ctx)) return;
    const target = await managedIacTarget("network-unapproved");
    const plan = await proposePlan(target.id);
    expect((await settled(plan.id)).status).toBe("succeeded");
    const apply = await proposeApply(target.id, plan.id);
    const t = await settled(apply.id);
    expect(t.status).toBe("infra_apply_refused");
    expect(await gatesOf(apply.id)).toContain("infra_plan_not_approved");
    expect(await stateOf(target.id), "an unapproved plan was applied").toBeUndefined();
  });

  it("SEPARATION OF DUTIES — a managed-iac plan's proposer cannot accept it", async (ctx) => {
    if (!requireDocker(ctx)) return;
    const target = await managedIacTarget("network-sod");
    const plan = await proposePlan(target.id);
    expect((await settled(plan.id)).status).toBe("succeeded");
    await waitForState(plan.id, "validating");
    const err = await admin.changes
      .accept(plan.id, "my own plan")
      .then(() => undefined)
      .catch((e: unknown) => e as { status?: number });
    expect(err?.status, "the proposer accepted their own managed-iac plan").toBe(409);
  });

  it("a SUPERSEDED plan is refused: a newer plan in the same workspace is what the workspace holds", async (ctx) => {
    if (!requireDocker(ctx)) return;
    const target = await managedIacTarget("network-old");
    const { plan } = await acceptedPlanAt(target.id);
    await writeFile(join(workspaceOf(target.id), "main.tf"), MAIN_TF("network-new"), "utf8");
    const newer = await proposePlan(target.id);
    expect((await settled(newer.id)).status).toBe("succeeded");
    const apply = await proposeApply(target.id, plan.id);
    expect((await settled(apply.id)).status).toBe("infra_apply_refused");
    expect(await gatesOf(apply.id)).toContain("infra_plan_superseded");
    expect(await stateOf(target.id)).toBeUndefined();
  });

  it("two targets resolving to ONE workspace: the second target's plan is refused (they would apply each other's)", async () => {
    const shared = `shared-${randomUUID().slice(0, 6)}`;
    const bind = async () => {
      const t = await admin.deploymentTargets.create({ name: `ws-${randomUUID().slice(0, 6)}` });
      await admin.executors.putBinding(t.id, {
        pluginModule: "managed-iac",
        pluginInstanceId: `miac-${randomUUID().slice(0, 8)}`,
        config: {},
        type: "infrastructure",
        externalRef: shared
      });
      return t;
    };
    const first = await bind();
    const second = await bind();
    const p1 = await proposePlan(first.id);
    await settled(p1.id);
    const p2 = await proposePlan(second.id);
    expect((await settled(p2.id)).status).toBe("infra_declaration_refused");
    expect(await gatesOf(p2.id)).toContain("infra_workspace_collision");
  });
});
