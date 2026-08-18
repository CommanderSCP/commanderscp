import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
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

    // THE RUN DIRECTORY IS A `mkdtemp`, so its suffix is the one thing here that cannot be a
    // literal. It is pinned STRUCTURALLY instead — inside the server-governed workspaceRoot, named
    // `scp-dep-*`, with `in`/`out` as siblings — and then used to express the whole-spec equality
    // below, so the only self-derived component is the random suffix.
    const outDir = seen[0]!.copyOut!.hostDir;
    const runDir = dirname(outDir);
    expect(dirname(runDir)).toBe(workspaceRoot);
    expect(basename(runDir).startsWith("scp-dep-")).toBe(true);

    // THE WHOLE SPEC, `toStrictEqual`. See `@scp/plugin-managed-iac`'s file of the same name for the
    // measurement that forced it: with the three goldens deleted, three load-bearing fields could be
    // flipped at once and the whole repo stayed green. Asserting two of eight fields here was the
    // reason a deletion could take the rest to zero.
    expect(seen[0], "managed-dep's RunnerSpec changed").toStrictEqual({
      image: "scp-runner-dep:vetted",
      // FIVE operands for npm — the edit is described entirely on argv. The anchor pair is appended
      // only for the SPLIT shapes (M21.7); npm's parser reports no line, so it is absent here, and
      // a five-operand invocation is byte-for-byte what every previously-shipped image understands.
      operands: ["npm", "package.json", "@acme/lib", "^1.2.3", "^1.4.0"],
      // THE LITERAL, never a config read — this class's charter clause carries no operator
      // qualifier, so `--network none` must not become an operator-settable default (ADR-0032 §8d).
      // The port takes the resolved value; the decision stays at this call site.
      networkMode: "none",
      // NO ENVIRONMENT AT ALL. The runner holds no credential; there is nothing to pass it.
      env: [],
      copyIn: [{ hostDir: join(runDir, "in"), containerPath: "/work/in" }],
      // ONLY ON SUCCESS and NOT guarded — copying out a partial manifest would put unverified bytes
      // where the verifiers read from. `trigger()`'s outer catch is what turns the resulting
      // rejection into a `failed` run, which is this plugin's own answer of the three.
      copyOut: {
        containerPath: "/work/out",
        hostDir: outDir,
        when: "on-success",
        onFailure: "propagate"
      },
      // 5 minutes and 8 MiB — the SMALLEST of the three on both counts, because this runner edits
      // one manifest and prints nothing.
      timeoutMs: 5 * 60_000,
      maxBuffer: 8 * 1024 * 1024
    });
    expect((await plugin.status(ctx, ref)).phase).toBe("succeeded");
  });
});
