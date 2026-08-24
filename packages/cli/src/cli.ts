import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { Command } from "commander";
import { reconcileStaleClaimants, ScpApiError, ScpClient } from "@scp/sdk";
import type { ListObjectsQuery, ListQuery } from "@scp/sdk";
import type {
  ApprovalRequest,
  ApprovalVote,
  Campaign,
  CampaignExplainResponse,
  CampaignStatus,
  Change,
  ChangeExplainResponse,
  ChangeState,
  ChangeWaitStatus,
  CreateObjectRequest,
  Decision,
  DesiredStateManifest,
  DoctorCheck,
  ExecutorType,
  PipelineClassification,
  SourceMapping,
  SourceMappingScope,
  Freeze,
  GraphObject,
  NamedGraphQuery,
  ObjectListResponse,
  Pat,
  Plan,
  PlanDiff,
  PlanDiffSummary,
  PlanDependencyProducerDiffEntry,
  PlanExecutorBindingDiffEntry,
  PlanGovernanceMoveRungDiffEntry,
  PlanObjectDiffEntry,
  PlanPlacementDiffEntry,
  PlanRelationshipDiffEntry,
  PlanSourceMappingDiffEntry,
  PolicyEvaluateResponse,
  Relationship,
  RelationshipListResponse,
  UpdateObjectRequest,
  UpsertObjectRequest,
  // M6: Federation Basics (BUILD_AND_TEST.md §8 M6, DESIGN §13).
  DeliveryTarget,
  FederationPeer,
  FederationStatusResponse,
  ImportBundleRequest,
  // M13.2/M13.3b — the two scan surfaces whose table rows are now exported formatters (Y2).
  InstanceScanFloor,
  InstanceScanExclusionAdmission,
  ScanDbStatus,
  RefreshScanDbResponse,
  LoadScanDbResponse,
  // M21.3 (ADR-0032 §3a/§6) — the dependency-subscription enablement chain.
  DependencyEcosystem,
  // M21.2 (ADR-0032 §4) — the inventory backfill.
  DependencyInventoryBackfillComponent,
  DependencySubscriptionContribution,
  DependencySubscriptionResolutionResponse,
  DependencySubscriptionUnlock,
  // M21.6 — the component-scoped dependency READ surface (inventory + bumps).
  ComponentDependencyBump,
  ComponentDependencyBumpsResponse,
  ComponentDependencyInventoryResponse,
  ComponentDependencyInventoryRow,
  // ADR-0032 §7e — the producer declaration's authoring surface.
  DependencyLineProducerView,
  DependencyLineProducerVerbResponse,
  DependencyProducerLineImpact,
  DependencyProducerOpenBump,
  // M16.2 phase A — the `outpost` config object (E1) + the narrow peer PATCH (E4).
  OutpostConfig,
  OutpostConfigReconcileResult,
  OutpostTrustTier,
  UpdateFederationPeerRequest,
  SyncScope,
  ScanMethod,
  // ADR-0028 — stage-scoped component coupling declared by a microservice's own CI.
  StageDependency,
  ChangeStageDependencyStatus,
  ChangeStageDependencyTarget,
  ChangeStageDependencyVerdict,
  // governance:move lattice (governance-reach-on-containment-move.md §9.2, owner ruling 2026-08-18).
  GovernanceMoveEnforcement,
  GovernanceMoveInstanceRung,
  GovernanceMoveRung,
  GovernanceMoveRungWriteResponse
} from "@scp/schemas";
import {
  DesiredStateManifestSchema,
  outpostClaimantTokens,
  OutpostTrustTierSchema,
  ScanMethodSchema,
  SourceMappingScopeSchema
} from "@scp/schemas";
// Node-only hashing (`node:crypto`) — deliberately a separate subpath from `@scp/schemas`'
// default entry, which `apps/web` also imports (browser build) — see audit-chain.ts's module doc.
import { verifyAuditChain } from "@scp/schemas/audit-chain";
import { saveCredentials } from "./config-store.js";
import { clientFromStoredCredentials, resolveLoginBaseUrl } from "./client-factory.js";
import { promptLine } from "./prompt.js";
import { printResult, type OutputFormat } from "./output.js";

/**
 * ABSENT — `null` OR `undefined`, never one of the two.
 *
 * A key an older or newer server OMITS arrives as `undefined` whatever the TypeScript type says.
 * SINCE ADR-0023 the SDK validates every 2xx JSON body of every spec'd operation, so for a field
 * that is `.nullable()` WITHOUT `.optional()` an omitted key now REJECTS at the boundary and this
 * guard is defence in depth. For a field that IS `.optional()` nothing changed: an omitted key is
 * contract-legal, passes validation untouched, and this guard is the only thing left. A strict
 * `=== null` therefore guards ONE of two legal absences and lets the other through to a printer, where it
 * becomes the literal string `undefined`, a crash on `.toFixed(…)`, or — worst — the CONFIDENT
 * branch of a ternary whose other branch was the honest one. `apps/web/src/lib/absent.ts` is the
 * same rule for the browser half; this is the CLI's copy, because the two share no runtime.
 */
function isAbsent(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}

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

/** M12 P4B — parse a `--requires` flag value: comma-separated `key@objectIdOrUrn` entries (the
 *  SAME format on `scp change propose` and `scp change-source report`). Split on the LAST '@' so a
 *  URN (which contains ':' but not '@') survives; a missing/empty half is a clear error, not a
 *  silent drop. */
function parseRequiresFlag(value: string | undefined): { key: string; at: string }[] | undefined {
  if (value === undefined) return undefined;
  return value.split(",").map((entry) => {
    const at = entry.slice(entry.lastIndexOf("@") + 1).trim();
    const key = entry.slice(0, entry.lastIndexOf("@")).trim();
    if (entry.lastIndexOf("@") < 0 || !key || !at) {
      throw new Error(`--requires entry '${entry}' must be 'key@objectIdOrUrn'`);
    }
    return { key, at };
  });
}

/** ADR-0028 — parse `--stage-depends-on` / `--stage-depends-at` into `stageDependencies` (the SAME
 *  pair of flags on `scp change propose` and `scp change-source report`).
 *
 *  `--stage-depends-on` is comma-separated `componentIdOrUrn` or `componentIdOrUrn@minWeight`; the
 *  '@' split is the LAST one, so a URN (which contains ':' but never '@') survives, exactly as
 *  `parseRequiresFlag` does. A present-but-unparseable weight is an error, not a silent drop to "no
 *  qualifier": the two mean different things and coercing one into the other would quietly widen the
 *  hold the author asked for.
 *
 *  `--stage-depends-at` scopes EVERY entry to the same deployment targets. The wire shape carries
 *  `atTargets` PER dependency, which is strictly more expressive; a release needing two dependencies
 *  scoped to different places must use the API/SDK. Said plainly here rather than pretending the
 *  flags are complete. */
export function parseStageDependenciesFlags(
  dependsOn: string | undefined,
  atTargets: string | undefined
): StageDependency[] | undefined {
  if (dependsOn === undefined) {
    if (atTargets !== undefined) {
      throw new Error("--stage-depends-at has no effect without --stage-depends-on");
    }
    return undefined;
  }
  const at = parseList(atTargets);
  return parseList(dependsOn)?.map((entry) => {
    const cut = entry.lastIndexOf("@");
    if (cut < 0) return { dependsOn: entry, ...(at ? { atTargets: at } : {}) };
    const ref = entry.slice(0, cut).trim();
    const weight = Number(entry.slice(cut + 1).trim());
    if (!ref || !Number.isInteger(weight) || weight < 1 || weight > 100) {
      throw new Error(
        `--stage-depends-on entry '${entry}' must be 'componentIdOrUrn' or 'componentIdOrUrn@minWeight' with minWeight an integer 1-100`
      );
    }
    return { dependsOn: ref, minWeight: weight, ...(at ? { atTargets: at } : {}) };
  });
}

function objectRow(o: GraphObject): Record<string, string> {
  return {
    id: o.id,
    type: o.typeId,
    name: o.name,
    urn: o.urn,
    version: String(o.version),
    // M20.1 (ADR-0031). Shown as a column rather than only in `--output json`: whether an object
    // leaves its security domain is exactly the kind of fact an operator should not have to go
    // looking for, and the table view is what they see by default.
    "domain-local": o.domainLocal ? "yes" : "no",
    deleted: o.deletedAt ? "yes" : "no"
  };
}

function relationshipRow(r: Relationship): Record<string, string> {
  return { id: r.id, type: r.typeId, from: r.fromId, to: r.toId };
}

function patRow(p: Pat): Record<string, string> {
  return {
    id: p.id,
    name: p.name,
    createdAt: p.createdAt,
    expiresAt: p.expiresAt ?? "(none)",
    revoked: p.revokedAt ? "yes" : "no",
    lastUsedAt: p.lastUsedAt ?? "(never)"
  };
}

/** Compact row for `scp change list` — mirrors `objectRow`'s style. */
function changeRow(c: Change): Record<string, string> {
  return {
    id: c.id,
    name: c.name,
    state: c.state,
    sourceKind: c.sourceKind ?? "",
    correlationKey: c.correlationKey ?? "",
    createdAt: c.createdAt
  };
}

/** Fuller row for single-Change commands (propose/get/cancel/accept/rollback). */
function changeDetailRow(c: Change): Record<string, string> {
  return {
    id: c.id,
    name: c.name,
    urn: c.urn,
    state: c.state,
    sourceKind: c.sourceKind ?? "",
    correlationKey: c.correlationKey ?? "",
    rollbackOfObjectId: c.rollbackOfObjectId ?? "",
    emergency: c.emergency ? "yes" : "no",
    createdAt: c.createdAt,
    updatedAt: c.updatedAt
  };
}

function decisionRow(d: Decision): Record<string, string> {
  return {
    id: d.id,
    kind: d.kind,
    subjectId: d.subjectId,
    verdict: d.verdict,
    createdAt: d.createdAt
  };
}

// -------------------------------------------------------------------------------------
// M5 Campaigns (BUILD_AND_TEST.md §8 M5, DESIGN.md §9.5) — row formatters.
// Campaign `status` is a pure derived field (no accept/cancel verbs), so it's surfaced
// prominently in both the compact and detail rows.
// -------------------------------------------------------------------------------------

function campaignRow(c: Campaign): Record<string, string> {
  return {
    id: c.id,
    name: c.name,
    status: c.status,
    targets: String(c.targets.length),
    createdAt: c.createdAt
  };
}

/** EXPORTED so `cli-absent-formatters.test.ts` can call it. It was module-private and therefore
 *  unreachable by any test, which is exactly why reverting its `isAbsent` guard left the suite
 *  green — a fix nothing can red is not a fix, it is a coincidence waiting to be undone. */
export function campaignDetailRow(c: Campaign): Record<string, string> {
  return {
    id: c.id,
    name: c.name,
    urn: c.urn,
    status: c.status,
    description: c.description ?? "",
    targets: c.targets.join(", "),
    topologyObjectId: c.topologyObjectId ?? "",
    topologyVersion: isAbsent(c.topologyVersion) ? "" : String(c.topologyVersion),
    createdAt: c.createdAt,
    updatedAt: c.updatedAt
  };
}

// -------------------------------------------------------------------------------------
// M6 Federation Basics (BUILD_AND_TEST.md §8 M6, DESIGN.md §13) — row formatters.
// -------------------------------------------------------------------------------------

/**
 * One paired peer as a `scp federation peers` table row.
 *
 * EXPORTED, like `federationStatusRow` beside it and for the same reason (round 4, Y2): a guard no
 * test can invoke is a guard nothing holds in place. This function was module-private, so the
 * `?.mode ?? "?"` below could be reverted without a single test noticing.
 *
 * `syncScope` is required-not-optional on `FederationPeerSchema`, and BEFORE ADR-0023 the generated
 * SDK validated NO response at runtime, so `p.syncScope.mode` was a bare dereference of a promise
 * about the server (since ADR-0023 such a body rejects at the SDK boundary and `bin.ts` prints the
 * operation and the field; this stays for every other source of a peer, and this function is what a
 * test can actually invoke) —
 * the EXACT field `outpost-settings.tsx`'s `peerSyncScopeMode` guards on the web side (its doc
 * comment states the rule). MEASURED here: `TypeError: Cannot read properties of undefined (reading
 * 'mode')`, thrown while building the FIRST row, so `scp federation peers` printed no table at all.
 *
 * `"?"` RATHER THAN `"full"`, deliberately, and matching `transport` below: substituting a default
 * would tell the operator this peer exports everything on no evidence whatsoever. An unknown scope
 * is unknown.
 */
export function peerRow(p: FederationPeer): Record<string, string> {
  return {
    id: p.id,
    name: p.name,
    role: p.role,
    baseUrl: p.baseUrl ?? "",
    syncScope: (p.syncScope as SyncScope | undefined)?.mode ?? "?",
    // M17.3 (E5) — whether this peer's cosign VERIFICATION key is registered (from pairing). Presence
    // only in the table; the full PEM is in `--output json`. A peer paired before E5 shows "none".
    cosign: p.cosignPublicKey ? "registered" : "none",
    // M13.2a (§13.2) — the peer's DeliveryTarget provider, or "env" when none is configured (the
    // instance `SCP_RELAY_OUT_DIR`/`SCP_RELAY_IN_DIR` fallback). Full dirs are in `--output json`.
    delivery: p.deliveryTarget?.provider ?? "env",
    // M14.1 (ADR-0009) — poke-mode (the commander may send a contentless wake signal) vs poll-mode
    // (the default frequent interval pull). Absent in an old response reads as poll.
    poke: p.pokeMode ? "poke" : "poll",
    pairedAt: p.pairedAt
  };
}

/**
 * `scp federation status` in table form. EXPORTED for the reason given on `peerRow`.
 *
 * `peers` is required-not-optional on `FederationStatusResponseSchema` and BEFORE ADR-0023 the SDK
 * validated no response — the LAST unguarded consumer of that field (Z5). Since ADR-0023 a body
 * without the key rejects at the boundary rather than reaching this printer. `outposts.tsx` reads it as
 * `statusQuery.data?.peers ?? []` and `outpost-detail.tsx` passes `data?.peers` into a function that
 * accepts `undefined`; this and `federation-status.tsx` were the two that did not. "No paired peers."
 * is the honest degradation: it says this side has no peer rows to show, which is exactly what an
 * absent list means here.
 */
export function printFederationStatus(
  status: FederationStatusResponse,
  output: OutputFormat
): void {
  if (output === "json") {
    console.log(JSON.stringify(status, null, 2));
    return;
  }
  const peers = status.peers ?? [];
  console.log(
    status.self
      ? `Self: ${status.self.name} (${status.self.domainId}) role=${status.self.role}`
      : "Self: not initialized — run `scp federation init`"
  );
  // M17.3 (E5) — the LOCAL cosign verification public key an operator copies into a peer's
  // `scp federation pair --cosign-public-key ...` for out-of-band distribution (works file-only for
  // air-gapped peers). Full value in `--output json`; here we note presence to keep the line compact.
  if (status.self) {
    console.log(
      status.self.cosignPublicKey
        ? `Cosign verification key: present (copy from \`scp federation self\` / --output json)`
        : "Cosign verification key: not yet provisioned"
    );
  }
  if (peers.length === 0) {
    console.log("No paired peers.");
    return;
  }
  printResult(peers, "table", (item) =>
    federationStatusRow(item as FederationStatusResponse["peers"][number])
  );
  // The honest-unknown declaration, surfaced rather than silently dropped by the table above.
  for (const p of peers) {
    const unknown = p.unknownFields ?? [];
    if (unknown.length > 0) {
      console.log(`  ${p.peer.name}: not observable here — ${unknown.join(", ")}`);
    }
  }
}

/**
 * ONE peer's row in `scp federation status` — EXTRACTED FROM the `printResult` callback inside
 * `printFederationStatus` (itself module-private), and exported, so that every honest-unknown rule
 * below is reachable by a test.
 *
 * WHY THE EXTRACTION IS THE POINT (Y2). Every `isAbsent` guard here was added to stop a fabrication,
 * and every one of them could be reverted with the CLI suite still GREEN, because nothing could
 * invoke the closure they lived in. `cli-absent-formatters.test.ts` now reverts each of them and
 * watches a named assertion go red. The most consequential is `trustTier`: without the
 * `unknownFields` clause a HAND-TYPED (shadow) tier prints BARE, with no `(unverified)` suffix —
 * the CLI reproduction of exactly the fabrication the web `TrustTierCell` exists to prevent.
 */
export function federationStatusRow(
  p: FederationStatusResponse["peers"][number]
): Record<string, string> {
  return {
    peer: `${p.peer.name} (${p.peer.id})`,
    role: p.peer.role,
    // DESIGN §13: air-gapped peers are explicitly "as of <bundle/date>", never presented as live.
    syncedThrough: isAbsent(p.lastAppliedSequence)
      ? "never synced"
      : `seq ${p.lastAppliedSequence}`,
    asOf: p.lastSyncedAt ?? "never",
    // M14.4 (ADR-0009) — the cadence ACTUALLY in force, next to the raw flag on `federation peers`.
    // "poke*" flags a divergence worth looking at: the peer is configured for poke-mode but the
    // scheduler is still polling it — never poked (D2), no client certs (D4), or the last pull
    // failed (the reconnect leg). Timestamps are in `--output json`.
    cadence:
      (p.effectiveCadence ?? (p.peer.pokeMode ? "poke" : "poll")) === "poke"
        ? "poke"
        : p.peer.pokeMode
          ? "poke*"
          : "poll",
    lastPull: p.lastPullSuccessAt ?? p.lastPullAttemptAt ?? "never",
    // M16.2 phase A (E3) — PENDING-EXPORT, never pending-apply. "N pending" counts THIS domain's own
    // journal entries not yet carried in any bundle addressed to the peer; it says NOTHING about what
    // the peer applied (this side cannot observe that — see the schema's note and `unknownFields`).
    // `?` is printed whenever the field is declared unknown, so a null never reads as "nothing
    // pending"/"synced".
    pendingExport: isAbsent(p.pendingExportEntryCount)
      ? "?"
      : `${p.pendingExportEntryCount} pending`,
    // The owner-ENTERED trust tier from the peer's `outpost` object, or "?" when never asserted
    // (F3: there is no source for a default, so the CLI must not print one). An UNVERIFIED
    // hand-filled claim is suffixed rather than printed bare — it is not a commander assertion.
    trustTier: isAbsent(p.trustTier)
      ? "?"
      : p.trustTierProvenance === "unverified" || (p.unknownFields ?? []).includes("trustTier")
        ? `${p.trustTier} (unverified)`
        : p.trustTier,
    // The CONFIGURED transport channel, deliberately separate from the tier and NEVER a reachability
    // claim ("dialable" means a dialable URL is configured; `lastPull` above is the observation).
    // "?" when no transport is configured, or when one is configured that federation refuses to dial.
    transport: p.transportMode ?? "?",
    // `?? []` — the same required-not-optional/no-runtime-validation read that white-screened the
    // web detail page; here it would abort the WHOLE table on `.length` of `undefined`.
    recentTransfers: String((p.recentTransfers ?? []).length)
  };
}

/**
 * M16.2 phase A (E1) — one `outpost` config object as a table row. `trustTier` prints "?" when the
 * operator has never asserted one; `origin` distinguishes a commander's own authored object from the
 * read-only REPLICA an outpost holds of it.
 *
 * EXPORTED for the reason given on `peerRow`: this was module-private, so the `?? []` below was
 * unreachable by any test.
 *
 * `unknownFields` is required-not-optional (`packages/schemas/src/federation.ts` `OutpostConfigSchema`)
 * and BEFORE ADR-0023 the SDK validated no response, so `o.unknownFields.join(", ")` was bare
 * (since ADR-0023 that body rejects at the boundary). MEASURED: `TypeError:
 * Cannot read properties of undefined (reading 'join')`. Its web twin at `outpost-configuration.tsx`
 * took the `?? []` last round and IS pinned; this half was not fixed even though the PR body claimed
 * the field "closed as a class". Blast radius is SIX commands (`cli.ts` ~2963/2993/3005/3017/3044/3050).
 *
 * `?? []` collapses to the same `"-"` an EMPTY `unknownFields` prints — and that is the honest
 * reading either way: this side has nothing to report as not-observable. It is NOT a claim that every
 * field is observable, which is why the column is headed "notObservable" and not "observable".
 */
export function outpostConfigRow(o: OutpostConfig): Record<string, string> {
  return {
    peerDomainId: o.peerDomainId,
    // §10.5 — WHAT `peerDomainId` NAMES (GLOSSARY / ADR-0021 D7 vocabulary): `hq` = THIS
    // instance's own trust domain — the HQ outpost (formerly "co-located"), which has no peer row;
    // `field` = a paired peer in another trust domain — a field outpost, whatever its
    // connectivity. `peerIsSelf` is optional on the wire (additive): an older server that does not
    // resolve it prints `?`, never "field" — absence is not a statement.
    binding: o.peerIsSelf === true ? "hq" : o.peerIsSelf === false ? "field" : "?",
    name: o.name,
    trustTier: o.trustTier ?? "?",
    originDomainId: o.originDomainId,
    revision: String(o.revision),
    version: String(o.version),
    notObservable: (o.unknownFields ?? []).join(", ") || "-"
  };
}

/**
 * One instance-scoped scan-requirement floor as a table row (`scp scan-floors list`) — LIFTED OUT of
 * the action closure it was written inside, and exported, for the reason given on
 * `federationStatusRow`: a guard no test can invoke is a guard nothing holds in place.
 *
 * THE FABRICATION EACH `isAbsent` STOPS is specific and severe here. `null` on a ceiling means
 * UNBOUNDED — no limit was authored — and it is NOT `0`. An unguarded `String(undefined)` prints the
 * literal `undefined` in a security ceiling column; the honest rendering is `-`.
 */
export function instanceScanFloorRow(item: InstanceScanFloor): Record<string, string> {
  return {
    tier: item.tier,
    origin: item.origin,
    maxCritical: isAbsent(item.maxCritical) ? "-" : String(item.maxCritical),
    maxHigh: isAbsent(item.maxHigh) ? "-" : String(item.maxHigh),
    maxMedium: isAbsent(item.maxMedium) ? "-" : String(item.maxMedium),
    maxLow: isAbsent(item.maxLow) ? "-" : String(item.maxLow),
    note: item.note ?? ""
  };
}

/**
 * One instance-scoped exclusion admission as a table row (`scp scan-exclusion-admissions list`) —
 * same lift, same reason as `instanceScanFloorRow`.
 *
 * THE FABRICATION `isAbsent` STOPS HERE is the reverse of the floor's: an admission row's mere
 * EXISTENCE is the grant, so there is no value to print `undefined` in — but `note` is nullable and
 * a literal `null` in an operator's audit column reads as a value somebody authored.
 */
export function instanceScanExclusionAdmissionRow(
  item: InstanceScanExclusionAdmission
): Record<string, string> {
  return {
    tier: item.tier,
    class: item.class,
    origin: item.origin,
    note: isAbsent(item.note) ? "" : String(item.note),
    updatedAt: isAbsent(item.updatedAt) ? "-" : String(item.updatedAt)
  };
}

/**
 * The managed-scan DB status row (`scp scan-db status`) — same lift, same reason.
 *
 * `ageHours` is the one where absence is not merely dishonest but FATAL: `.toFixed(1)` on
 * `undefined` throws, so the whole command dies rather than printing a status. "(unknown)" is the
 * honest reading — and it must not read as "fresh", because an unknown age is precisely the state a
 * staleness gate cannot clear.
 */
export function scanDbStatusRow(s: ScanDbStatus): Record<string, string> {
  return {
    present: String(s.present),
    source: s.source,
    ageHours: isAbsent(s.ageHours) ? "(unknown)" : s.ageHours.toFixed(1),
    schemaCompatible: String(s.schemaCompatible),
    staleness: s.staleness,
    thresholdFired: s.thresholdFired,
    softMaxAgeHours: String(s.activeSoftMaxAgeHours),
    hardMaxAgeHours: String(s.activeHardMaxAgeHours)
  };
}

/**
 * `scp scan-db refresh` / `scp scan-db load` outcome as a table row — LIFTED OUT of the two
 * `.action()` closures it was duplicated inside, and exported, for the reason given on
 * `scanDbStatusRow`.
 *
 * THE TWIN ONE COMMAND OVER (Z5). `scanDbStatusRow` guards `ageHours` because absence there is both
 * dishonest and FATAL; the identical read in these two closures was `String(r.status.ageHours)`,
 * left bare — so an omitted key printed the literal `undefined` in the age column of a SECURITY
 * cache, and an omitted `status` object threw over the report of a load that had already happened.
 * Same shape as Z4: the verb ran, and only the telling of it died.
 *
 * `"(unknown)"`, not `0` and not blank: an unknown age is precisely the state a staleness gate
 * cannot clear.
 */
export function scanDbOutcomeRow(
  outcome: RefreshScanDbResponse | LoadScanDbResponse
): Record<string, string> {
  const status = outcome.status as ScanDbStatus | undefined;
  const row: Record<string, string> = {};
  // The verb column keeps its own name on each command — "refreshed" and "loaded" are different
  // claims (a connected upstream pull vs an operator-carried signed blob) and must not be merged.
  if ("loaded" in outcome) row.loaded = String((outcome as LoadScanDbResponse).loaded);
  else row.refreshed = String((outcome as RefreshScanDbResponse).refreshed);
  row.source = status?.source ?? "(unknown)";
  row.ageHours = isAbsent(status?.ageHours) ? "(unknown)" : String(status.ageHours);
  row.detail = outcome.detail ?? "";
  return row;
}

/**
 * The instance dependency-subscription unlock as a table row (`scp dependency-subscriptions unlock`)
 * — exported, and written outside the action closure, for the reason given on `instanceScanFloorRow`.
 *
 * `updatedAt` distinguishes NEVER SET (no row — the locked default) from DELIBERATELY RE-LOCKED
 * (a timestamp beside `unlocked: false`), which is exactly the distinction an operator needs and
 * exactly the one a bare boolean loses. `"(never set)"`, not blank and not "now".
 */
export function dependencySubscriptionUnlockRow(
  unlock: DependencySubscriptionUnlock
): Record<string, string> {
  return {
    unlocked: String(unlock.unlocked),
    updatedAt: isAbsent(unlock.updatedAt) ? "(never set)" : unlock.updatedAt,
    source: unlock.source ?? "",
    note: unlock.note ?? ""
  };
}

/**
 * The verdict line of `scp dependency-subscriptions resolve`. The `contributions` are printed as
 * their own table beside it (below) — they are the answer to "WHICH level turned this off", and
 * folding them into one cell would make the explainability surface unreadable at the exact moment
 * it is being consulted.
 *
 * `granularity`/`delivery` are guarded even though the server always sends them: a key an older or
 * newer server omits arrives as `undefined` whatever the type says, and printing the literal
 * `undefined` in a DELIVERY column — where the two values are "open a PR" and "merge it
 * automatically" — is a fabrication with teeth.
 *
 * `managedHere`/`managedReason` carry the server's `dependencyManagement` envelope (ADR-0032 §7d),
 * printed BESIDE the verdict because they QUALIFY it: on a deployment that is not an explicitly
 * declared commander, `enabled: true` is arithmetically correct and NOTHING THERE WILL EVER ACT ON
 * IT. Guarded like the pair above, and for a sharper reason — a server that omits the key must
 * render `-`, never a fabricated `true`, because inventing "yes, managed here" is the exact false
 * reassurance the envelope exists to remove.
 */
export function dependencySubscriptionResolutionRow(
  response: DependencySubscriptionResolutionResponse
): Record<string, string> {
  const r = response.resolution;
  const managed = response.dependencyManagement as
    DependencySubscriptionResolutionResponse["dependencyManagement"] | undefined;
  const managedHere = managed?.managedHere;
  const managedReason = managed?.reason;
  return {
    component: response.componentObjectId,
    ecosystem: response.line.ecosystem,
    coordinate: response.line.coordinate,
    major: response.line.major,
    enabled: String(r.enabled),
    reason: r.reason,
    granularity: isAbsent(r.granularity) ? "-" : r.granularity,
    delivery: isAbsent(r.delivery) ? "-" : r.delivery,
    managedHere: isAbsent(managedHere) ? "-" : String(managedHere),
    managedReason: isAbsent(managedReason) ? "-" : managedReason
  };
}

/**
 * …AND THE SAME THING IN WORDS, when nothing on this deployment will act on the verdict (ADR-0032
 * §7d). `undefined` means print nothing.
 *
 * A `false` in a column is easy to read past, and the whole point of the envelope is that an
 * operator reading `enabled: true` on a field outpost is being told something true and misleading at
 * once. Printed ONLY for the refusals: a declared commander needs no caveat, and a caveat on every
 * invocation is one nobody reads.
 *
 * EXPORTED, AND OUTSIDE THE `.action()` CLOSURE, FOR THE REASON THE FORMATTERS ABOVE RECORD. This
 * lived inline in the resolve command's Commander closure, where no test can reach it: inverting the
 * condition — so the note prints on a healthy commander and is SILENT on the deployment it exists to
 * warn, the one inversion that matters — left the entire suite green. `dependency-subscription-cli.
 * test.ts` now pins BOTH directions, which is the only shape in which a conditional caveat is held.
 *
 * ABSENT IS NOT A REFUSAL. A server that omits the envelope gets no note (`=== false`, never
 * falsy): the row already renders `-` there rather than fabricating a posture, and asserting a
 * refusal the server never claimed would be the same fabrication with a louder voice.
 */
export function dependencyManagementNote(
  managed: DependencySubscriptionResolutionResponse["dependencyManagement"] | undefined
): string | undefined {
  if (managed?.managedHere !== false) return undefined;
  return (
    `NOTE: dependency management does NOT run on this deployment (${managed.reason}), ` +
    `so nothing here will act on the verdict above — the subscription is resolved from policies ` +
    `that federated down, and any bump is authored on the COMMANDER (ADR-0032 §7d).`
  );
}

/** ONE contribution to the enablement AND. `contributed` is the load-bearing column: `lock`/`disable`
 *  name the level that turned it off, `ignored` (with its reason) names a contribution that was found
 *  and admitted to NEITHER side — a malformed opt-out fails OPEN, so it must be visible here. */
export function dependencySubscriptionContributionRow(
  c: DependencySubscriptionContribution
): Record<string, string> {
  const selector = c.selector
    ? [
        c.selector.ecosystem ? `ecosystem=${c.selector.ecosystem}` : "",
        c.selector.coordinate ? `coordinate=${c.selector.coordinate}` : "",
        c.selector.major ? `major=${c.selector.major}` : ""
      ]
        .filter(Boolean)
        .join(" ")
    : "";
  return {
    tier: c.tier,
    contributed: c.contributed,
    // "*" is the wildcard an ABSENT selector actually is — blank would read as "matched nothing".
    selector: selector === "" ? "*" : selector,
    ignoredReason: c.ignoredReason ?? "",
    granularity: c.granularity ?? "",
    delivery: c.delivery ?? "",
    objectTypeId: c.objectTypeId ?? "",
    source: c.source
  };
}

/**
 * One component's row from `scp dependency-subscriptions backfill-inventory` (M21.2, ADR-0032 §4).
 *
 * `skipped` is a first-class column, not a footnote: a dependency manifest that could not be READ is
 * deliberately left alone rather than treated as declaring nothing (unreadable is not empty), so a
 * nonzero count means part of this component's inventory is STALE rather than wrong — and that is
 * invisible unless it is printed.
 */
export function dependencyInventoryBackfillRow(
  c: DependencyInventoryBackfillComponent
): Record<string, string> {
  return {
    component: c.name,
    verdict: c.verdict,
    manifests: String(c.manifestsIngested),
    declarations: String(c.declarationsRecorded),
    // THE DESTRUCTIVE HALF, PRINTED. A backfill DELETES declarations a manifest no longer makes,
    // and a receipt showing only what was added makes a run that emptied a component's inventory
    // (the wrong ref, a repo mid-migration) look identical to a clean one. A clean re-run prints 0.
    pruned: String(c.declarationsPruned),
    removed: String(c.manifestsRemoved),
    skipped: String(c.manifestsSkipped),
    // Zero for `not_enabled`, always: the enablement gate runs before any provider call, so this
    // column is the operator-visible receipt for "a disabled component is never fetched".
    reads: String(c.reads),
    detail: c.detail
  };
}

/**
 * ONE governance:move rung as a table row — `scp governance move-enforcement rungs`, and the
 * per-object chain a `status`/`enable`/`disable` response carries. `depth` is present only on the
 * per-object explain read (0 = org root, increasing toward the object); the org-wide `rungs` list
 * walks no chain, so it prints `-` there rather than fabricating a position.
 */
export function governanceMoveRungRow(rung: GovernanceMoveRung): Record<string, string> {
  return {
    tier: rung.tier,
    subject: rung.name,
    subjectObjectId: rung.subjectObjectId,
    depth: isAbsent(rung.depth) ? "-" : String(rung.depth),
    enabledAt: rung.enabledAt,
    enabledByObjectId: rung.enabledByObjectId
  };
}

/**
 * The verdict line of `scp governance move-enforcement status` — `enforced` is an OR across the
 * instance rung and every rung on the queried object's OWN containment chain. It answers about ONE
 * end of a move; the rungs table printed beside it (`governanceMoveRungRow`) is where "which rung"
 * lives, because the verdict alone cannot say that.
 */
export function governanceMoveEnforcementRow(
  enforcement: GovernanceMoveEnforcement
): Record<string, string> {
  return {
    enforced: String(enforcement.enforced),
    instanceRung: enforcement.instance.enabled ? "enabled" : "disabled",
    rungsOnChain: String(enforcement.rungs.length)
  };
}

/**
 * The instance (commander) rung as a table row (`scp governance move-enforcement instance get|set`)
 * — mirrors `dependencySubscriptionUnlockRow`'s "never set" distinction: `updatedAt: null` is the
 * shipped default (never configured), not "disabled just now".
 */
export function governanceMoveInstanceRow(
  instance: GovernanceMoveInstanceRung
): Record<string, string> {
  return {
    enabled: String(instance.enabled),
    updatedAt: isAbsent(instance.updatedAt) ? "(never set)" : instance.updatedAt
  };
}

/**
 * The response to a rung write (`enable`/`disable`) — the subject, the tier it was recorded at, the
 * resulting enabled state, and the Decision id every governance write carries (charter principle
 * 6). `enforcement` (the resolved state AT THE SUBJECT after the write) is available on the response
 * but not printed here — the caller already knows what it just did; `status` is where the full
 * chain belongs.
 */
export function governanceMoveRungWriteRow(
  response: GovernanceMoveRungWriteResponse
): Record<string, string> {
  return {
    subjectObjectId: response.subjectObjectId,
    tier: response.tier,
    enabled: String(response.enabled),
    decisionId: response.decisionId
  };
}

/**
 * The one line BOTH read verbs print when the answering deployment does not manage dependencies
 * (`dependencyManagement.managedHere === false`, ADR-0032 §7d) — and then print NOTHING ELSE of the
 * envelope: on such a deployment an empty inventory is "nothing here ever ingested a manifest", not
 * "declares nothing", and an empty bump list is "nothing is ever dispatched here", not "up to date",
 * so a table there is a table of a fact that does not exist. `undefined` when dependencies ARE
 * managed here — and ALSO when the server omitted the envelope (`=== false`, never falsy): an older
 * server claims no posture and this must not invent one. Exported and pure so both directions are
 * pinned (`dependency-subscription-cli.test.ts`, `dependency-read-verbs-wire.test.ts`).
 */
export function dependencyReadNotManagedLine(
  managed: { managedHere: boolean; reason: string } | undefined
): string | undefined {
  if (managed?.managedHere !== false) return undefined;
  return `dependencies are not managed on this instance (${managed.reason}) — ask the commander; nothing below would be a statement about this component`;
}

/**
 * The header lines of `scp dependency-subscriptions inventory` (M21.6) — the envelope BEFORE the
 * rows: which component, the ingestion STAMP (M21.7), the newest ingestion Decision, and the
 * component-level ingestion gate. Exported and pure for the reason `cli-absent-formatters.test.ts`
 * records. The caller has ALREADY handled `managedHere: false` (see
 * {@link dependencyReadNotManagedLine}); these lines describe a deployment that manages dependencies.
 *
 * THE STAMP IS THE TRICHOTOMY, PRINTED AS ONE (`ingestion-stamp-repo.ts`): a null stamp is NEVER
 * ATTEMPTED (there is no row, and only a pass writes one); `ok` with 0 rows written is "read fine —
 * no dependencies declared" (the sentence an empty inventory could not earn before the stamp);
 * `partial` / `unreadable` list every manifest with its per-file verdict, because the operator's
 * next action is a file, not a component; `not_enabled` is "the gate was closed; nothing fetched".
 * None of these is inferred from `rows` — the printer reads the stamp and says what it says. A null
 * `lastIngestionDecision` is "no ingestion Decision exists" (never ingested, OR refused as
 * not-enabled / not-addressable / superseded, none of which write one).
 *
 * `componentGate.reason` is a THIRD vocabulary (`enabled | instance_locked |
 * no_enabling_contribution`), distinct from a row's `subscription.reason`; it is printed under its
 * own label so the two are never read as one.
 */
export function dependencyInventoryHeaderLines(
  response: ComponentDependencyInventoryResponse
): string[] {
  const lines: string[] = [];
  lines.push(`component: ${response.component.name} (${response.component.id})`);
  const decision = response.lastIngestionDecision;
  lines.push(dependencyIngestionStampLine(response.ingestion, decision));
  if (isAbsent(decision)) {
    lines.push("last ingestion decision: none on record");
  } else {
    lines.push(
      `last ingestion decision: ${decision.decisionId} first observed ${decision.firstObservedAt}; ` +
        `read [${decision.manifestPathsRead.join(", ")}] absent [${decision.manifestPathsAbsent.join(", ")}] ` +
        `skipped ${decision.skipped.length}` +
        (decision.skipped.length > 0
          ? ` (${decision.skipped.map((s) => `${s.path}: ${s.reason}`).join(", ")})`
          : "")
    );
  }
  const gate = response.componentGate;
  lines.push(
    `component gate: ${gate.reason} (enabled=${String(gate.enabled)}, ${gate.contributions.length} contribution(s))`
  );
  return lines;
}

/** The ingestion stamp as one line — see {@link dependencyInventoryHeaderLines} for the four
 *  readings. `manifests[]` is listed as `repo:path=outcome (detail)`; on `ok` the list is the
 *  receipt of what was read, on `partial`/`unreadable` it is the work list.
 *
 *  `lastIngestionDecision` is consulted ONLY when the stamp is absent: the stamp table (migration
 *  0065) was created without a backfill from the `dependency_inventory_ingestion` Decisions, so a
 *  component ingested before it has a Decision and no stamp — "never attempted" would contradict
 *  the Decision line printed right under it. That case is stated as NOT STAMPED and defers to the
 *  Decision; "never attempted" is printed only when NEITHER is on record. */
export function dependencyIngestionStampLine(
  stamp: ComponentDependencyInventoryResponse["ingestion"],
  lastIngestionDecision?: ComponentDependencyInventoryResponse["lastIngestionDecision"]
): string {
  // `null` AND `undefined` alike: a server that omits the field (predating the stamp) has recorded
  // nothing in the stamp table. With NO Decision either, "never attempted" is the only reading a
  // missing stamp has; with one, the pass ran before the stamp existed and the Decision is the
  // record of it.
  if (isAbsent(stamp)) {
    return isAbsent(lastIngestionDecision)
      ? "ingestion: never attempted"
      : "ingestion: not stamped (ingested before the stamp existed) — see the last ingestion decision below";
  }
  const manifests = stamp.manifests ?? [];
  const files =
    manifests.length > 0
      ? "; manifests: " +
        manifests
          .map((m) => `${m.repo}:${m.path}=${m.outcome}${m.detail ? ` (${m.detail})` : ""}`)
          .join(", ")
      : "";
  const when = `at ${stamp.lastAttemptAt} (${stamp.source})`;
  const detail = isAbsent(stamp.detail) || stamp.detail === "" ? "" : ` — ${stamp.detail}`;
  switch (stamp.outcome) {
    case "ok":
      return stamp.rowsWritten === 0
        ? `ingestion: ok — no dependencies declared (read ${manifests.length} manifest(s)) ${when}${files}`
        : `ingestion: ok ${when}, ${stamp.rowsWritten} row(s) written${files}`;
    case "partial":
      return `ingestion: partial — some manifests could not be read ${when}, ${stamp.rowsWritten} row(s) written${files}`;
    case "unreadable":
      return `ingestion: unreadable — no manifest could be read ${when}, ${stamp.rowsWritten} row(s) written${files}`;
    case "not_enabled":
      return `ingestion: not enabled — the gate was closed, nothing was fetched ${when}${detail}`;
    default:
      // A word this build does not know: print it rather than mislabel it.
      return `ingestion: ${String(stamp.outcome)} ${when}, ${stamp.rowsWritten} row(s) written${files}${detail}`;
  }
}

/**
 * ONE ROW of `scp dependency-subscriptions inventory` (M21.6): one (major line × dependency
 * manifest) declaration with the line's observed head and its resolved dependency subscription.
 *
 * The coordinate is printed VERBATIM (`@acme/lib` is not `acme-lib`; case and punctuation decide
 * which package an opt-out named). `resolvedVersion: null` is "the manifest pins none" and
 * `head.latestVersion: null` is "not observed" — never "nothing newer" — both print `-`, the CLI's
 * absent-value convention. `granularity`/`delivery` are meaningful ONLY when the subscription is
 * enabled, so they are shown only then; an `ignored` contribution (a malformed or unevaluable
 * opt-out that admitted to NEITHER side — it fails OPEN) is surfaced in the REASON column rather
 * than dropped, because hiding it hides exactly the opt-out that silently did not apply.
 */
export function dependencyInventoryRow(
  row: ComponentDependencyInventoryRow
): Record<string, string> {
  const s = row.subscription;
  const ignored = (s.contributions ?? []).filter((c) => c.contributed === "ignored");
  const ignoredNote =
    ignored.length > 0
      ? ` (+${ignored.length} ignored: ${ignored.map((c) => c.ignoredReason ?? "?").join(", ")})`
      : "";
  // `head` is required on the wire, but a printer that reads through an omitted key crashes on the
  // exact row it was asked to show — read it once, guarded, like every other absent-value site.
  const latest = row.head?.latestVersion;
  return {
    ecosystem: row.line.ecosystem,
    coordinate: row.line.coordinate,
    major: row.line.major,
    manifest: row.manifestPath,
    declared: row.declaredVersion,
    resolved: isAbsent(row.resolvedVersion) ? "-" : row.resolvedVersion,
    latest: isAbsent(latest) ? "-" : latest,
    subscription: s.enabled
      ? `enabled (${isAbsent(s.granularity) ? "?" : s.granularity}, ${isAbsent(s.delivery) ? "?" : s.delivery})`
      : "not enabled",
    reason: `${s.reason}${ignoredNote}`
  };
}

/**
 * ONE ROW of `scp dependency-subscriptions bumps` (M21.6): a bump SCP authored for the component.
 *
 * Progress is `pullRequestNumber` (opened), `mergedAt` (the provider confirmed the merge) and the
 * merge Decision's verdict — never the change's `state`, which sits at `proposed` for a bump's
 * whole life. The PR column is `pullRequestUrl` when the server stored one, else `#<number>`; a
 * URL is NEVER composed from `repo` + number (the provider is not known here, and a guessed link is
 * a fabricated record).
 * `mergedAt: null` prints `-`, not "open": the provider has not confirmed a merge, which is all
 * that is known. `delivery` is what the dispatch RESOLVED TO — the first look is always
 * `pull_request` — and `-` when no dispatch Decision is on record.
 */
export function dependencyBumpRow(bump: ComponentDependencyBump): Record<string, string> {
  // THE URL WHEN THE SERVER STORED ONE, ELSE THE NUMBER, ELSE `-`. The URL is the provider's own
  // (`pull_request_url`, M21.7) and is never composed here; a stored URL is the better address of the
  // same PR, so it replaces the number rather than decorating it.
  const pr = !isAbsent(bump.pullRequestUrl)
    ? bump.pullRequestUrl
    : isAbsent(bump.pullRequestNumber)
      ? "-"
      : `#${bump.pullRequestNumber}`;
  return {
    coordinate: bump.line.coordinate,
    "from -> to": `${bump.fromVersion} -> ${bump.toVersion}`,
    manifest: bump.manifestPath,
    pr,
    dispatched: bump.dispatchedAt,
    merged: isAbsent(bump.mergedAt) ? "-" : bump.mergedAt,
    verdict: isAbsent(bump.merge) ? "-" : bump.merge.verdict,
    delivery: isAbsent(bump.delivery) ? "-" : bump.delivery
  };
}

/**
 * One ROW of `scp dependency-producers list` — the declaration NAMED (server-side view, ADR-0032 §7e,
 * dependency-subscription-ui.md §12.6 Q1): the producing component and the declaring principal by
 * name, with the ids beside them so a name is never the only handle. `""` (an id that named no row
 * in the org — see `namesForObjectIds`) prints as the id, never as a blank cell.
 *
 * Exported and unit-tested DIRECTLY, for the reason `cli-absent-formatters.test.ts` records.
 */
export function dependencyProducerListRow(p: DependencyLineProducerView): Record<string, string> {
  return {
    ecosystem: p.ecosystem,
    coordinate: p.coordinate,
    producer: p.producer?.name || p.producerObjectId,
    producerId: p.producerObjectId,
    declaredBy: p.declaredBy?.name || p.declaredByObjectId,
    declaredAt: p.declaredAt
  };
}

/**
 * One LINE of a producer declaration's blast radius (`scp dependency-producers declare|retract`,
 * ADR-0032 §7e).
 *
 * THE THREE COLUMNS THAT ARE NOT DECORATION:
 *
 *  - `subscribers` is the number of components whose repositories this act reaches. It is the whole
 *    reason declaring is a VERB with a report rather than a field write: the operator names one
 *    coordinate and affects a set of repositories the request never mentions.
 *  - `headWas` is what the observed head WAS. Both verbs clear it, and an operator needs to see the
 *    value that was discarded rather than only that something was — a wrong declaration is undone
 *    by re-observing, and knowing `2.7.0` was thrown away is how you know what to look for.
 *  - `headCleared` distinguishes "there was a head and it is gone" from "there was nothing to
 *    clear". Printing only `headWas` would render both as a blank.
 *
 * Exported and unit-tested DIRECTLY, for the reason `cli-absent-formatters.test.ts` records: a
 * mapper written inline in a Commander `.action()` closure is unreachable by any test.
 */
export function dependencyProducerLineRow(
  line: DependencyProducerLineImpact
): Record<string, string> {
  const head = line.headBefore ?? {
    latestVersion: null,
    latestDigest: null,
    latestObservedAt: null
  };
  return {
    major: line.major,
    // `-` and NEVER a blank or "none": absent means NOT OBSERVED, which is not the same claim as
    // "no newer version exists" (ADR-0032 §7's reading of the nullable head).
    headWas: head.latestVersion ?? "-",
    headCleared: String(line.headCleared === true),
    subscribers: String(line.subscribedComponentObjectIds?.length ?? 0),
    // WHO, by name — the same set as `subscribers` counts, named server-side (one batched read,
    // dependency-subscription-ui.md §12.6 Q1). Names, not ids: the operator reading this table is
    // about to affect these teams' repositories, and an id is not a name they can act on. `-`
    // when the server sent no names (an older server, or an empty radius) — never a fabricated
    // list, and never a count that disagrees with `subscribers`.
    subscribedNames: line.subscribedComponents?.map((c) => c.name || c.objectId).join(", ") || "-",
    lineId: line.lineId
  };
}

/**
 * One OPEN bump at the moment of a retraction — a pull request SCP already opened in someone else's
 * repository.
 *
 * IT IS PRINTED BECAUSE SCP WILL NOT CLOSE IT. Retraction stops future triggers only; a dispatched
 * bump has left SCP, and closing it from here would make SCP assert it closed a PR it did not
 * close. This table is the operator's only list of what to go and close by hand, so the URL column
 * prints `-` rather than composing one: `repo` + number is a github.com convention and the row does
 * not record which provider authored the bump.
 */
export function dependencyProducerOpenBumpRow(
  bump: DependencyProducerOpenBump
): Record<string, string> {
  return {
    repo: bump.repo,
    manifest: bump.manifestPath,
    bump: `${bump.fromVersion} -> ${bump.toVersion}`,
    url: bump.pullRequestUrl ?? "-",
    change: bump.changeObjectId
  };
}

/**
 * The sentence a caller must read before believing an empty producer list, and after a write.
 *
 * BOTH ARMS ARE LOAD-BEARING AND BOTH ARE TESTED. On a field outpost `dependency_line_producers` is
 * empty BY DESIGN (declarations live at the commander, ADR-0032 §7d), so an unqualified empty table
 * reads as "nothing is declared" when the truth is "you asked the wrong deployment". On a declared
 * commander the note must be SILENT — a caveat printed on every invocation is one nobody reads,
 * which is how the M21.7 inversion (`dependencyManagementNote`) went green while warning the wrong
 * deployment.
 */
export function dependencyProducerManagementNote(
  managed: { managedHere: boolean; reason: string } | undefined
): string | undefined {
  // `=== false`, never falsy: a server that predates the envelope claims no posture, and asserting
  // one it never claimed is the same fabrication the `-` columns exist to avoid.
  if (managed?.managedHere !== false) return undefined;
  return (
    `NOTE: dependency management does NOT run on this deployment (${managed.reason}), so producer ` +
    `declarations live at the COMMANDER. An empty list here is not evidence that nothing is declared.`
  );
}

/**
 * The whole receipt of a declare or a retract — the table, the note, and the in-flight bumps.
 *
 * IT IS A FUNCTION, NOT INLINE IN TWO `.action()` CLOSURES, for two reasons. The tested one: a
 * printer written inside a Commander action is unreachable by any test, and this one carries the
 * `dryRun` banner and the open-bump table, both of which are conditional and therefore both of
 * which have a silent-wrong arm. The other: declare and retract must print the SAME receipt, and
 * two copies of a receipt are two receipts that drift.
 */
export function printProducerVerbResult(
  response: DependencyLineProducerVerbResponse,
  output: string | undefined
): void {
  if (output === "json") {
    console.log(JSON.stringify(response, null, 2));
    return;
  }
  // FIRST LINE, NOT A FOOTER. An operator who scrolls away after the table must not be able to
  // mistake a dry run for a write, and the blast-radius table below looks identical either way.
  console.log(
    response.dryRun
      ? `DRY RUN — nothing was written. ${response.action} ${response.ecosystem} ${response.coordinate}`
      : `${response.action}d: ${response.ecosystem} ${response.coordinate}` +
          (response.declaration ? ` -> producer ${response.declaration.producerObjectId}` : "")
  );
  console.log("");
  if (response.lines.length === 0) {
    // AN EMPTY BLAST RADIUS IS ORDINARY AND MUST SAY WHY. A producer can be declared before any
    // consumer's manifest has minted a line — that is precisely what per-coordinate grain makes
    // representable — and a bare empty table reads as "the command did nothing".
    console.log(
      "No dependency line exists for this coordinate yet, so the declaration covers zero lines " +
        "today. It applies to every major line minted for the coordinate from now on, which is why " +
        "the declaration is per COORDINATE and not per line."
    );
  } else {
    console.log("BLAST RADIUS (every major line this coordinate covers):");
    printResult(response.lines, "table", (raw) =>
      dependencyProducerLineRow(raw as DependencyProducerLineImpact)
    );
  }
  if (response.openBumpAuthorships.length > 0) {
    console.log("");
    console.log(
      "BUMPS ALREADY IN FLIGHT — SCP does NOT close these. Retraction stops future triggers only; " +
        "an open pull request is another team's to close."
    );
    printResult(response.openBumpAuthorships, "table", (raw) =>
      dependencyProducerOpenBumpRow(raw as DependencyProducerOpenBump)
    );
  }
  const note = dependencyProducerManagementNote(response.dependencyManagement);
  if (note !== undefined) {
    console.log("");
    console.log(note);
  }
}

/**
 * `scp federation outpost reconcile`'s "what this WOULD do" lines — one per live claimant, printed
 * BEFORE the call from the very listing the `?ifClaimant=` token is derived from.
 *
 * WHY THE CLI NEEDS ITS OWN PREVIEW. This verb exists to un-wedge a peer, and the operator who
 * needs it is precisely the one who cannot use the UI (the wedged peer is what the UI fails to
 * render). Without these lines the command went straight to the write with NO read at all: the
 * largest unguarded window of any surface, and no preview whatsoever of a call that can adopt an
 * entered config, discard it, or delete a row this domain authored and JOURNAL that delete
 * downstream.
 *
 * BE HONEST ABOUT WHAT THE TOKEN BUYS HERE. Between this listing and the call is a ~millisecond
 * window, so for the CLI `?ifClaimant=` is a TOCTOU guard — NOT evidence that a human read
 * anything. The informed-consent claim belongs to the UI, where an operator actually reads the
 * preview and confirms. Both are worth having; this one must not be described as consent.
 *
 * THE RANKING IS MIRRORED, NOT AUTHORITATIVE. The server's `byAuthority` is the only thing that
 * decides the outcome; this reproduces its three classes (local-origin > verified replica >
 * unverified shadow, ties in listing order) from the fields the API already publishes
 * (`originIsSelf`, `provenance`). A drifted mirror would mis-PREDICT — which is exactly why the
 * token exists to make a divergence a refusal instead of a surprise.
 */
export function formatReconcilePreviewLines(
  claimants: readonly OutpostConfig[],
  keepObjectId?: string
): string[] {
  if (claimants.length === 0) return ["No live config objects claim this peer."];
  const isShadow = (c: OutpostConfig): boolean =>
    c.originIsSelf !== true && (c.provenance ?? null) === "manual";
  const rank = (c: OutpostConfig): number => (c.originIsSelf === true ? 0 : isShadow(c) ? 2 : 1);
  const ordered = claimants
    .map((c, i) => ({ c, i }))
    .sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i)
    .map((e) => e.c);
  /** Each row's CLASS and what dropping it would mean — the honest fallback for every case where
   *  the survivor is not knowable from this side. */
  const classLines = (): string[] =>
    ordered.map((c) => {
      const at = `${c.objectId} (version ${c.version})`;
      if (isShadow(c)) {
        return `  ${at} — an unverified hand-typed copy: dropping it is a purely local cleanup, invisible to the outpost`;
      }
      if (c.originIsSelf === true) {
        return `  ${at} — THIS DOMAIN AUTHORED it: dropping it is a journaled tombstone that WILL PROPAGATE to the outpost`;
      }
      return `  ${at} — a signature-verified replica: it is never deleted, so a survivor that requires dropping it is refused (409)`;
    });

  let keeper: OutpostConfig;
  if (keepObjectId !== undefined) {
    const named = claimants.find((c) => c.objectId === keepObjectId);
    if (named === undefined) {
      // The server answers 400 for a `keep` that names no live claimant. Say so instead of quietly
      // previewing the DEFAULT outcome, which is not the call about to be made.
      return [
        `--keep ${keepObjectId} names no live claimant of this peer, so the server will refuse this ` +
          `call with a 400. Its live claimants:`,
        ...classLines()
      ];
    }
    keeper = named;
  } else {
    // WITH NO `--keep`, THE SURVIVOR IS ONLY PREDICTABLE WHEN ONE ROW HOLDS THE TOP RANK ALONE. The
    // server breaks a tie inside one authority class by `(created_at, id)`; reconstructing that here
    // and printing it as a prediction is exactly the guess the panel refuses to make
    // (`reconcile-default-indeterminate`), and a preview that MIGHT be wrong is worse than no
    // preview — the whole value of these lines is that they say what WILL happen.
    const top = ordered.filter((c) => rank(c) === rank(ordered[0]!));
    if (top.length > 1) {
      return [
        `${claimants.length} live config object(s) claim this peer and ${top.length} of them hold the ` +
          `SAME authority — which one survives is decided by the server's creation order, so this side ` +
          `will not guess. Re-run with --keep <objectId>. Each row's class and the consequence of ` +
          `dropping it:`,
        ...classLines()
      ];
    }
    keeper = ordered[0]!;
  }

  const lines = [`${claimants.length} live config object(s) claim this peer; reconcile would:`];
  for (const c of ordered) {
    const at = `${c.objectId} (version ${c.version})`;
    if (c.objectId === keeper.objectId) {
      lines.push(
        isShadow(c)
          ? `  ADOPT  ${at} — an unverified hand-filled shadow becomes THIS DOMAIN'S OWN object, and from then on it JOURNALS DOWN to the outpost`
          : `  KEEP   ${at} — ${c.originIsSelf === true ? "this domain authored it" : "a signature-verified replica this domain did not author"}`
      );
      continue;
    }
    if (isShadow(c)) {
      lines.push(
        `  REMOVE ${at} — an unverified hand-typed copy this domain never authored: a purely local cleanup, invisible to the outpost`
      );
      continue;
    }
    if (c.originIsSelf === true) {
      lines.push(
        `  DELETE ${at} — a row THIS DOMAIN AUTHORED: an ordinary journaled tombstone that WILL PROPAGATE to the outpost`
      );
      continue;
    }
    lines.push(
      `  REFUSE ${at} — a signature-verified replica: reconcile never deletes one, so this call will be refused (409)`
    );
  }
  return lines;
}

/** `scp federation outpost reconcile`'s "what happened" lines (review round 6, M1). The two removal
 *  buckets on `OutpostConfigReconcileResult` are reported with DELIBERATELY DIFFERENT WORDING, and must
 *  stay that way: `removedShadowObjectIds` is a silent local tidy-up of a hand-typed copy this domain
 *  never authored (invisible to the outpost), while `removedLocalObjectIds` is THIS DOMAIN'S OWN declared
 *  config being permanently deleted — an ordinary journaled tombstone that PROPAGATES DOWNSTREAM to the
 *  outpost. Collapsing the two into one "unverified shadow(s)" sentence (the N9-era bug this fixes) told
 *  an operator who had just deleted their own config, and pushed that delete to the outpost, that they
 *  had merely cleaned up a stray copy. Exported so the CLI surface test can pin the wording gap directly
 *  rather than only via the command's `--keep` help text.
 *
 *  `?? []` ON BOTH BUCKETS (Z4). Both are required-not-optional on `OutpostConfigReconcileResultSchema`
 *  and BEFORE ADR-0023 the SDK validated no response, so both were bare `.length`/`.join` reads
 *  (since ADR-0023 that body rejects at the boundary). MEASURED: `TypeError:
 *  Cannot read properties of undefined (reading 'length')`. This is the WORST place in the CLI for it —
 *  the operator has just run a DESTRUCTIVE, DOWNSTREAM-PROPAGATING verb and the throw kills the entire
 *  report of what it did, so they are told NOTHING about deletes that already happened and already
 *  journaled. The web twin (`outpost-configuration.tsx`) took this guard last round for exactly that
 *  reason; the CLI half was left bare.
 *
 *  Absence degrades to "Removed: nothing (no surplus rows)" only when BOTH are empty-or-absent, which is
 *  the same line an all-empty result already printed. That is a reporting gap, not a fabrication: it says
 *  nothing about what the server did, and the server's own JSON is one `--output json` away. */
export function formatReconcileResultLines(result: OutpostConfigReconcileResult): string[] {
  const removedShadowObjectIds = result.removedShadowObjectIds ?? [];
  const removedLocalObjectIds = result.removedLocalObjectIds ?? [];
  const lines: string[] = [
    isAbsent(result.adoptedObjectId)
      ? "Adopted: nothing (an authoritative row already held the binding)"
      : `Adopted: ${result.adoptedObjectId} (an unverified hand-filled shadow is now this domain's own object)`
  ];
  if (removedShadowObjectIds.length === 0 && removedLocalObjectIds.length === 0) {
    lines.push("Removed: nothing (no surplus rows)");
    return lines;
  }
  if (removedShadowObjectIds.length > 0) {
    lines.push(
      `Removed ${removedShadowObjectIds.length} unverified shadow(s) (hand-typed copies this ` +
        `domain never authored — a purely local cleanup, invisible to the outpost): ` +
        `${removedShadowObjectIds.join(", ")}`
    );
  }
  if (removedLocalObjectIds.length > 0) {
    lines.push(
      `Deleted ${removedLocalObjectIds.length} row(s) THIS DOMAIN AUTHORED to resolve a --keep ` +
        `conflict (an ordinary journaled tombstone — this WILL propagate to the outpost): ` +
        `${removedLocalObjectIds.join(", ")}`
    );
  }
  return lines;
}

// -------------------------------------------------------------------------------------
// M4 Governance Engine (BUILD_AND_TEST.md §8 M4, DESIGN.md §10) — row formatters for
// approvals/freezes; policies/controls reuse `objectRow` (they're typed-registry resources).
// -------------------------------------------------------------------------------------

function approvalRow(a: ApprovalRequest): Record<string, string> {
  return {
    id: a.id,
    changeObjectId: a.changeObjectId,
    fromRole: a.fromRole,
    votes: `${a.voteCount}/${a.requiredCount}`,
    status: a.status,
    createdAt: a.createdAt
  };
}

function approvalVoteRow(v: ApprovalVote): Record<string, string> {
  return {
    id: v.id,
    voterObjectId: v.voterObjectId,
    votedAt: v.votedAt,
    signature: `${v.attestation.signature.slice(0, 16)}...`
  };
}

function freezeRow(f: Freeze): Record<string, string> {
  return {
    id: f.id,
    scopeObjectId: f.scopeObjectId,
    name: f.name ?? "",
    startsAt: f.startsAt,
    endsAt: f.endsAt,
    reason: f.reason,
    // D5: whether this freeze parks the whole wave or only what it covers is the single most
    // consequential thing about it, so it is on the default table row rather than json-only.
    atomic: String(f.atomic),
    // M25.1 — on the DEFAULT row, not json-only, because `scp freeze list` returns lifted freezes
    // too (they stay readable forever so a Decision citing one resolves) and a retracted freeze
    // that renders identically to a live one is a list an operator cannot act on. Empty means
    // still standing.
    liftedAt: f.liftedAt ?? ""
  };
}

function printPolicyEvaluateResult(result: PolicyEvaluateResponse, output: OutputFormat): void {
  if (output === "json") {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Verdict: ${result.verdict}`);
  const summary =
    typeof result.reasonTree["summary"] === "string"
      ? (result.reasonTree["summary"] as string)
      : JSON.stringify(result.reasonTree);
  console.log(summary);
}

// -------------------------------------------------------------------------------------
// `@scp/iac` plan/apply (BUILD_AND_TEST.md §8 M2 item 4) — `scp plan` computes a diff
// (dry run); `scp apply` does plan + apply in one shot, since that's the natural CLI UX and
// what "`scp apply` twice = no-op the second time" means end to end, not two manual steps.
// -------------------------------------------------------------------------------------

async function readManifestFile(manifestPath: string): Promise<DesiredStateManifest> {
  const raw = await readFile(manifestPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `--manifest '${manifestPath}' is not valid JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  return DesiredStateManifestSchema.parse(parsed);
}

/**
 * One `source_mappings` row as a table row (`scp change-source list-mappings`), lifted out of the
 * action closure and exported for the reason `federationStatusRow` gives. Column order is the order an
 * operator reads a rule in: what routes where, then the labels on it. `scope` (§10.6, migration 0066)
 * prints BLANK when not declared — the printer's absent-field convention, and the honest one: no
 * label was set, and nothing here guesses one from the site's role. `?` when the key is ABSENT
 * (absence is not "undeclared") — DEFENSIVE ONLY: `scope` is required-nullable on the wire and the
 * generated SDK validates every response body (ADR-0023), so a pre-0066 server's body is a contract
 * error at the SDK boundary and never reaches this printer; what an operator actually sees against
 * such a server is that error, not `?`. The widening stays so a hand-built row cannot crash the table
 * (the `outpostConfigRow` lesson above), not because the `?` is reachable through the SDK.
 */
export function sourceMappingRow(m: SourceMapping): Record<string, string> {
  // Widened on purpose (defensive, see above): the SDK type AND its response validator say `scope`
  // is required, so through the SDK it is never absent — read it as possibly-absent anyway so a row
  // that arrives without it prints `?`, not a crash or a blank.
  const scope = (m as { scope?: SourceMappingScope | null }).scope;
  return {
    id: m.id,
    sourceKind: m.sourceKind,
    component: m.componentObjectId,
    repo: m.repoPattern ?? "*",
    path: m.pathPattern ?? "*",
    ref: m.refPattern ?? "*",
    type: m.type,
    classification: m.classification ?? "",
    scope: scope === undefined ? "?" : (scope ?? ""),
    mirrorOfShared: String(m.mirrorOfShared),
    enabled: String(m.enabled),
    effectivelyEnabled: String(m.effectivelyEnabled),
    disabledUntil: m.disabledUntil ?? ""
  };
}

/** Parses a `--scope` flag value: `global` | `domain`, or `none` to CLEAR (`null`). Anything else is
 *  a usage error naming the accepted values — never silently dropped as undeclared. */
export function parseScopeFlag(value: string): SourceMappingScope | null {
  if (value === "none") return null;
  const parsed = SourceMappingScopeSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`--scope must be one of global|domain|none (got '${value}')`);
  }
  return parsed.data;
}

/**
 * EVERY collection `computePlanDiff` can emit, and the union is the point: a collection that is
 * computed, counted in `summary`, but missing here is a change the operator approves without ever
 * being shown it. `printPlanResult` spreads all of them, and the `never` arm below is what makes
 * "add a collection, forget the table" a TYPE ERROR rather than a silent omission — which is how
 * `placements`, `producers` and `governanceMoveRungs` each went unprinted for a while.
 */
type PlanDiffEntry =
  | PlanObjectDiffEntry
  | PlanRelationshipDiffEntry
  | PlanSourceMappingDiffEntry
  | PlanPlacementDiffEntry
  | PlanExecutorBindingDiffEntry
  | PlanDependencyProducerDiffEntry
  | PlanGovernanceMoveRungDiffEntry;

/** Every branch returns the SAME four keys in the same order — `tableLines` takes its columns from
 *  the FIRST row only, so a branch with a different key set prints blanks for every later row. */
export function diffEntryRow(entry: PlanDiffEntry): Record<string, string> {
  if (entry.kind === "object") {
    return { kind: "object", action: entry.action, ref: entry.urn, reason: entry.reason };
  }
  if (entry.kind === "relationship") {
    return {
      kind: "relationship",
      action: entry.action,
      ref: `${entry.fromUrn} --${entry.typeId}--> ${entry.toUrn}`,
      reason: entry.reason
    };
  }
  if (entry.kind === "source-mapping") {
    // The ref is part of the mapping IDENTITY (ADR-0030 §1), so it MUST appear here: two mappings
    // differing only by ref render identically without it, and a prune whose ref the plan did not
    // show is a prune the operator cannot check.
    const glob = [entry.repoPattern ?? "*", entry.pathPattern ?? "*", entry.refPattern ?? "*"].join(
      ":"
    );
    return {
      kind: "source-mapping",
      action: entry.action,
      ref: `${entry.sourceKind}:${glob} --${entry.type}--> ${entry.componentUrn}`,
      reason: entry.reason
    };
  }
  if (entry.kind === "executor-binding") {
    const module =
      entry.target?.executionSystemId != null
        ? `execution-system ${entry.target.executionSystemId}`
        : (entry.target?.pluginModule ?? "-");
    return {
      kind: "executor-binding",
      action: entry.action,
      ref: `${entry.targetUrn} (${entry.type}) -> ${module}`,
      reason: entry.reason
    };
  }
  if (entry.kind === "placement") {
    return {
      kind: "placement",
      action: entry.action,
      ref: `${entry.componentUrn} @ ${entry.deploymentTargetUrn}`,
      reason: entry.reason
    };
  }
  if (entry.kind === "dependency-producer") {
    // The DISPLACED producer is this entry's most consequential fact — an `update` takes a
    // coordinate away from a component the manifest never mentions — so it belongs in the row an
    // operator approves, not only in `--output json`.
    const displaced =
      entry.displacedProducerUrn === undefined
        ? ""
        : ` (taking it from ${entry.displacedProducerUrn})`;
    return {
      kind: "dependency-producer",
      action: entry.action,
      ref: `${entry.ecosystem}:${entry.coordinate} -> ${entry.producerUrn}${displaced}`,
      reason: entry.reason
    };
  }
  if (entry.kind === "governance-move-rung") {
    // A `delete` here DISABLES a governance bar, and a disabled bar's symptom is an ABSENCE of
    // refusals — nothing downstream surfaces the mistake, so the plan table is the only place an
    // operator can catch it. Hence the action is spelled out in words as well as in the column.
    const act =
      entry.action === "create"
        ? "enable"
        : entry.action === "delete"
          ? "DISABLE"
          : "already enabled";
    return {
      kind: "governance-move-rung",
      action: entry.action,
      ref: `${act} governance:move enforcement on ${entry.subjectUrn}`,
      reason: entry.reason
    };
  }
  // Unreachable for any kind the union knows — the `never` binding turns a NEW collection into a
  // compile error here. The runtime row exists anyway because entries are parsed off the wire: an
  // older CLI reading a newer server's plan must show the row as UNKNOWN rather than mislabel it
  // (this fall-through used to print every unknown kind as "relationship" with undefined refs).
  const unknown: never = entry;
  const wire = unknown as { kind?: unknown; action?: unknown; reason?: unknown };
  return {
    kind: `unknown(${String(wire.kind)})`,
    action: String(wire.action ?? ""),
    ref: "(this CLI does not know this entry kind — use --output json)",
    reason: String(wire.reason ?? "")
  };
}

/**
 * EVERY collection the diff can carry, flattened into the rows `scp plan` prints. Exported so the
 * "nothing computed is invisible" property is testable without capturing stdout.
 *
 * All but the first two are optional on the wire (a plan stored before the collection existed has
 * no key; for `producers` and `governanceMoveRungs` an absent key additionally means "this stack
 * manages none") — but every one that IS present must be PRINTED, or a plan whose only content is
 * bindings, placements, producers or rungs shows an EMPTY table under a NON-ZERO summary, and an
 * operator approves a diff they were never shown. Sharpest for a rung `delete`: it turns off a
 * governance bar whose only symptom is an absence of refusals, so no later signal catches it.
 */
export function planDiffEntries(diff: PlanDiff): PlanDiffEntry[] {
  return [
    ...diff.objects,
    ...diff.relationships,
    ...(diff.sourceMappings ?? []),
    ...(diff.placements ?? []),
    ...(diff.executorBindings ?? []),
    ...(diff.producers ?? []),
    ...(diff.governanceMoveRungs ?? [])
  ];
}

function summaryLine(summary: PlanDiffSummary): string {
  return `creates=${summary.creates} updates=${summary.updates} deletes=${summary.deletes} noops=${summary.noops}`;
}

/** Prints a plan (full diff with per-entry reasons) — `scp plan` and `scp plan-status`. */
function printPlanResult(plan: Plan, output: OutputFormat): void {
  if (output === "json") {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  printResult(planDiffEntries(plan.diff), "table", (item) => diffEntryRow(item as PlanDiffEntry));
  console.log(
    `\nPlan ${plan.id} (${plan.stackName}, status: ${plan.status}): ${summaryLine(plan.diff.summary)}`
  );
}

/**
 * Prints an apply summary — `--output json` gives a flat, machine-parseable
 * `{creates,updates,deletes,noops}` shape (not just prose), which is what makes DoD (b)'s
 * "`scp apply` twice = no-op" assertable from a test (plans.cli.integration.test.ts).
 */
function printApplyResult(plan: Plan, summary: PlanDiffSummary, output: OutputFormat): void {
  if (output === "json") {
    console.log(
      JSON.stringify(
        {
          planId: plan.id,
          stackName: plan.stackName,
          status: plan.status,
          creates: summary.creates,
          updates: summary.updates,
          deletes: summary.deletes,
          noops: summary.noops
        },
        null,
        2
      )
    );
    return;
  }
  console.log(`Applied plan ${plan.id} (${plan.stackName}): ${summaryLine(summary)}`);
}

/**
 * Renders a Change's coupled-pipeline wait status (M12 P4B) — the shared body of `scp change
 * explain` (embedded, alongside plan/Decisions) and `scp change wait-status` (standalone). `null`
 * means the change declared no `requires`; a `wait-status` caller wants an explicit line for that
 * case (there is nothing else on the screen to say so), `explain` silently omits the section
 * instead (unchanged since Phase 4's `explain` support landed) — hence the `standalone` flag.
 */
function printWaitStatusBody(waitStatus: ChangeWaitStatus | null, standalone: boolean): void {
  if (!waitStatus) {
    if (standalone)
      console.log("(no coupled-pipeline prerequisites — this change declared no `requires`)");
    return;
  }
  const outstanding = waitStatus.requirements.filter((r) => !r.satisfied).length;
  // Derived from `outstanding`, not `waitStatus.waiting` alone: `waiting` reflects the change's
  // STATE (`state === "waiting"`), which is false for a change read before it ever parked (still
  // `coordinated`/`proposed`) or after it released (`executing`/`validating`/`accepted`) — either
  // of which can still have an outstanding row (a not-yet-evaluated requirement, or a provider
  // that was cancelled after release). Heading off `waiting` alone would print "all satisfied"
  // over a row printing OUTSTANDING.
  const header =
    outstanding > 0
      ? `Waiting on ${outstanding} of ${waitStatus.requirements.length} prerequisite(s):`
      : `Coupled prerequisites (${waitStatus.requirements.length}, all satisfied):`;
  console.log(standalone ? header : `\n${header}`);
  for (const req of waitStatus.requirements) {
    const at = req.atName ? `${req.atName} (${req.at})` : req.at;
    const mark = req.satisfied ? `satisfied by change ${req.satisfiedByChangeId}` : "OUTSTANDING";
    console.log(`  - ${req.key} @ ${at}: ${mark}`);
    // "Did you mean?" (coupled-pipelines.md §3.7): only ever present on an outstanding requirement.
    if (req.didYouMean && req.didYouMean.length > 0) {
      console.log(`      did you mean one of: ${req.didYouMean.join(", ")}?`);
    }
  }
  if (waitStatus.malformed && waitStatus.malformed.length > 0) {
    console.log(
      `  malformed requires entries (unsatisfiable — fix and re-propose): ${JSON.stringify(waitStatus.malformed)}`
    );
  }
}

/**
 * ADR-0028 increment 4 — a Change's STAGE-DEPENDENCY status, the second and deliberately separate
 * section of `scp change explain` and `scp change wait-status`.
 *
 * WHY A SIBLING SECTION AND NOT A WIDENING OF `printWaitStatusBody`. The two couplings answer
 * different questions and are keyed differently: `requires` is `{key, at}` and parks the WHOLE change
 * in `waiting`, whereas a stage dependency is (component x deployment-target) and withholds ONE wave
 * target's trigger while the change stays `executing`. A change can be in either, both or neither.
 * The server made the same call one layer up — `stageDependencyStatus` is a sibling field on
 * `explain`, not a widening of `waitStatus`, whose `requirements[]` shape two consumers already read.
 *
 * EXPORTED, AND RETURNING LINES INSTEAD OF PRINTING THEM, for the reason `cli-absent-formatters.test.ts`
 * sets out at length: a renderer that is module-private — or worse, inline in a Commander `.action()`
 * closure — is unreachable by any test, and every one of the ten guards that survived last round's
 * mutation sweep lived in exactly that position. This is the surface an operator reads at 2am; it is
 * pinned directly.
 *
 * EVERY FIELD HERE IS LIVE. The server re-runs reconcile's own predicate per request rather than
 * reading back the pinned `stage_dependency` Decision — which is never cleared when a hold releases,
 * and whose kind ALSO carries a promotion-import `allow`. So "HELD" below means held right now, and
 * stops saying so the moment the dependency lands, with no clearing row to wait for.
 */
export function formatStageDependencyLines(
  status: ChangeStageDependencyStatus | null | undefined,
  standalone: boolean
): string[] {
  // THE TWO ABSENCES ARE DIFFERENT CLAIMS AND ARE NOT COLLAPSED (which is why this does not reach for
  // `isAbsent`, whose job is the opposite — to stop the two being told apart *by accident*). `null`
  // is the server saying "this change coupled nothing"; an omitted key is the server saying nothing
  // at all, which is contract-legal for an `.optional()` field and is exactly what a pre-increment-4
  // server puts on the wire. Printing "coupled nothing" for the second would be a fabricated
  // observation about a change that may well be held.
  if (status === undefined) {
    return standalone
      ? ["(no stage-dependency status reported — this server predates ADR-0028 increment 4)"]
      : [];
  }
  if (status === null) {
    return standalone ? ["(no stage dependencies — this change coupled nothing at any stage)"] : [];
  }

  const wave = status.waveIndex === null ? "no active wave" : `wave ${status.waveIndex}`;
  const held = status.targets.filter((target) => target.held);
  // Only UNTRIGGERED targets of the active wave are evaluated at all (a target already handed to its
  // executor is past the hold), so the denominator is named for what it is rather than left to read
  // as "the change's targets".
  const lines: string[] =
    status.targets.length === 0
      ? [`Stage dependencies (ADR-0028, ${wave}): no wave target is awaiting a trigger.`]
      : held.length > 0
        ? [
            `Stage dependencies (ADR-0028, ${wave}) — HELD at ${held.length} of ` +
              `${status.targets.length} untriggered wave target(s):`
          ]
        : [
            `Stage dependencies (ADR-0028, ${wave}) — ${status.targets.length} untriggered wave ` +
              `target(s), none held:`
          ];

  for (const target of status.targets) {
    lines.push(`  - ${describeStageDependencyPlace(target)}: ${target.held ? "HELD" : "clear"}`);
    for (const dependency of target.dependencies) {
      // The name and the branch, then the server's own sentence verbatim. Verbatim because it is the
      // SAME `describeStageDependencyHold` output the hold Decision's `reasonTree` is built from:
      // re-wording it here would let the CLI and the audit record describe one verdict two ways.
      lines.push(
        `      - ${stageDependencyMark(dependency)} [${dependency.branch}] ` +
          `${dependency.dependsOnName ?? "(unresolved)"}: ${dependency.summary}`
      );
    }
  }

  if (status.unenforced) {
    lines.push(
      "  NOT ENFORCED: a declared coupling had no place to scope by (its wave target names a " +
        "component, not a placement), so it was not applied — see `scp decision list --kind " +
        "stage_dependency_unscoped`."
    );
  }
  return lines;
}

/** Where a wave target sits, for the target line above. BOTH halves null is the `unscopeable`
 *  fail-open — a legacy-shaped target naming a component rather than a placement — and it is said
 *  outright rather than rendered as a place called `null`. */
function describeStageDependencyPlace(target: ChangeStageDependencyTarget): string {
  const component = target.componentName ?? target.componentObjectId;
  const place = target.deploymentTargetName ?? target.deploymentTargetObjectId;
  if (isAbsent(component) || isAbsent(place)) {
    return (
      `${target.targetName ?? target.targetObjectId} (no placement — this wave target names a ` +
      `component, so there is no stage to scope a hold by)`
    );
  }
  return `${component} @ ${place}`;
}

/** THE ONE PLACE THE WIRE'S `satisfied` IS NOT TAKEN AT FACE VALUE. `unscopeable` carries
 *  `satisfied: true` because the release proceeds — but nothing was checked, and printing "satisfied"
 *  would tell an operator their coupling held when it was never applied. ADR-0028 gave that case its
 *  own branch precisely so the fail-open would be findable; this is the CLI honouring that. */
function stageDependencyMark(dependency: ChangeStageDependencyVerdict): string {
  if (!dependency.satisfied) return "HELD";
  return dependency.branch === "unscopeable" ? "NOT ENFORCED" : "satisfied";
}

/** The printing half of `formatStageDependencyLines` — shared by `explain` (embedded) and
 *  `wait-status` (standalone). The blank separator is unconditional because this section is never
 *  first on the screen: `explain` has printed the change line above it, and `wait-status` has printed
 *  the `requires` section, which always emits at least its "(no coupled-pipeline prerequisites)"
 *  line. `standalone` therefore governs only whether an ABSENT status is worth a line of its own. */
function printStageDependencyBody(
  status: ChangeStageDependencyStatus | null | undefined,
  standalone: boolean
): void {
  const lines = formatStageDependencyLines(status, standalone);
  if (lines.length === 0) return;
  console.log("");
  for (const line of lines) console.log(line);
}

/**
 * Prints a Change's compiled plan (waves/targets) and every Decision made about it, in order —
 * the CLI's window into the coordination engine's reasoning (BUILD_AND_TEST.md §8 M3 DoD:
 * "`scp change explain` renders" the Decision record). Deviates from `printResult`/`printTable`
 * (which assume flat rows), same as `printPlanResult`/`printApplyResult` above and for the same
 * reason — this shape (a change, an optional plan tree, an ordered decision list) isn't a table.
 */
function printExplainResult(result: ChangeExplainResponse, output: OutputFormat): void {
  if (output === "json") {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const { change, plan, decisions, controlRuns, waitStatus } = result;
  console.log(`Change ${change.id} '${change.name}' — state: ${change.state}`);

  // M12 P4B: coupled-pipeline wait status. Present only for a change that declared `requires`.
  printWaitStatusBody(waitStatus, false);
  // ADR-0028 increment 4: the stage-dependency status, printed BEFORE the plan below deliberately —
  // it is the reason a wave target in that plan is sitting at `pending`, and reading the explanation
  // after the symptom is how the hold stayed invisible until this increment.
  printStageDependencyBody(result.stageDependencyStatus, false);

  if (plan) {
    console.log(`\nPlan ${plan.id} (status: ${plan.status}):`);
    for (const wave of plan.waves) {
      const label = wave.name ? `${wave.waveIndex} (${wave.name})` : String(wave.waveIndex);
      console.log(`  Wave ${label} — ${wave.status}`);
      for (const target of wave.targets) {
        const ref = target.targetUrn ?? target.targetName ?? target.targetObjectId;
        console.log(`    - ${ref}: ${target.status}`);
      }
    }
  } else {
    console.log("\n(no plan compiled yet)");
  }

  console.log(`\nDecisions (${decisions.length}):`);
  for (const decision of decisions) {
    const summary =
      typeof decision.reasonTree["summary"] === "string"
        ? (decision.reasonTree["summary"] as string)
        : JSON.stringify(decision.reasonTree);
    console.log(`  [${decision.createdAt}] ${decision.kind} -> ${decision.verdict}: ${summary}`);
  }

  // DESIGN §10.4 / BUILD_AND_TEST M4 flagship E2E: "explain reconstructs policy version + control
  // outcome + evidence" — the Decisions above already carry policy version + outcome status
  // (reasonTree.policies[].contributingPolicyVersions / effects[].detail), but the actual evidence
  // payload only ever lives on the control_run row itself, joined by controlObjectId.
  if (controlRuns.length > 0) {
    console.log(`\nControl runs (${controlRuns.length}):`);
    for (const run of controlRuns) {
      console.log(
        `  [${run.createdAt}] control ${run.controlObjectId} -> ${run.status}${run.detail ? `: ${run.detail}` : ""}`
      );
      if (Object.keys(run.evidence).length > 0) {
        console.log(`    evidence: ${JSON.stringify(run.evidence)}`);
      }
    }
  }
}

/**
 * Prints a Campaign's compiled plan (waves/targets, each resolved to its member Change) and every
 * Decision made about it — the campaign-scoped analogue of `printExplainResult` above (M5,
 * DESIGN.md §9.5). Same shape deviation from `printResult`/`printTable` and for the same reason.
 */
function printCampaignExplainResult(result: CampaignExplainResponse, output: OutputFormat): void {
  if (output === "json") {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const { campaign, plan, decisions } = result;
  console.log(`Campaign ${campaign.id} '${campaign.name}' — status: ${campaign.status}`);

  if (plan) {
    console.log(`\nPlan ${plan.id} (status: ${plan.status}):`);
    for (const wave of plan.waves) {
      const label = wave.name ? `${wave.waveIndex} (${wave.name})` : String(wave.waveIndex);
      console.log(`  Wave ${label} — ${wave.status}`);
      for (const target of wave.targets) {
        const ref = target.targetUrn ?? target.targetName ?? target.targetObjectId;
        console.log(
          `    - ${ref}: ${target.status}${target.memberChangeObjectId ? ` (change ${target.memberChangeObjectId})` : ""}`
        );
      }
    }
  } else {
    console.log("\n(no plan compiled yet)");
  }

  console.log(`\nDecisions (${decisions.length}):`);
  for (const decision of decisions) {
    const summary =
      typeof decision.reasonTree["summary"] === "string"
        ? (decision.reasonTree["summary"] as string)
        : JSON.stringify(decision.reasonTree);
    console.log(`  [${decision.createdAt}] ${decision.kind} -> ${decision.verdict}: ${summary}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Drives the CLI side of the device authorization flow (BUILD_AND_TEST.md §8 M2 item 3): starts
 * the request, prints the code+URL for the human to open in a browser, then polls at the
 * server-suggested interval until a token, a denial, or expiry — capping total wait at the
 * request's own `expiresIn`. `authorization_pending` is expected/normal while the human hasn't
 * approved yet; every other device-flow error code is terminal.
 */
async function deviceLogin(
  client: ScpClient
): Promise<{ token: string; expiresAt: string; org: string }> {
  const started = await client.deviceFlow.start();
  console.log(`Open ${started.verificationUri} and enter code ${started.userCode}`);
  console.log("Waiting for approval...");

  const deadline = Date.now() + started.expiresIn * 1000;
  while (Date.now() < deadline) {
    await sleep(started.interval * 1000);
    try {
      return await client.deviceFlow.poll(started.deviceCode);
    } catch (err) {
      const code =
        err instanceof ScpApiError && err.problem && "error" in err.problem
          ? (err.problem as { error?: string }).error
          : undefined;
      if (code === "authorization_pending") continue;
      if (code === "expired_token") {
        throw new Error("device authorization request expired — run `scp login --device` again");
      }
      if (code === "access_denied") throw new Error("device authorization request was denied");
      throw err;
    }
  }
  throw new Error("device authorization timed out waiting for approval");
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
  resourceOf: (client: ScpClient) => TypedResourceOps,
  opts?: { serviceOption?: boolean }
): Command {
  const cmd = program.command(name).description(`Manage ${name} objects`);

  // `component` create is strict: it MUST name an owning service (M12 P5a). Only that resource sets
  // `serviceOption`, mirroring the server's bespoke `POST /components` (a component always belongs to
  // a service — the CLI carries `--service` through to `CreateComponentRequest.service`).
  const registerCmd = cmd
    .command("register")
    .description(`Create a ${name}`)
    .requiredOption("--name <name>", `${name} name`);
  if (opts?.serviceOption) {
    registerCmd.requiredOption(
      "--service <idOrUrn>",
      // "or assembly" since migration 0055: the server checks `isContainerType`, so this flag has
      // always accepted whatever a container is — the help text was the only thing still saying
      // service. A flag whose help contradicts what the server accepts is a support ticket.
      `containing service or assembly id or URN (a ${name} belongs to one)`
    );
  }
  registerCmd
    .option("--id <uuid>", "client-suppliable UUIDv7 id")
    .option("--urn <urn>", "explicit URN (defaults to a derived one)")
    .option("--domain-id <id>", "containing object id (defaults to the org root)")
    // M20.1 (ADR-0031). Named `--domain-local` after the property, never after what it is FOR
    // ("--private", "--no-sync"): the flag has to keep meaning the same thing when the reason for
    // reaching for it changes. Requires `federation:write`, not merely object-write authority.
    .option(
      "--domain-local",
      "declare that this object never leaves its security domain (requires federation:write; IMMUTABLE once set — see `publish`)"
    )
    .option("--properties <json>", "JSON object")
    .option("--labels <json>", "JSON object")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (
        cmdOpts: BaseCliOpts & {
          name: string;
          service?: string;
          id?: string;
          urn?: string;
          domainId?: string;
          domainLocal?: boolean;
          properties?: string;
          labels?: string;
        }
      ) => {
        const client = await clientFromStoredCredentials(cmdOpts);
        // `service` is only present when `serviceOption` is set (component); it rides through the
        // request body to `CreateComponentRequest.service` (SDK sends the whole body). The cast is
        // needed because the shared `TypedResourceOps.create` is typed to the base request.
        const created = await resourceOf(client).create(
          {
            name: cmdOpts.name,
            id: cmdOpts.id,
            urn: cmdOpts.urn,
            domainId: cmdOpts.domainId,
            // Only sent when the flag is actually present. Commander omits a boolean flag entirely
            // rather than defaulting it to `false`, and sending an explicit `false` would be a
            // needless request-body difference on every ordinary create.
            ...(cmdOpts.domainLocal ? { domainLocal: true } : {}),
            properties: parseJsonOption(cmdOpts.properties, "--properties"),
            labels: parseJsonOption(cmdOpts.labels, "--labels"),
            ...(opts?.serviceOption ? { service: cmdOpts.service } : {})
          } as CreateObjectRequest,
          { idempotencyKey: randomUUID() }
        );
        printResult(created, cmdOpts.output, (item) => objectRow(item as GraphObject));
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

  const upsertCmd = cmd
    .command("upsert <urn>")
    .description("Idempotent upsert-by-URN")
    .requiredOption("--name <name>");
  if (opts?.serviceOption) {
    // Optional here (not required): the server needs `--service` only on the CREATE branch (a URN
    // that doesn't exist yet); updating an existing component ignores it (re-assignment is P5b's
    // move verb). Omitting it while creating gets a clear 400 from the server.
    upsertCmd.option(
      "--service <idOrUrn>",
      "owning service id or URN (required when this URN is new)"
    );
  }
  upsertCmd
    // M20.1 (ADR-0031 §6) — a DECLARATION on the create branch and a PRECONDITION on the update
    // branch. Accepted here so the declaration keeps IaC parity (`scp apply` reaches the graph
    // through this upsert); on an existing object a matching value is an idempotent no-op and a
    // differing one is refused 409, because locality is immutable.
    .option(
      "--domain-local",
      "declare locality when this URN is new; on an existing object it is a precondition, not a change (409 if it differs)"
    )
    .option("--properties <json>", "JSON object")
    .option("--labels <json>", "JSON object")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (
        urn: string,
        cmdOpts: BaseCliOpts & {
          name: string;
          service?: string;
          domainLocal?: boolean;
          properties?: string;
          labels?: string;
        }
      ) => {
        const client = await clientFromStoredCredentials(cmdOpts);
        const result = await resourceOf(client).upsertByUrn(urn, {
          name: cmdOpts.name,
          ...(cmdOpts.domainLocal ? { domainLocal: true } : {}),
          properties: parseJsonOption(cmdOpts.properties, "--properties"),
          labels: parseJsonOption(cmdOpts.labels, "--labels"),
          ...(opts?.serviceOption ? { service: cmdOpts.service } : {})
        } as UpsertObjectRequest);
        printResult(result, cmdOpts.output, (item) => objectRow(item as GraphObject));
      }
    );

  // M20.4 (ADR-0031 §6). A VERB, matching the API — deliberately NOT `update --no-domain-local`,
  // because it re-journals the object and sweeps its edges rather than editing a field, and the
  // command name is where an operator first learns that.
  cmd
    .command("publish <idOrUrn>")
    .description(
      `Publish a domain-local ${name} so it federates from now on (ONE-WAY — there is no un-publish)`
    )
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (idOrUrn: string, cmdOpts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(cmdOpts);
      // Routed through the GENERIC object resource rather than the typed one, because `name` here
      // IS the type id ("service", "deployment-target", …) and publish has exactly one endpoint —
      // `POST /objects/{type}/{idOrUrn}/publish`. The typed SDK namespaces wrap per-type routes that
      // have no publish counterpart, so adding a method there would mean six call sites threading a
      // type string to reach the same generic operation this reaches directly.
      const result = await client.object(name).publish(idOrUrn);
      if (cmdOpts.output === "json") {
        printResult(result, "json", () => ({}));
        return;
      }
      printResult(result.object, "table", (item) => objectRow(item as GraphObject));
      // The edge sweep is reported in BOTH directions, always — including the zero cases. A partial
      // sweep is the correct outcome when a neighbour is still domain-local, but an operator who is
      // not told is left assuming the whole subgraph travelled.
      process.stdout.write(
        `\npublished ${result.publishedRelationships.length} relationship(s)` +
          `; withheld ${result.withheldRelationships.length} (endpoint still domain-local)\n`
      );
      // NAMES, not uuids. For a withheld edge the other endpoint is the operator's next action —
      // "publish that one too" — and a bare id cannot tell them which object that is.
      for (const rel of result.withheldRelationships) {
        process.stdout.write(
          `  withheld: ${rel.typeId} -> ${rel.otherEndpointName} (${rel.otherEndpointUrn})\n`
        );
      }
    });

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
    .description("Exchange credentials for a bearer token and store it")
    .option("-u, --username <username>", "username", process.env.SCP_USERNAME)
    .option("-p, --password <password>", "password", process.env.SCP_PASSWORD)
    .option(
      "--device",
      "use the device authorization flow instead of username+password (for headless hosts — DESIGN.md §7)"
    )
    .option(
      "--base-url <url>",
      "API base URL (defaults to $SCP_API_URL, then your saved login, then localhost)"
    )
    .action(
      async (opts: {
        username?: string;
        password?: string;
        device?: boolean;
        baseUrl?: string;
      }) => {
        // Precedence: --base-url flag > $SCP_API_URL > saved credentials.json baseUrl > localhost.
        const baseUrl = await resolveLoginBaseUrl(opts.baseUrl);
        const client = new ScpClient({ baseUrl });

        if (opts.device) {
          const result = await deviceLogin(client);
          await saveCredentials({
            baseUrl,
            token: result.token,
            org: result.org,
            expiresAt: result.expiresAt
          });
          console.log(`Logged in (org: ${result.org}) via device authorization. Token stored.`);
          return;
        }

        const username = opts.username ?? (await promptLine("Username: "));
        const password = opts.password ?? (await promptLine("Password: "));
        const result = await client.login(username, password);
        await saveCredentials({
          baseUrl,
          token: result.token,
          org: result.org,
          expiresAt: result.expiresAt
        });
        console.log(`Logged in as '${username}' (org: ${result.org}). Token stored.`);
      }
    );

  // -------------------------------------------------------------------------------------
  // pat (Personal Access Tokens — BUILD_AND_TEST.md §8 M2 item 3)
  // -------------------------------------------------------------------------------------
  const patCmd = program.command("pat").description("Manage Personal Access Tokens");

  patCmd
    .command("create")
    .description("Create a Personal Access Token — the token is printed ONCE, store it now")
    .requiredOption("--name <name>", "label for the token")
    .option("--expires-at <iso>", "ISO 8601 expiry datetime (no expiry if omitted)")
    .option("--base-url <url>", "API base URL override")
    .action(async (opts: { name: string; expiresAt?: string; baseUrl?: string }) => {
      const client = await clientFromStoredCredentials(opts);
      const created = await client.pats.create(opts.name, { expiresAt: opts.expiresAt });
      console.log(
        `Personal Access Token '${created.name}' created (id: ${created.id}).\n` +
          "This token is shown ONLY ONCE and cannot be retrieved again — store it now:\n" +
          created.token
      );
    });

  patCmd
    .command("list")
    .description("List your Personal Access Tokens")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const page = await client.pats.list();
      printResult(page.items, opts.output, (item) => patRow(item as Pat));
    });

  patCmd
    .command("revoke <id>")
    .description("Revoke a Personal Access Token")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (id: string, opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const revoked = await client.pats.revoke(id);
      printResult(revoked, opts.output, (item) => patRow(item as Pat));
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
    .option(
      "--cardinality <cardinality>",
      "one_to_one|one_to_many|many_to_one|many_to_many",
      "many_to_many"
    )
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
          cardinality: "one_to_one" | "one_to_many" | "many_to_one" | "many_to_many";
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

  const componentCmd = registerTypedResourceCrud(program, "component", (c) => c.components, {
    serviceOption: true
  });
  registerOwnerCommands(componentCmd, (c) => c.components);
  registerEdgeCommands(componentCmd, "consumes", (c) => c.components);
  registerEdgeCommands(componentCmd, "depends-on", (c) => c.components);
  // `scp component assign <idOrUrn> --service <s>` — idempotent atomic assign-or-move (M12 P5b).
  // Sets the component's owning service: assign (no current service), atomic move (different), or
  // no-op (same). Re-runnable, so it safely bulk-organizes imported orphans.
  componentCmd
    .command("assign <idOrUrn>")
    .description("Assign or move a component into a service (idempotent)")
    .requiredOption("--service <idOrUrn>", "the service the component should belong to (id or URN)")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (idOrUrn: string, opts: BaseCliOpts & { service: string }) => {
      const client = await clientFromStoredCredentials(opts);
      const updated = await client.components.setService(idOrUrn, opts.service);
      printResult(updated, opts.output, (item) => objectRow(item as GraphObject));
    });

  // `scp component scan-requirements <idOrUrn>` — M22.8, charter principle 3 (API -> SDK -> CLI).
  //
  // WHICH SCAN RULES ARE IN FORCE for this component: the resolved six-tier severity ceiling with
  // every tier that contributed to it, and which exclusion classes are admitted and where a clause
  // of each would take effect.
  //
  // THIS IS THE POLLABLE ONE. `scp policy evaluate` runs the real orchestrator and writes a Decision
  // row per invocation with no write suppression; a watch loop on it recreates the amplification
  // ADR-0024 §D0 exists over. This command reads and writes nothing.
  //
  // The table view answers the one question that has no other answer today — "will the exclusion I
  // am about to author do anything?" — by printing each class's `effectiveAtTiers`. An EMPTY column
  // there is the shipped default (admission is empty at every tier) and is the state that was
  // previously invisible from every surface.
  componentCmd
    .command("scan-requirements <idOrUrn>")
    .description(
      "Show the scan rules in force for a component — resolved severity ceiling, its contributors, and which exclusion classes are admitted (writes no Decision)"
    )
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (idOrUrn: string, opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const result = await client.components.scanRequirements(idOrUrn);
      if (opts.output === "json") {
        printResult(result, "json", () => ({}));
        return;
      }
      const t = result.threshold;
      console.log(`component: ${result.componentUrn}`);
      console.log(
        `effective ceiling: ${
          t
            ? JSON.stringify(t.threshold)
            : "(none — no tier sets one; the scan control falls back to its own binding config)"
        }`
      );
      if (t && t.contributors.length > 0) {
        console.log("contributors:");
        printResult(t.contributors, "table", (item) => {
          const c = item as (typeof t.contributors)[number];
          return { tier: c.tier, source: c.source, threshold: JSON.stringify(c.threshold) };
        });
      }
      console.log("exclusion classes:");
      printResult(result.admittedExclusionClasses, "table", (item) => {
        const c = item as (typeof result.admittedExclusionClasses)[number];
        return {
          class: c.class,
          admittedBy: c.admittedBy.map((a) => a.tier).join(",") || "(nobody)",
          effectiveAtTiers: c.effectiveAtTiers.join(",") || "(nowhere — inert)"
        };
      });
      if (result.exclusionClauses.length > 0) {
        console.log("admitted clauses:");
        printResult(result.exclusionClauses, "table", (item) => {
          const c = item as (typeof result.exclusionClauses)[number];
          return { class: c.clause.class, tier: c.tier, source: c.source };
        });
      }
      if (result.unevaluatedConditions.length > 0) {
        // Named, never folded in silently: this surface evaluates NO CEL (there is no change to
        // evaluate against), so each of these was treated conservatively — kept for the CEILING,
        // dropped from the EXCLUSION set. A reader who cannot see them cannot tell a conservative
        // answer from a confident one.
        console.log("conditions NOT evaluated here (no change to evaluate against):");
        printResult(result.unevaluatedConditions, "table", (item) => {
          const c = item as (typeof result.unevaluatedConditions)[number];
          return { policy: c.name, condition: c.condition };
        });
      }
    });

  // `scp component merge <survivor> --loser <loser>` — driving-case merge (M12 P5d): fold a freshly-
  // imported, binding-only component into <survivor> (moves its bindings, soft-deletes it). 409 on a
  // binding-type collision (relabel one first via `scp executor repurpose`).
  componentCmd
    .command("merge <survivorIdOrUrn>")
    .description(
      "Merge another component into this one (moves its executor bindings, soft-deletes it)"
    )
    .requiredOption("--loser <idOrUrn>", "the component to merge in and soft-delete (id or URN)")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (survivorIdOrUrn: string, opts: BaseCliOpts & { loser: string }) => {
      const client = await clientFromStoredCredentials(opts);
      const result = await client.components.merge(survivorIdOrUrn, opts.loser);
      printResult(result, opts.output, (r) => ({
        survivor: (r as { survivor: GraphObject }).survivor.id,
        movedBindings: (r as { movedBindingTypes: string[] }).movedBindingTypes.join(", ") || "none"
      }));
    });

  // `scp placement` — one component at one deployment target (ADR-0026). NOT
  // `registerTypedResourceCrud`: that template's `create` takes a name and free-form properties,
  // and a placement is declared by naming BOTH endpoints. There is deliberately no `update` (the
  // endpoints are the identity) and deliberately no "pair these up by name" convenience (D8).
  const placementCmd = program
    .command("placement")
    .description("Declare where a component runs (component × deployment target)");

  placementCmd
    .command("declare")
    .description("Declare a placement — one component at one deployment target")
    .requiredOption("--component <idOrUrn>", "the component being placed (id or URN)")
    .requiredOption("--deployment-target <idOrUrn>", "the deployment target it runs at (id or URN)")
    .option("--name <name>", "display name (defaults to <component>@<deployment-target>)")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (
        opts: BaseCliOpts & { component: string; deploymentTarget: string; name?: string }
      ) => {
        const client = await clientFromStoredCredentials(opts);
        const created = await client.placements.create(
          {
            component: opts.component,
            deploymentTarget: opts.deploymentTarget,
            ...(opts.name !== undefined ? { name: opts.name } : {})
          },
          { idempotencyKey: randomUUID() }
        );
        printResult(created, opts.output, (item) => objectRow(item as GraphObject));
      }
    );

  placementCmd
    .command("list")
    .description("List placements, optionally filtered by either end of the pair")
    .option("--component <idOrUrn>", "only this component's placements (id or URN)")
    .option("--deployment-target <idOrUrn>", "only placements at this target (id or URN)")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (opts: BaseCliOpts & { component?: string; deploymentTarget?: string }) => {
      const client = await clientFromStoredCredentials(opts);
      const page = await client.placements.list({
        limit: 100,
        ...(opts.component !== undefined ? { component: opts.component } : {}),
        ...(opts.deploymentTarget !== undefined ? { deploymentTarget: opts.deploymentTarget } : {})
      });
      printResult(page.items, opts.output, (item) => objectRow(item as GraphObject));
    });

  placementCmd
    .command("get <idOrUrn>")
    .description("Get a placement by id or URN")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (idOrUrn: string, opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const found = await client.placements.get(idOrUrn);
      printResult(found, opts.output, (item) => objectRow(item as GraphObject));
    });

  placementCmd
    .command("withdraw <idOrUrn>")
    .description("Withdraw a placement (soft delete — frees the pair to be re-declared)")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (idOrUrn: string, opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const removed = await client.placements.delete(idOrUrn);
      printResult(removed, opts.output, (item) => objectRow(item as GraphObject));
    });

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
    .command("integrity")
    .description("Report (and optionally repair) rows that outlived the object they hang off")
    .option("--repair", "delete the repairable rows through the ordinary audited DELETE doors")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (opts: { repair?: boolean; baseUrl?: string; output: OutputFormat }) => {
      const client = await clientFromStoredCredentials(opts);
      const report = await client.graph.integrity();

      type IntegrityRow = { kind: string; id: string; detail: string; repairable: boolean };
      const rows: IntegrityRow[] = [
        ...report.danglingRelationships.map((r) => ({
          kind: "dangling-relationship",
          id: r.id,
          detail: `${r.typeId}: ${r.fromUrn} -> ${r.toUrn} (${r.deadEnd} dead)`,
          repairable: r.repairable
        })),
        ...report.orphanSourceMappings.map((r) => ({
          kind: "orphan-source-mapping",
          id: r.id,
          detail: `${r.ownerName}: ${r.detail}`,
          repairable: true
        })),
        ...report.orphanExecutorBindings.map((r) => ({
          kind: "orphan-executor-binding",
          id: r.id,
          detail: `${r.ownerName}: ${r.detail}`,
          repairable: true
        })),
        ...report.orphanPlacements.map((r) => ({
          kind: "orphan-placement",
          id: r.id,
          detail: `${r.ownerName}: ${r.detail}`,
          repairable: true
        }))
      ];

      if (!opts.repair) {
        printResult(rows, opts.output, (item) => {
          const row = item as IntegrityRow;
          return {
            kind: row.kind,
            id: row.id,
            repairable: String(row.repairable),
            detail: row.detail
          };
        });
        return;
      }

      // REPAIR ONLY WHAT THIS COMMAND CAN ACTUALLY DELETE THROUGH AN AUDITED DOOR.
      //
      // Relationships have one (`DELETE /relationships/{id}`), and it works even when an endpoint is
      // dead. The projection rows do NOT have an id-addressed door — `deleteMapping` matches on the
      // identity TUPLE and the binding door addresses its target object — so repairing them from
      // this report's `id` alone is not possible today. Rather than reach past the API into SQL,
      // this command repairs the edges and NAMES the rest, with the count, so the output can never
      // read as "all clean" when it is not.
      const repairable = report.danglingRelationships.filter((r) => r.repairable);
      const skippedReplicas = report.danglingRelationships.length - repairable.length;
      let deleted = 0;
      for (const edge of repairable) {
        await client.relationships.delete(edge.id);
        deleted += 1;
      }

      const remaining =
        report.orphanSourceMappings.length +
        report.orphanExecutorBindings.length +
        report.orphanPlacements.length;
      printResult(
        [
          { outcome: "relationships-deleted", count: deleted },
          { outcome: "replica-edges-skipped (single-writer authority)", count: skippedReplicas },
          {
            outcome: "projection-rows-left (no id-addressed door; see --output json)",
            count: remaining
          }
        ],
        opts.output,
        (item) => {
          const row = item as { outcome: string; count: number };
          return { outcome: row.outcome, count: String(row.count) };
        }
      );
    });

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
  // doctor — read-only operational self-checks (`GET /doctor`).
  //
  // Sibling of `scp graph integrity` in spirit: a report, never a repair. The distinction from
  // `pnpm doctor` (scripts/doctor.mjs) is deliberate and worth keeping straight — that one checks
  // the TOOLCHAIN on a developer's machine and never opens a database; this one checks a running
  // INSTANCE's state, over the public API like everything else in this CLI.
  // -------------------------------------------------------------------------------------

  program
    .command("doctor")
    .description(
      "Read-only operational self-checks for your org (never repairs; exits 1 if any check warns)"
    )
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const report = await client.doctor.report();

      if (opts.output === "json") {
        printResult(report, opts.output, (item) => item as Record<string, unknown>);
      } else {
        printResult(report.checks, opts.output, (item) => {
          const check = item as DoctorCheck;
          return {
            check: check.id,
            status: check.status.toUpperCase(),
            summary: check.summary
          };
        });
        // The table row is a headline; `detail` is the part an operator at 2am actually needs — what
        // is wrong, why it is silent, and which remedies are available. Printed in full, below the
        // table, for every check that warns. Never truncated into a column.
        for (const check of report.checks) {
          if (check.status === "ok") continue;
          console.log(`\n--- ${check.id} ---\n${check.detail}`);
        }
      }

      // Same contract as `scp policy evaluate`'s block verdict and as `pnpm doctor`: a non-zero exit
      // so this is usable as a CI/rollout gate, not merely something a human reads.
      if (report.checks.some((c) => c.status !== "ok")) process.exitCode = 1;
    });

  // -------------------------------------------------------------------------------------
  // plan / apply (`@scp/iac` server-side plan/apply — BUILD_AND_TEST.md §8 M2 item 4). A
  // manifest file is what `@scp/iac`'s `synthToFile` writes (or any hand-authored/CI-generated
  // JSON matching `DesiredStateManifestSchema`) — the CLI never imports/executes a user's IaC
  // TypeScript program directly, only the synthesized manifest (DESIGN.md §15).
  // -------------------------------------------------------------------------------------

  program
    .command("plan")
    .description("Compute a desired-state diff for an @scp/iac manifest (dry run — does not apply)")
    .requiredOption("--manifest <path>", "path to a synthesized DesiredStateManifest JSON file")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (opts: BaseCliOpts & { manifest: string }) => {
      const client = await clientFromStoredCredentials(opts);
      const manifest = await readManifestFile(opts.manifest);
      const plan = await client.plans.create(manifest);
      printPlanResult(plan, opts.output);
    });

  program
    .command("apply")
    .description(
      "Plan and apply an @scp/iac manifest in one shot (POST /plans then apply) — applying an unchanged manifest again is a no-op"
    )
    .requiredOption("--manifest <path>", "path to a synthesized DesiredStateManifest JSON file")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (opts: BaseCliOpts & { manifest: string }) => {
      const client = await clientFromStoredCredentials(opts);
      const manifest = await readManifestFile(opts.manifest);
      const plan = await client.plans.create(manifest);
      const { plan: applied, summary } = await client.plans.apply(plan.id);
      printApplyResult(applied, summary, opts.output);
    });

  program
    .command("plan-status <id>")
    .description("Get a previously computed plan by id")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (id: string, opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const plan = await client.plans.get(id);
      printPlanResult(plan, opts.output);
    });

  // -------------------------------------------------------------------------------------
  // change / decision (M3 Change Coordination Engine — DESIGN.md §9, §10.4, BUILD_AND_TEST.md
  // §8 M3). `scp change propose` submits a Change against >=1 target object (usually
  // components/services/deployment-targets); the engine compiles a wave plan from their
  // `depends_on` edges (or an explicit `--topology`), gates each state transition behind policy
  // Decisions, and executes waves via executor plugins. `scp change explain` is the CLI's window
  // into that reasoning — the compiled plan's waves/targets plus every Decision made about the
  // change, in order. `decision get/list` are read-only: Decisions are written by the
  // coordination engine itself (policy/guard verdicts), never created directly via the CLI.
  // -------------------------------------------------------------------------------------
  const changeCmd = program
    .command("change")
    .description("Manage Changes (DESIGN.md §9 lifecycle)");

  changeCmd
    .command("propose")
    .description("Propose a new Change")
    .requiredOption("--name <name>", "change name")
    .requiredOption("--targets <list>", "comma-separated object ids/URNs this change targets")
    .option("--topology <idOrUrn>", "release-topology object id or URN to compile the plan against")
    .option("--source-kind <kind>", "originating source kind (e.g. github, argocd)")
    .option("--correlation-key <key>", "correlation key for grouping related changes")
    .option("--emergency", "mark this change as an emergency (DESIGN.md §9)")
    .option(
      "--type <type>",
      "routing Type (ADR-0007): image|rpm|deb|npm (Category build) | infrastructure | configuration — " +
        "WHICH pipeline this change rolls, selecting each target's executor binding. Defaults to configuration"
    )
    .option(
      "--provides <keys>",
      "M12 P4B coupled pipelines: comma-separated keys this release makes true at its targets when it succeeds"
    )
    .option(
      "--requires <list>",
      "M12 P4B coupled pipelines: comma-separated prerequisites as key@objectIdOrUrn — this change " +
        "WAITS until another change provides each key at that object before it executes"
    )
    .option(
      "--stage-depends-on <list>",
      "ADR-0028 stage-scoped coupling: comma-separated componentIdOrUrn (or componentIdOrUrn@minWeight, " +
        "a percentage 1-100) this change's component must not deploy AHEAD OF at a shared place"
    )
    .option(
      "--stage-depends-at <targets>",
      "ADR-0028: comma-separated deployment-target ids/URNs restricting EVERY --stage-depends-on entry " +
        "to those places (omit for every stage the components share)"
    )
    .option("--properties <json>", "JSON object")
    .option("--labels <json>", "JSON object")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (
        opts: BaseCliOpts & {
          name: string;
          targets: string;
          type?: ExecutorType;
          provides?: string;
          requires?: string;
          stageDependsOn?: string;
          stageDependsAt?: string;
          topology?: string;
          sourceKind?: string;
          correlationKey?: string;
          emergency?: boolean;
          properties?: string;
          labels?: string;
        }
      ) => {
        const client = await clientFromStoredCredentials(opts);
        const requires = parseRequiresFlag(opts.requires);
        const created = await client.changes.propose(
          {
            name: opts.name,
            targets: parseList(opts.targets) ?? [],
            topology: opts.topology,
            sourceKind: opts.sourceKind,
            correlationKey: opts.correlationKey,
            emergency: opts.emergency,
            type: opts.type,
            provides: parseList(opts.provides),
            requires,
            stageDependencies: parseStageDependenciesFlags(
              opts.stageDependsOn,
              opts.stageDependsAt
            ),
            properties: parseJsonOption(opts.properties, "--properties"),
            labels: parseJsonOption(opts.labels, "--labels")
          },
          { idempotencyKey: randomUUID() }
        );
        printResult(created, opts.output, (item) => changeDetailRow(item as Change));
      }
    );

  changeCmd
    .command("list")
    .description("List Changes")
    .option(
      "--state <state>",
      "filter by state (proposed|evaluated|coordinated|waiting|executing|validating|accepted|cancelled|rolled_back)"
    )
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (opts: BaseCliOpts & { state?: ChangeState }) => {
      const client = await clientFromStoredCredentials(opts);
      const page = await client.changes.list({ state: opts.state, limit: 100 });
      printResult(page.items, opts.output, (item) => changeRow(item as Change));
    });

  changeCmd
    .command("get <id>")
    .description("Get a Change by id")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (id: string, opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const found = await client.changes.get(id);
      printResult(found, opts.output, (item) => changeDetailRow(item as Change));
    });

  changeCmd
    .command("explain <id>")
    .description(
      "Explain a Change — its compiled plan (waves/targets) and every Decision made about it"
    )
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (id: string, opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const result = await client.changes.explain(id);
      printExplainResult(result, opts.output);
    });

  changeCmd
    .command("wait-status <id>")
    // REWRITTEN AT ADR-0028 INCREMENT 4, not extended in silence. This command covered exactly one
    // coupling until now, and its help text said so by name ("M12 P4B … which `requires`
    // prerequisites"). Teaching it a second coupling while leaving that sentence would have left the
    // help text asserting the narrower command — and any test pinning the string would have gone on
    // passing, green for precisely the wrong reason.
    .description(
      "Print ONLY a Change's coupling status: which `requires` prerequisites are satisfied or " +
        "outstanding and by which change (M12 P4B), and which stage dependencies are withholding a " +
        "wave target's trigger, where, and why (ADR-0028). A thin renderer over `explain` — a change " +
        "may be in either coupling, both, or neither"
    )
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (id: string, opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      // No dedicated route (coupled-pipelines.md §3.8/§7 Phase 4) — `explain` already computes and
      // returns both statuses; this command is deliberately just that call, rendering only those two
      // sections instead of the full plan/Decisions/control-runs picture `explain` prints.
      const result = await client.changes.explain(id);
      if (opts.output === "json") {
        // BOTH KEYS. This branch printed `result.waitStatus` alone until increment 4, so a change
        // held by a stage dependency that declared no `requires` — the common ADR-0028 shape, since
        // the two couplings are independent — printed the literal `null`. The scripted path would
        // have gone on reporting "nothing is holding this" while the table path said HELD.
        // `stageDependencyStatus` is passed through UNNORMALISED: `JSON.stringify` drops an omitted
        // key, so an older server's silence stays silence here rather than being dressed as `null`.
        console.log(
          JSON.stringify(
            { waitStatus: result.waitStatus, stageDependencyStatus: result.stageDependencyStatus },
            null,
            2
          )
        );
        return;
      }
      printWaitStatusBody(result.waitStatus, true);
      printStageDependencyBody(result.stageDependencyStatus, true);
    });

  changeCmd
    .command("cancel <id>")
    .description("Cancel a Change")
    .option("--reason <text>", "reason for cancelling")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (id: string, opts: BaseCliOpts & { reason?: string }) => {
      const client = await clientFromStoredCredentials(opts);
      const cancelled = await client.changes.cancel(id, opts.reason);
      printResult(cancelled, opts.output, (item) => changeDetailRow(item as Change));
    });

  changeCmd
    .command("accept <id>")
    .description("Accept a Change out of `validating` — the human approval gate before `accepted`")
    .option(
      "--reason <text>",
      "reason for accepting (also the mandatory reason for --override-freeze)"
    )
    .option(
      "--override-freeze",
      "override an active freeze blocking this transition (requires freeze:override + --reason — DESIGN §10.3)"
    )
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (id: string, opts: BaseCliOpts & { reason?: string; overrideFreeze?: boolean }) => {
        const client = await clientFromStoredCredentials(opts);
        const accepted = await client.changes.accept(id, opts.reason, opts.overrideFreeze);
        printResult(accepted, opts.output, (item) => changeDetailRow(item as Change));
      }
    );

  changeCmd
    .command("rollback <id>")
    .description(
      "Roll back a Change — creates and returns a NEW rollback Change linked via rollbackOfObjectId"
    )
    .requiredOption("--reason <text>", "reason for the rollback (required — DESIGN.md §9.4)")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (id: string, opts: BaseCliOpts & { reason: string }) => {
      const client = await clientFromStoredCredentials(opts);
      const rollback = await client.changes.rollback(id, opts.reason);
      if (opts.output === "table") {
        console.log(`Rollback change created (of ${id}):`);
      }
      printResult(rollback, opts.output, (item) => changeDetailRow(item as Change));
    });

  const decisionCmd = program.command("decision").description("Inspect Decision records");

  decisionCmd
    .command("get <id>")
    .description("Get a Decision by id")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (id: string, opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const found = await client.decisions.get(id);
      printResult(found, opts.output, (item) => decisionRow(item as Decision));
    });

  decisionCmd
    .command("list")
    .description("List Decisions")
    .option("--subject-id <id>", "filter by subject (e.g. a Change) id")
    // ADR-0028 increment 4. Usable on its OWN, which is the point: `--subject-id` already answered
    // "what happened to this change", and the question this exists for — "was my coupling enforced
    // here?" — is asked by someone who has the coupling and not the change id. A kind is not a
    // state, though: `stage_dependency` carries a `hold` (a withheld trigger) AND an `allow` (the
    // declaration stripped on promotion import), so read the verdict column beside it.
    .option(
      "--kind <kind>",
      "filter by Decision kind (e.g. stage_dependency, watchdog, gate) — combinable with --subject-id"
    )
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (opts: BaseCliOpts & { subjectId?: string; kind?: string }) => {
      const client = await clientFromStoredCredentials(opts);
      const page = await client.decisions.list({
        subjectId: opts.subjectId,
        kind: opts.kind,
        limit: 100
      });
      printResult(page.items, opts.output, (item) => decisionRow(item as Decision));
    });

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

  // -------------------------------------------------------------------------------------
  // M4 Governance Engine (BUILD_AND_TEST.md §8 M4, DESIGN.md §10): policy/control documents
  // (typed-registry resources — same CRUD family as domains/services/etc.), approvals (N-of-M
  // quorum), freezes, and `scp policy evaluate`'s dry-run gate check.
  // -------------------------------------------------------------------------------------
  registerTypedResourceCrud(program, "policy", (c) => c.policies);
  const controlCmd = registerTypedResourceCrud(program, "control", (c) => c.controls);

  controlCmd
    .command("bind <idOrUrn>")
    .description("Bind a Control to a ControlPlugin instance (DESIGN §10.2)")
    .requiredOption(
      "--plugin-module <module>",
      "webhook-control | scan-result-control | github-check"
    )
    .requiredOption("--plugin-instance-id <id>", "stable plugin-host instance id")
    .option("--config <json>", "JSON object — plugin instance config (e.g. webhook url)")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (
        idOrUrn: string,
        opts: BaseCliOpts & { pluginModule: string; pluginInstanceId: string; config?: string }
      ) => {
        const client = await clientFromStoredCredentials(opts);
        const binding = await client.controls.putBinding(idOrUrn, {
          pluginModule: opts.pluginModule,
          pluginInstanceId: opts.pluginInstanceId,
          config: parseJsonOption(opts.config, "--config")
        });
        printResult(binding, opts.output, (item) => {
          const b = item as { id: string; pluginModule: string; pluginInstanceId: string };
          return { id: b.id, pluginModule: b.pluginModule, pluginInstanceId: b.pluginInstanceId };
        });
      }
    );

  const approvalCmd = program
    .command("approval")
    .description("Manage approval requests (DESIGN §10.2 — N-of-M quorum)");

  approvalCmd
    .command("list")
    .description("List approval requests for a change")
    .requiredOption("--change-id <id>", "change id or URN")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (opts: BaseCliOpts & { changeId: string }) => {
      const client = await clientFromStoredCredentials(opts);
      const page = await client.approvals.list({ changeId: opts.changeId, limit: 100 });
      printResult(page.items, opts.output, (item) => approvalRow(item as ApprovalRequest));
    });

  approvalCmd
    .command("get <id>")
    .description("Get an approval request by id")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (id: string, opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const found = await client.approvals.get(id);
      printResult(found, opts.output, (item) => approvalRow(item as ApprovalRequest));
    });

  approvalCmd
    .command("votes <id>")
    .description("List votes cast on an approval request")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (id: string, opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const votes = await client.approvals.listVotes(id);
      printResult(votes, opts.output, (item) => approvalVoteRow(item as ApprovalVote));
    });

  approvalCmd
    .command("approve <id>")
    .description(
      "Cast your vote on an approval request — always self-attested, one vote per subject"
    )
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (id: string, opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const vote = await client.approvals.vote(id);
      printResult(vote, opts.output, (item) => approvalVoteRow(item as ApprovalVote));
    });

  const freezeCmd = program.command("freeze").description("Manage freeze windows (DESIGN §10.3)");

  freezeCmd
    .command("create")
    .description("Declare a freeze window over a scope")
    .requiredOption(
      "--scope <idOrUrn>",
      "the org/domain/service/component/deployment-target this freeze covers (a deployment-target scope freezes a whole region — ADR-0026 containment route 4)"
    )
    .requiredOption("--starts-at <iso>", "ISO 8601 start")
    .requiredOption("--ends-at <iso>", "ISO 8601 end")
    .requiredOption("--reason <text>", "mandatory reason")
    .option("--name <name>", "human-readable label")
    .option(
      "--atomic",
      "park the WHOLE wave rather than only the targets this freeze covers (owner decision D5) — use it when half-applied is worse than not-applied, e.g. a schema migration and the service that reads it"
    )
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (
        opts: BaseCliOpts & {
          scope: string;
          startsAt: string;
          endsAt: string;
          reason: string;
          name?: string;
          atomic?: boolean;
        }
      ) => {
        const client = await clientFromStoredCredentials(opts);
        const freeze = await client.freezes.create({
          scopeObjectId: opts.scope,
          startsAt: opts.startsAt,
          endsAt: opts.endsAt,
          reason: opts.reason,
          name: opts.name,
          // Sent only when the flag is present, so an ordinary `scp freeze create` keeps sending a
          // byte-identical body and the server-side default (`false`) stays the one place the
          // default lives.
          ...(opts.atomic ? { atomic: true } : {})
        });
        printResult(freeze, opts.output, (item) => freezeRow(item as Freeze));
      }
    );

  freezeCmd
    .command("list")
    .description("List freeze windows")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const page = await client.freezes.list();
      printResult(page.items, opts.output, (item) => freezeRow(item as Freeze));
    });

  freezeCmd
    .command("get <id>")
    .description("Get a freeze by id")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (id: string, opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const found = await client.freezes.get(id);
      printResult(found, opts.output, (item) => freezeRow(item as Freeze));
    });

  // M25.1 — THE EXITS. `scp freeze` was create/list/get, so an operator could declare a freeze and
  // had no way to take it back: the only escapes were `scp change cancel` / `scp change rollback`,
  // which throw the RELEASE away rather than lifting the FREEZE. Since M25.2's per-target
  // admission that is worse than waiting — a mistyped `--ends-at` year now holds a SUBSET of a
  // wave's targets while the siblings have already shipped.
  freezeCmd
    .command("lift <id>")
    .description(
      "Lift (retract) a freeze — it stops being in force immediately, whatever endsAt says"
    )
    .requiredOption(
      "--reason <text>",
      "mandatory reason — lifting a freeze is a governance LOOSENING that applies to everyone it covered"
    )
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (id: string, opts: BaseCliOpts & { reason: string }) => {
      const client = await clientFromStoredCredentials(opts);
      // The lifted row comes back rather than an empty 204: `liftedAt`/`liftedBy`/`liftReason` are
      // on it, and a lifted freeze stays gettable by id forever so a Decision citing it resolves.
      const lifted = await client.freezes.lift(id, { reason: opts.reason });
      printResult(lifted, opts.output, (item) => freezeRow(item as Freeze));
    });

  freezeCmd
    .command("update <id>")
    .description(
      "Move a freeze's endsAt — shortening it is a loosening, extending it is a tightening"
    )
    .requiredOption("--ends-at <iso>", "the new ISO 8601 end (must still be after startsAt)")
    .requiredOption("--reason <text>", "mandatory reason, in BOTH directions")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (id: string, opts: BaseCliOpts & { endsAt: string; reason: string }) => {
      const client = await clientFromStoredCredentials(opts);
      const updated = await client.freezes.updateWindow(id, {
        endsAt: opts.endsAt,
        reason: opts.reason
      });
      printResult(updated, opts.output, (item) => freezeRow(item as Freeze));
    });

  const policyCmd = program.commands.find((c) => c.name() === "policy")!;
  policyCmd
    .command("evaluate <changeId>")
    .description(
      "Dry-run governance evaluation for a change — verdict + reason tree, no transition attempted"
    )
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (changeId: string, opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const result = await client.policyEvaluate(changeId);
      printPolicyEvaluateResult(result, opts.output);
      if (result.verdict === "block") process.exitCode = 1;
    });

  // -------------------------------------------------------------------------------------
  // campaign (M5 Campaigns — DESIGN.md §9.5, BUILD_AND_TEST.md §8 M5).
  // A Campaign coordinates many Changes across targets, wave by wave, over the SAME plan compiler
  // a Change uses; unlike Change, it has no accept/cancel verbs — `status` is always a pure
  // derived field, so `campaign status <id>` (its `get`) IS the CLI's window into that field.
  // -------------------------------------------------------------------------------------
  const campaignCmd = program
    .command("campaign")
    .description(
      "Manage Campaigns (DESIGN.md §9.5 — coordinate many Changes across targets, wave by wave)"
    );

  campaignCmd
    .command("create")
    .description("Create a new Campaign")
    .requiredOption("--name <name>", "campaign name")
    .requiredOption("--targets <list>", "comma-separated object ids/URNs this campaign targets")
    .option("--topology <idOrUrn>", "release-topology object id or URN to compile the plan against")
    .option("--description <text>", "campaign description")
    .option(
      "--type <type>",
      "routing Type (ADR-0007): image|rpm|deb|npm | infrastructure | configuration — WHICH pipeline " +
        "every change this campaign fans out rolls (e.g. infrastructure for 'patch the base AMI " +
        "everywhere'). Defaults to configuration"
    )
    .option("--labels <json>", "JSON object")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (
        opts: BaseCliOpts & {
          name: string;
          targets: string;
          topology?: string;
          description?: string;
          type?: ExecutorType;
          labels?: string;
        }
      ) => {
        const client = await clientFromStoredCredentials(opts);
        const created = await client.campaigns.propose(
          {
            name: opts.name,
            targets: parseList(opts.targets) ?? [],
            topology: opts.topology,
            description: opts.description,
            type: opts.type,
            labels: parseJsonOption(opts.labels, "--labels")
          },
          { idempotencyKey: randomUUID() }
        );
        printResult(created, opts.output, (item) => campaignDetailRow(item as Campaign));
      }
    );

  campaignCmd
    .command("list")
    .description("List Campaigns")
    .option(
      "--status <status>",
      "filter by status (proposed|active|blocked|failed|completed|partially_rolled_back|rolled_back)"
    )
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (opts: BaseCliOpts & { status?: CampaignStatus }) => {
      const client = await clientFromStoredCredentials(opts);
      const page = await client.campaigns.list({ status: opts.status, limit: 100 });
      printResult(page.items, opts.output, (item) => campaignRow(item as Campaign));
    });

  campaignCmd
    .command("status <id>")
    .description("Get a Campaign's current (derived) status and details")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (id: string, opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const found = await client.campaigns.get(id);
      printResult(found, opts.output, (item) => campaignDetailRow(item as Campaign));
    });

  campaignCmd
    .command("explain <id>")
    .description(
      "Explain a Campaign — its compiled plan (waves/targets) and every Decision made about it"
    )
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (id: string, opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const result = await client.campaigns.explain(id);
      printCampaignExplainResult(result, opts.output);
    });

  campaignCmd
    .command("rollback <id>")
    .description(
      "Roll back a Campaign — rolls back every currently-eligible member Change, each becoming its own new rollback Change"
    )
    .requiredOption("--reason <text>", "reason for the rollback (required — DESIGN.md §9.4/§9.5)")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (id: string, opts: BaseCliOpts & { reason: string }) => {
      const client = await clientFromStoredCredentials(opts);
      const result = await client.campaigns.rollback(id, opts.reason);
      if (opts.output === "json") {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(
        `Rolled back ${result.rolledBack.length} member change(s), ${result.skipped.length} skipped`
      );
      printResult(
        [
          ...result.rolledBack.map((r) => ({
            originalChangeObjectId: r.originalChangeObjectId,
            outcome: `rolled back -> ${r.rollbackChange.id}`
          })),
          ...result.skipped.map((s) => ({
            originalChangeObjectId: s.originalChangeObjectId,
            outcome: `skipped: ${s.reason}`
          }))
        ],
        opts.output,
        (item) => item as Record<string, unknown>
      );
    });

  // -------------------------------------------------------------------------------------
  // -------------------------------------------------------------------------------------
  // instance scan-floors (M17.5 — ADR-0016). The two ABOVE-org tiers of the six-tier,
  // most-restrictive-wins scan-requirement chain:
  //   platform -> trust domain (partition) -> org -> containment domain -> service -> component
  // These are INSTANCE-scoped: they bind EVERY org on the deployment, so authoring one is an
  // OPERATOR action gated by the deployment's SCP_OPERATOR_TOKEN — never a tenant role, however
  // privileged inside its own org. Reading is an ordinary authenticated call, because a gate you
  // cannot inspect is not explainable.
  //
  // `trust-domain` is the AMBIENT FEDERATION boundary (a partition) above org — NOT the intra-org
  // containment `domain` object type below org (`scp domain ...`). Different concepts; the stored
  // tier literal is `trust_domain`, never bare `domain`.
  // -------------------------------------------------------------------------------------
  const scanFloorsCmd = program
    .command("scan-floors")
    .description(
      "Instance-scoped scan-requirement floors (ADR-0016) — the platform + trust-domain (partition) tiers that bind every org on this deployment"
    );

  scanFloorsCmd
    .command("list")
    .description("List the instance-scoped scan-requirement floors binding this deployment")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const floors = await client.instanceScanFloors.list();
      printResult(floors, opts.output, (raw) =>
        instanceScanFloorRow(raw as (typeof floors)[number])
      );
    });

  scanFloorsCmd
    .command("set")
    .description(
      "Author an instance-scoped scan-requirement floor (OPERATOR ONLY — requires SCP_OPERATOR_TOKEN; a floor may only ever TIGHTEN what orgs below it can pass)"
    )
    .requiredOption(
      "--tier <tier>",
      "platform|trust-domain (the partition tier, not the intra-org containment domain)"
    )
    .option("--origin <origin>", "local|federated", "local")
    .option(
      "--max-critical <n>",
      "ceiling on CRITICAL findings (omit to leave unset — unset never means 0)"
    )
    .option("--max-high <n>", "ceiling on HIGH findings")
    .option("--max-medium <n>", "ceiling on MEDIUM findings")
    .option("--max-low <n>", "ceiling on LOW findings")
    .option("--note <text>", "free-text note recorded with the floor")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (
        opts: BaseCliOpts & {
          tier: string;
          origin: "local" | "federated";
          maxCritical?: string;
          maxHigh?: string;
          maxMedium?: string;
          maxLow?: string;
          note?: string;
        }
      ) => {
        const operatorToken = process.env.SCP_OPERATOR_TOKEN;
        if (!operatorToken) {
          throw new Error(
            "SCP_OPERATOR_TOKEN is not set — instance scan floors bind every org on the deployment, so authoring one requires the deployment operator token, not your tenant login."
          );
        }
        // Accept the friendlier `trust-domain` on the command line, but send the canonical
        // `trust_domain` literal — never bare `domain` (ADR-0016 terminology).
        const tier = opts.tier === "trust-domain" ? "trust_domain" : opts.tier;
        if (tier !== "platform" && tier !== "trust_domain") {
          throw new Error(`--tier must be 'platform' or 'trust-domain' (got '${opts.tier}')`);
        }
        const num = (v: string | undefined): number | undefined => {
          if (v === undefined) return undefined;
          const n = Number(v);
          if (!Number.isInteger(n) || n < 0)
            throw new Error(`expected a non-negative integer, got '${v}'`);
          return n;
        };
        const client = await clientFromStoredCredentials(opts);
        const floor = await client.instanceScanFloors.put(
          tier,
          {
            origin: opts.origin,
            maxCritical: num(opts.maxCritical),
            maxHigh: num(opts.maxHigh),
            maxMedium: num(opts.maxMedium),
            maxLow: num(opts.maxLow),
            note: opts.note
          },
          operatorToken
        );
        printResult(floor, opts.output, (item) => item as Record<string, unknown>);
      }
    );

  // -------------------------------------------------------------------------------------
  // instance scan-exclusion-admissions (M22.9 — ADR-0033 §1, §7a). The two ABOVE-org rungs of the
  // exclusion dimension's monotone AND: a clause authored at any tier has effect only if EVERY
  // represented tier strictly above it admits that clause's CLASS, and `platform` + `trust_domain`
  // are ALWAYS represented. No policy can contribute those two — a policy anchors at a graph object
  // and the containment chain is org-rooted — so with this table empty (the shipped default) every
  // exclusion clause on the deployment is inert. This command is how an operator changes that.
  //
  // The five org-and-below rungs are NOT here and need nothing: they admit through the ordinary
  // `scanExclusion` policy effect (`scp policy create ... {"scanExclusion":{"admit":[...]}}`).
  //
  // `set` REPLACES the admitted set for the tier, so withdrawing everything is `--revoke-all` rather
  // than simply omitting `--class` — omitting it is refused, because an empty set at an instance rung
  // makes every exclusion clause on the deployment inert and that is not something to reach by
  // forgetting a flag.
  // -------------------------------------------------------------------------------------
  const scanAdmissionsCmd = program
    .command("scan-exclusion-admissions")
    .description(
      "Instance-scoped scan-exclusion admissions (ADR-0033) — the platform + trust-domain rungs that gate every exclusion clause beneath them"
    );

  scanAdmissionsCmd
    .command("list")
    .description(
      "List the exclusion classes this deployment admits (an EMPTY list means every exclusion clause anywhere on this deployment is inert)"
    )
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const admissions = await client.instanceScanExclusionAdmissions.list();
      printResult(admissions, opts.output, (raw) =>
        instanceScanExclusionAdmissionRow(raw as (typeof admissions)[number])
      );
    });

  scanAdmissionsCmd
    .command("set")
    .description(
      "REPLACE the exclusion classes admitted at one instance tier (OPERATOR ONLY — requires SCP_OPERATOR_TOKEN; this is a whole-set replace, so withdrawing everything needs --revoke-all)"
    )
    .requiredOption(
      "--tier <tier>",
      "platform|trust-domain (the partition tier, not the intra-org containment domain)"
    )
    .option(
      "--class <class...>",
      "no_fix_available|vendor_latest|declared_fact|approved_override (repeatable; the WHOLE admitted set for this tier)"
    )
    .option(
      "--revoke-all",
      "withdraw EVERY admission at this tier (required when --class is omitted, because that is a destructive whole-set replace and not a no-op)"
    )
    .option("--origin <origin>", "local|federated", "local")
    .option("--note <text>", "free-text note recorded with the admission")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (
        opts: BaseCliOpts & {
          tier: string;
          class?: string[];
          revokeAll?: boolean;
          origin: "local" | "federated";
          note?: string;
        }
      ) => {
        const operatorToken = process.env.SCP_OPERATOR_TOKEN;
        if (!operatorToken) {
          throw new Error(
            "SCP_OPERATOR_TOKEN is not set — an admission opens a loosening for every org on the deployment, so authoring one requires the deployment operator token, not your tenant login."
          );
        }
        // Accept the friendlier `trust-domain` on the command line, but send the canonical
        // `trust_domain` literal — never bare `domain` (ADR-0016 / ADR-0033 terminology).
        const tier = opts.tier === "trust-domain" ? "trust_domain" : opts.tier;
        if (tier !== "platform" && tier !== "trust_domain") {
          throw new Error(`--tier must be 'platform' or 'trust-domain' (got '${opts.tier}')`);
        }
        const allowed = [
          "no_fix_available",
          "vendor_latest",
          "declared_fact",
          "approved_override"
        ] as const;
        // THE DESTRUCTIVE DEFAULT, MADE EXPLICIT (owner decision, 2026-08-18).
        //
        // `set` is a whole-set REPLACE, and that is the right server contract: an additive verb would
        // make withdrawal the harder operation on a LOOSENING, which is the wrong way round. But it
        // means `--class` omitted sends `classes: []`, and an empty admitted set at an instance rung
        // makes EVERY exclusion clause on the deployment inert — every org, every tier beneath it —
        // because the monotone AND fails at the top. That is a bigger blast radius than any other
        // single CLI call in this tool, and it was reachable by forgetting a flag.
        //
        // The server contract is unchanged; this refusal is CLI-side only. `--revoke-all` is the
        // withdrawal path and it says what it does.
        const classes = opts.class ?? [];
        if (classes.length === 0 && !opts.revokeAll) {
          throw new Error(
            `refusing to withdraw every exclusion-class admission at '${tier}': no --class was given, ` +
              `and 'set' REPLACES the whole admitted set for a tier rather than adding to it. That would ` +
              `make every exclusion clause on this deployment inert, for every org. Pass --revoke-all if ` +
              `that is what you mean, or name the classes this tier should admit with --class.`
          );
        }
        if (classes.length > 0 && opts.revokeAll) {
          throw new Error(
            "--revoke-all and --class are mutually exclusive: --revoke-all withdraws the whole set, so naming classes alongside it is contradictory."
          );
        }
        for (const cls of classes) {
          if (!(allowed as readonly string[]).includes(cls)) {
            // Refused here as well as by the route and the table's CHECK, for 0074's stated reason:
            // a typo'd class is an admission the operator believes they granted and that admits
            // nothing, with the clause beneath it silently inert.
            throw new Error(`--class must be one of ${allowed.join("|")} (got '${cls}')`);
          }
        }
        const client = await clientFromStoredCredentials(opts);
        const admissions = await client.instanceScanExclusionAdmissions.put(
          tier,
          {
            origin: opts.origin,
            classes: classes as InstanceScanExclusionAdmission["class"][],
            note: opts.note
          },
          operatorToken
        );
        printResult(admissions, opts.output, (raw) =>
          instanceScanExclusionAdmissionRow(raw as (typeof admissions)[number])
        );
      }
    );

  // -------------------------------------------------------------------------------------
  // instance scanner-assignments (M13.3a — ADR-0020 §2). The executor Type -> managed scan
  // method(s) registry the commander's promotion scan step selects scanners from. Keyed on the
  // EXISTING ExecutorType taxonomy (image|rpm|deb|npm|infrastructure|configuration). Like scan
  // floors these are INSTANCE-scoped: they bind EVERY org on the deployment, so authoring one is an
  // OPERATOR action gated by SCP_OPERATOR_TOKEN — never a tenant role. Reading is an ordinary
  // authenticated call. An empty methods set CLEARS the assignment (that Type produces no managed
  // evidence — fail-closed: E6 refuses unless org-pipeline evidence covers the digest).
  // -------------------------------------------------------------------------------------
  const scannerAssignmentsCmd = program
    .command("scanner-assignments")
    .description(
      "Instance-scoped scanner assignments (ADR-0020) — the executor Type -> managed scan method(s) the commander's promotion scan step runs; bind every org on this deployment"
    );

  scannerAssignmentsCmd
    .command("list")
    .description("List the instance-scoped scanner assignments binding this deployment")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const assignments = await client.scannerAssignments.list();
      printResult(assignments, opts.output, (raw) => {
        const item = raw as (typeof assignments)[number];
        return {
          executorType: item.executorType,
          methods: item.methods.length ? item.methods.join(",") : "(none)"
        };
      });
    });

  scannerAssignmentsCmd
    .command("set")
    .description(
      "Assign managed scan methods to an executor Type (OPERATOR ONLY — requires SCP_OPERATOR_TOKEN; an empty --methods clears the assignment, leaving that Type with no managed scanner)"
    )
    .requiredOption("--type <executorType>", "image|rpm|deb|npm|infrastructure|configuration")
    .option(
      "--methods <list>",
      "comma-separated scan methods (trivy|openscap); empty/omitted clears the assignment",
      ""
    )
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (
        opts: BaseCliOpts & {
          type: string;
          methods: string;
        }
      ) => {
        const operatorToken = process.env.SCP_OPERATOR_TOKEN;
        if (!operatorToken) {
          throw new Error(
            "SCP_OPERATOR_TOKEN is not set — scanner assignments bind every org on the deployment, so authoring one requires the deployment operator token, not your tenant login."
          );
        }
        const validTypes = [
          "image",
          "rpm",
          "deb",
          "npm",
          "infrastructure",
          "configuration"
        ] as const;
        if (!(validTypes as readonly string[]).includes(opts.type)) {
          throw new Error(`--type must be one of ${validTypes.join("|")} (got '${opts.type}')`);
        }
        const methods = opts.methods
          .split(",")
          .map((m) => m.trim())
          .filter(Boolean);
        // Validate against the SCHEMA's method set, never a hand-copied literal list: a new managed
        // scan method (13.3a added `trivy-vm`) must not need a matching edit here to be usable, and
        // a stale copy would reject a method the server accepts.
        const parsedMethods: ScanMethod[] = [];
        for (const m of methods) {
          const parsed = ScanMethodSchema.safeParse(m);
          if (!parsed.success) {
            throw new Error(
              `--methods entries must be one of ${ScanMethodSchema.options.join("|")} (got '${m}')`
            );
          }
          parsedMethods.push(parsed.data);
        }
        const client = await clientFromStoredCredentials(opts);
        const assignment = await client.scannerAssignments.put(
          {
            executorType: opts.type as (typeof validTypes)[number],
            methods: parsedMethods
          },
          operatorToken
        );
        printResult(assignment, opts.output, (item) => {
          const a = item as typeof assignment;
          return {
            executorType: a.executorType,
            methods: a.methods.length ? a.methods.join(",") : "(none)",
            updatedAt: a.updatedAt
          };
        });
      }
    );

  // scan-db (M13.3b-ii — ADR-0020, proposal §13.3b). The commander's managed-scan vulnerability DB:
  // `status` + `staleness-policy get` are ordinary reads (a promotion blocked for a stale DB must be
  // explainable); `staleness-policy set`, `refresh` (connected skopeo-pull), and `load` (air-gap
  // cosign-signed blob) bind every org and are OPERATOR actions gated by SCP_OPERATOR_TOKEN.
  // -------------------------------------------------------------------------------------
  const scanDbCmd = program
    .command("scan-db")
    .description(
      "Commander managed-scan vulnerability DB (ADR-0020 §13.3b) — status, staleness policy, connected refresh, air-gap operator-load"
    );

  scanDbCmd
    .command("status")
    .description(
      "Show the DB's presence, age, source (baked|refreshed|operator-loaded), schema compatibility, staleness, and active thresholds"
    )
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const status = await client.scanDb.status();
      printResult(status, opts.output, (raw) => scanDbStatusRow(raw as typeof status));
    });

  const stalenessCmd = scanDbCmd
    .command("staleness-policy")
    .description(
      "The instance-scoped soft/hard max-age policy (owner decision 2026-07-24 — a company applies its own rules)"
    );

  stalenessCmd
    .command("get")
    .description("Show the active staleness policy (built-in defaults when unset)")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const policy = await client.scanDb.stalenessPolicy();
      printResult(policy, opts.output, (raw) => {
        const p = raw as typeof policy;
        return {
          softMaxAgeHours: String(p.effectiveSoftMaxAgeHours),
          hardMaxAgeHours: String(p.effectiveHardMaxAgeHours),
          isDefault: String(p.isDefault),
          updatedAt: p.updatedAt
        };
      });
    });

  stalenessCmd
    .command("set")
    .description(
      "Author the staleness policy (OPERATOR ONLY — SCP_OPERATOR_TOKEN; omit a bound to reset it to the built-in default)"
    )
    .option(
      "--soft-max-age-hours <n>",
      "soft max age in hours (WARN beyond this); omit to reset to default"
    )
    .option(
      "--hard-max-age-hours <n>",
      "hard max age in hours (FAIL CLOSED beyond this); omit to reset to default"
    )
    .option("--note <text>", "optional note")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (
        opts: BaseCliOpts & { softMaxAgeHours?: string; hardMaxAgeHours?: string; note?: string }
      ) => {
        const operatorToken = process.env.SCP_OPERATOR_TOKEN;
        if (!operatorToken) {
          throw new Error(
            "SCP_OPERATOR_TOKEN is not set — the scan-DB staleness policy binds every org on the deployment, so authoring it requires the deployment operator token, not your tenant login."
          );
        }
        const parseHours = (v: string | undefined, flag: string): number | null => {
          if (v === undefined) return null;
          const n = Number(v);
          if (!Number.isInteger(n) || n <= 0)
            throw new Error(`${flag} must be a positive integer (got '${v}')`);
          return n;
        };
        const client = await clientFromStoredCredentials(opts);
        const policy = await client.scanDb.setStalenessPolicy(
          {
            softMaxAgeHours: parseHours(opts.softMaxAgeHours, "--soft-max-age-hours"),
            hardMaxAgeHours: parseHours(opts.hardMaxAgeHours, "--hard-max-age-hours"),
            ...(opts.note !== undefined ? { note: opts.note } : {})
          },
          operatorToken
        );
        printResult(policy, opts.output, (raw) => {
          const p = raw as typeof policy;
          return {
            softMaxAgeHours: String(p.effectiveSoftMaxAgeHours),
            hardMaxAgeHours: String(p.effectiveHardMaxAgeHours),
            isDefault: String(p.isDefault),
            updatedAt: p.updatedAt
          };
        });
      }
    );

  scanDbCmd
    .command("refresh")
    .description(
      "Connected refresh — skopeo-pull the upstream OCI trivy-db into the cache (OPERATOR ONLY — SCP_OPERATOR_TOKEN; allowlisted, atomic swap, schema-compat asserted)"
    )
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (opts: BaseCliOpts) => {
      const operatorToken = process.env.SCP_OPERATOR_TOKEN;
      if (!operatorToken) {
        throw new Error(
          "SCP_OPERATOR_TOKEN is not set — refreshing the deployment's scan DB is an operator action."
        );
      }
      const client = await clientFromStoredCredentials(opts);
      const result = await client.scanDb.refresh(operatorToken);
      printResult(result, opts.output, (raw) => scanDbOutcomeRow(raw as typeof result));
    });

  scanDbCmd
    .command("load")
    .description(
      "Air-gap load — verify + install a cosign-signed DB blob from server-local paths (OPERATOR ONLY — SCP_OPERATOR_TOKEN; digest-bound + detached-signature verify before accept)"
    )
    .requiredOption(
      "--file <path>",
      "server-local path to the DB blob (tar of the trivy cache db/ dir)"
    )
    .requiredOption("--sig <path>", "server-local path to the cosign detached signature")
    .requiredOption("--pubkey <path>", "server-local path to the operator's cosign public key PEM")
    .option("--digest <sha256>", "optional sha256:<hex> the blob bytes must hash to")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (
        opts: BaseCliOpts & { file: string; sig: string; pubkey: string; digest?: string }
      ) => {
        const operatorToken = process.env.SCP_OPERATOR_TOKEN;
        if (!operatorToken) {
          throw new Error(
            "SCP_OPERATOR_TOKEN is not set — loading a scan DB across the air gap is an operator action."
          );
        }
        const client = await clientFromStoredCredentials(opts);
        const result = await client.scanDb.load(
          {
            blobPath: opts.file,
            signaturePath: opts.sig,
            publicKeyPath: opts.pubkey,
            ...(opts.digest ? { expectedDigest: opts.digest } : {})
          },
          operatorToken
        );
        printResult(result, opts.output, (raw) => scanDbOutcomeRow(raw as typeof result));
      }
    );

  // -------------------------------------------------------------------------------------
  // dependency-subscriptions (M21.3 — ADR-0032 §3a, §6). Enablement is a monotone AND:
  //
  //     effective_enabled(component, line) =
  //         instance_unlocked  AND  component_enabled  AND  NOT line_opted_out
  //
  // `unlock` is an ordinary read (a team whose subscription is inert because the DEPLOYMENT never
  // opened the feature must be able to see that — charter principle 6); `set-unlock` binds every org
  // and is an OPERATOR action gated by SCP_OPERATOR_TOKEN, never a tenant role. `resolve` is the
  // explainability surface: it prints the verdict AND the per-tier contributions that produced it.
  //
  // THERE IS NO `subscribe` VERB, AND ONE MUST NOT BE ADDED. A dependency subscription IS a
  // `dependencySubscription` effect on an ordinary `policy` object (ADR-0032 §3a), so it is authored
  // with `scp policy register` — the same command, versioning and federation path every other policy
  // uses. `scp dependency-subscriptions --help` says so out loud, because the first thing someone
  // will look for here is the verb that does not exist.
  // -------------------------------------------------------------------------------------
  const depSubsCmd = program
    .command("dependency-subscriptions")
    .description(
      "Dependency subscriptions (ADR-0032 §6) — the instance unlock and the (component, line) enablement resolution. Subscriptions THEMSELVES are policy effects: author them with `scp policy register` carrying effects: [{ dependencySubscription: { enabled: true } }]"
    );

  depSubsCmd
    .command("unlock")
    .description(
      "Show the instance-scoped unlock — the first conjunct. It UNLOCKS and never activates: with no enabling policy, unlocked subscribes zero components"
    )
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const unlock = await client.dependencySubscriptions.unlock();
      printResult(unlock, opts.output, (raw) =>
        dependencySubscriptionUnlockRow(raw as DependencySubscriptionUnlock)
      );
    });

  depSubsCmd
    .command("set-unlock")
    .description(
      "Set the instance-scoped unlock (OPERATOR ONLY — SCP_OPERATOR_TOKEN; it binds every org on the deployment, and unlocking activates nothing on its own)"
    )
    // Two explicit, mutually exclusive flags rather than one `--unlocked <bool>`: absent never means
    // enabled (ADR-0032 §6), and a defaulted boolean flag is exactly how an omission becomes a value.
    .option("--unlocked", "permit dependency subscriptions on this deployment")
    .option("--locked", "refuse dependency subscriptions on this deployment")
    .option("--note <text>", "free-text note recorded with the unlock")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (opts: BaseCliOpts & { unlocked?: boolean; locked?: boolean; note?: string }) => {
      const operatorToken = process.env.SCP_OPERATOR_TOKEN;
      if (!operatorToken) {
        throw new Error(
          "SCP_OPERATOR_TOKEN is not set — the dependency-subscription unlock binds every org on the deployment, so setting it requires the deployment operator token, not your tenant login."
        );
      }
      if (opts.unlocked === opts.locked) {
        throw new Error("pass exactly one of --unlocked or --locked");
      }
      const client = await clientFromStoredCredentials(opts);
      const unlock = await client.dependencySubscriptions.setUnlock(
        {
          unlocked: opts.unlocked === true,
          ...(opts.note !== undefined ? { note: opts.note } : {})
        },
        operatorToken
      );
      printResult(unlock, opts.output, (raw) =>
        dependencySubscriptionUnlockRow(raw as DependencySubscriptionUnlock)
      );
    });

  depSubsCmd
    .command("resolve")
    .description(
      "Resolve whether a component is subscribed to one dependency line, and print WHICH level decided it (ADR-0032 §6)"
    )
    .requiredOption("--component <idOrUrn>", "component id or URN")
    .requiredOption("--ecosystem <ecosystem>", "npm|go|maven|python|oci")
    .requiredOption(
      "--coordinate <coordinate>",
      "the ecosystem-native coordinate, VERBATIM (`@acme/lib`, `github.com/acme/lib`, `com.acme:lib`, `docker.io/library/alpine`) — never slugified, so case and punctuation matter"
    )
    .requiredOption(
      "--major <line>",
      "the major line as the ecosystem spells it (`1`, `v2`, `3.18`)"
    )
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (
        opts: BaseCliOpts & {
          component: string;
          ecosystem: string;
          coordinate: string;
          major: string;
        }
      ) => {
        const client = await clientFromStoredCredentials(opts);
        const response = await client.dependencySubscriptions.resolve(opts.component, {
          // Validated server-side by the shared `DependencyLineKeySchema` (a bad ecosystem is a 400
          // naming the enum); cast rather than duplicate the list, so a sixth ecosystem is not a
          // third place to edit.
          ecosystem: opts.ecosystem as DependencyEcosystem,
          coordinate: opts.coordinate,
          major: opts.major
        });
        if (opts.output === "json") {
          console.log(JSON.stringify(response, null, 2));
          return;
        }
        printResult(response, "table", (raw) =>
          dependencySubscriptionResolutionRow(raw as DependencySubscriptionResolutionResponse)
        );
        // AND SAY IT IN WORDS WHEN NOTHING HERE WILL ACT ON THE VERDICT (ADR-0032 §7d). Both the
        // condition and the sentence live in `dependencyManagementNote`, outside this closure, so
        // they are reachable by a test — inline here, inverting the condition was fully green.
        const note = dependencyManagementNote(response.dependencyManagement);
        if (note !== undefined) {
          console.log("");
          console.log(note);
        }
        // THE CONTRIBUTIONS ARE THE POINT (charter principle 6). Printed as their own table rather
        // than squeezed into a cell — "which level turned this off" is the question this command
        // exists to answer, and the verdict alone does not answer it.
        console.log("");
        console.log("CONTRIBUTIONS (top-down; a disable always wins, at any tier):");
        printResult(response.resolution.contributions, "table", (raw) =>
          dependencySubscriptionContributionRow(raw as DependencySubscriptionContribution)
        );
      }
    );

  // M21.2 (ADR-0032 §4) — the inventory backfill.
  //
  // Ingestion is event-driven: an accepted, correlated change re-reads its component's dependency
  // manifests. That covers components that RELEASE and nothing else, so an existing estate — and any
  // component that has not pushed since it was enabled — needs this once. Idempotent, so running it
  // twice is a no-op, and it reports every skip rather than a bare count.
  //
  // POINT IT AT THE COMMANDER. All dependency automation is commander-only (ADR-0032 §7d), so an
  // instance whose `SCP_FEDERATION_ROLE` is not an explicitly declared `commander` answers 409 with
  // a detail naming why — including the fail-closed case where the role was never declared at all.
  // It is said in the description because that 409 is a mistake an operator makes when choosing
  // `--base-url`, not a mistake in the request, and the flag is right here.
  depSubsCmd
    .command("backfill-inventory")
    .description(
      "Read enabled components' dependency manifests and (re)build their inventory (ADR-0032 §4). Idempotent. A component with no enabling subscription is REFUSED BEFORE ITS REPO IS READ — this command cannot bypass the enablement chain. COMMANDER-ONLY: run it against the commander; an outpost, or a deployment that never declared its federation role, answers 409"
    )
    // Repeatable rather than comma-separated: a component URN legitimately contains punctuation, and
    // the existing repeatable flags on `scp change create` set the precedent.
    .option(
      "--component <idOrUrn>",
      "limit to this component (repeatable); omit for every component in the org",
      (value: string, previous: string[] = []) => [...previous, value]
    )
    .option(
      "--ref <ref>",
      "ref to read the manifests at (default: HEAD, i.e. the repo's own default branch)"
    )
    // The run holds LIVE provider I/O for every component it fetches for, inline in one request, so
    // it is bounded by default. A whole-org backfill is therefore several invocations rather than
    // one that times out; `notAttempted` in the receipt says how much is left.
    .option(
      "--fetch-budget <n>",
      "how many components this run may FETCH for before reporting the rest as not attempted (default: 25)"
    )
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (opts: BaseCliOpts & { component?: string[]; ref?: string; fetchBudget?: string }) => {
        const client = await clientFromStoredCredentials(opts);
        const response = await client.dependencySubscriptions.backfillInventory({
          ...(opts.component !== undefined ? { componentIdsOrUrns: opts.component } : {}),
          ...(opts.ref !== undefined ? { ref: opts.ref } : {}),
          ...(opts.fetchBudget !== undefined ? { fetchBudget: Number(opts.fetchBudget) } : {})
        });
        if (opts.output === "json") {
          console.log(JSON.stringify(response, null, 2));
          return;
        }
        console.log(
          `ref ${response.ref}: ${response.ingested} ingested, ${response.notEnabled} not enabled, ` +
            `${response.notAddressable} not addressable, ${response.superseded} superseded, ` +
            `${response.notAttempted} not attempted (budget), ` +
            `${response.declarationsPruned} declaration(s) pruned`
        );
        // EVERY COMPONENT IS PRINTED, refusals included. "Nothing happened for 400 of your
        // components, and here is why" is the answer an operator running a backfill needs; a
        // summary that showed only successes would make an unsubscribed estate look like a broken
        // command.
        printResult(response.components, "table", (raw) =>
          dependencyInventoryBackfillRow(raw as DependencyInventoryBackfillComponent)
        );
      }
    );

  // M21.6 — the component-scoped dependency READ surface: what a component DECLARES (its inventory
  // rows, each with the line's observed head and its resolved dependency subscription), and the
  // bumps SCP authored for it. Two READ verbs; neither authors anything, so the closed list in
  // dependency-subscription-cli.test.ts grows by exactly these two and still has no `subscribe`.
  depSubsCmd
    .command("inventory")
    .description(
      "Show a component's dependency inventory — one row per (major line × dependency manifest) with the line's observed head and the resolved dependency subscription for THIS caller. The ingestion stamp says whether the manifests were ever read (never attempted / ok / partial / unreadable / not enabled) — an empty table is NOT RECORDED as 'no dependencies' without it. On a deployment that does not manage dependencies (an outpost) only the posture is printed"
    )
    .requiredOption("--component <idOrUrn>", "component id or URN")
    .option(
      "--ecosystem <ecosystem>",
      "show only this ecosystem's rows (npm|go|maven|python|oci); a display filter over the fetched page"
    )
    .option("--limit <n>", "rows per page (default 100, max 200)")
    .option("--cursor <cursor>", "continue from a previous page's nextCursor")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (
        opts: BaseCliOpts & {
          component: string;
          ecosystem?: string;
          limit?: string;
          cursor?: string;
        }
      ) => {
        const client = await clientFromStoredCredentials(opts);
        const response = await client.dependencySubscriptions.inventory(opts.component, {
          ...(opts.limit !== undefined ? { limit: Number(opts.limit) } : {}),
          ...(opts.cursor !== undefined ? { cursor: opts.cursor } : {})
        });
        // A DISPLAY filter, applied after the read: the route pages by line id and has no
        // ecosystem query, so filtering here narrows what is shown, not what was fetched.
        const rows =
          opts.ecosystem === undefined
            ? response.rows
            : response.rows.filter((r) => r.line.ecosystem === opts.ecosystem);
        if (opts.output === "json") {
          console.log(JSON.stringify({ ...response, rows }, null, 2));
          return;
        }
        // NOT MANAGED HERE (ADR-0032 §7d): the component line, the posture, and NOTHING ELSE —
        // no stamp, no gate, no table. The envelope below the posture is not to be interpreted.
        const notManaged = dependencyReadNotManagedLine(response.dependencyManagement);
        if (notManaged !== undefined) {
          console.log(`component: ${response.component.name} (${response.component.id})`);
          console.log(notManaged);
          return;
        }
        for (const line of dependencyInventoryHeaderLines(response)) console.log(line);
        console.log("");
        if (rows.length === 0) {
          // AN EMPTY PAGE IS NOT "NO DEPENDENCIES". Beside a null stamp (never attempted) it is
          // UNKNOWN; beside an `ok` stamp with 0 rows written it is "declared nothing" — the
          // ingestion line above already said which.
          console.log(
            "(no rows on record — read the ingestion line above before reading this as 'no dependencies')"
          );
        } else {
          printResult(rows, "table", (raw) =>
            dependencyInventoryRow(raw as ComponentDependencyInventoryRow)
          );
        }
        if (!isAbsent(response.nextCursor)) {
          console.log("");
          console.log(`more rows: --cursor ${response.nextCursor}`);
        }
      }
    );

  depSubsCmd
    .command("bumps")
    .description(
      "Show the bumps SCP authored for a component, newest dispatch first — PR number, merge time and the merge gate's verdict. A PR link is printed only when the server stored one; it is never composed from repo + number"
    )
    .requiredOption("--component <idOrUrn>", "component id or URN")
    .option("--limit <n>", "rows per page (default 100, max 200)")
    .option("--cursor <cursor>", "continue from a previous page's nextCursor")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (opts: BaseCliOpts & { component: string; limit?: string; cursor?: string }) => {
      const client = await clientFromStoredCredentials(opts);
      const response: ComponentDependencyBumpsResponse = await client.dependencySubscriptions.bumps(
        opts.component,
        {
          ...(opts.limit !== undefined ? { limit: Number(opts.limit) } : {}),
          ...(opts.cursor !== undefined ? { cursor: opts.cursor } : {})
        }
      );
      if (opts.output === "json") {
        console.log(JSON.stringify(response, null, 2));
        return;
      }
      console.log(`component: ${response.component.name} (${response.component.id})`);
      // NOT MANAGED HERE (ADR-0032 §7d): bumps are dispatched by a declared commander only, so on
      // an outpost (or an undeclared role) the list is empty BY CONSTRUCTION and a table of it would
      // read as "up to date". Say the posture and stop.
      const notManaged = dependencyReadNotManagedLine(response.dependencyManagement);
      if (notManaged !== undefined) {
        console.log(notManaged);
        return;
      }
      printResult(response.rows, "table", (raw) =>
        dependencyBumpRow(raw as ComponentDependencyBump)
      );
      if (!isAbsent(response.nextCursor)) {
        console.log("");
        console.log(`more rows: --cursor ${response.nextCursor}`);
      }
    });

  // -------------------------------------------------------------------------------------
  // governance move-enforcement (governance-reach-on-containment-move.md §9.2, owner ruling
  // 2026-08-18) — the `governance:move` LATTICE: a top-down monotone OR of enabled RUNGS (the
  // instance, or one container object — org root, containment domain, service, assembly) that
  // decides whether a containment move ALSO requires `governance:move`, at-or-above BOTH the moved
  // object and the destination. Nothing is enforced until a rung is enabled — every deployment
  // ships with none, and `status`/`rungs` say so honestly.
  //
  // AN UPPER RUNG CANNOT BE UNDONE BELOW IT. `disable` answers 409 while an ancestor's rung (or the
  // instance rung) is still enabled, naming it — see `governanceMoveRungWriteRow`'s note on why a
  // "successful" disable that left the subtree enforced anyway would be worse than refusing.
  //
  // THE INSTANCE RUNG IS OPERATOR-ONLY (SCP_OPERATOR_TOKEN) — never a tenant role — because it
  // ACTIVATES enforcement for every org on the deployment (owner ruling Q1-A; contrast the
  // dependency-subscription unlock, which only PERMITS). `rungs`/`status`/`instance get` are
  // ordinary tenant reads; `enable`/`disable` need `policy:write` at-or-above the subject.
  // -------------------------------------------------------------------------------------
  const governanceCmd = program
    .command("governance")
    .description(
      "The governance:move enforcement lattice (governance-reach-on-containment-move.md §9.2) — an opt-in second permission bar on containment moves"
    );

  const moveEnforcementCmd = governanceCmd
    .command("move-enforcement")
    .description(
      "A top-down monotone OR of enabled rungs (instance, org root, containment domain, service, assembly) that decides whether a containment move additionally requires governance:move at both ends. Enforced iff the instance rung is enabled or the moved object's OR the destination's containment chain carries a rung"
    );

  moveEnforcementCmd
    .command("status <type> <idOrUrn>")
    .description(
      "Explain whether moves of ONE object are governed, and by which rung(s) — a move has TWO ends, so `enforced: false` here is not a promise that a particular move is ungoverned; the destination's own chain is ORed in at the door"
    )
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (type: string, idOrUrn: string, opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const enforcement = await client.governanceMove.enforcement(type, idOrUrn);
      if (opts.output === "json") {
        console.log(JSON.stringify(enforcement, null, 2));
        return;
      }
      printResult(enforcement, "table", (raw) =>
        governanceMoveEnforcementRow(raw as GovernanceMoveEnforcement)
      );
      console.log("");
      console.log("RUNGS ON THIS OBJECT'S CONTAINMENT CHAIN (org-root-first):");
      printResult(enforcement.rungs, "table", (raw) =>
        governanceMoveRungRow(raw as GovernanceMoveRung)
      );
    });

  moveEnforcementCmd
    .command("rungs")
    .description(
      "List every governance:move rung enabled in this org, plus the instance rung's state — the whole lattice this org can act on, in one call"
    )
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const list = await client.governanceMove.rungs();
      if (opts.output === "json") {
        console.log(JSON.stringify(list, null, 2));
        return;
      }
      console.log(
        `instance rung: ${
          list.instance.enabled
            ? "enabled — ACTIVATES governance:move enforcement for every org on this deployment"
            : "disabled"
        }`
      );
      console.log("");
      printResult(list.rungs, "table", (raw) => governanceMoveRungRow(raw as GovernanceMoveRung));
    });

  moveEnforcementCmd
    .command("enable <idOrUrn>")
    .description(
      "Enable governance:move enforcement at one container (org root, containment domain, service or assembly) — every containment move of an object under it then requires governance:move at-or-above the object AND at-or-above the destination. Idempotent. Requires policy:write at-or-above the subject"
    )
    .option("--note <text>", "why the rung was enabled — recorded with the enable Decision")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (idOrUrn: string, opts: BaseCliOpts & { note?: string }) => {
      const client = await clientFromStoredCredentials(opts);
      const response = await client.governanceMove.enable(idOrUrn, {
        ...(opts.note !== undefined ? { note: opts.note } : {})
      });
      printResult(response, opts.output, (raw) =>
        governanceMoveRungWriteRow(raw as GovernanceMoveRungWriteResponse)
      );
    });

  moveEnforcementCmd
    .command("disable <idOrUrn>")
    .description(
      "Disable governance:move enforcement at one container. Refused 409 while an upper rung (an ancestor's, or the instance rung) is enabled, naming it — an enablement above cannot be undone below. Requires policy:write at-or-above the subject"
    )
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (idOrUrn: string, opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const response = await client.governanceMove.disable(idOrUrn);
      printResult(response, opts.output, (raw) =>
        governanceMoveRungWriteRow(raw as GovernanceMoveRungWriteResponse)
      );
    });

  const governanceMoveInstanceCmd = moveEnforcementCmd
    .command("instance")
    .description(
      "The instance (commander) rung — the deployment-wide top of the lattice. It ACTIVATES (owner ruling Q1-A): enabled here means every org on this deployment enforces governance:move on containment moves, and no org may disable it"
    );

  governanceMoveInstanceCmd
    .command("get")
    .description("Show the instance rung — an ordinary tenant read")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const instance = await client.governanceMove.instance();
      printResult(instance, opts.output, (raw) =>
        governanceMoveInstanceRow(raw as GovernanceMoveInstanceRung)
      );
    });

  governanceMoveInstanceCmd
    .command("set")
    .description(
      "Set the instance rung (OPERATOR ONLY — requires SCP_OPERATOR_TOKEN; it activates governance:move enforcement for every org on the deployment, and no org may disable it)"
    )
    .requiredOption("--enabled <bool>", "true|false")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (opts: BaseCliOpts & { enabled: string }) => {
      const operatorToken = process.env.SCP_OPERATOR_TOKEN;
      if (!operatorToken) {
        throw new Error(
          "SCP_OPERATOR_TOKEN is not set — the instance governance:move rung binds every org on the deployment, so setting it requires the deployment operator token, not your tenant login."
        );
      }
      if (opts.enabled !== "true" && opts.enabled !== "false") {
        throw new Error("--enabled must be exactly 'true' or 'false'");
      }
      const client = await clientFromStoredCredentials(opts);
      const instance = await client.governanceMove.setInstance(
        { enabled: opts.enabled === "true" },
        operatorToken
      );
      printResult(instance, opts.output, (raw) =>
        governanceMoveInstanceRow(raw as GovernanceMoveInstanceRung)
      );
    });

  // -------------------------------------------------------------------------------------
  // dependency-producers (ADR-0032 §7e) — WHICH COORDINATES THIS ORG PUBLISHES.
  //
  // This is the switch between two entirely different head ingresses. A DECLARED coordinate's
  // versions come from the org's own production releases; an undeclared one's are fetched from a
  // public index. Getting it wrong fails in both directions and both are silent:
  //
  //   - declare a coordinate you do NOT publish -> it leaves the third-party poll permanently, and
  //     every subscriber stops receiving upstream versions INCLUDING SECURITY RELEASES. There is no
  //     error, because the failure is an absence.
  //   - fail to declare one you DO publish -> the coordinate is polled against a public index, and
  //     a stranger's package answering `9.9.9` bumps every subscriber onto it, on a daily timer.
  //
  // SO `--dry-run` IS ON BOTH WRITE VERBS AND IS THE FIRST THING TO REACH FOR. It prints the same
  // blast radius and writes nothing.
  //
  // THERE IS NO `--producer none`. Retraction is its own subcommand: a flag that switches a verb
  // between declaring and undeclaring is how an omitted value becomes a destructive default.
  //
  // POINT IT AT THE COMMANDER. The writes are commander-only (ADR-0032 §7d) and answer 409
  // elsewhere; the read works anywhere but is empty by design on a field outpost.
  // -------------------------------------------------------------------------------------
  const depProducersCmd = program
    .command("dependency-producers")
    .description(
      "Declared dependency-line producers (ADR-0032 §7e) — which COMPONENT this org publishes which coordinate from. A declared coordinate is INTERNAL: its versions are derived from the org's own production releases instead of a public index. Requires 'policy:write' at the ORG ROOT, because the declaration changes behaviour for every component in the org that depends on the coordinate"
    );

  depProducersCmd
    .command("list")
    .description(
      "List this org's declared producers. Narrowable by ecosystem or to one exact coordinate (compared VERBATIM). On a field outpost the list is EMPTY BY DESIGN — declarations live at the commander"
    )
    .option("--ecosystem <ecosystem>", "npm|go|maven|python|oci")
    .option(
      "--coordinate <coordinate>",
      "one exact coordinate, VERBATIM — never slugified, so case and punctuation matter"
    )
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (opts: BaseCliOpts & { ecosystem?: string; coordinate?: string }) => {
      const client = await clientFromStoredCredentials(opts);
      const response = await client.dependencyProducers.list({
        ...(opts.ecosystem !== undefined
          ? { ecosystem: opts.ecosystem as DependencyEcosystem }
          : {}),
        ...(opts.coordinate !== undefined ? { coordinate: opts.coordinate } : {})
      });
      if (opts.output === "json") {
        console.log(JSON.stringify(response, null, 2));
        return;
      }
      printResult(response.producers, "table", (raw) =>
        dependencyProducerListRow(raw as DependencyLineProducerView)
      );
      // The condition and the sentence live in `dependencyProducerManagementNote`, OUTSIDE this
      // closure, so both arms are reachable by a test — the M21.7 lesson: an inline caveat whose
      // condition is inverted warns the wrong deployment and leaves the suite green.
      const note = dependencyProducerManagementNote(response.dependencyManagement);
      if (note !== undefined) {
        console.log("");
        console.log(note);
      }
    });

  depProducersCmd
    .command("declare")
    .description(
      "Declare that a component produces a coordinate. Prints the BLAST RADIUS — every major line covered, its observed head, and how many components are subscribed. CLEARS each line's observed head, so a poisoned public head does not survive the declaration that exists to undo it. A service is refused: head derivation reads the COMPONENT a production placement names"
    )
    .requiredOption("--ecosystem <ecosystem>", "npm|go|maven|python|oci")
    .requiredOption(
      "--coordinate <coordinate>",
      "the ecosystem-native coordinate, VERBATIM (`@acme/lib`, `github.com/acme/lib`, `com.acme:lib`, `docker.io/library/alpine`)"
    )
    .requiredOption("--producer <idOrUrn>", "the producing COMPONENT's id or URN")
    // Argument-LESS, and with no default: a `--dry-run <bool>` is how "the operator said nothing"
    // silently becomes a value, and here the two values are "look" and "change every subscriber's
    // upstream".
    .option("--dry-run", "compute and print the blast radius; write nothing")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (
        opts: BaseCliOpts & {
          ecosystem: string;
          coordinate: string;
          producer: string;
          dryRun?: boolean;
        }
      ) => {
        const client = await clientFromStoredCredentials(opts);
        const response = await client.dependencyProducers.declare({
          // Validated server-side by the shared `DependencyEcosystemSchema` (a bad value is a 400
          // naming the enum); cast rather than duplicate the list here.
          ecosystem: opts.ecosystem as DependencyEcosystem,
          coordinate: opts.coordinate,
          producerIdOrUrn: opts.producer,
          ...(opts.dryRun === true ? { dryRun: true } : {})
        });
        printProducerVerbResult(response, opts.output);
      }
    );

  depProducersCmd
    .command("retract")
    .description(
      "Retract a producer declaration and return the coordinate to third-party polling. CLEARS each covered line's observed head — a head the org's own releases put there would otherwise wedge the line, and it is an input to the M22 vendor scan rule. Prints the bumps still in flight, which SCP does NOT close"
    )
    .requiredOption("--ecosystem <ecosystem>", "npm|go|maven|python|oci")
    .requiredOption("--coordinate <coordinate>", "the coordinate, VERBATIM")
    .option("--dry-run", "compute and print the blast radius; write nothing")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (opts: BaseCliOpts & { ecosystem: string; coordinate: string; dryRun?: boolean }) => {
        const client = await clientFromStoredCredentials(opts);
        const response = await client.dependencyProducers.retract({
          ecosystem: opts.ecosystem as DependencyEcosystem,
          coordinate: opts.coordinate,
          ...(opts.dryRun === true ? { dryRun: true } : {})
        });
        printProducerVerbResult(response, opts.output);
      }
    );

  // federation (M6 Federation Basics — DESIGN.md §13, BUILD_AND_TEST.md §8 M6). `export`/`import`
  // work on `.scpbundle` files on disk (the built-in file transport — "the air gap is the design
  // center", §13) so they're the ones CI's two-domain E2E drives via a real file-copy across an
  // isolated compose network. `promote` is the Promotion Bundle's own export verb — kept distinct
  // from `export` (which only ever produces sync bundles) so the CLI surface mirrors the two
  // distinct bundle kinds `packages/schemas/src/federation.ts` defines.
  //
  // `scp federation promote` KEEPS its name (ADR-0021 D1/D2/D5 scope note): it is a genuine
  // promotion — an already-built artifact advancing to the next step. The change-lifecycle
  // approval gate that used to share the word is now `scp change accept` (D5). The two verbs are
  // deliberately different words for deliberately different things; do not unify them.
  // -------------------------------------------------------------------------------------
  const federationCmd = program
    .command("federation")
    .description(
      "Manage federation (DESIGN.md §13 — signed sync journal, peer pairing, Promotion Bundles)"
    );

  federationCmd
    .command("init")
    .description("Designate this domain's federation role")
    .requiredOption("--name <name>", "this domain's display name")
    .requiredOption("--role <role>", "commander|outpost|retrans")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (opts: BaseCliOpts & { name: string; role: "commander" | "outpost" | "retrans" }) => {
        const client = await clientFromStoredCredentials(opts);
        const result = await client.federation.init({ name: opts.name, role: opts.role });
        printResult(result, opts.output, (item) => item as Record<string, unknown>);
      }
    );

  federationCmd
    .command("self")
    .description(
      "Show this domain's own federation identity + public key (copy this to a peer for out-of-band pairing)"
    )
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const self = await client.federation.self();
      printResult(self, opts.output, (item) => item as Record<string, unknown>);
    });

  federationCmd
    .command("pair")
    .description(
      "Pair a peer domain (outpost-initiated — dial the commander, or exchange identities out-of-band for air-gapped peers)"
    )
    .requiredOption(
      "--domain-id <id>",
      "the peer's federation domain id (from their `scp federation self`)"
    )
    .requiredOption("--name <name>", "a display name for the peer")
    .requiredOption(
      "--role <role>",
      "commander|outpost|retrans — the peer's role as seen from here"
    )
    .requiredOption(
      "--public-key <base64>",
      "the peer's Ed25519 public key (from their `scp federation self`)"
    )
    .option(
      "--cosign-public-key <pem>",
      "the peer's cosign verification public key (from their `scp federation self`) — registered for later manifest verification (M17.4)"
    )
    .option(
      "--base-url-of-peer <url>",
      "the peer's API base URL (outpost->commander mTLS transport only)"
    )
    .option(
      "--sync-scope <mode>",
      "full|policies_only|changes_only|status_only (custom/label-selector not exposed via CLI yet)",
      "full"
    )
    // M13.2a (§13.2) — the peer's DeliveryTarget (filesystem provider). Omitting BOTH dir flags
    // leaves any existing target untouched (re-pair-safe); --clear-delivery-target resets the peer
    // to the instance-env fallback (`SCP_RELAY_OUT_DIR`/`SCP_RELAY_IN_DIR`).
    .option(
      "--delivery-out-dir <dir>",
      "SERVER-side absolute directory where channel artifacts addressed to this peer are dropped (filesystem DeliveryTarget)"
    )
    .option(
      "--delivery-in-dir <dir>",
      "SERVER-side absolute directory where channel artifacts FROM this peer arrive (the inbox)"
    )
    // M13.2b (§13.2) — the s3-compatible provider. Requires --delivery-s3-endpoint + --delivery-s3-bucket
    // together; the endpoint/bucket must be operator-allowlisted (SCP_DELIVERY_S3_ENDPOINTS) or the pair
    // is refused. Credentials are stored separately in the vault (`delivery/<peer>/out|in`), never here.
    .option(
      "--delivery-s3-endpoint <url>",
      "S3(-compatible) endpoint for the peer's DeliveryTarget (e.g. https://minio:9000) — operator-allowlisted"
    )
    .option(
      "--delivery-s3-bucket <bucket>",
      "S3 bucket channel artifacts are put into / listed from"
    )
    .option(
      "--delivery-s3-out-prefix <prefix>",
      "S3 key prefix for outbound drops (default: bucket root)"
    )
    .option(
      "--delivery-s3-in-prefix <prefix>",
      "S3 key prefix for the inbound inbox (default: bucket root)"
    )
    .option(
      "--clear-delivery-target",
      "clear the peer's DeliveryTarget (fall back to the instance env dirs)"
    )
    // M14.1 (ADR-0009) — per-peer poke-mode. Tri-state on re-pair: omit BOTH flags to preserve the
    // current setting, --poke-mode sets it on, --no-poke-mode sets it off. Default-off. Setting it on
    // requires an https/mTLS-capable peer --base-url-of-peer (the server's pair-time guard) — the
    // poke must authenticate the caller as the enrolled commander (ADR-0001).
    .option(
      "--poke-mode",
      "enable poke-mode for this peer — the commander MAY send it a contentless wake signal; requires an https/mTLS peer base URL"
    )
    .option("--no-poke-mode", "disable poke-mode for this peer (poll-mode — the default)")
    .option("--base-url <url>", "this domain's own API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (
        opts: BaseCliOpts & {
          domainId: string;
          name: string;
          role: "commander" | "outpost" | "retrans";
          publicKey: string;
          cosignPublicKey?: string;
          baseUrlOfPeer?: string;
          syncScope: string;
          deliveryOutDir?: string;
          deliveryInDir?: string;
          deliveryS3Endpoint?: string;
          deliveryS3Bucket?: string;
          deliveryS3OutPrefix?: string;
          deliveryS3InPrefix?: string;
          clearDeliveryTarget?: boolean;
          // M14.1 tri-state: undefined = neither flag = preserve; true = --poke-mode; false =
          // --no-poke-mode. Commander leaves it undefined when neither flag is present because both
          // --poke-mode and --no-poke-mode are declared (no default).
          pokeMode?: boolean;
        }
      ) => {
        const hasFs = Boolean(opts.deliveryOutDir || opts.deliveryInDir);
        const hasS3 = Boolean(
          opts.deliveryS3Endpoint ||
          opts.deliveryS3Bucket ||
          opts.deliveryS3OutPrefix ||
          opts.deliveryS3InPrefix
        );
        if (opts.clearDeliveryTarget && (hasFs || hasS3)) {
          throw new Error("--clear-delivery-target cannot be combined with any --delivery-* flag");
        }
        if (hasFs && hasS3) {
          throw new Error(
            "a DeliveryTarget is one provider: use EITHER --delivery-out-dir/--delivery-in-dir (filesystem) OR the --delivery-s3-* flags"
          );
        }
        if (hasS3 && !(opts.deliveryS3Endpoint && opts.deliveryS3Bucket)) {
          throw new Error(
            "the s3-compatible DeliveryTarget requires BOTH --delivery-s3-endpoint and --delivery-s3-bucket"
          );
        }
        const client = await clientFromStoredCredentials(opts);
        const syncScope = { mode: opts.syncScope } as SyncScope;
        // Tri-state (mirrors the API's re-pair discipline): undefined preserves any existing
        // target, an object sets it, explicit null clears it.
        const deliveryTarget: DeliveryTarget | null | undefined = opts.clearDeliveryTarget
          ? null
          : hasS3
            ? {
                provider: "s3-compatible",
                endpoint: opts.deliveryS3Endpoint as string,
                bucket: opts.deliveryS3Bucket as string,
                ...(opts.deliveryS3OutPrefix ? { outPrefix: opts.deliveryS3OutPrefix } : {}),
                ...(opts.deliveryS3InPrefix ? { inPrefix: opts.deliveryS3InPrefix } : {})
              }
            : hasFs
              ? {
                  provider: "filesystem",
                  ...(opts.deliveryOutDir ? { outDir: opts.deliveryOutDir } : {}),
                  ...(opts.deliveryInDir ? { inDir: opts.deliveryInDir } : {})
                }
              : undefined;
        const peer = await client.federation.pair({
          domainId: opts.domainId,
          name: opts.name,
          role: opts.role,
          publicKey: opts.publicKey,
          cosignPublicKey: opts.cosignPublicKey,
          baseUrl: opts.baseUrlOfPeer,
          syncScope,
          deliveryTarget,
          // M14.1 tri-state: undefined preserves, true/false sets (see the flag declarations).
          pokeMode: opts.pokeMode
        });
        printResult(peer, opts.output, (item) => peerRow(item as FederationPeer));
      }
    );

  // -----------------------------------------------------------------------------------------
  // M16.2 phase A (E4) — `scp federation peer-update`: the NARROW, TRANSPORT-ONLY peer edit.
  //
  // DELIBERATELY A SEPARATE COMMAND FROM `pair`, not a flag on it. `pair` is a re-pair: it REQUIRES
  // `--public-key`, and a different value there is a KEY ROTATION that supersedes the peer's current
  // key window and hard-revokes the old key. This command takes no key flag at all, so "I just want to
  // fix the base URL" can never become a trust-anchor rotation. Rotating a key remains an explicit
  // `scp federation pair --public-key <new>`.
  // -----------------------------------------------------------------------------------------
  federationCmd
    .command("peer-update")
    .description(
      "Update a peer's TRANSPORT settings only (name/base URL/sync scope/delivery target/poke-mode) — never key material"
    )
    .argument("<idOrName>", "the peer's trust-domain id or name")
    .option("--name <name>", "a new display name for the peer")
    .option("--base-url-of-peer <url>", "the peer's API base URL")
    .option("--sync-scope <mode>", "full|policies_only|changes_only|status_only")
    .option("--delivery-out-dir <dir>", "SERVER-side absolute outbound drop directory")
    .option("--delivery-in-dir <dir>", "SERVER-side absolute inbound intake directory")
    .option("--delivery-s3-endpoint <url>", "S3(-compatible) endpoint — operator-allowlisted")
    .option("--delivery-s3-bucket <bucket>", "S3 bucket for channel artifacts")
    .option("--delivery-s3-out-prefix <prefix>", "S3 key prefix for outbound drops")
    .option("--delivery-s3-in-prefix <prefix>", "S3 key prefix for the inbound inbox")
    .option("--clear-delivery-target", "clear the peer's DeliveryTarget (instance-env fallback)")
    .option("--poke-mode", "enable poke-mode (requires an https/mTLS peer base URL)")
    .option("--no-poke-mode", "disable poke-mode (poll-mode)")
    .option("--base-url <url>", "this domain's own API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (
        idOrName: string,
        opts: BaseCliOpts & {
          name?: string;
          baseUrlOfPeer?: string;
          syncScope?: string;
          deliveryOutDir?: string;
          deliveryInDir?: string;
          deliveryS3Endpoint?: string;
          deliveryS3Bucket?: string;
          deliveryS3OutPrefix?: string;
          deliveryS3InPrefix?: string;
          clearDeliveryTarget?: boolean;
          pokeMode?: boolean;
        }
      ) => {
        const hasFs = Boolean(opts.deliveryOutDir || opts.deliveryInDir);
        const hasS3 = Boolean(
          opts.deliveryS3Endpoint ||
          opts.deliveryS3Bucket ||
          opts.deliveryS3OutPrefix ||
          opts.deliveryS3InPrefix
        );
        if (opts.clearDeliveryTarget && (hasFs || hasS3)) {
          throw new Error("--clear-delivery-target cannot be combined with any --delivery-* flag");
        }
        if (hasFs && hasS3) {
          throw new Error(
            "a DeliveryTarget is one provider: use EITHER --delivery-out-dir/--delivery-in-dir (filesystem) OR the --delivery-s3-* flags"
          );
        }
        if (hasS3 && !(opts.deliveryS3Endpoint && opts.deliveryS3Bucket)) {
          throw new Error(
            "the s3-compatible DeliveryTarget requires BOTH --delivery-s3-endpoint and --delivery-s3-bucket"
          );
        }
        const client = await clientFromStoredCredentials(opts);
        const deliveryTarget: DeliveryTarget | null | undefined = opts.clearDeliveryTarget
          ? null
          : hasS3
            ? {
                provider: "s3-compatible",
                endpoint: opts.deliveryS3Endpoint as string,
                bucket: opts.deliveryS3Bucket as string,
                ...(opts.deliveryS3OutPrefix ? { outPrefix: opts.deliveryS3OutPrefix } : {}),
                ...(opts.deliveryS3InPrefix ? { inPrefix: opts.deliveryS3InPrefix } : {})
              }
            : hasFs
              ? {
                  provider: "filesystem",
                  ...(opts.deliveryOutDir ? { outDir: opts.deliveryOutDir } : {}),
                  ...(opts.deliveryInDir ? { inDir: opts.deliveryInDir } : {})
                }
              : undefined;
        // Absent means PRESERVE on every field — the same tri-state the API applies, so a partial
        // edit can never blank a setting the operator did not mention.
        const req: UpdateFederationPeerRequest = {
          ...(opts.name !== undefined ? { name: opts.name } : {}),
          ...(opts.baseUrlOfPeer !== undefined ? { baseUrl: opts.baseUrlOfPeer } : {}),
          ...(opts.syncScope !== undefined
            ? { syncScope: { mode: opts.syncScope } as SyncScope }
            : {}),
          ...(deliveryTarget !== undefined ? { deliveryTarget } : {}),
          ...(opts.pokeMode !== undefined ? { pokeMode: opts.pokeMode } : {})
        };
        const peer = await client.federation.updatePeer(idOrName, req);
        printResult(peer, opts.output, (item) => peerRow(item as FederationPeer));
      }
    );

  federationCmd
    .command("peer")
    .description("Show one paired federation peer")
    .argument("<idOrName>", "the peer's trust-domain id or name")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (idOrName: string, opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const peer = await client.federation.getPeer(idOrName);
      printResult(peer, opts.output, (item) => peerRow(item as FederationPeer));
    });

  // -----------------------------------------------------------------------------------------
  // M16.2 phase A (E1) — `outpost` config objects: the commander-authored declared config that SYNCS
  // DOWN (a peer ROW never can — the journal has no peer-shaped entry kind). Commander-side commands;
  // on an outpost these read the local read-only replica, and a write there is refused with 409.
  // -----------------------------------------------------------------------------------------
  const outpostCmd = federationCmd
    .command("outpost")
    .description(
      "Commander-origin outpost config objects (trust tier) that sync down to the outpost"
    );

  // THE HELP TEXT IS DERIVED FROM THE SCHEMA, NOT RETYPED (review round 5, N1). The first cut of the
  // tier enum was `commercial|fedramp-high|il5`; ADR-0022 widened it to the glossary's five members,
  // and every OTHER site was corrected while these two option descriptions kept listing the old
  // three — the only place an operator ever reads the list. An operator enrolling a GovCloud outpost
  // was told no value existed for it, and pushed to either leave the tier unknown or assert
  // `commercial`: the INVENTED POSTURE this milestone exists to prevent. Joining the enum's own
  // members here makes that drift structurally impossible; `outpost-cli-surface.test.ts` pins it.
  const TRUST_TIER_CHOICES = OutpostTrustTierSchema.options.join("|");

  outpostCmd
    .command("declare")
    .description(
      "Declare the config object for an already-paired outpost peer — or, with --peer set to this instance's own domain id ('scp federation self'), the HQ outpost — the outpost in this instance's own trust domain (commander-role instances only: an outpost's own record arrives replicated)"
    )
    .requiredOption(
      "--peer <domainId>",
      "the paired outpost peer's trust-domain id (a field outpost), or this instance's own domain id for the HQ outpost"
    )
    .option("--name <name>", "display name for the config object (defaults to the peer's name)")
    .option(
      "--trust-tier <tier>",
      `${TRUST_TIER_CHOICES} — an owner-ENTERED assertion; OMIT it and the tier stays honestly unknown (never defaulted)`
    )
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (opts: BaseCliOpts & { peer: string; name?: string; trustTier?: OutpostTrustTier }) => {
        const client = await clientFromStoredCredentials(opts);
        const config = await client.federation.createOutpost({
          peerDomainId: opts.peer,
          ...(opts.name !== undefined ? { name: opts.name } : {}),
          ...(opts.trustTier !== undefined ? { trustTier: opts.trustTier } : {})
        });
        printResult(config, opts.output, (item) => outpostConfigRow(item as OutpostConfig));
      }
    );

  outpostCmd
    .command("set")
    .description("Edit an outpost's commander-origin config (absent flags PRESERVE)")
    .requiredOption("--peer <domainId>", "the outpost peer's trust-domain id")
    .option("--name <name>", "new display name")
    .option("--trust-tier <tier>", TRUST_TIER_CHOICES)
    .option("--expected-version <n>", "optimistic-concurrency guard on the object's version")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (
        opts: BaseCliOpts & {
          peer: string;
          name?: string;
          trustTier?: OutpostTrustTier;
          expectedVersion?: string;
        }
      ) => {
        const client = await clientFromStoredCredentials(opts);
        const config = await client.federation.updateOutpost(opts.peer, {
          ...(opts.name !== undefined ? { name: opts.name } : {}),
          ...(opts.trustTier !== undefined ? { trustTier: opts.trustTier } : {}),
          ...(opts.expectedVersion !== undefined
            ? { expectedVersion: Number(opts.expectedVersion) }
            : {})
        });
        printResult(config, opts.output, (item) => outpostConfigRow(item as OutpostConfig));
      }
    );

  outpostCmd
    .command("list")
    .description("List every outpost config object known here")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const configs = await client.federation.listOutposts();
      printResult(configs, opts.output, (item) => outpostConfigRow(item as OutpostConfig));
    });

  outpostCmd
    .command("show")
    .description("Show one outpost's config object, resolved through its peer binding")
    .requiredOption("--peer <domainId>", "the outpost peer's trust-domain id")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (opts: BaseCliOpts & { peer: string }) => {
      const client = await clientFromStoredCredentials(opts);
      const config = await client.federation.getOutpost(opts.peer);
      printResult(config, opts.output, (item) => outpostConfigRow(item as OutpostConfig));
    });

  // THE RECOVERY VERB, ON THE ONLY SURFACE ITS OPERATOR CAN REACH (review round 5, N2). Charter
  // principle 3 is API -> SDK -> CLI -> IaC -> UI, and this verb exists precisely so somebody can
  // UN-WEDGE a peer whose database holds duplicate `outpost` objects. That operator is the one person
  // who cannot use the UI for it — the wedged peer is exactly what the UI fails to render — so of all
  // the verbs this milestone added, `reconcile` is the one that most needs a command line.
  outpostCmd
    .command("reconcile")
    .description(
      "RECOVERY: restore the 1:1 peer<->config binding for a peer holding duplicate outpost config objects"
    )
    .requiredOption("--peer <domainId>", "the outpost peer's trust-domain id")
    .option(
      "--keep <objectId>",
      "which config object should SURVIVE (default: the most authoritative one). The only way out of a VERIFIED foreign-origin duplicate: this domain drops the row IT authored. A signature-verified replica is never deleted"
    )
    // NAMED, NEVER THE DEFAULT. Skipping the precondition is a deliberate act with a name, so it
    // shows up in the shell history and in any script that does it. The default reads first and
    // sends `?ifClaimant=` derived from that read.
    .option(
      "--no-precondition",
      "skip the ?ifClaimant= staleness check (send the bare call). Only for a peer whose claimants you have already inspected another way — without it, a claimant that appears between the listing and the call can silently change what reconcile does"
    )
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (opts: BaseCliOpts & { peer: string; keep?: string; precondition: boolean }) => {
      const client = await clientFromStoredCredentials(opts);
      // READ FIRST. The window between this listing and the call is milliseconds, so the token is
      // a TOCTOU guard rather than proof anybody read the preview — but the preview is also the
      // only look at the claimants this surface has ever offered, and the write below can adopt,
      // discard, or journal a delete downstream.
      let ifClaimants: string[] | undefined;
      if (opts.precondition) {
        const configs = await client.federation.listOutposts();
        ifClaimants = outpostClaimantTokens(configs, opts.peer);
        if (opts.output !== "json") {
          for (const line of formatReconcilePreviewLines(
            configs.filter((c) => c.peerDomainId === opts.peer),
            opts.keep
          )) {
            console.log(line);
          }
        }
      }
      const result = await client.federation
        .reconcileOutpost(opts.peer, {
          ...(opts.keep !== undefined ? { keep: opts.keep } : {}),
          ...(ifClaimants !== undefined ? { ifClaimants } : {})
        })
        .catch((err: unknown) => {
          // The stale-precondition 412 is the ONE refusal that carries its own re-preview. The
          // generic handler in bin.ts prints `err.message`, which for a ProblemError is the bare
          // HTTP title ("Precondition Failed") — an operator would learn nothing about WHAT moved
          // or what to do next, on the exact refusal whose whole point is to say so.
          const fresh = reconcileStaleClaimants(err);
          if (fresh === null) throw err;
          console.error(`REFUSED (HTTP 412): ${(err as ScpApiError).problem?.detail ?? ""}`);
          console.error("Claimants NOW:");
          for (const line of formatReconcilePreviewLines(
            fresh.filter((c) => c.peerDomainId === opts.peer),
            opts.keep
          )) {
            console.error(`  ${line}`);
          }
          console.error(
            "Nothing was adopted, removed or journaled. Re-run to act on the list above."
          );
          return null;
        });
      if (result === null) {
        process.exitCode = 1;
        return;
      }
      if (opts.output === "json") {
        printResult(result, opts.output, (item) => outpostConfigRow(item as OutpostConfig));
        return;
      }
      // Table mode prints WHAT IT DID before the surviving row, because "adopted" and "removed"
      // are the whole point of the call: a bare config row would look identical to `outpost show`
      // and leave the operator unable to tell whether anything was cleaned up.
      printResult([result.config], opts.output, (item) => outpostConfigRow(item as OutpostConfig));
      for (const line of formatReconcileResultLines(result)) {
        console.log(line);
      }
    });

  federationCmd
    .command("peers")
    .description("List paired federation peers")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const peers = await client.federation.listPeers();
      printResult(peers, opts.output, (item) => peerRow(item as FederationPeer));
    });

  federationCmd
    .command("status")
    .description(
      "Cross-domain status: every peer, this side's sync freshness, recent bundle transfers"
    )
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const status = await client.federation.status();
      printFederationStatus(status, opts.output);
    });

  federationCmd
    .command("export")
    .description(
      "Export a signed .scpbundle of journal entries since a cursor (the built-in file transport)"
    )
    .requiredOption("--peer <idOrName>", "peer to export for")
    .option("--since <sequence>", "sequence to export since (default: from genesis)")
    .option("--out <file>", "output .scpbundle file path (local write — today's manual walk)")
    // M13.2a (§13.2) — the server-side drop through the peer's DeliveryTarget (per-peer config,
    // else the instance SCP_RELAY_OUT_DIR fallback; neither → fail-closed named problem).
    .option(
      "--deliver",
      "drop the bundle server-side into the peer's DeliveryTarget instead of (or as well as) --out"
    )
    .option("--base-url <url>", "API base URL override")
    .action(
      async (
        opts: BaseCliOpts & { peer: string; since?: string; out?: string; deliver?: boolean }
      ) => {
        if (!opts.out && !opts.deliver) {
          throw new Error("provide --out <file>, --deliver, or both");
        }
        const client = await clientFromStoredCredentials(opts);
        const bundle = await client.federation.exportSync({
          peer: opts.peer,
          sinceSequence: opts.since !== undefined ? Number(opts.since) : undefined,
          deliver: opts.deliver || undefined
        });
        if (opts.out) await writeFile(opts.out, JSON.stringify(bundle, null, 2), "utf8");
        const where = [
          ...(opts.out ? [opts.out] : []),
          ...(opts.deliver ? [`the peer's DeliveryTarget (server-side)`] : [])
        ].join(" and ");
        console.log(
          `Exported ${bundle.entries.length} entries (sequence ${bundle.header.sinceSequence + 1}..${bundle.header.throughSequence}) to ${where}`
        );
      }
    );

  federationCmd
    .command("promote")
    .description(
      "Export a Promotion Bundle for a Change (change + control evidence + artifact digests + approval attestations)"
    )
    .requiredOption("--peer <idOrName>", "destination peer")
    .requiredOption("--change <idOrUrn>", "the Change to promote")
    .option("--out <file>", "output .scpbundle file path (local write — today's manual walk)")
    // M13.2a (§13.2) — the server-side drop through the peer's DeliveryTarget.
    .option(
      "--deliver",
      "drop the bundle server-side into the peer's DeliveryTarget instead of (or as well as) --out"
    )
    .option("--base-url <url>", "API base URL override")
    .action(
      async (
        opts: BaseCliOpts & { peer: string; change: string; out?: string; deliver?: boolean }
      ) => {
        if (!opts.out && !opts.deliver) {
          throw new Error("provide --out <file>, --deliver, or both");
        }
        const client = await clientFromStoredCredentials(opts);
        const bundle = await client.federation.exportPromotion({
          peer: opts.peer,
          change: opts.change,
          deliver: opts.deliver || undefined
        });
        if (opts.out) await writeFile(opts.out, JSON.stringify(bundle, null, 2), "utf8");
        const where = [
          ...(opts.out ? [opts.out] : []),
          ...(opts.deliver ? [`the peer's DeliveryTarget (server-side)`] : [])
        ].join(" and ");
        console.log(`Exported promotion bundle for change ${opts.change} to ${where}`);
      }
    );

  federationCmd
    .command("import <file>")
    .description(
      "Verify + apply a .scpbundle (sync or promotion, auto-detected) — REJECTS on any signature/hash-chain failure, applies nothing"
    )
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (file: string, opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      // Defensive byte-size ceiling BEFORE ever parsing the file — belt-and-braces alongside the
      // server's own bounded Fastify `bodyLimit` (routes/federation.ts). `.scpbundle` is a plain
      // JSON document (no archive/compression), so there is no zip-bomb class of attack to defend
      // against beyond "don't read an arbitrarily huge file into memory."
      const raw = await readFile(file, "utf8");
      const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
      if (Buffer.byteLength(raw, "utf8") > MAX_BUNDLE_BYTES) {
        throw new Error(
          `bundle file exceeds the ${MAX_BUNDLE_BYTES}-byte import ceiling — refusing to parse`
        );
      }
      const parsed: unknown = JSON.parse(raw);
      const result = await client.federation.import(parsed as ImportBundleRequest);
      printResult(result, opts.output, (item) => item as Record<string, unknown>);
    });

  // M15.5(c) — the retrans validate-then-relay (ADR-0019 §2). `relay` runs on the RETRANS-role
  // instance: pull + validate the imported promotion's authorized artifact bytes and build the
  // signed byte tarball in the server's SCP_RELAY_OUT_DIR drop directory. The tarball crosses the
  // CDS out-of-band (a file walk, exactly like `.scpbundle`); `relay-import` runs on the
  // DESTINATION outpost to verify it and push the bytes into the local registry by digest.
  federationCmd
    .command("relay")
    .description(
      "Validate-then-relay an imported promotion's artifact bytes into a signed tarball (retrans role only; fail-closed)"
    )
    .requiredOption(
      "--change <idOrUrn>",
      "the LOCAL imported change (from `scp federation import`)"
    )
    // M13.2a (§13.2) — the outbound drop resolves through the named DESTINATION peer's
    // DeliveryTarget; omitted, it resolves through the instance env (SCP_RELAY_OUT_DIR) as before.
    .option(
      "--peer <idOrName>",
      "destination peer whose DeliveryTarget receives the tarball drop (default: instance env)"
    )
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (opts: BaseCliOpts & { change: string; peer?: string }) => {
      const client = await clientFromStoredCredentials(opts);
      const result = await client.federation.relay({ change: opts.change, peer: opts.peer });
      if (opts.output === "json") {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(`Relay tarball built (server-side): ${result.tarballPath}`);
      for (const artifact of result.artifacts) {
        console.log(`  ${artifact.type}  ${artifact.digest}`);
      }
      console.log(`Decision: ${result.decisionId}`);
      console.log(
        "Carry the tarball across the CDS out-of-band, then run `scp federation relay-import` on the destination."
      );
    });

  federationCmd
    .command("relay-import")
    .description(
      "Destination side of the retrans relay: verify a signed byte tarball and push its artifacts into the local registry by digest (+ re-inspect)"
    )
    .requiredOption(
      "--file <name>",
      "tarball file name inside the destination server's SCP_RELAY_IN_DIR drop directory"
    )
    .requiredOption(
      "--change <idOrUrn>",
      "the LOCAL imported change this tarball belongs to (import its .scpbundle first)"
    )
    .requiredOption(
      "--pubkey <path>",
      "path to the RETRANS instance's cosign PUBLIC key (distributed out-of-band) — verifies the tarball signature"
    )
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (opts: BaseCliOpts & { file: string; change: string; pubkey: string }) => {
      const client = await clientFromStoredCredentials(opts);
      const relayCosignPublicKey = await readFile(opts.pubkey, "utf8");
      const result = await client.federation.relayImport({
        file: opts.file,
        change: opts.change,
        relayCosignPublicKey
      });
      if (opts.output === "json") {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(`Relayed bytes landed for change ${result.localChangeObjectId}:`);
      for (const artifact of result.pushed) {
        console.log(`  ${artifact.type}  ${artifact.digest}  ${artifact.location ?? ""}`);
      }
      console.log(`Decision: ${result.decisionId}`);
      console.log(
        "The receiving M17.4(a)+(b) gates still verify everything before any deploy (zero trust in the relay)."
      );
    });

  federationCmd
    .command("hand-fill")
    .description(
      "Manually enter a commander-origin object as an unverified shadow copy (air-gapped, no bundle transport at all)"
    )
    .requiredOption("--peer <idOrName>", "the commander peer this is claimed to originate from")
    .requiredOption("--type <typeId>", "object type id")
    .requiredOption("--urn <urn>", "the object's URN")
    .requiredOption("--name <name>", "the object's name")
    .option("--properties <json>", "JSON object")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (
        opts: BaseCliOpts & {
          peer: string;
          type: string;
          urn: string;
          name: string;
          properties?: string;
        }
      ) => {
        const client = await clientFromStoredCredentials(opts);
        const object = await client.federation.handFill({
          peer: opts.peer,
          typeId: opts.type,
          urn: opts.urn,
          name: opts.name,
          properties: parseJsonOption(opts.properties, "--properties")
        });
        printResult(object, opts.output, (item) => item as Record<string, unknown>);
      }
    );

  const overlayCmd = federationCmd
    .command("overlay")
    .description(
      "Shared-authority overlays (DESIGN.md §13 — annotate a foreign-origin base object without mutating it)"
    );

  overlayCmd
    .command("create")
    .description("Create a local overlay annotating a base object")
    .requiredOption("--base <idOrUrn>", "the base object to annotate")
    .requiredOption("--type <typeId>", "the overlay object's type id")
    .requiredOption("--name <name>", "the overlay object's name")
    .option("--properties <json>", "JSON object")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (
        opts: BaseCliOpts & { base: string; type: string; name: string; properties?: string }
      ) => {
        const client = await clientFromStoredCredentials(opts);
        const overlay = await client.federation.createOverlay({
          base: opts.base,
          typeId: opts.type,
          name: opts.name,
          properties: parseJsonOption(opts.properties, "--properties")
        });
        printResult(overlay, opts.output, (item) => item as Record<string, unknown>);
      }
    );

  overlayCmd
    .command("view <baseIdOrUrn>")
    .description("Read-time merge of a base object with its local overlays (base is never mutated)")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (baseIdOrUrn: string, opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const view = await client.federation.getMergedOverlayView(baseIdOrUrn);
      if (opts.output === "json") {
        console.log(JSON.stringify(view, null, 2));
        return;
      }
      console.log(`Base: ${view.base.urn} (${view.overlays.length} overlay(s))`);
      console.log(JSON.stringify(view.merged, null, 2));
    });

  // -----------------------------------------------------------------------------------------
  // M7: Real Executor Integrations (BUILD_AND_TEST.md §8 M7, DESIGN §11/§12) — secrets, executor/
  // notification bindings, plugin manifests, discovery run/accept, webhook signing secrets, and
  // `scp change report` (Terraform Mode 1's `--plan-json` CLI step).
  // -----------------------------------------------------------------------------------------

  const secretCmd = program
    .command("secret")
    .description("Manage encrypted org secrets (write-only — never readable back)");

  secretCmd
    .command("put <key>")
    .description("Store (or rotate) an encrypted secret value by key")
    .requiredOption("--value <value>", "the plaintext secret value (encrypted at rest immediately)")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (key: string, opts: BaseCliOpts & { value: string }) => {
      const client = await clientFromStoredCredentials(opts);
      const result = await client.secrets.put(key, { value: opts.value });
      printResult(result, opts.output, (item) => item as Record<string, unknown>);
    });

  secretCmd
    .command("list")
    .description("List configured secret KEYS for this org (never values)")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const result = await client.secrets.listKeys();
      if (opts.output === "json") {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      for (const key of result.keys) console.log(key);
    });

  secretCmd
    .command("delete <key>")
    .description("Delete a secret by key")
    .option("--base-url <url>", "API base URL override")
    .action(async (key: string, opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      await client.secrets.delete(key);
      console.log(`Deleted secret '${key}'`);
    });

  // -----------------------------------------------------------------------------------------
  // `scp connect` (M12 P4) — one command to register an execution system SCP will coordinate
  // (Mode A / BYO): stores the token, creates the `execution-system` object, and best-effort
  // validates connectivity. Wraps `secret put` + `object create` so an operator doesn't hand-craft
  // the properties JSON. After this, `scp discovery run --module argocd-discovery` imports the apps.
  // -----------------------------------------------------------------------------------------
  const connectCmd = program
    .command("connect")
    .description("Register an existing execution system for SCP to coordinate (Mode A)");

  connectCmd
    .command("argocd")
    .description(
      "Register an existing Argo CD server (stores the token, creates an execution-system)"
    )
    .requiredOption("--url <url>", "Argo CD API server base URL, e.g. https://argocd.example.com")
    .requiredOption("--token <token>", "an Argo CD API token (scoped per your Argo CD RBAC)")
    .option("--name <name>", "name for the execution-system object", "argocd")
    .option(
      "--token-key <key>",
      "secrets-store key to hold the token (default: <name>-argocd-token)"
    )
    .option("--no-validate", "skip the best-effort connectivity check")
    .option(
      "--allow-internal-egress",
      "declare that this system may be reached at a private/in-cluster address (e.g. an in-cluster " +
        "Argo CD ClusterIP). This is a DECLARATION, not a grant: the server also requires its host to " +
        "be in the operator's SCP_INTERNAL_EGRESS_HOSTS allowlist, or egress stays blocked (ADR-0003)"
    )
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (
        opts: BaseCliOpts & {
          url: string;
          token: string;
          name: string;
          tokenKey?: string;
          validate: boolean;
          allowInternalEgress?: boolean;
        }
      ) => {
        const client = await clientFromStoredCredentials(opts);
        const serverUrl = opts.url.replace(/\/+$/, "");
        const tokenKey = opts.tokenKey ?? `${opts.name}-argocd-token`;

        if (opts.validate) {
          // Best-effort: hit Argo CD's version endpoint with the token. A failure warns but does not
          // block (air-gapped/proxied setups may not be reachable from the operator's shell).
          try {
            const res = await fetch(`${serverUrl}/api/version`, {
              headers: { authorization: `Bearer ${opts.token}` }
            });
            if (!res.ok) {
              console.warn(
                `WARN: Argo CD ${serverUrl}/api/version returned HTTP ${res.status} — registering anyway`
              );
            } else {
              console.log(`Connectivity to ${serverUrl}: OK`);
            }
          } catch (err) {
            console.warn(
              `WARN: could not reach ${serverUrl} (${String(err)}) — registering anyway`
            );
          }
        }

        await client.secrets.put(tokenKey, { value: opts.token });
        const created = await client.object("execution-system").create(
          {
            name: opts.name,
            properties: {
              kind: "argocd",
              serverUrl,
              tokenSecretKey: tokenKey,
              ...(opts.allowInternalEgress ? { allowInternalEgress: true } : {})
            }
          },
          { idempotencyKey: randomUUID() }
        );
        console.log(
          `Registered execution-system '${opts.name}' (${created.id}). Token stored as secret '${tokenKey}'.`
        );
        // CREDENTIAL LOCALITY. `connect` is the moment the operator chooses where this system's
        // credential lives, and nothing used to say so — you found out by reading the secrets table.
        //
        // A single commander coordinating several places is a legitimate topology, and the RIGHT
        // default (charter principle 7 orders Simplicity above Federation; a second instance means a
        // second database and a small PKI). But it has one consequence worth stating out loud: this
        // token now lives HERE, so anyone with access to this instance can reach that system. That is
        // fine when this instance is at least as protected as the system it controls, and is exactly
        // the case where an outpost earns its cost when it is not.
        //
        // Printed as a NOTE, not a warning: it is unconditionally true rather than a problem, and
        // dressing a fact as an alarm is how operators learn to skim output. `federation.self()` is
        // best-effort — a connect must not fail because we could not decorate its success.
        try {
          const self = await client.federation.self();
          console.log(
            `NOTE: that token is held by THIS instance (domain '${self.name}', role ${self.role}). ` +
              `Anyone with access here can reach ${serverUrl}.`
          );
          if (self.role === "commander") {
            console.log(
              `      If ${opts.name} is more sensitive than this instance, run an outpost in its ` +
                `domain instead so the credential lives beside what it controls — see ` +
                `docs/federation-topologies.md.`
            );
          }
        } catch {
          // Unregistered/older instance, or the endpoint is unreachable. The registration above
          // already succeeded; say the durable half without inventing an identity for it.
          console.log(
            `NOTE: that token is held by THIS instance — anyone with access here can reach ${serverUrl}. ` +
              `See docs/federation-topologies.md.`
          );
        }
        console.log(
          `Next: scp discovery run --module argocd-discovery --instance-id ${opts.name} \\`
        );
        console.log(
          `        --config '{"serverUrl":"${serverUrl}","tokenSecretKey":"${tokenKey}","executionSystemId":"${created.id}"}' \\`
        );
        console.log(
          `        --secret-refs '{"${tokenKey}":"${tokenKey}"}'   # then: scp discovery accept <proposalId>`
        );
        printResult(created, opts.output, (item) => objectRow(item as GraphObject));
      }
    );

  const executorCmd = program
    .command("executor")
    .description("Configure ExecutorPlugin instances (DESIGN §12)");

  executorCmd
    .command("bind <idOrUrn>")
    .description(
      "Bind a Component/DeploymentTarget to an ExecutorPlugin instance or execution-system"
    )
    .option(
      "--module <module>",
      "plugin module: github|gitea|gitlab|argocd|terraform|managed-iac (inline binding)"
    )
    .option("--instance-id <id>", "stable id for this plugin instance (inline binding)")
    .option(
      "--execution-system <idOrUrn>",
      "bind via a registered execution-system object (module/serverUrl/token resolved from it)"
    )
    .option(
      "--config <json>",
      "JSON object — the plugin's own config shape (see `scp plugin manifests`)"
    )
    .option(
      "--secret-refs <json>",
      "JSON object mapping configFieldName -> secret key (`scp secret put`)"
    )
    .option("--allowed-hosts <list>", "comma-separated egress allowlist (hostnames)")
    .option(
      "--target-ref <ref>",
      "executor-specific target id (e.g. an Argo CD Application name); defaults to the object id"
    )
    .option(
      "--type <type>",
      "routing Type (ADR-0007) this binding drives: image|rpm|deb|npm (Category build) | " +
        "infrastructure | configuration (default: configuration). A target may hold ONE binding per " +
        "Type, so this ADDS a pipeline of that Type alongside the others rather than replacing one"
    )
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (
        idOrUrn: string,
        opts: BaseCliOpts & {
          module?: string;
          instanceId?: string;
          executionSystem?: string;
          config?: string;
          secretRefs?: string;
          allowedHosts?: string;
          targetRef?: string;
          type?: ExecutorType;
        }
      ) => {
        const client = await clientFromStoredCredentials(opts);
        const result = await client.executors.putBinding(
          idOrUrn,
          opts.executionSystem
            ? {
                executionSystemId: opts.executionSystem,
                externalRef: opts.targetRef,
                type: opts.type
              }
            : {
                pluginModule: opts.module,
                pluginInstanceId: opts.instanceId,
                config: parseJsonOption(opts.config, "--config") as
                  Record<string, unknown> | undefined,
                secretRefs: parseJsonOption(opts.secretRefs, "--secret-refs") as
                  Record<string, string> | undefined,
                allowedHosts: parseList(opts.allowedHosts),
                externalRef: opts.targetRef,
                type: opts.type
              }
        );
        printResult(result, opts.output, (item) => item as Record<string, unknown>);
      }
    );

  executorCmd
    .command("get <idOrUrn>")
    .description("Get a target's configured executor binding (one type; default: configuration)")
    .option("--type <type>", "which routing Type to read (default: configuration)")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (idOrUrn: string, opts: BaseCliOpts & { type?: ExecutorType }) => {
      const client = await clientFromStoredCredentials(opts);
      const result = await client.executors.getBinding(idOrUrn, opts.type);
      printResult(result, opts.output, (item) => item as Record<string, unknown>);
    });

  // M12 P5c binding primitives: list all / detach / relabel-type.
  executorCmd
    .command("bindings <idOrUrn>")
    .description("List every executor binding (all types) configured for a target")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (idOrUrn: string, opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const items = await client.executors.listBindings(idOrUrn);
      printResult(items, opts.output, (item) => item as Record<string, unknown>);
    });

  executorCmd
    .command("unbind <idOrUrn>")
    .description("Delete a target's executor binding for one type (default: configuration)")
    .option("--type <type>", "which routing Type to detach (default: configuration)")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (idOrUrn: string, opts: BaseCliOpts & { type?: ExecutorType }) => {
      const client = await clientFromStoredCredentials(opts);
      const result = await client.executors.deleteBinding(idOrUrn, opts.type);
      printResult(result, opts.output, (item) => item as Record<string, unknown>);
    });

  executorCmd
    .command("repurpose <idOrUrn>")
    .description("Relabel which pipeline (routing Type, ADR-0007) a target's binding drives")
    .requiredOption(
      "--to <type>",
      "the new routing Type: image|rpm|deb|npm|infrastructure|configuration"
    )
    .option("--from <type>", "the binding's current routing Type (default: configuration)")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (idOrUrn: string, opts: BaseCliOpts & { to: ExecutorType; from?: ExecutorType }) => {
        const client = await clientFromStoredCredentials(opts);
        const result = await client.executors.repurposeBinding(idOrUrn, opts.to, opts.from);
        printResult(result, opts.output, (item) => item as Record<string, unknown>);
      }
    );

  // M15.6 (ADR-0017 §3): read + validate a prod environment's per-region Argo CD set. A region is a
  // deployment-target with properties.environment=<env>/region=<label>; its Argo CD is an ordinary
  // per-region binding. Surfaces `prod env -> {region -> argocd binding}` and a validation verdict.
  executorCmd
    .command("regional <environment>")
    .description("Read + validate a prod environment's per-region Argo CD bindings (M15.6)")
    .option("--type <type>", "binding routing Type to resolve per region (default: configuration)")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (environment: string, opts: BaseCliOpts & { type?: ExecutorType }) => {
      const client = await clientFromStoredCredentials(opts);
      const view = await client.executors.getRegionalExecutors(environment, opts.type);
      if (opts.output === "json") {
        printResult(view, opts.output, (item) => item as Record<string, unknown>);
        return;
      }
      // Table view: one row per region, then the verdict + any problems.
      printResult(view.regions, opts.output, (item) => {
        const r = item as (typeof view.regions)[number];
        return {
          region: r.region || "(unset)",
          target: r.targetName,
          bound: String(r.bound),
          module: r.pluginModule ?? "-",
          argocd: String(r.isExpectedModule),
          executionSystem: r.executionSystemId ?? "-"
        } as Record<string, string>;
      });
      process.stdout.write(
        `\nenvironment '${view.environment}' — valid: ${view.valid}\n` +
          (view.problems.length ? view.problems.map((p) => `  - ${p}`).join("\n") + "\n" : "")
      );
    });

  const notifyCmd = program
    .command("notify")
    .description("Configure NotificationPlugin channels (DESIGN §11)");

  notifyCmd
    .command("bind <instanceId>")
    .description(
      "Configure (or update) a notification channel — an org may configure more than one"
    )
    .requiredOption("--module <module>", "plugin module: webhook-notify|smtp-notify")
    .option(
      "--config <json>",
      "JSON object — the plugin's own config shape (see `scp plugin manifests`)"
    )
    .option("--secret-refs <json>", "JSON object mapping configFieldName -> secret key")
    .option("--allowed-hosts <list>", "comma-separated egress allowlist (hostnames)")
    .option(
      "--min-severity <severity>",
      "info|warning|critical — minimum severity this channel receives",
      "info"
    )
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (
        instanceId: string,
        opts: BaseCliOpts & {
          module: string;
          config?: string;
          secretRefs?: string;
          allowedHosts?: string;
          minSeverity: "info" | "warning" | "critical";
        }
      ) => {
        const client = await clientFromStoredCredentials(opts);
        const result = await client.notifications.putBinding(instanceId, {
          pluginModule: opts.module,
          config: parseJsonOption(opts.config, "--config") as Record<string, unknown> | undefined,
          secretRefs: parseJsonOption(opts.secretRefs, "--secret-refs") as
            Record<string, string> | undefined,
          allowedHosts: parseList(opts.allowedHosts),
          minSeverity: opts.minSeverity
        });
        printResult(result, opts.output, (item) => item as Record<string, unknown>);
      }
    );

  notifyCmd
    .command("list")
    .description("List this org's configured notification channels")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const page = await client.notifications.listBindings();
      printResult(page.items, opts.output, (item) => item as Record<string, unknown>);
    });

  notifyCmd
    .command("delete <instanceId>")
    .description("Remove a notification channel")
    .option("--base-url <url>", "API base URL override")
    .action(async (instanceId: string, opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      await client.notifications.deleteBinding(instanceId);
      console.log(`Deleted notification binding '${instanceId}'`);
    });

  const pluginCmd = program.command("plugin").description("Inspect bundled plugins (DESIGN §11)");

  pluginCmd
    .command("manifests")
    .description(
      "Every bundled plugin's {id, kind, version, configSchema} — the source a config form is generated from"
    )
    .option("--base-url <url>", "API base URL override")
    .action(async (opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const result = await client.plugins.listManifests();
      console.log(JSON.stringify(result.items, null, 2));
    });

  const discoveryCmd = program
    .command("discovery")
    .description("DiscoveryPlugin run/accept — NEVER auto-commits (DESIGN §11)");

  discoveryCmd
    .command("run")
    .description(
      "Run a DiscoveryPlugin scan — prints a PROPOSAL only, nothing is written to the graph"
    )
    .requiredOption(
      "--module <module>",
      "plugin module: github-discovery | gitea-discovery | gitlab-discovery | argocd-discovery"
    )
    .requiredOption("--instance-id <id>", "stable id for this plugin instance")
    .option("--config <json>", "JSON object — the plugin's own config shape")
    .option("--secret-refs <json>", "JSON object mapping configFieldName -> secret key")
    .option("--allowed-hosts <list>", "comma-separated egress allowlist (hostnames)")
    .option("--base-url <url>", "API base URL override")
    .action(
      async (
        opts: BaseCliOpts & {
          module: string;
          instanceId: string;
          config?: string;
          secretRefs?: string;
          allowedHosts?: string;
        }
      ) => {
        const client = await clientFromStoredCredentials(opts);
        const proposal = await client.discovery.run({
          pluginModule: opts.module,
          pluginInstanceId: opts.instanceId,
          config: parseJsonOption(opts.config, "--config") as Record<string, unknown> | undefined,
          secretRefs: parseJsonOption(opts.secretRefs, "--secret-refs") as
            Record<string, string> | undefined,
          allowedHosts: parseList(opts.allowedHosts)
        });
        // Always JSON — a proposal is meant to be reviewed, edited, and re-submitted to
        // `discovery accept --proposal`, not rendered as a table.
        console.log(JSON.stringify(proposal, null, 2));
      }
    );

  discoveryCmd
    .command("accept")
    .description(
      "EXPLICITLY accept a discovery proposal — the only command that commits discovered objects/relationships"
    )
    .requiredOption(
      "--proposal <path-or-json>",
      "a file path to (or literal JSON of) a proposal from `discovery run`"
    )
    .option("--domain <idOrUrn>", "domain to create discovered objects under (default: org root)")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (opts: BaseCliOpts & { proposal: string; domain?: string }) => {
      const client = await clientFromStoredCredentials(opts);
      const raw = opts.proposal.trim().startsWith("{")
        ? opts.proposal
        : await readFile(opts.proposal, "utf8");
      const proposal = JSON.parse(raw) as { objects: unknown[]; relationships: unknown[] };
      const result = await client.discovery.accept({
        domainId: opts.domain,
        proposal: proposal as never
      });
      printResult(result, opts.output, (item) => item as Record<string, unknown>);
    });

  // M12 P5 follow-up: automated backfill of source_mappings onto ALREADY-imported components (the 50
  // argocd orphans imported before discovery emitted mappings). Feed a fresh `discovery run` proposal;
  // creates NO objects — matches its sourceMappings to existing components by name. Idempotent.
  discoveryCmd
    .command("backfill-mappings")
    .description(
      "Backfill source_mappings onto already-imported components from a discovery proposal"
    )
    .requiredOption(
      "--proposal <path-or-json>",
      "a file path to (or literal JSON of) a proposal from `discovery run` (its sourceMappings are used)"
    )
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (opts: BaseCliOpts & { proposal: string }) => {
      const client = await clientFromStoredCredentials(opts);
      const raw = opts.proposal.trim().startsWith("{")
        ? opts.proposal
        : await readFile(opts.proposal, "utf8");
      const proposal = JSON.parse(raw) as never;
      const result = await client.discovery.backfillSourceMappings(proposal);
      printResult(result, opts.output, (item) => item as Record<string, unknown>);
    });

  const changeSourceCmd = program
    .command("change-source")
    .description("Change-source webhook config (DESIGN §8/§9.2/§12)");

  // M12 P5 (owner Q3): source_mapping CRUD — the CLI parity gap (SDK + route existed). This is the
  // manual/backfill path for existing imports; new argocd imports get a mapping auto-created at accept.
  changeSourceCmd
    .command("create-mapping <sourceKind>")
    .description("Map a source (repo/path globs) to a component so its releases correlate")
    .requiredOption("--component <idOrUrn>", "the component this source's events belong to")
    .option(
      "--repo <pattern>",
      "repo glob (e.g. a GitHub repo URL/slug) — matched against the event's repo"
    )
    .option("--path <pattern>", "path glob within the repo")
    .option(
      "--ref <pattern>",
      "git ref glob (e.g. refs/heads/dev) — omitted matches ANY ref, which is the pre-0057 behaviour"
    )
    .option(
      "--type <type>",
      "routing Type (ADR-0007): image|rpm|deb|npm|infrastructure|configuration (default: configuration)"
    )
    .option(
      "--classification <label>",
      "declared pipeline classification: dev|beta (UI/reporting ONLY — never an enforcement input, ADR-0030 §3)"
    )
    .option(
      "--mirror-of-shared",
      "declare this repo a local MIRROR of a commander-shared source (outpost-ui.md §9.3a) — omit for a domain-specific repo; UI/reporting only, never an enforcement input"
    )
    .option(
      "--disabled",
      "create this mapping already PAUSED (migration 0063) — declared but routes nothing until enabled; default is enabled"
    )
    .option(
      "--scope <scope>",
      "declared reach of this repo (§10.6): global (shared across domains, tracked at the commander) | domain (tracked only here); omit = not declared (no label, nothing inferred); UI/reporting/IaC only, never a routing input"
    )
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (
        sourceKind: string,
        opts: BaseCliOpts & {
          component: string;
          repo?: string;
          path?: string;
          ref?: string;
          type?: ExecutorType;
          classification?: PipelineClassification;
          mirrorOfShared?: boolean;
          disabled?: boolean;
          scope?: string;
        }
      ) => {
        // Parsed BEFORE the client is built so a typo is a usage error, not a 400 after login.
        // `none` is meaningless at create (omitted already means undeclared) — reject it as such.
        const scope = opts.scope === undefined ? undefined : parseScopeFlag(opts.scope);
        if (opts.scope !== undefined && scope === null) {
          throw new Error(
            "--scope none is not meaningful at create — omit --scope for an undeclared scope"
          );
        }
        const client = await clientFromStoredCredentials(opts);
        const result = await client.changeSources.createMapping(sourceKind, {
          component: opts.component,
          repoPattern: opts.repo,
          pathPattern: opts.path,
          refPattern: opts.ref,
          type: opts.type,
          classification: opts.classification,
          ...(opts.mirrorOfShared ? { mirrorOfShared: true } : {}),
          ...(opts.disabled ? { enabled: false } : {}),
          ...(scope ? { scope } : {})
        });
        printResult(result, opts.output, (item) => sourceMappingRow(item as SourceMapping));
      }
    );

  changeSourceCmd
    .command("list-mappings <sourceKind>")
    .description(
      "List source_mappings for one source kind (SCOPE column: global|domain, blank = not declared)"
    )
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (sourceKind: string, opts: BaseCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const result = await client.changeSources.listMappings(sourceKind);
      printResult(result.items, opts.output, (item) => sourceMappingRow(item as SourceMapping));
    });

  // §10.6 — the after-the-fact door for the label `create-mapping --scope` sets at create. By id
  // (`list-mappings` shows it), because this is a genuine update of ONE row and must never reach a
  // byte-identical sibling. `--scope none` clears it. A label only: routing is untouched.
  changeSourceCmd
    .command("set-mapping-scope <sourceKind> <id>")
    .description(
      "Set or clear a source_mapping's declared scope — global (shared across domains) | domain (tracked only here) | none (clear); a label read by pipelines, IaC and this CLI, never a routing input"
    )
    .requiredOption("--scope <scope>", "global|domain|none")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (sourceKind: string, id: string, opts: BaseCliOpts & { scope: string }) => {
      const scope = parseScopeFlag(opts.scope);
      const client = await clientFromStoredCredentials(opts);
      const result = await client.changeSources.setMappingScope(sourceKind, id, scope);
      printResult(result, opts.output, (item) => sourceMappingRow(item as SourceMapping));
    });

  changeSourceCmd
    .command("webhook-secret <sourceKind>")
    .description("Configure (or rotate) this org+sourceKind's webhook HMAC signing secret")
    .requiredOption("--secret <value>", "the plaintext HMAC secret (encrypted at rest immediately)")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (sourceKind: string, opts: BaseCliOpts & { secret: string }) => {
      const client = await clientFromStoredCredentials(opts);
      const result = await client.changeSources.putWebhookSecret(sourceKind, {
        secret: opts.secret
      });
      printResult(result, opts.output, (item) => item as Record<string, unknown>);
    });

  changeSourceCmd
    .command("report <sourceKind>")
    .description(
      "Report a typed plan/apply result (DESIGN §12 Mode 1) — a one-line CI step; the typed, PAT-authenticated counterpart to raw webhook ingestion"
    )
    .requiredOption("--status <status>", "planned|applied|errored|discarded")
    .option("--repo <repo>", "correlation hint: repo (source_mappings matching)")
    .option("--path <path>", "correlation hint: path")
    .option(
      "--ref <ref>",
      "correlation hint: git ref (e.g. refs/heads/dev) — required to reach a ref-scoped mapping"
    )
    .option("--correlation-key <key>", "correlation key for grouping related changes")
    .option("--workspace <workspace>", "Terraform/OpenTofu workspace name")
    .option("--artifact-digest <digest>", "artifact digest linking this to an app-side change")
    .option("--plan-json <path>", "path to a `tofu show -json`-shaped plan file, attached verbatim")
    // M12 P4B coupled pipelines — THE pipeline declaration channel (a raw provider push webhook
    // cannot carry a key; this CI step can). Same flag format as `scp change propose`.
    .option(
      "--provides <keys>",
      "M12 P4B coupled pipelines: comma-separated keys this release makes true at its targets when it succeeds"
    )
    .option(
      "--requires <list>",
      "M12 P4B coupled pipelines: comma-separated prerequisites as key@objectIdOrUrn — the resulting " +
        "change WAITS until another change provides each key at that object before it executes"
    )
    // ADR-0028 stage-scoped coupling — THE declaration channel (owner ruling D2): the people who
    // know that A calls B are the people editing A, and nothing SCP observes carries inter-component
    // dependency data. Same flag pair as `scp change propose`.
    .option(
      "--stage-depends-on <list>",
      "ADR-0028 stage-scoped coupling: comma-separated componentIdOrUrn (or componentIdOrUrn@minWeight, " +
        "a percentage 1-100) this release's component must not deploy AHEAD OF at a shared place"
    )
    .option(
      "--stage-depends-at <targets>",
      "ADR-0028: comma-separated deployment-target ids/URNs restricting EVERY --stage-depends-on entry " +
        "to those places (omit for every stage the components share)"
    )
    // M17.2 (ADR-0015 §5) — a REFERENCE to the build-time SBOM the pipeline's own Trivy step emitted
    // and cosign-signed. SCP stores the reference, NEVER the document: do not pipe the SBOM itself.
    .option("--sbom-format <format>", "SBOM reference: cyclonedx|spdx (required to record an SBOM)")
    .option(
      "--sbom-digest <digest>",
      "SBOM reference: the SBOM DOCUMENT's own sha256 digest (not the artifact's)"
    )
    .option(
      "--sbom-location <uri>",
      "SBOM reference: where the document lives (OCI referrer ref / URI)"
    )
    .option(
      "--sbom-spec-version <version>",
      "SBOM reference: format spec version (e.g. 1.5, SPDX-2.3)"
    )
    .option(
      "--sbom-media-type <type>",
      "SBOM reference: media type (e.g. application/vnd.cyclonedx+json)"
    )
    .option(
      "--sbom-signature-ref <ref>",
      "SBOM reference: the ORIGIN cosign signature ref (SCP never signs)"
    )
    .option("--sbom-scanner <name>", "SBOM reference: which external tool produced it (e.g. trivy)")
    .option("--sbom-scanner-version <version>", "SBOM reference: that tool's version")
    .option("--sbom-generated-at <iso8601>", "SBOM reference: when the producer emitted it")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(
      async (
        sourceKind: string,
        opts: BaseCliOpts & {
          status: string;
          repo?: string;
          path?: string;
          ref?: string;
          correlationKey?: string;
          workspace?: string;
          artifactDigest?: string;
          planJson?: string;
          provides?: string;
          requires?: string;
          stageDependsOn?: string;
          stageDependsAt?: string;
          sbomFormat?: string;
          sbomDigest?: string;
          sbomLocation?: string;
          sbomSpecVersion?: string;
          sbomMediaType?: string;
          sbomSignatureRef?: string;
          sbomScanner?: string;
          sbomScannerVersion?: string;
          sbomGeneratedAt?: string;
        }
      ) => {
        const client = await clientFromStoredCredentials(opts);
        const validStatuses = ["planned", "applied", "errored", "discarded"] as const;
        if (!(validStatuses as readonly string[]).includes(opts.status)) {
          throw new Error(
            `--status must be one of ${validStatuses.join("|")} (got '${opts.status}')`
          );
        }
        const planJson = opts.planJson
          ? JSON.parse(await readFile(opts.planJson, "utf8"))
          : undefined;
        // An SBOM REFERENCE is all-or-nothing on its three required parts. Fail loudly on a partial
        // one rather than silently dropping it — a supply-chain reference that quietly vanishes is
        // exactly the failure mode ADR-0015 exists to prevent.
        const sbomFlags = [opts.sbomFormat, opts.sbomDigest, opts.sbomLocation];
        if (sbomFlags.some(Boolean) && !sbomFlags.every(Boolean)) {
          throw new Error(
            "--sbom-format, --sbom-digest and --sbom-location must be given together (an SBOM reference needs all three)"
          );
        }
        const validSbomFormats = ["cyclonedx", "spdx"] as const;
        if (opts.sbomFormat && !(validSbomFormats as readonly string[]).includes(opts.sbomFormat)) {
          throw new Error(
            `--sbom-format must be one of ${validSbomFormats.join("|")} (got '${opts.sbomFormat}')`
          );
        }
        const sbom = opts.sbomFormat
          ? {
              format: opts.sbomFormat as (typeof validSbomFormats)[number],
              digest: opts.sbomDigest!,
              location: opts.sbomLocation!,
              specVersion: opts.sbomSpecVersion,
              mediaType: opts.sbomMediaType,
              signatureRef: opts.sbomSignatureRef,
              scanner: opts.sbomScanner,
              scannerVersion: opts.sbomScannerVersion,
              generatedAt: opts.sbomGeneratedAt
            }
          : undefined;
        const result = await client.changeSources.report(sourceKind, {
          status: opts.status as (typeof validStatuses)[number],
          repo: opts.repo,
          path: opts.path,
          ref: opts.ref,
          correlationKey: opts.correlationKey,
          workspace: opts.workspace,
          artifactDigest: opts.artifactDigest,
          planJson,
          sbom,
          provides: parseList(opts.provides),
          requires: parseRequiresFlag(opts.requires),
          stageDependencies: parseStageDependenciesFlags(opts.stageDependsOn, opts.stageDependsAt)
        });
        printResult(result, opts.output, (item) => item as Record<string, unknown>);
      }
    );

  return program;
}

export async function runCli(argv: string[]): Promise<void> {
  const program = buildProgram();
  await program.parseAsync(argv);
}
