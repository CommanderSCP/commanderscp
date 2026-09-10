import {
  bigint,
  boolean,
  check,
  foreignKey,
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
import type { ContainmentDomainId, TrustDomainId } from "@scp/schemas";

/** M1 Graph Core schema. See docs/db.md §38. */

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
    // NULL for OIDC-provisioned accounts (M2 step 2, drizzle/0004_auth_expansion.sql) — those
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

/** Personal Access Tokens (M2 step 2, BUILD_AND_TEST.md §8 M2 item 3). See docs/db.md §39. */
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

/** SCP's own RFC 8628-shaped device-authorization flow. See docs/db.md §40. */
export const deviceAuthRequests = pgTable("device_auth_requests", {
  id: uuid("id").primaryKey(),
  deviceCodeHash: text("device_code_hash").notNull().unique(),
  userCode: text("user_code").notNull().unique(),
  status: text("status").notNull().default("pending"),
  orgId: uuid("org_id").references(() => orgs.id),
  /** Set on approval; the user whose auth context the deferred session gets minted from at claim time. */
  approvedByUserId: uuid("approved_by_user_id").references(() => users.id),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});

// Runtime type registry (DESIGN.md §4.1)

export const objectTypes = pgTable("object_types", {
  id: text("id").primaryKey(),
  orgId: uuid("org_id"),
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

// The graph (DESIGN.md §4.1)

export const objects = pgTable(
  "objects",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id").notNull(),
    // CONTAINMENT sense (ADR-0021 D4). See docs/db.md §41.
    domainId: uuid("domain_id").$type<ContainmentDomainId>(),
    typeId: text("type_id")
      .notNull()
      .references(() => objectTypes.id),
    name: text("name").notNull(),
    urn: text("urn").notNull(),
    properties: jsonb("properties").notNull().default({}),
    labels: jsonb("labels").notNull().default({}),
    // federation provenance (DESIGN.md §4.1 — every row is born federation-ready).
    // TRUST sense (ADR-0021 D4) — the security domain that authored this row.
    originDomainId: uuid("origin_domain_id").notNull().$type<TrustDomainId>(),
    revision: bigint("revision", { mode: "number" }).notNull().default(1),
    contentHash: text("content_hash").notNull(),
    // M6 (DESIGN.md §13): NULL = normally authored/imported-and-confirmed row. 'manual' = a
    // hand-filled shadow copy of a commander-origin object entered via `scp federation hand-fill`
    // for an air-gapped outpost with no bundle transport available yet — unverified until a signed
    // bundle later arrives and `federation/reconcile.ts` confirms or replaces it (DESIGN §13).
    provenance: text("provenance"),
    // True when this object's existence stays inside its own domain. See docs/db.md §42.
    domainLocal: boolean("domain_local").notNull().default(false),
    // M20.7 (ADR-0031 §6c) — WHY this object is domain-local. See docs/db.md §43.
    domainLocalInheritedFrom: uuid("domain_local_inherited_from"),
    domainLocalInheritedFromUrn: text("domain_local_inherited_from_urn"),
    // The stack whose apply owns this row, which is what scopes pruning. See docs/db.md §44.
    managedByStack: text("managed_by_stack"),
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
    index("obj_labels").using("gin", sql`${table.labels} jsonb_path_ops`),
    // drizzle/0068 — the prune-pool lookup. Partial: almost nothing on an estate is IaC-managed,
    // and the query never asks for the rows that are not.
    index("obj_managed_stack")
      .on(table.orgId, table.managedByStack)
      .where(sql`${table.managedByStack} IS NOT NULL AND ${table.deletedAt} IS NULL`),
    // drizzle/0059 — the domain-local set, which is a small minority of any estate's rows.
    index("obj_domain_local")
      .on(table.orgId)
      .where(sql`${table.domainLocal}`),
    // drizzle/0051 — ONE placement per (component, deployment target). Functional and partial: the
    // pair lives in `properties`, and only live `placement` rows are constrained. This is a
    // DATABASE guard because the application's check-then-insert was proven racy — two concurrent
    // creates both read "no placement yet" and both wrote one.
    uniqueIndex("objects_placement_one_per_component_target")
      .on(
        table.orgId,
        sql`((${table.properties} ->> 'componentId'))`,
        sql`((${table.properties} ->> 'deploymentTargetId'))`
      )
      .where(sql`${table.typeId} = 'placement' AND ${table.deletedAt} IS NULL`),
    // drizzle/0095 — ONE artifact per (digest, artifact type). Same shape and same reason as the
    // placement index above: minting an artifact is a check-then-insert, and a digest that arrives
    // twice concurrently must collapse to one row rather than fork the registry projection.
    uniqueIndex("objects_artifact_one_per_digest_type")
      .on(
        table.orgId,
        sql`((${table.properties} ->> 'digest'))`,
        sql`((${table.properties} ->> 'artifactType'))`
      )
      .where(sql`${table.typeId} = 'artifact' AND ${table.deletedAt} IS NULL`)
  ]
);

export const relationships = pgTable(
  "relationships",
  {
    id: uuid("id").primaryKey(),
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
    // Mirrors the object labels an IaC apply stamps. See docs/db.md §45.
    labels: jsonb("labels").notNull().default({}),
    // TRUST sense (ADR-0021 D4) — the security domain that authored this row.
    originDomainId: uuid("origin_domain_id").notNull().$type<TrustDomainId>(),
    revision: bigint("revision", { mode: "number" }).notNull().default(1),
    contentHash: text("content_hash").notNull(),
    // drizzle/0068 — mirrors `objects.managed_by_stack`; see that column for the full reasoning.
    // Same single writer (`iac/stack-ownership.ts`), same non-federating behaviour, same reason.
    managedByStack: text("managed_by_stack"),
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
    index("rel_labels").using("gin", sql`${table.labels} jsonb_path_ops`),
    index("rel_managed_stack")
      .on(table.orgId, table.managedByStack)
      .where(sql`${table.managedByStack} IS NOT NULL AND ${table.deletedAt} IS NULL`),
    // drizzle/0022 — a component is contained by AT MOST ONE service. Keyed on `to_id` (the
    // contained end) and partial on live `contains` rows. A database guard because the route's
    // check-then-insert was proven racy: two concurrent attaches both saw no parent.
    uniqueIndex("relationships_contains_one_service_per_component")
      .on(table.orgId, table.toId)
      .where(sql`${table.typeId} = 'contains' AND ${table.deletedAt} IS NULL`),
    // drizzle/0049 — a component releases via AT MOST ONE pipeline. Keyed on `from_id` (the
    // component end); same racy check-then-insert, same database-level answer.
    uniqueIndex("relationships_releases_via_one_pipeline_per_component")
      .on(table.orgId, table.fromId)
      .where(sql`${table.typeId} = 'releases_via' AND ${table.deletedAt} IS NULL`)
  ]
);

// RBAC (DESIGN.md §7)

export const roles = pgTable(
  "roles",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id"),
    name: text("name").notNull(),
    permissions: text("permissions").array().notNull(),
    /** drizzle/0108 — the IaC stack that authored this ORG role, or NULL. Never set on a built-in:
     *  `roles-repo.ts` addresses org rows only, so no stack name can reach an `org_id IS NULL`
     *  singleton. Pruning is bounded by the delete door, which refuses while a binding points at
     *  the role. */
    managedByStack: text("managed_by_stack"),
    /** drizzle/0097 — object type ids this role may be bound at. See docs/db.md §46. */
    bindableAt: text("bindable_at").array()
  },
  (table) => [
    /** Partial, so an org may reuse a built-in role name. See docs/db.md §47. */
    uniqueIndex("roles_builtin_name_key")
      .on(table.name)
      .where(sql`${table.orgId} IS NULL`),
    /** The org-scoped counterpart the earlier index left uncovered. See docs/db.md §48. */
    uniqueIndex("roles_org_name_key")
      .on(table.orgId, table.name)
      .where(sql`${table.orgId} IS NOT NULL`),
    /** drizzle/0108 — the IaC prune-pool scan, partial on the non-NULL half because the
     *  overwhelming majority of rows are hand-authored and never selected by it. */
    index("roles_managed_stack")
      .on(table.orgId, table.managedByStack)
      .where(sql`${table.managedByStack} IS NOT NULL`)
  ]
);

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
    effect: text("effect").notNull().default("allow"),
    /** The stack that created this binding, or null when granted. See docs/db.md §49. */
    managedByStack: text("managed_by_stack"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("role_bindings_subject").on(table.orgId, table.subjectId),
    index("role_bindings_scope").on(table.orgId, table.scopeObjectId),
    /** drizzle/0097 — the NATURAL KEY of a grant. See docs/db.md §50. */
    unique("role_bindings_grant_key").on(
      table.orgId,
      table.subjectId,
      table.roleId,
      table.scopeObjectId,
      table.effect
    ),
    /** Classified by exact string equality, never by coercion. See docs/db.md §51. */
    check("role_bindings_effect_check", sql`${table.effect} IN ('allow', 'deny')`),
    /** drizzle/0108 — the IaC prune-pool scan; see `roles_managed_stack`. Partial for the same
     *  reason: the overwhelming majority of grants are hand-authored. */
    index("role_bindings_managed_stack")
      .on(table.orgId, table.managedByStack)
      .where(sql`${table.managedByStack} IS NOT NULL`)
  ]
);

// -------------------------------------------------------------------------------------------
// Audit log (DESIGN.md §4.3) — append-only, hash-chained. UPDATE/DELETE revoked from scp_app in
// the hand-authored RLS/grants migration; a guard trigger is belt-and-braces.
// -------------------------------------------------------------------------------------------

export const auditEvents = pgTable(
  "audit_events",
  {
    // Strictly-monotonic insertion-order tiebreaker. See docs/db.md §52.
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity().notNull(),
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id").notNull(),
    // CONTAINMENT sense (ADR-0021 D4) — the containing `domain` graph object the audited action
    // happened under, matching its position in DESIGN.md §4.3 (org_id, domain_id, actor_id,
    // subject_id are all graph-object scope). Nothing writes it today; branding it now keeps the
    // first writer from silently supplying a federation identity.
    domainId: uuid("domain_id").$type<ContainmentDomainId>(),
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
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id").notNull(),
    type: text("type").notNull(),
    source: text("source").notNull(),
    subject: text("subject"),
    data: jsonb("data").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true })
  },
  (table) => [index("outbox_unprocessed").on(table.processedAt, table.createdAt)]
);

// IaC plans (BUILD_AND_TEST.md §8 M2 item 4, DESIGN.md §15). See docs/db.md §53.

export const plans = pgTable(
  "plans",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id").notNull(),
    /** The graph subject (user/service-account object id) who requested the plan — mirrors `audit_events.actor_id`. */
    actorId: uuid("actor_id").notNull(),
    stackName: text("stack_name").notNull(),
    /** The exact submitted desired-state manifest, kept verbatim (DesiredStateManifest — @scp/schemas). */
    manifest: jsonb("manifest").notNull(),
    /** The computed typed diff at plan time (PlanDiff — @scp/schemas): create/update/delete/noop entries with reasons. */
    diff: jsonb("diff").notNull(),
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    appliedAt: timestamp("applied_at", { withTimezone: true })
  },
  (table) => [
    index("plans_org_created").on(table.orgId, table.createdAt, table.id),
    index("plans_org_stack").on(table.orgId, table.stackName)
  ]
);

// M3 Change Coordination Engine. See docs/db.md §54.

export const changes = pgTable(
  "changes",
  {
    objectId: uuid("object_id").primaryKey(),
    orgId: uuid("org_id").notNull(),
    state: text("state").notNull().default("proposed"),
    sourceKind: text("source_kind"),
    // The raw delivery payload, plus the canonical keys lifted from it. See docs/db.md §55.
    sourceRef: jsonb("source_ref"),
    correlationKey: text("correlation_key"),
    emergency: boolean("emergency").notNull().default(false),
    // TRUST sense (ADR-0021 D4) — the security domain a promotion bundle imported this change from.
    importedFromDomain: uuid("imported_from_domain").$type<TrustDomainId>(),
    /** The release-topology object (+ its document version, pinned) this change compiled against. */
    topologyObjectId: uuid("topology_object_id"),
    topologyVersion: bigint("topology_version", { mode: "number" }),
    /** Set when this Change IS a rollback — DESIGN §9.4 "a rollback is its own Change, linked to the original". */
    rollbackOfObjectId: uuid("rollback_of_object_id"),
    rollbackTriggerReason: text("rollback_trigger_reason"),
    /** 0053: `system` (engine auto-cancel) | `user`. NULL when not cancelled. */
    cancellationKind: text("cancellation_kind"),
    // Watchdog (DESIGN §9.4): `state_entered_at` resets on every legal transition; the sweep
    // flags changes with no progress within their per-state SLA (coordination/watchdog.ts).
    stateEnteredAt: timestamp("state_entered_at", { withTimezone: true }).notNull().defaultNow(),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }).notNull().defaultNow(),
    watchdogFlaggedAt: timestamp("watchdog_flagged_at", { withTimezone: true }),
    /** MAJOR #6 fix. See docs/db.md §56. */
    reconcileBlockedAt: timestamp("reconcile_blocked_at", { withTimezone: true }),
    /** THE RECONCILE ROUND-ROBIN CURSOR. See docs/db.md §57. */
    reconcileCursorAt: timestamp("reconcile_cursor_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
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

/** Legal lifecycle edges. See docs/db.md §58. */
export const stateTransitions = pgTable(
  "state_transitions",
  {
    fromState: text("from_state").notNull(),
    toState: text("to_state").notNull(),
    trigger: text("trigger").notNull()
  },
  (table) => [uniqueIndex("state_transitions_pk").on(table.fromState, table.toState)]
);

/** The gate-binding SEAM. See docs/db.md §59. */
export const gateBindings = pgTable(
  "gate_bindings",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id").notNull(),
    scopeKind: text("scope_kind").notNull(),
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

/** Decision records (DESIGN §10.4). See docs/db.md §60. */
export const decisions = pgTable(
  "decisions",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id").notNull(),
    kind: text("kind").notNull(), // gate|policy|freeze|rollback_trigger|plan_diff|promotion|transition|watchdog
    subjectId: uuid("subject_id").notNull(),
    verdict: text("verdict").notNull(), // allow|block|warn|rollback|escalate|...
    inputContext: jsonb("input_context").notNull(),
    reasonTree: jsonb("reason_tree").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("decisions_org_subject").on(table.orgId, table.subjectId, table.createdAt),
    index("decisions_org_created").on(table.orgId, table.createdAt, table.id),
    // The RECONCILE HOT PATH's exact shape. See docs/db.md §61.
    index("decisions_org_subject_kind_created").on(
      table.orgId,
      table.subjectId,
      table.kind,
      table.createdAt.desc(),
      table.id.desc()
    ),
    // The SERVICE BOARD's shape. See docs/db.md §62.
    index("decisions_org_subject_block_created")
      .on(table.orgId, table.subjectId, table.createdAt.desc(), table.id.desc())
      .where(sql`${table.verdict} = 'block'`),
    // `GET /decisions?kind=…` WITHOUT a subject (ADR-0028 increment 4). See docs/db.md §63.
    index("decisions_org_kind_created").on(table.orgId, table.kind, table.createdAt, table.id)
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
    sourceKind: text("source_kind").notNull(),
    repoPattern: text("repo_pattern"),
    pathPattern: text("path_pattern"),
    // Glob matched against the event's git REF. See docs/db.md §64.
    refPattern: text("ref_pattern"),
    componentObjectId: uuid("component_object_id").notNull(),
    // WHICH pipeline of that component this source drives. See docs/db.md §65.
    type: text("type").notNull().default("configuration"),
    // The operator's DECLARED classification of this pipeline. See docs/db.md §66.
    classification: text("classification"),
    // The operator's declared provenance for this mapping's repo. See docs/db.md §67.
    mirrorOfShared: boolean("mirror_of_shared").notNull().default(false),
    // The operator's PAUSE SWITCH, migration 0063. See docs/db.md §68.
    enabled: boolean("enabled").notNull().default(true),
    // A timed close, read together with `enabled`. See docs/db.md §69.
    disabledUntil: timestamp("disabled_until", { withTimezone: true }),
    // The operator's declared reach for this mapping's repo. See docs/db.md §70.
    scope: text("scope"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [index("source_mappings_org_source").on(table.orgId, table.sourceKind)]
);

/** Webhook ingress: persist-then-process. See docs/db.md §71. */
export const changeSourceEvents = pgTable(
  "change_source_events",
  {
    id: uuid("id").primaryKey(), // UUIDv7 — the LOCAL event id (not a replay dedupe key — see below)
    orgId: uuid("org_id").notNull(),
    sourceKind: text("source_kind").notNull(),
    signatureVerified: boolean("signature_verified").notNull().default(false),
    /** M7 (MAJOR #5, adversarial review). See docs/db.md §72. */
    dedupeKey: text("dedupe_key"),
    headers: jsonb("headers").notNull(),
    payload: jsonb("payload").notNull(),
    /** The authenticated principal that reported this event. See docs/db.md §73. */
    reportedByObjectId: uuid("reported_by_object_id"),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    resultingChangeObjectId: uuid("resulting_change_object_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("change_source_events_unprocessed").on(table.processedAt, table.createdAt),
    unique("change_source_events_dedupe").on(table.orgId, table.sourceKind, table.dedupeKey)
  ]
);

/** observe()-driver watermarks (M10.2). See docs/db.md §74. */
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

/** Latest object health. See docs/db.md §75. */
export const objectHealth = pgTable(
  "object_health",
  {
    orgId: uuid("org_id").notNull(),
    objectId: uuid("object_id").notNull(),
    status: text("status").notNull(),
    detail: text("detail"),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    /** Provenance of the push (`owner` today; a binding descriptor like `prometheus:<query>` later). */
    source: text("source"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [primaryKey({ columns: [table.orgId, table.objectId] })]
);

/** Plan -> waves -> wave_targets ROWS (DESIGN §9.3). See docs/db.md §76. */
export const changePlans = pgTable(
  "change_plans",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id").notNull(),
    changeObjectId: uuid("change_object_id").notNull(),
    topologyObjectId: uuid("topology_object_id"),
    topologyVersion: bigint("topology_version", { mode: "number" }),
    topologyDocument: jsonb("topology_document"),
    status: text("status").notNull().default("compiled"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [index("change_plans_org_change").on(table.orgId, table.changeObjectId)]
);

export const changeWaves = pgTable(
  "change_waves",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id").notNull(),
    planId: uuid("plan_id").notNull(),
    waveIndex: bigint("wave_index", { mode: "number" }).notNull(),
    name: text("name"),
    /** Fan-in gate (DESIGN §9.3): true unless the topology explicitly marks a wave as not gated. */
    requiresFanIn: boolean("requires_fan_in").notNull().default(true),
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true })
  },
  (table) => [index("change_waves_org_plan").on(table.orgId, table.planId, table.waveIndex)]
);

export const changeWaveTargets = pgTable(
  "change_wave_targets",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id").notNull(),
    waveId: uuid("wave_id").notNull(),
    targetObjectId: uuid("target_object_id").notNull(),
    // WHICH pipeline of the target this wave rolls — the routing Type (ADR-0007, migration 0026; was
    // `purpose` in 0024) — what reconcile resolves the executor binding by, now that a target can hold
    // one binding per Type (P3). Flows in from the source mapping that matched the release. Defaults
    // to 'configuration'. Plain text (no pg enum / CHECK); the closed value set is enforced in Zod.
    type: text("type").notNull().default("configuration"),
    executorPluginId: text("executor_plugin_id"),
    executorRef: jsonb("executor_ref"),
    /** Captured before trigger — what a rollback of this wave target would restore (DESIGN §9.4). */
    priorStateRef: jsonb("prior_state_ref"),
    // Last status() stateRef reconcile observed. See docs/db.md §77.
    observedState: jsonb("observed_state"),
    // The target's status, where `no_executor` is fail-closed terminal. See docs/db.md §78.
    status: text("status").notNull().default("pending"),
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

// Idempotency-Key replay (DESIGN.md §6)

// M4 Governance Engine. See docs/db.md §79.

/** Binds a control object to a concrete plugin implementation. See docs/db.md §80. */
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

/** Persisted control outcomes. See docs/db.md §81. */
export const controlRuns = pgTable(
  "control_runs",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id").notNull(),
    controlObjectId: uuid("control_object_id").notNull(),
    changeObjectId: uuid("change_object_id").notNull(),
    gateKind: text("gate_kind").notNull(),
    gateRef: jsonb("gate_ref").notNull(),
    status: text("status").notNull(), // pass|fail|warning|skipped|timed_out|expired
    evidence: jsonb("evidence").notNull().default({}),
    detail: text("detail"),
    decisionId: uuid("decision_id"),
    /** The plugin module stamped at insert, not read back later. See docs/db.md §82. */
    pluginModule: text("plugin_module"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("control_runs_org_change").on(table.orgId, table.changeObjectId, table.createdAt),
    index("control_runs_org_control").on(table.orgId, table.controlObjectId),
    // 0065 — the composite-FK target for `scan_findings`. See docs/db.md §83.
    unique("control_runs_org_id_key").on(table.orgId, table.id)
  ]
);

/** A materialized N-of-M approval requirement. See docs/db.md §84. */
export const approvalRequests = pgTable(
  "approval_requests",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id").notNull(),
    changeObjectId: uuid("change_object_id").notNull(),
    policyObjectId: uuid("policy_object_id").notNull(),
    policyVersion: bigint("policy_version", { mode: "number" }).notNull(),
    effectIndex: bigint("effect_index", { mode: "number" }).notNull(),
    requiredCount: bigint("required_count", { mode: "number" }).notNull(),
    fromRole: text("from_role").notNull(),
    scopeObjectId: uuid("scope_object_id").notNull(),
    status: text("status").notNull().default("pending"),
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

/** One individual approval vote. See docs/db.md §85. */
export const approvalVotes = pgTable(
  "approval_votes",
  {
    id: uuid("id").primaryKey(),
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

/** Freeze windows (DESIGN §10.3). See docs/db.md §86. */
export const freezes = pgTable(
  "freezes",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id").notNull(),
    scopeObjectId: uuid("scope_object_id").notNull(),
    name: text("name"),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    reason: text("reason").notNull(),
    createdByActorId: uuid("created_by_actor_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Whether this freeze still parks a whole wave. See docs/db.md §87. */
    atomic: boolean("atomic").notNull().default(false),
    /** This freeze was retracted: a soft lift, regardless of end. See docs/db.md §88. */
    liftedAt: timestamp("lifted_at", { withTimezone: true }),
    /** Who lifted it. No FK, matching `createdByActorId`: an actor is a graph object that can be
     *  tombstoned and the lift record must outlive them. */
    liftedByActorId: uuid("lifted_by_actor_id"),
    /** Why. MANDATORY (non-empty) at the route whenever `liftedAt` is set — lifting a freeze is a
     *  governance LOOSENING affecting everyone at once, and `freeze:override` already refuses to
     *  bypass a freeze for ONE change without a reason. */
    liftReason: text("lift_reason"),
    /** The id of this freeze's graph object, or null when local. See docs/db.md §89. */
    objectId: uuid("object_id")
  },
  (table) => [
    index("freezes_org_scope").on(table.orgId, table.scopeObjectId),
    index("freezes_org_window").on(table.orgId, table.startsAt, table.endsAt),
    /** M25.7 — one projection row per freeze object, so a replayed bundle converges instead of
     *  duplicating and the rebuild's `WHERE object_id = …` guard can never match two rows. Partial
     *  (drizzle/0089): the non-federating majority is unconstrained and unindexed. */
    uniqueIndex("freezes_org_object")
      .on(table.orgId, table.objectId)
      .where(sql`${table.objectId} IS NOT NULL`)
  ]
);

/** The Ed25519 keypair this domain signs attestations with. See docs/db.md §90. */
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

/** M17.3 E4 (drizzle/0030_instance_cosign_keys.sql). See docs/db.md §91. */
export const instanceCosignKeys = pgTable(
  "instance_cosign_keys",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id").notNull(),
    privateKey: text("private_key").notNull(),
    publicKey: text("public_key").notNull(),
    fingerprint: text("fingerprint"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [uniqueIndex("instance_cosign_keys_org_id_key").on(table.orgId)]
);

// M5 Campaigns (DESIGN.md §9.5, BUILD_AND_TEST.md §8 M5). See docs/db.md §92.

export const campaignPlans = pgTable(
  "campaign_plans",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id").notNull(),
    campaignObjectId: uuid("campaign_object_id").notNull(),
    topologyObjectId: uuid("topology_object_id"),
    topologyVersion: bigint("topology_version", { mode: "number" }),
    topologyDocument: jsonb("topology_document"),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [index("campaign_plans_org_campaign").on(table.orgId, table.campaignObjectId)]
);

export const campaignWaves = pgTable(
  "campaign_waves",
  {
    id: uuid("id").primaryKey(),
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
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id").notNull(),
    waveId: uuid("wave_id").notNull(),
    targetObjectId: uuid("target_object_id").notNull(),
    /** Set once the campaign reconciler proposes this target's member Change — DESIGN §9.5 /
     *  this milestone's spec: "Member changes are real Changes linked to the campaign via
     *  coordinates relationships." */
    memberChangeObjectId: uuid("member_change_object_id"),
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("campaign_wave_targets_org_wave").on(table.orgId, table.waveId),
    index("campaign_wave_targets_org_target").on(table.orgId, table.targetObjectId),
    index("campaign_wave_targets_org_member_change").on(table.orgId, table.memberChangeObjectId)
  ]
);

// M6 Federation (DESIGN.md §13, BUILD_AND_TEST.md §8 M6). See docs/db.md §93.

/** This org's own federation identity within this instance — a singleton row per org, created
 *  lazily on first federation use (`federation/self-repo.ts` `ensureFederationSelf`). `role` is
 *  set explicitly by the operator (`scp federation init --role commander|outpost|retrans`), never
 *  inferred. */
export const federationSelf = pgTable("federation_self", {
  orgId: uuid("org_id").primaryKey(),
  // TRUST sense (ADR-0021 D4). See docs/db.md §94.
  domainId: uuid("domain_id")
    .notNull()
    .unique("federation_self_domain_id_key")
    .$type<TrustDomainId>(),
  name: text("name").notNull(),
  role: text("role").notNull().default("unset"),
  /** §7.2.6 (drizzle/0092) — a per-org monotonic counter bumped by the resync operation (and the
   *  promotion runbook). Recorded WITH the resync Decision so a forensic reading can attribute
   *  entries to before/after a lost-tail event. Never enters the signed journal-entry format. */
  generation: bigint("generation", { mode: "number" }).notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});

/** Member-cluster version heartbeat (§7.4, drizzle/0093) — one row per member cluster, upserted on
 *  boot. INSTANCE-WIDE (no org_id). The migrations Job refuses a contract-phase deploy while any live
 *  heartbeat reports a version != the deploying one (an old member cluster still up; N and N+1 only). */
export const memberClusterHeartbeat = pgTable("member_cluster_heartbeat", {
  clusterId: text("cluster_id").primaryKey(),
  appVersion: text("app_version").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

/** Known peer domains. See docs/db.md §95. */
export const federationPeers = pgTable(
  "federation_peers",
  {
    // TRUST sense (ADR-0021 D4) — = the peer's own federation_self.domainId.
    id: uuid("id").primaryKey().$type<TrustDomainId>(),
    orgId: uuid("org_id").notNull(),
    name: text("name").notNull(),
    role: text("role").notNull(), // as seen from here: 'commander' | 'outpost' | 'retrans'
    baseUrl: text("base_url"), // set on an outpost's record of its commander — what federation-https dials
    syncScope: jsonb("sync_scope").notNull().default({ mode: "full" }),
    /** The peer's delivery target for signed channel artifacts. See docs/db.md §96. */
    deliveryTarget: jsonb("delivery_target"),
    /** M14.1 (ADR-0009, drizzle/0037) — per-peer poke-mode. See docs/db.md §97. */
    pokeMode: boolean("poke_mode").notNull().default(false),
    /** The live-pull scheduler's per-peer due state; null means now. See docs/db.md §98. */
    lastPullAttemptAt: timestamp("last_pull_attempt_at", { withTimezone: true }),
    lastPullSuccessAt: timestamp("last_pull_success_at", { withTimezone: true }),
    lastPokeReceivedAt: timestamp("last_poke_received_at", { withTimezone: true }),
    pairedAt: timestamp("paired_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    unique("federation_peers_org_id_key").on(table.orgId, table.id),
    index("federation_peers_org").on(table.orgId),
    /** drizzle/0045 (review round 4, H6) — `name` IS A RESOLUTION KEY: `getPeerByIdOrName` resolves a
     *  non-UUID path parameter by name, and `PATCH /v1/federation/peers/{id}` is a TRANSPORT WRITE. Two
     *  peers sharing a name made that write land on an arbitrary one of them. Read 0045's header for the
     *  self-healing backfill and for why the constraint (not a per-route narrowing) is the fix. */
    unique("federation_peers_org_name_key").on(table.orgId, table.name)
  ]
);

/** Peer public-key history. See docs/db.md §99. */
export const federationPeerKeys = pgTable(
  "federation_peer_keys",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id").notNull(),
    peerDomainId: uuid("peer_domain_id").notNull().$type<TrustDomainId>(), // TRUST sense (ADR-0021 D4)
    publicKey: text("public_key").notNull(),
    // The peer's cosign key, riding the same key window as Ed25519. See docs/db.md §100.
    cosignPublicKey: text("cosign_public_key"),
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

/** The append-only Sync Journal (DESIGN §13 core). See docs/db.md §101. */
export const syncJournal = pgTable(
  "sync_journal",
  {
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity().notNull(),
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id").notNull(),
    originDomainId: uuid("origin_domain_id").notNull().$type<TrustDomainId>(), // TRUST sense (ADR-0021 D4)
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
    signature: text("signature").notNull(),
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
    // Both TRUST sense (ADR-0021 D4).
    peerDomainId: uuid("peer_domain_id").notNull().$type<TrustDomainId>(),
    originDomainId: uuid("origin_domain_id").notNull().$type<TrustDomainId>(),
    lastAppliedSeq: bigint("last_applied_seq", { mode: "number" }).notNull().default(0),
    // The imported `rowHash` of the entry at `lastAppliedSeq`. See docs/db.md §102.
    lastAppliedRowHash: text("last_applied_row_hash"),
    /** ONE-SHOT RE-ANCHOR PERMIT. See docs/db.md §103. */
    reanchorFromSeq: bigint("reanchor_from_seq", { mode: "number" }),
    /** RAIL 4 — EXPORTER TAIL ATTESTATION HIGH-WATER MARK. See docs/db.md §104. */
    attestedTailSeq: bigint("attested_tail_seq", { mode: "number" }),
    attestedTailRowHash: text("attested_tail_row_hash"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("sync_cursors_pk").on(table.orgId, table.peerDomainId, table.originDomainId)
  ]
);

/** Federation audit witness (§7.2.7, drizzle/0091). See docs/db.md §105. */
export const federationAuditWitness = pgTable(
  "federation_audit_witness",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id").notNull(),
    peerDomainId: uuid("peer_domain_id").notNull().$type<TrustDomainId>(), // TRUST sense (ADR-0021 D4)
    originDomainId: uuid("origin_domain_id").notNull().$type<TrustDomainId>(),
    sequence: bigint("sequence", { mode: "number" }).notNull(),
    auditEventId: uuid("audit_event_id").notNull(),
    contentHash: text("content_hash").notNull(),
    witnessedAt: timestamp("witnessed_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("federation_audit_witness_origin_seq").on(
      table.orgId,
      table.originDomainId,
      table.sequence
    )
  ]
);

/** Bundle-transfer tracking (DESIGN §13). See docs/db.md §106. */
export const bundleTransfers = pgTable(
  "bundle_transfers",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id").notNull(),
    peerDomainId: uuid("peer_domain_id").notNull().$type<TrustDomainId>(), // TRUST sense (ADR-0021 D4)
    direction: text("direction").notNull(),
    kind: text("kind").notNull().default("sync"),
    status: text("status").notNull().default("created"),
    sinceSequence: bigint("since_sequence", { mode: "number" }),
    throughSequence: bigint("through_sequence", { mode: "number" }),
    checksum: text("checksum"),
    /** drizzle/0041 — HOW this transfer travelled. See docs/db.md §107. */
    transport: text("transport"),
    /** drizzle/0087 — WHICH LEG this hop was. See docs/db.md §108. */
    channel: text("channel"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true })
  },
  (table) => [
    index("bundle_transfers_org_peer").on(table.orgId, table.peerDomainId, table.createdAt),
    // Declared for fidelity; the migration creates it concurrently. See docs/db.md §109.
    index("bundle_transfers_org_peer_confirmed").on(
      table.orgId,
      table.peerDomainId,
      table.confirmedAt.desc().nullsLast()
    )
  ]
);

/** The unattended inbox loop's processed-file ledger. See docs/db.md §110. */
export const federationInboxFiles = pgTable(
  "federation_inbox_files",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id").notNull(),
    /** The RESOLVED inbox directory the file was listed in (per-peer DeliveryTarget inDir or the
     *  instance `SCP_RELAY_IN_DIR` fallback). */
    inboxDir: text("inbox_dir").notNull(),
    fileName: text("file_name").notNull(),
    /** sha256 (hex) of the file content; sentinel `-` when the file could not be read at all
     *  (e.g. a traversal-shaped name refused before any read). */
    sha256: text("sha256").notNull(),
    outcome: text("outcome").notNull(),
    detail: text("detail"),
    decisionId: uuid("decision_id"),
    processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("federation_inbox_files_identity").on(
      table.orgId,
      table.inboxDir,
      table.fileName,
      table.sha256
    ),
    index("federation_inbox_files_org_processed").on(table.orgId, table.processedAt)
  ]
);

/** M13.1b (drizzle/0047) — the staging-node AUTO-RELAY BUILD LEDGER. See docs/db.md §111. */
export const federationRelayBuilds = pgTable(
  "federation_relay_builds",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id").notNull(),
    /** The LOCAL imported change whose M17.4(a)-verified authorized set is relayed. */
    changeObjectId: uuid("change_object_id").notNull(),
    /** The EXPORTER's change id — what names the emitted tarball at the CDS. */
    sourceChangeObjectId: text("source_change_object_id"),
    /** 'pending' | 'built' | 'forwarded' | 'exhausted' — see the migration header. */
    status: text("status").notNull(),
    /** CLAIMS taken; also the fence token every release is guarded on. */
    attempts: integer("attempts").notNull().default(0),
    /** Attempts that produced a VERDICT and failed — the ONLY counter the cap is measured against,
     *  so an evicted worker cannot spend a change's budget without ever deciding anything. */
    failedAttempts: integer("failed_attempts").notNull().default(0),
    /** Retry gate: a 'pending' row is workable only at/after this instant. */
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    /** The claiming worker's lease; NULL = unclaimed. A dead worker's lease simply lapses. */
    claimedUntil: timestamp("claimed_until", { withTimezone: true }),
    lastReason: text("last_reason"),
    /** `buildRelayTarball`'s OWN Decision — identical to what the manual path writes. */
    lastDecisionId: uuid("last_decision_id"),
    tarballPath: text("tarball_path"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("federation_relay_builds_change").on(table.orgId, table.changeObjectId),
    index("federation_relay_builds_due").on(table.orgId, table.status, table.nextAttemptAt)
  ]
);

/** Pre-M16 residual, Track A (drizzle/0040). See docs/db.md §112. */
export const federationUnattachedChangeStatus = pgTable(
  "federation_unattached_change_status",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id").notNull(),
    /** TRUST sense (ADR-0021 D4) — the peer whose bundle carried the dropped entry. */
    peerDomainId: uuid("peer_domain_id").notNull().$type<TrustDomainId>(),
    /** `payload.objectId` — the change graph object id on the ORIGIN domain. Deliberately not a
     *  local FK: the whole point is that no local row with this id exists (yet). */
    changeObjectId: uuid("change_object_id").notNull(),
    /** Propose-time enrichment only — the transition payload carries neither, so both are nullable
     *  and preserved across later transitions. */
    urn: text("urn"),
    name: text("name"),
    /** `payload.toState ?? payload.state` — the last lifecycle state the peer reported. The board
     *  conditions its caveat on this being IN-FLIGHT, so one long-settled change cannot make a
     *  board claim ignorance forever. */
    lastState: text("last_state"),
    /** 'no_local_replica' (entry admitted; nothing local carries `changeObjectId` — the SENDER
     *  withheld the change object) | 'receiver_scope' (this receiver's own scope filter discarded
     *  it). Different operator-visible causes with different fixes; collapsing them would repeat
     *  the conflation this table exists to end. */
    dropReason: text("drop_reason").notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("federation_unattached_change_identity").on(
      table.orgId,
      table.peerDomainId,
      table.changeObjectId
    ),
    index("federation_unattached_change_org_state").on(table.orgId, table.lastState)
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
    changeObjectId: uuid("change_object_id").notNull(),
    originDomainId: uuid("origin_domain_id").notNull().$type<TrustDomainId>(), // TRUST sense (ADR-0021 D4) — whose approval this was
    attestation: jsonb("attestation").notNull(),
    verified: boolean("verified").notNull(),
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

// M7 Real Executor Integrations. See docs/db.md §113.

/** Encrypted secret material, referenced by key from a binding. See docs/db.md §114. */
export const secrets = pgTable(
  "secrets",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id").notNull(),
    key: text("key").notNull(),
    ciphertext: text("ciphertext").notNull(),
    nonce: text("nonce").notNull(),
    keyVersion: integer("key_version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    unique("secrets_org_key").on(table.orgId, table.key),
    index("secrets_org").on(table.orgId)
  ]
);

/** Binds a graph object to a concrete executor plugin instance. See docs/db.md §115. */
export const executorBindings = pgTable(
  "executor_bindings",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id").notNull(),
    targetObjectId: uuid("target_object_id").notNull(),
    pluginModule: text("plugin_module").notNull(),
    pluginInstanceId: text("plugin_instance_id").notNull(),
    config: jsonb("config").notNull().default({}),
    secretRefs: jsonb("secret_refs").notNull().default({}),
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
    // WHICH pipeline this binding drives for the target — the routing Type (ADR-0007, migration 0026;
    // was `purpose` in 0023). A component may own several Types at once (a `configuration` sync, an
    // `image` build, an `infrastructure` apply), so bindings are 1:N per target, keyed by type.
    // Defaults to 'configuration'. Plain text (no pg enum / CHECK); the closed value set is Zod-enforced.
    type: text("type").notNull().default("configuration"),
    /** ADR-0046 §4 / §14 res 7 — 'build' | 'test' (`ExecutorLaneSchema`). DEFAULT 'build': every
     *  pre-lane row is in the build lane, because that is what every binding was before lanes
     *  existed. Plain text, no pg enum, like `type` above and for the same reason. */
    lane: text("lane").notNull().default("build"),
    /** NULL for a hand-authored binding; the winning `executorBinding` policy's object id for one
     *  the domain reconciler derived. Provenance is READ FROM THE ROW (ADR-0046 §4), which is what
     *  lets the reconciler prune its own rows without touching a hand-authored one-off. */
    managedByPolicyId: uuid("managed_by_policy_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    unique("executor_bindings_org_target_type_lane_key").on(
      table.orgId,
      table.targetObjectId,
      table.type,
      table.lane
    ),
    index("executor_bindings_org").on(table.orgId),
    /** drizzle/0105 — the reconciler's own sweep: every row it manages, for one policy or across
     *  the domain. Partial, because a hand-bound row is never a candidate for it. */
    index("executor_bindings_managed_by_policy")
      .on(table.orgId, table.managedByPolicyId)
      .where(sql`${table.managedByPolicyId} IS NOT NULL`)
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
    pluginModule: text("plugin_module").notNull(),
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

/** Per-org, per-source-kind webhook signing secret KEY REFERENCE. See docs/db.md §116. */
export const changeSourceWebhookSecrets = pgTable(
  "change_source_webhook_secrets",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id").notNull(),
    sourceKind: text("source_kind").notNull(),
    secretKey: text("secret_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    unique("change_source_webhook_secrets_org_source_key").on(table.orgId, table.sourceKind)
  ]
);

// M17.5 — instance-scoped scan-requirement floors. See docs/db.md §117.
export const scanRequirementFloors = pgTable(
  "scan_requirement_floors",
  {
    tier: text("tier").notNull(),
    // 'local' | 'federated'. NOTE (dated 2026-07-23, M17.5 follow-on). See docs/db.md §118.
    origin: text("origin").notNull().default("local"),
    maxCritical: integer("max_critical"),
    maxHigh: integer("max_high"),
    maxMedium: integer("max_medium"),
    maxLow: integer("max_low"),
    note: text("note"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [primaryKey({ columns: [table.tier, table.origin] })]
);

// M22.2 — instance-scoped scan-EXCLUSION admissions. See docs/db.md §119.
export const scanExclusionAdmissions = pgTable(
  "scan_exclusion_admissions",
  {
    tier: text("tier").notNull(),
    class: text("class").notNull(),
    /** 'local' | 'federated'. As on `scanRequirementFloors`, the CHECK admits both but no federation
     *  writer produces `federated` rows today — outposts never evaluate scan policy (ADR-0020 §3). */
    origin: text("origin").notNull().default("local"),
    note: text("note"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [primaryKey({ columns: [table.tier, table.class, table.origin] })]
);

// M21.2 — the DEPENDENCY INVENTORY substrate. See docs/db.md §120.

/** The identity of ONE MAJOR LINE of one dependency, in one org. See docs/db.md §121. */
export const dependencyLines = pgTable(
  "dependency_lines",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id").notNull(),
    /** `npm` | `go` | `maven` | `python` | `oci`. Plain text with no pg enum and no CHECK, exactly
     *  like `sourceMappings.type`: the closed set is enforced in packages/schemas
     *  (`DependencyEcosystemSchema`), so a sixth ecosystem is a schema edit, not a migration. */
    ecosystem: text("ecosystem").notNull(),
    /** The ecosystem-native coordinate, verbatim and case-preserved: `@acme/lib`,
     *  `github.com/acme/lib`, `com.acme:lib`, `acme-lib`, `docker.io/library/alpine`. Never
     *  slugified — see the class comment. */
    coordinate: text("coordinate").notNull(),
    /** The major line, as the ecosystem spells it (`1`, `v2`, `3.18`). `text`, not an integer, for
     *  the same reason the coordinate is verbatim: Go writes `v2`, image lines are frequently
     *  two-segment, and parsing it to a number here would be the same lossy normalisation the URN
     *  scheme performs. */
    major: text("major").notNull(),
    /** `oci` only: image tags are not semver. See docs/db.md §122. */
    tagPattern: text("tag_pattern"),
    // THE PRODUCER LINK USED TO BE HERE. See docs/db.md §123.
    /** The head of the line as last OBSERVED. Written by M21.4 detection, never by manifest
     *  ingestion — a component declaring `1.2.0` says nothing about what the line's head is. NULL is
     *  "not yet observed", which is NOT "no newer version exists": absent never means zero, the same
     *  reading `scanRequirementFloors` established for its nullable ceilings. */
    latestVersion: text("latest_version"),
    /** `oci` — the digest `latestVersion`'s tag resolved to when observed. A mutable tag is not an
     *  identity (ADR-0032 §7), so the bytes are recorded alongside the label. */
    latestDigest: text("latest_digest"),
    latestObservedAt: timestamp("latest_observed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    // THE identity. `@acme/lib` and `acme-lib` are two rows here and one URN under `deriveUrn`;
    // that difference is the whole reason the inventory is tabular (ADR-0032 §3).
    uniqueIndex("dependency_lines_identity").on(
      table.orgId,
      table.ecosystem,
      table.coordinate,
      table.major
    ),
    // The composite-FK target for `componentDependencies` — see that table's `line_id` note.
    // Redundant with the primary key for uniqueness; it exists so a `(org_id, id)` foreign key has
    // something to reference.
    unique("dependency_lines_org_id_key").on(table.orgId, table.id)
    // `dependency_lines_org_producer` (the partial index over the declared minority) and
    // `dependency_lines_internal_is_declared` (the all-three-or-none CHECK) were dropped with the
    // columns they served — drizzle/0068. "Which lines does component X publish?" is now
    // `dependency_line_producers_org_producer` -> this table's `dependency_lines_identity`, whose
    // `(org_id, ecosystem, coordinate)` PREFIX serves the second hop, so no index was added to
    // replace it. The CHECK is retired rather than reproduced: in the new table every column is NOT
    // NULL and the ROW'S EXISTENCE IS THE DECLARATION, so a half-written declaration is not
    // representable instead of being refused.
  ]
);

/** WHICH COMPONENT THIS ORG DECLARES IT PRODUCES ONE COORDINATE. See docs/db.md §124. */
export const dependencyLineProducers = pgTable(
  "dependency_line_producers",
  {
    orgId: uuid("org_id").notNull(),
    /** `npm` | `go` | `maven` | `python` | `oci`. Plain text with no CHECK, exactly as on
     *  `dependencyLines.ecosystem`: packages/schemas is the only enforcement point. */
    ecosystem: text("ecosystem").notNull(),
    /** The ecosystem-native coordinate, VERBATIM and case-preserved — the same bytes
     *  `dependencyLines.coordinate` holds, because the join between the two is byte equality. */
    coordinate: text("coordinate").notNull(),
    /** The producing COMPONENT's graph object id. A `service` is refused by the verb in the first
     *  cut (ADR-0032 §7e): `listProducedLines` derives a head only from the component a prod
     *  placement names, so a service-valued declaration would remove the coordinate from
     *  third-party polling — the harmful half — and derive no head at all — the useful half. */
    producerObjectId: uuid("producer_object_id")
      .notNull()
      .references(() => objects.id),
    declaredAt: timestamp("declared_at", { withTimezone: true }).notNull().defaultNow(),
    /** WHO asserted it (principle 6). Taken from the authenticated subject at the route and never
     *  from the request body — a caller-supplied provenance label is a forgeable one. */
    declaredByObjectId: uuid("declared_by_object_id")
      .notNull()
      .references(() => objects.id)
  },
  (table) => [
    // ONE declaration per coordinate. The org cannot model "we produce @acme/lib@2, upstream
    // produces @acme/lib@1" — and that refusal is deliberate: that shape means a public index
    // legitimately answers for a coordinate the org also publishes, which is dependency confusion
    // with a data model behind it.
    primaryKey({
      name: "dependency_line_producers_pk",
      columns: [table.orgId, table.ecosystem, table.coordinate]
    }),
    // "Which coordinates does component X produce?" — the first hop of M21.4's internal-release
    // derivation, which used to be `dependency_lines_org_producer`.
    index("dependency_line_producers_org_producer").on(table.orgId, table.producerObjectId)
  ]
);

/** Which component declares which line, at which version. See docs/db.md §125. */
export const componentDependencies = pgTable(
  "component_dependencies",
  {
    orgId: uuid("org_id").notNull(),
    componentObjectId: uuid("component_object_id")
      .notNull()
      .references(() => objects.id),
    /** The line this declaration is against. Bound to the org by a COMPOSITE foreign key (see the
     *  `foreignKey` below) rather than a plain `references()`: RLS's WITH CHECK pins this row's own
     *  `org_id` to the session, and the composite key then makes pointing at ANOTHER org's line
     *  structurally impossible rather than merely filtered on read. */
    lineId: uuid("line_id").notNull(),
    /** Repo-relative path of the dependency manifest this was read out of (`package.json`,
     *  `go.mod`, `services/api/Dockerfile`). Part of the key: one component can legitimately declare
     *  the same line from two manifests (two Dockerfiles; a root and a workspace `package.json`),
     *  and collapsing them would make a prune of one silently delete the other's declaration. */
    manifestPath: text("manifest_path").notNull(),
    /** What the manifest LITERALLY says — `^1.2.3`, `~=1.4`, `v1.2.3`, `3.18-alpine`. Verbatim,
     *  because it is the exact string the M21.5 actuator has to edit; a normalised copy would be an
     *  edit target that does not appear in the file. */
    declaredVersion: text("declared_version").notNull(),
    /** The concrete version parsed OUT of `declaredVersion`, or NULL when the declaration pins none
     *  (an open range). Derived from the MANIFEST ALONE — no lockfile is read and no package manager
     *  is run, which is ADR-0032 §8's manifest-only scope boundary. NULL therefore means "the
     *  manifest does not pin one", never "we did not look". */
    resolvedVersion: text("resolved_version"),
    /** `oci` — the digest this component's `FROM` currently resolves to (ADR-0032 §7). */
    resolvedDigest: text("resolved_digest"),
    /** The repository the manifest was read from, as spelled. See docs/db.md §126. */
    observedRepo: text("observed_repo"),
    /** The git ref the manifest was read at (`refs/heads/main`), so a declaration is attributable to
     *  a point in the repo rather than to "whenever we last looked". */
    observedRef: text("observed_ref"),
    /** WHEN THE MANIFEST WAS READ. See docs/db.md §127. */
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    // `orgId` LEADS the key so the primary-key index IS the forward lookup ("what does component C
    // declare?", which is always org-scoped) and no second index is needed to serve it.
    primaryKey({
      name: "component_dependencies_pk",
      columns: [table.orgId, table.componentObjectId, table.lineId, table.manifestPath]
    }),
    foreignKey({
      name: "component_dependencies_line_fk",
      columns: [table.orgId, table.lineId],
      foreignColumns: [dependencyLines.orgId, dependencyLines.id]
    }),
    // The REVERSE lookup — "which components declare line L?" — the fan-out list a dependency
    // subscription resolves against. One index descent; deliberately not a traversal.
    index("component_dependencies_org_line").on(table.orgId, table.lineId)
  ]
);

/** One entry of {@link dependencyIngestionStamps.manifests} — what a pass established about ONE
 *  manifest path IN ONE REPOSITORY. Declared here beside the column so the jsonb has a type at
 *  every read. */
export interface IngestionStampManifest {
  /** The repository this evidence came from, so the array merges. See docs/db.md §128. */
  readonly repo: string;
  readonly path: string;
  /** Read outcomes: `ok`, retryable `unreadable`, or `unsupported`. See docs/db.md §129. */
  readonly outcome: "ok" | "unreadable" | "unsupported";
  /** `component_dependencies` rows THIS manifest's last observation wrote; 0 on an entry that was
   *  not read and on one whose manifest went away. The row's `rows_written` is the SUM of these
   *  over the merged set — it has to be, or a second repository's pass would report its own count
   *  as the whole component's and `ok` + 0 would stop meaning "declares nothing". */
  readonly rows: number;
  /** WHEN THE PASS THAT WROTE THIS ENTRY LOOKED, ISO-8601. See docs/db.md §130. */
  readonly at: string;
  /** The ingestion's own sentence about this path. Absent on the ordinary `ok` entry. */
  readonly detail?: string;
}

/** THE DEPENDENCY INGESTION'S RECEIPT, PER COMPONENT. See docs/db.md §131. */
export const dependencyIngestionStamps = pgTable(
  "dependency_ingestion_stamps",
  {
    orgId: uuid("org_id").notNull(),
    /** Org-unbound reference, the form the sibling columns use. See docs/db.md §132. */
    componentObjectId: uuid("component_object_id")
      .notNull()
      .references(() => objects.id),
    /** WHEN THIS PASS LOOKED — the phase-2 read time where a provider was reached, the start of the
     *  pass where it refused before reaching one. The same clock `component_dependencies.observed_at`
     *  is stamped from, so a pass's stamp and its rows describe one instant and two overlapping
     *  passes order identically in both places. */
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }).notNull(),
    /** Whether this inventory is loop-maintained or backfilled. See docs/db.md §133. */
    source: text("source").$type<"loop" | "backfill">().notNull(),
    /** What the manifests are known to be across every repository. See docs/db.md §134. */
    outcome: text("outcome").$type<"ok" | "partial" | "unreadable" | "not_enabled">().notNull(),
    /** The pass's own sentence, only when it declared the outcome. See docs/db.md §135. */
    detail: text("detail"),
    /** The rows the merged manifest set currently accounts for. See docs/db.md §136. */
    rowsWritten: integer("rows_written").notNull(),
    /** Per (REPOSITORY, manifest path), sorted. See docs/db.md §137. */
    manifests: jsonb("manifests")
      .$type<IngestionStampManifest[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** When this component was FIRST attempted. Not derivable from `lastAttemptAt`: "attempted once
     *  months ago and never since" and "attempted for the first time an hour ago" are different
     *  operational stories behind the same last-attempt timestamp. */
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    // `orgId` LEADS, so the primary-key index IS both reads — the point lookup ("what happened to
    // component C?") and the batched one a list view takes over many components at once. No second
    // index, because there is no second access path.
    primaryKey({
      name: "dependency_ingestion_stamps_pk",
      columns: [table.orgId, table.componentObjectId]
    })
  ]
);

/** WHAT COMMANDERSCP ITSELF AUTHORED FOR A DEPENDENCY BUMP. See docs/db.md §138. */
export const dependencyBumpAuthorships = pgTable(
  "dependency_bump_authorships",
  {
    orgId: uuid("org_id").notNull(),
    /** The bump change. Org-unbound `references(objects.id)`, the same form `changes.objectId` uses
     *  (0061's barrier-2 note: `objects` has no `(org_id, id)` unique constraint to reference). */
    changeObjectId: uuid("change_object_id")
      .notNull()
      .references(() => objects.id),
    componentObjectId: uuid("component_object_id")
      .notNull()
      .references(() => objects.id),
    lineId: uuid("line_id").notNull(),
    /** `owner/repo` — THE authority for which repository a merge may touch. */
    repo: text("repo").notNull(),
    /** The branch the pull request targets. The plugin asserts the provider agrees the pull
     *  request's OWN base is this before merging, so a retargeted pull request refuses. */
    baseBranch: text("base_branch").notNull(),
    /** `refs/heads/scp/dep-bump/<changeObjectId>` — recorded rather than only derived, so both sides
     *  of the provenance join are facts on disk. */
    authoredRef: text("authored_ref").notNull(),
    ecosystem: text("ecosystem").notNull(),
    coordinate: text("coordinate").notNull(),
    manifestPath: text("manifest_path").notNull(),
    fromVersion: text("from_version").notNull(),
    toVersion: text("to_version").notNull(),
    /** The commit SCP's own branch is at, written when the authored push is observed back through
     *  the two-sided branch check. NULL until then — a real state, and the reason a FIRST dispatch
     *  can never auto-merge. */
    headCommit: text("head_commit"),
    /** The pull request SCP opened, read back from the authoring run's own `status().stateRef`. The
     *  merge is addressed to THIS NUMBER, never to the first entry of a provider list. */
    pullRequestNumber: integer("pull_request_number"),
    /** The pull request URL as the provider returned it. See docs/db.md §139. */
    pullRequestUrl: text("pull_request_url"),
    /** Set once the provider confirms the merge — what stops the merge commit's OWN webhook from
     *  re-running the gate and overwriting the audit trail with a refusal for a bump that merged. */
    mergedAt: timestamp("merged_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    primaryKey({
      name: "dependency_bump_authorships_pk",
      columns: [table.orgId, table.changeObjectId]
    }),
    foreignKey({
      name: "dependency_bump_authorships_line_fk",
      columns: [table.orgId, table.lineId],
      foreignColumns: [dependencyLines.orgId, dependencyLines.id]
    }),
    // "Which bump is this commit the head of?" — the CI-conclusion correlation route, which ran as
    // an unbounded scan of every dependency-bump change in the org inside the ingress transaction.
    // PARTIAL in 0063, and mirrored here so the two do not disagree about what is indexed.
    index("dependency_bump_authorships_org_head_commit")
      .on(table.orgId, table.headCommit)
      .where(sql`${table.headCommit} is not null`),
    // The idempotency lookup a redelivered head-advance takes.
    index("dependency_bump_authorships_org_subject").on(
      table.orgId,
      table.componentObjectId,
      table.manifestPath,
      table.coordinate,
      table.toVersion
    )
  ]
);

/** THE PER-OBJECT RUNGS OF THE `governance:move` LATTICE. See docs/db.md §140. */
export const governanceMoveRungs = pgTable(
  "governance_move_rungs",
  {
    orgId: uuid("org_id").notNull(),
    /** The container the rung sits on — PK, because a rung is enabled or it is not. */
    subjectObjectId: uuid("subject_object_id")
      .notNull()
      .references(() => objects.id),
    /** `org` | `containment_domain` | `service` | `assembly`, the literal AT WRITE TIME.
     *  Explainability only, never re-derived on read — the convention
     *  `dependencies/subscription-resolution.ts`'s `tierForObjectType` documents. */
    tier: text("tier").notNull(),
    /** Principle 6: WHO enabled it. Stamped from the authenticated subject, never the request body. */
    enabledByObjectId: uuid("enabled_by_object_id")
      .notNull()
      .references(() => objects.id),
    enabledAt: timestamp("enabled_at", { withTimezone: true }).notNull().defaultNow(),
    /** The Decision the enablement recorded. Nullable for rows a future importer might write. */
    decisionId: uuid("decision_id")
  },
  (table) => [
    primaryKey({ name: "governance_move_rungs_pk", columns: [table.subjectObjectId] }),
    index("governance_move_rungs_org").on(table.orgId)
  ]
);

/** THE INSTANCE (COMMANDER) RUNG. See docs/db.md §141. */
export const governanceMoveInstanceRung = pgTable("governance_move_instance_rung", {
  id: text("id").primaryKey().default("default"),
  enabled: boolean("enabled").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

/** M25.3 — THE INSTANCE-SCOPED. See docs/db.md §142. */
export const instanceFreezes = pgTable(
  "instance_freezes",
  {
    /** A REAL uuid (uuidv7, stamped by the route), because this id travels into
     *  `ServiceBoardFreezeSchema.id` — published as `z.string().uuid()` in `openapi.v1.json`. A
     *  synthetic `platform:<key>` identity would either violate that shipped response contract or
     *  force widening it. Stable across a `PUT` upsert of the same key. */
    id: uuid("id").primaryKey(),
    /** The operator slug: the `PUT`/`DELETE` path segment. UNIQUE, not the PK. Named explicitly
     *  because drizzle/0086 calls the constraint `_uq`, not the `_unique` this sugar defaults to. */
    key: text("key").notNull().unique("instance_freezes_key_uq"),
    name: text("name"),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    reason: text("reason").notNull(),
    /** The explicit deployment-wide form — covers every target including one that declares no
     *  stage coordinate at all. Mutually exclusive with `matchEnvironment` (DB CHECK). */
    matchAllEnvironments: boolean("match_all_environments").notNull().default(false),
    matchEnvironment: text("match_environment"),
    /** Narrows `matchEnvironment` to one `properties.region`. Null = every region of it. */
    matchRegion: text("match_region"),
    /** Owner decision D5, the same semantics as `freezes.atomic` (0084) one tier up: `true` parks
     *  EVERY target of a wave once it covers any one of them. Read in both places the org-tier
     *  column is read — `gate-orchestrator.ts`'s `partiallyFrozen` and
     *  `coordination/freeze-hold.ts` — because the wave gate fires exactly once. */
    atomic: boolean("atomic").notNull().default(false),
    /** Whether any tenant role may override this freeze at all. See docs/db.md §143. */
    overridable: boolean("overridable").notNull().default(false),
    note: text("note"),
    /** SOFT retraction (`DELETE /v1/instance/freezes/{key}`) — 0085's ruling one tier up, for the
     *  same reason: the freeze-block Decision carries this id forever and a hard delete would make
     *  `scp change explain` name an id that resolves to nothing. Filtered in exactly ONE place,
     *  `governance/instance-freezes-repo.ts`'s `activeInstanceFreezesInWindow`. */
    liftedAt: timestamp("lifted_at", { withTimezone: true }),
    liftReason: text("lift_reason"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [index("instance_freezes_window").on(table.startsAt, table.endsAt)]
);

/** The per-finding projection of one scan verdict. See docs/db.md §144. */
export const scanFindings = pgTable(
  "scan_findings",
  {
    orgId: uuid("org_id").notNull(),
    /** The scan verdict these findings decompose — one `control_runs` row is exactly one scan
     *  outcome for one artifact digest at one gate crossing (M22.0a), which is the unit an exclusion
     *  is resolved for. */
    controlRunId: uuid("control_run_id").notNull(),
    /** POSITION within the persisted set, in the producing parser's order — the identity, because a
     *  finding has no other one. */
    ordinal: integer("ordinal").notNull(),
    /** critical|high|medium|low. Trivy's `UNKNOWN` is folded away upstream and never reaches a row,
     *  exactly as it never reaches a count. */
    severity: text("severity").notNull(),
    /** Every attribution column is NULLABLE for the same reason `ScanFindingSchema`'s fields are
     *  optional: an entry is retained whenever it would have been COUNTED, on `Severity` alone.
     *  Requiring identifiers would drop entries and move operators' numbers. */
    vulnerabilityId: text("vulnerability_id"),
    pkgName: text("pkg_name"),
    installedVersion: text("installed_version"),
    /** ABSENT means upstream shipped no fix — M22.3's "no fix available" class reads this absence as
     *  the signal rather than inferring it. */
    fixedVersion: text("fixed_version"),
    /** Trivy `Results[].Class` — the field that makes M22.4's vendor rule expressible without an
     *  inventory join (`os-pkgs` attributes to the base image line, `lang-pkgs` to a manifest
     *  dependency or to nothing). */
    class: text("class"),
    target: text("target"),
    /** `PkgIdentifier.PURL` VERBATIM. Canonicalisation belongs at the join, once, where both sides
     *  are visible — the dependency inventory stores its coordinate un-normalised too. */
    purl: text("purl"),
    /** ADR-0024 §D1 class, per row. 'E' excluded (accepted-risk evidence) | 'O' ordinary
     *  (telemetry). 'P' is refused by the CHECK: no finding is permanent evidence. Defaults to 'O'
     *  because nothing is excluded until M22.2 exists to exclude it. */
    retentionClass: text("retention_class").notNull().default("O"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    /** `orgId` LEADS, so this index IS the one hot lookup ("the findings of control run R") and no
     *  second index is needed. */
    primaryKey({
      name: "scan_findings_pk",
      columns: [table.orgId, table.controlRunId, table.ordinal]
    }),
    /** Barrier 2 (DESIGN §4.2): a row cannot reference another org's control run, even from a
     *  session that passes RLS for its own org. CASCADE so findings never outlive the verdict they
     *  explain. */
    foreignKey({
      name: "scan_findings_control_run_fk",
      columns: [table.orgId, table.controlRunId],
      foreignColumns: [controlRuns.orgId, controlRuns.id]
    }).onDelete("cascade"),
    check(
      "scan_findings_severity_check",
      sql`${table.severity} IN ('critical','high','medium','low')`
    ),
    check("scan_findings_retention_class_check", sql`${table.retentionClass} IN ('E','O')`)
  ]
);

// -------------------------------------------------------------------------------------------
// Pipeline hooks and their evidence (team-pipeline-iac increment 8, migration 0096).
// Contract: packages/schemas/src/pipeline-behaviors.ts. Verdicts: coordination/pipeline-hook-verdicts.ts.
// -------------------------------------------------------------------------------------------

/** The four DECLARED test hooks per component (D11/D21). See docs/db.md §145. */
/** Which stacks a config source actually delivers. See docs/db.md §146. */
export const configSourceStacks = pgTable(
  "config_source_stacks",
  {
    orgId: uuid("org_id").notNull(),
    /** The delivered `DesiredStateManifest.stackName` — the same bare string `plans` and
     *  `objects.managed_by_stack` key on. A second spelling here would be a second definition of
     *  what a stack is. */
    stackName: text("stack_name").notNull(),
    /** The `config-source` object that delivered it. Org-unbound `REFERENCES objects(id)`. */
    configSourceId: uuid("config_source_id").notNull(),
    /** The team the apply RAN AS — recorded, never re-derived from a document that may since have
     *  been edited (the provenance-is-read-not-inferred rule ADR-0046 §4 states for derived
     *  bindings). */
    teamObjectId: uuid("team_object_id").notNull(),
    lastCommitSha: text("last_commit_sha").notNull(),
    lastManifestPath: text("last_manifest_path").notNull(),
    firstDeliveredAt: timestamp("first_delivered_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastDeliveredAt: timestamp("last_delivered_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    pk: primaryKey({
      columns: [table.orgId, table.stackName],
      name: "config_source_stacks_pkey"
    }),
    bySource: index("config_source_stacks_by_source").on(table.orgId, table.configSourceId)
  })
);

/** The rollout strategy a component declares per target class. See docs/db.md §147. */
/** The config-source trigger's durable handoff. See docs/db.md §148. */
export const configSourceSyncQueue = pgTable(
  "config_source_sync_queue",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id").notNull(),
    configSourceId: uuid("config_source_id").notNull(),
    /** Carried verbatim from the delivery — the work item is about the repo that ACTUALLY moved,
     *  not whatever the registration says at drain time. */
    repo: text("repo").notNull(),
    commitSha: text("commit_sha").notNull(),
    /** `ExtractedHint.paths`. Empty is legitimate and means "read every manifest the registration
     *  selects" — the conservative direction. */
    paths: jsonb("paths").notNull().default([]),
    enqueuedAt: timestamp("enqueued_at", { withTimezone: true }).notNull().defaultNow(),
    /** Set even on a FAILED drain: the repo being ahead of the graph is a DISPLAYED state, never an
     *  infinite retry. */
    processedAt: timestamp("processed_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error")
  },
  (table) => [
    /** drizzle/0109 — ONE PENDING entry per (source, commit). This is what makes the table a QUEUE
     *  rather than a log: without it a webhook redelivery, or two ingests racing on the same push,
     *  enqueue the same commit twice and it is synced twice. `processed_at IS NULL` is in the
     *  PREDICATE rather than the key so a re-push of an already-processed commit still enqueues. */
    uniqueIndex("config_source_sync_queue_pending_identity")
      .on(table.orgId, table.configSourceId, table.commitSha)
      .where(sql`${table.processedAt} IS NULL`),
    /** drizzle/0109 — the drain's claim query: oldest pending first, per org. */
    index("config_source_sync_queue_pending")
      .on(table.orgId, table.enqueuedAt)
      .where(sql`${table.processedAt} IS NULL`)
  ]
);

export const componentRollouts = pgTable(
  "component_rollouts",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id").notNull(),
    componentObjectId: uuid("component_object_id").notNull(),
    targetClass: text("target_class").notNull(),
    /** `RolloutStrategySchema` — discriminated on `strategy` (D15(c)). */
    rollout: jsonb("rollout").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    unique("component_rollouts_identity").on(
      table.orgId,
      table.componentObjectId,
      table.targetClass
    )
  ]
);

export const componentConvergence = pgTable(
  "component_convergence",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id").notNull(),
    componentObjectId: uuid("component_object_id").notNull(),
    targetObjectId: uuid("target_object_id").notNull(),
    /** Stored explicitly INCLUDING `false` — D8 requires the manifest to say which. */
    converge: boolean("converge").notNull(),
    scope: text("scope").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    unique("component_convergence_identity").on(
      table.orgId,
      table.componentObjectId,
      table.targetObjectId
    )
  ]
);

export const pipelineHooks = pgTable(
  "pipeline_hooks",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id").notNull(),
    /** The component whose pipeline declares this hook — AND the ownership pointer (see above).
     *  Org-unbound `REFERENCES objects(id)`, the form `changes.object_id` already uses. */
    componentObjectId: uuid("component_object_id").notNull(),
    /** 'postMerge'|'postDeploy'|'continuous'|'bakeAlarms'. Plain text, no pg enum and no CHECK — the
     *  closed set lives ONCE, in `PipelineHookKindSchema`, exactly as for `sourceMappings.type`. */
    kind: text("kind").notNull(),
    /** Defaulted at synth to the construct kind (D16(6)), ALWAYS explicit on the wire. */
    hookId: text("hook_id").notNull(),
    /** `WorkflowRefSchema` — (repo, branch, path, templateName?). NULL on `bakeAlarms` only, which
     *  triggers nothing and so carries no workflow. */
    workflow: jsonb("workflow"),
    /** `postDeploy`/`bakeAlarms`. NULL = EVERY wave, the STRICT end of the range: adding a `stage`
     *  REMOVES gates. Operator vocabulary (D6) — SCP never enforces the value set. */
    stage: text("stage"),
    /** `continuous` only. DESCRIPTIVE — Argo runs the cron, SCP does not schedule it. */
    everySeconds: integer("every_seconds"),
    /** `continuous` only, REQUIRED there. Evidence older than this reads as ABSENT — not stale-pass
     *  and not fail (`evaluateContinuousHold`). */
    maxAgeSeconds: integer("max_age_seconds"),
    /** `bakeAlarms` only — `evaluateBakeGate`'s `quietWindowSeconds`. */
    quietWindowSeconds: integer("quiet_window_seconds"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    unique("pipeline_hooks_identity").on(
      table.orgId,
      table.componentObjectId,
      table.kind,
      table.hookId
    )
  ]
);

/** Schedules a deleted hook still owes its executor. See docs/db.md §149. */
export const continuousProbeRetractions = pgTable(
  "continuous_probe_retractions",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id").notNull(),
    /** Deliberately NOT `REFERENCES objects(id)` — the retraction must outlive the component, which
     *  the same apply may have deleted. */
    componentObjectId: uuid("component_object_id").notNull(),
    hookId: text("hook_id").notNull(),
    /** Frozen at delete time, never re-derived: the retraction must name the id that was actually
     *  declared, even if `probeScheduleId`'s derivation later changes. */
    scheduleId: text("schedule_id").notNull(),
    enqueuedAt: timestamp("enqueued_at", { withTimezone: true }).notNull().defaultNow(),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error")
  },
  (table) => [
    /** drizzle/0111 — one outstanding retraction per (component, hook); also the drain's per-org
     *  read path. Rows are DELETED on success, so this is a plain UNIQUE rather than a partial. */
    uniqueIndex("continuous_probe_retractions_identity").on(
      table.orgId,
      table.componentObjectId,
      table.hookId
    )
  ]
);

/** Concluded test runs and asserted alarm-state windows. See docs/db.md §150. */
export const pipelineEvidence = pgTable(
  "pipeline_evidence",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id").notNull(),
    componentObjectId: uuid("component_object_id").notNull(),
    /** The deployment target this evidence is ABOUT. Required even for `postMerge`, whose run is not
     *  target-specific, because the AUTHORIZATION is scoped at the target — "an evidence row nobody
     *  can attribute is an evidence row nobody can revoke". */
    targetObjectId: uuid("target_object_id").notNull(),
    hookId: text("hook_id").notNull(),
    kind: text("kind").notNull(),
    /** EXACTLY ONE binding is what the consuming hook requires: `postMerge` binds to the built
     *  COMMIT (it runs before any artifact exists), the other three to the artifact DIGEST. Both are
     *  permitted on the wire and the CONSUMER requires the one its hook needs — a mismatch is a
     *  refusal, never a widening. Unbound evidence is read as covering whatever deploys next. */
    artifactDigest: text("artifact_digest"),
    commitSha: text("commit_sha"),
    /** SERVER-STAMPED, never settable from a request body (see above). CHECKed in SQL rather than by
     *  Zod precisely BECAUSE it is not on the wire: no request schema stands over this column, so
     *  the constraint is the only guard. */
    source: text("source").notNull(),
    /** SERVER-STAMPED, never settable from a request body (see above). NULLABLE and deliberately
     *  un-FK'd: an `executor_observed` row has no human subject, and evidence must outlive a deleted
     *  subject — "who said the window was quiet" cannot be answered by a row that cascaded away. */
    producerSubjectId: uuid("producer_subject_id"),
    /** The parsed `PipelineEvidenceSchema` body, verbatim. The columns beside it are the ones that
     *  get QUERIED; everything else stays in the bag rather than being shredded into columns that
     *  would have to be kept in step with the Zod contract by hand. */
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    /** "The latest evidence for this (org, target, hook)" — `created_at DESC` is IN the index so the
     *  read stops at the first row instead of sorting every report ever filed against the target. */
    index("pipeline_evidence_latest").on(
      table.orgId,
      table.targetObjectId,
      table.hookId,
      table.createdAt.desc()
    ),
    /** Bake window-coverage lookups. `kind` earns its place: the overlap predicate is a range scan
     *  over jsonb window bounds, so keeping the far more numerous `testRun` rows out of the scan
     *  entirely is the point. */
    index("pipeline_evidence_bake_window").on(
      table.orgId,
      table.targetObjectId,
      table.hookId,
      table.kind
    ),
    /** Newest-wins supersession for test runs, ENFORCED. `coalesce(..., '')` because the binding is
     *  "digest OR commit" with the unused one NULL, and NULL never equals NULL in a unique index —
     *  without it this index would permit unlimited duplicates of exactly the rows it collapses.
     *  PARTIAL on `kind = 'testRun'`: alarm rows accumulate on purpose and must not be caught. */
    uniqueIndex("pipeline_evidence_test_run_identity")
      .on(
        table.orgId,
        table.componentObjectId,
        table.targetObjectId,
        table.hookId,
        sql`coalesce(${table.artifactDigest}, '')`,
        sql`coalesce(${table.commitSha}, '')`
      )
      .where(sql`${table.kind} = 'testRun'`),
    check(
      "pipeline_evidence_source_check",
      sql`${table.source} IN ('rollout_analysis','pushed','executor_observed')`
    )
  ]
);

/** IN-FLIGHT AND CONCLUDED HOOK RUNS. See docs/db.md §151. */
export const pipelineHookRuns = pgTable(
  "pipeline_hook_runs",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id").notNull(),
    /** The component whose hook this run belongs to — AND the ownership pointer. NO `managedByStack`
     *  column and none is ever added; ownership derives from the owning object, exactly as for
     *  `pipelineHooks` / `sourceMappings` / `executorBindings` (packages/schemas/src/coordination-as-code.ts). */
    componentObjectId: uuid("component_object_id").notNull(),
    /** NULLABLE, and load-bearing: `postMerge` runs before any artifact exists and is not
     *  target-specific, so there is no target to name. See the constraint note above for what that
     *  NULL does to a plain UNIQUE. */
    targetObjectId: uuid("target_object_id"),
    /** The Change this run gates. Part of the identity — a run for change A says nothing about
     *  change B, even at the same wave index. */
    changeObjectId: uuid("change_object_id").notNull(),
    hookId: text("hook_id").notNull(),
    kind: text("kind").notNull(),
    waveIndex: integer("wave_index"),
    /** The binding this run's eventual evidence carries: `postMerge` -> commit, the other three ->
     *  digest. Both nullable here; `PipelineEvidenceSubjectSchema`'s exactly-one refine is enforced
     *  at the evidence write, where a mismatch must be a refusal rather than a widening. */
    artifactDigest: text("artifact_digest"),
    commitSha: text("commit_sha"),
    /** NULLABLE, AND THAT IS THE WHOLE DESIGN. See docs/db.md §152. */
    externalRunId: text("external_run_id"),
    externalUrl: text("external_url"),
    /** Mirrors `ExecutionPhase` from `@scp/plugin-api` member for member. CHECKed in SQL — unlike
     *  `kind` — because no Zod schema stands over this column: `ExecutionPhase` is a TS union in a
     *  package deliberately free of a `@scp/schemas` dependency, so there is no parse door and the
     *  constraint is the only guard. Same reasoning as `pipelineEvidence.source`. */
    status: text("status").notNull(),
    /** The instance the trigger used. Persisted, not re-resolved at poll time, for the reason
     *  `changeWaveTargets.executorPluginId` is: a poll against a different instance polls a
     *  different pipeline for this run's ref. */
    pluginInstanceId: text("plugin_instance_id").notNull(),
    /** Trigger-call retry count, so a refusing executor backs off instead of re-firing every tick. */
    attempt: integer("attempt").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    /** NULL until the first `status()` poll — an un-polled run and a polled-and-still-pending run
     *  are different operator situations. */
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true }),
    /** The D23 pin: `CapturedWorkflowRef`. See docs/db.md §153. */
    capturedWorkflow: jsonb("captured_workflow"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    unique("pipeline_hook_runs_identity")
      .on(table.orgId, table.changeObjectId, table.hookId, table.waveIndex)
      .nullsNotDistinct(),
    /** The poll driver's only scan. PARTIAL on the non-terminal statuses so it stays proportional to
     *  work outstanding rather than to every run ever dispatched. */
    index("pipeline_hook_runs_non_terminal")
      .on(table.orgId, table.startedAt)
      .where(sql`${table.status} IN ('pending','running')`),
    index("pipeline_hook_runs_by_change").on(table.orgId, table.changeObjectId, table.hookId),
    check(
      "pipeline_hook_runs_status_check",
      sql`${table.status} IN ('pending','running','succeeded','failed','aborted')`
    )
  ]
);

/** drizzle/0104 — instance-tier operator credentials. See docs/db.md §154. */
export const instanceOperatorCredentials = pgTable(
  "instance_operator_credentials",
  {
    id: uuid("id").primaryKey(),
    name: text("name").notNull(),
    /** CLEARTEXT lookup key — argon2 output is salted and non-comparable, so a presented credential
     *  cannot be found by hashing it and matching a row. UNIQUE (drizzle/0104, declared below):
     *  `verifyOperatorCredential` resolves a presented credential with a single `findFirst` on this
     *  column, which only names the right row if no second row can share the value. */
    tokenId: text("token_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    /** The minter's graph object. NULL = minted with the bootstrap env token. Deliberately not an FK:
     *  an instance-tier row must not couple to an org-scoped one. */
    createdByUserId: uuid("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true })
  },
  (table) => [
    /** drizzle/0104 — what makes the `token_id` lookup in `verifyOperatorCredential` resolve one
     *  row. A `uniqueIndex` rather than `.unique()` sugar because 0104 creates an INDEX named
     *  `..._key`, which the sugar's default `..._unique` constraint name would not match. */
    uniqueIndex("instance_operator_credentials_token_id_key").on(table.tokenId)
  ]
);
