import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@scp/plugin-api";

/**
 * Unit tests (no Docker — every `docker` invocation is mocked, so these run on every PR under
 * `pnpm test`). They assert the SECURITY-critical properties the ADR-0020 / managed-iac model
 * demands: the container always launches with `--network none`, NO bind mount, NO docker.sock; the
 * scan subject is copied IN and evidence copied OUT rather than mounted; an unsupported method or
 * missing server-controlled dirs fail CLOSED WITHOUT touching docker; and a non-zero scanner run is
 * reported failed (so a broken scan never masquerades as clean).
 */

interface DockerCall {
  file: string;
  args: string[];
}
const dockerCalls: DockerCall[] = [];
let startBehavior: { ok: boolean; stdout: string; stderr: string } = { ok: true, stdout: "ok", stderr: "" };

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
        cb(null, { stdout: "scan-container-abc\n", stderr: "" });
      } else if (sub === "start") {
        if (startBehavior.ok) cb(null, { stdout: startBehavior.stdout, stderr: startBehavior.stderr });
        else {
          const err = Object.assign(new Error("container exited non-zero"), {
            stdout: startBehavior.stdout,
            stderr: startBehavior.stderr
          });
          cb(err);
        }
      } else {
        cb(null, { stdout: "", stderr: "" }); // cp / rm
      }
    }
  };
});

const { createManagedScanExecutorPlugin } = await import("./index.js");

let scratch: string;

beforeEach(async () => {
  dockerCalls.length = 0;
  startBehavior = { ok: true, stdout: "ok", stderr: "" };
  scratch = await mkdtemp(join(tmpdir(), "managed-scan-unit-"));
});
afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

function ctx(overrides: Record<string, unknown> = {}): PluginContext {
  return {
    orgId: "org-1",
    domainId: "domain-1",
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    secrets: { get: async () => undefined },
    http: {
      request: async () => {
        throw new Error("managed-scan: never calls ctx.http");
      }
    },
    config: { runnerImage: "scp-runner-scan:vetted", networkMode: "none", ...overrides }
  };
}
function createCall(): DockerCall | undefined {
  return dockerCalls.find((c) => c.args[0] === "create");
}

describe("@scp/plugin-managed-scan: container isolation", () => {
  it("launches the vetted image with --network none, NO -v bind mount, and NO docker.sock", async () => {
    const plugin = createManagedScanExecutorPlugin();
    const ref = await plugin.trigger(ctx(), {
      kind: "custom",
      parameters: { method: "trivy", inputDir: join(scratch, "oci"), outputDir: join(scratch, "out") }
    });
    const create = createCall();
    expect(create).toBeDefined();
    const args = create!.args;
    expect(args).toContain("--network");
    expect(args[args.indexOf("--network") + 1]).toBe("none");
    expect(args).toContain("scp-runner-scan:vetted");
    expect(args[args.length - 1]).toBe("trivy");
    expect(args).not.toContain("-v");
    expect(args.join(" ")).not.toContain("docker.sock");
    // Subject copied IN to /work/image, evidence copied OUT of /work/out.
    const cpIn = dockerCalls.find((c) => c.args[0] === "cp" && c.args[2]?.endsWith(":/work/image"));
    const cpOut = dockerCalls.find((c) => c.args[0] === "cp" && c.args[1]?.endsWith(":/work/out/."));
    expect(cpIn).toBeDefined();
    expect(cpOut).toBeDefined();
    // Container destroyed unconditionally.
    expect(dockerCalls.some((c) => c.args[0] === "rm" && c.args.includes("-f"))).toBe(true);
    expect((await plugin.status(ctx(), ref)).phase).toBe("succeeded");
  });

  it("honours the SERVER-injected networkMode verbatim (never a tenant default)", async () => {
    const plugin = createManagedScanExecutorPlugin();
    await plugin.trigger(ctx({ networkMode: "bridge-for-test" }), {
      kind: "custom",
      parameters: { method: "trivy", inputDir: join(scratch, "oci"), outputDir: join(scratch, "out") }
    });
    const args = createCall()!.args;
    expect(args[args.indexOf("--network") + 1]).toBe("bridge-for-test");
  });
});

describe("@scp/plugin-managed-scan: fail-closed", () => {
  it("an unsupported method fails CLOSED without touching docker (OpenSCAP is a follow-on)", async () => {
    const plugin = createManagedScanExecutorPlugin();
    const ref = await plugin.trigger(ctx(), {
      kind: "custom",
      parameters: { method: "openscap", inputDir: join(scratch, "oci"), outputDir: join(scratch, "out") }
    });
    expect(dockerCalls).toHaveLength(0);
    const st = await plugin.status(ctx(), ref);
    expect(st.phase).toBe("failed");
    expect(st.detail).toContain("unsupported method");
  });

  it("missing server-controlled inputDir/outputDir fails CLOSED without touching docker", async () => {
    const plugin = createManagedScanExecutorPlugin();
    const ref = await plugin.trigger(ctx(), { kind: "custom", parameters: { method: "trivy" } });
    expect(dockerCalls).toHaveLength(0);
    expect((await plugin.status(ctx(), ref)).phase).toBe("failed");
  });

  it("a non-zero scanner run is reported FAILED (a broken scan never masquerades as clean)", async () => {
    startBehavior = { ok: false, stdout: "", stderr: "trivy: db corrupt" };
    const plugin = createManagedScanExecutorPlugin();
    const ref = await plugin.trigger(ctx(), {
      kind: "custom",
      parameters: { method: "trivy", inputDir: join(scratch, "oci"), outputDir: join(scratch, "out") }
    });
    const st = await plugin.status(ctx(), ref);
    expect(st.phase).toBe("failed");
    expect(st.detail).toContain("scan FAILED");
  });

  it("a missing runnerImage (managed scanning not enabled) throws — never a tenant-influenceable default", async () => {
    const plugin = createManagedScanExecutorPlugin();
    await expect(
      plugin.trigger(
        { ...ctx(), config: { networkMode: "none" } },
        { kind: "custom", parameters: { method: "trivy", inputDir: scratch, outputDir: scratch } }
      )
    ).rejects.toThrow(/runnerImage is not configured/);
  });
});
