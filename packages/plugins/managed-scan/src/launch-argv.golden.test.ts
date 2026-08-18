import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@scp/plugin-api";

/**
 * ================================================================================================
 * M23.0 — THE GOLDEN DOCKER ARGV FOR `scp-managed-scan`, RECORDED BEFORE ANYTHING MOVES
 * ================================================================================================
 *
 * WHY THIS FILE EXISTS, AND WHY M23.1 DID NOT RETIRE IT.
 * M23 extracts a `RunnerLauncher` port so the three managed executors can also launch their runners
 * as Kubernetes Jobs. That refactor's central promise is that **the Docker path is byte-for-byte
 * unchanged**. A promise like that is only checkable if the current bytes were written down FIRST,
 * by a test that existed BEFORE the refactor — otherwise the "unchanged" baseline is whatever the
 * refactor happens to emit, and the assertion is a tautology.
 *
 * THE PARAGRAPH THAT USED TO SIT HERE WAS WRONG, AND THIS ONE REPLACES IT. It said that until
 * M23.1 landed the port this file was the definition of "unchanged", and that when the port landed
 * these tests were "to be **deleted or superseded** by the port's own conformance suite". M23.1 HAS
 * LANDED. It did NOT retire this file, and that standing instruction is withdrawn — because the
 * port's conformance suite (`packages/runner-launcher/src/docker-adapter.test.ts`) and this file
 * prove DIFFERENT things, and neither implies the other:
 *   - THE CONFORMANCE SUITE drives `createDockerRunnerLauncher` DIRECTLY. Its subject is what the
 *     adapter emits FOR A GIVEN `RunnerSpec` — argv, per-call `timeout`/`maxBuffer`, both copy-out
 *     axes, the failure paths. A `RunnerSpec` is its INPUT.
 *   - THIS FILE drives `plugin.trigger()`. Its subject is THE OTHER HALF, which the conformance
 *     suite structurally cannot reach: that this plugin still hands the port THE SAME SPEC it used
 *     to build by hand. A spec field changed here — a copy-IN that stopped being conditional, or
 *     an `onFailure: "propagate"` relaxed to `"swallow"` — produces a perfectly CONFORMANT launch
 *     of the WRONG container, and the conformance suite is blind to it, because that spec is what
 *     it is handed rather than what it checks.
 * Deleting this file on the strength of the old sentence would take the plugin→port boundary to
 * ZERO coverage while every task stayed green — the vacuous-green class BUILD_AND_TEST.md §4.4
 * names, and the same reason `@scp/runner-launcher` no longer runs with `--passWithNoTests`.
 * RETIRE THIS FILE ONLY ALONGSIDE SOMETHING THAT COVERS THAT BOUNDARY, never merely alongside
 * something that covers the adapter.
 *
 * WHAT IS PINNED, AND WHY EACH PART IS PART OF THE PROMISE.
 *  1. THE FULL argv ARRAY of every `execFile`, in order. Asserted as an array against a literal,
 *     never as "contains" or as a call count: a renamed binary, a reordered flag or a dropped
 *     operand must fail, and must fail by PRINTING the actual argv next to the expected one.
 *  2. THE OPTIONS OBJECT alongside each argv. managed-scan runs 10 min / **32 MiB** — the largest
 *     of the three, because a Trivy report is the biggest thing any of these runners writes to
 *     stdout — while managed-iac is 16 MiB and managed-dep 8 MiB. `rm` alone carries a 30 s timeout
 *     AND NO `maxBuffer` AT ALL. A port that unified those into one shared default would be a
 *     behaviour change wearing a refactor's clothes. `toStrictEqual` is what makes the ABSENCE of
 *     `maxBuffer` on `rm` — and the absence of any `cwd`/`env` anywhere — part of the record.
 *  3. THE CONDITIONALITY THAT IS SPECIFIC TO THIS PLUGIN: managed-scan issues **one to three**
 *     copy-IN calls. The subject layout always; `/work/db` only when the server resolved a
 *     pre-loaded Trivy DB; `/work/scap` only when it resolved SSG content (M13.3b-ii). Each
 *     optional copy is paired with its own `-e` on the `create` line, and the `-e` pairs come in a
 *     fixed order that is not the same order as the copies would need to be discovered in. All of
 *     that is pinned, not normalised.
 *  4. THE FAILURE PATH: on a rejected `start` there is **no copy-out at all** — the opposite of
 *     managed-iac, which copies out unconditionally. And this plugin's copy-out is **not**
 *     catch-guarded, so a failed copy-out escapes `trigger()` rather than being swallowed. Both
 *     halves of that asymmetry are measured below.
 *
 * THE RECORDING SEAM is the one this package already uses — `vi.mock("node:child_process")` with a
 * hand-written `execFile`, the same shape as `index.test.ts` here and `runner-containment.test.ts`
 * in `@scp/plugin-managed-dep`. The only widening is that the options object (which those files
 * discard as `_opts`) is now recorded too, because point 2 above is half the promise. No Docker is
 * required, so these run on every PR under `pnpm test`.
 */

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

vi.mock("node:child_process", () => {
  return {
    execFile: (
      file: string,
      args: string[],
      opts: unknown,
      cb: (err: Error | null, result?: { stdout: string; stderr: string }) => void
    ) => {
      calls.push({ file, args, opts });
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

/**
 * THE OPTIONS, AS LITERALS. Deliberately NOT imported from `index.ts`: a golden that re-derives its
 * expectation from the code it is guarding cannot detect a change to that code. 10 minutes and
 * 32 MiB are written here because that is what the plugin does TODAY.
 */
const RUN_OPTS = { timeout: 10 * 60_000, maxBuffer: 32 * 1024 * 1024 };
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
        args: ["create", "--network", "none", "scp-runner-scan:vetted", "trivy"],
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
      { file: "docker", args: ["rm", "-f", "scan-container-abc"], opts: RM_OPTS }
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

    const opts = { timeout: 123_456, maxBuffer: 32 * 1024 * 1024 };
    expect(calls, "the managed-scan maximal Docker launch argv changed").toStrictEqual([
      {
        file: "/usr/local/bin/docker",
        args: [
          "create",
          "--network",
          "scp-scan-egress",
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
      { file: "/usr/local/bin/docker", args: ["rm", "-f", "scan-container-abc"], opts: RM_OPTS }
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
      { file: "docker", args: ["rm", "-f", "scan-container-abc"], opts: RM_OPTS }
    ]);

    expect((await plugin.status(ctx(), ref)).phase).toBe("succeeded");
  });

  it("THE FOURTH COMBINATION — SCAP content but NO Trivy DB: TWO copies in and the OTHER single `-e`", async () => {
    // The `-e` pairs and the copy-INs are INDEPENDENTLY conditional, so the two preload flags span
    // four combinations: neither (test 1), both (test 2), DB-only (test 3) — and this one, which was
    // the only one left unpinned. Without it, a launcher that emitted `SCP_SCAN_DB_DIR` whenever ANY
    // preload was present, or that copied `/work/db` from `scanScapDir`, passes all three others: no
    // test above ever exercises `scanScapDir` WITHOUT `scanDbDir`, so the second condition is only
    // ever observed while the first is also true. Rare in production (SSG has no OCI upstream to
    // refresh, §13.3b's documented asymmetry) but reachable — an air-gapped site that seeded SSG
    // content by hand and lets Trivy use the image's own bundled DB is exactly this shape.
    //
    // It also pins the `""` positional arm: openscap with neither `profile` nor `datastream` puts
    // TWO EMPTY STRING OPERANDS on the command line, which is what lets run.sh's `${2:-default}`
    // form apply its own defaults. A launcher that dropped empty operands instead of passing them
    // would shift `datastream` into `profile`'s position and nothing else would notice.
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
      { file: "docker", args: ["rm", "-f", "scan-container-abc"], opts: RM_OPTS }
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
        args: ["create", "--network", "none", "scp-runner-scan:vetted", "trivy"],
        opts: RUN_OPTS
      },
      {
        file: "docker",
        args: ["cp", `${inputDir}/.`, "scan-container-abc:/work/image"],
        opts: RUN_OPTS
      },
      { file: "docker", args: ["start", "-a", "scan-container-abc"], opts: RUN_OPTS },
      { file: "docker", args: ["rm", "-f", "scan-container-abc"], opts: RM_OPTS }
    ]);

    const status = await plugin.status(ctx(), ref);
    expect(status.phase).toBe("failed");
    expect(status.detail).toContain("trivy: boom");
  });

  it("A FAILED COPY-OUT IS NOT SWALLOWED — it escapes `trigger()`, and `rm` still runs", async () => {
    // The second half of the asymmetry: managed-iac wraps its copy-out in `.catch(() => undefined)`;
    // managed-scan does not, so the same Docker failure that leaves an iac run "succeeded" makes a
    // scan `trigger()` REJECT — no outcome is cached, so `status()` reports `pending`, not `failed`.
    // Recorded as behaviour, without judgement: whether it should reject is an M23.1 question, but
    // it must not change silently while the refactor is called byte-for-byte identical.
    cpOutOk = false;
    const inputDir = join(scratch, "oci");
    const outputDir = join(scratch, "out");
    const plugin = createManagedScanExecutorPlugin();
    await expect(
      plugin.trigger(ctx(), {
        kind: "custom",
        idempotencyKey: "k5",
        parameters: { method: "trivy", inputDir, outputDir }
      })
    ).rejects.toThrow(/docker cp/);

    expect(calls.map((c) => c.args[0])).toStrictEqual(["create", "cp", "start", "cp", "rm"]);
    expect(calls.at(-1)).toStrictEqual({
      file: "docker",
      args: ["rm", "-f", "scan-container-abc"],
      opts: RM_OPTS
    });
    expect((await plugin.status(ctx(), { externalId: "managed-scan::k5" })).phase).toBe("pending");
  });
});
