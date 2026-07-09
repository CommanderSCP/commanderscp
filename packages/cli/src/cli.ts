import { Command } from "commander";
import { ScpClient } from "@scp/sdk";
import type { ServiceObject } from "@scp/schemas";
import { saveCredentials } from "./config-store.js";
import { clientFromStoredCredentials, DEFAULT_BASE_URL } from "./client-factory.js";
import { promptLine } from "./prompt.js";
import { printResult, type OutputFormat } from "./output.js";

const SUPPORTED_OBJECT_TYPES = new Set(["service"]);

function assertSupportedType(type: string): void {
  if (!SUPPORTED_OBJECT_TYPES.has(type)) {
    throw new Error(
      `Unsupported object type '${type}' in M0 — only 'service' exists until the generic ` +
        `/objects/{type} endpoint lands in M1.`
    );
  }
}

function serviceObjectRow(o: ServiceObject): Record<string, string> {
  return { id: o.id, name: o.name, type: o.type, createdAt: o.createdAt };
}

export function buildProgram(): Command {
  const program = new Command();
  program.name("scp").description("CommanderSCP CLI").version("0.0.0");

  program
    .command("login")
    .description("Exchange local-auth credentials for a bearer token and store it")
    .option("-u, --username <username>", "username", process.env.SCP_USERNAME)
    .option("-p, --password <password>", "password", process.env.SCP_PASSWORD)
    .option("--base-url <url>", "API base URL", DEFAULT_BASE_URL)
    .action(async (opts: { username?: string; password?: string; baseUrl: string }) => {
      const username = opts.username ?? (await promptLine("Username: "));
      const password = opts.password ?? (await promptLine("Password: "));
      const client = new ScpClient({ baseUrl: opts.baseUrl });
      const result = await client.login(username, password);
      await saveCredentials({
        baseUrl: opts.baseUrl,
        token: result.token,
        org: result.org,
        expiresAt: result.expiresAt
      });
      console.log(`Logged in as '${username}' (org: ${result.org}). Token stored.`);
    });

  const objectCmd = program.command("object").description("Manage graph objects");

  objectCmd
    .command("create <type>")
    .description("Register an object (M0: 'service' only)")
    .requiredOption("--name <name>", "object name")
    .option("--org <org>", "explicit /orgs/{org} path override")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (
        type: string,
        opts: { name: string; org?: string; baseUrl?: string; output: OutputFormat }
      ) => {
        assertSupportedType(type);
        const client = await clientFromStoredCredentials(opts);
        const created = await client.objects.service.create(opts.name, { org: opts.org });
        printResult(created, opts.output, (item) => serviceObjectRow(item as ServiceObject));
      }
    );

  objectCmd
    .command("list <type>")
    .description("List objects (M0: 'service' only)")
    .option("--org <org>", "explicit /orgs/{org} path override")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (type: string, opts: { org?: string; baseUrl?: string; output: OutputFormat }) => {
      assertSupportedType(type);
      const client = await clientFromStoredCredentials(opts);
      const items: ServiceObject[] = [];
      for await (const item of client.listAllServiceObjects({}, { org: opts.org })) {
        items.push(item);
      }
      printResult(items, opts.output, (item) => serviceObjectRow(item as ServiceObject));
    });

  return program;
}

export async function runCli(argv: string[]): Promise<void> {
  const program = buildProgram();
  await program.parseAsync(argv);
}
