import { connect as netConnect, isIP, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import type {
  DeliveryResult,
  NotificationMessage,
  NotificationPlugin,
  PluginContext,
  PluginManifest
} from "@scp/plugin-api";
import { assertHostNotInternal } from "./egress.js";

/** `@scp/plugin-smtp-notify` — the SMTP `NotificationPlugin`. See docs/plugins.md §536. */

export interface SmtpNotifyConfig {
  host: string;
  port?: number;
  /** `true` = implicit TLS from connect (typically port 465); `false`/omitted = plaintext then
   *  STARTTLS if the server advertises it (typically port 587/25). */
  implicitTls?: boolean;
  from: string;
  to: string[];
  /** Username for `AUTH LOGIN`/`AUTH PLAIN` — password comes from `ctx.secrets` (see below), never
   *  from config, since config crosses the JSON-RPC boundary and lands in DB-persisted binding
   *  rows; the password is DB-persisted too, but only as ciphertext (`secrets` table). */
  username?: string;
  /** `SecretsAccessor` key holding the SMTP password/app-token — resolved via `ctx.secrets.get()`,
   *  never embedded in `config` itself. */
  passwordSecretKey?: string;
  /** Egress allowlist enforced by THIS plugin (see module doc) — hostnames, not URLs. Empty/unset
   *  disables the check (matches `PluginHostInstanceConfig.allowedHosts`'s own "empty = unscoped"
   *  default) but every real binding is expected to set this to `[host]`. */
  allowedHosts?: string[];
  /** Opt-in to sending AUTH credentials over an unencrypted connection. Default (unset/false)
   *  REFUSES — see `send()`: without it, a relay that simply omits STARTTLS from its EHLO reply
   *  harvests the password in cleartext. */
  allowPlaintextAuth?: boolean;
  connectTimeoutMs?: number; // default 10_000
}

const DEFAULT_PORT = 587;
const DEFAULT_TIMEOUT_MS = 10_000;

function asConfig(config: unknown): SmtpNotifyConfig {
  const c = config as Partial<SmtpNotifyConfig> | undefined;
  if (!c?.host || !c.from || !c.to?.length) {
    throw new Error(
      "smtp-notify: config.host, config.from, and config.to (non-empty) are required"
    );
  }
  return {
    host: c.host,
    port: c.port,
    implicitTls: c.implicitTls,
    from: c.from,
    to: c.to,
    username: c.username,
    passwordSecretKey: c.passwordSecretKey,
    allowedHosts: c.allowedHosts,
    allowPlaintextAuth: c.allowPlaintextAuth,
    connectTimeoutMs: c.connectTimeoutMs
  };
}

/** `allowedHosts` allowlist enforcement. See docs/plugins.md §537. */
function checkAllowlist(host: string, allowedHosts: string[] | undefined): void {
  if (!allowedHosts || allowedHosts.length === 0) return;
  if (!allowedHosts.includes(host)) {
    throw new Error(`smtp-notify: host '${host}' is not in the configured allowedHosts allowlist`);
  }
}

/** One line-buffered read of every response line for one multi-line SMTP reply (e.g. EHLO's
 *  capability list: `"250-STARTTLS\r\n250 AUTH LOGIN PLAIN\r\n"`) — SMTP marks the FINAL line of a
 *  reply with a space after the 3-digit code (`"250 "`) vs. a dash for continuation (`"250-"`). */
function readReply(socket: Socket | TLSSocket): Promise<{ code: number; lines: string[] }> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\r\n").filter((l) => l.length > 0);
      const last = lines[lines.length - 1];
      if (!last) return;
      const isFinal = /^\d{3} /.test(last);
      if (!isFinal) return;
      cleanup();
      const code = Number(last.slice(0, 3));
      resolve({ code, lines });
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    const cleanup = (): void => {
      socket.off("data", onData);
      socket.off("error", onError);
    };
    socket.on("data", onData);
    socket.on("error", onError);
  });
}

function writeCommand(socket: Socket | TLSSocket, command: string): void {
  socket.write(`${command}\r\n`);
}

async function expect(
  socket: Socket | TLSSocket,
  command: string | undefined,
  acceptableCodes: number[]
): Promise<{ code: number; lines: string[] }> {
  if (command !== undefined) writeCommand(socket, command);
  const reply = await readReply(socket);
  if (!acceptableCodes.includes(reply.code)) {
    throw new Error(`smtp-notify: unexpected SMTP reply ${reply.code}: ${reply.lines.join(" | ")}`);
  }
  return reply;
}

function buildMessage(config: SmtpNotifyConfig, msg: NotificationMessage): string {
  const headers = [
    `From: ${config.from}`,
    `To: ${config.to.join(", ")}`,
    `Subject: [${msg.severity.toUpperCase()}] ${msg.subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8"
  ];
  // RFC 5321 dot-stuffing: any line starting with '.' gets an extra leading '.' so it isn't
  // mistaken for the end-of-DATA terminator.
  const body = msg.body
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => (line.startsWith(".") ? `.${line}` : line));
  return [...headers, "", ...body, "."].join("\r\n");
}

/** Dials the address the guard just verified, not the name. See docs/plugins.md §538. */
async function connectSocket(
  config: SmtpNotifyConfig,
  address: string
): Promise<Socket | TLSSocket> {
  const port = config.port ?? DEFAULT_PORT;
  const timeoutMs = config.connectTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const servername = isIP(config.host.replace(/^\[|\]$/g, "")) === 0 ? config.host : undefined;
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    const socket = config.implicitTls
      ? tlsConnect({ host: address, servername, port, timeout: timeoutMs }, () => {
          socket.off("error", onError);
          resolve(socket);
        })
      : netConnect({ host: address, port, timeout: timeoutMs }, () => {
          socket.off("error", onError);
          resolve(socket);
        });
    socket.once("error", onError);
    socket.once("timeout", () => {
      socket.destroy();
      reject(new Error(`smtp-notify: connection to ${config.host}:${port} timed out`));
    });
  });
}

/** Upgrades a plaintext socket to TLS in place (STARTTLS, RFC 3207) — the plaintext socket is
 *  destroyed only after the TLS handshake completes over it, never before (no window where
 *  application data could be sent in the clear post-STARTTLS-negotiation). */
function upgradeToTls(socket: Socket, host: string): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const tlsSocket = tlsConnect({ socket, host }, () => resolve(tlsSocket));
    tlsSocket.once("error", reject);
  });
}

/** Whether this socket is ACTUALLY a completed TLS session — `TLSSocket.encrypted` is set by the
 *  transport itself, so it cannot report an upgrade that did not happen. */
function isEncrypted(socket: Socket | TLSSocket): boolean {
  return (socket as TLSSocket).encrypted === true;
}

async function authenticate(
  socket: Socket | TLSSocket,
  username: string,
  password: string
): Promise<void> {
  const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");
  await expect(socket, "AUTH LOGIN", [334]);
  await expect(socket, b64(username), [334]);
  await expect(socket, b64(password), [235]);
}

async function send(ctx: PluginContext, msg: NotificationMessage): Promise<DeliveryResult> {
  const config = asConfig(ctx.config);

  let socket: Socket | TLSSocket | undefined;
  try {
    checkAllowlist(config.host, config.allowedHosts);
    // MAJOR #6 — SSRF internal-range deny-list (egress.ts). The addresses it returns are the ONLY
    // ones this plugin may dial; connecting to the name instead would re-resolve it (rebinding).
    const verified = await assertHostNotInternal(config.host);
    const address = verified[0];
    if (!address) {
      throw new Error(`smtp-notify: no verified address for host '${config.host}'`);
    }
    socket = await connectSocket(config, address);
    await readReply(socket);
    let ehlo = await expect(socket, `EHLO scp-notify`, [250]);
    const capabilities = ehlo.lines.join(" ").toUpperCase();

    if (!config.implicitTls && capabilities.includes("STARTTLS")) {
      await expect(socket, "STARTTLS", [220]);
      socket = await upgradeToTls(socket as Socket, config.host);
      ehlo = await expect(socket, `EHLO scp-notify`, [250]);
    }

    if (config.username && config.passwordSecretKey) {
      // Read the encryption state off the socket, not our intent. See docs/plugins.md §539.
      if (!isEncrypted(socket) && config.allowPlaintextAuth !== true) {
        return {
          delivered: false,
          detail:
            `smtp-notify: refusing to send AUTH credentials to '${config.host}' over an ` +
            `unencrypted connection — the server did not offer STARTTLS (or the upgrade did not ` +
            `happen). Set implicitTls, use a relay that offers STARTTLS, or set ` +
            `allowPlaintextAuth if this hop is genuinely trusted.`
        };
      }
      const password = await ctx.secrets.get(config.passwordSecretKey);
      if (!password) {
        return {
          delivered: false,
          detail: `smtp-notify: secret '${config.passwordSecretKey}' not configured`
        };
      }
      await authenticate(socket, config.username, password);
    }

    await expect(socket, `MAIL FROM:<${config.from}>`, [250]);
    for (const recipient of config.to) {
      await expect(socket, `RCPT TO:<${recipient}>`, [250, 251]);
    }
    await expect(socket, "DATA", [354]);
    await expect(socket, buildMessage(config, msg), [250]);
    await expect(socket, "QUIT", [221]);
    return { delivered: true };
  } catch (err) {
    return {
      delivered: false,
      detail: `smtp-notify: ${err instanceof Error ? err.message : String(err)}`
    };
  } finally {
    socket?.destroy();
  }
}

export const smtpNotifyPlugin: NotificationPlugin = { send };

export function createSmtpNotifyPlugin(): NotificationPlugin {
  return smtpNotifyPlugin;
}

export const manifest: PluginManifest = {
  id: "smtp-notify",
  kind: "notification",
  version: "0.1.0",
  configSchema: {
    type: "object",
    required: ["host", "from", "to"],
    properties: {
      host: { type: "string" },
      port: { type: "integer", minimum: 1, maximum: 65535, default: 587 },
      implicitTls: { type: "boolean", default: false },
      from: { type: "string", format: "email" },
      to: { type: "array", items: { type: "string", format: "email" }, minItems: 1 },
      username: { type: "string" },
      passwordSecretKey: { type: "string" },
      allowedHosts: { type: "array", items: { type: "string" } },
      allowPlaintextAuth: { type: "boolean", default: false },
      connectTimeoutMs: { type: "integer", minimum: 100, default: 10_000 }
    }
  }
};

export default smtpNotifyPlugin;
