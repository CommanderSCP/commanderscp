import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@scp/plugin-api";

// These SMTP-PROTOCOL tests reach a loopback fake server (127.0.0.1), which the real internal-IP
// egress guard (egress.ts, MAJOR #6) would block — so bypass the guard HERE. The guard itself is
// tested directly in egress.test.ts, and its wiring into send() in index.egress.test.ts (no mock).
// The stand-in returns the address send() must dial: the guard's answer is the ONLY thing that
// chooses the socket's peer now (DNS-rebinding pin — see egress.ts), which the pinning test below
// exercises with a hostname no resolver can answer.
vi.mock("./egress.js", () => ({
  assertHostNotInternal: async (): Promise<string[]> => ["127.0.0.1"]
}));

import { smtpNotifyPlugin } from "./index.js";
import { startFakeSmtpServer, type FakeSmtpServerHandle } from "./test-support/fake-smtp-server.js";

let activeServer: FakeSmtpServerHandle | undefined;

afterEach(async () => {
  await activeServer?.close();
  activeServer = undefined;
});

function testCtx(config: unknown, secretValue?: string): PluginContext {
  return {
    orgId: "org-1",
    scopeKey: "domain-1",
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    secrets: { get: async (key) => (key === "smtp-password" ? secretValue : undefined) },
    http: {
      request: async () => {
        throw new Error("smtp-notify: never calls ctx.http");
      }
    },
    config
  };
}

describe("@scp/plugin-smtp-notify", () => {
  it("sends a plain (no-auth) message over a real socket and reports delivered:true", async () => {
    activeServer = await startFakeSmtpServer();
    const result = await smtpNotifyPlugin.send(
      testCtx({
        host: "127.0.0.1",
        port: activeServer.port,
        from: "scp@example.com",
        to: ["ops@example.com"]
      }),
      { subject: "Change stalled", body: "line one\nline two", severity: "warning" }
    );

    expect(result).toEqual({ delivered: true });
    expect(activeServer.receivedLines).toContain("MAIL FROM:<scp@example.com>");
    expect(activeServer.receivedLines).toContain("RCPT TO:<ops@example.com>");
    expect(activeServer.receivedMessage).toContain("Subject: [WARNING] Change stalled");
    expect(activeServer.receivedMessage).toContain("line one");
    expect(activeServer.receivedMessage).toContain("line two");
  });

  it("sends to multiple recipients (one RCPT TO per address)", async () => {
    activeServer = await startFakeSmtpServer();
    await smtpNotifyPlugin.send(
      testCtx({
        host: "127.0.0.1",
        port: activeServer.port,
        from: "scp@example.com",
        to: ["a@example.com", "b@example.com"]
      }),
      { subject: "s", body: "b", severity: "info" }
    );

    expect(activeServer.receivedLines).toContain("RCPT TO:<a@example.com>");
    expect(activeServer.receivedLines).toContain("RCPT TO:<b@example.com>");
  });

  it("dot-stuffs a body line that starts with '.' (RFC 5321 transparency)", async () => {
    activeServer = await startFakeSmtpServer();
    await smtpNotifyPlugin.send(
      testCtx({
        host: "127.0.0.1",
        port: activeServer.port,
        from: "scp@example.com",
        to: ["ops@example.com"]
      }),
      { subject: "s", body: ".leading dot line", severity: "info" }
    );

    expect(activeServer.receivedMessage).toContain("..leading dot line");
  });

  it("authenticates via AUTH LOGIN when username + passwordSecretKey are configured, resolving the password through ctx.secrets", async () => {
    activeServer = await startFakeSmtpServer({ capabilities: ["AUTH LOGIN"] });
    const result = await smtpNotifyPlugin.send(
      testCtx(
        {
          host: "127.0.0.1",
          port: activeServer.port,
          from: "scp@example.com",
          to: ["ops@example.com"],
          username: "scp-relay-user",
          passwordSecretKey: "smtp-password",
          // The fixture speaks no TLS (see its HONEST GAP note), so these AUTH-protocol cases
          // take the explicit plaintext opt-in; the refusal it opts out of has its own test below.
          allowPlaintextAuth: true
        },
        "the-real-password"
      ),
      { subject: "s", body: "b", severity: "info" }
    );

    expect(result.delivered).toBe(true);
    expect(activeServer.receivedLines).toContain("[base64] scp-relay-user");
    expect(activeServer.receivedLines).toContain("[base64] the-real-password");
  });

  it("reports delivered:false (never throws) when AUTH LOGIN is rejected", async () => {
    activeServer = await startFakeSmtpServer({ capabilities: ["AUTH LOGIN"], authOk: false });
    const result = await smtpNotifyPlugin.send(
      testCtx(
        {
          host: "127.0.0.1",
          port: activeServer.port,
          from: "scp@example.com",
          to: ["ops@example.com"],
          username: "scp-relay-user",
          passwordSecretKey: "smtp-password",
          // The fixture speaks no TLS (see its HONEST GAP note), so these AUTH-protocol cases
          // take the explicit plaintext opt-in; the refusal it opts out of has its own test below.
          allowPlaintextAuth: true
        },
        "wrong-password"
      ),
      { subject: "s", body: "b", severity: "info" }
    );

    expect(result.delivered).toBe(false);
  });

  it("reports delivered:false when the configured secret is missing (never sends unauthenticated as a silent fallback)", async () => {
    activeServer = await startFakeSmtpServer({ capabilities: ["AUTH LOGIN"] });
    const result = await smtpNotifyPlugin.send(
      testCtx({
        host: "127.0.0.1",
        port: activeServer.port,
        from: "scp@example.com",
        to: ["ops@example.com"],
        username: "scp-relay-user",
        passwordSecretKey: "smtp-password", // no secret value provided to testCtx -> resolves undefined
        allowPlaintextAuth: true
      }),
      { subject: "s", body: "b", severity: "info" }
    );

    expect(result.delivered).toBe(false);
    expect(result.detail).toContain("not configured");
    // Never even attempted MAIL FROM — fail-closed before the transaction started.
    expect(activeServer.receivedLines.some((l) => l.startsWith("MAIL FROM"))).toBe(false);
  });

  it("does NOT attempt STARTTLS when the server doesn't advertise it", async () => {
    activeServer = await startFakeSmtpServer();
    const result = await smtpNotifyPlugin.send(
      testCtx({
        host: "127.0.0.1",
        port: activeServer.port,
        from: "scp@example.com",
        to: ["ops@example.com"]
      }),
      { subject: "s", body: "b", severity: "info" }
    );

    expect(result.delivered).toBe(true);
    expect(activeServer.receivedLines.some((l) => l === "STARTTLS")).toBe(false);
  });

  it("REFUSES to authenticate when the server strips STARTTLS — the credentials never leave this process", async () => {
    // The STARTTLS-stripping attack, verbatim: the server advertises AUTH but not STARTTLS, so the
    // opportunistic upgrade is skipped and the socket stays cleartext. Anything that reaches this
    // fixture reached an on-path attacker in the real world.
    activeServer = await startFakeSmtpServer({ capabilities: ["AUTH LOGIN"] });
    const result = await smtpNotifyPlugin.send(
      testCtx(
        {
          host: "127.0.0.1",
          port: activeServer.port,
          from: "scp@example.com",
          to: ["ops@example.com"],
          username: "scp-relay-user",
          passwordSecretKey: "smtp-password"
        },
        "the-real-password"
      ),
      { subject: "s", body: "b", severity: "info" }
    );

    expect(result.delivered).toBe(false);
    expect(result.detail).toContain("unencrypted");
    expect(activeServer.receivedLines.some((l) => l.startsWith("AUTH"))).toBe(false);
    expect(activeServer.receivedLines.some((l) => l.includes("the-real-password"))).toBe(false);
    // And nothing was delivered unauthenticated as a consolation prize either.
    expect(activeServer.receivedLines.some((l) => l.startsWith("MAIL FROM"))).toBe(false);
  });

  it("dials the address the egress guard verified, not the configured NAME (DNS-rebinding pin)", async () => {
    // `.invalid` can never be resolved by a real resolver (RFC 6761), and the guard stand-in above
    // hands back 127.0.0.1 — so a message that ARRIVES proves the socket took its peer from the
    // guard's answer instead of re-resolving the name on its own.
    activeServer = await startFakeSmtpServer();
    const result = await smtpNotifyPlugin.send(
      testCtx({
        host: "relay.invalid",
        port: activeServer.port,
        from: "scp@example.com",
        to: ["ops@example.com"]
      }),
      { subject: "s", body: "b", severity: "info" }
    );

    expect(result).toEqual({ delivered: true });
    expect(activeServer.receivedLines).toContain("MAIL FROM:<scp@example.com>");
  });

  it("reports delivered:false (never throws) on a non-2xx MAIL FROM response", async () => {
    activeServer = await startFakeSmtpServer({ transactionReplyCode: 550 });
    const result = await smtpNotifyPlugin.send(
      testCtx({
        host: "127.0.0.1",
        port: activeServer.port,
        from: "scp@example.com",
        to: ["ops@example.com"]
      }),
      { subject: "s", body: "b", severity: "info" }
    );

    expect(result.delivered).toBe(false);
    expect(result.detail).toContain("550");
  });

  it("reports delivered:false (never throws) when the host is unreachable", async () => {
    const result = await smtpNotifyPlugin.send(
      testCtx({
        host: "127.0.0.1",
        port: 1,
        from: "scp@example.com",
        to: ["ops@example.com"],
        connectTimeoutMs: 500
      }),
      { subject: "s", body: "b", severity: "info" }
    );

    expect(result.delivered).toBe(false);
  });

  it("fails closed when the target host is not on the configured allowedHosts allowlist", async () => {
    activeServer = await startFakeSmtpServer();
    const result = await smtpNotifyPlugin.send(
      testCtx({
        host: "127.0.0.1",
        port: activeServer.port,
        from: "scp@example.com",
        to: ["ops@example.com"],
        allowedHosts: ["smtp.only-this-host-allowed.test"]
      }),
      { subject: "s", body: "b", severity: "info" }
    );

    expect(result.delivered).toBe(false);
    expect(result.detail).toContain("allowedHosts");
    expect(activeServer.receivedLines).toHaveLength(0); // never even connected
  });

  it("throws synchronously (config error, not a DeliveryResult) when required config fields are missing", async () => {
    await expect(
      smtpNotifyPlugin.send(testCtx({}), { subject: "s", body: "b", severity: "info" })
    ).rejects.toThrow(/host|from|to/);
  });
});
