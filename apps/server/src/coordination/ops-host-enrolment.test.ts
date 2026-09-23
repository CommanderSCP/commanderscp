import { describe, expect, it } from "vitest";
import { EnrolmentGenerationError, trustedUserCaKeysFile } from "./ops-host-enrolment.js";

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
