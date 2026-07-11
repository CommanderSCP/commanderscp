import { afterEach, describe, expect, it } from "vitest";
import type { PluginContext } from "@scp/plugin-api";
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
    domainId: "domain-1",
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
          passwordSecretKey: "smtp-password"
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
          passwordSecretKey: "smtp-password"
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
        passwordSecretKey: "smtp-password" // no secret value provided to testCtx -> resolves undefined
      }),
      { subject: "s", body: "b", severity: "info" }
    );

    expect(result.delivered).toBe(false);
    expect(result.detail).toContain("not configured");
    // Never even attempted MAIL FROM — fail-closed before the transaction started.
    expect(activeServer.receivedLines.some((l) => l.startsWith("MAIL FROM"))).toBe(false);
  });

  it("does NOT attempt STARTTLS when the server doesn't advertise it", async () => {
    activeServer = await startFakeSmtpServer(); // no STARTTLS in capabilities
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
