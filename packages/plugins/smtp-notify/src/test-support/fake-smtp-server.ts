import net from "node:net";

/**
 * A minimal, plaintext (non-TLS) fake SMTP server for `@scp/plugin-smtp-notify`'s test suite —
 * just enough of RFC 5321/4954's command/response shape to exercise this package's real
 * `send()` implementation end to end over a real `node:net` socket (not a mock of `send()`
 * itself). HONEST GAP: this fixture does NOT implement STARTTLS's actual TLS handshake (would
 * need a self-signed cert generated at test time — no such helper exists in this repo, and
 * pulling one in for a single test fixture wasn't judged worth a new dependency this milestone) —
 * `index.ts`'s STARTTLS branch is therefore exercised only up to "the server didn't advertise
 * STARTTLS, so the plaintext path continues" and "the server advertised it and STARTTLS was
 * issued", not the TLS upgrade itself. Flagged here, not silently skipped.
 */
export interface FakeSmtpServerOptions {
  /** Extra EHLO capability lines (e.g. ["STARTTLS", "AUTH LOGIN"]) besides the final "250 ok". */
  capabilities?: string[];
  /** AUTH LOGIN outcome — 235 (accepted) vs 535 (rejected). Ignored if the client never authenticates. */
  authOk?: boolean;
  /** MAIL FROM / RCPT TO / DATA-terminator response code override, for error-path tests. Default 250. */
  transactionReplyCode?: number;
}

export interface FakeSmtpServerHandle {
  port: number;
  /** Every command line the server received, in order (base64-decoded AUTH LOGIN credentials
   *  included, for assertion — this is a TEST fixture, never production code). */
  receivedLines: string[];
  /** The full DATA payload (headers + body), once a DATA transaction completes. */
  receivedMessage: string | undefined;
  close(): Promise<void>;
}

export function startFakeSmtpServer(
  opts: FakeSmtpServerOptions = {}
): Promise<FakeSmtpServerHandle> {
  const receivedLines: string[] = [];
  let receivedMessage: string | undefined;
  const transactionCode = opts.transactionReplyCode ?? 250;

  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      let buffer = "";
      let mode: "command" | "auth-user" | "auth-pass" | "data" = "command";
      let dataLines: string[] = [];

      socket.write("220 fake-smtp ready\r\n");

      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        let idx: number;
        while ((idx = buffer.indexOf("\r\n")) !== -1) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          handleLine(line);
        }
      });

      function handleLine(line: string): void {
        if (mode === "data") {
          if (line === ".") {
            receivedMessage = dataLines.join("\r\n");
            dataLines = [];
            mode = "command";
            socket.write(`${transactionCode} message accepted\r\n`);
            return;
          }
          dataLines.push(line);
          return;
        }
        if (mode === "auth-user" || mode === "auth-pass") {
          receivedLines.push(`[base64] ${Buffer.from(line, "base64").toString("utf8")}`);
          if (mode === "auth-user") {
            mode = "auth-pass";
            socket.write("334 UGFzc3dvcmQ6\r\n"); // "Password:"
          } else {
            mode = "command";
            socket.write(
              opts.authOk === false ? "535 authentication failed\r\n" : "235 authenticated\r\n"
            );
          }
          return;
        }

        receivedLines.push(line);
        const verb = line.split(" ")[0]?.toUpperCase() ?? "";
        if (verb === "EHLO" || verb === "HELO") {
          const caps = opts.capabilities ?? [];
          if (caps.length === 0) {
            socket.write("250 fake-smtp\r\n");
          } else {
            socket.write(
              `250-fake-smtp\r\n${caps.map((c) => `250-${c}`).join("\r\n")}\r\n250 HELP\r\n`
            );
          }
        } else if (verb === "STARTTLS") {
          socket.write("220 go ahead\r\n");
          // No actual TLS handshake — see module doc's HONEST GAP note.
        } else if (verb === "AUTH") {
          mode = "auth-user";
          socket.write("334 VXNlcm5hbWU6\r\n"); // "Username:"
        } else if (verb === "MAIL" || verb === "RCPT") {
          socket.write(`${transactionCode} ok\r\n`);
        } else if (verb === "DATA") {
          mode = "data";
          socket.write("354 go ahead\r\n");
        } else if (verb === "QUIT") {
          socket.write("221 bye\r\n");
          socket.end();
        } else {
          socket.write("500 unrecognized command\r\n");
        }
      }
    });

    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("fake-smtp-server: could not determine bound port"));
        return;
      }
      resolve({
        port: address.port,
        receivedLines,
        get receivedMessage() {
          return receivedMessage;
        },
        close: () => new Promise((res) => server.close(() => res()))
      });
    });
  });
}
