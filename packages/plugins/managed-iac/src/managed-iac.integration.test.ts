import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { PluginContext } from "@scp/plugin-api";
import { createManagedIacExecutorPlugin } from "./index.js";

/**
 * REAL-DOCKER integration test (BUILD_AND_TEST.md §8 M7 DoD): "launches a REAL scp-runner-iac
 * container against a local-state tofu fixture end-to-end: plan evidence → gate block → approve
 * → apply → rollback via the prior state ref." Needs a reachable Docker daemon — excluded from
 * `pnpm test` (vitest.config.ts), run via `pnpm test:integration` on the
 * `homelab-commanderscp-linux-docker-build` CI runner, or locally per CLAUDE.md's ENVIRONMENT.
 *
 * COPY-NOT-BIND-MOUNT (adversarial-review CRITICAL #1 fix, also fixes the dind CI failure): the
 * plugin `docker cp`s the workspace INTO the container and back OUT — it never bind-mounts a host
 * path. `docker cp` streams over the daemon API, so it works regardless of whether the host path
 * is shared with the (colima/dind) VM — this is why the previous "TMPDIR must be $HOME-rooted
 * under colima" / "the dind runner's /tmp isn't shared" constraints are GONE. `os.tmpdir()` is
 * used freely for both the workspace root and the dedup statePath.
 *
 * SERVER-GOVERNED CONFIG: `runnerImage`/`networkMode`/`workspaceRoot`/`statePath` are the fields
 * the SERVER injects in production (`executor-bindings-repo.ts`) and a tenant can never set. This
 * test provides them directly (it calls the plugin, not the server), standing in for that
 * injection — with `networkMode: "none"` asserting isolation, not just assuming it.
 *
 * FIXTURE, DELIBERATELY NETWORK-FREE: `terraform_data` (built into OpenTofu's CORE provider — zero
 * provider download at `tofu init`), so a real plan/apply/state lifecycle runs with no network.
 */

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNNER_IAC_CONTEXT = resolve(__dirname, "../../../../apps/runner-iac");
const RUNNER_IMAGE_TAG = "scp-runner-iac:m7-integration-test";
const ORG_ID = "test-org";
const TARGET_REF = "test-workspace";

function fixtureSource(content: string): Record<string, string> {
  return {
    "main.tf": `variable "content" {\n  type    = string\n  default = "${content}"\n}\n\nresource "terraform_data" "example" {\n  input = var.content\n}\n\noutput "content" {\n  value = terraform_data.example.output\n}\n`
  };
}

async function dockerAvailable(): Promise<boolean> {
  try {
    await execFileAsync("docker", ["info"], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/** The server-derived per-(org,target) workspace the plugin writes evidence into (mirrors
 *  `workspaceDirFor` in index.ts). */
function derivedWorkspace(workspaceRoot: string): string {
  const safe = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, "_");
  return join(workspaceRoot, safe(ORG_ID), safe(TARGET_REF));
}

async function readState(
  workspaceRoot: string
): Promise<{ input: string; output: string } | undefined> {
  try {
    const raw = await readFile(join(derivedWorkspace(workspaceRoot), "terraform.tfstate"), "utf8");
    const state = JSON.parse(raw) as {
      resources: Array<{
        instances: Array<{ attributes: { input: { value: string }; output: { value: string } } }>;
      }>;
    };
    const attrs = state.resources[0]?.instances[0]?.attributes;
    return attrs ? { input: attrs.input.value, output: attrs.output.value } : undefined;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

async function readPlanEvidence(workspaceRoot: string): Promise<unknown> {
  return JSON.parse(await readFile(join(derivedWorkspace(workspaceRoot), "plan.json"), "utf8"));
}

async function listStateHistory(workspaceRoot: string): Promise<string[]> {
  try {
    return await readdir(join(derivedWorkspace(workspaceRoot), "state-history"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

function buildCtx(workspaceRoot: string, overrides: Record<string, unknown> = {}): PluginContext {
  return {
    orgId: ORG_ID,
    domainId: "test-domain",
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    secrets: { get: async () => undefined }, // fixture needs no infra creds — terraform_data is local-only
    http: {
      request: async () => {
        throw new Error("managed-iac integration test: plugin never calls ctx.http");
      }
    },
    config: {
      // Server-governed fields (the server injects these in production; here we stand in for it).
      runnerImage: RUNNER_IMAGE_TAG,
      workspaceRoot,
      networkMode: "none", // isolation asserted, not assumed
      statePath: join(workspaceRoot, "dedup.json"),
      timeoutMs: 90_000,
      ...overrides
    }
  };
}

describe.runIf(await dockerAvailable())(
  "managed-iac: real scp-runner-iac container (Docker required)",
  () => {
    const plugin = createManagedIacExecutorPlugin();

    beforeAll(async () => {
      await execFileAsync("docker", ["build", "-t", RUNNER_IMAGE_TAG, RUNNER_IAC_CONTEXT], {
        timeout: 300_000,
        maxBuffer: 32 * 1024 * 1024
      });
    }, 300_000);

    it("plan evidence -> gate block -> approve -> apply -> rollback via prior state ref, end to end against a real container", async () => {
      const workspaceRoot = await mkdtemp(join(tmpdir(), "scp-managed-iac-it-"));
      try {
        const ctx = buildCtx(workspaceRoot);

        // ---- 1. PLAN — evidence produced, NOTHING applied yet (gate-block state). ----
        const planRef = await plugin.trigger(ctx, {
          kind: "sync",
          targetRef: TARGET_REF,
          parameters: { iacAction: "plan", sourceFiles: fixtureSource("v1") },
          idempotencyKey: "plan-v1"
        });
        expect((await plugin.status(ctx, planRef)).phase).toBe("succeeded");

        const planEvidence = (await readPlanEvidence(workspaceRoot)) as {
          resource_changes: Array<{ change: { actions: string[]; after: { input: string } } }>;
        };
        expect(planEvidence.resource_changes).toHaveLength(1);
        expect(planEvidence.resource_changes[0]!.change.actions).toContain("create");
        expect(planEvidence.resource_changes[0]!.change.after.input).toBe("v1");
        // Gate block, concretely proven: plan alone made no infrastructure change.
        expect(await readState(workspaceRoot)).toBeUndefined();

        // ---- 2. APPROVE -> APPLY ----
        const applyRef = await plugin.trigger(ctx, {
          kind: "sync",
          targetRef: TARGET_REF,
          parameters: { iacAction: "apply" },
          idempotencyKey: "apply-v1"
        });
        expect((await plugin.status(ctx, applyRef)).phase).toBe("succeeded");
        expect((await readState(workspaceRoot))?.output).toBe("v1");

        // ---- 3. IDEMPOTENCY — retry with the SAME key must dedup WITHOUT invoking docker (proven:
        // a broken dockerBinary on the retry still returns the cached outcome). ----
        const dedupCtx = buildCtx(workspaceRoot, {
          dockerBinary: "/nonexistent/docker-binary-for-dedup-proof"
        });
        const dedupRef = await plugin.trigger(dedupCtx, {
          kind: "sync",
          targetRef: TARGET_REF,
          parameters: { iacAction: "apply" },
          idempotencyKey: "apply-v1"
        });
        expect(dedupRef.externalId).toBe(applyRef.externalId);

        // ---- 4. A second real change (v2) — sets up rollback's prior known-good state. ----
        const historyBeforeV2 = new Set(await listStateHistory(workspaceRoot));
        await plugin.trigger(ctx, {
          kind: "sync",
          targetRef: TARGET_REF,
          parameters: { iacAction: "plan", sourceFiles: fixtureSource("v2") },
          idempotencyKey: "plan-v2"
        });
        await plugin.trigger(ctx, {
          kind: "sync",
          targetRef: TARGET_REF,
          parameters: { iacAction: "apply" },
          idempotencyKey: "apply-v2"
        });
        expect((await readState(workspaceRoot))?.output).toBe("v2");

        const newEntries = (await listStateHistory(workspaceRoot)).filter(
          (f) => !historyBeforeV2.has(f)
        );
        const priorStateFile = newEntries.find((f) => f.endsWith("-pre-apply.tfstate"));
        expect(
          priorStateFile,
          `expected a *-pre-apply.tfstate snapshot among new entries: ${newEntries.join(", ")}`
        ).toBeDefined();

        // ---- 5. ROLLBACK via the prior state ref — restores v1's state. ----
        const rollbackRef = await plugin.trigger(ctx, {
          kind: "rollback",
          targetRef: TARGET_REF,
          priorStateRef: `state-history/${priorStateFile}`,
          idempotencyKey: "rollback-to-v1"
        });
        expect((await plugin.status(ctx, rollbackRef)).phase).toBe("succeeded");
        expect((await readState(workspaceRoot))?.output).toBe("v1");
      } finally {
        await rm(workspaceRoot, { recursive: true, force: true });
      }
    }, 180_000);

    it("rollback FAILS CLOSED against a real container when no valid prior state ref is given (never silently re-applies)", async () => {
      const workspaceRoot = await mkdtemp(join(tmpdir(), "scp-managed-iac-it-rb-"));
      try {
        const ctx = buildCtx(workspaceRoot);
        const ref = await plugin.trigger(ctx, {
          kind: "rollback",
          targetRef: TARGET_REF,
          idempotencyKey: "rollback-no-prior"
        });
        const status = await plugin.status(ctx, ref);
        expect(status.phase).toBe("failed");
        expect(status.detail).toContain("FAILED CLOSED");
      } finally {
        await rm(workspaceRoot, { recursive: true, force: true });
      }
    });
  }
);
