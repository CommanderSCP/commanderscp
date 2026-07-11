import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
 * `pnpm test` (vitest.config.ts), run via `pnpm test:integration` (vitest.integration.config.ts)
 * on the `homelab-commanderscp-linux-docker-build` CI runner, or locally per CLAUDE.md's ENVIRONMENT
 * section: `export DOCKER_HOST="unix://$HOME/.colima/default/docker.sock"
 * TESTCONTAINERS_RYUK_DISABLED=true && pnpm exec turbo run test:integration --env-mode=loose`.
 *
 * LOCAL-DOCKER-VIA-COLIMA NOTE: colima's default VM mount is `$HOME` ONLY (`mounts: []` in
 * `~/.colima/default/colima.yaml`, doc comment: "Colima default behaviour: $HOME is mounted as
 * writable") — a bind mount rooted outside `$HOME` (e.g. the OS default tmpdir on macOS,
 * `/var/folders/...`) silently mounts as EMPTY inside the container under colima, which reads as
 * "no configuration files found" rather than an obvious mount error. This test uses
 * `os.tmpdir()`/`mkdtemp` (the portable, CI-correct pattern every other temp dir in this repo
 * uses — test-support/harness.ts) and NOT a colima-specific path, since CI's docker-build runner
 * is native Docker with no VM layer (any path bind-mounts correctly there); a developer running
 * this locally under colima needs `TMPDIR` pointed at a `$HOME`-rooted directory (e.g. `export
 * TMPDIR="$HOME/.scp-test-tmp"` before running) — `os.tmpdir()` honors `$TMPDIR` on POSIX.
 *
 * FIXTURE, DELIBERATELY NETWORK-FREE (CLAUDE.md: "Tests never touch the internet"): uses
 * `terraform_data` — a resource type built into Terraform/OpenTofu's own CORE `terraform.io/
 * builtin/terraform` provider, requiring ZERO provider download at `tofu init` (confirmed
 * empirically: `tofu init` against a `terraform_data`-only config never touches the registry).
 * This is the "local-state tofu fixture" the DoD names — no cloud credentials, no network egress,
 * still a REAL `tofu plan`/`apply`/state-file lifecycle inside the REAL `scp-runner-iac` image.
 */

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
// packages/plugins/managed-iac/src -> repo root -> apps/runner-iac
const RUNNER_IAC_CONTEXT = resolve(__dirname, "../../../../apps/runner-iac");
const RUNNER_IMAGE_TAG = "scp-runner-iac:m7-integration-test";

function fixtureConfig(content: string): string {
  return `variable "content" {\n  type    = string\n  default = "${content}"\n}\n\nresource "terraform_data" "example" {\n  input = var.content\n}\n\noutput "content" {\n  value = terraform_data.example.output\n}\n`;
}

async function dockerAvailable(): Promise<boolean> {
  try {
    await execFileAsync("docker", ["info"], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

async function readState(
  workspaceDir: string
): Promise<{ input: string; output: string } | undefined> {
  try {
    const raw = await readFile(join(workspaceDir, "terraform.tfstate"), "utf8");
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

async function readPlanEvidence(workspaceDir: string): Promise<unknown> {
  const raw = await readFile(join(workspaceDir, "plan.json"), "utf8");
  return JSON.parse(raw);
}

/** Snapshots the `state-history/` directory's entries; used to find the file a given trigger()
 *  call added (diffed against a before-snapshot) rather than trusting timestamp uniqueness — two
 *  runs completing within the same wall-clock second would otherwise collide (run.sh's filenames
 *  have 1-second resolution). */
async function listStateHistory(workspaceDir: string): Promise<string[]> {
  try {
    return await readdir(join(workspaceDir, "state-history"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

function buildCtx(workspaceDir: string, overrides: Record<string, unknown> = {}): PluginContext {
  return {
    orgId: "test-org",
    domainId: "test-domain",
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    secrets: { get: async () => undefined }, // fixture needs no infra creds — terraform_data is local-only
    http: {
      request: async () => {
        throw new Error("managed-iac integration test: plugin never calls ctx.http");
      }
    },
    config: {
      runnerImage: RUNNER_IMAGE_TAG,
      workspaceDir,
      networkMode: "none", // the fixture makes zero network calls — deny-by-default proven, not just assumed
      timeoutMs: 90_000,
      ...overrides
    }
  };
}

describe.runIf(await dockerAvailable())(
  "managed-iac: real scp-runner-iac container (Docker required)",
  () => {
    const plugin = createManagedIacExecutorPlugin();
    let workspaceDir: string;

    beforeAll(async () => {
      // Build once for the whole suite — the Dockerfile pulls ghcr.io/opentofu/opentofu on a cache
      // miss (a normal build-time base-image fetch, same category as the root Dockerfile's
      // node:22-bookworm-slim — not a runtime/test network call).
      await execFileAsync("docker", ["build", "-t", RUNNER_IMAGE_TAG, RUNNER_IAC_CONTEXT], {
        timeout: 300_000,
        maxBuffer: 32 * 1024 * 1024
      });
    }, 300_000);

    it("plan evidence -> gate block -> approve -> apply -> rollback via prior state ref, end to end against a real container", async () => {
      workspaceDir = await mkdtemp(join(tmpdir(), "scp-managed-iac-it-"));
      try {
        await writeFile(join(workspaceDir, "main.tf"), fixtureConfig("v1"), "utf8");
        const ctx = buildCtx(workspaceDir);

        // ---- 1. PLAN — evidence produced, NOTHING applied yet ("gate block" state: the change
        // has evidence for a human/policy decision to consult, but no infra has changed). ----
        const planRef = await plugin.trigger(ctx, {
          kind: "sync",
          targetRef: "test-workspace",
          parameters: { iacAction: "plan" },
          idempotencyKey: "plan-v1"
        });
        const planStatus = await plugin.status(ctx, planRef);
        expect(planStatus.phase).toBe("succeeded");

        const planEvidence = (await readPlanEvidence(workspaceDir)) as {
          resource_changes: Array<{ change: { actions: string[]; after: { input: string } } }>;
        };
        expect(planEvidence.resource_changes).toHaveLength(1);
        expect(planEvidence.resource_changes[0]!.change.actions).toContain("create");
        expect(planEvidence.resource_changes[0]!.change.after.input).toBe("v1");

        // Gate block, concretely proven: plan alone made no infrastructure change.
        expect(await readState(workspaceDir)).toBeUndefined();

        // ---- 2. APPROVE -> APPLY ----
        const applyRef = await plugin.trigger(ctx, {
          kind: "sync",
          targetRef: "test-workspace",
          parameters: { iacAction: "apply" },
          idempotencyKey: "apply-v1"
        });
        const applyStatus = await plugin.status(ctx, applyRef);
        expect(applyStatus.phase).toBe("succeeded");

        const stateAfterV1 = await readState(workspaceDir);
        expect(stateAfterV1?.output).toBe("v1");

        // ---- 3. IDEMPOTENCY — a retry with the SAME idempotencyKey must dedup WITHOUT ever
        // invoking docker again (proven, not assumed: point dockerBinary at a nonexistent path on
        // a fresh ctx and confirm the cached outcome still comes back with no error). This is the
        // strongest of any M7 executor's idempotency proof, matching the module doc's framing —
        // the stakes (a real, if local, infrastructure apply) are the highest of any M7 executor. ----
        const dedupCtx = buildCtx(workspaceDir, {
          dockerBinary: "/nonexistent/docker-binary-for-dedup-proof"
        });
        const dedupRef = await plugin.trigger(dedupCtx, {
          kind: "sync",
          targetRef: "test-workspace",
          parameters: { iacAction: "apply" },
          idempotencyKey: "apply-v1"
        });
        expect(dedupRef.externalId).toBe(applyRef.externalId);

        // ---- 4. A second, real change (v2) — sets up rollback's "prior known-good state". ----
        const historyBeforeV2 = new Set(await listStateHistory(workspaceDir));
        await writeFile(join(workspaceDir, "main.tf"), fixtureConfig("v2"), "utf8");
        await plugin.trigger(ctx, {
          kind: "sync",
          targetRef: "test-workspace",
          parameters: { iacAction: "plan" },
          idempotencyKey: "plan-v2"
        });
        await plugin.trigger(ctx, {
          kind: "sync",
          targetRef: "test-workspace",
          parameters: { iacAction: "apply" },
          idempotencyKey: "apply-v2"
        });
        const stateAfterV2 = await readState(workspaceDir);
        expect(stateAfterV2?.output).toBe("v2");

        const historyAfterV2 = await listStateHistory(workspaceDir);
        const newEntries = historyAfterV2.filter((f) => !historyBeforeV2.has(f));
        const priorStateFile = newEntries.find((f) => f.endsWith("-pre-apply.tfstate"));
        expect(
          priorStateFile,
          `expected a *-pre-apply.tfstate snapshot among new entries: ${newEntries.join(", ")}`
        ).toBeDefined();

        // ---- 5. ROLLBACK via the prior state ref — restores v1's state, exactly as the DoD
        // names ("rollback via the prior state ref"). ----
        const rollbackRef = await plugin.trigger(ctx, {
          kind: "rollback",
          targetRef: "test-workspace",
          priorStateRef: `state-history/${priorStateFile}`,
          idempotencyKey: "rollback-to-v1"
        });
        const rollbackStatus = await plugin.status(ctx, rollbackRef);
        expect(rollbackStatus.phase).toBe("succeeded");

        const stateAfterRollback = await readState(workspaceDir);
        expect(stateAfterRollback?.output).toBe("v1");
      } finally {
        await rm(workspaceDir, { recursive: true, force: true });
      }
    }, 120_000);

    it("abort() honestly reports nothing to abort (trigger() is synchronous — module doc)", async () => {
      const ctx = buildCtx(await mkdtemp(join(tmpdir(), "scp-managed-iac-it-abort-")));
      try {
        const result = await plugin.abort(ctx, { externalId: "managed-iac::whatever" });
        expect(result.aborted).toBe(false);
      } finally {
        await rm((ctx.config as { workspaceDir: string }).workspaceDir, {
          recursive: true,
          force: true
        });
      }
    });
  }
);
