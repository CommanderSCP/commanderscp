import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PluginContext } from "@scp/plugin-api";
import { resolveRunnerImage } from "@scp/plugin-testkit";
import { resolveSkopeo } from "@scp/cosign";
import { createManagedScanExecutorPlugin, __resetManagedScanOutcomes } from "./index.js";

/** REAL-DOCKER PLUGIN-LEVEL INTEGRATION TEST. See docs/plugins.md §493. */

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNNER_SCAN_CONTEXT = resolve(__dirname, "../../../../apps/runner-scan");
const RUNNER_IMAGE_TAG = "scp-runner-scan:m23-plugin-integration-test";
/** LEVER 1, mirrors managed-iac's: the image tests actually run — pre-built GHCR ref in CI
 *  (`SCP_RUNNER_SCAN_IMAGE_REF`), or a local legacy-builder build (dev fallback). */
let runnerImageRef = RUNNER_IMAGE_TAG;

const SUBJECT_REGISTRY = process.env.SCP_TEST_SUBJECT_REGISTRY ?? "docker.io/library";
const CLEAN_SRC = `docker://${SUBJECT_REGISTRY}/alpine:3.20`;

async function dockerAvailable(): Promise<boolean> {
  try {
    await execFileAsync("docker", ["info"], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

function buildCtx(overrides: Record<string, unknown> = {}): PluginContext {
  return {
    orgId: "test-org",
    scopeKey: "test-domain",
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    secrets: { get: async () => undefined }, // a scan reads bytes already pulled; no infra creds
    http: {
      request: async () => {
        throw new Error("managed-scan plugin integration test: plugin never calls ctx.http");
      }
    },
    config: {
      // Server-governed fields (production: executor-bindings-repo.ts's managedScanServerSettings).
      // `networkMode: "none"` is asserted, not assumed — the offline trivy scan succeeding under it
      // (baked DB, --skip-db-update) IS the network-isolation proof.
      runnerImage: runnerImageRef,
      networkMode: "none",
      timeoutMs: 90_000,
      ...overrides
    }
  };
}

describe.runIf(await dockerAvailable())(
  "managed-scan: real scp-runner-scan container (Docker required)",
  () => {
    const plugin = createManagedScanExecutorPlugin();
    let inputDir: string;
    let scratchRoot: string;

    beforeAll(async () => {
      const resolved = resolveSkopeo();
      if (resolved.source === "missing") {
        throw new Error(
          "managed-scan integration test: skopeo binary not found (vendored or PATH)"
        );
      }
      const skopeoBin = resolved.bin;

      scratchRoot = await mkdtemp(join(tmpdir(), "scp-managed-scan-plugin-it-"));
      const ociDir = join(scratchRoot, "subject-oci");

      // Pull the runner image and the subject layout in parallel — independent, both slow on a
      // cold cache.
      [runnerImageRef] = await Promise.all([
        resolveRunnerImage({
          refEnvVar: "SCP_RUNNER_SCAN_IMAGE_REF",
          localTag: RUNNER_IMAGE_TAG,
          context: RUNNER_SCAN_CONTEXT
        }),
        // The SAME command `promotion-scan-step.ts`'s server-side pull runs (`--all
        // --preserve-digests … oci:<dir>:scan`) — this file's subject is real bytes pulled the
        // production way, not a hand-built fixture layout.
        execFileAsync(
          skopeoBin,
          ["copy", "--all", "--preserve-digests", CLEAN_SRC, `oci:${ociDir}:scan`],
          { timeout: 120_000, maxBuffer: 64 * 1024 * 1024 }
        )
      ]);
      inputDir = ociDir;
    }, 300_000);

    afterAll(async () => {
      await rm(scratchRoot, { recursive: true, force: true });
    });

    it(
      "trigger() -> status(): a real container scans a real OCI layout, --network none, and copies " +
        "evidence back to the path this plugin promises",
      async () => {
        __resetManagedScanOutcomes();
        const outputDir = join(scratchRoot, "out-primary");
        const ctx = buildCtx();

        const ref = await plugin.trigger(ctx, {
          kind: "custom",
          targetRef: "subject",
          parameters: { method: "trivy", inputDir, outputDir },
          idempotencyKey: "trivy-primary"
        });

        const status = await plugin.status(ctx, ref);
        expect(status.phase, status.detail).toBe("succeeded");
        expect(status.detail).toContain(`${outputDir}/result.json`);

        // The evidence this plugin promises, actually on disk — copied OUT of a container that has
        // already been `rm -f`'d by the time trigger() returns (synchronous trigger, module doc).
        const raw = await readFile(join(outputDir, "result.json"), "utf8");
        const evidence = JSON.parse(raw) as { Results?: unknown };
        expect(Array.isArray(evidence.Results)).toBe(true);
      },
      180_000
    );

    it(
      "a same-idempotencyKey retry against a REAL container is safe: this plugin does NOT dedup " +
        "(module doc — a scan is a fresh, stateless, read-only analysis with no cross-restart " +
        "state to preserve, unlike managed-iac's apply), so a retry re-runs a real container rather " +
        "than serving a cached outcome — proven here by an independently broken dockerBinary on the " +
        "retry surfacing as a REAL failure rather than the first run's cached success — while the " +
        "externalId it reports is stable and derived from the key",
      async () => {
        __resetManagedScanOutcomes();
        const outputDir = join(scratchRoot, "out-retry");
        const ctx = buildCtx();

        const first = await plugin.trigger(ctx, {
          kind: "custom",
          targetRef: "subject",
          parameters: { method: "trivy", inputDir, outputDir },
          idempotencyKey: "trivy-retry"
        });
        expect((await plugin.status(ctx, first)).phase).toBe("succeeded");

        // NOT a dedup proof — the opposite: the retry actually tries to invoke docker again (no
        // cache short-circuits it), so a broken dockerBinary on the retry surfaces as a REAL
        // failure, overwriting the first run's cached success under the same externalId.
        const brokenCtx = buildCtx({
          dockerBinary: "/nonexistent/docker-binary-proves-a-real-retry"
        });
        const second = await plugin.trigger(brokenCtx, {
          kind: "custom",
          targetRef: "subject",
          parameters: { method: "trivy", inputDir, outputDir },
          idempotencyKey: "trivy-retry"
        });
        expect(second.externalId).toBe(first.externalId);
        expect((await plugin.status(ctx, second)).phase).toBe("failed");
      },
      180_000
    );

    it("an unsupported method fails closed WITHOUT touching docker at all", async () => {
      __resetManagedScanOutcomes();
      const brokenDockerCtx = buildCtx({
        dockerBinary: "/nonexistent/docker-binary-proves-no-invocation"
      });
      const ref = await plugin.trigger(brokenDockerCtx, {
        kind: "custom",
        targetRef: "subject",
        parameters: {
          method: "not-a-real-method",
          inputDir,
          outputDir: join(scratchRoot, "unused")
        },
        idempotencyKey: "unsupported-method"
      });
      const status = await plugin.status(brokenDockerCtx, ref);
      expect(status.phase).toBe("failed");
      expect(status.detail).toContain("unsupported method");
    });
  }
);
