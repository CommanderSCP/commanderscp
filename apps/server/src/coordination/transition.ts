import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { ChangeState, Decision } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { changes, objects } from "../db/schema.js";
import { notFound } from "../errors.js";
import { appendAuditEvent } from "../audit/audit-repo.js";
import { eventBus } from "../events/event-bus.js";
import { findEdge, isLegalTransition } from "./transitions.js";
import { evaluateLifecycleGate, type GateDeps } from "./gates.js";
import { insertDecision } from "./decisions-repo.js";
import { appendJournalEntry } from "../federation/journal-repo.js";
import { changeStatusContentHash } from "./changes-repo.js";
import { ensureFederationSelf } from "../federation/self-repo.js";
import { SYSTEM_ACTOR_ID } from "./system-actor.js";

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

export interface LocalAuthorityCheckInput {
  orgId: string;
  changeObjectId: string;
  /** The change's underlying graph object's `originDomainId` (NOT `importedFromDomain` — a
   *  promoted change's own object is always LOCALLY originated; provenance travels separately.
   *  See the module doc below and ADR references in `tracked-security-followups`. */
  originDomainId: string;
  actorObjectId: string;
  requestId: string;
  reason?: string | null;
}

export type LocalAuthorityResult =
  { ok: true } | { ok: false; decision: Decision; blockedReason: string };

/** The single-writer authority check for transition verbs. See docs/coordination.md §1006. */
export async function enforceLocalChangeAuthority(
  tx: TenantTx,
  input: LocalAuthorityCheckInput
): Promise<LocalAuthorityResult> {
  const self = await ensureFederationSelf(tx, input.orgId);
  if (input.originDomainId === self.domainId) return { ok: true };

  const decision = await insertDecision(tx, {
    orgId: input.orgId,
    kind: "transition",
    subjectId: input.changeObjectId,
    verdict: "block",
    inputContext: {
      originDomainId: input.originDomainId,
      selfDomainId: self.domainId,
      actorId: input.actorObjectId,
      reason: input.reason ?? null
    },
    reasonTree: {
      summary:
        `refused: change '${input.changeObjectId}' is authoritatively owned by domain ` +
        `'${input.originDomainId}', not this domain ('${self.domainId}') — single-writer ` +
        `authority (only the owning domain may transition or roll back this change)`
    }
  });
  await appendAuditEvent(tx, {
    orgId: input.orgId,
    actorId: input.actorObjectId,
    action: "change.transition.blocked",
    subjectId: input.changeObjectId,
    reason: input.reason ?? "single-writer authority violation",
    decisionId: decision.id,
    requestId: input.requestId
  });
  return {
    ok: false,
    decision,
    blockedReason:
      "change is authoritatively owned by another federation domain — only the owning domain may transition or roll it back"
  };
}

/** THE single guarded transition function (DESIGN.md §9.1). See docs/coordination.md §1007. */
export async function transitionChange(
  tx: TenantTx,
  input: TransitionChangeInput,
  gateDeps: GateDeps
): Promise<TransitionResult> {
  const rows = await tx
    // M20.3 (ADR-0031 §5) — `domainLocal` joins `originDomainId` here rather than becoming a second
    // query: both are properties of the change's graph OBJECT, both are needed on every transition,
    // and the join already exists.
    .select({
      change: changes,
      originDomainId: objects.originDomainId,
      domainLocal: objects.domainLocal
    })
    .from(changes)
    .innerJoin(objects, eq(changes.objectId, objects.id))
    .where(and(eq(changes.orgId, input.orgId), eq(changes.objectId, input.changeObjectId)))
    .for("update", { of: changes });
  const row = rows[0];
  if (!row) throw notFound(`change '${input.changeObjectId}' not found`);
  const existing = row.change;

  const authority = await enforceLocalChangeAuthority(tx, {
    orgId: input.orgId,
    changeObjectId: input.changeObjectId,
    originDomainId: row.originDomainId,
    actorObjectId: input.actorObjectId,
    requestId: input.requestId,
    reason: input.reason
  });
  if (!authority.ok) {
    return {
      verdict: "block",
      decision: authority.decision,
      blockedReason: authority.blockedReason
    };
  }

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

  // A freeze override is always a high-severity audit event. See docs/coordination.md §1008.
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
      ...(toState === "rolled_back" && input.reason ? { rollbackTriggerReason: input.reason } : {}),
      // 0053: WHO cancelled, structurally. See docs/coordination.md §1009.
      ...(toState === "cancelled"
        ? { cancellationKind: input.actorObjectId === SYSTEM_ACTOR_ID ? "system" : "user" }
        : {})
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
    requestId: input.requestId,
    // M20.3 (ADR-0031 §5) — the audit segment names the change object id; withheld for a
    // domain-local change, while the local audit row is written unchanged.
    subjectDomainLocal: row.domainLocal
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
    // M20.3 (ADR-0031 §5) — and NOT for a domain-local change. See docs/coordination.md §1010.
    if (!row.domainLocal) {
      await appendJournalEntry(tx, {
        orgId: input.orgId,
        entryKind: "change_status",
        contentHash: changeStatusContentHash(payload),
        payload
      });
    }
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
