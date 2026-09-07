import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  ChangeRequirementSchema,
  SbomRefSchema,
  StageDependencySchema,
  TestBundleRefSchema,
  normalizeSbomDigest,
  type ArtifactClass,
  type SbomRef,
  type StageDependency,
  type TestBundleRef
} from "@scp/schemas";
import { webhookAdapterForSourceKind } from "./webhook-adapters.js";
import { listConfigSourceRegistrations } from "../config-source/config-sources-repo.js";
import { resolveConfigSourceForSync } from "../config-source/registration-match.js";
import { enqueueConfigSourceSync } from "../config-source/sync-queue-repo.js";
import type { TenantTx } from "../db/tenant-tx.js";
import { changeSourceEvents } from "../db/schema.js";
import { badRequest, ProblemError } from "../errors.js";
import { appendAuditEvent } from "../audit/audit-repo.js";
import { insertDecision } from "./decisions-repo.js";
import {
  BUMP_OBSERVED_EVENT,
  linkToCoordinatedChange,
  matchAuthoredBumpChange,
  matchComponentForSource
} from "./correlation.js";
import { writeOutboxEvent } from "../events/outbox-repo.js";
import { recordBumpHeadCommit } from "../dependencies/bump-authorship-repo.js";
import { proposeChange } from "./changes-repo.js";
import {
  artifactClassMismatchReason,
  parseReportedArtifactClass,
  verifyArtifactClass
} from "./artifact-class-verification.js";
import { deriveUrn } from "../graph/urn.js";
import { SYSTEM_ACTOR_ID } from "./system-actor.js";
import { withoutServerOwnedSourceRefKeys } from "../federation/boundary-bundle-ref.js";

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
  /** Every path the event touched. See `CorrelationHint.paths` (`correlation.ts`) for why a
   *  single `path` cannot represent a commit, and what that costs on a monorepo. */
  paths?: string[];
  correlationKey?: string;
  /** The fully-qualified git ref (`refs/heads/dev`) this event is on — the routing input a
   *  `refPattern` source mapping matches against (ADR-0030 §1). Undefined for any source that has
   *  no ref (a registry/package push), which simply never matches a ref-scoped mapping. */
  ref?: string;
  /** The source branch of a pull request, fully qualified. See docs/coordination.md §1078. */
  headRef?: string;
  /** The COMMIT this event is about. See docs/coordination.md §1079. */
  commitSha?: string;
  /** OCI/image artifact digest. See docs/coordination.md §1080. */
  artifactDigest?: string;
  /** A reference to the SBOM the executor signed at origin. See docs/coordination.md §1081. */
  sbom?: SbomRef;
  /** A reference to the test bundle the build captured. See docs/coordination.md §1082. */
  testBundle?: TestBundleRef;
  /** The artifact class the build reported producing. See docs/coordination.md §1083. */
  artifactClass?: ArtifactClass;
  /** M12 P4B coupled pipelines — `ChangeReportRequestSchema.provides`, read from the flat
   *  first-party report body and threaded into `proposeChange` exactly as `POST /changes` threads
   *  its own typed field. Provider webhook payloads carry no coupling key (coupled-pipelines.md
   *  §6#1 — a raw push webhook CANNOT declare one; the CI report step is THE channel). */
  provides?: string[];
  /** M12 P4B — `ChangeReportRequestSchema.requires`. `at` is an id-or-URN here, resolved by
   *  `proposeChange` (an unresolvable one is refused — see `processChangeSourceEvents`). */
  requires?: { key: string; at: string }[];
  /** M12 P4B fail-closed. See docs/coordination.md §1084. */
  requiresInvalid?: unknown;
  /** ADR-0028 — `ChangeReportRequestSchema.stageDependencies`. `dependsOn` and each `atTargets`
   *  entry are ids-or-URNs here, resolved by `proposeChange` (an unresolvable one is refused — see
   *  `processChangeSourceEvents`). Provider webhook payloads carry none: like a coupling key, a raw
   *  push webhook cannot declare a dependency, so the CI report step is THE channel. */
  stageDependencies?: StageDependency[];
  /** Fail-closed, set verbatim when the body cannot be read. See docs/coordination.md §1085. */
  stageDependenciesInvalid?: unknown;
}

/** The FLAT first-party shape. See docs/coordination.md §1086. */
function genericHint(payload: unknown): ExtractedHint {
  if (!payload || typeof payload !== "object") return {};
  const p = payload as Record<string, unknown>;
  const sbom = SbomRefSchema.safeParse(p.sbom);
  // D23 — parsed with the SAME best-effort posture as `sbom`: a malformed reference is dropped here
  // and quarantined by `canonicalizeSourceRef`, never thrown. It is metadata about which tests were
  // captured, not an execution precondition, so it sits with `sbom` and not with `requires`.
  const testBundle = TestBundleRefSchema.safeParse(p.testBundle);
  // D13 — best-effort like `sbom`/`testBundle`. See docs/coordination.md §1087.
  const artifactClass = parseReportedArtifactClass(p.artifactClass);
  // The coupling declaration, validated against the same shapes. See docs/coordination.md §1088.
  const provides = z.array(z.string().min(1)).safeParse(p.provides);
  const requires = z.array(ChangeRequirementSchema).safeParse(p.requires);
  // ADR-0028: `stageDependencies` sits with `requires`, not with `provides`. Dropping a malformed
  // one fails OPEN — the release would deploy with no hold at all, ahead of every component its
  // author named — so it is carried under `stageDependenciesInvalid` and the processor refuses.
  const stageDependencies = z.array(StageDependencySchema).safeParse(p.stageDependencies);
  return {
    repo: typeof p.repo === "string" ? p.repo : undefined,
    path: typeof p.path === "string" ? p.path : undefined,
    // Read the SAME way an observed payload writes it (`observe.ts`) and a first-party reporter may
    // send it. Non-string members are dropped rather than rejecting the whole event: a partly
    // malformed path list should narrow correlation, never wedge ingress.
    paths: Array.isArray(p.paths)
      ? p.paths.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
      : undefined,
    // The flat shape carries a ref, so it can drive ref routing. See docs/coordination.md §1089.
    ref: typeof p.ref === "string" && p.ref.length > 0 ? p.ref : undefined,
    // The same reader that records the commit on a bump. See docs/coordination.md §1090.
    commitSha:
      commitShaFromPayload(payload) ??
      (typeof p.commit === "string" && p.commit.length > 0 ? p.commit : undefined),
    correlationKey: typeof p.correlationKey === "string" ? p.correlationKey : undefined,
    artifactDigest:
      typeof p.artifactDigest === "string" && p.artifactDigest.length > 0
        ? p.artifactDigest
        : undefined,
    // Best-effort: a malformed `sbom` on an otherwise-valid delivery is DROPPED, never a throw —
    // an unparseable supply-chain reference must not wedge ingress for the whole tick (the raw
    // payload is still preserved verbatim in `sourceRef`, so nothing is lost for forensics).
    sbom: sbom.success ? sbom.data : undefined,
    testBundle: testBundle.success ? testBundle.data : undefined,
    artifactClass,
    provides: provides.success && provides.data.length > 0 ? provides.data : undefined,
    ...(p.requires === undefined || p.requires === null
      ? {}
      : requires.success
        ? requires.data.length > 0
          ? { requires: requires.data }
          : {}
        : { requiresInvalid: p.requires }),
    ...(p.stageDependencies === undefined || p.stageDependencies === null
      ? {}
      : stageDependencies.success
        ? stageDependencies.data.length > 0
          ? { stageDependencies: stageDependencies.data }
          : {}
        : { stageDependenciesInvalid: p.stageDependencies })
  };
}

/** Exported for unit testing — the pure hint-extraction half of ingress (see `canonicalizeSourceRef`). */
export function extractHint(sourceKind: string, headers: unknown, payload: unknown): ExtractedHint {
  const generic = genericHint(payload);
  // Provider parsing is resolved through the adapter registry. See docs/coordination.md §1091.
  const adapter = webhookAdapterForSourceKind(sourceKind);
  if (!adapter) return generic;

  // Resolve the event NAME. See docs/coordination.md §1092.
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
    // Same precedence as every other field: the adapter's reading wins, the flat generic shape is
    // the fallback. An empty array from an adapter is treated as "no paths determined" rather than
    // "changed nothing" — the two are indistinguishable here, and the latter cannot happen.
    paths: providerHint.paths && providerHint.paths.length > 0 ? providerHint.paths : generic.paths,
    // Same adapter-wins precedence as every field above it. An adapter that maps a non-git event
    // (a package push) sets no ref, so this correctly falls through to the generic shape and then
    // to undefined — and an event with no ref matches no ref-scoped mapping, fail-closed.
    ref: providerHint.ref ?? generic.ref,
    // Adapter-only: no flat-payload shape carries a pull request's head branch, and nothing in the
    // generic hint should start inventing one.
    headRef: providerHint.headRef,
    // Same adapter-wins precedence as every field above. See docs/coordination.md §1093.
    commitSha: providerHint.commitSha ?? generic.commitSha,
    correlationKey: providerHint.correlationKey ?? generic.correlationKey,
    // Additive forwarding (M15.3c): git-provider hints that don't set a digest leave this undefined,
    // so nothing about their behavior changes; harbor/gitea package pushes carry it through to
    // `sourceRef.artifact_digest` below. Falls back to the flat generic field (M17.2) so a
    // first-party body that ALSO resolves an adapter does not lose its reported digest.
    artifactDigest: providerHint.artifactDigest ?? generic.artifactDigest,
    // No provider webhook payload carries an SBOM reference — it arrives only on the typed
    // first-party report body, which the generic shape reads.
    sbom: generic.sbom,
    // D23: same story, same one line. See docs/coordination.md §1094.
    testBundle: generic.testBundle,
    artifactClass: generic.artifactClass,
    // M12 P4B: no provider webhook payload carries a coupling declaration either (§6#1) — like
    // `sbom`, these ride the flat first-party shape. Carried through EXPLICITLY because this
    // branch reconstructs field-by-field rather than spreading `generic`: omitting them here is
    // the one line that would silently drop a coupling from a body that also resolves an adapter.
    provides: generic.provides,
    requires: generic.requires,
    requiresInvalid: generic.requiresInvalid,
    // ADR-0028: same story, same one line. A CI report body that ALSO resolves an adapter (a
    // first-party `scp change-source report` for sourceKind `github`, say) would lose its declared
    // stage dependencies entirely if these were not re-forwarded here, and the loss would be
    // silent — the release would run uncoupled with no error anywhere.
    stageDependencies: generic.stageDependencies,
    stageDependenciesInvalid: generic.stageDependenciesInvalid
  };
}

/** Builds the canonical source ref from the raw payload. See docs/coordination.md §1095. */
export function canonicalizeSourceRef(
  rawPayload: unknown,
  hint: ExtractedHint
): Record<string, unknown> {
  const raw = ((rawPayload as Record<string, unknown>) ?? {}) as Record<string, unknown>;
  // The SERVER-OWNED stamps. See docs/coordination.md §1096.
  const sourceRef: Record<string, unknown> = withoutServerOwnedSourceRefKeys({ ...raw });
  // The two keys naming where and which point, lifted here. See docs/coordination.md §1097.
  if (hint.repo) sourceRef.repo = hint.repo;
  if (hint.ref) sourceRef.ref = hint.ref;
  if (hint.commitSha) sourceRef.commit = hint.commitSha;
  if (hint.artifactDigest) sourceRef.artifact_digest = hint.artifactDigest;
  if (hint.sbom) {
    // Normalize the SBOM DOCUMENT's digest to `sha256:<lowercase-hex>` so what is persisted always
    // compares byte-for-byte (same normalization `scan-result-control` applies to a Trivy digest).
    sourceRef.sbom = {
      ...hint.sbom,
      digest: normalizeSbomDigest(hint.sbom.digest) ?? hint.sbom.digest
    };
  } else if ("sbom" in raw) {
    // The body carried an SBOM that did not validate. See docs/coordination.md §1098.
    delete sourceRef.sbom;
    sourceRef.sbom_invalid = raw.sbom;
  }
  if (hint.testBundle) {
    // Stored VERBATIM — `TestBundleRefSchema.digest` is already canonical `sha256:<64-lowercase-hex>`
    // by construction (it is a regex, not a coercion), so there is nothing to normalize and nothing
    // to guess. That is what makes this digest comparable byte-for-byte against the artifact digests
    // in the promotion manifest and against a `CapturedWorkflowRef.bundle.digest`.
    sourceRef.testBundle = { ...hint.testBundle };
  } else if ("testBundle" in raw) {
    // The same quarantine, with sharper stakes. See docs/coordination.md §1099.
    delete sourceRef.testBundle;
    sourceRef.testBundle_invalid = raw.testBundle;
  }
  if (hint.artifactClass) {
    // The observed side of the artifact-class verification. See docs/coordination.md §1100.
    sourceRef.artifact_class = hint.artifactClass;
  } else if ("artifactClass" in raw) {
    // The SAME quarantine `sbom`/`testBundle` get. The downstream contract is
    // "`sourceRef.artifact_class`, when present, IS a valid `ArtifactClass`" — an unrecognised value
    // left under that key would later read as a real observation and could flip a verdict.
    delete sourceRef.artifact_class;
    sourceRef.artifact_class_invalid = raw.artifactClass;
  }
  return sourceRef;
}

/** The commit a push payload is at, or `undefined`. See docs/coordination.md §1101. */
export function commitShaFromPayload(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== "object") return undefined;
  const p = payload as Record<string, unknown>;
  for (const key of ["commit_sha", "commitSha", "sha", "after", "checkout_sha"]) {
    const value = p[key];
    // A push that DELETES a branch carries an all-zero `after`, which is not a commit. Treated as
    // absent rather than recorded, or the change would claim a head nothing can be checked against.
    if (typeof value === "string" && value !== "" && !/^0+$/.test(value)) return value;
  }
  const head = p.head_commit as { id?: unknown } | null | undefined;
  if (head && typeof head.id === "string" && head.id !== "") return head.id;
  return undefined;
}

/** Multi-replica single-flight on the processor. See docs/coordination.md §1102. */
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

    // M21.5 THE PROVENANCE LOOP. See docs/coordination.md §1103.
    const authoredChangeId = await matchAuthoredBumpChange(tx, orgId, {
      repo: hint.repo,
      // A pull request's source branch counts as its ref. See docs/coordination.md §1104.
      ref: hint.ref ?? hint.headRef,
      // M21.5 auto-merge link: a CI-conclusion event (GitHub's `workflow_run`) names no ref, only the
      // commit it ran on. `matchAuthoredBumpChange`'s second route joins that to the bump change that
      // RECORDED that commit as its own branch head — see it for why that is still a fact SCP
      // asserted rather than one the payload claimed.
      commitSha: hint.commitSha
    });
    if (authoredChangeId) {
      // Which commit the authored branch is now at, recorded. See docs/coordination.md §1105.
      const observedCommit = commitShaFromPayload(row.payload);
      if (observedCommit) {
        await recordBumpHeadCommit(tx, orgId, authoredChangeId, observedCommit);
        await tx.execute(sql`
          UPDATE changes
             SET source_ref = jsonb_set(
                   jsonb_set(coalesce(source_ref, '{}'::jsonb), '{commit_sha}', to_jsonb(${observedCommit}::text), true),
                   '{scp_authored,headCommit}', to_jsonb(${observedCommit}::text), true
                 ),
                 updated_at = now()
           WHERE org_id = ${orgId} AND object_id = ${authoredChangeId}
        `);
      }
      // AND THIS IS WHERE AUTO-MERGE BECOMES REACHABLE. See docs/coordination.md §1106.
      await writeOutboxEvent(tx, {
        orgId,
        type: BUMP_OBSERVED_EVENT,
        source: "/dependencies/bumps",
        subject: authoredChangeId,
        data: { changeObjectId: authoredChangeId, sourceKind: row.sourceKind }
      });
      await tx
        .update(changeSourceEvents)
        .set({ processedAt: new Date(), resultingChangeObjectId: authoredChangeId })
        .where(eq(changeSourceEvents.id, row.id));
      continue;
    }

    // ADR-0046 §2 — THE CONFIG-SOURCE TRIGGER. See docs/coordination.md §1107.
    if (hint.repo && hint.commitSha) {
      const registry = await listConfigSourceRegistrations(tx, orgId);
      // `matched` is impossible here (no stack name to match on) — what this asks is the narrower
      // question the trigger needs: does ANY registration cover this repo? An ambiguous repo is
      // enqueued against nothing and reported at drain time by the same matcher, so the loud refusal
      // stays in one place rather than being duplicated here.
      const covering = registry.registrations.filter((r) => {
        const single = resolveConfigSourceForSync([r], hint.repo!, "");
        return single.outcome !== "no_match";
      });
      for (const registration of covering) {
        await enqueueConfigSourceSync(tx, orgId, {
          configSourceId: registration.id,
          repo: hint.repo,
          commitSha: hint.commitSha,
          paths: hint.paths ?? []
        });
      }
    }

    const match = await matchComponentForSource(tx, orgId, {
      sourceKind: row.sourceKind,
      repo: hint.repo,
      path: hint.path,
      paths: hint.paths,
      ref: hint.ref
    });

    if (!match) {
      // No `source_mappings` row matched. See docs/coordination.md §1108.
      await tx
        .update(changeSourceEvents)
        .set({ processedAt: new Date() })
        .where(eq(changeSourceEvents.id, row.id));
      continue;
    }

    // Each unprocessed row is one distinct real-world event. See docs/coordination.md §1109.
    const name = `${row.sourceKind}${hint.repo ? `: ${hint.repo}` : ""}`;
    // `sourceRef` is the raw delivery payload kept verbatim (DESIGN §8) plus canonical keys lifted
    // from the hint — `artifact_digest` (M15.3c/M17.1) and `sbom` (M17.2). See
    // `canonicalizeSourceRef`. Additive: a delivery with neither is passed through byte-identical.
    const sourceRef = canonicalizeSourceRef(row.payload, hint);
    try {
      // SAVEPOINT (nested transaction) around the propose. See docs/coordination.md §1110.
      await tx.transaction(async (inner) => {
        if (hint.requiresInvalid !== undefined) {
          throw badRequest(
            `report carried a malformed \`requires\` — each entry must be {key, at} (got ${JSON.stringify(hint.requiresInvalid)})`
          );
        }
        if (hint.stageDependenciesInvalid !== undefined) {
          throw badRequest(
            `report carried a malformed \`stageDependencies\` — each entry must be {dependsOn, minWeight?, atTargets?} (got ${JSON.stringify(hint.stageDependenciesInvalid)})`
          );
        }
        // The verification, where both sides are finally in hand. See docs/coordination.md §1111.
        const artifactClassVerification = verifyArtifactClass(match.type, hint.artifactClass);
        if (artifactClassVerification.verdict === "mismatch") {
          throw badRequest(artifactClassMismatchReason(artifactClassVerification));
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
          requires: hint.requires,
          // ADR-0028: the stage-scoped coupling from the typed report body (`scp change-source
          // report --stage-depends-on`), threaded the same way — same propose-time resolution of
          // `dependsOn`/`atTargets`, same storage under `properties.stageDependencies`.
          stageDependencies: hint.stageDependencies,
          // WHO DECLARED IT. The CHANGE stays the system actor's. See docs/coordination.md §1112.
          declarationActorObjectId: row.reportedByObjectId ?? undefined
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
      // The REFUSAL surface for a caller-shaped defect. See docs/coordination.md §1113.
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
          // D13 — the verification RECORD, not just the message. See docs/coordination.md §1114.
          artifactClassVerification: verifyArtifactClass(match.type, hint.artifactClass),
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
