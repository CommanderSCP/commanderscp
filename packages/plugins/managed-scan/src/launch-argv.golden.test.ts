import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@scp/plugin-api";
import { RUNNER_LAUNCHER_DEADLINE_LABEL, RUNNER_LAUNCHER_OWNER_LABEL } from "@scp/runner-launcher";

/** The golden Docker argv, recorded before anything moves. See docs/plugins.md §484. */

interface ExecFileCall {
  file: string;
  args: string[];
  opts: unknown;
}

/** Every `execFile` of the run, in the order the plugin issued them. */
const calls: ExecFileCall[] = [];

let startOk = true;
/** Copy-OUT outcome. managed-scan does NOT guard it; that is what the last test measures. */
let cpOutOk = true;

/** M23.1 PHASE 4 — the reaper. See docs/plugins.md §485. */
function stripLauncherLabel(args: string[], key: string): string[] {
  const flagIndex = args.findIndex(
    (a, i) => a === "--label" && (args[i + 1] ?? "").startsWith(`${key}=`)
  );
  return flagIndex === -1 ? args : [...args.slice(0, flagIndex), ...args.slice(flagIndex + 2)];
}
function stripLauncherLabels(args: string[]): string[] {
  return stripLauncherLabel(
    stripLauncherLabel(args, RUNNER_LAUNCHER_OWNER_LABEL),
    RUNNER_LAUNCHER_DEADLINE_LABEL
  );
}

vi.mock("node:child_process", () => {
  return {
    execFile: (
      file: string,
      args: string[],
      opts: unknown,
      cb: (err: Error | null, result?: { stdout: string; stderr: string }) => void
    ) => {
      if (args[0] === "ps") {
        setImmediate(() => cb(null, { stdout: "", stderr: "" }));
        return;
      }
      calls.push({ file, args: args[0] === "create" ? stripLauncherLabels(args) : args, opts });
      const sub = args[0];
      if (sub === "create") {
        cb(null, { stdout: "scan-container-abc\n", stderr: "" });
        return;
      }
      if (sub === "start") {
        if (startOk) {
          cb(null, { stdout: "scan ok", stderr: "" });
        } else {
          cb(
            Object.assign(new Error("container exited non-zero"), {
              stdout: "",
              stderr: "trivy: boom"
            })
          );
        }
        return;
      }
      if (sub === "cp" && String(args[1]).includes(":/work/out/.") && !cpOutOk) {
        cb(new Error("docker cp: no such file or directory"));
        return;
      }
      cb(null, { stdout: "", stderr: "" }); // cp in / cp db / cp scap / cp out / rm
    }
  };
});

const { createManagedScanExecutorPlugin } = await import("./index.js");

/** The options: the buffer as a literal, the timeout as a bound. See docs/plugins.md §486. */
const BUDGET_SLACK_MS = 5_000;
function runOpts(budgetMs: number, maxBuffer: number): unknown {
  return {
    timeout: {
      asymmetricMatch: (actual: unknown): boolean =>
        typeof actual === "number" && actual > budgetMs - BUDGET_SLACK_MS && actual <= budgetMs,
      toAsymmetricMatcher: (): string =>
        `RemainingBudget(>${budgetMs - BUDGET_SLACK_MS}, <=${budgetMs})`,
      toString: (): string => "RemainingBudget"
    },
    maxBuffer
  };
}
const RUN_OPTS = runOpts(10 * 60_000, 32 * 1024 * 1024);
/** The teardown call's own options — a shorter timeout and, notably, NO `maxBuffer`. */
const RM_OPTS = { timeout: 30_000 };

let scratch: string;

beforeEach(async () => {
  calls.length = 0;
  startOk = true;
  cpOutOk = true;
  scratch = await mkdtemp(join(tmpdir(), "managed-scan-golden-"));
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

describe("M23.0 golden: the `scp-managed-scan` runner launch, byte for byte", () => {
  it("DEFAULT — trivy, no pre-loaded content: create / cp image / start / cp out / rm", async () => {
    // ONE copy-in. The `create` line carries no `-e` at all, and the method is the last operand.
    const inputDir = join(scratch, "oci");
    const outputDir = join(scratch, "out");
    const plugin = createManagedScanExecutorPlugin();
    const ref = await plugin.trigger(ctx(), {
      kind: "custom",
      idempotencyKey: "k1",
      parameters: { method: "trivy", inputDir, outputDir }
    });

    expect(calls, "the managed-scan Docker launch argv changed").toStrictEqual([
      {
        file: "docker",
        args: [
          "create",
          "--network",
          "none",
          "--name",
          "scp-runner-k1",
          "--label",
          "scp.executor=scp-managed-scan",
          "--label",
          "scp.run-id=k1",
          "scp-runner-scan:vetted",
          "trivy"
        ],
        opts: RUN_OPTS
      },
      {
        file: "docker",
        args: ["cp", `${inputDir}/.`, "scan-container-abc:/work/image"],
        opts: RUN_OPTS
      },
      { file: "docker", args: ["start", "-a", "scan-container-abc"], opts: RUN_OPTS },
      {
        file: "docker",
        args: ["cp", "scan-container-abc:/work/out/.", outputDir],
        opts: RUN_OPTS
      },
      { file: "docker", args: ["rm", "-f", "scp-runner-k1"], opts: RM_OPTS }
    ]);

    // ...and the run really completed, so none of the above passed by nothing having happened.
    expect((await plugin.status(ctx(), ref)).phase).toBe("succeeded");
  });

  it("EVERY OPTIONAL INPUT PRESENT — openscap with profile, datastream, DB and SCAP preloads: THREE copies in", async () => {
    // THE MAXIMAL SHAPE. Both `-e` pairs on the `create` line in DB-then-SCAP order; the two extra
    // operands after the method are openscap's positional `profile` and `datastream`; and THREE
    // copy-in calls in subject / db / scap order, before a single `start`.
    const inputDir = join(scratch, "oci");
    const outputDir = join(scratch, "out");
    const scanDbDir = join(scratch, "trivy-db");
    const scanScapDir = join(scratch, "ssg");
    const plugin = createManagedScanExecutorPlugin();
    const c = ctx({
      dockerBinary: "/usr/local/bin/docker",
      networkMode: "scp-scan-egress",
      timeoutMs: 123_456
    });
    const ref = await plugin.trigger(c, {
      kind: "custom",
      idempotencyKey: "k2",
      parameters: {
        method: "openscap",
        inputDir,
        outputDir,
        profile: "xccdf_org.ssgproject.content_profile_standard",
        datastream: "/usr/share/xml/scap/ssg/content/ssg-debian11-ds.xml",
        scanDbDir,
        scanScapDir
      }
    });

    const opts = runOpts(123_456, 32 * 1024 * 1024);
    expect(calls, "the managed-scan maximal Docker launch argv changed").toStrictEqual([
      {
        file: "/usr/local/bin/docker",
        args: [
          "create",
          "--network",
          "scp-scan-egress",
          "--name",
          "scp-runner-k2",
          "--label",
          "scp.executor=scp-managed-scan",
          "--label",
          "scp.run-id=k2",

          "-e",
          "SCP_SCAN_DB_DIR=/work/db",
          "-e",
          "SCP_SCAN_SCAP_DIR=/work/scap",
          "scp-runner-scan:vetted",
          "openscap",
          "xccdf_org.ssgproject.content_profile_standard",
          "/usr/share/xml/scap/ssg/content/ssg-debian11-ds.xml"
        ],
        opts
      },
      {
        file: "/usr/local/bin/docker",
        args: ["cp", `${inputDir}/.`, "scan-container-abc:/work/image"],
        opts
      },
      {
        file: "/usr/local/bin/docker",
        args: ["cp", `${scanDbDir}/.`, "scan-container-abc:/work/db"],
        opts
      },
      {
        file: "/usr/local/bin/docker",
        args: ["cp", `${scanScapDir}/.`, "scan-container-abc:/work/scap"],
        opts
      },
      { file: "/usr/local/bin/docker", args: ["start", "-a", "scan-container-abc"], opts },
      {
        file: "/usr/local/bin/docker",
        args: ["cp", "scan-container-abc:/work/out/.", outputDir],
        opts
      },
      // THE TEARDOWN TIMEOUT IS NOT THE RUN TIMEOUT. A tenant `timeoutMs` of 123456 does not reach
      // `rm`, which keeps its own literal 30 s and still carries no `maxBuffer`.
      { file: "/usr/local/bin/docker", args: ["rm", "-f", "scp-runner-k2"], opts: RM_OPTS }
    ]);

    expect((await plugin.status(c, ref)).phase).toBe("succeeded");
  });

  it("THE MIDDLE CASE — a Trivy DB preload but no SCAP content: TWO copies in and ONE `-e`", async () => {
    // Without this the one-to-three conditionality is only pinned at its endpoints, and a launcher
    // that emitted both `-e` pairs whenever EITHER preload was present would pass both of the tests
    // above. This is the shape the commander actually uses in production (`trivy` + a preloaded DB;
    // SSG has no OCI upstream to refresh, so `scanScapDir` is rare — §13.3b's documented asymmetry).
    const inputDir = join(scratch, "oci");
    const outputDir = join(scratch, "out");
    const scanDbDir = join(scratch, "trivy-db");
    const plugin = createManagedScanExecutorPlugin();
    const ref = await plugin.trigger(ctx(), {
      kind: "custom",
      idempotencyKey: "k3",
      parameters: { method: "trivy-vm", inputDir, outputDir, scanDbDir }
    });

    expect(calls, "the managed-scan DB-only Docker launch argv changed").toStrictEqual([
      {
        file: "docker",
        args: [
          "create",
          "--network",
          "none",
          "--name",
          "scp-runner-k3",
          "--label",
          "scp.executor=scp-managed-scan",
          "--label",
          "scp.run-id=k3",

          "-e",
          "SCP_SCAN_DB_DIR=/work/db",
          "scp-runner-scan:vetted",
          "trivy-vm"
        ],
        opts: RUN_OPTS
      },
      {
        file: "docker",
        args: ["cp", `${inputDir}/.`, "scan-container-abc:/work/image"],
        opts: RUN_OPTS
      },
      {
        file: "docker",
        args: ["cp", `${scanDbDir}/.`, "scan-container-abc:/work/db"],
        opts: RUN_OPTS
      },
      { file: "docker", args: ["start", "-a", "scan-container-abc"], opts: RUN_OPTS },
      { file: "docker", args: ["cp", "scan-container-abc:/work/out/.", outputDir], opts: RUN_OPTS },
      { file: "docker", args: ["rm", "-f", "scp-runner-k3"], opts: RM_OPTS }
    ]);

    expect((await plugin.status(ctx(), ref)).phase).toBe("succeeded");
  });

  it("THE FOURTH COMBINATION — SCAP content but NO Trivy DB: TWO copies in and the OTHER single `-e`", async () => {
    // The env pairs and copy-ins are independently conditional. See docs/plugins.md §487.
    const inputDir = join(scratch, "oci");
    const outputDir = join(scratch, "out");
    const scanScapDir = join(scratch, "ssg");
    const plugin = createManagedScanExecutorPlugin();
    const ref = await plugin.trigger(ctx(), {
      kind: "custom",
      idempotencyKey: "k3b",
      parameters: { method: "openscap", inputDir, outputDir, scanScapDir }
    });

    expect(calls, "the managed-scan SCAP-only Docker launch argv changed").toStrictEqual([
      {
        file: "docker",
        args: [
          "create",
          "--network",
          "none",
          "--name",
          "scp-runner-k3b",
          "--label",
          "scp.executor=scp-managed-scan",
          "--label",
          "scp.run-id=k3b",

          "-e",
          "SCP_SCAN_SCAP_DIR=/work/scap",
          "scp-runner-scan:vetted",
          "openscap",
          "",
          ""
        ],
        opts: RUN_OPTS
      },
      {
        file: "docker",
        args: ["cp", `${inputDir}/.`, "scan-container-abc:/work/image"],
        opts: RUN_OPTS
      },
      {
        file: "docker",
        args: ["cp", `${scanScapDir}/.`, "scan-container-abc:/work/scap"],
        opts: RUN_OPTS
      },
      { file: "docker", args: ["start", "-a", "scan-container-abc"], opts: RUN_OPTS },
      { file: "docker", args: ["cp", "scan-container-abc:/work/out/.", outputDir], opts: RUN_OPTS },
      { file: "docker", args: ["rm", "-f", "scp-runner-k3b"], opts: RM_OPTS }
    ]);

    expect((await plugin.status(ctx(), ref)).phase).toBe("succeeded");
  });

  it("FAILURE — `start` rejects, and NO evidence is copied out; only `rm` follows", async () => {
    // THE ASYMMETRY, MEASURED. managed-iac copies its workspace out even after a failed `start`;
    // managed-scan does not, because a failed scan must produce NO evidence (fail-closed — E6 then
    // refuses). A refactor that gives all three launchers one shared sequence must break either this
    // test or managed-iac's mirror of it.
    startOk = false;
    const inputDir = join(scratch, "oci");
    const outputDir = join(scratch, "out");
    const plugin = createManagedScanExecutorPlugin();
    const ref = await plugin.trigger(ctx(), {
      kind: "custom",
      idempotencyKey: "k4",
      parameters: { method: "trivy", inputDir, outputDir }
    });

    expect(calls, "the managed-scan FAILED-run Docker sequence changed").toStrictEqual([
      {
        file: "docker",
        args: [
          "create",
          "--network",
          "none",
          "--name",
          "scp-runner-k4",
          "--label",
          "scp.executor=scp-managed-scan",
          "--label",
          "scp.run-id=k4",
          "scp-runner-scan:vetted",
          "trivy"
        ],
        opts: RUN_OPTS
      },
      {
        file: "docker",
        args: ["cp", `${inputDir}/.`, "scan-container-abc:/work/image"],
        opts: RUN_OPTS
      },
      { file: "docker", args: ["start", "-a", "scan-container-abc"], opts: RUN_OPTS },
      { file: "docker", args: ["rm", "-f", "scp-runner-k4"], opts: RM_OPTS }
    ]);

    const status = await plugin.status(ctx(), ref);
    expect(status.phase).toBe("failed");
    expect(status.detail).toContain("trivy: boom");
  });

  it("A FAILED COPY-OUT IS NOT SWALLOWED — it is RECORDED as failed, and `rm` still runs", async () => {
    // The second half of the asymmetry. See docs/plugins.md §488.
    cpOutOk = false;
    const inputDir = join(scratch, "oci");
    const outputDir = join(scratch, "out");
    const plugin = createManagedScanExecutorPlugin();
    const ref = await plugin.trigger(ctx(), {
      kind: "custom",
      idempotencyKey: "k5",
      parameters: { method: "trivy", inputDir, outputDir }
    });

    expect(calls.map((c) => c.args[0])).toStrictEqual(["create", "cp", "start", "cp", "rm"]);
    expect(calls.at(-1)).toStrictEqual({
      file: "docker",
      // BY NAME, not by the id `create` printed — see managed-iac's golden for why the two
      // identities differ and which one teardown must use.
      args: ["rm", "-f", "scp-runner-k5"],
      opts: RM_OPTS
    });
    const status = await plugin.status(ctx(), ref);
    expect(status.phase).toBe("failed");
    expect(status.detail).toMatch(/docker cp/);
  });
});
