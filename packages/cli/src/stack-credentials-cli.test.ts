import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerStackCommands } from "./stack-cli.js";
import { credentialTargetOf, readCredentialValue } from "./stack-credentials-cli.js";

describe("scp stack credential (M29.5, ADR-0063)", () => {
  it("holds a target to the catalog's pairs, not just its vocabulary", () => {
    expect(credentialTargetOf("argo-workflows", "scp-build-registry", "registryPassword")).toEqual({
      backend: "argo-workflows",
      secretName: "scp-build-registry",
      key: "registryPassword"
    });
    // Every name is in the vocabulary, but AWS keys belong to the infra Secrets.
    expect(() => credentialTargetOf("argo-workflows", "scp-build-registry", "AWS_REGION")).toThrow(
      /catalog/
    );
    expect(() => credentialTargetOf("gitea", "scp-build-registry", "registryPassword")).toThrow();
    expect(() => credentialTargetOf("argo-workflows", "kube-root-ca", "ca.crt")).toThrow();
  });

  it("reads the value from a file or piped stdin — one trailing newline dropped, an empty value refused", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "scp-cred-"));
    try {
      const f = path.join(dir, "v");
      await writeFile(f, "from-file\n");
      expect(await readCredentialValue({ fromFile: f })).toBe("from-file");
      const piped = Object.assign(Readable.from([Buffer.from("piped-value\n")]), {
        isTTY: false
      }) as unknown as NodeJS.ReadStream;
      expect(await readCredentialValue({}, { stdin: piped, stderr: process.stderr })).toBe(
        "piped-value"
      );
      const empty = Object.assign(Readable.from([Buffer.from("\n")]), {
        isTTY: false
      }) as unknown as NodeJS.ReadStream;
      await expect(
        readCredentialValue({}, { stdin: empty, stderr: process.stderr })
      ).rejects.toThrow(/no value/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("the value is never a command-line argument: `set` takes no value option or extra argument, and there is no `get`", () => {
    const program = new Command();
    registerStackCommands(program);
    const cred = program.commands
      .find((c) => c.name() === "stack")!
      .commands.find((c) => c.name() === "credential")!;
    expect(cred.commands.map((c) => c.name()).sort()).toEqual(["delete", "list", "set"]);
    const set = cred.commands.find((c) => c.name() === "set")!;
    expect(set.registeredArguments.map((a) => a.name())).toEqual(["backend", "secretName", "key"]);
    expect(set.options.map((o) => o.long)).not.toContain("--value");
    expect(set.options.map((o) => o.long)).toContain("--from-file");
  });
});
