import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Agent } from "undici";
import {
  assertEgressAllowed,
  classifyIp,
  createEgressPinRegistry,
  type EgressPinRegistry,
  type EgressResolver
} from "./egress-guard.js";

/**
 * Unit tests for the SSRF egress guard (MAJOR #6). All cases use IP LITERALS so `assertEgressAllowed`
 * short-circuits DNS resolution (`isIP` !== 0) and never touches the network — the guard's blocking
 * logic is fully exercised without a real DNS lookup or HTTP server.
 */
describe("classifyIp", () => {
  const cases: Array<[string, ReturnType<typeof classifyIp>]> = [
    ["127.0.0.1", "loopback"],
    ["127.53.1.9", "loopback"],
    ["169.254.169.254", "linkLocal"],
    ["169.254.0.1", "linkLocal"],
    ["0.0.0.0", "unspecified"],
    ["10.0.0.5", "private"],
    ["172.16.4.4", "private"],
    ["172.31.255.255", "private"],
    ["172.32.0.1", "public"],
    ["192.168.1.1", "private"],
    ["100.64.0.1", "private"],
    ["8.8.8.8", "public"],
    ["1.1.1.1", "public"],
    ["::1", "loopback"],
    ["::", "unspecified"],
    ["fe80::1", "linkLocal"],
    ["fc00::1", "private"],
    ["fd12:3456::1", "private"],
    ["2606:4700:4700::1111", "public"],
    ["::ffff:127.0.0.1", "loopback"],
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
// Third arg = allowInternalPrivate, derived from MODULE identity by the caller (not shown here).
const TENANT = false;
const OPERATOR_PLANE = true;

describe("assertEgressAllowed", () => {
  it("ALWAYS blocks link-local (cloud metadata) + unspecified — for EVERY plugin incl. operator-plane escape hatches", async () => {
    for (const ip of ["169.254.169.254", "169.254.0.1", "0.0.0.0", "::", "fe80::1"]) {
      await expect(assertEgressAllowed(url(ip), [ip], TENANT), `tenant ${ip}`).rejects.toThrow(
        /never a permitted plugin egress target/
      );
      await expect(
        assertEgressAllowed(url(ip), [], OPERATOR_PLANE),
        `op-plane ${ip}`
      ).rejects.toThrow(/never a permitted plugin egress target/);
    }
  });

  it("BLOCKS loopback + private for a TENANT plugin — even with EMPTY allowedHosts (the reopened-SSRF regression guard)", async () => {
    // Empty allowedHosts is exactly what a tenant-created binding defaults to — must NOT permit internal.
    for (const ip of [
      "127.0.0.1",
      "::1",
      "10.0.0.5",
      "172.16.9.9",
      "192.168.1.50",
      "100.64.0.1",
      "fc00::1"
    ]) {
      await expect(
        assertEgressAllowed(url(ip), [], TENANT),
        `tenant empty-allowlist ${ip}`
      ).rejects.toThrow(/internal egress blocked/);
      // And with the IP allowlisted, still blocked (the allowlist doesn't grant internal access).
      await expect(
        assertEgressAllowed(url(ip), [ip], TENANT),
        `tenant allowlisted ${ip}`
      ).rejects.toThrow(/internal egress blocked/);
    }
  });

  it("PERMITS loopback + private ONLY for an OPERATOR-PLANE escape hatch (webhook-control's control server, federation-https's on-prem peers)", async () => {
    for (const ip of ["127.0.0.1", "::1", "10.0.0.5", "192.168.1.50", "fc00::1"]) {
      await expect(
        assertEgressAllowed(url(ip), [], OPERATOR_PLANE),
        `op-plane ${ip}`
      ).resolves.toEqual({ hostname: ip, ips: [ip] });
    }
  });

  it("permits a public IP (tenant and operator-plane)", async () => {
    await expect(assertEgressAllowed("http://8.8.8.8/x", ["8.8.8.8"], TENANT)).resolves.toEqual({
      hostname: "8.8.8.8",
      ips: ["8.8.8.8"]
    });
    await expect(assertEgressAllowed("http://8.8.8.8/x", [], TENANT)).resolves.toEqual({
      hostname: "8.8.8.8",
      ips: ["8.8.8.8"]
    });
  });

  it("blocks a host NOT on a non-empty allowlist (the allowlist gate itself)", async () => {
    await expect(assertEgressAllowed("http://8.8.8.8/x", ["1.1.1.1"], TENANT)).rejects.toThrow(
      /allowlist/
    );
  });
});

/**
 * DNS-rebinding pinning (`createEgressPinRegistry`). These run REAL undici requests through the
 * exact Agent shape `subprocess-entry.ts`'s `scopedFetchHttpClient` builds — `connect.lookup` set
 * to the registry — because the defect being closed lives entirely in what the SOCKET does, not in
 * what the guard returns. The only server involved is a loopback one this file starts; the
 * hostnames used are `.invalid`, which by RFC 6761 no real resolver can answer, so a request that
 * ARRIVES proves the pin (and nothing else) chose the address.
 */
describe("createEgressPinRegistry", () => {
  let server: Server;
  let port: number;
  let seenHosts: string[];

  beforeEach(async () => {
    seenHosts = [];
    server = createServer((req, res) => {
      seenHosts.push(req.headers.host ?? "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const agentFor = (pins: EgressPinRegistry): Agent =>
    new Agent({ connect: { lookup: pins.lookup }, connectTimeout: 500 });

  it("connects to the address the guard verified — a resolver that rebinds is never asked twice", async () => {
    // Answer 1 is a public (TEST-NET-3, RFC 5737) address the guard accepts; answer 2 is the
    // loopback server this test is running. A rebinding attacker's whole play is that the second
    // answer is the one the socket uses. It must be unreachable.
    const answers = ["203.0.113.9", "127.0.0.1"];
    let calls = 0;
    const rebinding: EgressResolver = async (_hostname) => [answers[calls++] ?? "127.0.0.1"];

    const target = await assertEgressAllowed(
      `http://rebind.invalid:${port}/x`,
      [],
      TENANT,
      rebinding
    );
    expect(target.ips).toEqual(["203.0.113.9"]);

    const pins = createEgressPinRegistry();
    const agent = agentFor(pins);
    const release = pins.pin(target);
    await expect(
      agent.request({ origin: `http://rebind.invalid:${port}`, path: "/x", method: "GET" })
    ).rejects.toThrow();
    release();
    await agent.close();

    // The two assertions that matter: the socket never reached the rebind target, and the
    // connect path performed NO resolution of its own (one resolver call, the guard's).
    expect(seenHosts, "the rebound address was reached").toEqual([]);
    expect(calls, "the hostname was resolved a second time at connect time").toBe(1);
  });

  it("a pinned name resolves ONLY through the pin — no DNS involved (positive control)", async () => {
    const pins = createEgressPinRegistry();
    const agent = agentFor(pins);
    const release = pins.pin({ hostname: "pinned.invalid", ips: ["127.0.0.1"] });
    const res = await agent.request({
      origin: `http://pinned.invalid:${port}`,
      path: "/x",
      method: "GET"
    });
    expect(res.statusCode).toBe(200);
    await res.body.text();
    release();
    await agent.close();
    // `.invalid` never resolves, so arriving at all proves the pin supplied the address — and the
    // name still travelled as `Host` (and, over TLS, as SNI): only address selection is pinned.
    expect(seenHosts).toEqual([`pinned.invalid:${port}`]);
  });

  it("refuses to resolve a hostname with no live pin (no silent fallback to DNS)", async () => {
    const pins = createEgressPinRegistry();
    const agent = agentFor(pins);
    const release = pins.pin({ hostname: "pinned.invalid", ips: ["127.0.0.1"] });
    release();
    await expect(
      agent.request({ origin: `http://pinned.invalid:${port}`, path: "/x", method: "GET" })
    ).rejects.toThrow(/verified|rebinding/);
    await agent.close();
    expect(seenHosts).toEqual([]);
  });

  it("holds a concurrent second request's pin — the first release cannot strand it", async () => {
    const pins = createEgressPinRegistry();
    const agent = agentFor(pins);
    const releaseA = pins.pin({ hostname: "pinned.invalid", ips: ["127.0.0.1"] });
    const releaseB = pins.pin({ hostname: "pinned.invalid", ips: ["127.0.0.1"] });
    releaseA();
    const res = await agent.request({
      origin: `http://pinned.invalid:${port}`,
      path: "/x",
      method: "GET"
    });
    expect(res.statusCode).toBe(200);
    await res.body.text();
    releaseB();
    await agent.close();
  });
});
