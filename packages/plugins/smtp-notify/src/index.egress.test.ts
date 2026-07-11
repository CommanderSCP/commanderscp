import { describe, expect, it } from "vitest";
import type { PluginContext } from "@scp/plugin-api";
// NO vi.mock here (unlike index.test.ts) — this file proves the REAL guard is wired into send():
// a send() to an internal host fails closed (delivered:false) BEFORE any socket is opened.
import { smtpNotifyPlugin } from "./index.js";

function ctx(host: string): PluginContext {
  return {
    orgId: "org-1",
    domainId: "domain-1",
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    secrets: { get: async () => undefined },
    http: {
      request: async () => {
        throw new Error("smtp-notify: never calls ctx.http");
      }
    },
    config: { host, from: "scp@example.com", to: ["ops@example.com"] }
  };
}

describe("@scp/plugin-smtp-notify: SSRF internal-range deny-list wired into send() (MAJOR #6)", () => {
  for (const host of ["127.0.0.1", "169.254.169.254", "10.0.0.5", "192.168.1.9", "::1"]) {
    it(`send() to internal host ${host} fails closed (delivered:false) — no connection attempted`, async () => {
      const result = await smtpNotifyPlugin.send(ctx(host), {
        subject: "s",
        body: "b",
        severity: "info"
      });
      expect(result.delivered).toBe(false);
      expect(result.detail).toContain("internal egress blocked");
    });
  }
});
