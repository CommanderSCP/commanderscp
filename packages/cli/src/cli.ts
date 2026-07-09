import { randomUUID } from "node:crypto";
import { Command } from "commander";
import { ScpClient } from "@scp/sdk";
import type { ListObjectsQuery, ListQuery } from "@scp/sdk";
import type {
  CreateObjectRequest,
  GraphObject,
  NamedGraphQuery,
  ObjectListResponse,
  Relationship,
  RelationshipListResponse,
  UpdateObjectRequest,
  UpsertObjectRequest
} from "@scp/schemas";
import { verifyAuditChain } from "@scp/schemas";
import { saveCredentials } from "./config-store.js";
import { clientFromStoredCredentials, DEFAULT_BASE_URL } from "./client-factory.js";
import { promptLine } from "./prompt.js";
import { printResult, type OutputFormat } from "./output.js";

function parseJsonOption(
  value: string | undefined,
  flag: string
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("not a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `${flag} must be a JSON object: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

function parseList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function objectRow(o: GraphObject): Record<string, string> {
  return {
    id: o.id,
    type: o.typeId,
    name: o.name,
    urn: o.urn,
    version: String(o.version),
    deleted: o.deletedAt ? "yes" : "no"
  };
}

function relationshipRow(r: Relationship): Record<string, string> {
  return { id: r.id, type: r.typeId, from: r.fromId, to: r.toId };
}

// -------------------------------------------------------------------------------------------
// M2 typed registries (BUILD_AND_TEST.md §8 M2 item 1). All 8 resources — domain/service/
// component/deployment-target/team/group/user/service-account — expose the exact same
// create/list/get/update/delete/upsertByUrn shape (ScpClient.typedResource), and the 4
// `owns`-eligible + 2 `consumes`/`depends_on`-eligible resources add ownership/edge methods on
// top. These three factories build the `register`/`list`/`get`/`update`/`delete`/`upsert` and
// `add-owner`/`add-consumes`/`add-depends-on` command families once, instead of hand-copying
// them per resource — mirroring routes/typed-registries.ts and routes/ownership.ts server-side.
// -------------------------------------------------------------------------------------------

interface TypedResourceOps {
  create(req: CreateObjectRequest, opts?: { idempotencyKey?: string }): Promise<GraphObject>;
  list(query?: ListObjectsQuery): Promise<ObjectListResponse>;
  get(idOrUrn: string): Promise<GraphObject>;
  update(idOrUrn: string, req: UpdateObjectRequest): Promise<GraphObject>;
  delete(idOrUrn: string): Promise<GraphObject>;
  upsertByUrn(urn: string, req: UpsertObjectRequest): Promise<GraphObject>;
}

interface OwnerOps {
  addOwner(
    idOrUrn: string,
    ownerIdOrUrn: string,
    opts?: { idempotencyKey?: string }
  ): Promise<Relationship>;
  listOwners(idOrUrn: string, query?: ListQuery): Promise<RelationshipListResponse>;
  removeOwner(idOrUrn: string, ownerIdOrUrn: string): Promise<Relationship>;
}

interface EdgeOps {
  addConsumes(
    idOrUrn: string,
    targetIdOrUrn: string,
    opts?: { idempotencyKey?: string }
  ): Promise<Relationship>;
  listConsumes(idOrUrn: string, query?: ListQuery): Promise<RelationshipListResponse>;
  removeConsumes(idOrUrn: string, targetIdOrUrn: string): Promise<Relationship>;
  addDependsOn(
    idOrUrn: string,
    targetIdOrUrn: string,
    opts?: { idempotencyKey?: string }
  ): Promise<Relationship>;
  listDependsOn(idOrUrn: string, query?: ListQuery): Promise<RelationshipListResponse>;
  removeDependsOn(idOrUrn: string, targetIdOrUrn: string): Promise<Relationship>;
}

interface BaseCliOpts {
  baseUrl?: string;
  output: OutputFormat;
}

/**
 * Registers `scp <name> register|list|get|update|delete|upsert`, options mirroring `object
 * create`/`object list`/etc. exactly. Returns the resource's top-level `Command` so callers can
 * attach `add-owner`/`add-consumes`/`add-depends-on` families on top where applicable.
 */
function registerTypedResourceCrud(
  program: Command,
  name: string,
  resourceOf: (client: ScpClient) => TypedResourceOps
): Command {
  const cmd = program.command(name).description(`Manage ${name} objects`);

  cmd
    .command("register")
    .description(`Create a ${name}`)
    .requiredOption("--name <name>", `${name} name`)
    .option("--id <uuid>", "client-suppliable UUIDv7 id")
    .option("--urn <urn>", "explicit URN (defaults to a derived one)")
    .option("--domain-id <id>", "containing object id (defaults to the org root)")
    .option("--properties <json>", "JSON object")
    .option("--labels <json>", "JSON object")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (
        opts: BaseCliOpts & {
          name: string;
          id?: string;
          urn?: string;
          domainId?: string;
          properties?: string;
          labels?: string;
        }
      ) => {
        const client = await clientFromStoredCredentials(opts);
        const created = await resourceOf(client).create(
          {
            name: opts.name,
            id: opts.id,
            urn: opts.urn,
            domainId: opts.domainId,
            properties: parseJsonOption(opts.properties, "--properties"),
            labels: parseJsonOption(opts.labels, "--labels")
          },
          { idempotencyKey: randomUUID() }
        );
        printResult(created, opts.output, (item) => objectRow(item as GraphObject));
      }
    );

  cmd
    .command("list")
    .description(`List ${name} objects`)
    .option("--domain-id <id>", "filter by containing object id")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (opts: BaseCliOpts & { domainId?: string }) => {
      const client = await clientFromStoredCredentials(opts);
      const page = await resourceOf(client).list({ domainId: opts.domainId, limit: 100 });
      printResult(page.items, opts.output, (item) => objectRow(item as GraphObject));
    });

  cmd
    .command("get <idOrUrn>")
    .description(`Get a ${name} by id or URN`)
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (idOrUrn: string, opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const found = await resourceOf(client).get(idOrUrn);
      printResult(found, opts.output, (item) => objectRow(item as GraphObject));
    });

  cmd
    .command("update <idOrUrn>")
    .description(`Partially update a ${name}`)
    .option("--name <name>")
    .option("--properties <json>", "JSON object (full replace)")
    .option("--labels <json>", "JSON object (full replace)")
    .option("--version <n>", "expected version (optimistic concurrency)")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (
        idOrUrn: string,
        opts: BaseCliOpts & {
          name?: string;
          properties?: string;
          labels?: string;
          version?: string;
        }
      ) => {
        const client = await clientFromStoredCredentials(opts);
        const updated = await resourceOf(client).update(idOrUrn, {
          name: opts.name,
          properties: parseJsonOption(opts.properties, "--properties"),
          labels: parseJsonOption(opts.labels, "--labels"),
          version: opts.version ? Number(opts.version) : undefined
        });
        printResult(updated, opts.output, (item) => objectRow(item as GraphObject));
      }
    );

  cmd
    .command("delete <idOrUrn>")
    .description(`Soft-delete a ${name}`)
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (idOrUrn: string, opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const deleted = await resourceOf(client).delete(idOrUrn);
      printResult(deleted, opts.output, (item) => objectRow(item as GraphObject));
    });

  cmd
    .command("upsert <urn>")
    .description("Idempotent upsert-by-URN")
    .requiredOption("--name <name>")
    .option("--properties <json>", "JSON object")
    .option("--labels <json>", "JSON object")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (
        urn: string,
        opts: BaseCliOpts & { name: string; properties?: string; labels?: string }
      ) => {
        const client = await clientFromStoredCredentials(opts);
        const result = await resourceOf(client).upsertByUrn(urn, {
          name: opts.name,
          properties: parseJsonOption(opts.properties, "--properties"),
          labels: parseJsonOption(opts.labels, "--labels")
        });
        printResult(result, opts.output, (item) => objectRow(item as GraphObject));
      }
    );

  return cmd;
}

/** Adds `add-owner`/`list-owners`/`remove-owner` to an existing resource command. */
function registerOwnerCommands(cmd: Command, resourceOf: (client: ScpClient) => OwnerOps): void {
  cmd
    .command("add-owner <idOrUrn>")
    .description("Add an owner (owns) — owner may be a team, group, user, or service-account")
    .requiredOption("--owner <ownerIdOrUrn>", "owner id or URN")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (idOrUrn: string, opts: BaseCliOpts & { owner: string }) => {
      const client = await clientFromStoredCredentials(opts);
      const created = await resourceOf(client).addOwner(idOrUrn, opts.owner, {
        idempotencyKey: randomUUID()
      });
      printResult(created, opts.output, (item) => relationshipRow(item as Relationship));
    });

  cmd
    .command("list-owners <idOrUrn>")
    .description("List direct owners")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (idOrUrn: string, opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const page = await resourceOf(client).listOwners(idOrUrn, { limit: 100 });
      printResult(page.items, opts.output, (item) => relationshipRow(item as Relationship));
    });

  cmd
    .command("remove-owner <idOrUrn> <ownerIdOrUrn>")
    .description("Remove an owner")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (idOrUrn: string, ownerIdOrUrn: string, opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const deleted = await resourceOf(client).removeOwner(idOrUrn, ownerIdOrUrn);
      printResult(deleted, opts.output, (item) => relationshipRow(item as Relationship));
    });
}

/** Adds `add-consumes|add-depends-on` (+ list/remove) to an existing resource command. */
function registerEdgeCommands(
  cmd: Command,
  edge: "consumes" | "depends-on",
  resourceOf: (client: ScpClient) => EdgeOps
): void {
  const relTypeId = edge === "consumes" ? "consumes" : "depends_on";
  const add = (ops: EdgeOps) => (edge === "consumes" ? ops.addConsumes : ops.addDependsOn);
  const list = (ops: EdgeOps) => (edge === "consumes" ? ops.listConsumes : ops.listDependsOn);
  const remove = (ops: EdgeOps) => (edge === "consumes" ? ops.removeConsumes : ops.removeDependsOn);

  cmd
    .command(`add-${edge} <idOrUrn>`)
    .description(`Add a '${relTypeId}' edge`)
    .requiredOption("--target <targetIdOrUrn>", "target id or URN")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (idOrUrn: string, opts: BaseCliOpts & { target: string }) => {
      const client = await clientFromStoredCredentials(opts);
      const created = await add(resourceOf(client))(idOrUrn, opts.target, {
        idempotencyKey: randomUUID()
      });
      printResult(created, opts.output, (item) => relationshipRow(item as Relationship));
    });

  cmd
    .command(`list-${edge} <idOrUrn>`)
    .description(`List direct outgoing '${relTypeId}' edges`)
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (idOrUrn: string, opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const page = await list(resourceOf(client))(idOrUrn, { limit: 100 });
      printResult(page.items, opts.output, (item) => relationshipRow(item as Relationship));
    });

  cmd
    .command(`remove-${edge} <idOrUrn> <targetIdOrUrn>`)
    .description(`Remove a '${relTypeId}' edge`)
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (idOrUrn: string, targetIdOrUrn: string, opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const deleted = await remove(resourceOf(client))(idOrUrn, targetIdOrUrn);
      printResult(deleted, opts.output, (item) => relationshipRow(item as Relationship));
    });
}

export function buildProgram(): Command {
  const program = new Command();
  program.name("scp").description("CommanderSCP CLI").version("0.0.0");

  // -------------------------------------------------------------------------------------
  // login
  // -------------------------------------------------------------------------------------
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

  // -------------------------------------------------------------------------------------
  // type-registry (DESIGN.md §4.1)
  // -------------------------------------------------------------------------------------
  const typeRegistryCmd = program
    .command("type-registry")
    .description("Manage the runtime type registry");

  typeRegistryCmd
    .command("object-type-create <id>")
    .description("Register a custom object type")
    .requiredOption("--display-name <name>", "human-readable display name")
    .option("--schema <json>", "JSON Schema validating instance properties")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (
        id: string,
        opts: { displayName: string; schema?: string; baseUrl?: string; output: OutputFormat }
      ) => {
        const client = await clientFromStoredCredentials(opts);
        const created = await client.typeRegistry.objectTypes.create(
          {
            id,
            displayName: opts.displayName,
            propertySchema: parseJsonOption(opts.schema, "--schema")
          },
          { idempotencyKey: randomUUID() }
        );
        printResult(created, opts.output, (item) => ({
          id: (item as { id: string }).id,
          displayName: (item as { displayName: string }).displayName
        }));
      }
    );

  typeRegistryCmd
    .command("object-type-list")
    .description("List object types (built-in + org-defined)")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (opts: { baseUrl?: string; output: OutputFormat }) => {
      const client = await clientFromStoredCredentials(opts);
      const page = await client.typeRegistry.objectTypes.list({ limit: 100 });
      printResult(page.items, opts.output, (item) => ({
        id: (item as { id: string }).id,
        displayName: (item as { displayName: string }).displayName,
        builtin: String((item as { isBuiltin: boolean }).isBuiltin)
      }));
    });

  typeRegistryCmd
    .command("relationship-type-create <id>")
    .description("Register a custom relationship type")
    .requiredOption("--display-name <name>", "human-readable display name")
    .option("--from-types <list>", "comma-separated allowed 'from' object types")
    .option("--to-types <list>", "comma-separated allowed 'to' object types")
    .option("--cardinality <cardinality>", "one_to_one|one_to_many|many_to_many", "many_to_many")
    .option("--schema <json>", "JSON Schema validating instance properties")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (
        id: string,
        opts: {
          displayName: string;
          fromTypes?: string;
          toTypes?: string;
          cardinality: "one_to_one" | "one_to_many" | "many_to_many";
          schema?: string;
          baseUrl?: string;
          output: OutputFormat;
        }
      ) => {
        const client = await clientFromStoredCredentials(opts);
        const created = await client.typeRegistry.relationshipTypes.create(
          {
            id,
            displayName: opts.displayName,
            fromTypes: parseList(opts.fromTypes),
            toTypes: parseList(opts.toTypes),
            cardinality: opts.cardinality,
            propertySchema: parseJsonOption(opts.schema, "--schema")
          },
          { idempotencyKey: randomUUID() }
        );
        printResult(created, opts.output, (item) => ({
          id: (item as { id: string }).id,
          displayName: (item as { displayName: string }).displayName,
          cardinality: (item as { cardinality: string }).cardinality
        }));
      }
    );

  typeRegistryCmd
    .command("relationship-type-list")
    .description("List relationship types (built-in + org-defined)")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (opts: { baseUrl?: string; output: OutputFormat }) => {
      const client = await clientFromStoredCredentials(opts);
      const page = await client.typeRegistry.relationshipTypes.list({ limit: 100 });
      printResult(page.items, opts.output, (item) => ({
        id: (item as { id: string }).id,
        cardinality: (item as { cardinality: string }).cardinality,
        builtin: String((item as { isBuiltin: boolean }).isBuiltin)
      }));
    });

  // -------------------------------------------------------------------------------------
  // object (generic — works for ANY registered type, built-in or custom)
  // -------------------------------------------------------------------------------------
  const objectCmd = program
    .command("object")
    .description("Manage graph objects of any registered type");

  objectCmd
    .command("create <type>")
    .description("Create an object")
    .requiredOption("--name <name>", "object name")
    .option("--id <uuid>", "client-suppliable UUIDv7 id")
    .option("--urn <urn>", "explicit URN (defaults to a derived one)")
    .option("--domain-id <id>", "containing object id (defaults to the org root)")
    .option("--properties <json>", "JSON object")
    .option("--labels <json>", "JSON object")
    .option("--org <org>", "explicit /orgs/{org} path override")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (
        type: string,
        opts: {
          name: string;
          id?: string;
          urn?: string;
          domainId?: string;
          properties?: string;
          labels?: string;
          baseUrl?: string;
          output: OutputFormat;
        }
      ) => {
        const client = await clientFromStoredCredentials(opts);
        const created = await client.object(type).create(
          {
            name: opts.name,
            id: opts.id,
            urn: opts.urn,
            domainId: opts.domainId,
            properties: parseJsonOption(opts.properties, "--properties"),
            labels: parseJsonOption(opts.labels, "--labels")
          },
          { idempotencyKey: randomUUID() }
        );
        printResult(created, opts.output, (item) => objectRow(item as GraphObject));
      }
    );

  objectCmd
    .command("list <type>")
    .description("List objects of a type")
    .option("--domain-id <id>", "filter by containing object id")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (type: string, opts: { domainId?: string; baseUrl?: string; output: OutputFormat }) => {
        const client = await clientFromStoredCredentials(opts);
        const items: GraphObject[] = [];
        for await (const item of client.listAllObjects(type, { domainId: opts.domainId }))
          items.push(item);
        printResult(items, opts.output, (item) => objectRow(item as GraphObject));
      }
    );

  objectCmd
    .command("get <type> <idOrUrn>")
    .description("Get an object by id or URN")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (type: string, idOrUrn: string, opts: { baseUrl?: string; output: OutputFormat }) => {
        const client = await clientFromStoredCredentials(opts);
        const found = await client.object(type).get(idOrUrn);
        printResult(found, opts.output, (item) => objectRow(item as GraphObject));
      }
    );

  objectCmd
    .command("update <type> <idOrUrn>")
    .description("Partially update an object")
    .option("--name <name>")
    .option("--properties <json>", "JSON object (full replace)")
    .option("--labels <json>", "JSON object (full replace)")
    .option("--version <n>", "expected version (optimistic concurrency)")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (
        type: string,
        idOrUrn: string,
        opts: {
          name?: string;
          properties?: string;
          labels?: string;
          version?: string;
          baseUrl?: string;
          output: OutputFormat;
        }
      ) => {
        const client = await clientFromStoredCredentials(opts);
        const updated = await client.object(type).update(idOrUrn, {
          name: opts.name,
          properties: parseJsonOption(opts.properties, "--properties"),
          labels: parseJsonOption(opts.labels, "--labels"),
          version: opts.version ? Number(opts.version) : undefined
        });
        printResult(updated, opts.output, (item) => objectRow(item as GraphObject));
      }
    );

  objectCmd
    .command("delete <type> <idOrUrn>")
    .description("Soft-delete an object")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (type: string, idOrUrn: string, opts: { baseUrl?: string; output: OutputFormat }) => {
        const client = await clientFromStoredCredentials(opts);
        const deleted = await client.object(type).delete(idOrUrn);
        printResult(deleted, opts.output, (item) => objectRow(item as GraphObject));
      }
    );

  objectCmd
    .command("upsert <type> <urn>")
    .description("Idempotent upsert-by-URN")
    .requiredOption("--name <name>")
    .option("--properties <json>", "JSON object")
    .option("--labels <json>", "JSON object")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (
        type: string,
        urn: string,
        opts: {
          name: string;
          properties?: string;
          labels?: string;
          baseUrl?: string;
          output: OutputFormat;
        }
      ) => {
        const client = await clientFromStoredCredentials(opts);
        const result = await client.object(type).upsertByUrn(urn, {
          name: opts.name,
          properties: parseJsonOption(opts.properties, "--properties"),
          labels: parseJsonOption(opts.labels, "--labels")
        });
        printResult(result, opts.output, (item) => objectRow(item as GraphObject));
      }
    );

  // -------------------------------------------------------------------------------------
  // rel (relationships)
  // -------------------------------------------------------------------------------------
  const relCmd = program.command("rel").description("Manage graph relationships");

  relCmd
    .command("create")
    .description("Create a relationship")
    .requiredOption("--type <typeId>", "relationship type id")
    .requiredOption("--from <id>", "'from' object id")
    .requiredOption("--to <id>", "'to' object id")
    .option("--properties <json>", "JSON object")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (opts: {
        type: string;
        from: string;
        to: string;
        properties?: string;
        baseUrl?: string;
        output: OutputFormat;
      }) => {
        const client = await clientFromStoredCredentials(opts);
        const created = await client.relationships.create(
          {
            typeId: opts.type,
            fromId: opts.from,
            toId: opts.to,
            properties: parseJsonOption(opts.properties, "--properties")
          },
          { idempotencyKey: randomUUID() }
        );
        printResult(created, opts.output, (item) => relationshipRow(item as Relationship));
      }
    );

  relCmd
    .command("list")
    .description("List relationships")
    .option("--from <id>", "filter by 'from' object id")
    .option("--to <id>", "filter by 'to' object id")
    .option("--type <typeId>", "filter by relationship type id")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (opts: {
        from?: string;
        to?: string;
        type?: string;
        baseUrl?: string;
        output: OutputFormat;
      }) => {
        const client = await clientFromStoredCredentials(opts);
        const page = await client.relationships.list({
          fromId: opts.from,
          toId: opts.to,
          typeId: opts.type,
          limit: 100
        });
        printResult(page.items, opts.output, (item) => relationshipRow(item as Relationship));
      }
    );

  relCmd
    .command("get <id>")
    .description("Get a relationship")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (id: string, opts: { baseUrl?: string; output: OutputFormat }) => {
      const client = await clientFromStoredCredentials(opts);
      const found = await client.relationships.get(id);
      printResult(found, opts.output, (item) => relationshipRow(item as Relationship));
    });

  relCmd
    .command("delete <id>")
    .description("Soft-delete a relationship")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (id: string, opts: { baseUrl?: string; output: OutputFormat }) => {
      const client = await clientFromStoredCredentials(opts);
      const deleted = await client.relationships.delete(id);
      printResult(deleted, opts.output, (item) => relationshipRow(item as Relationship));
    });

  // -------------------------------------------------------------------------------------
  // M2 typed registries (BUILD_AND_TEST.md §8 M2 item 1): one top-level command per resource,
  // same shape as `object`/`rel` above, built from the factories defined earlier in this file.
  // -------------------------------------------------------------------------------------
  const domainCmd = registerTypedResourceCrud(program, "domain", (c) => c.domains);
  registerOwnerCommands(domainCmd, (c) => c.domains);

  const serviceCmd = registerTypedResourceCrud(program, "service", (c) => c.services);
  registerOwnerCommands(serviceCmd, (c) => c.services);
  registerEdgeCommands(serviceCmd, "consumes", (c) => c.services);
  registerEdgeCommands(serviceCmd, "depends-on", (c) => c.services);

  const componentCmd = registerTypedResourceCrud(program, "component", (c) => c.components);
  registerOwnerCommands(componentCmd, (c) => c.components);
  registerEdgeCommands(componentCmd, "consumes", (c) => c.components);
  registerEdgeCommands(componentCmd, "depends-on", (c) => c.components);

  const deploymentTargetCmd = registerTypedResourceCrud(
    program,
    "deployment-target",
    (c) => c.deploymentTargets
  );
  registerOwnerCommands(deploymentTargetCmd, (c) => c.deploymentTargets);

  registerTypedResourceCrud(program, "team", (c) => c.teams);
  registerTypedResourceCrud(program, "group", (c) => c.groups);
  registerTypedResourceCrud(program, "user", (c) => c.users);
  registerTypedResourceCrud(program, "service-account", (c) => c.serviceAccounts);

  // -------------------------------------------------------------------------------------
  // graph (named queries + traverse — DESIGN.md §5)
  // -------------------------------------------------------------------------------------
  const graphCmd = program.command("graph").description("Run graph queries");

  graphCmd
    .command("query <name>")
    .description(
      "Run a named graph query (owners-of|dependents-of|consumers-of|impact-of|blast-radius|paths-between|domains-impacted)"
    )
    .requiredOption("--object-id <id>", "the object to query from")
    .option("--target-id <id>", "required by paths-between")
    .option("--rel-types <list>", "comma-separated relationship type override")
    .option("--max-depth <n>", "max traversal depth (<=10)", "10")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (
        name: string,
        opts: {
          objectId: string;
          targetId?: string;
          relTypes?: string;
          maxDepth: string;
          baseUrl?: string;
          output: OutputFormat;
        }
      ) => {
        const client = await clientFromStoredCredentials(opts);
        const result = await client.graph.query(name as NamedGraphQuery, {
          objectId: opts.objectId,
          targetId: opts.targetId,
          relTypes: parseList(opts.relTypes),
          maxDepth: Number(opts.maxDepth)
        });
        printResult(result.objects, opts.output, (item) => objectRow(item as GraphObject));
      }
    );

  graphCmd
    .command("traverse")
    .description("Bounded generic graph traversal")
    .requiredOption("--object-id <id>", "the object to traverse from")
    .option("--direction <direction>", "out|in|both", "out")
    .option("--rel-types <list>", "comma-separated relationship type filter")
    .option("--max-depth <n>", "max traversal depth (<=10)", "3")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (opts: {
        objectId: string;
        direction: "out" | "in" | "both";
        relTypes?: string;
        maxDepth: string;
        baseUrl?: string;
        output: OutputFormat;
      }) => {
        const client = await clientFromStoredCredentials(opts);
        const result = await client.graph.traverse({
          objectId: opts.objectId,
          direction: opts.direction,
          relTypes: parseList(opts.relTypes),
          maxDepth: Number(opts.maxDepth)
        });
        printResult(result.objects, opts.output, (item) => objectRow(item as GraphObject));
      }
    );

  // -------------------------------------------------------------------------------------
  // audit
  // -------------------------------------------------------------------------------------
  const auditCmd = program.command("audit").description("Audit log");

  auditCmd
    .command("verify")
    .description(
      "Re-walk the org's hash-chained audit log via the public API and verify it (DESIGN.md §4.3)"
    )
    .option("--base-url <url>", "API base URL override")
    .action(async (opts: { baseUrl?: string }) => {
      const client = await clientFromStoredCredentials(opts);
      const events = [];
      for await (const event of client.listAllAuditEvents()) events.push(event);
      const result = verifyAuditChain(events);
      if (result.valid) {
        console.log(`OK: audit chain verified (${result.eventCount} events).`);
        return;
      }
      console.error(
        `FAILED: audit chain broken at event ${result.brokenAt?.id} — ${result.brokenAt?.reason} (${result.eventCount} events checked).`
      );
      process.exitCode = 1;
    });

  return program;
}

export async function runCli(argv: string[]): Promise<void> {
  const program = buildProgram();
  await program.parseAsync(argv);
}
