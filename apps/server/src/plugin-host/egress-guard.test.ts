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

const url = (ip: string): string => `http://${ip.includes(":") ? `[${ip}]` : ip}/x`;

describe("assertEgressAllowed", () => {
  it("ALWAYS blocks link-local (cloud metadata) + unspecified — for EVERY plugin, scoped or not", async () => {
    for (const ip of ["169.254.169.254", "169.254.0.1", "0.0.0.0", "::", "fe80::1"]) {
      // Blocked whether allowlisted (scoped) or unscoped (escape hatch).
      await expect(assertEgressAllowed(url(ip), [ip]), `scoped ${ip}`).rejects.toThrow(
        /never a permitted plugin egress target/
      );
      await expect(assertEgressAllowed(url(ip), []), `unscoped ${ip}`).rejects.toThrow(
        /never a permitted plugin egress target/
      );
    }
  });

  it("blocks loopback + private for a SCOPED plugin — '127.0.0.1 / the DB host is blocked even when allowlisted'", async () => {
    for (const ip of ["127.0.0.1", "::1", "10.0.0.5", "172.16.9.9", "192.168.1.50", "fc00::1"]) {
      await expect(assertEgressAllowed(url(ip), [ip]), `scoped ${ip}`).rejects.toThrow(
        /rebinding|redirect defense/
      );
    }
  });

  it("PERMITS loopback + private for an UNSCOPED escape hatch (empty allowlist) — webhook-control's local control server, federation-https's on-prem peers", async () => {
    for (const ip of ["127.0.0.1", "::1", "10.0.0.5", "192.168.1.50", "fc00::1"]) {
      await expect(assertEgressAllowed(url(ip), []), `unscoped ${ip}`).resolves.toBeUndefined();
    }
  });

  it("permits a public IP (scoped and unscoped)", async () => {
    await expect(assertEgressAllowed("http://8.8.8.8/x", ["8.8.8.8"])).resolves.toBeUndefined();
    await expect(assertEgressAllowed("http://8.8.8.8/x", [])).resolves.toBeUndefined();
  });

  it("blocks a host NOT on a non-empty allowlist (the allowlist gate itself)", async () => {
    await expect(assertEgressAllowed("http://8.8.8.8/x", ["1.1.1.1"])).rejects.toThrow(/allowlist/);
  });
});
