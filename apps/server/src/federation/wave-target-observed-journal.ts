import { and, eq } from "drizzle-orm";
import { boundPersistedJson } from "@scp/runner-launcher";
import { WaveTargetObservedPayloadSchema, type WaveTargetObservedPayload } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { objects } from "../db/schema.js";
import { appendJournalEntry } from "./journal-repo.js";
import { computeWaveTargetObservedContentHash } from "../graph/content-hash.js";

/**
 * THE SENDER HALF of the `wave_target_observed` journal kind (pipeline-mockup-data.md §5.3, owner
 * decisions D3/D4 of 2026-09-16).
 *
 * The domain that coordinates a change is the only one holding `change_wave_targets` and
 * `pipeline_hook_runs` rows, so it is the only one that can report what it observed. It appends one
 * entry per REAL change of an observation.
 *
 * THE RECEIVER HALF IS `peer-observations-repo.ts`, and the split is the echo-loop guard. This
 * module writes the journal and never the replica table; that one writes the replica table and never
 * the journal. `pipeline-hooks-repo.ts`'s `FederationImportable` flag exists because its sender and
 * receiver share a function — "a receiver that re-journalled what it was sent would echo the entry
 * back to its sender and, with two peers paired both ways, loop". Here they share nothing, so the
 * guard is structural: there is no code path from an import to this append.
 *
 * It is also why this file imports nothing from `coordination/`: the two call sites there
 * (`updateWaveTargetObserved` and the three `pipeline_hook_runs` status writes) import THIS, and a
 * cycle between the halves is how a "never on an unchanged re-poll" rule gets quietly relocated.
 */

/**
 * Appends one entry. Callers must already have decided that the observation CHANGED — this function
 * deliberately does not re-derive that, because the comparison needs the pre-image of the row being
 * updated and only the caller holds it. Each call site states its own no-change fast path and is
 * mutation-tested on it.
 *
 * The payload is PARSED before it is signed. A malformed payload appended here would be dropped by
 * every receiver (the import door parses the same schema) — silently, forever, while this side
 * believed it was reporting. Failing loudly at the append is the cheaper end of that trade.
 */
export async function appendWaveTargetObservedEntry(
  tx: TenantTx,
  orgId: string,
  payload: WaveTargetObservedPayload
): Promise<void> {
  const parsed = WaveTargetObservedPayloadSchema.parse(payload);
  // ADR-0031 §5: A DOMAIN-LOCAL CHANGE FEDERATES NOTHING, and that has to include its execution.
  // `createChange` marks the change object domain-local when its targets are, and `createObject`
  // then SKIPS the object's own journal entry — so without this check an observation would be the
  // one entry that carried a domain-local release's existence, target id and progress to every
  // peer, through a channel added after that rule was written. Checked HERE rather than at the two
  // call sites: every payload names a `changeObjectId`, so one lookup covers both subjects and any
  // caller added later. (A skip, not a `domainLocal: true` payload flag — the flag keeps the entry
  // in the local chain where it costs sequence numbers for nothing, and `createObject` already
  // chose the skip for the same fact.)
  const [change] = await tx
    .select({ domainLocal: objects.domainLocal })
    .from(objects)
    .where(and(eq(objects.orgId, orgId), eq(objects.id, parsed.changeObjectId)))
    .limit(1);
  if (change?.domainLocal === true) return;
  await appendJournalEntry(tx, {
    orgId,
    entryKind: "wave_target_observed",
    contentHash: computeWaveTargetObservedContentHash({ orgId, payload: parsed }),
    // BOUNDED ONCE, HERE, so neither call site can ship an unbounded executor-supplied string:
    // `rollout.message` is plugin output and `externalUrl` is an executor's. The proposal's volume
    // argument (§9 mitigation 3) is only true if the payload size is a constant.
    payload: boundPersistedJson(parsed).value as unknown as Record<string, unknown>
  });
}
