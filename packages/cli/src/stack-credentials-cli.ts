import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import type { Command } from "commander";
import {
  STACK_WORKLOAD_IDENTITY_PROVIDERS,
  StackCredentialBackendSchema,
  StackCredentialKeySchema,
  StackCredentialSecretNameSchema,
  StackWorkloadIdentityBackendSchema,
  StackWorkloadIdentityServiceAccountSchema,
  isCatalogTarget,
  type StackCredentialKeyView,
  type StackCredentialTarget,
  type StackCredentialsView,
  type StackWorkloadIdentityBinding,
  type StackWorkloadIdentityProvider
} from "@scp/schemas";
import { clientFromStoredCredentials } from "./client-factory.js";
import { printResult, type OutputFormat } from "./output.js";

/**
 * `scp stack credential …` and `scp stack workload-identity …` — credentials through SCP (M29.5,
 * ADR-0063). WRITE-ONLY: a value goes in and never comes back — there is no `get`, because there is
 * no read route. The value is NEVER an argument (it would sit in shell history and `ps`): it is read
 * from a hidden prompt, from stdin when piped, or from `--from-file`.
 */

interface CredOpts {
  baseUrl?: string;
  output: OutputFormat;
  operatorToken?: string;
  fromFile?: string;
}

const tokenOf = (o: { operatorToken?: string }) =>
  o.operatorToken ?? process.env.SCP_OPERATOR_TOKEN ?? undefined;

/** The catalog target, held to the schema's own vocabulary and then to the catalog's pairs. */
export function credentialTargetOf(
  backend: string,
  secretName: string,
  key: string
): StackCredentialTarget {
  const b = StackCredentialBackendSchema.safeParse(backend);
  const s = StackCredentialSecretNameSchema.safeParse(secretName);
  const k = StackCredentialKeySchema.safeParse(key);
  if (!b.success || !s.success || !k.success || !isCatalogTarget(backend, secretName, key)) {
    throw new Error(
      `${backend} ${secretName} ${key} is not a credential SCP can deliver — \`scp stack credential list\` shows the catalog`
    );
  }
  return { backend: b.data, secretName: s.data, key: k.data };
}

/** Reads the value from a file, from piped stdin, or from a prompt that does not echo. A single
 *  trailing newline (what `echo` and editors add) is dropped. */
export async function readCredentialValue(
  opts: { fromFile?: string },
  io: { stdin: NodeJS.ReadStream; stderr: NodeJS.WriteStream } = {
    stdin: process.stdin,
    stderr: process.stderr
  }
): Promise<string> {
  const strip = (v: string) => v.replace(/\r?\n$/, "");
  let value: string;
  if (opts.fromFile) {
    value = strip(await readFile(opts.fromFile, "utf8"));
  } else if (!io.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const c of io.stdin) chunks.push(Buffer.from(c as Buffer));
    value = strip(Buffer.concat(chunks).toString("utf8"));
  } else {
    io.stderr.write("Value (not echoed): ");
    const muted = new Writable({ write: (_c, _e, cb) => cb() });
    const rl = createInterface({ input: io.stdin, output: muted, terminal: true });
    value = await new Promise<string>((resolve) => rl.question("", resolve));
    rl.close();
    io.stderr.write("\n");
  }
  if (value.length === 0) throw new Error("no value given — nothing was sent");
  return value;
}

export function credentialRow(k: StackCredentialKeyView): Record<string, string> {
  return {
    secret: k.secretName,
    key: k.key,
    state: k.pendingOp ? `${k.state} (${k.pendingOp})` : k.state,
    by: k.requestedBy?.username ?? k.requestedBy?.mechanism ?? "-",
    requested: k.requestedAt ?? "-",
    delivered: k.deliveredAt ?? "-",
    error: k.error ?? "-"
  };
}

function printCredentials(view: StackCredentialsView, output: OutputFormat): void {
  if (output === "json") {
    console.log(JSON.stringify(view, null, 2));
    return;
  }
  console.log(
    view.sealingKey.published
      ? "the stack controller's sealing key is published: values entered are sealed to it"
      : "the stack controller has NOT published its sealing key — no value can be entered until it runs"
  );
  for (const s of view.secrets) {
    console.log(`\n${s.backend} / ${s.secretName} — ${s.purpose}`);
    printResult(s.keys, output, (raw) => credentialRow(raw as StackCredentialKeyView));
  }
  console.log("\nworkload identities (preferred: nothing to enter):");
  printResult(view.workloadIdentities, output, (raw) => {
    const w = raw as StackCredentialsView["workloadIdentities"][number];
    return {
      backend: w.backend,
      serviceAccount: w.serviceAccount,
      provider: w.binding?.provider ?? "-",
      identifier: w.binding?.identifier ?? "-",
      declared: w.declaredAt ?? "-"
    };
  });
}

const operatorOption = [
  "--operator-token <token>",
  "a deployment operator credential (else $SCP_OPERATOR_TOKEN; else your login's instance-operator role)"
] as const;

export function registerStackCredentialCommands(stack: Command): void {
  const cred = stack
    .command("credential")
    .description(
      "Credentials a bundled backend needs (a registry push token, cloud credentials, a git token), entered once through SCP and written by the stack controller into the backend's own Secret. Write-only: SCP keeps no copy and cannot show one"
    );

  cred
    .command("list")
    .description("The catalog of Secrets and keys, each key's state — never a value")
    .option(...operatorOption)
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (opts: CredOpts) => {
      const client = await clientFromStoredCredentials(opts);
      printCredentials(await client.stack.credentials(tokenOf(opts)), opts.output);
    });

  cred
    .command("set <backend> <secretName> <key>")
    // A value typed as a fourth argument is already in shell history: refuse it loudly rather than
    // ignore it and wait on stdin.
    .allowExcessArguments(false)
    .description(
      "Enter (or rotate) one key. The value is read from a hidden prompt, from stdin when piped, or from --from-file — never from the command line"
    )
    .option("--from-file <path>", "read the value from this file")
    .option(...operatorOption)
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (backend: string, secretName: string, key: string, opts: CredOpts) => {
      const target = credentialTargetOf(backend, secretName, key);
      const value = await readCredentialValue(opts);
      const client = await clientFromStoredCredentials(opts);
      const k = await client.stack.setCredential(target, value, tokenOf(opts));
      printResult([k], opts.output, (raw) => credentialRow(raw as StackCredentialKeyView));
    });

  cred
    .command("delete <backend> <secretName> <key>")
    .description("Remove one key from the backend's Secret (the stack controller deletes it)")
    .option(...operatorOption)
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (backend: string, secretName: string, key: string, opts: CredOpts) => {
      const target = credentialTargetOf(backend, secretName, key);
      const client = await clientFromStoredCredentials(opts);
      const k = await client.stack.deleteCredential(target, tokenOf(opts));
      printResult([k], opts.output, (raw) => credentialRow(raw as StackCredentialKeyView));
    });

  const wi = stack
    .command("workload-identity")
    .description(
      `Declare that a stack ServiceAccount gets its cloud authority from workload identity, so nothing needs entering: ${Object.keys(STACK_WORKLOAD_IDENTITY_PROVIDERS).join(", ")}`
    );

  const slotOf = (backend: string, serviceAccount: string) => {
    const b = StackWorkloadIdentityBackendSchema.safeParse(backend);
    const s = StackWorkloadIdentityServiceAccountSchema.safeParse(serviceAccount);
    if (!b.success || !s.success) {
      throw new Error(
        `${backend} ${serviceAccount} is not a ServiceAccount a workload identity may be declared for — \`scp stack credential list\` shows them`
      );
    }
    return { backend: b.data, serviceAccount: s.data };
  };

  wi.command("set <backend> <serviceAccount>")
    .description("Declare (or change) the workload identity of one ServiceAccount")
    .requiredOption(
      "--provider <provider>",
      Object.keys(STACK_WORKLOAD_IDENTITY_PROVIDERS).join("|")
    )
    .requiredOption(
      "--identifier <id>",
      "the provider's identifier: an IAM role ARN, a Google service account email, or an Azure client id"
    )
    .option(...operatorOption)
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (
        backend: string,
        serviceAccount: string,
        opts: CredOpts & { provider: string; identifier: string }
      ) => {
        if (!Object.hasOwn(STACK_WORKLOAD_IDENTITY_PROVIDERS, opts.provider)) {
          throw new Error(
            `--provider must be one of ${Object.keys(STACK_WORKLOAD_IDENTITY_PROVIDERS).join("|")}`
          );
        }
        const binding = {
          provider: opts.provider as StackWorkloadIdentityProvider,
          identifier: opts.identifier
        } as StackWorkloadIdentityBinding;
        const client = await clientFromStoredCredentials(opts);
        printCredentials(
          await client.stack.putWorkloadIdentity(
            slotOf(backend, serviceAccount),
            binding,
            tokenOf(opts)
          ),
          opts.output
        );
      }
    );

  wi.command("delete <backend> <serviceAccount>")
    .description("Withdraw a workload-identity declaration")
    .option(...operatorOption)
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (backend: string, serviceAccount: string, opts: CredOpts) => {
      const client = await clientFromStoredCredentials(opts);
      printCredentials(
        await client.stack.deleteWorkloadIdentity(slotOf(backend, serviceAccount), tokenOf(opts)),
        opts.output
      );
    });
}
