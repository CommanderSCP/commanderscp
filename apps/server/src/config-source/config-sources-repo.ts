/** THE DB-BACKED CONFIG-SOURCE REGISTRY. See docs/config-source.md §13. */

import { and, eq, isNull } from "drizzle-orm";
import { objects } from "../db/schema.js";
import type { TenantTx } from "../db/tenant-tx.js";
import type { ConfigSourceRegistration } from "./registration-match.js";
import type { StackConfigSourceBinding } from "./cli-apply-guard.js";
import { findDeliveredStackOwner } from "./stack-delivery-repo.js";
import {
  CONFIG_SOURCE_TYPE_ID,
  parseConfigSourceDocument,
  type ConfigSourceDocument
} from "./config-source-document.js";

/** A stored `config-source` row whose `properties` do not parse — carried, not dropped. */
export interface MalformedConfigSource {
  id: string;
  name: string;
  /** The parse refusal's own message, verbatim, so the status says what is actually wrong. */
  detail: string;
}

export interface ConfigSourceRegistry {
  /** Every valid registration, in `id` order — the deterministic order every refusal in
   *  `registration-match.ts` reports in. */
  registrations: ConfigSourceRegistration[];
  /** Every row that could not be parsed, in `id` order. Empty in every healthy org. */
  malformed: MalformedConfigSource[];
  /** The parsed document beside its object id, for callers that need a field
   *  `ConfigSourceRegistration` does not carry (`ref`, `paths`) — the sync loop reads both. */
  documents: Map<string, ConfigSourceDocument>;
  /** Object id -> the row's display name, for self-explaining refusals without a second lookup. */
  names: Map<string, string>;
}

/** The sentence a refusal carries, falling back to whatever the value stringifies to — a non-
 *  `ProblemError` throw here would be a bug, but swallowing its text would hide it. */
function readRefusalDetail(error: unknown): string {
  const detail = (error as { detail?: unknown }).detail;
  if (typeof detail === "string" && detail !== "") return detail;
  return error instanceof Error ? error.message : String(error);
}

async function selectConfigSourceRows(tx: TenantTx, orgId: string) {
  return tx
    .select({
      id: objects.id,
      name: objects.name,
      properties: objects.properties
    })
    .from(objects)
    .where(
      and(
        eq(objects.orgId, orgId),
        eq(objects.typeId, CONFIG_SOURCE_TYPE_ID),
        isNull(objects.deletedAt)
      )
    );
}

/** Read every live config source in the org. See docs/config-source.md §14. */
export async function listConfigSourceRegistrations(
  tx: TenantTx,
  orgId: string
): Promise<ConfigSourceRegistry> {
  const rows = [...(await selectConfigSourceRows(tx, orgId))].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  );

  const registrations: ConfigSourceRegistration[] = [];
  const malformed: MalformedConfigSource[] = [];
  const documents = new Map<string, ConfigSourceDocument>();
  const names = new Map<string, string>();

  for (const row of rows) {
    names.set(row.id, row.name);
    let document: ConfigSourceDocument;
    try {
      document = parseConfigSourceDocument(
        (row.properties ?? {}) as Record<string, unknown>,
        `config-source '${row.name}'`
      );
    } catch (error) {
      malformed.push({
        id: row.id,
        name: row.name,
        // `.detail`, NOT `.message`. See docs/config-source.md §15.
        detail: readRefusalDetail(error)
      });
      continue;
    }
    documents.set(row.id, document);
    registrations.push({
      id: row.id,
      ...(document.repo !== undefined ? { repo: document.repo } : {}),
      ...(document.repoPattern !== undefined ? { repoPattern: document.repoPattern } : {}),
      team: document.team,
      stackTeams: document.stackTeams
    });
  }

  return { registrations, malformed, documents, names };
}

/** The D7 lookup. See docs/config-source.md §16. */
export async function findStackConfigSourceBinding(
  tx: TenantTx,
  orgId: string,
  stackName: string
): Promise<StackConfigSourceBinding | null> {
  const { registrations, names } = await listConfigSourceRegistrations(tx, orgId);
  const claimed = registrations.find((r) => r.stackTeams?.[stackName] !== undefined);
  if (claimed) {
    return { configSourceId: claimed.id, configSourceName: names.get(claimed.id) ?? claimed.id };
  }

  // D26 — the delivered half. A stack this config source has APPLIED is repo-owned even though no
  // operator wrote it into the map: the thing D7 protects against is the next sync reverting a
  // push, and the next sync will revert it either way.
  const delivered = await findDeliveredStackOwner(tx, orgId, stackName);
  if (!delivered) return null;
  // The name comes from the registrations read above while the source is live. A DELETED config
  // source keeps its delivery row on purpose (`drizzle/0101`), and its id is then the only honest
  // name to give — reporting "unowned" would hand the stack back to CLI-push while the manifest
  // that produced it still sits in a repo someone can re-register.
  return {
    configSourceId: delivered.configSourceId,
    configSourceName: names.get(delivered.configSourceId) ?? delivered.configSourceId
  };
}
