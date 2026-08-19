import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RUNNER_DETAIL_MAX_CHARS,
  RunnerLaunchError,
  classifyRunnerFailure,
  type RunnerLauncher
} from "@scp/runner-launcher";
import {
  BUMP_SPEC,
  DECLARED_MANIFEST_PATHS,
  PACKAGE_JSON_BASE,
  githubHandler,
  recordingCtx
} from "./write-test-support.js";
import { __resetManagedDepOutcomes, createManagedDepExecutorPlugin } from "./index.js";

/**
 * HIGH (M23.0 verification pass 7) — THE THIRD PLUGIN, AND THE GAP WAS MEASURED RATHER THAN
 * ASSUMED. When `output.slice(-FAILURE_OUTPUT_TAIL_CHARS)` -> `output.slice(0, …)` was applied to
 * `@scp/runner-launcher` and rebuilt through `dist`, the suites answered:
 *
 *     runner-launcher   2 failed | 135 passed     managed-iac    3 failed | 26 passed
 *     managed-scan      3 failed |  39 passed     managed-dep  242 passed   <- this file's reason
 *
 * managed-dep front-sliced `runnerOutcomeDetail(run)` at 2000 characters exactly as managed-scan
 * did, so it carried the same defect at every output size — and its whole 242-test suite was
 * indifferent to the mechanism being inverted. A green that a mutation cannot move is not coverage.
 *
 * THIS PLUGIN HAS A SECOND, DISTINCT WRITE OF THE SAME CLASS and it is the more interesting one.
 * The other two compose `detail` only from strings they authored plus the runner's output. This one
 * also quotes MANIFEST TEXT — `verdict.detail` embeds the changed line of the file the tenant's own
 * repository supplied and the runner returned. That is the one `detail` in the three plugins whose
 * length is chosen by a HOSTILE INPUT rather than by an unlucky tool, and it does not pass through
 * `classifyRunnerFailure` at all, so the port's bound is not what protects it. Its arm is below.
 */

const REAL_CAUSE = "npm ERR! code EACCES: permission denied, open '/work/out/manifest'";

function failingLauncher(noiseChars: number): RunnerLauncher {
  const line = "npm WARN deprecated a@1.0.0: this is noise printed on the way to the error\n";
  const noise = line.repeat(Math.ceil(noiseChars / line.length)).slice(0, noiseChars);
  const stderr = `${noise}${REAL_CAUSE}\n`;
  return {
    async run() {
      const err = new RunnerLaunchError({
        step: "start",
        file: "docker",
        argv: ["start", "-a", "scp-runner-managed-dep--k"],
        cause: Object.assign(new Error(`Command failed: docker start -a c\n${stderr}`), {
          code: 1,
          killed: false,
          signal: null,
          stdout: "",
          stderr
        }),
        redactions: []
      });
      return { succeeded: false, stdout: "", stderr, failure: classifyRunnerFailure(err) };
    },
    reap: async () => []
  };
}

/** A runner that SUCCEEDS and returns a manifest the verifiers refuse, with the refusal's quoted
 *  line sized by the caller — the hostile-input axis. */
function hostileManifestLauncher(lineChars: number): RunnerLauncher {
  const edited = PACKAGE_JSON_BASE.replace(
    '  "version": "0.1.0",',
    `  "version": "${"x".repeat(lineChars)}",`
  );
  return {
    async run(spec) {
      if (spec.copyOut) {
        await writeFile(join(spec.copyOut.hostDir, "manifest"), edited, "utf8");
      }
      return { succeeded: true, stdout: "", stderr: "" };
    },
    reap: async () => []
  };
}

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

let workspaceRoot: string;

beforeEach(async () => {
  __resetManagedDepOutcomes();
  workspaceRoot = await mkdtemp(join(tmpdir(), "managed-dep-detail-"));
});

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

function depCtx() {
  const { ctx } = recordingCtx(githubHandler({}, {}));
  return {
    ...ctx,
    config: {
      runnerImage: "scp-runner-dep:vetted",
      workspaceRoot,
      appId: "12345",
      installationId: "67890",
      privateKeyPem
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

async function runAndRead(launcher: RunnerLauncher, key: string) {
  const plugin = createManagedDepExecutorPlugin(() => launcher);
  const ctx = depCtx();
  const ref = await plugin.trigger(ctx, npmIntent(key));
  return plugin.status(ctx, ref);
}

describe("HIGH: a failed bump's own last words reach status().detail at every output size", () => {
  it.each([1_500, 5_000, 50_000])(
    "the cause survives %i characters of runner output",
    async (noiseChars) => {
      const status = await runAndRead(failingLauncher(noiseChars), `dep-bound-${noiseChars}`);
      expect(status.phase).toBe("failed");
      // BOTH ENDS. The plugin's own framing — which manifest it was editing — is at the front, and
      // the runner's last line at the back; the middle is the noise npm printed getting there.
      expect(status.detail).toContain("the runner failed to edit 'package.json'");
      expect(status.detail, "the tail is unreachable again").toContain(REAL_CAUSE);
      expect(status.detail!.length).toBeLessThanOrEqual(RUNNER_DETAIL_MAX_CHARS);
    }
  );

  it("THE OUTCOME MAP ENTRY IS BOUNDED, not just the value status() returns", async () => {
    // `outcomes` is a module-level `Map` keyed by `externalId` that nothing prunes — the same
    // per-key growth property as managed-iac's on-disk ledger, in RAM. Sized at 2 MB, where an
    // entry holding the whole string is unmissable next to one holding 4000 characters.
    const status = await runAndRead(failingLauncher(2_000_000), "dep-cache-1");
    expect(status.phase).toBe("failed");
    expect(status.detail!.length).toBeLessThanOrEqual(RUNNER_DETAIL_MAX_CHARS);
    expect(status.detail).toContain(REAL_CAUSE);
  });
});

describe("HIGH: the refusal that quotes TENANT MANIFEST TEXT is bounded too", () => {
  it("a 500 KB changed line cannot make the refusal a 500 KB record — and 'nothing was written' survives", async () => {
    // THE AXIS THE PORT'S BOUND DOES NOT COVER. This run SUCCEEDS at the runner and is refused by
    // `verifyManifestBump`, so `classifyRunnerFailure` never executes; the string's length is
    // picked by the bytes the repository holds. Without the bound at this call site the plugin
    // would store half a megabyte per key and hand it to `reconcile.ts` to become a `Decision` row.
    const status = await runAndRead(hostileManifestLauncher(500_000), "dep-hostile-1");
    expect(status.phase).toBe("failed");
    expect(status.detail!.length).toBeLessThanOrEqual(RUNNER_DETAIL_MAX_CHARS);

    // THE HEAD NAMES THE VERDICT — an operator must be able to tell a refusal from a crash.
    expect(status.detail).toContain("REFUSED (wrong_declaration_changed)");
    // ...AND THE TAIL CARRIES THE FACT THAT MATTERS MOST OPERATIONALLY. This is why the bound keeps
    // both ends rather than truncating: under a front-slice the reassurance that no commit and no
    // pull request exist is the very first thing lost, and it is the sentence that decides whether
    // a human goes looking at the repository at 3am.
    expect(status.detail!.endsWith("Nothing was written to 'acme/widget'.")).toBe(true);
  });
});
