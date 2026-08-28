/**
 * THE DB-BACKED CONFIG-SOURCE REGISTRY — the read half of ADR-0046 §1, and the layer the four pure
 * modules beside it were written to be called from (`registration-match.ts`'s own header names
 * this as "a later increment's job").
 *
 * Config sources are ordinary graph objects of type `config-source` (migration 0100): there is no
 * table, no projection row, and no second write anywhere. So the registry read is a plain typed
 * select over `objects`, and this module's whole job is turning stored rows into the two shapes its
 * callers already decide over — `ConfigSourceRegistration` for `registration-match.ts`, and
 * `StackConfigSourceBinding` for `cli-apply-guard.ts`.
 *
 * ================================================================================================
 * A ROW THAT DOES NOT PARSE IS REPORTED, NEVER SKIPPED
 * ================================================================================================
 * `authoring-guard.ts` refuses a malformed document at every local write door, so a malformed row
 * should not exist. "Should not" is not "cannot": the door is deliberately exempt on the federation
 * import path (a throw there wedges a peer's whole bundle — ADR-0033 §8), and a row written before
 * the guard existed does not re-validate itself.
 *
 * Dropping such a row from the list would produce the precise failure §4 of the proposal rules out:
 * a repository silently ahead of the graph, with a registration that exists, looks fine in a list,
 * and never syncs. So {@link listConfigSourceRegistrations} returns the malformed ones ALONGSIDE the
 * valid ones, with the reason attached, for the sync loop to surface as status. This costs the
 * caller one field it must decide what to do with — which is the point.
 */

import { and, eq, isNull } from "drizzle-orm";
import { objects } from "../db/schema.js";
import type { TenantTx } from "../db/tenant-tx.js";
import type { ConfigSourceRegistration } from "./registration-match.js";
import type { StackConfigSourceBinding } from "./cli-apply-guard.js";
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

/**
 * Read every live config source in the org.
 *
 * Not paginated, deliberately: every consumer needs the WHOLE set to answer its question at all —
 * `registration-match.ts`'s two refusals are "this repo matched more than one registration" and
 * "another registration already claims this stack name", and both are false-negative-prone on a
 * page. One registration covers a team's entire fleet of repos (D9), so the row count is
 * per-team-ish, not per-repo.
 */
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
        // `.detail`, NOT `.message`. A `ProblemError`'s `message` is the RFC 9457 TITLE — the bare
        // word "Bad Request" (`errors.ts`) — and the sentence saying WHICH rule the row breaks is
        // on `detail`. Reporting the title would satisfy every "is it reported?" test while telling
        // an operator staring at a repo that will not sync exactly nothing, which is the failure
        // this module's header says it exists to prevent. Measured, not assumed: case (7) of
        // `config-source-doors.integration.test.ts` failed on precisely this.
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

/**
 * The D7 lookup: is this stack repo-owned, and by which config source?
 *
 * BINDING IS THE EXPLICIT `stackTeams` CLAIM, never the repo pattern. §4 is precise about this —
 * "per-stack ownership: `stackName → team` … Binding a stack here marks it repo-owned (D7)" — and
 * the distinction matters in the direction that protects the operator: a team registering its whole
 * repo namespace does NOT thereby lock every stack name it might ever push from a terminal. A stack
 * becomes repo-owned when someone writes it into the map, which is a thing they did on purpose.
 *
 * THAT IS HALF THE PREDICATE, AND THE OTHER HALF ARRIVES IN ROUND C (D26, owner ruling
 * 2026-08-27 — proposal §5). §4's map and D9's default-team rule disagree about an UNCLAIMED
 * stack: `registration-match.ts` resolves one to the registration's default team and the sync will
 * apply it, but nothing here marks it repo-owned, so a CLI push to that stack succeeds and the next
 * sync silently reverts it — D7's own failure mode, reached by forgetting a line rather than by
 * doing anything wrong. The ruling is that **ownership follows delivery**: the sync records every
 * stack it has applied for a config source, and this function returns the explicit claims UNION
 * that record. The record cannot exist before the sync loop that writes it, so this function is
 * deliberately half-built and says so, rather than reading as a settled rule.
 *
 * WHEN TWO REGISTRATIONS CLAIM ONE STACK NAME this returns the lowest-id one, and that is a
 * reporting choice, not an adjudication: the answer to "is this stack repo-owned" is `true` under
 * either, so the 409 fires either way and only the name it prints is at stake.
 * `resolveConfigSourceForSync` refuses that same state loudly (`stack_owned_elsewhere`) when the
 * sync itself runs, which is where it can be fixed.
 */
export async function findStackConfigSourceBinding(
  tx: TenantTx,
  orgId: string,
  stackName: string
): Promise<StackConfigSourceBinding | null> {
  const { registrations, names } = await listConfigSourceRegistrations(tx, orgId);
  const owner = registrations.find((r) => r.stackTeams?.[stackName] !== undefined);
  if (!owner) return null;
  return {
    configSourceId: owner.id,
    configSourceName: names.get(owner.id) ?? owner.id
  };
}
