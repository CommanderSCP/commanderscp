import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { ChangeRequirementSchema, SbomRefSchema, normalizeSbomDigest, type SbomRef } from "@scp/schemas";
import { webhookAdapterForSourceKind } from "./webhook-adapters.js";
import type { TenantTx } from "../db/tenant-tx.js";
import { changeSourceEvents } from "../db/schema.js";
import { badRequest, ProblemError } from "../errors.js";
import { appendAuditEvent } from "../audit/audit-repo.js";
import { insertDecision } from "./decisions-repo.js";
import { linkToCoordinatedChange, matchComponentForSource } from "./correlation.js";
import { proposeChange } from "./changes-repo.js";
import { deriveUrn } from "../graph/urn.js";
import { SYSTEM_ACTOR_ID } from "./system-actor.js";

const BATCH_LIMIT = 20;

/**
 * The "process" half of persist-then-process webhook ingress (DESIGN.md §8: "raw payload
 * persisted first (signature-verified), then processed as an event — replayable and auditable").
 * `routes/change-sources.ts`'s webhook route does ONLY the persist step (a plain INSERT); this
 * turns unprocessed `change_source_events` rows into Changes, run from the SAME reconciliation
 * tick as everything else in `coordination/reconcile.ts` (one more "observe → decide →
 * coordinate" step, reusing its per-org loop rather than a second scheduling mechanism) — which
 * is what makes ingress "replayable": a row that fails processing simply stays unprocessed and is
 * retried on the next tick, exactly like every other engine action in this milestone.
 *
 * Correlation hint extraction (M3 -> M7 -> M15.1b): the common shape `coordination/correlation.ts`'s
 * `CorrelationHint` models (`repo`, `path`, `correlationKey`) is still the baseline — a generic
 * source (a source-specific adapter, `scp change report`, or a direct test/curl caller) that sends
 * this flat shape directly keeps working unchanged. Provider-specific parsing is resolved through
 * the per-`sourceKind` webhook ADAPTER REGISTRY (`webhook-adapters.ts`, M15.1b): each provider's
 * `GitProviderAdapter.mapEvent` (the SAME function that plugin's own polling-fallback `observe()`
 * uses — DESIGN §12's "poll-vs-push equivalence") reads the real nested provider webhook JSON using
 * that provider's own event header persisted alongside the payload (`change_source_events.headers`)
 * — `X-GitHub-Event` for github (`repository.full_name`/`head_commit.id`/…), `X-Gitea-Event` for
 * gitea. A provider-specific hint field, when present, wins; any field it doesn't set (or an
 * unrecognized/missing event name, or a source kind with no adapter) falls back to the flat generic
 * shape, so a hand-crafted test payload with a bare `{repo, correlationKey}` still correlates
 * exactly as before. ArgoCD/Terraform have no provider-specific webhook parser (ArgoCD is poll-only;
 * Terraform Mode 1's inbound path is `scp change report`'s own flat shape) — they resolve no adapter
 * and use the generic shape, tracked as follow-up if TFC/Atlantis-native payloads need first-class
 * parsing.
 */
export interface ExtractedHint {
  repo?: string;
  path?: string;
  correlationKey?: string;
  /** OCI/image artifact digest (`sha256:…`) for a registry/package push (harbor's `PUSH_ARTIFACT`,
   *  gitea's `package`) — threaded into the proposed Change's `sourceRef.artifact_digest`, the
   *  connective tissue the M17.1 scan gate binds to (ADR-0013). Additive (M15.3c): forwarded here
   *  for the first time; git-provider correlation is unchanged (git events that set no digest leave
   *  this undefined, and the digest was — and still is — also folded into `correlationKey` for
   *  grouping). */
  artifactDigest?: string;
  /** M17.2 — a REFERENCE to the build-time SBOM the EXECUTOR emitted and cosign-signed at origin
   *  (ADR-0015 §5), lifted to the proposed Change's `sourceRef.sbom`. SCP never generates, signs, or
   *  stores an SBOM document — only this reference. Carried today by the TYPED first-party report
   *  ingress (`ChangeReportRequestSchema.sbom`); provider webhook adapters set no SBOM (a registry
   *  push payload carries none), so this stays undefined for them. */
  sbom?: SbomRef;
  /** M12 P4B coupled pipelines — `ChangeReportRequestSchema.provides`, read from the flat
   *  first-party report body and threaded into `proposeChange` exactly as `POST /changes` threads
   *  its own typed field. Provider webhook payloads carry no coupling key (coupled-pipelines.md
   *  §6#1 — a raw push webhook CANNOT declare one; the CI report step is THE channel). */
  provides?: string[];
  /** M12 P4B — `ChangeReportRequestSchema.requires`. `at` is an id-or-URN here, resolved by
   *  `proposeChange` (an unresolvable one is refused — see `processChangeSourceEvents`). */
  requires?: { key: string; at: string }[];
  /** M12 P4B fail-closed: set (verbatim) when the body carried a `requires` that does NOT parse as
   *  `{key, at}[]`. NOT dropped-and-proceed (that would execute a release whose author declared a
   *  prerequisite — the exact fail-open P4B closes) and NOT quarantined-but-proposed like `sbom`
   *  (an SBOM reference is metadata; `requires` is an execution precondition): the processor
   *  REFUSES the event, recording a Decision + audit. The typed `/report` route's Zod validation
   *  makes this unreachable for SDK/CLI reporters — it exists for hand-crafted raw-`/webhook`
   *  payloads. */
  requiresInvalid?: unknown;
}

/**
 * The FLAT first-party shape (`scp change-source report`'s typed body, or a hand-crafted
 * `{repo, correlationKey}` test/curl payload). Reads the fields a first-party reporter sends at the
 * TOP LEVEL of its body.
 *
 * M17.2 fixed a latent gap here: this used to read ONLY `repo`/`path`/`correlationKey`, so the typed
 * report route's `artifactDigest` was NEVER lifted to the canonical `sourceRef.artifact_digest` — it
 * survived purely as a raw camelCase key that `federation/promotion-repo.ts` and
 * `governance/gate-orchestrator.ts` happened to also accept as a fallback. Both of those still read
 * BOTH key shapes (legacy rows written before this fix must keep resolving), but a NEWLY reported
 * change now gets the same canonicalization the harbor/git adapters get, so there is exactly one
 * documented place a digest lives on new data.
 */
function genericHint(payload: unknown): ExtractedHint {
  if (!payload || typeof payload !== "object") return {};
  const p = payload as Record<string, unknown>;
  const sbom = SbomRefSchema.safeParse(p.sbom);
  // M12 P4B — the coupling declaration, validated against the SAME shapes `POST /changes` uses.
  // `provides`: a malformed value is dropped like `sbom` (fail-CLOSED for the coupling: a dropped
  // `provides` releases nobody; waiters keep waiting and their wait-status names the gap).
  // `requires`: a malformed value is the OPPOSITE case — dropping it would fail OPEN (the release
  // executes as if uncoupled), so it is carried under `requiresInvalid` and the processor refuses
  // the event with a recorded Decision.
  const provides = z.array(z.string().min(1)).safeParse(p.provides);
  const requires = z.array(ChangeRequirementSchema).safeParse(p.requires);
  return {
    repo: typeof p.repo === "string" ? p.repo : undefined,
    path: typeof p.path === "string" ? p.path : undefined,
    correlationKey: typeof p.correlationKey === "string" ? p.correlationKey : undefined,
    artifactDigest:
      typeof p.artifactDigest === "string" && p.artifactDigest.length > 0 ? p.artifactDigest : undefined,
    // Best-effort: a malformed `sbom` on an otherwise-valid delivery is DROPPED, never a throw —
    // an unparseable supply-chain reference must not wedge ingress for the whole tick (the raw
    // payload is still preserved verbatim in `sourceRef`, so nothing is lost for forensics).
    sbom: sbom.success ? sbom.data : undefined,
    provides: provides.success && provides.data.length > 0 ? provides.data : undefined,
    ...(p.requires === undefined || p.requires === null
      ? {}
      : requires.success
        ? requires.data.length > 0
          ? { requires: requires.data }
          : {}
        : { requiresInvalid: p.requires })
  };
}

/** Exported for unit testing — the pure hint-extraction half of ingress (see `canonicalizeSourceRef`). */
export function extractHint(sourceKind: string, headers: unknown, payload: unknown): ExtractedHint {
  const generic = genericHint(payload);
  // Provider-specific parsing is resolved through the per-sourceKind webhook ADAPTER REGISTRY
  // (`webhook-adapters.ts`, M15.1b) — github reads its nested payload via `x-github-event`, gitea
  // via `x-gitea-event`, each using its own `GitProviderAdapter.mapEvent` (the SAME mapper that
  // plugin's `observe()` polling fallback uses — DESIGN §12 "poll-vs-push equivalence"). A source
  // kind with no adapter (a generic/first-party reporter) keeps the flat generic shape unchanged.
  const adapter = webhookAdapterForSourceKind(sourceKind);
  if (!adapter) return generic;

  // Resolve the event NAME. HEADER-DRIVEN for adapters that name their event in an HTTP header
  // (github/gitea/gitlab — behavior UNCHANGED: a non-string header still yields the generic shape).
  // BODY-DERIVED for an adapter that declares no `eventHeaderName` (harbor, M15.3c — its event type
  // is in `payload.type`, not a header); without this the header-only path would read `undefined`
  // and silently drop every harbor event before ever calling `mapEvent`.
  let eventName: string | undefined;
  if (adapter.eventHeaderName) {
    const headerMap = (headers ?? {}) as Record<string, unknown>;
    const headerValue = headerMap[adapter.eventHeaderName];
    if (typeof headerValue !== "string") return generic;
    eventName = headerValue;
  } else {
    const p = (payload ?? {}) as Record<string, unknown>;
    if (typeof p.type !== "string") return generic;
    eventName = p.type;
  }

  const providerHint = adapter.mapEvent(eventName, payload);
  if (!providerHint) return generic;
  return {
    repo: providerHint.repo ?? generic.repo,
    path: providerHint.path ?? generic.path,
    correlationKey: providerHint.correlationKey ?? generic.correlationKey,
    // Additive forwarding (M15.3c): git-provider hints that don't set a digest leave this undefined,
    // so nothing about their behavior changes; harbor/gitea package pushes carry it through to
    // `sourceRef.artifact_digest` below. Falls back to the flat generic field (M17.2) so a
    // first-party body that ALSO resolves an adapter does not lose its reported digest.
    artifactDigest: providerHint.artifactDigest ?? generic.artifactDigest,
    // No provider webhook payload carries an SBOM reference — it arrives only on the typed
    // first-party report body, which the generic shape reads.
    sbom: generic.sbom,
    // M12 P4B: no provider webhook payload carries a coupling declaration either (§6#1) — like
    // `sbom`, these ride the flat first-party shape. Carried through EXPLICITLY because this
    // branch reconstructs field-by-field rather than spreading `generic`: omitting them here is
    // the one line that would silently drop a coupling from a body that also resolves an adapter.
    provides: generic.provides,
    requires: generic.requires,
    requiresInvalid: generic.requiresInvalid
  };
}

/**
 * Build the Change's canonical `sourceRef` from the raw delivery payload plus whatever the hint
 * extracted. The raw payload is kept VERBATIM (DESIGN §8 — replayable/auditable ingress); canonical
 * keys are ADDED alongside it:
 *   - `artifact_digest` — the artifact this release promotes, the connective tissue the M17.1 scan
 *     gate binds to (`governance/gate-orchestrator.ts`, ADR-0013).
 *   - `sbom` — a REFERENCE to the build-time SBOM (M17.2, ADR-0015 §5). Reference ONLY: `{format,
 *     digest, location, signatureRef, …}`. SCP never generates, signs, or stores the document.
 *
 * Exported for unit testing: this is the one place canonical `source_ref` keys are minted, so it is
 * the one place worth pinning with a test.
 */
export function canonicalizeSourceRef(
  rawPayload: unknown,
  hint: ExtractedHint
): Record<string, unknown> {
  const raw = ((rawPayload as Record<string, unknown>) ?? {}) as Record<string, unknown>;
  const sourceRef: Record<string, unknown> = { ...raw };
  if (hint.artifactDigest) sourceRef.artifact_digest = hint.artifactDigest;
  if (hint.sbom) {
    // Normalize the SBOM DOCUMENT's digest to `sha256:<lowercase-hex>` so what is persisted always
    // compares byte-for-byte (same normalization `scan-result-control` applies to a Trivy digest).
    sourceRef.sbom = { ...hint.sbom, digest: normalizeSbomDigest(hint.sbom.digest) ?? hint.sbom.digest };
  } else if ("sbom" in raw) {
    // The body carried an `sbom` that did NOT validate as a reference. The CONTRACT M17.3 reads is
    // "`sourceRef.sbom`, when present, IS a valid `SbomRef`" — so an invalid one must not sit under
    // that key masquerading as a real reference. Quarantine it under `sbom_invalid` instead: nothing
    // is lost for forensics (DESIGN §8 keeps the delivery auditable), but no downstream reader can
    // mistake garbage for an attested supply-chain reference.
    delete sourceRef.sbom;
    sourceRef.sbom_invalid = raw.sbom;
  }
  return sourceRef;
}

/**
 * MULTI-REPLICA SINGLE-FLIGHT (M8 hardening — BUILD_AND_TEST.md §8 M8 item 6, found during the
 * same concurrency audit as the trigger-claim and evaluated->coordinated fixes): without `FOR
 * UPDATE SKIP LOCKED` here, two concurrent ticks (two worker replicas' overlapping reconcile
 * loops) each run this ENTIRE function in their own transaction, and BOTH could `SELECT` the SAME
 * unprocessed `change_source_events` row before either commits (plain READ COMMITTED — nothing
 * about a bare `SELECT ... WHERE processed_at IS NULL` prevents a second transaction from reading
 * the identical "still unprocessed" snapshot). Each would then call `proposeChange` for that SAME
 * webhook delivery — creating TWO SEPARATE Change objects for one real-world event, which could
 * go on to independently gate/approve/promote/execute as if they were unrelated changes. `FOR
 * UPDATE SKIP LOCKED` is the standard job-queue claim pattern: a row already locked by another
 * in-flight transaction is silently EXCLUDED from this transaction's result set (not waited on),
 * so two concurrent ticks always get disjoint row sets — provably no double-processing, and no
 * added latency (never blocks).
 */
export async function processChangeSourceEvents(tx: TenantTx, orgId: string): Promise<void> {
  const rows = await tx
    .select()
    .from(changeSourceEvents)
    .where(and(eq(changeSourceEvents.orgId, orgId), isNull(changeSourceEvents.processedAt)))
    .orderBy(asc(changeSourceEvents.createdAt))
    .limit(BATCH_LIMIT)
    .for("update", { skipLocked: true });

  for (const row of rows) {
    const hint = extractHint(row.sourceKind, row.headers, row.payload);
    const match = await matchComponentForSource(tx, orgId, {
      sourceKind: row.sourceKind,
      repo: hint.repo,
      path: hint.path
    });

    if (!match) {
      // No `source_mappings` row matched — nothing to correlate against, so there's no target to
      // propose a Change for. Marked processed anyway: persist-then-process's "replayable"
      // promise covers retrying TRANSIENT failures, not waiting forever for a mapping that may
      // never be added — an operator who adds the missing mapping later is covered by the NEXT
      // webhook delivery, not a replay of this one.
      await tx
        .update(changeSourceEvents)
        .set({ processedAt: new Date() })
        .where(eq(changeSourceEvents.id, row.id));
      continue;
    }

    // Each unprocessed `change_source_events` row is one distinct real-world event — redeliveries
    // of the SAME provider delivery are already collapsed to one row at ingest by the
    // `(org_id, source_kind, dedupe_key)` unique index (schema.ts), so every row that reaches here
    // is a genuinely separate release. Each therefore becomes its OWN Change (`correlationKey` then
    // GROUPS related changes via `linkToCoordinatedChange` — it does NOT dedupe them: for a GitHub
    // push it is the branch ref, identical for every commit on that branch).
    //
    // The human-readable NAME stays repo-scoped and thus SHARED across a repo's events, but the URN
    // must be unique per event or `createObject`'s `(org_id, urn)` unique constraint rejects the
    // second same-repo event of a batch as a `Conflict` — which rolls back the whole tick and wedges
    // the queue forever (a monorepo backlog guarantees several same-repo events per tick). Suffixing
    // the derived URN with the row id (a per-event UUIDv7) makes it collision-free while keeping the
    // name informative. Concurrent double-processing of the SAME row is separately prevented by the
    // `FOR UPDATE SKIP LOCKED` claim above, so two ticks never both mint a change for one row.
    const name = `${row.sourceKind}${hint.repo ? `: ${hint.repo}` : ""}`;
    // `sourceRef` is the raw delivery payload kept verbatim (DESIGN §8) plus canonical keys lifted
    // from the hint — `artifact_digest` (M15.3c/M17.1) and `sbom` (M17.2). See
    // `canonicalizeSourceRef`. Additive: a delivery with neither is passed through byte-identical.
    const sourceRef = canonicalizeSourceRef(row.payload, hint);
    try {
      // SAVEPOINT (nested transaction) around the propose: this ingress is persist-then-PROCESS, so
      // a caller-shaped defect in the payload (M12 P4B: an unresolvable `requires[].at`, a malformed
      // `requires`) surfaces HERE, not as a 4xx on the report/webhook request. Without the
      // savepoint, that defect would poison the whole tick's transaction and the row would retry —
      // and refail — forever, wedging every event queued behind it. With it, the failed propose
      // rolls back cleanly and the refusal is recorded in the OUTER transaction below.
      await tx.transaction(async (inner) => {
        if (hint.requiresInvalid !== undefined) {
          throw badRequest(
            `report carried a malformed \`requires\` — each entry must be {key, at} (got ${JSON.stringify(hint.requiresInvalid)})`
          );
        }
        const { change } = await proposeChange(inner, {
          orgId,
          actorObjectId: SYSTEM_ACTOR_ID,
          requestId: `webhook-${row.id}`,
          name,
          urn: deriveUrn(orgId, "change", name, row.id),
          sourceKind: row.sourceKind,
          sourceRef,
          correlationKey: hint.correlationKey,
          targets: [match.componentObjectId],
          // WHICH pipeline this release drives — the routing Type (ADR-0007), straight from the mapping
          // that matched it (M12 P4A). One release = one source = one pipeline, so the Type belongs to the
          // CHANGE rather than to each target — a release needing both would be two releases.
          type: match.type,
          // M12 P4B: the coupling declaration from the typed report body (`scp change-source
          // report --provides/--requires`), threaded IDENTICALLY to `POST /changes`' typed fields —
          // same `at` resolution inside `proposeChange`, same storage, same routing-guard behaviour.
          provides: hint.provides,
          requires: hint.requires
        });

        if (hint.correlationKey) {
          await linkToCoordinatedChange(inner, {
            orgId,
            changeObjectId: change.id,
            correlationKey: hint.correlationKey,
            actorObjectId: SYSTEM_ACTOR_ID,
            requestId: `webhook-${row.id}`
          });
        }

        await inner
          .update(changeSourceEvents)
          .set({ processedAt: new Date(), resultingChangeObjectId: change.id })
          .where(eq(changeSourceEvents.id, row.id));
      });
    } catch (err) {
      // The REFUSAL surface for a caller-shaped defect (a 4xx `ProblemError` thrown by our own
      // validation — e.g. M12 P4B's unresolvable `requires[].at`, which `POST /changes` turns into
      // a 404 but this async path cannot). The event is marked processed WITH NO resulting change,
      // and the refusal is recorded as a Decision + audit event (charter principle 6 — never a
      // silent drop, and never the infinite retry a permanent defect would otherwise cause).
      // Anything else (DB failure, transient error) still rethrows: the row stays unprocessed and
      // persist-then-process's replayability retries it next tick, exactly as before.
      if (!(err instanceof ProblemError) || err.status >= 500) throw err;
      const reason = err.detail ?? err.message;
      const decision = await insertDecision(tx, {
        orgId,
        kind: "ingress",
        subjectId: row.id,
        verdict: "block",
        inputContext: {
          changeSourceEventId: row.id,
          sourceKind: row.sourceKind,
          repo: hint.repo ?? null,
          path: hint.path ?? null,
          provides: hint.provides ?? null,
          requires: hint.requires ?? hint.requiresInvalid ?? null,
          error: reason
        },
        reasonTree: {
          summary: `change-source event refused: ${reason}`
        }
      });
      await appendAuditEvent(tx, {
        orgId,
        actorId: SYSTEM_ACTOR_ID,
        action: "change_source.event.refused",
        subjectId: row.id,
        reason,
        decisionId: decision.id,
        requestId: `webhook-${row.id}`
      });
      await tx
        .update(changeSourceEvents)
        .set({ processedAt: new Date() })
        .where(eq(changeSourceEvents.id, row.id));
    }
  }
}
