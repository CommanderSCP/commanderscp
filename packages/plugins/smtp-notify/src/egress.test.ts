import { describe, expect, it } from "vitest";
import { assertHostNotInternal, classifyIp } from "./egress.js";

/**
 * Unit tests for smtp-notify's SSRF internal-range deny-list (MAJOR #6). IP literals only — no DNS,
 * no socket. smtp is a tenant-configurable plugin, so it blocks EVERY non-public target.
 */
describe("smtp-notify egress classifyIp", () => {
  const cases: Array<[string, ReturnType<typeof classifyIp>]> = [
    ["127.0.0.1", "loopback"],
    ["169.254.169.254", "linkLocal"],
    ["0.0.0.0", "unspecified"],
    ["10.0.0.5", "private"],
    ["172.16.0.1", "private"],
    ["192.168.1.1", "private"],
    ["100.64.0.1", "private"],
    ["8.8.8.8", "public"],
    ["::1", "loopback"],
    ["fe80::1", "linkLocal"],
    ["fc00::1", "private"],
    ["::ffff:127.0.0.1", "loopback"],
    ["2606:4700::1111", "public"]
  ];
  for (const [ip, expected] of cases) {
    it(`classifies ${ip} as ${expected}`, () => {
      expect(classifyIp(ip)).toBe(expected);
    });
  }
});

describe("smtp-notify assertHostNotInternal", () => {
  it("blocks every non-public target (metadata/link-local/loopback/private/unspecified)", async () => {
    for (const ip of [
      "127.0.0.1",
      "169.254.169.254",
      "0.0.0.0",
      "10.0.0.5",
      "192.168.1.9",
      "::1",
      "fc00::1"
    ]) {
      await expect(assertHostNotInternal(ip), `expected ${ip} blocked`).rejects.toThrow(
        /internal egress blocked/
      );
    }
  });

  it("permits a public IP", async () => {
    await expect(assertHostNotInternal("8.8.8.8")).resolves.toBeUndefined();
  });
});
