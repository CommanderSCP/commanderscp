import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { and, eq } from "drizzle-orm";
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
import { auditEvents, changeWaveTargets, decisions } from "../db/schema.js";
import { INFRA_LANE_RESERVED_PARAMETERS } from "./infra-lane-trigger-parameters.js";

/**
 * M28.3 — INFRASTRUCTURE BUILDOUT FOR AN ENVIRONMENT, plan → approve → apply, through Argo Workflows.
 *
 * Driven the way production drives it: changes are proposed, the REAL reconcile loop plans and
 * triggers them, `infraLaneTriggerParameters` derives the parameters and decides whether an apply
 * may be triggered at all, and the REAL `argo-workflows` plugin in the real subprocess plugin host
 * submits the shipped WorkflowTemplates to an Argo Workflows API and reads the plan back out of the
 * workflow's global outputs. That API is a loopback stand-in (Argo needs a cluster), and it is the
 * only stand-in: when Docker is available, each submitted workflow is EXECUTED by running the
 * shipped `deploy/helm-bundled/files/scp-infra.sh` in the pinned `scp-runner-iac` image, with the
 * exact parameters the plugin submitted, against a real local-backend state — and the digest and
 * tally the stand-in reports back are the ones that script wrote. So the plan an approver accepts is
 * a real OpenTofu plan, and the apply that follows is bound to its real digest.
 *
 * The DoD, one test each: the plan is persisted and rendered as evidence (API); an apply cannot run
 * without an approved plan, nor after that plan was superseded; a re-apply of an applied plan is a
 * no-op; a recipe cannot restate the lane's bounds; the shipped apply template cannot be reached
 * outside the lane; and the real counterparty's re-plan after apply shows no changes.
 *
 * WIRING-DELETION MUTATIONS (recorded in the M28.3 PR): deleting the `infraLaneTriggerParameters`
 * call in reconcile.ts, the `accepted` check, the supersession check, the applied-already check, or
 * the plugin's output read each turns a test here red for its own reason.
 */

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../../..");
const RUNNER_IAC_CONTEXT = resolve(REPO_ROOT, "apps/runner-iac");
const SCRIPT = resolve(REPO_ROOT, "deploy/helm-bundled/files/scp-infra.sh");
const CATALOG_TEMPLATE = resolve(
  REPO_ROOT,
  "deploy/helm-bundled/templates/argo-workflows-catalog.yaml"
);
const NAMESPACE = "scp-argo-workflows";
const ENVIRONMENT = "prod-us-east-1";
const REPO = "acme/infra";
const FAKE_COMMIT = "c".repeat(40);
/** One environment's network: `terraform_data` is built into OpenTofu, so the plan is real and
 *  needs no provider download (the run has no network at all). */
const NETWORK_TF = [
  'variable "environment" {',
  "  type = string",
  "}",
  "",
  'resource "terraform_data" "network" {',
  '  input = "network-${var.environment}"',
  "}",
  "",
  'output "network" {',
  "  value = terraform_data.network.output",
  "}",
  ""
].join("\n");

/** The output FILE each template writes → the GLOBAL output name it is exported as (the template's
 *  `outputs.parameters`, held to this by tools/helm-verify). */
const GLOBAL_OUTPUT_OF_FILE: Record<string, string> = {
  planDigest: "scpPlanDigest",
  planAdd: "scpPlanAdd",
  planChange: "scpPlanChange",
  planDestroy: "scpPlanDestroy",
  applied: "scpPlanApplied"
};

interface Submission {
  resourceName: string;
  name: string;
  parameters: Record<string, string>;
}

interface Completion {
  phase: "Succeeded" | "Failed";
  outputs: Record<string, string>;
}

/** The parameter names one phase's template declares, read from the template SOURCE — Argo refuses
 *  a submission naming an undeclared parameter, so a key the lane sends that is not declared is a
 *  trigger that fails at submit in production and passes every unit test. The two templates are one
 *  `range` over the phases, with the apply-only parameters inside `if eq $phase "apply"`. */
async function declaredParameters(phase: "plan" | "apply"): Promise<string[]> {
  const text = await readFile(CATALOG_TEMPLATE, "utf8");
  const start = text.indexOf("  name: scp-infra-{{ $phase }}-v1");
  expect(start, "the infra templates are not in the catalog").toBeGreaterThan(-1);
  const args = text.indexOf("  arguments:\n    parameters:\n", start);
  const end = text.indexOf("\n  templates:\n", args);
  const names: string[] = [];
  let applyOnly = false;
  for (const line of text.slice(args, end).split("\n")) {
    if (line.includes(`{{- if eq $phase "apply" }}`)) applyOnly = true;
    else if (line.includes("{{- end }}")) applyOnly = false;
    const m = /^ {6}- name: (\S+)$/.exec(line);
    if (m && (!applyOnly || phase === "apply")) names.push(m[1]!);
  }
  expect(names.length).toBeGreaterThan(5);
  return names;
}

let dockerReady = false;
async function dockerAvailable(): Promise<boolean> {
  try {
    await execFileAsync("docker", ["info"], { timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}
/** A VISIBLE skip — `it.runIf` reports skipped with exit 0 before `beforeAll` decides anything.
 *  And NEVER a skip in CI: the integration job has Docker, so a missing daemon there is a broken
 *  job, and a green "skip" would be the real-counterparty proof quietly not running. */
function expectSkipped(): void {
  if (process.env.CI) {
    throw new Error(
      "[infra-lane] CI is set and no Docker daemon is reachable — the real OpenTofu counterparty " +
        "MUST run in CI; this is a broken job, not a skip"
    );
  }
  console.warn(
    "[infra-lane] no reachable Docker daemon — the real OpenTofu counterparty did NOT run"
  );
  expect(dockerReady).toBe(false);
}

describe(
  "M28.3: infrastructure buildout for prod-us-east-1 — plan → approve → apply through Argo Workflows",
  { timeout: 240_000 },
  () => {
    let server: ListeningTestServer;
    let org: TestOrg;
    let admin: ScpClient;
    /** A second subject with `change:accept`: a plan's proposer (admin) may not accept it. */
    let approver: ScpClient;
    let argo: Server;
    let argoSystemId: string;
    const submissions: Submission[] = [];
    const completions = new Map<string, Completion>();
    const prevEgressHosts = process.env.SCP_INTERNAL_EGRESS_HOSTS;

    let runnerImage = "";
    let workDir = "";
    let commit = FAKE_COMMIT;
    /** Every real script run, for the report and the last test. */
    const realRuns: {
      phase: string;
      rc: number;
      stdout: string;
      outputs: Record<string, string>;
    }[] = [];

    function startArgo(): Promise<{ srv: Server; url: string }> {
      const srv = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          res.setHeader("content-type", "application/json");
          const url = req.url ?? "";
          if (req.method === "POST" && url === `/api/v1/workflows/${NAMESPACE}/submit`) {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
              resourceName: string;
              submitOptions?: { parameters?: string[] };
            };
            const parameters = Object.fromEntries(
              (body.submitOptions?.parameters ?? []).map((p) => {
                const i = p.indexOf("=");
                return [p.slice(0, i), p.slice(i + 1)];
              })
            );
            const name = `${body.resourceName}-${submissions.length + 1}`;
            submissions.push({ resourceName: body.resourceName, name, parameters });
            res.end(JSON.stringify({ metadata: { name, uid: randomUUID() } }));
            return;
          }
          const get = new RegExp(`^/api/v1/workflows/${NAMESPACE}/([^/?]+)$`).exec(url);
          if (req.method === "GET" && get) {
            const done = completions.get(get[1]!);
            res.end(
              JSON.stringify({
                metadata: { name: get[1], uid: "uid" },
                status: done
                  ? {
                      phase: done.phase,
                      progress: "1/1",
                      outputs: {
                        parameters: Object.entries(done.outputs).map(([file, value]) => ({
                          name: GLOBAL_OUTPUT_OF_FILE[file] ?? file,
                          value
                        }))
                      }
                    }
                  : { phase: "Running", progress: "0/1" }
              })
            );
            return;
          }
          res.end(JSON.stringify({ items: [] }));
        });
      });
      return new Promise((ok) => {
        srv.listen(0, "127.0.0.1", () => {
          const addr = srv.address();
          const port = typeof addr === "object" && addr ? addr.port : 0;
          ok({ srv, url: `http://127.0.0.1:${port}` });
        });
      });
    }

    /** RUN THE SHIPPED SCRIPT in the pinned image, as the template runs it: the same positional
     *  arguments in the same order (tools/helm-verify holds the template's `args` to this), and the
     *  same posture — non-root, read-only root, every capability dropped, no_new_privs, no network. */
    async function runScript(
      phase: "plan" | "apply",
      p: Record<string, string>
    ): Promise<{ rc: number; stdout: string; outputs: Record<string, string> }> {
      const out = await mkdtempTrackedForFile(join(tmpdir(), "scp-infra-out-"));
      const uid = `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
      const args = [
        phase,
        p["environment"]!,
        p["stateWorkspace"]!,
        p["sourceRepo"]!,
        p["sourceCommit"]!,
        p["infraPath"]!,
        ...(phase === "apply" ? [p["planDigest"]!] : [])
      ];
      let rc = 0;
      let stdout = "";
      try {
        const r = await execFileAsync(
          "docker",
          [
            "run",
            "--rm",
            "--network",
            "none",
            "--read-only",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "--user",
            uid,
            "--tmpfs",
            `/work:rw,exec,uid=${uid.split(":")[0]},gid=${uid.split(":")[1]}`,
            "-v",
            `${workDir}/repos:/repos:ro`,
            "-v",
            `${workDir}/state:/state`,
            "-v",
            `${out}:/out`,
            "-v",
            `${SCRIPT}:/scp/scp-infra.sh:ro`,
            "-v",
            `${workDir}/backend.tfbackend:/scp/backend.tfbackend:ro`,
            "-e",
            "HOME=/work/home",
            "-e",
            "SCP_WORK_DIR=/work",
            "-e",
            "SCP_OUTPUT_DIR=/out",
            "-e",
            "SCP_SOURCE_BASE_URL=file:///repos",
            "-e",
            "SCP_STATE_BACKEND_TYPE=local",
            "-e",
            "SCP_BACKEND_CONFIG_FILE=/scp/backend.tfbackend",
            "-e",
            "TF_IN_AUTOMATION=1",
            "--entrypoint",
            "bash",
            runnerImage,
            "/scp/scp-infra.sh",
            ...args
          ],
          { timeout: 240_000, maxBuffer: 16 * 1024 * 1024 }
        );
        stdout = r.stdout + r.stderr;
      } catch (err) {
        const e = err as { code?: number; stdout?: string; stderr?: string };
        rc = typeof e.code === "number" ? e.code : 1;
        stdout = `${e.stdout ?? ""}${e.stderr ?? ""}`;
      }
      const outputs: Record<string, string> = {};
      for (const file of Object.keys(GLOBAL_OUTPUT_OF_FILE)) {
        const value = await readFile(join(out, file), "utf8").catch(() => undefined);
        if (value !== undefined) outputs[file] = value;
      }
      realRuns.push({ phase, rc, stdout, outputs });
      return { rc, stdout, outputs };
    }

    /** What the stand-in reports for a submitted workflow: the real script's outputs when Docker is
     *  here, else a synthetic plan whose digest is a function of what was planned. */
    async function execute(sub: Submission): Promise<Completion> {
      const phase = sub.resourceName === "scp-infra-apply-v1" ? "apply" : "plan";
      if (dockerReady) {
        const run = await runScript(phase, sub.parameters);
        return { phase: run.rc === 0 ? "Succeeded" : "Failed", outputs: run.outputs };
      }
      const digest =
        phase === "apply"
          ? sub.parameters["planDigest"]!
          : createHash("sha256")
              .update(`${sub.parameters["sourceCommit"]}:${sub.parameters["stateWorkspace"]}`)
              .digest("hex");
      return {
        phase: "Succeeded",
        outputs: {
          planDigest: digest,
          planAdd: "1",
          planChange: "0",
          planDestroy: "0",
          applied: phase === "apply" ? "true" : "false"
        }
      };
    }

    beforeAll(async () => {
      process.env.SCP_INTERNAL_EGRESS_HOSTS = "127.0.0.1";
      const started = await startArgo();
      argo = started.srv;
      server = await listenTestServer({
        withEventRelay: true,
        withReconcileLoop: true,
        pluginHostOptions: {
          callTimeoutMs: 8_000,
          restartBackoffBaseMs: 50,
          maxRestartBackoffMs: 300
        }
      });
      org = await createTestOrg(server, "m28-3-infra");
      admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
      const approverUser = await createTestUser(server, org, [
        { role: "Administrator", scope: org.orgId }
      ]);
      approver = new ScpClient({ baseUrl: server.baseUrl, token: approverUser.token });
      const system = await admin.object("execution-system").create({
        name: `argo-workflows-${randomUUID().slice(0, 8)}`,
        properties: {
          kind: "argo-workflows",
          serverUrl: started.url,
          namespace: NAMESPACE,
          allowInternalEgress: true
        }
      });
      argoSystemId = system.id;

      dockerReady = await dockerAvailable();
      if (!dockerReady) return;
      runnerImage = await resolveRunnerImage({
        refEnvVar: "SCP_RUNNER_IAC_IMAGE_REF",
        localTag: "scp-runner-iac:m28-3-integration",
        context: RUNNER_IAC_CONTEXT
      });
      // THE ORG'S INFRASTRUCTURE REPO: one environment's configuration under infra/, committed and
      // served as a bare repo the script fetches BY COMMIT. `terraform_data` is built into OpenTofu,
      // so the plan is real and needs no provider download (the run has no network at all).
      workDir = await mkdtempTrackedForFile(join(tmpdir(), "scp-infra-lane-"));
      await mkdir(join(workDir, "repos/acme"), { recursive: true });
      await mkdir(join(workDir, "state"), { recursive: true });
      await writeFile(
        join(workDir, "backend.tfbackend"),
        'path = "/state/terraform.tfstate"\nworkspace_dir = "/state/workspaces"\n'
      );
      commit = await seedRepo("acme/infra", { "infra/main.tf": NETWORK_TF });
    }, 600_000);

    /** One bare repo under repos/, committed from `files`, served to the script as file:///repos. */
    async function seedRepo(name: string, files: Record<string, string>): Promise<string> {
      const seed = await mkdtempTrackedForFile(join(tmpdir(), "scp-infra-seed-"));
      for (const [path, content] of Object.entries(files)) {
        await mkdir(dirname(join(seed, path)), { recursive: true });
        await writeFile(join(seed, path), content);
      }
      const uid = `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
      const seeded = await execFileAsync(
        "docker",
        [
          "run",
          "--rm",
          "--network",
          "none",
          "--user",
          uid,
          "-e",
          "HOME=/tmp",
          "-v",
          `${seed}:/seed`,
          "-v",
          `${workDir}/repos:/repos`,
          "--entrypoint",
          "bash",
          runnerImage,
          "-c",
          [
            "set -eu",
            "cd /seed",
            "git init -q -b main .",
            "git -c user.email=scp@example.invalid -c user.name=scp add -A",
            "git -c user.email=scp@example.invalid -c user.name=scp commit -q -m seed",
            `git clone -q --bare /seed /repos/${name}.git`,
            "git rev-parse HEAD"
          ].join("\n")
        ],
        { timeout: 120_000 }
      );
      const head = seeded.stdout.trim();
      expect(head).toMatch(/^[0-9a-f]{40}$/);
      return head;
    }

    afterAll(async () => {
      await server?.close();
      await new Promise<void>((ok) => argo?.close(() => ok()));
      if (prevEgressHosts === undefined) delete process.env.SCP_INTERNAL_EGRESS_HOSTS;
      else process.env.SCP_INTERNAL_EGRESS_HOSTS = prevEgressHosts;
    });

    /** A deployment-target for one environment, its `infrastructure` pipeline bound to the shipped
     *  plan template on the Argo system. */
    async function environmentTarget(
      properties: Record<string, unknown> = {
        environment: ENVIRONMENT,
        infrastructurePath: "infra"
      },
      externalRef = "scp-infra-plan-v1",
      type: "infrastructure" | "configuration" = "infrastructure"
    ) {
      const target = await admin.deploymentTargets.create({
        name: `${String(properties["environment"] ?? "no-env")}-${randomUUID().slice(0, 6)}`,
        // The repo this environment's infrastructure lives in — declared ON THE TARGET, never taken
        // from the change (verification probe C). `null` in `properties` means "declare none".
        properties: Object.fromEntries(
          Object.entries({ infrastructureRepo: REPO, ...properties }).filter(([, v]) => v !== null)
        )
      });
      await admin.executors.putBinding(target.id, {
        executionSystemId: argoSystemId,
        type,
        externalRef
      });
      return target;
    }

    const proposePlan = (targetId: string, sourceCommit = commit) =>
      admin.changes.propose({
        name: `plan ${randomUUID().slice(0, 6)}`,
        targets: [targetId],
        type: "infrastructure",
        sourceRef: { repo: REPO, ref: "refs/heads/main", commit: sourceCommit }
      });

    const proposeApply = (
      targetId: string,
      planChangeId: string,
      extra: Record<string, unknown> = {}
    ) =>
      admin.changes.propose({
        name: `apply ${randomUUID().slice(0, 6)}`,
        targets: [targetId],
        type: "infrastructure",
        properties: { infrastructure: { applyPlan: planChangeId }, ...extra }
      });

    const submissionFor = (changeId: string) =>
      waitUntil(async () => submissions.find((s) => s.parameters["changeObjectId"] === changeId), {
        describe: `a workflow is submitted for change ${changeId}`,
        timeoutMs: 30_000
      });

    const waveTargetOf = async (changeId: string) =>
      (await admin.changes.explain(changeId)).plan?.waves.flatMap((w) => w.targets)[0];

    const waitForTarget = (changeId: string, status: string) =>
      waitUntil(
        async () => {
          const t = await waveTargetOf(changeId);
          return t?.status === status ? t : undefined;
        },
        { describe: `change ${changeId}'s wave target reaches '${status}'`, timeoutMs: 60_000 }
      );

    /** For a target that must NOT reach its executor (a refusal) or must succeed WITHOUT it (a
     *  no-op): wait until it SETTLES — its verdict, or a trigger — and then assert. A broken gate
     *  then fails as "the template was submitted", not as a timeout that says nothing about why. */
    const settle = async (changeId: string, expected: string) => {
      const t = await settled(changeId, expected);
      expect(
        submissions.filter((s) => s.parameters["changeObjectId"] === changeId),
        "a workflow was SUBMITTED for this change — the gate did not hold"
      ).toEqual([]);
      expect(t.status).toBe(expected);
      return t;
    };
    const settled = (changeId: string, expected: string) =>
      waitUntil(
        async () => {
          const t = await waveTargetOf(changeId);
          return t &&
            (t.status === expected ||
              t.status.endsWith("_refused") ||
              ["triggered", "observing", "succeeded", "failed"].includes(t.status))
            ? t
            : undefined;
        },
        { describe: `change ${changeId}'s wave target settles`, timeoutMs: 60_000 }
      );

    const waitForState = (changeId: string, state: string) =>
      waitUntil(
        async () => ((await admin.changes.get(changeId)).state === state ? true : undefined),
        {
          describe: `change ${changeId} reaches '${state}'`,
          timeoutMs: 60_000
        }
      );

    /** Submit → execute → report: one workflow's whole life at the stand-in. */
    async function runSubmittedWorkflow(changeId: string): Promise<Submission> {
      const sub = await submissionFor(changeId);
      const completion = await execute(sub);
      // Loud, here, with the script's own words — a failed run otherwise surfaces as a wait timing out.
      expect(completion.phase, dockerReady ? realRuns.at(-1)?.stdout : "synthetic").toBe(
        "Succeeded"
      );
      completions.set(sub.name, completion);
      return sub;
    }

    async function decisionsOf(changeId: string) {
      return withTenantTx(server.deps.db, org.orgId, (tx) =>
        tx.select().from(decisions).where(eq(decisions.subjectId, changeId))
      );
    }

    async function auditOf(changeId: string) {
      return withTenantTx(server.deps.db, org.orgId, (tx) =>
        tx.select().from(auditEvents).where(eq(auditEvents.subjectId, changeId))
      );
    }

    const byGate = (rows: Awaited<ReturnType<typeof decisionsOf>>, gate: string) =>
      rows.find((d) => (d.inputContext as { gate?: string } | null)?.gate === gate);

    /** A plan, run to acceptance. Returns the change and the digest its evidence carries. */
    async function acceptedPlanAt(targetId: string) {
      const plan = await proposePlan(targetId);
      await runSubmittedWorkflow(plan.id);
      const t = await waitForTarget(plan.id, "succeeded");
      await waitForState(plan.id, "validating");
      await approver.changes.accept(plan.id, "reviewed the plan");
      return { plan, digest: t.observed!.plan!.ref! };
    }

    let prodTargetId = "";
    let approved: { planChangeId: string; digest: string } | undefined;
    let applySubmission: Submission | undefined;

    it("PLAN: submits scp-infra-plan-v1 for prod-us-east-1, and the plan comes back as persisted, rendered evidence", async () => {
      const target = await environmentTarget();
      prodTargetId = target.id;
      const plan = await proposePlan(target.id);

      const sub = await runSubmittedWorkflow(plan.id);
      expect(sub.resourceName).toBe("scp-infra-plan-v1");
      expect(sub.parameters).toMatchObject({
        environment: ENVIRONMENT,
        // One state per TARGET, carrying the org and the target (item 10): never shared between two
        // regions of an environment, nor two orgs' `prod`.
        stateWorkspace: `${ENVIRONMENT}--o${org.orgId}--t${target.id}`,
        infraPath: "infra",
        sourceRepo: REPO,
        sourceCommit: commit,
        sourceRef: "refs/heads/main",
        changeObjectId: plan.id,
        targetObjectId: target.id
      });
      expect(sub.parameters).not.toHaveProperty("planDigest");
      const declared = await declaredParameters("plan");
      for (const key of Object.keys(sub.parameters)) {
        expect(declared, `SCP sent '${key}', which scp-infra-plan-v1 does not declare`).toContain(
          key
        );
      }

      // THE EVIDENCE, read back through the public API — the same read the plan chip renders.
      const t = await waitForTarget(plan.id, "succeeded");
      expect(t.category).toBe("infrastructure");
      expect(t.observed?.plan).toMatchObject({ add: 1, change: 0, destroy: 0 });
      expect(t.observed?.plan?.ref).toMatch(/^[0-9a-f]{64}$/);
      await waitForState(plan.id, "validating");
      approved = { planChangeId: plan.id, digest: t.observed!.plan!.ref! };
    });

    it("APPLY IS REFUSED before the plan is approved — never submitted, Decision + audit", async () => {
      expect(approved, "the plan test ran").toBeDefined();
      const apply = await proposeApply(prodTargetId, approved!.planChangeId);
      const t = await settle(apply.id, "infra_apply_refused");
      expect(t.executorRef ?? null).toBeNull();
      expect(submissions.filter((s) => s.parameters["changeObjectId"] === apply.id)).toEqual([]);

      const refusal = byGate(await decisionsOf(apply.id), "infra_plan_not_approved");
      expect(refusal, "a Decision records WHY, with its inputs").toBeDefined();
      expect(refusal!.verdict).toBe("block");
      expect(refusal!.inputContext).toMatchObject({
        planChangeObjectId: approved!.planChangeId,
        planChangeState: "validating"
      });
      expect(
        (await auditOf(apply.id)).find((a) => a.action === "change.wave_target.infra_apply_refused")
          ?.decisionId
      ).toBe(refusal!.id);
    });

    it("SEPARATION OF DUTIES — the plan's proposer cannot accept (approve) it; someone else can", async () => {
      const refused = await admin.changes
        .accept(approved!.planChangeId, "approving my own plan")
        .then(() => undefined)
        .catch((err: unknown) => err as { status?: number; problem?: Record<string, unknown> });
      expect(refused, "the proposer's accept was NOT refused").toBeDefined();
      expect(refused!.status).toBe(409);
      expect((await admin.changes.get(approved!.planChangeId)).state).toBe("validating");
      // The transition's Decision carries the gate's verdict under `gate` (transition.ts).
      const block = (await decisionsOf(approved!.planChangeId)).find(
        (d) =>
          (d.inputContext as { gate?: { gate?: string } } | null)?.gate?.gate ===
          "infra_plan_separation_of_duties"
      );
      expect(block?.verdict).toBe("block");
      expect(refused!.problem?.["decisionId"] ?? block!.id).toBe(block!.id);
    });

    it("APPLY of the ACCEPTED plan submits scp-infra-apply-v1 bound to that plan's digest and source", async () => {
      await approver.changes.accept(approved!.planChangeId, "reviewed the plan");
      const apply = await proposeApply(prodTargetId, approved!.planChangeId);
      applySubmission = await runSubmittedWorkflow(apply.id);
      expect(applySubmission.resourceName).toBe("scp-infra-apply-v1");
      expect(applySubmission.parameters).toMatchObject({
        planDigest: approved!.digest,
        planChangeObjectId: approved!.planChangeId,
        // The PLAN's source, not this change's (it has none): apply re-plans what was approved.
        sourceRepo: REPO,
        sourceCommit: commit,
        environment: ENVIRONMENT,
        stateWorkspace: `${ENVIRONMENT}--o${org.orgId}--t${prodTargetId}`,
        infraPath: "infra",
        changeObjectId: apply.id
      });
      const declared = await declaredParameters("apply");
      for (const key of Object.keys(applySubmission.parameters)) {
        expect(declared, `SCP sent '${key}', which scp-infra-apply-v1 does not declare`).toContain(
          key
        );
      }
      const t = await waitForTarget(apply.id, "succeeded");
      expect(t.observed?.plan?.ref).toBe(approved!.digest);
      await waitForState(apply.id, "validating");
    });

    it("RE-APPLY of the applied plan is a NO-OP — succeeded, nothing submitted, the reason recorded", async () => {
      const before = submissions.length;
      const again = await proposeApply(prodTargetId, approved!.planChangeId);
      const t = await settle(again.id, "succeeded");
      expect(submissions.length, "no second apply was submitted").toBe(before);
      expect(t.observed?.plan?.ref).toBe(approved!.digest);
      const noop = byGate(await decisionsOf(again.id), "infra_apply_noop");
      expect(noop?.verdict).toBe("allow");
      expect(
        (await auditOf(again.id)).some((a) => a.action === "change.wave_target.infra_apply_noop")
      ).toBe(true);
      await waitForState(again.id, "validating");
    });

    it("a plan approved and then SUPERSEDED by a newer plan cannot be applied", async () => {
      const target = await environmentTarget({
        environment: ENVIRONMENT,
        region: "blue",
        infrastructurePath: "infra"
      });
      const first = await acceptedPlanAt(target.id);
      // A newer plan runs at the same place — not yet accepted, but it is the configuration now.
      const newer = await proposePlan(target.id);
      await runSubmittedWorkflow(newer.id);
      await waitForTarget(newer.id, "succeeded");

      const apply = await proposeApply(target.id, first.plan.id);
      await settle(apply.id, "infra_apply_refused");
      expect(submissions.filter((s) => s.parameters["changeObjectId"] === apply.id)).toEqual([]);
      const refusal = byGate(await decisionsOf(apply.id), "infra_plan_superseded");
      expect(refusal?.inputContext).toMatchObject({ supersededBy: newer.id });
    });

    it("a RECIPE restating any of the lane's bounds is refused — it cannot re-point an approved apply", async () => {
      const target = await environmentTarget({
        environment: ENVIRONMENT,
        region: "green",
        infrastructurePath: "infra"
      });
      const { plan } = await acceptedPlanAt(target.id);
      const hostile = Object.fromEntries(
        INFRA_LANE_RESERVED_PARAMETERS.map((k) => [k, k === "planDigest" ? "f".repeat(64) : "x"])
      );
      const apply = await proposeApply(target.id, plan.id, {
        recipe: { version: 1, trigger: { kind: "workflow_dispatch", parameters: hostile } }
      });
      // TWO LAYERS, asserted in the order that lets a mutation tell them apart. The refusal is the
      // first: nothing is submitted at all. Behind it the lane's values are spread LAST, so even with
      // the refusal deleted the recipe's digest never reaches the executor — the first assertion
      // stays green and the second goes red; delete BOTH and the first goes red too.
      const t = await settled(apply.id, "infra_declaration_refused");
      expect(
        submissions.filter((s) => s.parameters["planDigest"] === "f".repeat(64)),
        "an apply carrying the RECIPE's digest was submitted — the lane's bound did not win"
      ).toEqual([]);
      expect(
        submissions.filter((s) => s.parameters["changeObjectId"] === apply.id),
        "the apply was submitted at all — a recipe restating the lane's bounds must be refused"
      ).toEqual([]);
      expect(t.status).toBe("infra_declaration_refused");
      const refusal = byGate(await decisionsOf(apply.id), "infra_recipe_restates_bound");
      expect(refusal?.inputContext).toMatchObject({
        restated: [...INFRA_LANE_RESERVED_PARAMETERS].sort()
      });
    });

    it("PROBE A — the target re-scoped after approval (region r1 → r2): the apply is refused, never sent to the new workspace", async () => {
      const target = await environmentTarget({
        environment: ENVIRONMENT,
        region: "r1",
        infrastructurePath: "infra"
      });
      const { plan } = await acceptedPlanAt(target.id);
      const current = await admin.deploymentTargets.get(target.id);
      await admin.deploymentTargets.update(target.id, {
        properties: { ...(current.properties as Record<string, unknown>), region: "r2" }
      });
      const apply = await proposeApply(target.id, plan.id);
      await settle(apply.id, "infra_apply_refused");
      const refusal = byGate(await decisionsOf(apply.id), "infra_plan_scope_changed");
      expect(refusal?.inputContext).toMatchObject({ changed: ["stateWorkspace", "region"] });
    });

    it("PROBE B — the binding's plan template swapped after approval: refused, never sent to the new template's sibling", async () => {
      const target = await environmentTarget({
        environment: ENVIRONMENT,
        region: "r3",
        infrastructurePath: "infra"
      });
      const { plan } = await acceptedPlanAt(target.id);
      await admin.executors.putBinding(target.id, {
        executionSystemId: argoSystemId,
        type: "infrastructure",
        externalRef: "acme-evil-plan"
      });
      const apply = await proposeApply(target.id, plan.id);
      await settle(apply.id, "infra_apply_refused");
      expect(submissions.filter((s) => s.resourceName === "acme-evil-apply")).toEqual([]);
      const refusal = byGate(await decisionsOf(apply.id), "infra_plan_scope_changed");
      expect(refusal?.inputContext).toMatchObject({ changed: ["templateRef"] });
    });

    it("PROBE C — a plan from a repo the target does not declare is refused, never run with the operator's credentials", async () => {
      const target = await environmentTarget({
        environment: ENVIRONMENT,
        region: "r4",
        infrastructurePath: "infra"
      });
      const plan = await admin.changes.propose({
        name: `evil ${randomUUID().slice(0, 6)}`,
        targets: [target.id],
        type: "infrastructure",
        sourceRef: { repo: "attacker/evil", commit: "d".repeat(40) }
      });
      await settle(plan.id, "infra_declaration_refused");
      expect(submissions.filter((s) => s.parameters["sourceRepo"] === "attacker/evil")).toEqual([]);
      expect(
        byGate(await decisionsOf(plan.id), "infra_source_not_declared")?.inputContext
      ).toMatchObject({
        requestedRepo: "attacker/evil",
        declaredRepo: REPO
      });

      // And a target that declares NO repo refuses every plan.
      const undeclared = await environmentTarget({
        environment: ENVIRONMENT,
        region: "r4b",
        infrastructureRepo: null
      });
      const b = await proposePlan(undeclared.id);
      await settle(b.id, "infra_declaration_refused");
      expect(byGate(await decisionsOf(b.id), "infra_source_undeclared")).toBeDefined();
    });

    it("PROBE D — a configuration binding naming the PLAN template, recipe steering the workspace, is refused", async () => {
      const target = await environmentTarget(
        { environment: ENVIRONMENT, region: "r5" },
        "scp-infra-plan-v1",
        "configuration"
      );
      const change = await admin.changes.propose({
        name: `cfg ${randomUUID().slice(0, 6)}`,
        targets: [target.id],
        type: "configuration",
        properties: {
          recipe: {
            version: 1,
            trigger: {
              kind: "workflow_dispatch",
              parameters: {
                environment: "x",
                stateWorkspace: "other-org-prod",
                sourceRepo: "attacker/evil",
                sourceCommit: "e".repeat(40),
                infraPath: "."
              }
            }
          }
        }
      });
      await settle(change.id, "infra_apply_refused");
      expect(
        submissions.filter((s) => s.parameters["stateWorkspace"] === "other-org-prod")
      ).toEqual([]);
      expect(byGate(await decisionsOf(change.id), "infra_template_outside_lane")).toBeDefined();
    });

    it("THE PLUGIN HOST'S DOOR — no server path can submit or schedule an infra template except the lane", async () => {
      // Every other caller (hook runs, continuous probes, bumps) reaches Argo through this client.
      const t = await waveTargetOf(approved!.planChangeId);
      const instanceId = t!.executorPluginId!;
      const client = server.pluginHost!.executor(instanceId);
      const before = submissions.length;
      for (const template of ["scp-infra-plan-v1", "scp-infra-apply-v1"]) {
        await expect(
          client.trigger({
            kind: "workflow_dispatch",
            targetRef: template,
            parameters: { stateWorkspace: "anything", planDigest: "f".repeat(64) }
          })
        ).rejects.toThrow(/submitted only by the infrastructure lane/);
        await expect(
          client.ensureSchedule!({
            scheduleId: `probe-${randomUUID().slice(0, 6)}`,
            targetRef: template,
            cadenceSeconds: 300
          })
        ).rejects.toThrow(/submitted only by the infrastructure lane/);
      }
      expect(submissions.length, "an infra template reached Argo outside the lane").toBe(before);
    });

    it("a declared APPLY on a target whose pipeline is NOT the Argo lane is refused, never run as something else", async () => {
      const target = await admin.deploymentTargets.create({
        name: `unbound-${randomUUID().slice(0, 6)}`,
        properties: { environment: ENVIRONMENT, infrastructureRepo: REPO }
      });
      const apply = await proposeApply(target.id, approved!.planChangeId);
      const t = await settled(apply.id, "infra_apply_refused");
      expect(t.status).toBe("infra_apply_refused");
      expect(byGate(await decisionsOf(apply.id), "infra_apply_lane_absent")).toBeDefined();
    });

    it("the shipped APPLY template is unreachable outside the lane — a binding naming it directly is refused", async () => {
      const target = await environmentTarget(
        { environment: "prod-us-east-1", region: "side-door" },
        "scp-infra-apply-v1",
        "configuration"
      );
      const change = await admin.changes.propose({
        name: `side door ${randomUUID().slice(0, 6)}`,
        targets: [target.id],
        type: "configuration",
        properties: {
          recipe: {
            version: 1,
            trigger: { kind: "workflow_dispatch", parameters: { planDigest: "f".repeat(64) } }
          }
        }
      });
      await settle(change.id, "infra_apply_refused");
      expect(submissions.filter((s) => s.parameters["planDigest"] === "f".repeat(64))).toEqual([]);
      expect(byGate(await decisionsOf(change.id), "infra_template_outside_lane")).toBeDefined();
    });

    it("a PLAN is refused — never submitted — for a target with no environment, or a source with no pinned commit", async () => {
      const noEnv = await environmentTarget({ infrastructurePath: "infra" });
      const a = await proposePlan(noEnv.id);
      await settle(a.id, "infra_declaration_refused");
      expect(byGate(await decisionsOf(a.id), "infra_environment_missing")).toBeDefined();

      const env = await environmentTarget({ environment: "prod-us-east-1", region: "unpinned" });
      const b = await admin.changes.propose({
        name: `unpinned ${randomUUID().slice(0, 6)}`,
        targets: [env.id],
        type: "infrastructure",
        sourceRef: { repo: REPO, ref: "refs/heads/main" }
      });
      await settle(b.id, "infra_declaration_refused");
      expect(byGate(await decisionsOf(b.id), "infra_source_unpinned")).toBeDefined();
      for (const id of [a.id, b.id]) {
        expect(submissions.filter((s) => s.parameters["changeObjectId"] === id)).toEqual([]);
      }
    });

    it("REAL COUNTERPARTY — the shipped script planned, applied the approved digest, and a re-plan now shows NO changes; a drifted digest is refused", async () => {
      if (!dockerReady) return expectSkipped();
      expect(applySubmission, "the apply test ran").toBeDefined();

      // The runs the lane itself drove, in order: the prod plan, then its apply.
      const prodPlan = realRuns.find((r) => r.phase === "plan");
      const prodApply = realRuns.find((r) => r.phase === "apply");
      expect(prodPlan?.rc, prodPlan?.stdout).toBe(0);
      expect(prodPlan?.outputs).toMatchObject({ planAdd: "1", planChange: "0", planDestroy: "0" });
      expect(prodApply?.rc, prodApply?.stdout).toBe(0);
      expect(prodApply?.outputs["applied"]).toBe("true");
      expect(prodApply?.outputs["planDigest"]).toBe(approved!.digest);
      expect(prodApply?.stdout).toContain("Apply complete! Resources: 1 added");

      // RE-PLAN with the apply's own parameters: the environment's state now holds the network.
      const replan = await runScript("plan", applySubmission!.parameters);
      expect(replan.rc, replan.stdout).toBe(0);
      expect(replan.outputs).toMatchObject({ planAdd: "0", planChange: "0", planDestroy: "0" });
      expect(replan.stdout).toContain("No changes.");

      // THE TEMPLATE'S HALF OF THE BINDING, against the real state. Re-applying the approved digest is
      // a no-op, and an apply whose approved digest is not what the configuration now plans is refused.
      const reapply = await runScript("apply", applySubmission!.parameters);
      expect(reapply.rc, reapply.stdout).toBe(0);
      expect(reapply.outputs["applied"]).toBe("false");
      expect(reapply.stdout).toContain("no-op");

      // A second environment with nothing applied yet: an apply bound to the WRONG digest refuses.
      const fresh = { ...applySubmission!.parameters, stateWorkspace: "prod-us-east-1-drill" };
      const drifted = await runScript("apply", { ...fresh, planDigest: "f".repeat(64) });
      expect(drifted.rc, drifted.stdout).toBe(3);
      expect(drifted.stdout).toContain("REFUSING to apply");
      expect(drifted.outputs["applied"]).toBe("false");

      // And the digest is deterministic — two plans of the same thing agree, which is what makes a
      // digest an identity an approval can bind to at all.
      const p1 = await runScript("plan", fresh);
      const p2 = await runScript("plan", fresh);
      expect(p1.outputs["planDigest"]).toMatch(/^[0-9a-f]{64}$/);
      expect(p2.outputs["planDigest"]).toBe(p1.outputs["planDigest"]);

      // THE DIGEST COVERS THE PLACE (item 1): the same changes planned into another workspace are a
      // different plan, so an approval of one cannot apply the other — measured, not argued.
      const elsewhere = await runScript("plan", {
        ...fresh,
        stateWorkspace: "prod-us-east-1-other"
      });
      expect(elsewhere.outputs["planAdd"]).toBe(p1.outputs["planAdd"]);
      expect(elsewhere.outputs["planDigest"]).not.toBe(p1.outputs["planDigest"]);
      const crossApply = await runScript("apply", {
        ...fresh,
        stateWorkspace: "prod-us-east-1-other",
        planDigest: p1.outputs["planDigest"]!
      });
      expect(crossApply.rc, crossApply.stdout).toBe(3);
      expect(crossApply.outputs["applied"]).toBe("false");

      // THE BACKEND IS THE OPERATOR'S (item 5): a repo carrying its own override file, `backend`
      // block or `cloud` block is refused before init — `zz_override.tf` sorts after the script's
      // override and would otherwise win (measured by the verification probe).
      for (const [name, extra] of [
        [
          "acme/infra-override",
          {
            "infra/zz_override.tf":
              'terraform {\n  backend "local" {\n    path = "/tmp/elsewhere.tfstate"\n  }\n}\n'
          }
        ],
        ["acme/infra-backend", { "infra/backend.tf": 'terraform {\n  backend "s3" {}\n}\n' }],
        [
          "acme/infra-cloud",
          { "infra/cloud.tf": 'terraform {\n  cloud {\n    organization = "x"\n  }\n}\n' }
        ]
      ] as const) {
        const head = await seedRepo(name, { "infra/main.tf": NETWORK_TF, ...extra });
        const run = await runScript("plan", { ...fresh, sourceRepo: name, sourceCommit: head });
        expect(run.rc, `${name}: ${run.stdout}`).toBe(2);
        expect(run.stdout).toMatch(/override file|backend or cloud block/);
        expect(run.outputs["planDigest"], `${name} got as far as a plan`).toBeUndefined();
      }
    }, 900_000);

    it("(the wave-target rows agree with the API — the observed plan is PERSISTED, not computed on read)", async () => {
      const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
        tx
          .select()
          .from(changeWaveTargets)
          .where(
            and(
              eq(changeWaveTargets.orgId, org.orgId),
              eq(changeWaveTargets.targetObjectId, prodTargetId)
            )
          )
      );
      const withPlan = rows.filter(
        (r) =>
          (r.observedState as { plan?: { ref?: string } } | null)?.plan?.ref === approved!.digest
      );
      // The plan, its apply, and the no-op re-apply all carry the approved plan on the row itself.
      expect(withPlan.length).toBeGreaterThanOrEqual(3);
    });
  }
);
