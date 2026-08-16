import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BUMP_SPEC,
  DECLARED_MANIFEST_PATHS,
  PACKAGE_JSON_BUMPED,
  githubHandler,
  recordingCtx
} from "./write-test-support.js";

/**
 * ================================================================================================
 * THE CHARTER'S RUNNER/ORCHESTRATOR SPLIT, MEASURED (charter `scp-managed-dep`, amended 2026-08-15)
 * ================================================================================================
 * The 2026-08-15 amendment states the split in two sentences:
 *
 *   "Runner network egress is `--network none`; the runner holds no credential, contains no package
 *    manager, and edits only the bytes handed to it."
 *   "The orchestrator holds the per-run, repository-scoped, short-lived credential and reaches the
 *    git provider on the runner's behalf."
 *
 * Both halves were previously only DOCUMENTED here. A comment describing a containment property is
 * not the property; this file drives a real `trigger()` with every `docker` invocation mocked (so it
 * runs on every PR under `pnpm test`, no Docker required) and asserts what the container was
 * actually launched with — the same shape, and the same reason, as `@scp/plugin-managed-scan`'s
 * shipped `index.test.ts` containment block.
 *
 * WHAT EACH ASSERTION IS FOR, since a list of `expect`s is not self-explaining:
 *  - `--network none`      — the runner reaches no hosts. Without it, "never resolves a lockfile"
 *                            stops being a property of the image and becomes a hope.
 *  - no `-v`/`--mount`, no docker.sock — nothing of the host is reachable from inside, so a
 *                            path-escape in the editor has nowhere to escape TO. Bytes go in and out
 *                            by `docker cp`.
 *  - no `-e`/`--env`, and the token appears in NO argv — the credential does not cross into the
 *                            runner. This is the half the amendment had to be qualified for, so it
 *                            is the half most worth measuring.
 *  - argv is exactly the five descriptor strings — nothing on that command line can be a file body,
 *                            a host path, or a command.
 *  - the ORCHESTRATOR made the provider calls — the credential is used, but on this side of the
 *                            boundary. Asserted positively so "no network in the runner" cannot be
 *                            satisfied by there being no network anywhere.
 */

interface DockerCall {
  file: string;
  args: string[];
}
const dockerCalls: DockerCall[] = [];
/** The bytes the stand-in runner "produces". Set per test; the copy-OUT mock writes them. */
let editedOutput = PACKAGE_JSON_BUMPED;

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
        cb(null, { stdout: "dep-container-abc\n", stderr: "" });
        return;
      }
      if (sub === "cp" && args[1]?.includes(":/work/out")) {
        // The copy-OUT step is where the runner's product appears. Writing it here is what makes
        // this a stand-in RUNNER rather than a stub: the orchestrator reads real bytes off disk and
        // puts them through both verifiers, exactly as it would with the real image.
        const dest = args[2] as string;
        void writeFile(join(dest, "manifest"), editedOutput, "utf8").then(
          () => cb(null, { stdout: "", stderr: "" }),
          (err: Error) => cb(err)
        );
        return;
      }
      cb(null, { stdout: "", stderr: "" }); // cp-in / start / rm
    }
  };
});

const { createManagedDepExecutorPlugin, __resetManagedDepOutcomes, RUNNER_NETWORK_MODE } =
  await import("./index.js");

let scratch: string;

beforeEach(async () => {
  dockerCalls.length = 0;
  __resetManagedDepOutcomes();
  scratch = await mkdtemp(join(tmpdir(), "managed-dep-unit-"));
  editedOutput = PACKAGE_JSON_BUMPED;
});
afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

const { generateKeyPairSync } = await import("node:crypto");
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

/** The token the fake provider mints — the string that must appear on NO docker command line. */
const RUN_TOKEN = "ghs_run_scoped";

function bumpIntent(overrides: Record<string, unknown> = {}) {
  return {
    kind: "custom" as const,
    idempotencyKey: `run-${Math.random()}`,
    parameters: {
      ecosystem: BUMP_SPEC.ecosystem,
      coordinate: BUMP_SPEC.coordinate,
      manifestPath: BUMP_SPEC.manifestPath,
      declaredManifestPaths: DECLARED_MANIFEST_PATHS,
      fromVersion: BUMP_SPEC.fromVersion,
      toVersion: BUMP_SPEC.toVersion,
      repo: "acme/widget",
      baseBranch: "main",
      changeObjectId: "0198f3c1-1111-7000-8000-000000000001",
      delivery: "pull_request",
      ...overrides
    }
  };
}

function runCtx(configOverrides: Record<string, unknown> = {}) {
  const { ctx, calls } = recordingCtx(githubHandler());
  return {
    ctx: {
      ...ctx,
      config: {
        runnerImage: "scp-runner-dep:vetted",
        networkMode: "none",
        workspaceRoot: scratch,
        appId: "12345",
        installationId: "67890",
        privateKeyPem,
        ...configOverrides
      }
    },
    calls
  };
}

function createCall(): DockerCall | undefined {
  return dockerCalls.find((c) => c.args[0] === "create");
}

describe("the runner half — no network, no credential, no host", () => {
  it("launches the vetted image with --network none, no bind mount and no docker socket", async () => {
    const plugin = createManagedDepExecutorPlugin();
    const { ctx } = runCtx();
    const ref = await plugin.trigger(ctx, bumpIntent());

    const create = createCall();
    expect(create).toBeDefined();
    const args = create!.args;
    expect(args[args.indexOf("--network") + 1]).toBe("none");
    expect(args).toContain("scp-runner-dep:vetted");
    expect(args).not.toContain("-v");
    expect(args).not.toContain("--mount");
    expect(args.join(" ")).not.toContain("docker.sock");
    expect(args).not.toContain("--privileged");

    // Bytes in and out by `docker cp`, and the container destroyed unconditionally.
    expect(dockerCalls.some((c) => c.args[0] === "cp" && c.args[2]?.endsWith(":/work/in"))).toBe(
      true
    );
    expect(dockerCalls.some((c) => c.args[0] === "cp" && c.args[1]?.endsWith(":/work/out/."))).toBe(
      true
    );
    expect(dockerCalls.some((c) => c.args[0] === "rm" && c.args.includes("-f"))).toBe(true);

    // ...and the run actually completed, so none of the above passed by nothing having happened.
    expect((await plugin.status(ctx, ref)).phase).toBe("succeeded");
  });

  it("hands the runner exactly the five descriptor strings — nothing that could be a file body", async () => {
    const plugin = createManagedDepExecutorPlugin();
    const { ctx } = runCtx();
    await plugin.trigger(ctx, bumpIntent());

    const args = createCall()!.args;
    const trailing = args.slice(args.indexOf("scp-runner-dep:vetted") + 1);
    expect(trailing).toEqual([
      BUMP_SPEC.ecosystem,
      BUMP_SPEC.manifestPath,
      BUMP_SPEC.coordinate,
      BUMP_SPEC.fromVersion,
      BUMP_SPEC.toVersion
    ]);
  });

  it("passes NO credential to the container — not on argv, not through -e", async () => {
    const plugin = createManagedDepExecutorPlugin();
    const { ctx, calls } = runCtx();
    await plugin.trigger(ctx, bumpIntent());

    // The orchestrator really did mint the token, so this is a live negative, not a vacuous one.
    expect(calls.some((c) => c.url.endsWith("/access_tokens"))).toBe(true);

    for (const call of dockerCalls) {
      const line = call.args.join(" ");
      expect(line, `a docker command line carried the run token: ${line}`).not.toContain(RUN_TOKEN);
      expect(call.args, "the runner is given no environment").not.toContain("-e");
      expect(call.args, "the runner is given no environment").not.toContain("--env");
      expect(line).not.toContain(privateKeyPem.slice(0, 40));
    }
  });

  it("launches `--network none` UNCONDITIONALLY — a config naming another mode changes nothing", async () => {
    // THIS ASSERTION IS THE INVERSE OF WHAT IT USED TO BE, and the reversal is the charter rather
    // than a change of mind. It previously mirrored `managed-scan`'s "honours the server-injected
    // networkMode" — correct THERE, because the 2026-07-23 amendment QUALIFIES that class's network
    // clause ("excepting operator-allowlisted registry pulls for the subject artifact's bytes"), so
    // an operator setting is exactly what the charter contemplates for it.
    //
    // The `scp-managed-dep` clause carries no such qualifier: "Runner network egress is `--network
    // none`; the runner holds no credential, contains no package manager, and edits only the bytes
    // handed to it" (2026-08-15). An operator-settable knob with a `none` default is an
    // operator-facing way to contradict an unqualified clause, so the value is a LITERAL
    // (`RUNNER_NETWORK_MODE`) and `SCP_MANAGED_DEP_NETWORK_MODE` is now read by nothing.
    const plugin = createManagedDepExecutorPlugin();
    const { ctx } = runCtx({ networkMode: "bridge-for-test" });
    await plugin.trigger(ctx, bumpIntent());
    const args = createCall()!.args;
    expect(RUNNER_NETWORK_MODE).toBe("none");
    expect(args[args.indexOf("--network") + 1]).toBe("none");
  });
});

describe("the orchestrator half — it is the side that holds the credential and reaches the host", () => {
  it("mints a scoped token, opens the pull request, and revokes the token", async () => {
    const plugin = createManagedDepExecutorPlugin();
    const { ctx, calls } = runCtx();
    const ref = await plugin.trigger(ctx, bumpIntent());

    expect(calls.some((c) => c.url.endsWith("/access_tokens"))).toBe(true);
    expect(calls.some((c) => c.method === "PUT" && c.url.includes("/contents/"))).toBe(true);
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/pulls"))).toBe(true);
    expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/installation/token"))).toBe(
      true
    );

    const status = await plugin.status(ctx, ref);
    expect(status.phase).toBe("succeeded");
    expect(status.detail).toContain("@acme/lib");
  });

  /**
   * THE FIRST VERIFIER IS LOAD-BEARING, proven by a case only IT can catch.
   *
   * The runner returns a perfectly well-formed manifest that bumps the right dependency to the
   * WRONG version. `verifyManifestOnlyEdit` accepts it — and is right to: every one of its gates
   * holds (the dependency set is identical, exactly one already-declared version moved, the change
   * is confined to that version's own text). It has no idea which version was ASKED for; that fact
   * lives in the descriptor, which is what `verifyManifestBump` anchors on.
   *
   * This case exists because a mutation run found the gap: deleting the runner-output verdict check
   * left the earlier "added a dependency" case green, since the second verifier caught that one
   * anyway. A refusal that another layer would have caught is not evidence that this layer works.
   */
  it("REFUSES a runner that bumped to a version nobody asked for — the descriptor-anchored check", async () => {
    editedOutput = PACKAGE_JSON_BUMPED.replace('"^1.4.0"', '"^9.9.9"');
    const plugin = createManagedDepExecutorPlugin();
    const { ctx, calls } = runCtx();
    const ref = await plugin.trigger(ctx, bumpIntent());

    const status = await plugin.status(ctx, ref);
    expect(status.phase).toBe("failed");
    expect(status.detail).toContain("non_version_edit");
    expect(calls.some((c) => c.method === "PUT" && c.url.includes("/contents/"))).toBe(false);
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/pulls"))).toBe(false);
  });

  it("REFUSES to publish output the verifiers reject — and reaches the provider's write route not at all", async () => {
    // The runner returns a legitimate bump PLUS an added dependency. That is the failure mode the
    // whole verification layer exists for: the image could be rebuilt wrong, replaced, or simply
    // given a manifest its editor mis-parses, and every layer above would otherwise not be able to
    // tell.
    editedOutput = PACKAGE_JSON_BUMPED.replace(
      '"@acme/lib": "^1.4.0"',
      '"@acme/lib": "^1.4.0",\n    "evil": "1.0.0"'
    );
    const plugin = createManagedDepExecutorPlugin();
    const { ctx, calls } = runCtx();
    const ref = await plugin.trigger(ctx, bumpIntent());

    const status = await plugin.status(ctx, ref);
    expect(status.phase).toBe("failed");
    // Nothing was written: no commit, no pull request. The read of the manifest and the token mint
    // happened (they precede the runner), which is why this asserts on the WRITE routes rather than
    // on a request count.
    expect(calls.some((c) => c.method === "PUT" && c.url.includes("/contents/"))).toBe(false);
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/pulls"))).toBe(false);
    // ...and the credential was still revoked on the way out of the failed run.
    expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/installation/token"))).toBe(
      true
    );
  });
});
