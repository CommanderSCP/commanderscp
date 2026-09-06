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
/** `code` and `takesMs` ADDED FOR MEDIUM (verification pass 5) — see the `start` arm below. Without
 *  them this seam could produce exactly ONE kind of `start` failure, so the two shapes an operator
 *  most needs told apart (our own budget killing the scan, and a scanner that exited quietly) were
 *  not expressible here at all. */
let startBehavior: {
  ok: boolean;
  stdout: string;
  stderr: string;
  code?: string | number | null;
  takesMs?: number;
} = {
  ok: true,
  stdout: "ok",
  stderr: ""
};

vi.mock("node:child_process", () => {
  return {
    execFile: (
      file: string,
      args: string[],
      opts: { timeout?: number },
      cb: (err: Error | null, result?: { stdout: string; stderr: string }) => void
    ) => {
      dockerCalls.push({ file, args });
      const sub = args[0];
      if (sub === "create") {
        cb(null, { stdout: "scan-container-abc\n", stderr: "" });
      } else if (sub === "start") {
        // NODE'S OWN RULE FOR `timeout`, modelled only for `start`. A positive `timeout` shorter
        // than the run's duration means Node SIGTERMs the child and rejects with
        // `killed: true, signal: "SIGTERM", code: null` — the shape `@scp/runner-launcher`'s
        // NODE_FAILURE_SHAPES pins against a real child process.
        const takesMs = startBehavior.takesMs ?? 0;
        const timeout = opts?.timeout;
        if (typeof timeout === "number" && timeout > 0 && timeout < takesMs) {
          setTimeout(() => {
            cb(
              Object.assign(new Error(`Command failed: ${file} ${args.join(" ")}`), {
                code: null,
                killed: true,
                signal: "SIGTERM",
                stdout: startBehavior.stdout,
                stderr: startBehavior.stderr
              })
            );
          }, timeout);
          return;
        }
        if (startBehavior.ok)
          cb(null, { stdout: startBehavior.stdout, stderr: startBehavior.stderr });
        else {
          const err = Object.assign(new Error("container exited non-zero"), {
            stdout: startBehavior.stdout,
            stderr: startBehavior.stderr,
            ...(startBehavior.code !== undefined
              ? { code: startBehavior.code, killed: false, signal: null }
              : {})
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
    scopeKey: "domain-1",
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
      parameters: {
        method: "trivy",
        inputDir: join(scratch, "oci"),
        outputDir: join(scratch, "out")
      }
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
    const cpOut = dockerCalls.find(
      (c) => c.args[0] === "cp" && c.args[1]?.endsWith(":/work/out/.")
    );
    expect(cpIn).toBeDefined();
    expect(cpOut).toBeDefined();
    expect(dockerCalls.some((c) => c.args[0] === "rm" && c.args.includes("-f"))).toBe(true);
    expect((await plugin.status(ctx(), ref)).phase).toBe("succeeded");
  });

  it("honours the SERVER-injected networkMode verbatim (never a tenant default)", async () => {
    const plugin = createManagedScanExecutorPlugin();
    await plugin.trigger(ctx({ networkMode: "bridge-for-test" }), {
      kind: "custom",
      parameters: {
        method: "trivy",
        inputDir: join(scratch, "oci"),
        outputDir: join(scratch, "out")
      }
    });
    const args = createCall()!.args;
    expect(args[args.indexOf("--network") + 1]).toBe("bridge-for-test");
  });
});

describe("@scp/plugin-managed-scan: openscap dispatch (M13.3b)", () => {
  it("dispatches openscap with the profile + datastream as trailing run.sh argv", async () => {
    const plugin = createManagedScanExecutorPlugin();
    const ref = await plugin.trigger(ctx(), {
      kind: "custom",
      parameters: {
        method: "openscap",
        inputDir: join(scratch, "oci"),
        outputDir: join(scratch, "out"),
        profile: "xccdf_org.ssgproject.content_profile_standard",
        datastream: "/usr/share/xml/scap/ssg/content/ssg-debian11-ds.xml"
      }
    });
    const args = createCall()!.args;
    // ENTRYPOINT argv after the image: method, profile, datastream (positional, per run.sh contract).
    const imageIdx = args.indexOf("scp-runner-scan:vetted");
    expect(args.slice(imageIdx + 1)).toEqual([
      "openscap",
      "xccdf_org.ssgproject.content_profile_standard",
      "/usr/share/xml/scap/ssg/content/ssg-debian11-ds.xml"
    ]);
    // Still no bind mount / no docker.sock — same isolation as trivy.
    expect(args).not.toContain("-v");
    expect(args.join(" ")).not.toContain("docker.sock");
    expect((await plugin.status(ctx(), ref)).phase).toBe("succeeded");
  });

  it("passes empty positional args when profile/datastream are unset (run.sh applies defaults)", async () => {
    const plugin = createManagedScanExecutorPlugin();
    await plugin.trigger(ctx(), {
      kind: "custom",
      parameters: {
        method: "openscap",
        inputDir: join(scratch, "oci"),
        outputDir: join(scratch, "out")
      }
    });
    const args = createCall()!.args;
    const imageIdx = args.indexOf("scp-runner-scan:vetted");
    expect(args.slice(imageIdx + 1)).toEqual(["openscap", "", ""]);
  });
});

describe("@scp/plugin-managed-scan: trivy-vm dispatch (13.3a machine-image arm)", () => {
  it("dispatches trivy-vm with NO trailing args and the SAME isolation as trivy", async () => {
    const plugin = createManagedScanExecutorPlugin();
    const ref = await plugin.trigger(ctx(), {
      kind: "custom",
      parameters: {
        method: "trivy-vm",
        inputDir: join(scratch, "oci"),
        outputDir: join(scratch, "out")
      }
    });
    const args = createCall()!.args;
    const imageIdx = args.indexOf("scp-runner-scan:vetted");
    // The machine-image arm takes no profile/datastream — the method IS the whole argv tail.
    expect(args.slice(imageIdx + 1)).toEqual(["trivy-vm"]);
    // The isolation model is not relaxed for a bigger subject: still --network none, still no bind
    // mount (a multi-GiB disk is `docker cp`'d in like everything else), still no docker.sock.
    expect(args[args.indexOf("--network") + 1]).toBe("none");
    expect(args).not.toContain("-v");
    expect(args.join(" ")).not.toContain("docker.sock");
    // Subject copied IN to /work/image (the machine image rides the same copy-in seam), evidence out.
    expect(dockerCalls.some((c) => c.args[0] === "cp" && c.args[2]?.endsWith(":/work/image"))).toBe(
      true
    );
    expect(dockerCalls.some((c) => c.args[0] === "cp" && c.args[1]?.endsWith(":/work/out/."))).toBe(
      true
    );
    expect(dockerCalls.some((c) => c.args[0] === "rm" && c.args.includes("-f"))).toBe(true);
    expect((await plugin.status(ctx(), ref)).phase).toBe("succeeded");
  });

  it("carries the pre-loaded Trivy DB into a machine-image scan (the DB seam is not trivy-only)", async () => {
    const plugin = createManagedScanExecutorPlugin();
    await plugin.trigger(ctx(), {
      kind: "custom",
      parameters: {
        method: "trivy-vm",
        inputDir: join(scratch, "oci"),
        outputDir: join(scratch, "out"),
        scanDbDir: join(scratch, "db")
      }
    });
    const args = createCall()!.args;
    // A `trivy vm` scan reads the SAME vulnerability DB as `trivy image`; if the pre-load env were
    // wired for `trivy` only, this arm would silently scan against the image-baked (stale) DB.
    expect(args).toContain("SCP_SCAN_DB_DIR=/work/db");
    expect(dockerCalls.some((c) => c.args[0] === "cp" && c.args[2]?.endsWith(":/work/db"))).toBe(
      true
    );
  });

  it("a non-zero trivy-vm run (e.g. an unrecognized disk format) is reported FAILED", async () => {
    // run.sh exits 4 when it cannot resolve exactly one machine-image disk from the layout — the
    // fail-closed refusal. The orchestrator must surface that as a FAILED run so the commander
    // deposits no evidence and E6 refuses; it must never be smoothed into a clean result.
    startBehavior = {
      ok: false,
      stdout: "",
      stderr: "scp-runner-scan: trivy-vm — expected exactly ONE machine-image disk file"
    };
    const plugin = createManagedScanExecutorPlugin();
    const ref = await plugin.trigger(ctx(), {
      kind: "custom",
      parameters: {
        method: "trivy-vm",
        inputDir: join(scratch, "oci"),
        outputDir: join(scratch, "out")
      }
    });
    const st = await plugin.status(ctx(), ref);
    expect(st.phase).toBe("failed");
    expect(st.detail).toContain("scan FAILED");
    expect(st.detail).toContain("ONE machine-image disk");
  });
});

describe("@scp/plugin-managed-scan: fail-closed", () => {
  it("an unsupported method fails CLOSED without touching docker", async () => {
    const plugin = createManagedScanExecutorPlugin();
    const ref = await plugin.trigger(ctx(), {
      kind: "custom",
      parameters: {
        method: "grype",
        inputDir: join(scratch, "oci"),
        outputDir: join(scratch, "out")
      }
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
      parameters: {
        method: "trivy",
        inputDir: join(scratch, "oci"),
        outputDir: join(scratch, "out")
      }
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

/**
 * ================================================================================================
 * MEDIUM (verification pass 5) — A FAILED SCAN'S RECORDED REASON IS NEVER THE EMPTY STRING
 * ================================================================================================
 *
 * This plugin built its failure detail as `managed-scan: <method> scan FAILED — ${result.stderr}`.
 * `promisify(execFile)` always attaches `stderr` as a string, so for a scan WE killed on the budget
 * and for a `docker` that never spawned that expression produced the literal `scan FAILED — ` and
 * stopped — and `status().detail` is what `reconcile.ts` copies into a `block` Decision's
 * `inputContext`, and what E6 quotes when it refuses a promotion for want of evidence. An operator
 * chasing a blocked release got a sentence that ends in an em dash.
 *
 * `runnerOutcomeDetail` is the wiring; these are the arms that die when it is removed.
 */
describe("MEDIUM (pass 5): a failed scan records WHY, not an empty string", () => {
  async function scanAndRead(key: string): Promise<{ phase: string; detail: string }> {
    const plugin = createManagedScanExecutorPlugin();
    const c = ctx({ timeoutMs: 60 });
    const ref = await plugin.trigger(c, {
      kind: "custom",
      idempotencyKey: key,
      parameters: {
        method: "trivy",
        inputDir: join(scratch, "oci"),
        outputDir: join(scratch, "out")
      }
    });
    const st = await plugin.status(c, ref);
    return { phase: st.phase, detail: st.detail ?? "" };
  }

  it("A BUDGET-KILLED SCAN AND A SILENT NON-ZERO EXIT ARE DIFFERENT RECORDS IN status()", async () => {
    startBehavior = { ok: true, stdout: "", stderr: "", takesMs: 400 };
    const killed = await scanAndRead("scan-budget-kill");

    startBehavior = { ok: false, stdout: "", stderr: "", code: 3 };
    const exited = await scanAndRead("scan-silent-exit");

    expect([killed.phase, exited.phase]).toStrictEqual(["failed", "failed"]);
    // The old shape: `scan FAILED — ` for both, which is 30 characters of nothing. The lengths are
    // asserted against the PREFIX rather than against zero, because the prefix was never the part
    // that went missing.
    for (const { detail } of [killed, exited]) {
      const afterPrefix = detail.slice(detail.indexOf("scan FAILED — ") + "scan FAILED — ".length);
      expect(afterPrefix.length, "the recorded reason is the empty string").toBeGreaterThan(0);
    }
    expect(killed.detail).not.toBe(exited.detail);
    expect(killed.detail).toContain("budget-exhausted");
    expect(exited.detail).toContain("exit-nonzero");
    expect(exited.detail).toContain("code=3");
  });

  it("A SUCCESSFUL SCAN STILL RECORDS WHERE THE EVIDENCE LANDED, not a status line", async () => {
    // The success arm is deliberately NOT `runnerOutcomeDetail` here — unlike managed-iac, this
    // plugin's evidence is a file, and a Trivy report on stdout can run to 32 MiB. A fix that
    // unified the two arms would put that report in an in-memory cache and in every Decision.
    startBehavior = { ok: true, stdout: "x".repeat(5_000), stderr: "" };
    const ok = await scanAndRead("scan-evidence");

    expect(ok.phase).toBe("succeeded");
    expect(ok.detail).toContain("evidence at");
    expect(ok.detail).not.toContain("xxxxx");
  });
});
