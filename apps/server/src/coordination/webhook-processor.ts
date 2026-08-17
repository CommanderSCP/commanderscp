import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  ChangeRequirementSchema,
  SbomRefSchema,
  StageDependencySchema,
  normalizeSbomDigest,
  type SbomRef,
  type StageDependency
} from "@scp/schemas";
import { webhookAdapterForSourceKind } from "./webhook-adapters.js";
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
  /**
   * The SOURCE branch of a pull/merge request, fully qualified — read ONLY by the M21.5 bump
   * correlation, never by source-mapping routing (see `GitProviderEventHint.headRef` for why it is
   * not folded into `ref`).
   *
   * A `pull_request` action=opened delivery for a bump SCP authored can be processed BEFORE the
   * authored push — the ordering is the provider's — and at that moment the bump has no recorded
   * head commit, so neither correlation route could see it. It matched the component's ordinary
   * source mapping and minted the second, unrelated change ADR-0032 §9 exists to prevent. The head
   * ref is the join that was already available on the payload and was being dropped.
   */
  headRef?: string;
  /**
   * The COMMIT this event is about — `head_commit.id`/`after` for a push, the head sha for a PR or
   * a workflow run. Every git-provider adapter's `mapEvent` has always returned one; until M21.2
   * nothing on this side read it, so it was dropped at this boundary and `changes.source_ref` carried
   * no commit AT ALL (measured filterlessly: no non-test module in the tree ever wrote
   * `source_ref.commit`).
   *
   * That was not a cosmetic gap. A ref is a moving label and a commit is an identity, so every
   * consumer that must read a repo AT THE RELEASED POINT was blocked on it: M21.4's language
   * ecosystems refused every release with `no_released_commit`, and M21.2's inventory ingestion
   * would otherwise read a branch head that has since moved past the release it is recording.
   *
   * M21.5 (the auto-merge link) is the other reader, and it is why the ADAPTER's reading has to
   * reach this field rather than only the flat one: GitHub's `workflow_run` (the event that says a
   * component's checks CONCLUDED) carries its commit at `workflow_run.head_sha`, which no flat key
   * reaches, so a CI conclusion arrived at ingress with its commit unreadable. Surfacing it here is
   * what lets `matchAuthoredBumpChange` attach a CI event to the bump change whose own head commit
   * it names.
   *
   * Undefined for any event with no commit (a registry/package push, a release), which correlates
   * exactly as it always has.
   */
  commitSha?: string;
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
  /** ADR-0028 — `ChangeReportRequestSchema.stageDependencies`. `dependsOn` and each `atTargets`
   *  entry are ids-or-URNs here, resolved by `proposeChange` (an unresolvable one is refused — see
   *  `processChangeSourceEvents`). Provider webhook payloads carry none: like a coupling key, a raw
   *  push webhook cannot declare a dependency, so the CI report step is THE channel. */
  stageDependencies?: StageDependency[];
  /** ADR-0028 fail-closed, the SAME reasoning as `requiresInvalid` above: set (verbatim) when the
   *  body carried a `stageDependencies` that does NOT parse. Dropping it would fail OPEN — the
   *  release would execute as if it were free to deploy ahead of everything its author named, which
   *  is precisely the harm the coupling exists to prevent — so the processor REFUSES the event with
   *  a recorded Decision instead. The typed `/report` route's Zod validation makes this unreachable
   *  for SDK/CLI reporters; it exists for hand-crafted raw-`/webhook` payloads. */
  stageDependenciesInvalid?: unknown;
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
    // The flat generic shape carries a ref too, so a hand-crafted raw `/webhook` payload can drive
    // a ref-scoped mapping with no provider adapter in the path. The TYPED `/report` ingress needed
    // more than this line: `ChangeReportRequestSchema` is a `strictObject`, so until `ref` was
    // declared there a CI step sending one got a validation REFUSAL, not a route — reading it here
    // would have been necessary and not sufficient.
    ref: typeof p.ref === "string" && p.ref.length > 0 ? p.ref : undefined,
    // The SAME reader that records the commit onto an authored bump change, so the flat shape's
    // notion of "which commit" has exactly one definition (`commitShaFromPayload`, including its
    // all-zero branch-delete rejection) — that function already covers `commitSha`, the spelling
    // `observe()` writes into the flat payload it correlates from (`coordination/observe.ts`).
    //
    // `commit` is read here and NOT added to that function's key set, deliberately: those keys are
    // pinned to what `governance/gate-orchestrator.ts`'s `resolveChangeCommitSha` reads back out of
    // `source_ref`, and `commit` is not one of them. But a hand-crafted `/webhook` body and the
    // canonical `source_ref` both spell it `commit` (it is the key `canonicalizeSourceRef` mints
    // below), and accepting one spelling and not the other would make the poll-vs-push equivalence
    // DESIGN §12 claims false for this field. Last, so a payload carrying both keeps the pinned set
    // authoritative.
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
    // Same adapter-wins precedence as every field above. Carried through EXPLICITLY because this
    // branch reconstructs field-by-field rather than spreading `generic` — the omission of this one
    // line is what dropped every provider's commit sha at this boundary until M21.2. It is also the
    // field that carries a CI conclusion's commit: only the adapter can read `workflow_run.head_sha`
    // / `object_attributes.sha`, and the flat shape never reaches them — see `ExtractedHint.commitSha`.
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
  // The SERVER-OWNED stamps (`boundaryBundleChecksums`, `promotionExports` — what the exporter
  // signed, rendered as fact by the component pipeline) are never a delivery's to set: a payload
  // that carries them is stripped of exactly those keys, nothing else. The delivery row itself
  // (`change_source_events.payload`) still holds the body byte-for-byte for forensics; the
  // untrusted `POST /changes` door refuses the same keys with a 400 (`routes/changes.ts`).
  const sourceRef: Record<string, unknown> = withoutServerOwnedSourceRefKeys({ ...raw });
  // M21.2 — THE TWO KEYS THAT NAME *WHERE* AND *WHICH POINT*, lifted for the first time.
  //
  // `internal-release-detection.ts` and `inventory-ingestion-loop.ts` both read `source_ref` as
  // flat `{repo, ref, commit}`, and until now that read found almost nothing: a GitHub push nests
  // its repo at `repository.full_name` and its commit at `head_commit.id`, so `repo` was absent for
  // every provider webhook and `commit` was absent for EVERY driver in the tree, `observe()`
  // included (it writes `commitSha`). The measured downstream cost was two hard refusals —
  // `manifest-reader.ts` throws when `repo` is empty and `internal-release-version.ts` refuses with
  // `no_released_commit` when `commit` is — so three of the five ecosystems could not resolve a
  // released version on ANY real delivery, and nothing could read a manifest at the released point.
  //
  // Lifted here rather than defended in each reader for the reason `artifact_digest` is: this is the
  // one place canonical `source_ref` keys are minted, and a reader that dug into a provider's own
  // payload shape would be a per-provider parser in a module that must stay provider-neutral.
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
 * The commit a push payload is at, or `undefined`.
 *
 * THE KEY SET IS NOT CHOSEN HERE — it is exactly the set `governance/gate-orchestrator.ts`'s
 * `resolveChangeCommitSha` reads back out of `source_ref` (`commit_sha`, `commitSha`, `sha`,
 * `after`, `checkout_sha`, then `head_commit.id`). That is the whole point: this function writes the
 * value that function reads, so a key one of them knows and the other does not is a control asked
 * about nothing. `bump-provenance.integration.test.ts` drives a real push payload through the
 * webhook ingress and asserts the recorded `commit_sha`, which is where a divergence would bite.
 *
 * Exported for that test. Not exported to give callers a second way to read a commit: everything
 * downstream reads `source_ref`, never a payload.
 */
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

/**
 * MULTI-REPLICA SINGLE-FLIGHT (M8 hardening — BUILD_AND_TEST.md §8 M8 item 6, found during the
 * same concurrency audit as the trigger-claim and evaluated->coordinated fixes): without `FOR
 * UPDATE SKIP LOCKED` here, two concurrent ticks (two worker replicas' overlapping reconcile
 * loops) each run this ENTIRE function in their own transaction, and BOTH could `SELECT` the SAME
 * unprocessed `change_source_events` row before either commits (plain READ COMMITTED — nothing
 * about a bare `SELECT ... WHERE processed_at IS NULL` prevents a second transaction from reading
 * the identical "still unprocessed" snapshot). Each would then call `proposeChange` for that SAME
 * webhook delivery — creating TWO SEPARATE Change objects for one real-world event, which could
 * go on to independently gate/approve/accept/execute as if they were unrelated changes. `FOR
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

    // M21.5 THE PROVENANCE LOOP (ADR-0032 §9) — BEFORE source-mapping correlation, because a bump SCP
    // authored WOULD match the component's ordinary mapping and would then be proposed as a second,
    // unrelated change for a release that already has one. Attaching here is what makes the returning
    // event the originating change's own rather than a duplicate of it.
    //
    // Deliberately NOT a filter on `sourceKind` or on the mapping: the push arrives through the
    // component's own git provider, so it is indistinguishable from any other push except by the ref
    // SCP chose and the change that claims it. See `correlation.ts`'s `matchAuthoredBumpChange` for
    // why BOTH halves of that claim are required.
    const authoredChangeId = await matchAuthoredBumpChange(tx, orgId, {
      repo: hint.repo,
      // THE PULL REQUEST'S OWN SOURCE BRANCH counts as "the ref this event is about" for the
      // provenance join, and only for it: a `pull_request` opened delivery that beats the authored
      // push has no recorded commit to join on, and would otherwise mint a second change for a
      // release that already has one. `hint.ref` still wins where a provider set one (a push), so
      // no existing event changes route.
      ref: hint.ref ?? hint.headRef,
      // M21.5 auto-merge link: a CI-conclusion event (GitHub's `workflow_run`) names no ref, only the
      // commit it ran on. `matchAuthoredBumpChange`'s second route joins that to the bump change that
      // RECORDED that commit as its own branch head — see it for why that is still a fact SCP
      // asserted rather than one the payload claimed.
      commitSha: hint.commitSha
    });
    if (authoredChangeId) {
      // WHICH COMMIT THE AUTHORED BRANCH IS NOW AT — recorded onto the change, not merely observed.
      //
      // This is what makes the charter's auto-merge clause enforceable. `dependencies/bump-actuator.ts`
      // grants `auto_merge` only on a control run that evidences the component's own checks passed FOR
      // THIS BUMP'S OWN COMMIT, and until this event there is no such commit anywhere: the change is
      // recorded before the branch exists, so `@scp/plugin-github-check` would fall back to its
      // operator-pinned `expectedRef` and could report CI green for the BASE branch — green on `main`
      // used as proof that the edit to `main` is safe.
      //
      // WHERE IT IS WRITTEN, and why it is written twice:
      //
      //   1. `dependency_bump_authorships.head_commit` — THE AUTHORITY. Server-owned storage
      //      (migration 0063) that no tenant-facing write path can reach. Everything that leads to a
      //      merge reads it: the delivery grant's "which commit", the merge precondition sent to the
      //      provider, and the correlation route that attaches a ref-less CI event to this bump.
      //   2. `changes.source_ref.commit_sha` — THE READABLE LIFT, because that is what
      //      `governance/gate-orchestrator.ts`'s `resolveChangeCommitSha` reads to tell a control
      //      WHICH commit this change is about, and it is the same key every other change uses. Note
      //      what that does and does not buy: forging it changes which commit a control is ASKED
      //      about, and the grant then refuses because the control's evidence names a commit that is
      //      not the recorded head. The authority is (1); this is the question, not the answer.
      //      `scp_authored.headCommit` rides along beside it as the human-readable statement.
      //
      // A LATER PUSH TO THE SAME BRANCH OVERWRITES BOTH, deliberately: the bump's head IS the newest
      // commit on its branch, and leaving the first one standing would let evidence about a superseded
      // commit authorise merging a different tree. Idempotent under redelivery — the same push writes
      // the same value.
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
      // ============================================================================================
      // AND THIS IS WHERE AUTO-MERGE BECOMES REACHABLE (M21.5, ADR-0032 §8c)
      // ============================================================================================
      // Something observable happened to a bump SCP authored. That is the ONLY trigger under which
      // the delivery question is worth asking a second time, and until this line nothing asked it:
      // §8c recorded `auto_merge` as resolved, recorded and downgraded forever precisely because no
      // producer of a re-evaluation existed.
      //
      // EMITTED AT THE CHOKE POINT, NOT PER EVENT KIND, for the same reason the head-advance event is
      // emitted at the one head write door (ADR-0032 §8a clause 1): the two events that reach here
      // today are the authored push and the CI conclusion that names its commit, and a third that
      // correlates to a bump re-evaluates it by construction rather than by somebody remembering to
      // add a case.
      //
      // IT IS NOT A VERDICT AND CARRIES NONE. The consumer (`dependencies/bump-gate.ts`) re-reads the
      // change, runs the EXISTING governance gate for it, and re-asks
      // `resolveEffectiveDelivery` — so a redelivery, an out-of-order arrival, or an event about a
      // commit that has since been superseded all reach the same answer as a first delivery. The
      // subject is the CHANGE; nothing downstream trusts this payload for anything but a lookup key.
      //
      // Rides the ordinary outbox in the ingress transaction (DESIGN §8), so an event that attached
      // cannot fail to notify and a notification cannot name an attachment that rolled back.
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

    const match = await matchComponentForSource(tx, orgId, {
      sourceKind: row.sourceKind,
      repo: hint.repo,
      path: hint.path,
      paths: hint.paths,
      ref: hint.ref
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
        if (hint.stageDependenciesInvalid !== undefined) {
          throw badRequest(
            `report carried a malformed \`stageDependencies\` — each entry must be {dependsOn, minWeight?, atTargets?} (got ${JSON.stringify(hint.stageDependenciesInvalid)})`
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
          requires: hint.requires,
          // ADR-0028: the stage-scoped coupling from the typed report body (`scp change-source
          // report --stage-depends-on`), threaded the same way — same propose-time resolution of
          // `dependsOn`/`atTargets`, same storage under `properties.stageDependencies`.
          stageDependencies: hint.stageDependencies,
          // WHO DECLARED IT. The CHANGE stays the system actor's — nobody asked for it, a push
          // happened — but the `depends_on` edges the declaration mints are a deliberate,
          // authorized graph write by the REPORTING PRINCIPAL, and the route that authorized it
          // (`routes/change-sources.ts`, `relationship:write` at both endpoints) is the only place
          // that principal exists. Carried on the event row since 0054 so it survives to here.
          // Without it the edge's audit event, journal entry and emitted event all name the system
          // actor, leaving "who declared that A depends on B?" unanswerable — for a write that
          // changes `graph.dependentIds`, a live CEL policy input for the depended-on component.
          // NULL (an observe()-driven row, or one written before 0054) falls back to the change's
          // own actor, which is the system actor and is the honest answer there.
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
