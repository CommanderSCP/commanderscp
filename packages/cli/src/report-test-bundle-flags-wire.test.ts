import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChangeReportRequestSchema } from "@scp/schemas";

/**
 * `scp change-source report` — THE D23/D13 FLAGS ACTUALLY REACH THE REQUEST BODY.
 *
 * ============================================================================================
 * WHAT WAS BROKEN, AND WHY IT MADE THE WHOLE INCREMENT UNREACHABLE FROM CI
 * ============================================================================================
 * Increment 8 shipped `ChangeReportRequestSchema.commitSha` (#316), `.testBundle` (#316) and
 * `.artifactClass` (#317), and the CLI could send NONE of them — it had `--sbom-*` and
 * `--artifact-digest` and stopped there. `scp change-source report` is THE channel a build declares
 * through (a raw provider webhook cannot carry any of this), so in practice no CI step could produce
 * a D23 pin at all: `deriveCapturedWorkflow` needs the declared workflow, the built commit AND the
 * bundle, and two of those three had no flag. Every declared hook would trigger, terminalize, write
 * no evidence, and hold its wave forever with a correctly-named reason nobody could act on.
 *
 * That is charter principle 3 (API → SDK → CLI → IaC → UI) failing at the CLI rung, and it is the
 * same built-never-installed shape #317 closed one layer down — which is why this file asserts the
 * VALUES ON THE WIRE and not merely that the options are registered. A flag that parses into a
 * variable nothing threads is exactly as useless as no flag, and `stage-dependencies-flags.test.ts`
 * (registration + pure parsers) could not tell the two apart. The `dependency-read-verbs-wire`
 * lesson applies verbatim: a `return;` at the top of the action leaves a fully green package.
 *
 * Every asserted body is parsed by `ChangeReportRequestSchema` itself rather than compared to a
 * retyped literal, so a future contract change cannot leave these flags emitting a shape the API
 * refuses.
 */

const reportCalls: { sourceKind: string; req: Record<string, unknown> }[] = [];

vi.mock("@scp/sdk", () => {
  class ScpApiError extends Error {}
  class ScpClient {
    changeSources = {
      report: async (sourceKind: string, req: Record<string, unknown>) => {
        reportCalls.push({ sourceKind, req });
        return { eventId: "01a00000-0000-7000-8000-000000000001", accepted: true };
      }
    };
  }
  return { ScpClient, ScpApiError, reconcileStaleClaimants: () => null };
});

let configDir: string;

beforeEach(async () => {
  reportCalls.length = 0;
  configDir = await mkdtemp(path.join(tmpdir(), "scp-report-flags-"));
  process.env.SCP_CONFIG_DIR = configDir;
  await writeFile(
    path.join(configDir, "credentials.json"),
    JSON.stringify({
      baseUrl: "http://localhost:8080/api/v1",
      token: "tok",
      org: "acme",
      expiresAt: "2030-01-01T00:00:00Z"
    })
  );
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.SCP_CONFIG_DIR;
  await rm(configDir, { recursive: true, force: true });
});

async function run(args: string[]): Promise<void> {
  const { buildProgram } = await import("./cli.js");
  await buildProgram().parseAsync(["node", "scp", ...args]);
}

const BUNDLE_DIGEST = `sha256:${"7c".repeat(32)}`;
const COMMIT = "9".repeat(40);

const base = ["change-source", "report", "terraform", "--status", "applied", "--repo", "acme/api"];

describe("scp change-source report — the D23/D13 flags reach the wire", () => {
  it("sends commitSha, testBundle and artifactClass as the schema shapes them", async () => {
    await run([
      ...base,
      "--commit-sha",
      COMMIT,
      "--test-bundle-repository",
      "acme/api-tests",
      "--test-bundle-digest",
      BUNDLE_DIGEST,
      "--artifact-class",
      "image"
    ]);

    expect(reportCalls).toHaveLength(1);
    const req = reportCalls[0]!.req;
    expect(req.commitSha).toBe(COMMIT);
    // The nested shape matters as much as the values: the server reads `sourceRef.testBundle` as a
    // `TestBundleRef`, and two flat keys would be dropped by that parse and quarantined.
    expect(req.testBundle).toEqual({ repository: "acme/api-tests", digest: BUNDLE_DIGEST });
    expect(req.artifactClass).toBe("image");
    // Parsed by the real contract, not a literal — a strictObject, so an extra or misnamed key here
    // would throw rather than silently pass.
    expect(() => ChangeReportRequestSchema.parse(req)).not.toThrow();
  });

  it("omitting them sends nothing at all — absent, not null or empty", async () => {
    // THE ADDITIVE PROPERTY at the CLI rung. Every existing CI step invokes exactly this form, and
    // an emitted `testBundle: undefined` key would still be a key on a `strictObject` body.
    await run(base);

    const req = reportCalls[0]!.req;
    expect("commitSha" in req && req.commitSha !== undefined).toBe(false);
    expect(req.testBundle).toBeUndefined();
    expect(req.artifactClass).toBeUndefined();
    expect(() => ChangeReportRequestSchema.parse(req)).not.toThrow();
  });

  it("REFUSES a half-declared bundle, and never calls the SDK", async () => {
    // All-or-nothing, like the SBOM reference. A half pin is dropped by the server's
    // `TestBundleRefSchema` parse and quarantined on `sourceRef`, so the gate would hold forever
    // with a reason naming a bundle the operator believes they sent. Failing here names the flag.
    await expect(run([...base, "--test-bundle-repository", "acme/api-tests"])).rejects.toThrow(
      /--test-bundle-repository and --test-bundle-digest must be given together/
    );
    await expect(run([...base, "--test-bundle-digest", BUNDLE_DIGEST])).rejects.toThrow(
      /must be given together/
    );
    expect(reportCalls).toHaveLength(0);
  });

  it("REFUSES an unknown artifact class locally, naming the valid set, without calling the SDK", async () => {
    // The door would 400 this anyway (closed enum on a strictObject), but a CI step that typed
    // `Image` deserves the valid set rather than a wire error.
    await expect(run([...base, "--artifact-class", "Image"])).rejects.toThrow(
      /--artifact-class must be one of image\|rpm\|deb/
    );
    expect(reportCalls).toHaveLength(0);
  });

  it("accepts every build-family class the contract does", async () => {
    // Guards against the CLI's local list drifting from the schema's: each value is sent AND parsed
    // by `ChangeReportRequestSchema`, so a class the CLI allows but the contract rejects fails here.
    for (const cls of [
      "image",
      "rpm",
      "deb",
      "npm",
      "maven",
      "python",
      "go",
      "chart",
      "vm-image"
    ]) {
      reportCalls.length = 0;
      await run([...base, "--artifact-class", cls]);
      const req = reportCalls[0]!.req;
      expect(req.artifactClass).toBe(cls);
      expect(() => ChangeReportRequestSchema.parse(req)).not.toThrow();
    }
  });

  it("REFUSES the two non-build types — infrastructure and configuration are not artifact classes", async () => {
    for (const cls of ["infrastructure", "configuration"]) {
      await expect(run([...base, "--artifact-class", cls])).rejects.toThrow(/must be one of/);
    }
    expect(reportCalls).toHaveLength(0);
  });
});
