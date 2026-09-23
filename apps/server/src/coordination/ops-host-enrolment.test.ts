import { describe, expect, it } from "vitest";
import {
  EnrolmentGenerationError,
  sudoersFragment,
  trustedUserCaKeysFile
} from "./ops-host-enrolment.js";

const CA = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICSwjEuBHgqItZu7begnhRtU+k7sUAWz71Q3F/JVYOSb";

describe("trustedUserCaKeysFile", () => {
  it("emits exactly one key and a newline", () => {
    expect(trustedUserCaKeysFile(CA)).toBe(`${CA}\n`);
  });

  it("refuses a key that spans lines — that would install a SECOND trust anchor", () => {
    // The file is a trust anchor list. A second line is a second authority nobody decided to trust,
    // and it would be invisible in a diff that only showed the first.
    expect(() => trustedUserCaKeysFile(`${CA}\n${CA}`)).toThrow(EnrolmentGenerationError);
  });

  it("refuses anything that is not an ed25519 public key", () => {
    expect(() => trustedUserCaKeysFile("-----BEGIN PRIVATE KEY-----")).toThrow(
      EnrolmentGenerationError
    );
    expect(() => trustedUserCaKeysFile("ssh-rsa AAAAB3")).toThrow(EnrolmentGenerationError);
  });
});

describe("sudoersFragment", () => {
  const sets = {
    os_package: { charterClass: "osPackage", commands: ["/usr/bin/apt-get", "/usr/bin/dnf"] },
    scheduled_unit: { charterClass: "cronSystemd", commands: ["/usr/bin/systemctl"] }
  };

  it("grants exactly the catalog's commands, to the certificate's principal", () => {
    const out = sudoersFragment("scp-ops", sets);
    expect(out).toContain("scp-ops ALL=(root) NOPASSWD: /usr/bin/apt-get, /usr/bin/dnf");
    expect(out).toContain("scp-ops ALL=(root) NOPASSWD: /usr/bin/systemctl");
  });

  it("NEVER emits a wildcard", () => {
    // The containment argument for host-reaching execution is that the operations are a bounded,
    // reviewed vocabulary. `NOPASSWD:ALL` replaces that argument with nothing.
    const out = sudoersFragment("scp-ops", sets);
    expect(out).not.toMatch(/NOPASSWD:\s*ALL\s*$/m);
    expect(out).not.toContain("(ALL)");
  });

  it("REFUSES a relative command — the classic sudoers escape", () => {
    // A relative command resolves through PATH at invocation, so a restricted rule becomes
    // unrestricted for anyone who can set PATH.
    expect(() =>
      sudoersFragment("scp-ops", {
        bad: { charterClass: "osPackage", commands: ["apt-get"] }
      })
    ).toThrow(/not an absolute path/);
  });

  it("REFUSES a principal that could terminate the field", () => {
    // Written verbatim into a rule; anything with whitespace or punctuation rewrites the rule
    // rather than filling it in.
    for (const bad of ["scp ops", "scp-ops ALL=(ALL)", "root\nevil", "scp/ops"]) {
      expect(() => sudoersFragment(bad, sets)).toThrow(/not a plain login name/);
    }
  });

  it("REFUSES an empty command set rather than emitting a file that grants nothing", () => {
    // A file granting nothing reads as a successful enrolment while every run fails at its first
    // privileged task — the failure would look like a runner bug, not a missing rule.
    expect(() => sudoersFragment("scp-ops", {})).toThrow(/EMPTY sudoers/);
  });

  it("is byte-stable for the same catalog", () => {
    // Roles and commands are both sorted, so re-running enrolment against an unchanged catalog
    // produces an identical file — and a diff on a host means the catalog really changed.
    expect(sudoersFragment("scp-ops", sets)).toBe(sudoersFragment("scp-ops", sets));
  });
});
