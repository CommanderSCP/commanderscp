import {
  bigint,
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  unique
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * M1 Graph Core schema (DESIGN.md §4.1-§4.3, §7, §8). Supersedes M0's minimal `objects` table
 * with the full generic graph model: object_types/relationship_types (runtime type registry),
 * objects/relationships (the graph itself, federation-ready provenance columns, optimistic
 * concurrency, soft delete), roles/role_bindings (RBAC), audit_events (hash-chained append-only
 * log), outbox (transactional outbox feeding pg-boss + SSE), and idempotency_keys
 * (Idempotency-Key replay per DESIGN.md §6).
 *
 * RLS policies, the `scp_app` least-privileged role, built-in type/role seed rows, and the
 * outbox NOTIFY trigger are hand-authored SQL (drizzle-kit cannot express them) — see
 * drizzle/0002_rls_rbac_seed.sql.
 */

// -------------------------------------------------------------------------------------------
// M0 auth substrate (kept — local-auth bootstrap; extended with a link to the user's graph
// object so RBAC/audit can attribute actions to a graph subject, DESIGN.md §7).
// -------------------------------------------------------------------------------------------

export const orgs = pgTable("orgs", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    username: text("username").notNull(),
    // NULL for OIDC-provisioned accounts (M2 stage 2, drizzle/0004_auth_expansion.sql) — those
    // authenticate exclusively via the IdP, never a local password (auth/local-auth.ts `login()`
    // treats NULL the same as a wrong password).
    passwordHash: text("password_hash"),
    /** The graph `user` object representing this account (DESIGN.md §7 RBAC subject). */
    objectId: uuid("object_id"),
    /** OIDC `sub` claim this account was JIT-provisioned from (auth/oidc.ts) — NULL for local-auth-only users. */
    oidcSubject: text("oidc_subject"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    unique("users_org_id_username_key").on(table.orgId, table.username),
    unique("users_org_id_oidc_subject_key").on(table.orgId, table.oidcSubject)
  ]
);

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  orgId: uuid("org_id")
    .notNull()
    .references(() => orgs.id),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});

/**
 * Personal Access Tokens (M2 stage 2, BUILD_AND_TEST.md §8 M2 item 3) — auth substrate like
 * orgs/users/sessions above (no RLS, see drizzle/0004_auth_expansion.sql). `tokenId` is an
 * indexable CLEARTEXT lookup key: argon2's output is salted/non-comparable, so — unlike
 * `sessions.tokenHash`'s SHA-256 equality lookup — a PAT can't be found by hashing the presented
 * secret and matching it directly. The presented token is `scp_pat_<tokenId>.<secret>`;
 * `tokenId` finds the row in O(1), then `tokenHash` (argon2 of `secret`) is verified
 * (auth/pat.ts).
 */
export const personalAccessTokens = pgTable(
  "personal_access_tokens",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    tokenId: text("token_id").notNull().unique(),
    tokenHash: text("token_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true })
  },
  (table) => [index("pat_org_user").on(table.orgId, table.userId)]
);

/**
 * SCP's own RFC 8628-shaped device-authorization flow (M2 stage 2 Part C) — hosted by SCP itself,
 * not a proxy to the upstream IdP's device grant, so it works identically for local-auth-only
 * air-gapped orgs and OIDC-configured orgs alike (DESIGN.md §7 "headless jump boxes can't do
 * browser redirects"). Auth substrate, no RLS — same treatment as orgs/users/sessions.
 *
 * Session minting is DEFERRED to claim time (auth/device-flow.ts `pollDeviceAuth`, drizzle/0006):
 * approval (`approveDeviceAuth`) only records WHO approved (`approvedByUserId`) and WHEN
 * (`approvedAt`) — never a token. `createSession` (session.ts) is called for the first time
 * inside the claiming poll's `FOR UPDATE` transaction, and the resulting plaintext bearer is
 * returned exactly once, never persisted. This row therefore never holds a usable credential at
 * any point in its lifecycle — matching every other credential in the system (sessions:
 * SHA-256 hash; PATs: argon2 hash).
 */
export const deviceAuthRequests = pgTable("device_auth_requests", {
  id: uuid("id").primaryKey(),
  deviceCodeHash: text("device_code_hash").notNull().unique(),
  userCode: text("user_code").notNull().unique(),
  status: text("status").notNull().default("pending"), // pending|approved|denied|expired|claimed
  orgId: uuid("org_id").references(() => orgs.id), // set on approval
  /** Set on approval; the user whose auth context the deferred session gets minted from at claim time. */
  approvedByUserId: uuid("approved_by_user_id").references(() => users.id),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});

// -------------------------------------------------------------------------------------------
// Runtime type registry (DESIGN.md §4.1)
// -------------------------------------------------------------------------------------------

export const objectTypes = pgTable("object_types", {
  id: text("id").primaryKey(),
  orgId: uuid("org_id"), // NULL = built-in/global type
  displayName: text("display_name").notNull(),
  propertySchema: jsonb("property_schema"),
  isBuiltin: boolean("is_builtin").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});

export const relationshipTypes = pgTable("relationship_types", {
  id: text("id").primaryKey(),
  orgId: uuid("org_id"),
  displayName: text("display_name").notNull(),
  propertySchema: jsonb("property_schema"),
  fromTypes: text("from_types").array(),
  toTypes: text("to_types").array(),
  cardinality: text("cardinality").notNull().default("many_to_many"),
  isBuiltin: boolean("is_builtin").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});

// -------------------------------------------------------------------------------------------
// The graph (DESIGN.md §4.1)
// -------------------------------------------------------------------------------------------

export const objects = pgTable(
  "objects",
  {
    id: uuid("id").primaryKey(), // UUIDv7, client-suppliable
    orgId: uuid("org_id").notNull(),
    domainId: uuid("domain_id"), // containing object; NULL only for the org root object
    typeId: text("type_id")
      .notNull()
      .references(() => objectTypes.id),
    name: text("name").notNull(),
    urn: text("urn").notNull(),
    properties: jsonb("properties").notNull().default({}),
    labels: jsonb("labels").notNull().default({}),
    // federation provenance (DESIGN.md §4.1 — every row is born federation-ready)
    originDomainId: uuid("origin_domain_id").notNull(),
    revision: bigint("revision", { mode: "number" }).notNull().default(1),
    contentHash: text("content_hash").notNull(),
    // lifecycle
    version: bigint("version", { mode: "number" }).notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true })
  },
  (table) => [
    unique("objects_org_id_urn_key").on(table.orgId, table.urn),
    index("obj_type").on(table.orgId, table.typeId),
    index("obj_domain").on(table.orgId, table.domainId),
    index("obj_created_cursor").on(table.orgId, table.createdAt, table.id),
    index("obj_props").using("gin", sql`${table.properties} jsonb_path_ops`),
    index("obj_labels").using("gin", sql`${table.labels} jsonb_path_ops`)
  ]
);

export const relationships = pgTable(
  "relationships",
  {
    id: uuid("id").primaryKey(), // UUIDv7
    orgId: uuid("org_id").notNull(),
    typeId: text("type_id")
      .notNull()
      .references(() => relationshipTypes.id),
    fromId: uuid("from_id")
      .notNull()
      .references(() => objects.id),
    toId: uuid("to_id")
      .notNull()
      .references(() => objects.id),
    properties: jsonb("properties").notNull().default({}),
    // M2 stage 3 addition (BUILD_AND_TEST.md §8 M2 item 4, drizzle/0005_plans.sql) — mirrors
    // `objects.labels` so the `scp:managed-by`/`scp:stack` IaC pruning convention
    // (apps/server/src/iac/plan-diff.ts) applies uniformly to relationships, not just objects.
    labels: jsonb("labels").notNull().default({}),
    originDomainId: uuid("origin_domain_id").notNull(),
    revision: bigint("revision", { mode: "number" }).notNull().default(1),
    contentHash: text("content_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true })
  },
  (table) => [
    unique("relationships_org_type_from_to_key").on(
      table.orgId,
      table.typeId,
      table.fromId,
      table.toId
    ),
    index("rel_fwd").on(table.orgId, table.fromId, table.typeId),
    index("rel_rev").on(table.orgId, table.toId, table.typeId),
    index("rel_created_cursor").on(table.orgId, table.createdAt, table.id),
    index("rel_labels").using("gin", sql`${table.labels} jsonb_path_ops`)
  ]
);

// -------------------------------------------------------------------------------------------
// RBAC (DESIGN.md §7)
// -------------------------------------------------------------------------------------------

export const roles = pgTable("roles", {
  id: uuid("id").primaryKey(),
  orgId: uuid("org_id"), // NULL = built-in (Viewer|Operator|Approver|Administrator|Owner)
  name: text("name").notNull(),
  permissions: text("permissions").array().notNull()
});

export const roleBindings = pgTable(
  "role_bindings",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id").notNull(),
    subjectId: uuid("subject_id").notNull(), // user | group | team | service-account (graph object)
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id),
    scopeObjectId: uuid("scope_object_id")
      .notNull()
      .references(() => objects.id),
    effect: text("effect").notNull().default("allow"), // 'allow' | 'deny' (deny overrides)
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("role_bindings_subject").on(table.orgId, table.subjectId),
    index("role_bindings_scope").on(table.orgId, table.scopeObjectId)
  ]
);

// -------------------------------------------------------------------------------------------
// Audit log (DESIGN.md §4.3) — append-only, hash-chained. UPDATE/DELETE revoked from scp_app in
// the hand-authored RLS/grants migration; a guard trigger is belt-and-braces.
// -------------------------------------------------------------------------------------------

export const auditEvents = pgTable(
  "audit_events",
  {
    // Strictly-monotonic insertion-order tiebreaker — audit_events chain appends are serialized
    // per org via `pg_advisory_xact_lock` (apps/server/src/audit/audit-repo.ts), but two events
    // committed within the same microsecond can still share `occurred_at`, and UUIDv7's random
    // low bits are not a true insertion-order counter. `seq` is DB-internal only (never exposed
    // by the API — the public `AuditEvent` shape stays exactly DESIGN.md §4.3's columns).
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity().notNull(),
    id: uuid("id").primaryKey(), // UUIDv7
    orgId: uuid("org_id").notNull(),
    domainId: uuid("domain_id"),
    actorId: uuid("actor_id").notNull(),
    action: text("action").notNull(),
    subjectId: uuid("subject_id"),
    beforeHash: text("before_hash"),
    afterHash: text("after_hash"),
    reason: text("reason"),
    decisionId: uuid("decision_id"),
    requestId: text("request_id").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    prevHash: text("prev_hash").notNull(),
    rowHash: text("row_hash").notNull()
  },
  (table) => [
    index("audit_events_org_chain").on(table.orgId, table.occurredAt, table.id),
    index("audit_events_org_seq").on(table.orgId, table.seq)
  ]
);

// -------------------------------------------------------------------------------------------
// Transactional outbox (DESIGN.md §8) — CloudEvents-shaped rows written in the same transaction
// as the mutation; relayed to pg-boss + SSE by the worker's outbox relay.
// -------------------------------------------------------------------------------------------

export const outbox = pgTable(
  "outbox",
  {
    id: uuid("id").primaryKey(), // UUIDv7 — doubles as the CloudEvents `id`
    orgId: uuid("org_id").notNull(),
    type: text("type").notNull(), // CloudEvents `type`, e.g. 'scp.object.created'
    source: text("source").notNull(), // CloudEvents `source`
    subject: text("subject"), // CloudEvents `subject` — usually the object/relationship id
    data: jsonb("data").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true })
  },
  (table) => [index("outbox_unprocessed").on(table.processedAt, table.createdAt)]
);

// -------------------------------------------------------------------------------------------
// IaC plans (BUILD_AND_TEST.md §8 M2 item 4, DESIGN.md §15) — a `plans` table is a "projection
// table for hot lifecycle state" (DESIGN.md §4.1): unlike M2 stage 1's typed registries (which
// deliberately reused objects/relationships), a plan has its own lifecycle (pending -> applied,
// or stale) and needs real columns for that, so it's a dedicated table referencing the graph only
// loosely (via URNs inside `manifest`/`diff`, not a `object_id` FK — a single plan touches many
// objects, not one). TENANT data (org_id-scoped, not auth substrate), so it needs the same RLS
// treatment as objects/relationships — hand-authored in drizzle/0005_plans.sql, same pattern as
// 0002_rls_rbac_seed.sql §2.
// -------------------------------------------------------------------------------------------

export const plans = pgTable(
  "plans",
  {
    id: uuid("id").primaryKey(), // UUIDv7
    orgId: uuid("org_id").notNull(),
    /** The graph subject (user/service-account object id) who requested the plan — mirrors `audit_events.actor_id`. */
    actorId: uuid("actor_id").notNull(),
    stackName: text("stack_name").notNull(),
    /** The exact submitted desired-state manifest, kept verbatim (DesiredStateManifest — @scp/schemas). */
    manifest: jsonb("manifest").notNull(),
    /** The computed typed diff at plan time (PlanDiff — @scp/schemas): create/update/delete/noop entries with reasons. */
    diff: jsonb("diff").notNull(),
    status: text("status").notNull().default("pending"), // 'pending' | 'applied' | 'stale'
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    appliedAt: timestamp("applied_at", { withTimezone: true })
  },
  (table) => [
    index("plans_org_created").on(table.orgId, table.createdAt, table.id),
    index("plans_org_stack").on(table.orgId, table.stackName)
  ]
);

// -------------------------------------------------------------------------------------------
// M3 Change Coordination Engine (DESIGN.md §9, §10.4, BUILD_AND_TEST.md §8 M3). Hand-authored
// grants/RLS/seed data in drizzle/0007_change_coordination.sql (same pattern as 0002/0005).
//
// `changes` is the projection table DESIGN §9.1 specifies verbatim, plus M3 additions: watchdog
// bookkeeping (`state_entered_at`/`last_heartbeat_at`/`watchdog_flagged_at` — §9.4), the
// compiled-plan's topology pin, and rollback linkage (a rollback is its OWN Change row,
// `rollback_of_object_id` pointing at the change it reverts — §9.4).
// -------------------------------------------------------------------------------------------

export const changes = pgTable(
  "changes",
  {
    objectId: uuid("object_id").primaryKey(), // references objects(id) — FK added in migration
    orgId: uuid("org_id").notNull(),
    state: text("state").notNull().default("proposed"),
    sourceKind: text("source_kind"), // github|argocd|terraform|manual|federation|rollback
    sourceRef: jsonb("source_ref"), // {repo, ref, commit, run_url, workspace, artifact_digest, ...}
    correlationKey: text("correlation_key"),
    emergency: boolean("emergency").notNull().default(false),
    importedFromDomain: uuid("imported_from_domain"),
    /** The release-topology object (+ its document version, pinned) this change compiled against. */
    topologyObjectId: uuid("topology_object_id"),
    topologyVersion: bigint("topology_version", { mode: "number" }),
    /** Set when this Change IS a rollback — DESIGN §9.4 "a rollback is its own Change, linked to the original". */
    rollbackOfObjectId: uuid("rollback_of_object_id"),
    rollbackTriggerReason: text("rollback_trigger_reason"),
    // Watchdog (DESIGN §9.4): `state_entered_at` resets on every legal transition; the sweep
    // flags changes with no progress within their per-state SLA (coordination/watchdog.ts).
    stateEnteredAt: timestamp("state_entered_at", { withTimezone: true }).notNull().defaultNow(),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }).notNull().defaultNow(),
    watchdogFlaggedAt: timestamp("watchdog_flagged_at", { withTimezone: true }),
    /**
     * MAJOR #6 fix (PR #7 review — "batch starvation"): set by `coordination/reconcile.ts` when
     * an `executing` change's active wave has `failed` and is awaiting an operator's manual
     * cancel/rollback (M3 has no auto-retry). That branch never otherwise touches `changes` at
     * all, so `updated_at` would sit frozen forever and — under `listChangeRowsInStates`'s
     * oldest-`updated_at`-first, capped batch — 25+ such parked changes would sort ahead of every
     * newer, genuinely-progressing `executing` change and starve it out of every batch
     * indefinitely. `listChangeRowsInStates` filters this column `IS NULL`, so a parked change
     * simply stops occupying batch slots until an operator acts (via the API directly, never
     * through this batch listing — see reconcile.ts's doc comment on the `failed` branch).
     */
    reconcileBlockedAt: timestamp("reconcile_blocked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("changes_org_state").on(table.orgId, table.state),
    index("changes_org_state_entered").on(table.orgId, table.state, table.stateEnteredAt),
    index("changes_rollback_of").on(table.orgId, table.rollbackOfObjectId),
    index("changes_org_created").on(table.orgId, table.createdAt, table.objectId)
  ]
);

/**
 * Legal lifecycle edges — DESIGN §9.1 "Legal transitions are data". This table mirrors
 * `coordination/transitions.ts`'s `LEGAL_TRANSITIONS` constant exactly (seeded in the migration,
 * cross-checked by an integration test) so the state machine's shape is queryable data, not just
 * an in-process constant — while `coordination/transition.ts`'s guarded transition function uses
 * the pure TS function as its legality gate (BUILD_AND_TEST.md §4.1: "anything testable as a pure
 * function must be written as a pure function" — the exhaustive unit test needs no Docker).
 */
export const stateTransitions = pgTable(
  "state_transitions",
  {
    fromState: text("from_state").notNull(),
    toState: text("to_state").notNull(),
    trigger: text("trigger").notNull()
  },
  (table) => [uniqueIndex("state_transitions_pk").on(table.fromState, table.toState)]
);

/**
 * The gate-binding SEAM (BUILD_AND_TEST.md §8 M3 item 1: "gates are minimal here — M4 adds
 * policy/controls; model the binding seam now"). Nothing in M3 writes rows here (no API exposes
 * it yet — that's M4's policy engine); `coordination/gates.ts` queries it and, finding none,
 * always returns an `allow` verdict. The shape exists so M4 can bind real controls to a
 * lifecycle edge or a wave boundary without redesigning the guarded transition function.
 */
export const gateBindings = pgTable(
  "gate_bindings",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id").notNull(),
    scopeKind: text("scope_kind").notNull(), // 'lifecycle_edge' | 'wave_boundary'
    fromState: text("from_state"),
    toState: text("to_state"),
    topologyObjectId: uuid("topology_object_id"),
    waveIndex: bigint("wave_index", { mode: "number" }),
    controlRefs: jsonb("control_refs").notNull().default([]),
    enforcement: text("enforcement").notNull().default("required"), // advisory|recommended|required
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [index("gate_bindings_org_edge").on(table.orgId, table.fromState, table.toState)]
);

/**
 * Decision records (DESIGN §10.4) — the explainability funnel. Every engine verdict (lifecycle
 * transition, gate check, watchdog flag, rollback trigger, plan compile) persists exactly one of
 * these with its full input context and a structured reason tree, independent of whether the
 * verdict allowed or blocked anything.
 */
export const decisions = pgTable(
  "decisions",
  {
    id: uuid("id").primaryKey(), // UUIDv7
    orgId: uuid("org_id").notNull(),
    kind: text("kind").notNull(), // gate|policy|freeze|rollback_trigger|plan_diff|promotion|transition|watchdog
    subjectId: uuid("subject_id").notNull(), // the change/plan/etc decided about
    verdict: text("verdict").notNull(), // allow|block|warn|rollback|escalate|...
    inputContext: jsonb("input_context").notNull(),
    reasonTree: jsonb("reason_tree").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("decisions_org_subject").on(table.orgId, table.subjectId, table.createdAt),
    index("decisions_org_created").on(table.orgId, table.createdAt, table.id)
  ]
);

/**
 * Correlation (DESIGN §9.2): repo/path pattern -> component, matched against executor event
 * correlation hints (repo, path, commit SHA, artifact digest, labels, explicit correlation key).
 */
export const sourceMappings = pgTable(
  "source_mappings",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id").notNull(),
    sourceKind: text("source_kind").notNull(), // github|argocd|terraform|manual|...
    repoPattern: text("repo_pattern"), // glob, matched against source_ref.repo
    pathPattern: text("path_pattern"), // glob, matched against source_ref.path (optional)
    componentObjectId: uuid("component_object_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [index("source_mappings_org_source").on(table.orgId, table.sourceKind)]
);

/**
 * Webhook ingress: persist-then-process (DESIGN §8 "Webhook ingestion: raw payload persisted
 * first (signature-verified), then processed as an event — replayable and auditable"). The route
 * handler only verifies the signature and inserts a row; `coordination/webhook-processor.ts`
 * (invoked via pg-boss, same tick loop as reconciliation) turns unprocessed rows into Changes.
 */
export const changeSourceEvents = pgTable(
  "change_source_events",
  {
    id: uuid("id").primaryKey(), // UUIDv7 — doubles as an idempotency key for re-delivery
    orgId: uuid("org_id").notNull(),
    sourceKind: text("source_kind").notNull(),
    signatureVerified: boolean("signature_verified").notNull().default(false),
    headers: jsonb("headers").notNull(),
    payload: jsonb("payload").notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    resultingChangeObjectId: uuid("resulting_change_object_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [index("change_source_events_unprocessed").on(table.processedAt, table.createdAt)]
);

/**
 * Plan -> waves -> wave_targets ROWS (DESIGN §9.3) — the compiled execution shape of a Change.
 * Named `change_*` to avoid colliding with M2's unrelated `plans` table (`@scp/iac` desired-state
 * plan/apply). `topology_document` is a snapshot of the release topology at compile time (not a
 * live FK dereference) so a later topology edit never retroactively changes an in-flight plan —
 * consistent with DESIGN §10.1's "policies are versioned documents" pinning pattern.
 */
export const changePlans = pgTable(
  "change_plans",
  {
    id: uuid("id").primaryKey(), // UUIDv7
    orgId: uuid("org_id").notNull(),
    changeObjectId: uuid("change_object_id").notNull(),
    topologyObjectId: uuid("topology_object_id"),
    topologyVersion: bigint("topology_version", { mode: "number" }),
    topologyDocument: jsonb("topology_document"),
    status: text("status").notNull().default("compiled"), // compiled|active|completed|aborted
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [index("change_plans_org_change").on(table.orgId, table.changeObjectId)]
);

export const changeWaves = pgTable(
  "change_waves",
  {
    id: uuid("id").primaryKey(), // UUIDv7
    orgId: uuid("org_id").notNull(),
    planId: uuid("plan_id").notNull(),
    waveIndex: bigint("wave_index", { mode: "number" }).notNull(),
    name: text("name"),
    /** Fan-in gate (DESIGN §9.3): true unless the topology explicitly marks a wave as not gated. */
    requiresFanIn: boolean("requires_fan_in").notNull().default(true),
    status: text("status").notNull().default("pending"), // pending|running|succeeded|failed|skipped
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true })
  },
  (table) => [index("change_waves_org_plan").on(table.orgId, table.planId, table.waveIndex)]
);

export const changeWaveTargets = pgTable(
  "change_wave_targets",
  {
    id: uuid("id").primaryKey(), // UUIDv7
    orgId: uuid("org_id").notNull(),
    waveId: uuid("wave_id").notNull(),
    targetObjectId: uuid("target_object_id").notNull(),
    executorPluginId: text("executor_plugin_id"),
    executorRef: jsonb("executor_ref"), // ExternalRunRef once triggered
    /** Captured before trigger — what a rollback of this wave target would restore (DESIGN §9.4). */
    priorStateRef: jsonb("prior_state_ref"),
    status: text("status").notNull().default("pending"), // pending|triggering|triggered|observing|succeeded|failed|aborted
    attempt: bigint("attempt", { mode: "number" }).notNull().default(0),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("change_wave_targets_org_wave").on(table.orgId, table.waveId),
    index("change_wave_targets_org_target").on(table.orgId, table.targetObjectId)
  ]
);

// -------------------------------------------------------------------------------------------
// Idempotency-Key replay (DESIGN.md §6)
// -------------------------------------------------------------------------------------------

export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    orgId: uuid("org_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    route: text("route").notNull(),
    requestHash: text("request_hash").notNull(),
    responseStatus: bigint("response_status", { mode: "number" }).notNull(),
    responseBody: jsonb("response_body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [uniqueIndex("idempotency_keys_pk").on(table.orgId, table.idempotencyKey)]
);
