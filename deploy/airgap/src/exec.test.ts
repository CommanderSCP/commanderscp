import { describe, expect, it } from "vitest";
import { CommandError, run, which } from "./exec.js";

describe("run", () => {
  it("returns stdout on success", () => {
    const { stdout } = run("printf", ["%s", "hello"], { log: false });
    expect(stdout).toBe("hello");
  });

  it("throws CommandError with exit code + stderr on failure", () => {
    let caught: unknown;
    try {
      run("sh", ["-c", "echo boom >&2; exit 3"], { log: false });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CommandError);
    const err = caught as CommandError;
    expect(err.exitCode).toBe(3);
    expect(err.stderr).toContain("boom");
  });

  it("passes extra env vars through without discarding process.env", () => {
    const { stdout } = run("sh", ["-c", "echo \"$SCP_AIRGAP_TEST_VAR\""], {
      log: false,
      env: { SCP_AIRGAP_TEST_VAR: "marker-value" }
    });
    expect(stdout.trim()).toBe("marker-value");
  });
});

describe("which", () => {
  it("finds a binary that definitely exists", () => {
    expect(which("sh")).toBe(true);
  });

  it("returns false for a binary that definitely does not exist", () => {
    expect(which("scp-airgap-definitely-not-a-real-binary-xyz")).toBe(false);
  });
});
