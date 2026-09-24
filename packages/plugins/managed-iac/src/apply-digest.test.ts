import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PluginContext } from "@scp/plugin-api";
import type { RunnerLauncher, RunnerSpec } from "@scp/runner-launcher";
import { createManagedIacExecutorPlugin } from "./index.js";

/**
 * THE EXECUTOR-SIDE HALF OF THE APPLY GATE (ADR-0056 addendum 4). The server approves ONE plan by
 * digest; `run.sh apply` applies whatever `.tfplan` the workspace holds. So the plugin refuses —
 * before any container is launched — an apply whose digest is not the workspace's plan, an apply
 * with no digest, and an apply that brings new source. A plan may not overwrite the files the
 * workspace owns either (the saved plan, its evidence, the state).
 */

const PLAN_JSON = JSON.stringify({ resource_changes: [{ change: { actions: ["create"] } }] });
const DIGEST = createHash("sha256").update(PLAN_JSON).digest("hex");

let workspaceRoot: string;
let seen: RunnerSpec[];

const launcher = (): RunnerLauncher => ({
  async run(spec) {
    seen.push(spec);
    return { succeeded: true, stdout: "applied", stderr: "" };
  },
  reap: async () => []
});

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "managed-iac-apply-"));
  seen = [];
  await mkdir(join(workspaceRoot, "org-1", "t1"), { recursive: true });
  await writeFile(join(workspaceRoot, "org-1", "t1", "plan.json"), PLAN_JSON, "utf8");
});

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

function ctx(): PluginContext {
  return {
    orgId: "org-1",
    scopeKey: "domain-1",
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    secrets: { get: async () => undefined },
    http: {
      request: async () => {
        throw new Error("managed-iac: never calls ctx.http");
      }
    },
    config: {
      runnerImage: "scp-runner-iac:vetted",
      workspaceRoot,
      networkMode: "none",
      statePath: join(workspaceRoot, "dedup.json")
    }
  };
}

async function run(parameters: Record<string, unknown>, key: string) {
  const plugin = createManagedIacExecutorPlugin(() => launcher());
  const c = ctx();
  const ref = await plugin.trigger(c, { kind: "sync", targetRef: "t1", parameters, idempotencyKey: key });
  return plugin.status(c, ref);
}

describe("managed-iac apply is bound to the approved plan's digest", () => {
  it("CONTROL: the approved digest IS the workspace's plan — the apply launches", async () => {
    const status = await run({ iacAction: "apply", planDigest: DIGEST }, "ok");
    expect(status.phase).toBe("succeeded");
    expect(seen.map((s) => s.operands)).toEqual([["apply"]]);
    expect(status.observed?.plan?.ref).toBe(DIGEST);
  });

  it("a DIFFERENT digest (a newer plan in the workspace) is refused, and nothing launches", async () => {
    const status = await run({ iacAction: "apply", planDigest: "f".repeat(64) }, "other");
    expect(status.phase).toBe("failed");
    expect(status.detail).toMatch(/FAILED CLOSED — the workspace's plan is .* and the approved plan is ffffffffffff/);
    expect(seen).toEqual([]);
  });

  it("NO digest is refused", async () => {
    const status = await run({ iacAction: "apply" }, "none");
    expect(status.detail).toMatch(/names no approved plan digest/);
    expect(seen).toEqual([]);
  });

  it("NO plan in the workspace is refused", async () => {
    await rm(join(workspaceRoot, "org-1", "t1", "plan.json"));
    const status = await run({ iacAction: "apply", planDigest: DIGEST }, "absent");
    expect(status.detail).toMatch(/the workspace's plan is absent/);
    expect(seen).toEqual([]);
  });

  it("an apply that brings SOURCE is refused — it applies what was reviewed, nothing else", async () => {
    const status = await run(
      { iacAction: "apply", planDigest: DIGEST, sourceFiles: { "main.tf": "x" } },
      "source"
    );
    expect(status.detail).toMatch(/an apply takes no source files/);
    expect(seen).toEqual([]);
  });

  it("an unknown iacAction is refused", async () => {
    const status = await run({ iacAction: "destroy" }, "unknown");
    expect(status.detail).toMatch(/unknown iacAction 'destroy'/);
    expect(seen).toEqual([]);
  });

  it.each([".tfplan", "plan.json", "terraform.tfstate", "terraform.tfstate.backup", ".terraform.lock.hcl"])(
    "a plan may not overwrite the workspace-owned '%s'",
    async (name) => {
      const status = await run({ iacAction: "plan", sourceFiles: { [name]: "forged" } }, `own-${name}`);
      expect(status.phase).toBe("failed");
      expect(status.detail).toMatch(/names a file the workspace owns/);
      expect(seen).toEqual([]);
    }
  );
});
