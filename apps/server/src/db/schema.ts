import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
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
    // M6 (DESIGN.md §13): NULL = normally authored/imported-and-confirmed row. 'manual' = a
    // hand-filled shadow copy of a commander-origin object entered via `scp federation hand-fill`
    // for an air-gapped outpost with no bundle transport available yet — unverified until a signed
    // bundle later arrives and `federation/reconcile.ts` confirms or replaces it (DESIGN §13).
    provenance: text("provenance"),
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
    id: uuid("id").primaryKey(), // UUIDv7 — the LOCAL event id (not a replay dedupe key — see below)
    orgId: uuid("org_id").notNull(),
    sourceKind: text("source_kind").notNull(),
    signatureVerified: boolean("signature_verified").notNull().default(false),
    /**
     * M7 (MAJOR #5, adversarial review): the PROVIDER's own delivery identity — GitHub's
     * `X-GitHub-Delivery` (unique per delivery, stable across a redelivery of the same event), or
     * a `payload-sha256:<hex>` of the raw body when no delivery header exists. A unique index on
     * `(org_id, source_kind, dedupe_key)` makes a redelivered/replayed (even validly-signed)
     * webhook a no-op instead of a second Change → second real workflow_dispatch/sync/apply. The
     * PK `id` is freshly minted per HTTP request and is NOT this key (that was the bug).
     */
    dedupeKey: text("dedupe_key"),
    headers: jsonb("headers").notNull(),
    payload: jsonb("payload").notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    resultingChangeObjectId: uuid("resulting_change_object_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("change_source_events_unprocessed").on(table.processedAt, table.createdAt),
    unique("change_source_events_dedupe").on(table.orgId, table.sourceKind, table.dedupeKey)
  ]
);

/**
 * observe()-driver watermarks (M10.2) — one cursor per (org, executor plugin INSTANCE) that the
 * pull-based change-detection loop (`coordination/observe.ts`) passes to
 * `ExecutorPlugin.observe(since)`. Bindings that share a `plugin_instance_id` share observe scope
 * (identical configured source), so the cursor is instance-scoped, not binding-scoped. The loop
 * polls each observe-capable binding, normalizes returned events into `change_source_events` (the
 * SAME queue the inbound-webhook route feeds — poll-vs-push equivalence, DESIGN §12), and advances
 * `cursor_token`. This is the fallback for connected-but-unwebhookable and air-gapped domains whose
 * executors cannot reach SCP's ingress. Upsert-in-place only (no delete route).
 */
export const executorObserveCursors = pgTable(
  "executor_observe_cursors",
  {
    orgId: uuid("org_id").notNull(),
    pluginInstanceId: text("plugin_instance_id").notNull(),
    /** Opaque watermark the plugin minted/interprets (the driver stores it verbatim). */
    cursorToken: text("cursor_token"),
    lastPolledAt: timestamp("last_polled_at", { withTimezone: true })
  },
  (table) => [primaryKey({ columns: [table.orgId, table.pluginInstanceId] })]
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

// -------------------------------------------------------------------------------------------
// M4 Governance Engine (DESIGN.md §10, BUILD_AND_TEST.md §8 M4). Hand-authored grants/RLS in
// drizzle/0010_governance.sql (same pattern as 0002/0005/0007). Policies and Controls themselves
// are NOT new tables — they are graph objects of the pre-seeded `policy`/`control` types
// (0002 §5), managed through typed-registry endpoints exactly like `release-topology` (0007 §9):
// the document lives in `objects.properties`, and the document's own version is `objects.version`
// (bumped on every update) — the same pinning pattern `change_plans.topology_version` already
// uses. What DOES need new projection tables is everything with real lifecycle/quorum state that
// the graph's generic model has no place for: control run evidence, approval quorum, and freezes.
// -------------------------------------------------------------------------------------------

/**
 * Binds an abstract `control` graph object to a concrete ControlPlugin implementation (DESIGN
 * §10.2: "ControlPlugin implementations are bindings — swapping Trivy for Snyk... changes a
 * binding, never a policy"). `pluginModule`/`pluginInstanceId` feed the exact same
 * `PluginHostInstanceConfig` shape the M3 executor plugin host already uses
 * (plugin-host/contract.ts) — control plugins run under the identical subprocess host, just a
 * different `PluginHost.control(instanceId)` client (plugin-host/contract.ts, host.ts).
 */
export const controlBindings = pgTable(
  "control_bindings",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id").notNull(),
    controlObjectId: uuid("control_object_id").notNull(),
    pluginModule: text("plugin_module").notNull(), // 'webhook-control' (M4) | future control plugins
    pluginInstanceId: text("plugin_instance_id").notNull(),
    config: jsonb("config").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    unique("control_bindings_org_control_key").on(table.orgId, table.controlObjectId),
    index("control_bindings_org").on(table.orgId)
  ]
);

/**
 * Persisted control outcomes (DESIGN §10.2: "always with an evidence payload (persisted,
 * referenced by Decisions)"). One row per control evaluation attempt against one change at one
 * gate point; `decisionId` links back to the gate Decision that consulted this outcome.
 */
export const controlRuns = pgTable(
  "control_runs",
  {
    id: uuid("id").primaryKey(), // UUIDv7
    orgId: uuid("org_id").notNull(),
    controlObjectId: uuid("control_object_id").notNull(),
    changeObjectId: uuid("change_object_id").notNull(),
    gateKind: text("gate_kind").notNull(), // 'lifecycle_edge' | 'wave_boundary'
    gateRef: jsonb("gate_ref").notNull(), // {fromState,toState} or {waveIndex,topologyObjectId}
    status: text("status").notNull(), // pass|fail|warning|skipped|timed_out|expired
    evidence: jsonb("evidence").notNull().default({}),
    detail: text("detail"),
    decisionId: uuid("decision_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("control_runs_org_change").on(table.orgId, table.changeObjectId, table.createdAt),
    index("control_runs_org_control").on(table.orgId, table.controlObjectId)
  ]
);

/**
 * A materialized N-of-M approval requirement (DESIGN §10.2: "approval control instances
 * materialize as approval tasks"), one row per (change, firing policy, policy version, effect)
 * — re-derived idempotently by governance/gate evaluation every time it runs (the unique key
 * below makes creation an upsert-shaped no-op on repeat). `policyVersion` pins the exact
 * `objects.version` of the policy that was in force when this request was created, so the
 * requirement stays reconstructible even if the policy document is edited later (DESIGN §10.4).
 */
export const approvalRequests = pgTable(
  "approval_requests",
  {
    id: uuid("id").primaryKey(), // UUIDv7
    orgId: uuid("org_id").notNull(),
    changeObjectId: uuid("change_object_id").notNull(),
    policyObjectId: uuid("policy_object_id").notNull(),
    policyVersion: bigint("policy_version", { mode: "number" }).notNull(),
    effectIndex: bigint("effect_index", { mode: "number" }).notNull(),
    requiredCount: bigint("required_count", { mode: "number" }).notNull(),
    fromRole: text("from_role").notNull(),
    scopeObjectId: uuid("scope_object_id").notNull(),
    status: text("status").notNull().default("pending"), // pending|satisfied
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    satisfiedAt: timestamp("satisfied_at", { withTimezone: true }),
    satisfiedDecisionId: uuid("satisfied_decision_id")
  },
  (table) => [
    unique("approval_requests_dedup_key").on(
      table.orgId,
      table.changeObjectId,
      table.policyObjectId,
      table.policyVersion,
      table.effectIndex
    ),
    index("approval_requests_org_change").on(table.orgId, table.changeObjectId)
  ]
);

/**
 * One individual approval vote (DESIGN §10.2 "approval attestation"). The unique key is the
 * DB-enforced core of N-of-M quorum integrity — SECURITY-SENSITIVE (BUILD_AND_TEST.md §8 M4):
 * it makes "the same actor voting twice" a constraint violation, not just an application-layer
 * check that a bug could bypass. `attestation` holds the Ed25519-signed canonical record
 * (governance/attestation.ts) binding voter + approved object + decision id + timestamp
 * (DESIGN §10.2), independent of this row's own columns so the signed payload is self-contained
 * and portable (it is exactly what a future federation Promotion Bundle carries — DESIGN §13).
 */
export const approvalVotes = pgTable(
  "approval_votes",
  {
    id: uuid("id").primaryKey(), // UUIDv7
    orgId: uuid("org_id").notNull(),
    approvalRequestId: uuid("approval_request_id").notNull(),
    voterObjectId: uuid("voter_object_id").notNull(),
    decisionId: uuid("decision_id"),
    attestation: jsonb("attestation").notNull(),
    votedAt: timestamp("voted_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    unique("approval_votes_no_double_vote").on(
      table.orgId,
      table.approvalRequestId,
      table.voterObjectId
    ),
    index("approval_votes_org_request").on(table.orgId, table.approvalRequestId)
  ]
);

/**
 * Freeze windows (DESIGN §10.3): "a built-in policy effect with time windows and scope
 * (org/domain/service/component)." A dedicated projection table (not a graph object) because a
 * freeze's only state is a time window + scope + reason — no benefit to the generic object model
 * here, and `/freezes` is its own top-level API resource per DESIGN §6.
 */
export const freezes = pgTable(
  "freezes",
  {
    id: uuid("id").primaryKey(), // UUIDv7
    orgId: uuid("org_id").notNull(),
    scopeObjectId: uuid("scope_object_id").notNull(),
    name: text("name"),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    reason: text("reason").notNull(),
    createdByActorId: uuid("created_by_actor_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("freezes_org_scope").on(table.orgId, table.scopeObjectId),
    index("freezes_org_window").on(table.orgId, table.startsAt, table.endsAt)
  ]
);

/**
 * Ed25519 keypair this domain signs approval attestations AND (as of M6) sync-journal
 * entries/bundles with (DESIGN §10.2/§13: "the domain instance signs (Ed25519 domain key)").
 * Generated once per org on first use (governance/attestation.ts `ensureInstanceKey`), same trust
 * tier as `SCP_COOKIE_SECRET` — a server-side secret, never sent to clients.
 *
 * M6 CHANGE (org-scoped — M4's own doc comment anticipated exactly this: "multi-org attestation
 * verification is out of M4 scope (no federation yet — M6)"): originally a single fixed-id row
 * with "no org scoping, no RLS" under the reasoning that DESIGN's "domain key" is one key per SCP
 * INSTANCE (= federation domain), and a real deployment has exactly one org per instance anyway
 * (charter: "MSPs needing hard isolation run one instance per customer"). Scoped by `org_id` here
 * — matching `federation_self`'s own scoping decision (schema.ts's M6 section doc) — for two
 * reasons: (1) it lets federation's Testcontainers-level integration tests model two distinct
 * "domains" as two orgs sharing one test Postgres instance with genuinely DIFFERENT signing keys,
 * which the M6 DoD's tamper/signature tests require; (2) it keeps every federation identity
 * concept (self, peers, journal, signing key) consistently scoped the same way.
 *
 * M8 SECURITY-PASS FIX (drizzle/0016_instance_keys_rls.sql): the M6 org-scoping change above left
 * this table WITHOUT an `org_isolation` RLS policy — its "no RLS" reasoning predates M6 and was
 * written for a single GLOBAL row ("same treatment as state_transitions"), a premise the M6 change
 * made false but the policy was never revisited to match. Once this table held one PRIVATE SIGNING
 * KEY PER ORG in a table shared across every tenant, that gap meant a single forgotten `org_id`
 * filter (an app bug) — with no independent DB-level backstop — could leak one org's federation/
 * attestation signing key to another org's request context, violating DESIGN.md §4.2's
 * non-negotiable "two independent failures" invariant. Now has full RLS, matching every other
 * tenant-scoped table; `ensureInstanceKey`'s only call sites already run inside `withTenantTx`
 * (it takes a `TenantTx`), so this closes the gap with no impact on the legitimate access path.
 */
export const instanceKeys = pgTable(
  "instance_keys",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id").notNull(),
    publicKey: text("public_key").notNull(),
    privateKey: text("private_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [uniqueIndex("instance_keys_org_id_key").on(table.orgId)]
);

// -------------------------------------------------------------------------------------------
// M5 Campaigns & Initiatives (DESIGN.md §9.5, BUILD_AND_TEST.md §8 M5). Hand-authored
// grants/RLS/seed data in drizzle/0011_campaigns.sql (same pattern as 0002/0005/0007/0010).
//
// KEY DESIGN DECISION (documented at length in 0011's own header): a Campaign is NOT a second
// transition-guarded state machine. `campaign`/`initiative` are graph objects (pre-seeded
// built-in types, 0002 §5); what they need beyond the generic object model is exactly what a
// Change needed — a compiled plan -> waves -> wave_targets shape, over the SAME
// `coordination/plan-compiler.ts` pure function `change_plans`/`change_waves`/
// `change_wave_targets` already use. `campaign_wave_targets` differs in one way: its unit of work
// is an entire real M3 Change (`memberChangeObjectId`), not a direct executor trigger — see
// `coordination/campaign-reconcile.ts`. Campaign STATUS is a pure derived aggregation
// (`coordination/campaign-status.ts`), never a stored column here.
// -------------------------------------------------------------------------------------------

export const campaignPlans = pgTable(
  "campaign_plans",
  {
    id: uuid("id").primaryKey(), // UUIDv7
    orgId: uuid("org_id").notNull(),
    campaignObjectId: uuid("campaign_object_id").notNull(),
    topologyObjectId: uuid("topology_object_id"),
    topologyVersion: bigint("topology_version", { mode: "number" }),
    topologyDocument: jsonb("topology_document"),
    status: text("status").notNull().default("active"), // active|completed|aborted
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [index("campaign_plans_org_campaign").on(table.orgId, table.campaignObjectId)]
);

export const campaignWaves = pgTable(
  "campaign_waves",
  {
    id: uuid("id").primaryKey(), // UUIDv7
    orgId: uuid("org_id").notNull(),
    planId: uuid("plan_id").notNull(),
    waveIndex: bigint("wave_index", { mode: "number" }).notNull(),
    name: text("name"),
    requiresFanIn: boolean("requires_fan_in").notNull().default(true),
    // pending|blocked|running|succeeded|failed|skipped — 'blocked' is campaign-specific (not a
    // change_waves status): set when this wave's boundary gate returns a "block" verdict, so the
    // campaign's derived status can distinguish "still waiting to even start" from "actively
    // blocked by a policy/control" without a second Decision query (coordination/campaign-status.ts).
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true })
  },
  (table) => [index("campaign_waves_org_plan").on(table.orgId, table.planId, table.waveIndex)]
);

export const campaignWaveTargets = pgTable(
  "campaign_wave_targets",
  {
    id: uuid("id").primaryKey(), // UUIDv7
    orgId: uuid("org_id").notNull(),
    waveId: uuid("wave_id").notNull(),
    targetObjectId: uuid("target_object_id").notNull(),
    /** Set once the campaign reconciler proposes this target's member Change — DESIGN §9.5 /
     *  this milestone's spec: "Member changes are real Changes linked to the campaign via
     *  coordinates relationships." */
    memberChangeObjectId: uuid("member_change_object_id"),
    status: text("status").notNull().default("pending"), // pending|change_proposed|succeeded|failed
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("campaign_wave_targets_org_wave").on(table.orgId, table.waveId),
    index("campaign_wave_targets_org_target").on(table.orgId, table.targetObjectId),
    index("campaign_wave_targets_org_member_change").on(table.orgId, table.memberChangeObjectId)
  ]
);

// -------------------------------------------------------------------------------------------
// M6 Federation (DESIGN.md §13, BUILD_AND_TEST.md §8 M6). Hand-authored grants/RLS in
// drizzle/0012_federation.sql (same pattern as 0002/0007/0010/0011).
//
// SCOPING DECISION (M6 PR body): DESIGN.md's federation "domain" means a whole SCP instance (a
// Domain Control Plane) — a different concept from the pre-existing `domain` OBJECT TYPE (an
// org-internal containment node under which services/components live). This schema keeps
// federation identity/peers/journal ORG-SCOPED (one federation self-identity + peer set per org,
// same `org_isolation` RLS every other tenant table gets), because the sync journal is derived
// from the per-org outbox/audit stream and every row it carries (`objects`/`relationships`/
// `changes`/policy/approval rows) is already org_id-scoped end to end. Per the charter ("MSPs
// needing hard isolation run one instance per customer"), one org per instance is the expected
// shape, so this collapses to one federation domain per instance in practice — nothing in the M6
// DoD depends on the distinction. The Ed25519 key that SIGNS journal segments/bundles is the SAME
// key `governance/attestation.ts`'s `ensureInstanceKey` already manages for approval attestations
// — as of M6 that table (`instanceKeys`, above) is ALSO org-scoped, for exactly this reason, so
// "one Ed25519 identity signs both approval attestations and
// federation material" (DESIGN §13: "SCP performs all signing and validation itself") holds at
// the org-as-domain granularity this schema uses throughout.
// -------------------------------------------------------------------------------------------

/** This org's own federation identity within this instance — a singleton row per org, created
 *  lazily on first federation use (`federation/self-repo.ts` `ensureFederationSelf`). `role` is
 *  set explicitly by the operator (`scp federation init --role commander|outpost|retrans`), never
 *  inferred. */
export const federationSelf = pgTable("federation_self", {
  orgId: uuid("org_id").primaryKey(),
  domainId: uuid("domain_id").notNull().unique(), // this domain's own stable identity (UUIDv7, generated once, never reused)
  name: text("name").notNull(),
  role: text("role").notNull().default("unset"), // 'unset' | 'commander' | 'outpost' | 'retrans'
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});

/** Known peer domains (DESIGN §13 "peer pairing"), one row per paired remote domain. `syncScope`
 *  is configurable per peer (§13: full graph / policies-only / changes-only / status-only /
 *  label-selector custom). Pairing is always initiated by dialing OUT (§13 outpost-initiated-only)
 *  or, for air-gapped peers, by an out-of-band exchange of each side's public identity
 *  (`scp federation pair`) — never a live handshake the commander initiates. */
export const federationPeers = pgTable(
  "federation_peers",
  {
    id: uuid("id").primaryKey(), // = the peer's own federation_self.domainId
    orgId: uuid("org_id").notNull(),
    name: text("name").notNull(),
    role: text("role").notNull(), // as seen from here: 'commander' | 'outpost' | 'retrans'
    baseUrl: text("base_url"), // set on an outpost's record of its commander — what federation-https dials
    syncScope: jsonb("sync_scope").notNull().default({ mode: "full" }),
    pairedAt: timestamp("paired_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    unique("federation_peers_org_id_key").on(table.orgId, table.id),
    index("federation_peers_org").on(table.orgId)
  ]
);

/** Peer public-key history (rotation via signed journal events, DESIGN §13). Exactly one row per
 *  peer has `supersededAt IS NULL` (the current key) at any time — `federation-repo.ts` enforces
 *  this invariant on rotation rather than a DB constraint (a partial unique index would need a
 *  fixed sentinel for "current", which `NULL` already conveys unambiguously per peer).
 *
 *  SECURITY-SENSITIVE (M6 review fix — CRITICAL: rotation gave no compromise recovery). Key
 *  validity is anchored to the AUTHENTICATED, monotonic journal SEQUENCE, never to a self-declared
 *  timestamp an attacker can choose. On rotation, the OLD key records `supersededAtSequence` = the
 *  highest origin sequence this domain had verifiably applied from that peer (from `sync_cursors`);
 *  the NEW key records `effectiveFromSequence` at the same anchor. A key verifies entry with
 *  sequence S iff `effectiveFromSequence < S AND (supersededAtSequence IS NULL OR S <=
 *  supersededAtSequence)`. Because every future import applies only entries with sequence > the
 *  cursor (>= the anchor), a rotated-away (compromised) key can never verify any content that will
 *  ever be applied — rotation HARD-revokes it. The `effectiveFrom`/`supersededAt` TIMESTAMP columns
 *  are retained for display/audit only and are NEVER consulted for verification. */
export const federationPeerKeys = pgTable(
  "federation_peer_keys",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id").notNull(),
    peerDomainId: uuid("peer_domain_id").notNull(),
    publicKey: text("public_key").notNull(), // base64 SPKI DER
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull().defaultNow(),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    // Sequence-anchored validity window (the actual verification anchor — see doc above).
    effectiveFromSequence: bigint("effective_from_sequence", { mode: "number" })
      .notNull()
      .default(0),
    supersededAtSequence: bigint("superseded_at_sequence", { mode: "number" })
  },
  (table) => [
    index("federation_peer_keys_org_peer").on(table.orgId, table.peerDomainId, table.supersededAt)
  ]
);

/** The append-only Sync Journal (DESIGN §13 core) — every row hash-chained AND Ed25519-signed,
 *  monotonic `sequence` PER (org, origin domain) — see the scoping decision above. Stamps
 *  `(origin_domain_id, sequence, content_hash)` per DESIGN §13, plus the two v1-unused reserved
 *  fields (`baseRevision`, `conflict`) the overlay decision insures against a future format
 *  break. `seq` (identity) is a DB-internal insertion-order tiebreaker only, mirroring
 *  `audit_events.seq` — never part of the signed/hashed payload. */
export const syncJournal = pgTable(
  "sync_journal",
  {
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity().notNull(),
    id: uuid("id").primaryKey(), // UUIDv7
    orgId: uuid("org_id").notNull(),
    originDomainId: uuid("origin_domain_id").notNull(),
    sequence: bigint("sequence", { mode: "number" }).notNull(), // per (org, originDomainId) monotonic — DESIGN §13
    // object_upsert | object_tombstone | relationship_upsert | relationship_tombstone |
    // change_status | policy_upsert | approval_evidence | audit_segment | key_rotation
    entryKind: text("entry_kind").notNull(),
    payload: jsonb("payload").notNull(),
    contentHash: text("content_hash").notNull(),
    baseRevision: bigint("base_revision", { mode: "number" }), // reserved, v1-unused (DESIGN §13)
    conflict: text("conflict"), // reserved, v1-unused (DESIGN §13)
    prevHash: text("prev_hash").notNull(),
    rowHash: text("row_hash").notNull(),
    signature: text("signature").notNull(), // base64 Ed25519 signature over rowHash, by originDomainId's key
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    unique("sync_journal_origin_sequence_key").on(
      table.orgId,
      table.originDomainId,
      table.sequence
    ),
    index("sync_journal_org_origin_seq").on(table.orgId, table.originDomainId, table.sequence)
  ]
);

/** Per-peer resumable cursors (DESIGN §13: "per-domain monotonic sequence cursors make
 *  replication idempotent and resumable"). Tracks, for each (peer, origin domain) pair consumed
 *  from, the last sequence number durably applied on THIS side — an interrupted transfer resumes
 *  from here; re-applying an already-seen sequence is a no-op. */
export const syncCursors = pgTable(
  "sync_cursors",
  {
    orgId: uuid("org_id").notNull(),
    peerDomainId: uuid("peer_domain_id").notNull(),
    originDomainId: uuid("origin_domain_id").notNull(),
    lastAppliedSeq: bigint("last_applied_seq", { mode: "number" }).notNull().default(0),
    // The imported `rowHash` of the entry at `lastAppliedSeq` — SECURITY-SENSITIVE: this is what
    // lets a RESUMED import verify true hash-chain continuity across separate import calls (not
    // just internal-to-one-bundle contiguity). Without it, an attacker controlling a later bundle
    // could splice in a fabricated sub-chain starting at `cursor + 1` with a `prevHash` that
    // matches nothing real, and `verifyJournalChain` would have no prior tail to check it against.
    // NULL until the first entry from this (peer, origin) pair is applied.
    lastAppliedRowHash: text("last_applied_row_hash"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("sync_cursors_pk").on(table.orgId, table.peerDomainId, table.originDomainId)
  ]
);

/** Bundle-transfer tracking (DESIGN §13: "export created -> transfer submitted -> confirmed when
 *  a returned bundle carries the outpost's import cursor"). One row per `.scpbundle` this side
 *  produced or consumed. */
export const bundleTransfers = pgTable(
  "bundle_transfers",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id").notNull(),
    peerDomainId: uuid("peer_domain_id").notNull(),
    direction: text("direction").notNull(), // 'export' | 'import'
    kind: text("kind").notNull().default("sync"), // 'sync' | 'promotion'
    status: text("status").notNull().default("created"), // created|submitted|confirmed
    sinceSequence: bigint("since_sequence", { mode: "number" }),
    throughSequence: bigint("through_sequence", { mode: "number" }),
    checksum: text("checksum"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true })
  },
  (table) => [
    index("bundle_transfers_org_peer").on(table.orgId, table.peerDomainId, table.createdAt)
  ]
);

/** Imported-approval EVIDENCE (DESIGN §13: "approvals transfer as evidence, never as authority").
 *  Deliberately a separate table from `approval_votes` — these rows are never counted toward a
 *  LOCAL `approval_requests` quorum; they are read-only, attestation-validated proof attached to
 *  an imported Change for `scp change explain`/UI display only. */
export const importedApprovalEvidence = pgTable(
  "imported_approval_evidence",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id").notNull(),
    changeObjectId: uuid("change_object_id").notNull(), // the LOCAL imported change
    originDomainId: uuid("origin_domain_id").notNull(), // whose approval this was
    attestation: jsonb("attestation").notNull(), // the SignedAttestation exactly as received
    verified: boolean("verified").notNull(), // did validation pass against the origin's registered key?
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [index("imported_approval_evidence_org_change").on(table.orgId, table.changeObjectId)]
);

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

// -------------------------------------------------------------------------------------------
// M7 Real Executor Integrations (DESIGN.md §11, §12, BUILD_AND_TEST.md §8 M7). Hand-authored
// grants/RLS in drizzle/0014_m7_executor_integrations.sql (same pattern as 0002/0005/0007/0010).
//
// `executor_bindings` is the exact gap `coordination/executor-config.ts`'s module doc predicted
// ("that lands once ExecutorPlugin config becomes a registry object, alongside GitHub/ArgoCD/
// Terraform in M7") — the M4 `control_bindings` precedent for a graph object bound to a concrete
// plugin instance, applied to Component/DeploymentTarget objects instead of Control objects.
//
// `secrets` is the org-scoped, ENCRYPTED-AT-REST credential store the GitHub App private key /
// ArgoCD token / managed-IaC vaulted infra credentials need (`secrets/crypto.ts` — AES-256-GCM,
// keyed by an operator-supplied `SCP_SECRETS_MASTER_KEY`, never the app database itself). This is
// deliberately NOT modeled on `instance_keys` (M4/M6): that table is explicitly plaintext-in-
// Postgres with no RLS, an acceptable narrow exception for one federation-domain-wide signing key;
// a general-purpose secrets store handling many tenants' arbitrary plugin credentials gets both
// real encryption and RLS.
//
// `notification_bindings` gives the M3 watchdog escalation seam (coordination/watchdog.ts) and
// governance gate blocks somewhere real to send to — an org may configure more than one channel
// (hence no per-org uniqueness), each bound to a `NotificationPlugin` instance exactly like an
// executor/control binding.
// -------------------------------------------------------------------------------------------

/** Org-scoped, encrypted-at-rest secret material referenced BY KEY from `executor_bindings.config`
 *  / `notification_bindings.config` (e.g. `{ "privateKeySecretRef": "github-app-1-private-key" }`)
 *  — plugin instances never see a secret unless their own binding's config explicitly names it,
 *  and the plaintext is decrypted only in-memory, injected into the plugin's subprocess env at
 *  spawn time (`plugin-host/host.ts`), never logged, never persisted anywhere but this ciphertext
 *  column. */
export const secrets = pgTable(
  "secrets",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id").notNull(),
    key: text("key").notNull(), // caller-chosen reference name, unique per org
    ciphertext: text("ciphertext").notNull(), // base64(AES-256-GCM(plaintext) || authTag)
    nonce: text("nonce").notNull(), // base64, 12-byte GCM IV, fresh per encryption
    keyVersion: integer("key_version").notNull().default(1), // which master key encrypted this row
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    unique("secrets_org_key").on(table.orgId, table.key),
    index("secrets_org").on(table.orgId)
  ]
);

/** Binds a Component/DeploymentTarget graph object to a concrete `ExecutorPlugin` instance —
 *  `pluginModule`/`pluginInstanceId`/`config` feed the exact same `PluginHostInstanceConfig` shape
 *  `control_bindings` already does (plugin-host/contract.ts); `secretRefs` names which `secrets`
 *  rows (by key) get resolved and injected as this instance's `PluginContext.secrets` at
 *  provisioning time (coordination/executor-bindings-repo.ts's `resolveExecutorPluginInstance`).
 *  `allowedHosts` is this instance's egress allowlist (SSRF mitigation, plugin-host/host.ts) —
 *  empty/omitted means the plugin's own manifest-declared defaults apply. */
export const executorBindings = pgTable(
  "executor_bindings",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id").notNull(),
    targetObjectId: uuid("target_object_id").notNull(),
    pluginModule: text("plugin_module").notNull(), // 'github'|'argocd'|'terraform'|'managed-iac'|...
    pluginInstanceId: text("plugin_instance_id").notNull(),
    config: jsonb("config").notNull().default({}),
    secretRefs: jsonb("secret_refs").notNull().default({}), // { configFieldName: secretKey }
    allowedHosts: jsonb("allowed_hosts").notNull().default([]),
    // The EXECUTOR-SPECIFIC target identifier this graph object maps to (e.g. an Argo CD Application
    // name), passed as `trigger().targetRef`. Nullable: when unset, reconcile falls back to the
    // object id — backward-compatible with pre-M12 bindings. This is what lets one execution system
    // coordinate many objects whose ids differ from their external names (Mode A / import).
    externalRef: text("external_ref"),
    // Optional reference to an `execution-system` graph object (M12 P2). When set, the plugin's
    // serverUrl + token are resolved FROM that object (not this binding's inline config), and the
    // plugin instance is keyed on the system id so all bindings on one system share one observe poll.
    executionSystemId: uuid("execution_system_id"),
    // WHICH pipeline this binding drives for the target (M12 P3, migration 0023): 'infra' | 'software'.
    // A component may own BOTH (owner model: "all services involve infra and software"), so bindings
    // are 1:N per target, keyed by purpose. Defaults to 'software': every pre-P3 binding is the one
    // reconcile triggers today, and reconcile asks for 'software' — so 1:N changed no behaviour.
    purpose: text("purpose").notNull().default("software"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    unique("executor_bindings_org_target_purpose_key").on(
      table.orgId,
      table.targetObjectId,
      table.purpose
    ),
    index("executor_bindings_org").on(table.orgId)
  ]
);

/** An org's notification channels (DESIGN §11 `NotificationPlugin`) — the watchdog escalation
 *  seam and governance gate-block notices fan out to every row here, best-effort (one channel's
 *  delivery failure never blocks another's, nor the engine action that triggered it). */
export const notificationBindings = pgTable(
  "notification_bindings",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id").notNull(),
    pluginModule: text("plugin_module").notNull(), // 'smtp-notify'|'webhook-notify'
    pluginInstanceId: text("plugin_instance_id").notNull(),
    config: jsonb("config").notNull().default({}),
    secretRefs: jsonb("secret_refs").notNull().default({}),
    allowedHosts: jsonb("allowed_hosts").notNull().default([]),
    minSeverity: text("min_severity").notNull().default("info"), // info|warning|critical
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    unique("notification_bindings_org_instance_key").on(table.orgId, table.pluginInstanceId),
    index("notification_bindings_org").on(table.orgId)
  ]
);

/** Per-org, per-source-kind webhook signing secret KEY REFERENCE (into `secrets`) — resolved by
 *  `routes/change-sources.ts` before it will accept a delivery as signature-verified. Kept as its
 *  own tiny table (not folded into `source_mappings`, which is 1:N per source kind and has no
 *  natural place for a singleton secret) so rotating a webhook secret never touches correlation
 *  config. */
export const changeSourceWebhookSecrets = pgTable(
  "change_source_webhook_secrets",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id").notNull(),
    sourceKind: text("source_kind").notNull(),
    secretKey: text("secret_key").notNull(), // references secrets.key for this org
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    unique("change_source_webhook_secrets_org_source_key").on(table.orgId, table.sourceKind)
  ]
);
