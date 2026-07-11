import { describe, expect, it } from "vitest";
import { assertEgressAllowed, classifyIp } from "./egress-guard.js";

/**
 * Unit tests for the SSRF egress guard (MAJOR #6). All cases use IP LITERALS so `assertEgressAllowed`
 * short-circuits DNS resolution (`isIP` !== 0) and never touches the network — the guard's blocking
 * logic is fully exercised without a real DNS lookup or HTTP server.
 */
describe("classifyIp", () => {
  const cases: Array<[string, ReturnType<typeof classifyIp>]> = [
    ["127.0.0.1", "loopback"],
    ["127.53.1.9", "loopback"],
    ["169.254.169.254", "linkLocal"], // cloud metadata endpoint
    ["169.254.0.1", "linkLocal"],
    ["0.0.0.0", "unspecified"],
    ["10.0.0.5", "private"],
    ["172.16.4.4", "private"],
    ["172.31.255.255", "private"],
    ["172.32.0.1", "public"], // just outside 172.16/12
    ["192.168.1.1", "private"],
    ["100.64.0.1", "private"], // CGNAT
    ["8.8.8.8", "public"],
    ["1.1.1.1", "public"],
    ["::1", "loopback"],
    ["::", "unspecified"],
    ["fe80::1", "linkLocal"],
    ["fc00::1", "private"],
    ["fd12:3456::1", "private"],
    ["2606:4700:4700::1111", "public"],
    ["::ffff:127.0.0.1", "loopback"], // IPv4-mapped loopback
    ["::ffff:169.254.169.254", "linkLocal"],
    ["::ffff:8.8.8.8", "public"]
  ];
  for (const [ip, expected] of cases) {
    it(`classifies ${ip} as ${expected}`, () => {
      expect(classifyIp(ip)).toBe(expected);
    });
  }
});

describe("assertEgressAllowed", () => {
  it("ALWAYS blocks loopback, link-local (metadata), and unspecified — even with the IP allowlisted", async () => {
    for (const ip of ["127.0.0.1", "169.254.169.254", "0.0.0.0", "::1", "fe80::1"]) {
      await expect(
        assertEgressAllowed(`http://${ip.includes(":") ? `[${ip}]` : ip}/x`, [ip]),
        `expected ${ip} blocked even when allowlisted`
      ).rejects.toThrow(/never a permitted plugin egress target|SSRF/);
    }
  });

  it("blocks private ranges for a SCOPED plugin (non-empty allowlist) — 'the DB host is blocked even when allowlisted'", async () => {
    for (const ip of ["10.0.0.5", "172.16.9.9", "192.168.1.50"]) {
      await expect(assertEgressAllowed(`http://${ip}/x`, [ip])).rejects.toThrow(/private/);
    }
  });

  it("PERMITS private ranges for an UNSCOPED escape hatch (empty allowlist) — federation-https/webhook-control internal targets", async () => {
    for (const ip of ["10.0.0.5", "192.168.1.50", "fc00::1"]) {
      await expect(
        assertEgressAllowed(`http://${ip.includes(":") ? `[${ip}]` : ip}/x`, [])
      ).resolves.toBeUndefined();
    }
  });

  it("still blocks loopback/link-local even for an UNSCOPED escape hatch (empty allowlist)", async () => {
    for (const ip of ["127.0.0.1", "169.254.169.254", "::1"]) {
      await expect(
        assertEgressAllowed(`http://${ip.includes(":") ? `[${ip}]` : ip}/x`, [])
      ).rejects.toThrow(/never a permitted plugin egress target|SSRF/);
    }
  });

  it("permits a public IP", async () => {
    await expect(assertEgressAllowed("http://8.8.8.8/x", ["8.8.8.8"])).resolves.toBeUndefined();
    await expect(assertEgressAllowed("http://8.8.8.8/x", [])).resolves.toBeUndefined();
  });

  it("blocks a host NOT on a non-empty allowlist (the allowlist gate itself)", async () => {
    await expect(assertEgressAllowed("http://8.8.8.8/x", ["1.1.1.1"])).rejects.toThrow(/allowlist/);
  });
});
