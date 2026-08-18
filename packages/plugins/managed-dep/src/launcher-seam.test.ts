import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunnerLauncher, RunnerSpec } from "@scp/runner-launcher";
import {
  BUMP_SPEC,
  DECLARED_MANIFEST_PATHS,
  PACKAGE_JSON_BUMPED,
  githubHandler,
  recordingCtx
} from "./write-test-support.js";
import { __resetManagedDepOutcomes, createManagedDepExecutorPlugin } from "./index.js";

/**
 * M23.1 — THE STANDING GATE THAT THE PORT IS INSTALLED, not merely present.
 *
 * See `@scp/plugin-managed-iac`'s file of the same name for why this is separate from
 * `launch-argv.golden.test.ts`. The golden proves the Docker bytes are unchanged; it would keep
 * passing if this plugin kept a private copy of the launch sequence and `@scp/runner-launcher` were
 * dead code beside it. Deleting the wiring — here, by injecting a launcher that throws — is the only
 * check that tells the two apart.
 *
 * WHERE THE FAILURE LANDS IS THIS PLUGIN'S OWN ANSWER, and pinning it is half the point: managed-dep
 * wraps the whole run in a try/catch, so a launcher failure becomes a FAILED outcome rather than a
 * rejection (managed-iac rejects out of `trigger()`; managed-scan rejects and leaves the run stuck
 * `pending`). Three call sites, three answers, all three preserved by the port.
 *
 * IT ALSO PINS THAT NO WRITE HAPPENED. A launch that never ran must not leave a commit or a pull
 * request behind, and the run credential must still be revoked.
 */

function throwingLauncher(): RunnerLauncher {
  return {
    run(): Promise<never> {
      throw new Error("managed-dep test: the injected RunnerLauncher was reached");
    }
  };
}

function recordingLauncher(seen: RunnerSpec[], outDirBox: { path?: string }): RunnerLauncher {
  return {
    async run(spec) {
      seen.push(spec);
      // Stand in for the runner's product, so the orchestrator's verifiers run and the outcome is a
      // real `succeeded` rather than "the runner produced no manifest".
      outDirBox.path = spec.copyOut?.hostDir;
      if (spec.copyOut) {
        await writeFile(join(spec.copyOut.hostDir, "manifest"), PACKAGE_JSON_BUMPED, "utf8");
      }
      return { succeeded: true, stdout: "", stderr: "" };
    }
  };
}

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

let workspaceRoot: string;

beforeEach(async () => {
  __resetManagedDepOutcomes();
  workspaceRoot = await mkdtemp(join(tmpdir(), "managed-dep-seam-"));
});

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

function depCtx() {
  const { ctx, calls } = recordingCtx(githubHandler({}, {}));
  return {
    httpCalls: calls,
    ctx: {
      ...ctx,
      config: {
        runnerImage: "scp-runner-dep:vetted",
        workspaceRoot,
        appId: "12345",
        installationId: "67890",
        privateKeyPem
      }
    }
  };
}

function npmIntent(key: string) {
  return {
    kind: "custom" as const,
    idempotencyKey: key,
    parameters: {
      ecosystem: BUMP_SPEC.ecosystem,
      coordinate: BUMP_SPEC.coordinate,
      manifestPath: BUMP_SPEC.manifestPath,
      declaredManifestPaths: DECLARED_MANIFEST_PATHS,
      fromVersion: BUMP_SPEC.fromVersion,
      toVersion: BUMP_SPEC.toVersion,
      repo: "acme/widget",
      baseBranch: "main",
      changeObjectId: "0198f3c1-1111-7000-8000-00000000000a",
      delivery: "pull_request"
    }
  };
}

describe("M23.1: managed-dep launches through the injected RunnerLauncher", () => {
  it("a launcher that throws makes the run FAIL — the plugin has no second, private launch path", async () => {
    const plugin = createManagedDepExecutorPlugin(() => throwingLauncher());
    const { ctx, httpCalls } = depCtx();
    const ref = await plugin.trigger(ctx, npmIntent("seam-1"));

    const status = await plugin.status(ctx, ref);
    expect(status.phase).toBe("failed");
    expect(status.detail).toContain("the injected RunnerLauncher was reached");
    // Nothing was written to the repository, and the run credential was still revoked.
    expect(httpCalls.some((c) => c.method === "PUT" && c.url.includes("/contents/"))).toBe(false);
    expect(
      httpCalls.some((c) => c.method === "DELETE" && c.url.endsWith("/installation/token"))
    ).toBe(true);
  });

  it("the resolver is handed the server-injected dockerBinary and NOTHING else, and the spec carries no env", async () => {
    const seen: RunnerSpec[] = [];
    const resolverSaw: Record<string, unknown>[] = [];
    const outDirBox: { path?: string } = {};
    const plugin = createManagedDepExecutorPlugin((config) => {
      resolverSaw.push({ ...config });
      return recordingLauncher(seen, outDirBox);
    });
    const { ctx } = depCtx();
    const ref = await plugin.trigger(ctx, npmIntent("seam-2"));

    // `toStrictEqual` on the WHOLE object: the absence of any further adapter-selection key is the
    // assertion, because every key here joins the server-injected, never-tenant-settable class.
    // The value is `"docker"` rather than `undefined` because `asConfig` already applied this
    // package's own unit-test fallback before the resolver ever sees it — in production the server
    // injects `SCP_MANAGED_RUNNER_DOCKER_BINARY` and the fallback is never reached.
    expect(resolverSaw).toStrictEqual([{ dockerBinary: "docker" }]);
    expect(seen).toHaveLength(1);
    // The two charter properties this class states unconditionally, restated at the port boundary:
    // no environment at all, and `--network none` as a literal that no context can move.
    expect(seen[0]!.env).toStrictEqual([]);
    expect(seen[0]!.networkMode).toBe("none");
    expect((await plugin.status(ctx, ref)).phase).toBe("succeeded");
  });
});
