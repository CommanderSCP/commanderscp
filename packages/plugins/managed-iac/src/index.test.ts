import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@scp/plugin-api";

/**
 * Unit tests (no Docker — every `docker` invocation is mocked, so these run on every PR under
 * `pnpm test`). They assert the SECURITY-critical properties the review demanded be guarded:
 * the container always launches with `--network none`, NO bind mount, and NO docker.sock; the
 * workspace is copied in/out rather than mounted; a rollback with no valid prior state ref fails
 * CLOSED without touching docker; the dedup cache prevents a second real run; and resolved secret
 * values are redacted out of returned evidence.
 */

// Records every `docker` argv and lets each test script the responses (create -> id, start ->
// stdout/stderr or a failure, cp/rm -> ok). `promisify(execFile)` resolves the callback's second
// arg, so a mocked call passes `{stdout, stderr}` there (or an Error carrying stdout/stderr).
interface DockerCall {
  file: string;
  args: string[];
}
const dockerCalls: DockerCall[] = [];
let startBehavior: { ok: boolean; stdout: string; stderr: string } = {
  ok: true,
  stdout: "ok",
  stderr: ""
};

vi.mock("node:child_process", () => {
  return {
    execFile: (
      file: string,
      args: string[],
      _opts: unknown,
      cb: (err: Error | null, result?: { stdout: string; stderr: string }) => void
    ) => {
      dockerCalls.push({ file, args });
      const sub = args[0];
      if (sub === "create") {
        cb(null, { stdout: "container-abc123\n", stderr: "" });
      } else if (sub === "start") {
        if (startBehavior.ok) {
          cb(null, { stdout: startBehavior.stdout, stderr: startBehavior.stderr });
        } else {
          const err = Object.assign(new Error("container exited non-zero"), {
            stdout: startBehavior.stdout,
            stderr: startBehavior.stderr
          });
          cb(err);
        }
      } else {
        // cp / rm
        cb(null, { stdout: "", stderr: "" });
      }
    }
  };
});

// Import AFTER the mock is registered (vi.mock is hoisted, but keep the intent explicit).
const { createManagedIacExecutorPlugin } = await import("./index.js");

let workspaceRoot: string;

beforeEach(async () => {
  dockerCalls.length = 0;
  startBehavior = { ok: true, stdout: "ok", stderr: "" };
  workspaceRoot = await mkdtemp(join(tmpdir(), "managed-iac-unit-"));
});

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

function ctx(
  overrides: Record<string, unknown> = {},
  secretGet?: (k: string) => Promise<string | undefined>
): PluginContext {
  return {
    orgId: "org-1",
    scopeKey: "domain-1",
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    secrets: { get: secretGet ?? (async () => undefined) },
    http: {
      request: async () => {
        throw new Error("managed-iac: never calls ctx.http");
      }
    },
    config: {
      runnerImage: "scp-runner-iac:vetted",
      workspaceRoot,
      networkMode: "none",
      statePath: join(workspaceRoot, "dedup.json"),
      ...overrides
    }
  };
}

function createCall(): DockerCall | undefined {
  return dockerCalls.find((c) => c.args[0] === "create");
}

describe("@scp/plugin-managed-iac: container isolation (CRITICAL #1)", () => {
  it("launches the vetted image with --network none, NO -v bind mount, and NO docker.sock", async () => {
    const plugin = createManagedIacExecutorPlugin();
    await plugin.trigger(ctx(), {
      kind: "sync",
      targetRef: "t1",
      parameters: { iacAction: "plan", sourceFiles: { "main.tf": "# tf" } },
      idempotencyKey: "k1"
    });

    const create = createCall();
    expect(create).toBeDefined();
    const args = create!.args;
    // create --network none ... scp-runner-iac:vetted plan
    expect(args).toContain("--network");
    expect(args[args.indexOf("--network") + 1]).toBe("none");
    expect(args).toContain("scp-runner-iac:vetted");
    expect(args[args.length - 1]).toBe("plan");
    // No bind mount, no docker socket — structurally: the container gets its workspace by copy.
    expect(args).not.toContain("-v");
    expect(args.join(" ")).not.toContain("docker.sock");
    // The workspace is delivered by `docker cp` INTO the container, then evidence copied back OUT.
    const cpCalls = dockerCalls.filter((c) => c.args[0] === "cp");
    expect(cpCalls.length).toBeGreaterThanOrEqual(2);
    expect(cpCalls.some((c) => c.args[2] === "container-abc123:/workspace")).toBe(true);
    // The container is always removed afterward — BY THE NAME the plugin chose, not by the id
    // `create` printed. That is M23.0's defect 1: the name is the only identity that also exists on
    // the path where `create` itself is what failed, so it is the only one teardown can rely on.
    expect(dockerCalls.some((c) => c.args[0] === "rm" && c.args.includes("scp-runner-k1"))).toBe(
      true
    );
  });

  it("uses the server-supplied networkMode verbatim (e.g. a real cloud provider's 'bridge')", async () => {
    const plugin = createManagedIacExecutorPlugin();
    await plugin.trigger(ctx({ networkMode: "bridge" }), {
      kind: "sync",
      targetRef: "t1",
      parameters: { iacAction: "plan" },
      idempotencyKey: "k1"
    });
    const args = createCall()!.args;
    expect(args[args.indexOf("--network") + 1]).toBe("bridge");
  });

  it("rejects a source filename containing a path separator or '..' (path-traversal defense)", async () => {
    const plugin = createManagedIacExecutorPlugin();
    // The write is rejected BEFORE docker is ever invoked; trigger surfaces the error (the
    // reconcile loop treats it as a retryable failure) — crucially, no container was created.
    await expect(
      plugin.trigger(ctx(), {
        kind: "sync",
        targetRef: "t1",
        parameters: { iacAction: "plan", sourceFiles: { "../escape.tf": "# evil" } },
        idempotencyKey: "k1"
      })
    ).rejects.toThrow(/illegal source filename/);
    expect(createCall()).toBeUndefined();
  }, 10_000);
});

describe("@scp/plugin-managed-iac: config validation", () => {
  it("throws when runnerImage is missing (server-governed — Mode 2 not enabled)", async () => {
    const plugin = createManagedIacExecutorPlugin();
    const badCtx = ctx();
    (badCtx.config as Record<string, unknown>).runnerImage = undefined;
    await expect(
      plugin.trigger(badCtx, { kind: "sync", targetRef: "t1", idempotencyKey: "k1" })
    ).rejects.toThrow(/runnerImage/);
    expect(createCall()).toBeUndefined();
  });
});

describe("@scp/plugin-managed-iac: rollback fail-closed (CRITICAL-adjacent)", () => {
  it("no priorStateRef -> failed, NEVER launches a container", async () => {
    const plugin = createManagedIacExecutorPlugin();
    const ref = await plugin.trigger(ctx(), {
      kind: "rollback",
      targetRef: "t1",
      idempotencyKey: "k1"
    });
    expect(createCall()).toBeUndefined();
    expect((await plugin.status(ctx(), ref)).phase).toBe("failed");
  });

  it("priorStateRef not under state-history/ -> failed, NEVER launches a container (jail)", async () => {
    const plugin = createManagedIacExecutorPlugin();
    const ref = await plugin.trigger(ctx(), {
      kind: "rollback",
      targetRef: "t1",
      priorStateRef: "/etc/passwd",
      idempotencyKey: "k1"
    });
    expect(createCall()).toBeUndefined();
    expect((await plugin.status(ctx(), ref)).phase).toBe("failed");
  });

  it("priorStateRef with '..' traversal -> failed (jail)", async () => {
    const plugin = createManagedIacExecutorPlugin();
    const ref = await plugin.trigger(ctx(), {
      kind: "rollback",
      targetRef: "t1",
      priorStateRef: "state-history/../../../etc/passwd",
      idempotencyKey: "k1"
    });
    expect(createCall()).toBeUndefined();
    expect((await plugin.status(ctx(), ref)).phase).toBe("failed");
  });
});

describe("@scp/plugin-managed-iac: idempotency + secret redaction", () => {
  it("the SAME idempotencyKey returns the cached ref WITHOUT a second container launch", async () => {
    const plugin = createManagedIacExecutorPlugin();
    const c = ctx();
    const first = await plugin.trigger(c, {
      kind: "sync",
      targetRef: "t1",
      parameters: { iacAction: "plan" },
      idempotencyKey: "same-key"
    });
    const createsAfterFirst = dockerCalls.filter((x) => x.args[0] === "create").length;
    const second = await plugin.trigger(c, {
      kind: "sync",
      targetRef: "t1",
      parameters: { iacAction: "plan" },
      idempotencyKey: "same-key"
    });
    expect(second.externalId).toBe(first.externalId);
    // No new `create` for the deduped call.
    expect(dockerCalls.filter((x) => x.args[0] === "create").length).toBe(createsAfterFirst);
  });

  it("redacts resolved secret VALUES out of the stdout evidence returned via status()", async () => {
    startBehavior = {
      ok: true,
      stdout: "provider used token super-secret-value in plan",
      stderr: ""
    };
    const plugin = createManagedIacExecutorPlugin();
    const c = ctx({ infraCredsSecretKeys: { PROVIDER_TOKEN: "provider-token-key" } }, async (k) =>
      k === "provider-token-key" ? "super-secret-value" : undefined
    );
    const ref = await plugin.trigger(c, {
      kind: "sync",
      targetRef: "t1",
      parameters: { iacAction: "plan" },
      idempotencyKey: "k1"
    });
    const status = await plugin.status(c, ref);
    expect(status.phase).toBe("succeeded");
    expect(status.detail).not.toContain("super-secret-value");
    expect(status.detail).toContain("***");

    // ================================================================================================
    // THIS ASSERTION IS THE INVERSE OF WHAT IT USED TO BE, AND THE REVERSAL IS THE FIX.
    // ================================================================================================
    // It read:
    //
    //     // The secret WAS injected into the container env (as -e PROVIDER_TOKEN=...), just
    //     // redacted from evidence.
    //     expect(createArgs).toContain("PROVIDER_TOKEN=super-secret-value");
    //
    // — an accurate record of M23.0's defect 3, and a test that PINNED it. The credential was on the
    // `create` argv, readable in the host process table by any local process, and reproduced
    // verbatim inside `err.message` on every failed `create` (`Command failed: docker create …
    // -e PROVIDER_TOKEN=super-secret-value …`), which `subprocess-entry.ts` serialises across the
    // plugin-host RPC boundary and into a server log. "Redacted from the evidence" was true and was
    // never the channel that mattered.
    //
    // The credential now travels as `secretEnv` — a mode-0600 `--env-file` the adapter unlinks the
    // instant `create` returns. THE POSITIVE HALF (that it still reaches the runner at all) is
    // pinned in `launch-argv.golden.test.ts`, which snapshots the file's contents while `create` is
    // in flight; here the claim is only the negative, over EVERY element of EVERY call.
    for (const call of dockerCalls) {
      for (const arg of call.args) {
        expect(arg, `a docker argv carried the credential VALUE: ${arg}`).not.toContain(
          "super-secret-value"
        );
      }
    }
    expect(createCall()!.args, "the credential is delivered by env-file, not by -e").toContain(
      "--env-file"
    );
  });
});
