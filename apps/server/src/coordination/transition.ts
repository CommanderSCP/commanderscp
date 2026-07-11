import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { ChangeState, Decision } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { changes } from "../db/schema.js";
import { notFound } from "../errors.js";
import { appendAuditEvent } from "../audit/audit-repo.js";
import { eventBus } from "../events/event-bus.js";
import { findEdge, isLegalTransition } from "./transitions.js";
import { evaluateLifecycleGate, type GateDeps } from "./gates.js";
import { insertDecision } from "./decisions-repo.js";
import { appendJournalEntry } from "../federation/journal-repo.js";
import { changeStatusContentHash } from "./changes-repo.js";

type ChangeRow = typeof changes.$inferSelect;

function stateHash(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}

export interface TransitionChangeInput {
  orgId: string;
  changeObjectId: string;
  toState: ChangeState;
  actorObjectId: string;
  requestId: string;
  /** Human-supplied reason — required by callers for cancel/rollback (validated at the route layer). */
  reason?: string | null;
  /** Extra context merged into the Decision's `input_context` (e.g. rollback trigger metadata). */
  extraInputContext?: Record<string, unknown>;
  /** Explicit freeze-override intent (DESIGN §10.3: mandatory reason + `freeze:override`
   *  permission, checked by `governance/gate-orchestrator.ts`). `reason` here doubles as the
   *  override's mandatory reason — routes/changes.ts requires both to be present together. */
  overrideFreeze?: { reason: string } | undefined;
}

export type TransitionResult =
  | { verdict: "allow"; changeRow: ChangeRow; decision: Decision }
  | { verdict: "block"; decision: Decision; blockedReason: string };

/**
 * THE single guarded transition function (DESIGN.md §9.1) — every `changes.state` mutation in the
 * system goes through this, and only this. Must run inside the caller's `withTenantTx` (it does
 * not open its own transaction) so its writes commit or roll back atomically with whatever else
 * the caller is doing in the same request/job.
 *
 * Atomically, in order: (1) locks the change row (`SELECT ... FOR UPDATE`) so two concurrent
 * transition attempts on the same change serialize rather than race; (2) checks legality — a pure
 * function, `coordination/transitions.ts` — then the gate seam (`coordination/gates.ts`);
 * (3) writes EXACTLY ONE Decision recording the verdict either way; (4) ONLY on `verdict: allow`,
 * updates `changes.state` (+ resets the watchdog clock), writes the audit event, and publishes an
 * outbox event.
 *
 * Deliberately does NOT throw for an "expected" block (illegal edge or a failed gate) — it
 * returns `{ verdict: 'block', decision, blockedReason }` and lets the enclosing transaction
 * commit normally, so the Decision (and a `change.transition.blocked` audit event) persist even
 * though nothing about the change itself changed. Route handlers (routes/changes.ts) inspect the
 * result AFTER the transaction has committed and turn a block into a 409 carrying
 * `decision.id` as `decision_id` (DESIGN §6/§10.4). This function only throws for genuinely
 * exceptional conditions (change not found, DB errors) — those DO roll back the transaction, as
 * they should.
 */
export async function transitionChange(
  tx: TenantTx,
  input: TransitionChangeInput,
  gateDeps: GateDeps
): Promise<TransitionResult> {
  const rows = await tx
    .select()
    .from(changes)
    .where(and(eq(changes.orgId, input.orgId), eq(changes.objectId, input.changeObjectId)))
    .for("update");
  const existing = rows[0];
  if (!existing) throw notFound(`change '${input.changeObjectId}' not found`);

  const fromState = existing.state as ChangeState;
  const toState = input.toState;
  const edge = findEdge(fromState, toState);
  const legal = isLegalTransition(fromState, toState);

  if (!legal) {
    const decision = await insertDecision(tx, {
      orgId: input.orgId,
      kind: "transition",
      subjectId: input.changeObjectId,
      verdict: "block",
      inputContext: {
        fromState,
        toState,
        actorId: input.actorObjectId,
        reason: input.reason ?? null,
        ...input.extraInputContext
      },
      reasonTree: {
        summary: `illegal transition: '${fromState}' -> '${toState}' has no edge in the state machine`
      }
    });
    await appendAuditEvent(tx, {
      orgId: input.orgId,
      actorId: input.actorObjectId,
      action: "change.transition.blocked",
      subjectId: input.changeObjectId,
      beforeHash: stateHash(fromState),
      afterHash: null,
      reason: input.reason ?? `illegal transition ${fromState}->${toState}`,
      decisionId: decision.id,
      requestId: input.requestId
    });
    return {
      verdict: "block",
      decision,
      blockedReason: `illegal transition: '${fromState}' -> '${toState}'`
    };
  }

  const gate = await evaluateLifecycleGate(
    tx,
    {
      orgId: input.orgId,
      fromState,
      toState,
      changeObjectId: input.changeObjectId,
      actorObjectId: input.actorObjectId,
      emergency: existing.emergency,
      isRollback: existing.rollbackOfObjectId !== null,
      overrideFreeze: input.overrideFreeze
    },
    gateDeps
  );
  const decision = await insertDecision(tx, {
    orgId: input.orgId,
    kind: "transition",
    subjectId: input.changeObjectId,
    verdict: gate.verdict,
    inputContext: {
      fromState,
      toState,
      trigger: edge?.trigger,
      actorId: input.actorObjectId,
      reason: input.reason ?? null,
      gate: gate.inputContext,
      ...input.extraInputContext
    },
    reasonTree:
      gate.verdict === "allow"
        ? { summary: `transition '${fromState}' -> '${toState}' allowed`, gate: gate.reasonTree }
        : {
            summary: `transition '${fromState}' -> '${toState}' blocked by gate`,
            gate: gate.reasonTree
          }
  });

  // DESIGN §10.3: a freeze override is ALWAYS a high-severity, mandatory-reason audit event —
  // written even though the transition itself allows, in the SAME transaction as everything else
  // this guarded function does, so an override can never happen without its own permanent record.
  // CRITICAL #2: EVERY overridden freeze gets its own event (a change under several simultaneous
  // freezes must override — and audit — each one individually).
  for (const override of gate.freezeOverrides ?? []) {
    await appendAuditEvent(tx, {
      orgId: input.orgId,
      actorId: input.actorObjectId,
      action: "freeze.override",
      subjectId: override.freezeId,
      beforeHash: null,
      afterHash: null,
      reason: override.reason,
      decisionId: decision.id,
      requestId: input.requestId
    });
  }

  if (gate.verdict === "block") {
    await appendAuditEvent(tx, {
      orgId: input.orgId,
      actorId: input.actorObjectId,
      action: "change.transition.blocked",
      subjectId: input.changeObjectId,
      beforeHash: stateHash(fromState),
      afterHash: null,
      reason: input.reason ?? "blocked by gate",
      decisionId: decision.id,
      requestId: input.requestId
    });
    return { verdict: "block", decision, blockedReason: "blocked by gate" };
  }

  const now = new Date();
  const [updated] = await tx
    .update(changes)
    .set({
      state: toState,
      stateEnteredAt: now,
      lastHeartbeatAt: now,
      watchdogFlaggedAt: null,
      updatedAt: now,
      ...(toState === "rolled_back" && input.reason ? { rollbackTriggerReason: input.reason } : {})
    })
    .where(eq(changes.objectId, existing.objectId))
    .returning();
  if (!updated) throw new Error("failed to update change state");

  await appendAuditEvent(tx, {
    orgId: input.orgId,
    actorId: input.actorObjectId,
    action: "change.transition",
    subjectId: input.changeObjectId,
    beforeHash: stateHash(fromState),
    afterHash: stateHash(toState),
    reason: input.reason ?? null,
    decisionId: decision.id,
    requestId: input.requestId
  });
  {
    // M6 (DESIGN §13): every state change rides the journal too — this is what lets a promotion
    // that just happened in a LOCAL change (possibly one instantiated from a Promotion Bundle)
    // sync its status back to a peer (§13 "each wave's gate is the target domain's own local gate
    // outcome, reported back via the journal").
    const payload = {
      objectId: input.changeObjectId,
      fromState,
      toState,
      trigger: edge?.trigger ?? null,
      reason: input.reason ?? null,
      importedFromDomain: existing.importedFromDomain
    };
    await appendJournalEntry(tx, {
      orgId: input.orgId,
      entryKind: "change_status",
      contentHash: changeStatusContentHash(payload),
      payload
    });
  }
  await eventBus.publish(tx, {
    orgId: input.orgId,
    type: "scp.change.transitioned",
    source: `/changes/${input.changeObjectId}`,
    subject: input.changeObjectId,
    data: { fromState, toState, trigger: edge?.trigger ?? null }
  });

  return { verdict: "allow", changeRow: updated, decision };
}
