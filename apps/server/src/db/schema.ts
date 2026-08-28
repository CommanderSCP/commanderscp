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

/**
 * Personal Access Tokens (M2 step 2, BUILD_AND_TEST.md §8 M2 item 3) — auth substrate like
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
 * SCP's own RFC 8628-shaped device-authorization flow (M2 step 2 Part C) — hosted by SCP itself,
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
    // CONTAINMENT sense (ADR-0021 D4) — the containment parent (ANY object; a `domain` in the
    // common case); NULL only for the org root object. There is deliberately NO FK and NO CHECK
    // here (0001_graph_core.sql:32) and `resolveContainmentParent` applies no type filter, so a
    // service id or a component id is valid and is what several shipped tests pass. The brand
    // asserts the SENSE, never the TYPE. Deliberately branded differently from `originDomainId`
    // nine lines below, which is the TRUST sense: the two are structurally identical uuids and were
    // freely interchangeable before branding.
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
    // M20.1 (ADR-0031 §1) — TRUE = this object's existence stays inside its own security domain:
    // `federation/scope-filter.ts` matches its journal entries against NO peer scope, in either
    // direction. Operator-DECLARED at create under `federation:write`, never inferred from a repo
    // name, a target label or a branch string (the ADR-0030 §2 lesson).
    //
    // IMMUTABLE BY CONSTRUCTION, not by a guard: of the five statements that write this table, only
    // `createObject`'s INSERT names this column. Shared -> domain-local is refused forever
    // (federation has no un-send); domain-local -> shared is the one-way M20.4 publication verb.
    //
    // VISIBILITY ONLY (ADR-0031 §7). It is never an enforcement input: it grants no scan exemption,
    // relaxes no gate, and is read by no governance path. The exemption domain-local content enjoys
    // comes from the PATH (no peer => `exportPromotionBundle` unreachable => E6 never applies), and
    // an inertness test pins that this bit and that gate stay unaware of each other.
    domainLocal: boolean("domain_local").notNull().default(false),
    // M20.7 (ADR-0031 §6c) — WHY this object is domain-local. The container it INHERITED locality
    // from at create (M20.5/§6a), or NULL when an operator DECLARED it, or when it is not
    // domain-local at all. Those three states are exhaustive and need no discriminator column.
    //
    // HISTORICAL, deliberately: it records the container as it was at create and is never updated to
    // follow it, so after §6b's publish-container-then-child flow a still-local child legitimately
    // points at a container that has since become shared. That is the true answer to "how did this
    // become domain-local", not staleness. Re-deriving it live would need the containment walk §6a
    // exists to avoid.
    //
    // No FK: losing the provenance because its source was tombstoned would be worse than a dangling
    // id, which readers render as "inherited, source no longer present".
    // The URN is denormalized alongside the id because `objects.urn` is IMMUTABLE (`updateObject`
    // writes `urn: existing.urn`), so it cannot drift — and it is accepted anywhere an id is, which
    // means a badge can render "inherited from secure-partition" and link to it with NO lookup.
    // `name` is deliberately absent: it IS mutable, and the urn's last segment is the name as at
    // create, which for historical provenance is the more honest label.
    domainLocalInheritedFrom: uuid("domain_local_inherited_from"),
    domainLocalInheritedFromUrn: text("domain_local_inherited_from_urn"),
    // drizzle/0068 — the `@scp/iac` stack whose apply owns this row, or NULL. This is what scopes
    // PRUNING: an apply deletes exactly the live rows carrying its own stack name that its manifest
    // no longer declares (`iac/plan-diff.ts`'s `isStackManaged`).
    //
    // SERVER-WRITTEN ONLY, and that is the whole point of it being a column. It lived in `labels`
    // until 0068, where the prune TARGET could rewrite it under plain `object:write` — enrolling an
    // arbitrary object into a stack's delete pool, or walking its own object out of one. The sole
    // writer is `iac/stack-ownership.ts`, called from the IaC apply path; no request body can reach
    // it and no route passes it, exactly as for `origin_domain_id`, `provenance` and `domain_local`.
    //
    // DOES NOT FEDERATE, deliberately: it is absent from the journal payload, so a replica arrives
    // owned by nobody. That is the truth — the importing domain's IaC does not manage a row another
    // domain authored — and it is a bonus over the label scheme, under which a peer's `scp:stack=X`
    // did land here (labels ARE in the payload) and would join a local stack X's prune pool. That
    // consequence is READ FROM THE CODE, not reproduced against two live domains; see
    // `iac/stack-ownership.ts` for the chain and the caveat.
    managedByStack: text("managed_by_stack"),
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
    index("obj_labels").using("gin", sql`${table.labels} jsonb_path_ops`),
    // drizzle/0068 — the prune-pool lookup. Partial: almost nothing on an estate is IaC-managed,
    // and the query never asks for the rows that are not.
    index("obj_managed_stack")
      .on(table.orgId, table.managedByStack)
      .where(sql`${table.managedByStack} IS NOT NULL AND ${table.deletedAt} IS NULL`)
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
    // M2 step 3 addition (BUILD_AND_TEST.md §8 M2 item 4, drizzle/0005_plans.sql) — mirrors
    // `objects.labels`. An IaC apply writes `scp:managed-by`/`scp:stack` here, but SINCE
    // drizzle/0068 THOSE ARE A DESCRIPTIVE MIRROR THAT SCOPES NOTHING: pruning reads
    // `managed_by_stack` below. This map is writable by the endpoints' owners, which is exactly
    // what made the previous "pruning convention" a delete decision its own subject could rewrite.
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
    // drizzle/0068 — see `obj_managed_stack`.
    index("rel_managed_stack")
      .on(table.orgId, table.managedByStack)
      .where(sql`${table.managedByStack} IS NOT NULL AND ${table.deletedAt} IS NULL`)
  ]
);

// -------------------------------------------------------------------------------------------
// RBAC (DESIGN.md §7)
// -------------------------------------------------------------------------------------------

export const roles = pgTable(
  "roles",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id"), // NULL = built-in (Viewer|Operator|Approver|Administrator|Owner)
    name: text("name").notNull(),
    permissions: text("permissions").array().notNull(),
    /**
     * drizzle/0097 — object type ids this role may be bound at. NULL = ANY scope, which is what
     * the five built-in ladder rows carry and must keep carrying (their live bindings predate the
     * column).
     *
     * **ENFORCED SINCE role-model.md §5 step 5** — `authz/role-binding-door.ts`'s
     * `assertRoleBindableAtScope`, called by `POST /api/v1/role-bindings`. GRANT ONLY: a revoke
     * deliberately does not re-check it, or every binding already written at a nonsensical scope
     * would become permanent, and cleaning those up is half the reason the column exists.
     *
     * THE DATABASE STILL ENFORCES NOTHING and that is unchanged: `scope_object_id` is a bare
     * `uuid NOT NULL REFERENCES objects(id)` with no type constraint, so a row written by hand SQL
     * or restored from a dump can still point at a `user` or a `change`. Such a binding is inert —
     * until `objects.domain_id`, which carries no type constraint either, parents something under
     * it and it suddenly confers authority (role-model.md §1.3h). The door is the only layer that
     * sees this, which is why the check is at the door and not here.
     */
    bindableAt: text("bindable_at").array()
  },
  (table) => [
    /**
     * drizzle/0097 — PARTIAL, so an org's own custom roles may reuse a built-in name; the
     * collision that matters is between the SHARED SINGLETON rows every org reads through the
     * `roles` RLS `USING (... OR org_id IS NULL)` clause. Without it, 0002's seed
     * `INSERT ... ON CONFLICT DO NOTHING` has no arbiter index and can never fire, so re-running
     * that seed forks "Owner" into two rows that `findFirst` picks between arbitrarily.
     */
    uniqueIndex("roles_builtin_name_key")
      .on(table.name)
      .where(sql`${table.orgId} IS NULL`)
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
    effect: text("effect").notNull().default("allow"), // 'allow' | 'deny' (deny overrides)
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("role_bindings_subject").on(table.orgId, table.subjectId),
    index("role_bindings_scope").on(table.orgId, table.scopeObjectId),
    /**
     * drizzle/0097 — the NATURAL KEY of a grant. Without it a write door creates duplicate
     * grants that are individually revocable and COLLECTIVELY still granting: revoke one, the
     * other still grants, and the revoke reports success. That is why this lands BEFORE the
     * role-binding API, not with it.
     */
    unique("role_bindings_grant_key").on(
      table.orgId,
      table.subjectId,
      table.roleId,
      table.scopeObjectId,
      table.effect
    ),
    /**
     * drizzle/0097 — `hasPermission`/`hasRoleAtScope` classify with exact string equality
     * (`effects.includes("deny")`, then `includes("allow")` — authz/resolve.ts:285-286,
     * :353-354). So 'ALLOW' or '' grants nothing AND denies nothing: a silently inert row that
     * reads as authority. Deleting this CHECK re-opens that; the database is the only layer that
     * sees every writer.
     */
    check("role_bindings_effect_check", sql`${table.effect} IN ('allow', 'deny')`)
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
// table for hot lifecycle state" (DESIGN.md §4.1): unlike M2 step 1's typed registries (which
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
    // The raw delivery payload kept verbatim, plus CANONICAL keys lifted from it by
    // `coordination/webhook-processor.ts`'s `canonicalizeSourceRef`:
    //   {repo, ref, commit, run_url, workspace,
    //    artifact_digest,                       // the artifact this release promotes (M15.3c/M17.1,
    //                                           //   ADR-0013 — what the scan gate binds to)
    //    sbom: {format, specVersion?, digest, location, mediaType?, signatureRef?, scanner?,
    //           scannerVersion?, generatedAt?}, // M17.2, ADR-0015 §5 — a REFERENCE to the
    //                                           //   EXECUTOR's build-time, cosign-signed-at-origin
    //                                           //   SBOM. SCP never generates, signs, or stores the
    //                                           //   document bytes; only this reference. Typed as
    //                                           //   `SbomRefSchema` (@scp/schemas supply-chain.ts).
    //    ...}
    // jsonb ⇒ every one of these is zero-migration.
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
    /**
     * THE RECONCILE ROUND-ROBIN CURSOR (migration 0056) — engine scheduling state, and the ONLY
     * column `listChangeRowsInStates` orders by. "When did the engine last take this change's turn",
     * which is a queue position and NOT a fact about the change.
     *
     * It exists because `updated_at` used to carry both meanings at once. The engine serves
     * `ORDER BY <cursor> ASC LIMIT BATCH_LIMIT`, and five reconcile paths re-stamp a change they
     * examined but could NOT advance so it goes to the back of the queue — without that,
     * >BATCH_LIMIT stuck changes own every batch slot forever and everything behind them is never
     * evaluated even once (measured: 13 days of stopped production coordination behind green health
     * checks, homelab 2026-08-01 — see reconcile.ts's gate-blocked bump). Sharing `updated_at` for
     * that made the API-visible `Change.updatedAt` read "1s ago" for a change that had done nothing
     * for three days.
     *
     * THE SPLIT IS STARVATION-SAFE BY DIRECTION, which is the property to check when touching this.
     * The guarantee needs the not-advanced paths to push a change BACKWARD in the queue; every other
     * write that used to move `updated_at` incidentally (a transition, a `source_ref` stamp, a park)
     * now leaves the cursor alone, which can only make a change be served SOONER. Nothing that could
     * delay a change was removed.
     *
     * DELIBERATELY UN-INDEXED. `changes_org_state` already narrows the candidate set to one org and
     * state; adding a btree on this column would defeat HOT updates for the per-tick bump — index
     * churn on exactly the write that fires most often (ADR-0024's cost lesson, one write class
     * over). `updated_at`, which this replaces in the ORDER BY, was never indexed either.
     *
     * NOT ON THE WIRE, like `reconcile_blocked_at` beside it. See `Change`'s `updatedAt` docblock
     * in `@scp/schemas` for the reasoning.
     */
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
    index("decisions_org_created").on(table.orgId, table.createdAt, table.id),
    // The RECONCILE HOT PATH's exact shape (`decisions-repo.ts`'s `latestDecisionForSubjectKind`:
    // org + subject + kind, newest first, LIMIT 1). Neither index above covers `kind`, so it is a
    // HEAP FILTER and the scan walks every one of the subject's other-kind rows above the newest
    // match — measured at 12M rows: 22.8 s / 402,430 buffers for a probe that returns NO row, 0.3 ms
    // with this index (drizzle/0044 carries the full before/after EXPLAIN and the write cost).
    // With `kind` in the key, every probe is one index descent whatever else the subject holds.
    // `id DESC` CLOSES THE KEY, and it is load-bearing for a reason that is NOT about the answer —
    // see the identical note on the block index below, and drizzle/0069 for the measurements.
    index("decisions_org_subject_kind_created").on(
      table.orgId,
      table.subjectId,
      table.kind,
      table.createdAt.desc(),
      table.id.desc()
    ),
    // The SERVICE BOARD's shape (`decisions-repo.ts`'s `latestBlockDecisionForSubject`, once per
    // board row): org + subject + the latest `block`. PARTIAL, because `block` is the only verdict
    // that query is ever issued with — so `verdict` becomes the index PREDICATE rather than a heap
    // filter, and a change that NEVER blocked (the common case) is answered by an index descent that
    // finds nothing instead of a walk over its whole history. Measured at 12M rows: 45.8 ms /
    // 20,526 buffers fully cached to return NO row, 0.070 ms / 13 buffers with this index
    // (drizzle/0046 carries the full before/after EXPLAIN and the write cost).
    //
    // `id DESC` CLOSES THE KEY, AND IT IS THE DIFFERENCE BETWEEN THIS INDEX BEING USED AND NOT
    // BEING USED. The read ends `ORDER BY created_at DESC, id DESC`; an index that stops at
    // `created_at DESC` supplies only a PREFIX of that order, so every plan using it carries an
    // `Incremental Sort` above it — and a sort node's STARTUP cost is exactly what `LIMIT 1`
    // cannot amortise. `decisions_org_created` below supplies the whole order sortlessly, so the
    // planner prices it at `1/estimated_matches` of its length and prefers it the moment
    // statistics make a match look near, then applies `subject_id`/`verdict` as a heap FILTER and
    // walks the ORG's entire stream. This comment previously argued the opposite — that a `LIMIT 1`
    // query needs no tiebreak in its index because a tiebreak "cannot change the answer". It cannot;
    // that was never its job here. drizzle/0069 carries the before/after plans and the CI failure
    // (`expected 804 to be less than or equal to 10`) that this cost.
    index("decisions_org_subject_block_created")
      .on(table.orgId, table.subjectId, table.createdAt.desc(), table.id.desc())
      .where(sql`${table.verdict} = 'block'`),
    // `GET /decisions?kind=…` WITHOUT a subject (ADR-0028 increment 4) — the operator who knows the
    // coupling but not the change id. Every index above leads with `subject_id` or omits `kind`, so
    // that filter was a PARALLEL SEQ SCAN of the whole table, sorted: measured at 4M rows,
    // 100.0 ms / 55,650 buffers and every row scanned to return 101, versus 0.098 ms / 8 buffers
    // with this index (drizzle/0056 carries the full before/after EXPLAIN and the write cost).
    // `created_at, id` closes the key because that is the keyset cursor's ordering verbatim, so a
    // page costs one descent and no sort. That is the same reason the two indexes above now close
    // theirs (drizzle/0069): "no sort node" is a property every one of these ordered reads needs,
    // `LIMIT 1` included — this index is also the RIVAL that won whenever they lacked it.
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
    sourceKind: text("source_kind").notNull(), // github|argocd|terraform|manual|...
    repoPattern: text("repo_pattern"), // glob, matched against source_ref.repo
    pathPattern: text("path_pattern"), // glob, matched against source_ref.path (optional)
    // Glob matched against the event's git REF (`refs/heads/dev`), migration 0057 / ADR-0030 §1.
    // The third routing glob and a PEER of the two above, not a rank above them: paths and refs are
    // orthogonal, and the same directory on two branches is two pipelines — which no path glob can
    // express. NULL matches EVERY ref (the matcher skips a null one, exactly as it already does for
    // the other two), so every mapping written before 0057 keeps its behaviour unchanged.
    refPattern: text("ref_pattern"),
    componentObjectId: uuid("component_object_id").notNull(),
    // WHICH pipeline of that component this source drives — the routing Type (ADR-0007, migration
    // 0026; was `purpose` in 0024). A change IS a release and comes from ONE source per pipeline, so
    // the mapping is where the release declares its Type — deliberately NOT inferred from source_kind,
    // because `github` can run Terraform OR deploy an app. Defaults to 'configuration'. Plain text
    // (no pg enum / CHECK): the closed value set is enforced in packages/schemas (Zod).
    type: text("type").notNull().default("configuration"),
    // The operator's DECLARED classification of this pipeline (`dev`|`beta`), migration 0057 /
    // ADR-0030 §2. UI and reporting read THIS; nothing parses the branch name looking for "dev".
    // A label named after WHICH BRANCH MATCHED goes false the moment that branch covers a second
    // kind — a failure already shipped once here (charter principle 6).
    //
    // NEVER an enforcement input (ADR-0030 §3): it is not threaded into the export gate, and forging
    // or removing it changes no gate outcome. Enforcement keys on the path — a change targeting no
    // federation peer never reaches `exportPromotionBundle`. Plain text (no pg enum / CHECK), like
    // `type` above: the closed value set is enforced in packages/schemas (Zod).
    classification: text("classification"),
    // The operator's DECLARED provenance of this mapping's repo, migration 0062 / outpost-ui.md
    // §9.3a (owner, 2026-08-14). A component spans domains and its ONE pipeline has inputs of two
    // provenances: globally SHARED repos authored at the commander, and DOMAIN-SPECIFIC repos
    // tracked only by this domain's outpost. Where a domain holds a COPY of a shared repo (the
    // owner's row 2 — "IaC shared source → IaC repo, domain-B copy → component (domain B)"), that
    // mapping is physically local but its provenance is the commander. `true` declares exactly
    // that: "this repo mirrors a commander-shared source". NULL/false = domain-specific (the
    // owner's row 3), which is also every pre-0062 row's meaning unchanged.
    //
    // DECLARED, never inferred — same discipline as `classification` above and for the same
    // charter-6 reason: guessing "shared" from the repo host or a name pattern would label a
    // domain's classified network repo as shared the moment it lived on the same Gitea. And
    // NEVER an enforcement input: it grants and withholds nothing; the UI groups the source lane
    // by it and reporting may read it, and that is all.
    mirrorOfShared: boolean("mirror_of_shared").notNull().default(false),
    // The operator's PAUSE SWITCH, migration 0063 (owner ask 2026-08-14, UI source-lane
    // enable/disable). A mapping stays DECLARED but routes nothing while disabled — distinct from
    // delete, which forgets the rule entirely. `correlation.ts`'s `matchComponentForSource` skips a
    // disabled row as its first filter, so this is an ENFORCEMENT input (unlike `classification`
    // and `mirrorOfShared` above): a caller flipping it changes what a push actually correlates to,
    // not just how it renders. `NOT NULL DEFAULT true` — every pre-0063 row was already routing, so
    // the default preserves that behaviour with no backfill.
    enabled: boolean("enabled").notNull().default(true),
    // TIMED CLOSE (owner, 2026-08-14: "disable for x period of time or until manually enabled
    // again"), migration 0064. Read together with `enabled`, exactly the way a freeze window is
    // read (governance/freezes-repo.ts): NO timer job re-opens anything — the correlation matcher
    // evaluates `now()` at every push. Three states: enabled=true → open (this column ignored);
    // enabled=false, disabled_until NULL → closed until an operator re-opens; enabled=false,
    // disabled_until = T → closed while now() < T, then OPEN again automatically, on time, with
    // zero moving parts. `enabled` stays the operator's declared intent; this column bounds it.
    disabledUntil: timestamp("disabled_until", { withTimezone: true }),
    // The operator's DECLARED reach of this mapping's repo, migration 0066 /
    // pipeline-substrate-registry-scan.md §10.6 (owner, 2026-08-16): `global` = a cross-domain
    // shared repo authored and tracked at the commander; `domain` = tracked only in one domain.
    // NULL = NOT DECLARED → the pipeline renders NO label and NOTHING is inferred (not from the
    // site's federation role, not from the repo host, not from a name pattern) — a pre-0066 row on
    // the commander is not thereby global. Orthogonal to `mirrorOfShared` above (a `domain`-scope
    // mapping may mirror a global one; the mirror wins the eyebrow). Like `classification` and
    // `mirrorOfShared`, NEVER an enforcement input: `correlation.ts` does not read it (pinned by
    // source-mapping-scope.integration.test.ts). Plain text with a CHECK on the two values — the
    // value set is closed at both ends because a third value would render as no label, silently.
    scope: text("scope"),
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
    /**
     * ADR-0028 (migration 0054): the authenticated principal that reported this event. The
     * processor runs as SYSTEM_ACTOR_ID — right for the CHANGE, since nobody asked for it — but a
     * declared `stageDependencies` on the same body MINTS a `depends_on` edge, and an edge write
     * attributed to the system actor leaves "who declared this?" unanswerable in the audit chain,
     * the federation journal and the emitted event. NULL for observe()-driven rows (no principal
     * exists) and for rows written before 0054; the processor falls back to the system actor.
     */
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
 * Latest object health (observe-enrichment signal 4; ADR-0008 decision 4) — an object-referencing
 * PROJECTION table keyed by `objects(id)` (DESIGN §4.1's "thin projection tables that reference
 * their graph object" pattern, same class as `changes.objectId`, `freezes.scopeObjectId` and
 * `executorObserveCursors`), NOT a new top-level concept table (charter principle 2). It projects
 * the hot latest-health state of an EXISTING graph object; it does not introduce a new first-class
 * concept, registry, or relationship.
 *
 * INVARIANT (coordinate-not-execute, principle 1): SCP never probes/polls/computes health. This row
 * is written ONLY by a PUSH-IN (owner PUT today; a future opt-in health-source binding writes the
 * SAME row via `source`). One latest row per (org, object), UPSERT-IN-PLACE (no delete route),
 * mirroring `executorObserveCursors`. Per-observation history is a deferred non-goal (ADR-0008).
 */
export const objectHealth = pgTable(
  "object_health",
  {
    orgId: uuid("org_id").notNull(),
    objectId: uuid("object_id").notNull(), // references objects(id) — FK added in migration
    status: text("status").notNull(), // healthy|degraded|down|unknown
    detail: text("detail"),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    /** Provenance of the push (`owner` today; a binding descriptor like `prometheus:<query>` later). */
    source: text("source"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [primaryKey({ columns: [table.orgId, table.objectId] })]
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
    // WHICH pipeline of the target this wave rolls — the routing Type (ADR-0007, migration 0026; was
    // `purpose` in 0024) — what reconcile resolves the executor binding by, now that a target can hold
    // one binding per Type (P3). Flows in from the source mapping that matched the release. Defaults
    // to 'configuration'. Plain text (no pg enum / CHECK); the closed value set is enforced in Zod.
    type: text("type").notNull().default("configuration"),
    executorPluginId: text("executor_plugin_id"),
    executorRef: jsonb("executor_ref"), // ExternalRunRef once triggered
    /** Captured before trigger — what a rollback of this wave target would restore (DESIGN §9.4). */
    priorStateRef: jsonb("prior_state_ref"),
    // Last status() stateRef reconcile observed — the synced revision it previously computed and
    // discarded (ADR-0008 decision 1; docs/proposals/observe-enrichment.md signal 1). Additive/
    // nullable, null until the first successful observe; a status() with no stateRef never nulls a
    // previously-captured value (updateWaveTargetObserved writes it only when defined).
    //
    // NOT AS-IS — the claim this comment made until M23.1g, and M23.1f made it false. Everything in
    // this column is plugin-supplied and passes `boundPluginJson` on the way in: a string may be
    // shortened, a list may lose its tail, U+0000 and lone surrogates become U+FFFD. What was
    // removed is written into the SAME jsonb under `truncation`, per field, so a reader is never
    // left to infer a cut from a suspiciously short value — and so `no rollout` and `we cut the
    // rollout` stop being the same bytes (`ChangeWaveTargetSchema.observed.truncation`).
    // `observedAt` is stamped here too and is deliberately NOT on the API.
    observedState: jsonb("observed_state"),
    // pending|triggering|triggered|observing|succeeded|failed|aborted|no_executor
    // `no_executor` (docs/adr/0006): fail-closed terminal — the target has real executor bindings
    // but NONE for the Type this wave rolls, so reconcile refused to fake-succeed the gap. Plain
    // text column (no Postgres ENUM / CHECK), so the value is additive with no migration; the read
    // schema (ChangeWaveTargetSchema.status) is already `z.string()`, so the API is additive too.
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
//
// ===========================================================================================
// THAT LAST CLAUSE WAS NARROWED BY OWNER DECISION D6 (M25.7, ADR-0043) — READ BOTH HALVES
// ===========================================================================================
// It used to be flat: a freeze was not a graph object and never could be, and this line is the
// PRIMARY SOURCE the rest of the codebase cited for that — `drizzle/0089` and
// `governance/freeze-object.ts` both quote it by line number. Left as it stood it would keep
// asserting, from the file the citations point at, exactly what the citations say was retracted.
//
// THE DISTINCTION THAT SURVIVES, and it is a real one rather than a hedge:
//
//   * A freeze's ENFORCEMENT STATE still has no place in the generic object model. The window
//     predicate `starts_at <= at < ends_at AND lifted_at IS NULL` is evaluated on a hot gate path
//     by `activeFreezesInWindow` — the single owner of that comparison — and re-expressing it as
//     jsonb comparisons would put a second copy of it in the system. That is why `freezes` (below)
//     STAYS, unchanged, and why every reader that BLOCKS still reads it.
//   * A freeze's WIRE FORM is now a `freeze` graph object (drizzle/0089), for one reason: nothing
//     table-shaped can cross a security boundary. `JournalEntryKindSchema` admits nine kinds and
//     none is freeze-shaped, and widening it is both an oasdiff response break and a fail-closed
//     cliff at an un-upgraded peer — so an object on the existing `object_upsert` is the only
//     route a freeze has. `federation/import-repo.ts` rebuilds the projection row from it at the
//     receiving instance, which is what makes an imported freeze actually block.
//
// So: object PLUS projection (the pattern `changes` and `campaigns` already use), opt-in per
// freeze (`freezes.object_id IS NULL` is the default and the whole pre-M25.7 estate), and org tier
// only — `instance_freezes` (drizzle/0086) has no `org_id` and does not federate under any
// decision (ADR-0040). Control run evidence and approval quorum are untouched by D6: both clauses
// above still hold for them flatly.
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
    /** The `control_bindings.plugin_module` that PRODUCED this run, stamped at insert (0063).
     *  Deliberately not read from the binding at query time: a binding is mutable, so re-pointing
     *  one control at `github-check` would retroactively relabel every historical run of it as "the
     *  component's own checks passed" — which is the label `dependencies/bump-actuator.ts` grants an
     *  unattended merge on. NULL on pre-0063 rows and on rows no bound plugin produced. */
    pluginModule: text("plugin_module"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("control_runs_org_change").on(table.orgId, table.changeObjectId, table.createdAt),
    index("control_runs_org_control").on(table.orgId, table.controlObjectId),
    // 0065 — the composite-FK target for `scan_findings`. `id` is already the primary key, so this
    // adds no new uniqueness; it exists so a `(org_id, control_run_id)` foreign key has something to
    // reference, which is what makes "a finding cannot point at another org's scan" a STRUCTURAL
    // barrier rather than a repo-layer habit (0061 could not do this for its `objects(id)`
    // references and says so).
    unique("control_runs_org_id_key").on(table.orgId, table.id)
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
 * (org/domain/service/component)." A dedicated projection table because a freeze's whole
 * enforcement state is a time window + scope + reason, queried on a hot gate path, and `/freezes`
 * is its own top-level API resource per DESIGN §6.
 *
 * M25.7 / OWNER DECISION D6 (ADR-0043) — "NOT A GRAPH OBJECT" IS NO LONGER TRUE, AND THAT SENTENCE
 * USED TO BE HERE. A freeze that opts into federation (`object_id` non-null) ALSO gets a `freeze`
 * graph object, because the sync journal has nine entry kinds, none freeze-shaped, and widening
 * that enum is both an oasdiff response break and a fail-closed cliff at an older peer — so the
 * object is the only way a freeze can cross a boundary. This table STAYS: the object is the wire
 * form, this row is the enforcement form every reader already composes over
 * (`activeFreezesInWindow` and everything above it). Object-plus-projection, the pattern `changes`
 * and `campaigns` already use.
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** M25.2 / owner decision D5 (drizzle/0084) — WHETHER THIS FREEZE STILL PARKS A WHOLE WAVE.
     *  `false` (the default, and retroactively true of every freeze authored before M25.2): the
     *  covered wave targets are held one by one in `coordination/reconcile.ts`'s trigger loop and
     *  their uncovered siblings ship. `true`: any coverage parks every target of the wave — the
     *  pre-M25.2 behaviour, for coupled targets where half-applied is worse than not-applied.
     *  Read in exactly one place: `gate-orchestrator.ts`'s `partiallyFrozen` predicate. */
    atomic: boolean("atomic").notNull().default(false),
    /** M25.1 (drizzle/0085) — THIS FREEZE WAS RETRACTED, and is no longer in force regardless of
     *  `endsAt`. A SOFT lift, following `personal_access_tokens.revoked_at`: the row stays readable
     *  by id forever, because two Decision writers put `freeze.id` in their `inputContext` and a
     *  hard DELETE would dangle every one of them (charter principle 6 — a blocked response stays
     *  reconstructible).
     *
     *  FILTERED IN EXACTLY ONE PLACE: `governance/freezes-repo.ts`'s `activeFreezesInWindow`, the
     *  single function that knows the window predicate. Every "is this freeze in force" consumer
     *  composes over it, so one `IS NULL` retires a freeze on every path at once; a second liveness
     *  filter elsewhere is the drift hazard that once made a service-scoped freeze fail OPEN.
     *  `listFreezes`/`getFreeze` deliberately do NOT filter — lifted is a FIELD, not an absence. */
    liftedAt: timestamp("lifted_at", { withTimezone: true }),
    /** Who lifted it. No FK, matching `createdByActorId`: an actor is a graph object that can be
     *  tombstoned and the lift record must outlive them. */
    liftedByActorId: uuid("lifted_by_actor_id"),
    /** Why. MANDATORY (non-empty) at the route whenever `liftedAt` is set — lifting a freeze is a
     *  governance LOOSENING affecting everyone at once, and `freeze:override` already refuses to
     *  bypass a freeze for ONE change without a reason. */
    liftReason: text("lift_reason"),
    /** M25.7 / owner decision D6 (drizzle/0089, ADR-0043) — THE ID OF THIS FREEZE'S `freeze` GRAPH
     *  OBJECT, or NULL when this freeze does not federate.
     *
     *  NULL IS THE DEFAULT AND THE STATUS QUO. Every freeze authored before M25.7 has it, and a
     *  `POST /api/v1/freezes` that omits `federate` still produces one — byte-identical behaviour
     *  on every path. D6 adds a new REACH, and a new reach never defaults on.
     *
     *  Non-null means two things at once, and they are the two halves of the feature: the object
     *  rides `object_upsert` to a peer (there is no freeze journal kind and there cannot be one —
     *  see drizzle/0089's header), and THIS ROW BECOMES REPLICA-AWARE. `freezes-repo.ts`'s
     *  `lockFreezeRow` — the read half of both write verbs — refuses a lift or a window edit when
     *  the named object is authoritatively owned by another domain, so an outpost cannot lift a
     *  commander freeze; its remedy is `freeze:override` at the replica's own scope.
     *
     *  No FK, matching `scope_object_id` and both `*_actor_id` columns. */
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

/**
 * M17.3 E4 (drizzle/0030_instance_cosign_keys.sql): each org's cosign MANIFEST-SIGNING keypair.
 * Distinct from `instanceKeys` above (which holds the org's Ed25519 attestation/federation
 * identity key): this holds the cosign keypair each org's commander signs its own promotion
 * manifests with (E6) and whose PUBLIC half E5 distributes to outposts for verification.
 *
 * DEDICATED TABLE, DELIBERATELY NOT THE `secrets` VAULT (owner decision, M17.3 grounding Area C):
 * `secrets/secrets-repo.ts` `resolveSecretRefs` resolves any `executor_bindings.secretRefs` entry
 * an org names into a `secrets` row and `plugin-host/host.ts` injects the plaintext into a plugin
 * subprocess. A dedicated table is STRUCTURALLY unreachable by that path (it queries `secrets`
 * only), so the SCP signing key can never be pulled into a plugin — the vault-exfiltration hole
 * cannot apply. Posture MIRRORS `instanceKeys`: ORG-SCOPED (one row per org), unique(orgId), full
 * `org_isolation` RLS. `privateKey` is cosign's empty-password encrypted PEM (`cosign.key`) — the
 * table's RLS + dedicated-table isolation are the protection, exactly the narrow plaintext-with-RLS
 * exception `instanceKeys` documents. `privateKey` is server-side only and is NEVER returned over
 * any HTTP API or SDK type.
 */
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

// -------------------------------------------------------------------------------------------
// M5 Campaigns (DESIGN.md §9.5, BUILD_AND_TEST.md §8 M5). Hand-authored
// grants/RLS/seed data in drizzle/0011_campaigns.sql (same pattern as 0002/0005/0007/0010).
//
// KEY DESIGN DECISION (documented at length in 0011's own header): a Campaign is NOT a second
// transition-guarded state machine. `campaign` is a graph object (pre-seeded
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
  // TRUST sense (ADR-0021 D4) — this security domain's own stable identity (UUIDv7, generated
  // once, never reused). NOT a containment `domain` object id.
  domainId: uuid("domain_id").notNull().unique().$type<TrustDomainId>(),
  name: text("name").notNull(),
  role: text("role").notNull().default("unset"), // 'unset' | 'commander' | 'outpost' | 'retrans'
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

/** Known peer domains (DESIGN §13 "peer pairing"), one row per paired remote domain. `syncScope`
 *  is configurable per peer (§13: full graph / policies-only / changes-only / status-only /
 *  label-selector custom). Pairing is always initiated by dialing OUT (§13 outpost-initiated-only)
 *  or, for air-gapped peers, by an out-of-band exchange of each side's public identity
 *  (`scp federation pair`) — never a live handshake the commander initiates. */
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
    /** M13.2a (proposal §13.2) — the peer's per-peer DeliveryTarget (`DeliveryTargetSchema`,
     *  packages/schemas): where signed channel artifacts (`.scpbundle` / relay tarballs) addressed
     *  to this peer are dropped, and where inbound ones from it arrive. NULLABLE, no backfill: a
     *  NULL falls back to the instance env (`SCP_RELAY_OUT_DIR`/`SCP_RELAY_IN_DIR` — PR #112's
     *  behavior, byte-identical), so existing setups migrate as no-ops. jsonb (not columns) because
     *  13.2b adds a `provider: 's3-compatible'` member additively — registry-shaped data, not a new
     *  table (charter principle 2). */
    deliveryTarget: jsonb("delivery_target"),
    /** M14.1 (ADR-0009, drizzle/0037) — per-peer poke-mode. NOT NULL DEFAULT false: default-off, so
     *  every existing peer migrates as a no-op poll-mode peer. `true` means the commander MAY send
     *  this peer a contentless wake signal and its frequent poll is disabled (full enforcement is
     *  M14.4); the M14.1 pair-time guard requires an https/mTLS-capable `baseUrl` before it can be
     *  set true. Plain boolean column (not jsonb) — a two-state switch, not registry-shaped data. */
    pokeMode: boolean("poke_mode").notNull().default(false),
    /** M14.4 (ADR-0009, drizzle/0038) — the live-pull scheduler's PER-PEER due-state. All three are
     *  NULLABLE with no backfill: NULL = "never" = due now, so every pre-M14.4 row migrates as a
     *  no-op (its next tick pulls immediately, exactly as before).
     *
     *  `lastPullAttemptAt` is stamped by the scheduler's CONDITIONAL claim (one atomic UPDATE …
     *  WHERE last_pull_attempt_at IS NULL OR < now() - interval), so two worker replicas cannot both
     *  pull the same peer in one window — an in-memory throttle would multiply the effective poll
     *  rate by the replica count and defeat sparse mode entirely. `lastPullSuccessAt` is stamped only
     *  on an `imported` outcome, so `lastPullSuccessAt IS NULL OR < lastPullAttemptAt` IS the
     *  "last attempt failed" signal that returns a poke-mode peer to the FREQUENT cadence until one
     *  pull succeeds (the reconnect leg — no counters, replica-safe). `lastPokeReceivedAt` is stamped
     *  by the M14.2 poke handler when it ACCEPTS a poke from that caller: a peer goes sparse only once
     *  it has PROVEN pokes actually arrive (D2 self-proving), never merely because its flag is set.
     *
     *  NOT derivable from `sync_cursors.updatedAt`: `advanceCursor` early-returns when nothing
     *  advanced, so an idempotent no-op pull leaves that timestamp untouched — it records applied
     *  progress, never a pull ATTEMPT. */
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
    peerDomainId: uuid("peer_domain_id").notNull().$type<TrustDomainId>(), // TRUST sense (ADR-0021 D4)
    publicKey: text("public_key").notNull(), // base64 SPKI DER
    // M17.3 (E5) — the peer's cosign MANIFEST-VERIFICATION public key (`cosign.pub` PEM), riding in
    // the SAME key-window row as its Ed25519 `publicKey`: distributed via the existing out-of-band
    // pairing exchange (zero new transport) and rotated by the SAME supersede mechanic (a changed
    // Ed25519 OR cosign pubkey opens a new window). Nullable — a peer paired before E5, or one that
    // never supplied a cosign key, has none. Verification against it is E6/M17.4; E5 only registers
    // it. NEVER the private half.
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
    // Both TRUST sense (ADR-0021 D4).
    peerDomainId: uuid("peer_domain_id").notNull().$type<TrustDomainId>(),
    originDomainId: uuid("origin_domain_id").notNull().$type<TrustDomainId>(),
    lastAppliedSeq: bigint("last_applied_seq", { mode: "number" }).notNull().default(0),
    // The imported `rowHash` of the entry at `lastAppliedSeq` — SECURITY-SENSITIVE: this is what
    // lets a RESUMED import verify true hash-chain continuity across separate import calls (not
    // just internal-to-one-bundle contiguity). Without it, an attacker controlling a later bundle
    // could splice in a fabricated sub-chain starting at `cursor + 1` with a `prevHash` that
    // matches nothing real, and `verifyJournalChain` would have no prior tail to check it against.
    // NULL until the first entry from this (peer, origin) pair is applied.
    lastAppliedRowHash: text("last_applied_row_hash"),
    /** ONE-SHOT RE-ANCHOR PERMIT (drizzle/0042) — SECURITY-SENSITIVE, and deliberately writable only
     *  from a LOCAL, AUTHENTICATED OPERATOR ACTION that declares this peer's own `sync_scope`: today
     *  `pairPeer` (`POST /v1/federation/peers`) and `updatePeerTransport`
     *  (`PATCH /v1/federation/peers/{id}`, M16.2 phase A E4 — which re-applies this guard precisely so
     *  widening a scope to `full` heals a wedged cursor on BOTH scope-declaring routes rather than one).
     *  Nothing else may write it; read "`pairPeer`" below as "either of those two operator paths".
     *
     *  A receiver whose own `sync_scope` is narrow verifies sparse and advances this cursor with
     *  `last_applied_row_hash = NULL` (it never holds the tail entry's hash — the tail may be an
     *  entry it was never shown). That is correct while it stays narrow. When a `pairPeer` call
     *  leaves that peer's `sync_scope` at `full` — whatever it was set to before that call — while
     *  this cursor is still anchorless, the strict path has no way to link the peer's next,
     *  perfectly contiguous run to it — every subsequent import is refused forever (the one-way
     *  ratchet). Setting this column to the CURRENT `last_applied_seq` permits the next strict run
     *  to adopt its OWN first entry as the anchor, for that one cursor position only. Everything
     *  else stays strict: the run must still begin at exactly `last_applied_seq + 1`, be internally
     *  gap-free, and verify every rowHash and signature — so a re-signed run with a deleted middle
     *  entry is still refused.
     *
     *  Consumed by the first `advanceCursor` that records real progress (which always writes a
     *  real row hash on the strict path), and only re-issued by another `pairPeer` call that again
     *  leaves this peer at `full` with an anchorless cursor. NOTHING a peer sends can set it: no
     *  import/relay/poke path writes this column. */
    reanchorFromSeq: bigint("reanchor_from_seq", { mode: "number" }),
    /** RAIL 4 — EXPORTER TAIL ATTESTATION HIGH-WATER MARK (drizzle/0090, M26.2 §7.2 rail 4).
     *  A monotonic per-`(org, peer, origin)` record of the highest journal tail this side has ever
     *  seen the exporter *attest and sign* (`SyncBundle.tailAttestation`), independent of what this
     *  receiver's scope let it actually apply. This is what makes B1 (a lost/rolled-back tail after
     *  an async-replication failover) detectable for a NARROW-scope peer, where rails 1–3 are silent
     *  because that peer never holds a real anchor. NULL until the first signed attestation is seen.
     *  Verify-and-advance only: a later attestation whose `tailSequence` regresses, or whose
     *  `tailRowHash` differs at the SAME height, is a `journal_divergence` refusal — never a
     *  regression of these columns. Nothing a peer sends other than a validly-signed attestation may
     *  move them. Read/written only by `cursors-repo.ts`'s tail-attestation path. */
    attestedTailSeq: bigint("attested_tail_seq", { mode: "number" }),
    attestedTailRowHash: text("attested_tail_row_hash"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("sync_cursors_pk").on(table.orgId, table.peerDomainId, table.originDomainId)
  ]
);

/** Federation audit witness (§7.2.7, drizzle/0091) — a passive record of a peer ORIGIN's audit-chain
 *  head, persisted from the `audit_segment` journal entries importers used to discard. INFORMATIONAL:
 *  never blocks an import. The post-failover runbook compares a restored local head against peers'
 *  witnessed `(auditEventId, contentHash)` at each sequence to DETECT truncation — the one thing
 *  `scp audit verify` cannot see, since any prefix of a valid chain verifies (B2). Peers are
 *  detectors of truncation here, never sources of the truncated data. */
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

/** Bundle-transfer tracking (DESIGN §13). One row per `.scpbundle` this side produced or consumed.
 *  PER-HOP AND INSERT-ONLY — never a lifecycle (doc corrected 2026-07-29, M16.1): `created` is
 *  written by the exporter, `submitted` only by a retrans's onward drop, `confirmed` only by the
 *  receiver, each in its OWN database, and no production path ever updates a row. See
 *  `bundle-transfers-repo.ts` for the full note (including the one test-fixture update) and the
 *  UNBUILT return-path confirmation (future increment M16.4). */
export const bundleTransfers = pgTable(
  "bundle_transfers",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id").notNull(),
    peerDomainId: uuid("peer_domain_id").notNull().$type<TrustDomainId>(), // TRUST sense (ADR-0021 D4)
    direction: text("direction").notNull(), // 'export' | 'import'
    kind: text("kind").notNull().default("sync"), // 'sync' | 'promotion'
    status: text("status").notNull().default("created"), // created|submitted|confirmed
    sinceSequence: bigint("since_sequence", { mode: "number" }),
    throughSequence: bigint("through_sequence", { mode: "number" }),
    checksum: text("checksum"),
    /** drizzle/0041 — HOW this transfer travelled: 'live-pull' (the federation-sync scheduler
     *  dialled the peer) or 'bundle' (a file/pushed/inbox handoff). NULL on rows written before
     *  0041, which surfaces as `via: "unknown"` rather than a guess. Recorded at import time
     *  because that is the only moment the transport is known — no pair of stored timestamps can
     *  reconstruct it (see the migration header). */
    transport: text("transport"),
    /** drizzle/0087 — WHICH LEG this hop was: 'metadata' (an ordinary `.scpbundle` sync/promotion
     *  export or import) or 'bytes' (a retrans byte-relay hop). NULL on rows written before 0087 or
     *  by a writer that genuinely could not determine it — never inferred from
     *  direction/kind/status, which are identical across both channels for a `kind:'promotion'`
     *  row. See `bundle-transfers-repo.ts::recordBundleTransfer` (required-at-callsite) and
     *  0087's migration header. */
    channel: text("channel"), // 'metadata' | 'bytes' | null
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true })
  },
  (table) => [
    index("bundle_transfers_org_peer").on(table.orgId, table.peerDomainId, table.createdAt),
    // drizzle/0041 — serves `lastConfirmedSyncImportAt`, which runs per peer on every service-board
    // render. Declared here for schema fidelity; the migration creates it PARTIAL + INCLUDE
    // (`direction='import' AND kind='sync' AND status='confirmed'`, INCLUDE (transport)), which
    // drizzle-kit cannot express — see 0041's header.
    //
    // `DESC NULLS LAST` MATCHES THE READ, and that is the whole point of the column order here:
    // the query orders by `confirmed_at DESC NULLS LAST` (deliberately — a NULL `confirmed_at` must
    // not sort ahead of a real one), while 0041 built the index as bare `DESC`, which PostgreSQL
    // reads as NULLS FIRST. Those are different orderings, so the index was INELIGIBLE for the read
    // and every board render seq-scanned the whole never-pruned transfer ledger and sorted it.
    // drizzle/0070 carries the plans.
    index("bundle_transfers_org_peer_confirmed").on(
      table.orgId,
      table.peerDomainId,
      table.confirmedAt.desc().nullsLast()
    )
  ]
);

/** M13.1a (proposal §13.1) — the unattended inbox loop's PROCESSED-FILE LEDGER: one row per
 *  (org, inbox dir, file name, content sha256) the loop has terminally handled, keyed on CONTENT
 *  identity so a replaced file (same name, new bytes) is processed as new while a re-listed
 *  identical file is a silent no-op. Deliberately separate from `bundle_transfers` (per-hop
 *  observational bookkeeping with no file identity — see drizzle/0034's header for the documented
 *  ledger decision). INSERT-only from the loop; files themselves are always LEFT IN PLACE in the
 *  inbox ("quarantined" is a ledger state, never a filesystem move). */
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
    outcome: text("outcome").notNull(), // 'imported' | 'forwarded' | 'refused' | 'skipped'
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

/**
 * M13.1b (drizzle/0047) — the staging-node AUTO-RELAY BUILD LEDGER. One row per (org, LOCAL
 * imported change) that OWES the onward byte hop, so a `role: retrans` instance builds the tarball
 * exactly once per imported promotion, retries a transient failure, and STOPS at an
 * operator-configured cap.
 *
 * CAUSAL, NOT DERIVED: the row is written by the promotion import itself (`promotion-repo.ts`), in
 * that transaction, on a `role: retrans` instance only — the sweep never stands a predicate scan
 * over `changes`. See the migration header for why (the high-side retrans would otherwise enumerate
 * builds it can never perform) and for why no existing surface can carry this state.
 */
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

/** Pre-M16 residual, Track A (drizzle/0040) — peer change STATUS this domain received and could
 *  not attach to anything. A `change_status` journal entry is positive evidence that a change
 *  exists and is moving on the peer (it names `payload.objectId` and a state); when no local
 *  replica of that object exists, or when this receiver's own scope filter discards the entry,
 *  `federation/import-repo.ts` used to drop that evidence silently and
 *  `coordination/service-board.ts` then reported the affected components as a confident `stable`.
 *
 *  This is the store `import-repo.ts`'s own comment already named as the missing feature. It is
 *  what makes the board's change-blindness caveat EVIDENCE-derived rather than only SCOPE-derived
 *  — decisive when the SENDER is the narrow side, because `sync_scope` is purely local config that
 *  never rides the wire and the two peers' values are never reconciled.
 *
 *  Keyed on (org, peer, change object id) and UPSERTED, so a from-genesis re-sync converges
 *  (DESIGN §6 replay invariant); DELETED when the change's `object_upsert` finally lands, so the
 *  signal resolves itself and can never fabricate persistent ignorance. It deliberately carries no
 *  target components: no `change_status` payload shape carries `targets`, so attribution stays at
 *  the (peer, change) grain and the board's caveat stays board-level — see drizzle/0040's header
 *  for the owner decision that would change that. */
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
    changeObjectId: uuid("change_object_id").notNull(), // the LOCAL imported change
    originDomainId: uuid("origin_domain_id").notNull().$type<TrustDomainId>(), // TRUST sense (ADR-0021 D4) — whose approval this was
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
    // WHICH pipeline this binding drives for the target — the routing Type (ADR-0007, migration 0026;
    // was `purpose` in 0023). A component may own several Types at once (a `configuration` sync, an
    // `image` build, an `infrastructure` apply), so bindings are 1:N per target, keyed by type.
    // Defaults to 'configuration'. Plain text (no pg enum / CHECK); the closed value set is Zod-enforced.
    type: text("type").notNull().default("configuration"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    unique("executor_bindings_org_target_type_key").on(
      table.orgId,
      table.targetObjectId,
      table.type
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

// -------------------------------------------------------------------------------------------
// M17.5 — instance-scoped scan-requirement floors (ADR-0016 §3). Hand-authored table/RLS/grants in
// drizzle/0029_scan_requirement_floors.sql; read that file's header for the full rationale.
//
// THE ONE TABLE IN THIS SCHEMA WITH NO `org_id`, and deliberately so: it carries the two ABOVE-ORG
// tiers of the six-tier scan-requirement chain (platform -> trust domain (partition) -> org ->
// containment domain -> service -> component). A deployment sits in exactly one partition, so a
// trust-domain floor applies to EVERY org hosted on it. This is the documented exception to
// DESIGN §4.2's "org_id NOT NULL on every tenant-scoped table" — the table is not tenant-scoped and
// holds no per-tenant rows at all, so it exposes no cross-tenant visibility.
//
// `tier` is spelled `trust_domain`, NEVER bare `domain`: the trust domain (partition) is the
// ambient federation boundary ABOVE org, while the `domain` OBJECT TYPE (the containment domain,
// see the `federation_self` comment above) is an intra-org grouping BELOW org. Different concepts.
//
// Access: tenant-READ (RLS `FOR SELECT USING (true)`, `scp_app` holds SELECT only) / operator-WRITE
// (over the admin connection — `scp_app` has no write grant AND there is no write policy).
//
// Every severity ceiling is NULLABLE: NULL = "this tier sets no ceiling for this severity", which
// contributes NOTHING to the per-severity MIN. Absent is never read as 0.
// -------------------------------------------------------------------------------------------
export const scanRequirementFloors = pgTable(
  "scan_requirement_floors",
  {
    tier: text("tier").notNull(), // 'platform' | 'trust_domain'
    // 'local' | 'federated'. NOTE (dated 2026-07-23, M17.5 follow-on): the CHECK admits both, but
    // NO federation writer producing `origin: 'federated'` rows exists — only the operator PUT
    // (routes/instance-scan-floors.ts) writes this table. Under the 2026-07-23 D5 decision
    // (outposts/retrans never evaluate scan policy — they validate the commander's signature, not
    // requirements), federated-origin floors are DORMANT until a genuine multi-commander
    // distribution need exists. Not a bug; see the matching note in scan-requirements.ts and the
    // ADR-0016 addendum.
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

// -------------------------------------------------------------------------------------------
// M22.2 — instance-scoped scan-EXCLUSION admissions (ADR-0033 §1, §7a). Hand-authored table/RLS/
// grants in drizzle/0074_scan_exclusion_admissions.sql; read that file's header for the full
// rationale.
//
// THE SECOND TABLE IN THIS SCHEMA WITH NO `org_id`, and it is the SAME documented exception as
// `scanRequirementFloors` above rather than a new one: an admission is an operator statement about
// the DEPLOYMENT ("exclusions of this class may have effect beneath the platform/trust-domain
// rung"), identical for every org hosted here, so it holds no per-tenant rows and exposes no
// cross-tenant visibility. Access is the same: tenant-READ (RLS `FOR SELECT USING (true)`, `scp_app`
// holds SELECT only) / operator-WRITE over the admin connection.
//
// DO NOT REASON ABOUT THIS TABLE BY ANALOGY WITH `scanFindings` BELOW — M22 added both and they are
// deliberately opposite. `scan_findings` is ordinary tenant data (`org_id NOT NULL`, standard RLS):
// it records what a scanner saw for one tenant's artifact. This one is instance config.
//
// A ROW IS AN ADMISSION; NO ROW IS NO ADMISSION. The table ships EMPTY and is never seeded, so on
// every existing deployment the `platform` rung admits nothing, every clause beneath fails the
// monotone AND, and behaviour is byte-identical to pre-M22.2. Note the sign is the OPPOSITE of the
// neighbour above: an absent floor row means NO CEILING (a loosening), an absent admission row means
// NO ADMISSION (a tightening). A tightening and a loosening cannot share a default.
//
// `class` must agree with `ScanExclusionClassSchema` (packages/schemas/src/supply-chain.ts); the
// migration carries a CHECK holding the same four values, and an integration test pins that the two
// lists agree.
// -------------------------------------------------------------------------------------------
export const scanExclusionAdmissions = pgTable(
  "scan_exclusion_admissions",
  {
    tier: text("tier").notNull(), // 'platform' | 'trust_domain'
    /** 'no_fix_available' | 'vendor_latest' | 'declared_fact' | 'approved_override' */
    class: text("class").notNull(),
    /** 'local' | 'federated'. As on `scanRequirementFloors`, the CHECK admits both but no federation
     *  writer produces `federated` rows today — outposts never evaluate scan policy (ADR-0020 §3). */
    origin: text("origin").notNull().default("local"),
    note: text("note"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [primaryKey({ columns: [table.tier, table.class, table.origin] })]
);

// -------------------------------------------------------------------------------------------
// M21.2 — the DEPENDENCY INVENTORY substrate (ADR-0032 §3/§4/§5/§7). Hand-authored table/RLS/grants
// in drizzle/0061_dependency_inventory.sql; read that file's header for the full rationale — the
// four measurements behind the principle-2 bend, the URN-collision argument, and the RLS mirroring.
//
// Two things about these tables are invariants rather than current shape:
//
//  1. NO `depends_on` EDGE IS EVER MINTED for a package dependency (ADR-0032 §5). That relationship
//     type is the wave-plan toposort input, the `impact-of`/`blast-radius` default relType, and the
//     `stageDependencies` materialisation target; a cycle among co-placed targets is a hard
//     plan-compile error and package graphs routinely contain cycles. Package dependencies live in
//     these two tables and nowhere else.
//  2. NOTHING HERE MAY EXPOSE A TRANSITIVE TRAVERSAL (ADR-0032 §3). Direct declared dependencies
//     only — the transitive closure is an SBOM by another name (ADR-0013) and SCP stores no SBOM
//     bytes. Both hot queries are single-hop index lookups served by the two indexes below; the
//     moment a recursive walk appears here the graph representation becomes necessary again and the
//     measured `impact-of` CTE hazard (7+ min, then disk exhaustion, against a 5s statement_timeout)
//     applies.
// -------------------------------------------------------------------------------------------

/**
 * The identity of ONE MAJOR LINE of one dependency, in one org. Derived, high-churn observation
 * data — the category `changeSourceEvents` and `objectHealth` already occupy — so it is a
 * projection table and it does NOT federate (ADR-0032 §3, unchanged: that is what justifies the
 * principle-2 bend).
 *
 * IT IS WRITTEN ON THE COMMANDER ONLY (ADR-0032 §7d, owner decision 2026-08-17). This comment used
 * to say "per-domain … each domain derives its own", quoting §3; that half is reversed. All
 * dependency automation is commander-only — a FIELD outpost never ORIGINATES a bump, it receives the
 * resulting change down the global pipeline the commander manages — so these rows exist in exactly
 * one place, and an EMPTY `dependency_lines` on a field outpost is correct rather than a sync
 * failure. "Field" is the qualifier that makes that sentence true: an HQ outpost is the outpost in
 * the COMMANDER'S OWN trust domain, so its rows ARE these rows (ADR-0032 §7d's vocabulary note,
 * read out of the code in `dependencies/commander-only.ts`). Any deployment whose
 * `SCP_FEDERATION_ROLE` reads `outpost` is a field outpost, which is why the table is empty
 * exactly there and nowhere else.
 * `drizzle/0061`'s `COMMENT ON` carried the old wording, which is what an operator actually meets
 * in `\d+ dependency_lines`; 0061 is merged and not editable in place, so `drizzle/0066` restates
 * it there. The two are meant to be read as one statement — keep them saying the same thing.
 *
 * THE COORDINATE IS NOT A URN, and that is why this is a table. `graph/urn.ts`'s `slugify`
 * lowercases and hyphenate-collapses every non-alphanumeric run, so `@acme/lib`, `acme/lib` and
 * `acme-lib` all become `acme-lib` — one URN, a 409 collision, no auto-suffix and no
 * upsert-by-coordinate. `coordinate` is therefore the ecosystem-native string stored VERBATIM, and
 * `(orgId, ecosystem, coordinate, major)` is the identity.
 */
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
    /** `oci` only — the tag shape whose parsed version this line follows. Image tags are not semver
     *  (`1.2.3`, `1.2.3-alpine`, `1.2`, `latest` and date stamps coexist) and a registry has no
     *  notion of a major line, so an image line needs a pattern plus an extractor; tags the
     *  extractor cannot parse are SKIPPED, never guessed (ADR-0032 §7). NULL for the four language
     *  ecosystems. */
    tagPattern: text("tag_pattern"),
    // THE PRODUCER LINK USED TO BE HERE — `produced_by_object_id` + `produced_by_declared_at` +
    // `produced_by_declared_by_object_id`, with a partial index and the
    // `dependency_lines_internal_is_declared` CHECK. All five are gone (drizzle/0068, ADR-0032 §7e).
    //
    // They made the declaration PER MAJOR LINE, and a line is minted only by a CONSUMER's manifest.
    // So every new major of a coordinate the org publishes minted a fresh row with a NULL producer —
    // honestly third-party, since nobody had filled it in — and `buildLineWorkList` then handed the
    // org's own coordinate to a PUBLIC INDEX. That is §7b clause 1's dependency-confusion
    // catastrophe, re-armed silently at each major bump; both barriers that exist against it read
    // the column, and neither can protect a column nobody filled in. The declaration now lives in
    // `dependencyLineProducers`, keyed `(org_id, ecosystem, coordinate)`.
    //
    // DO NOT REINSTATE THIS AS A MATERIALIZED CACHE stamped by `upsertDependencyLine` at mint time.
    // It closes the same hole with no human step, and it puts a `produced_by_*` write back inside
    // the ingestion verb — which deletes "the capability is absent from ingestion", the property
    // this whole feature protects. The join makes the projection unnecessary rather than safe.
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

/**
 * WHICH COMPONENT THIS ORG DECLARES IT PRODUCES ONE COORDINATE (ADR-0032 §7e, proposal §12.1).
 * Hand-authored table/RLS/grants in `drizzle/0068_dependency_line_producers.sql`.
 *
 * THE GRAIN IS THE COORDINATE, NOT THE LINE, and that is a security property rather than tidiness.
 * A `dependency_lines` row is `(org, ecosystem, coordinate, major)` and is minted ONLY by a
 * consumer's manifest, so under per-line grain (a) a producer with no consumers yet had no row to
 * attach to, and (b) every new major minted a fresh NULL-producer row that the version poll then
 * handed to a public index — §7b clause 1's dependency confusion, on a daily timer, re-armed at
 * each major bump with nothing to alert on. Keyed by coordinate, a brand-new major of a declared
 * coordinate is internal FROM THE INSTANT IT IS MINTED, because there is no per-major field left to
 * populate.
 *
 * IT IS NOT A GRAPH OBJECT, AND THAT IS THE FEDERATION DECISION (proposal §12.4). A `produces`
 * relationship or a `producedBy` policy effect WOULD federate — `policy` does — and a field outpost
 * would then hold a declaration with no inventory behind it: a visible assertion nothing can act on.
 * A projection table cannot make that mistake; it exists only where the inventory does, which since
 * ADR-0032 §7d is the commander alone.
 *
 * DECLARED, NEVER INFERRED. Nothing writes this table except the two verbs in
 * `routes/dependency-producers.ts`; `inventory-ingestion.ts` does not import it, which is the
 * enforcement, exactly as `dependency-inventory-repo.ts` not importing `relationships` is the
 * enforcement for "no `depends_on` edge is minted".
 */
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

/**
 * The projection: which component DECLARES which dependency line, at which version, out of which
 * dependency manifest (ADR-0032 §4). Keyed by the component's GRAPH OBJECT ID — the same "thin
 * projection table that references its graph object" pattern `changes.objectId`, `objectHealth` and
 * `freezes.scopeObjectId` use (DESIGN §4.1). The component stays a first-class graph object; only
 * this projection of it is tabular.
 *
 * DIRECT DECLARED DEPENDENCIES ONLY. No column here can hold a transitive closure, deliberately.
 */
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
    /**
     * The REPOSITORY the manifest was read from, as the provider spells it — the other half of the
     * address `observed_ref` only ever gave one half of (a commit sha names no repository).
     *
     * It is what makes a prune attributable: an ingestion pass reads ONE repo, and "this path is
     * not in repo A" is evidence about repo A alone. Without this column a pass over a component
     * fed by two repositories pruned the OTHER repository's declarations, which silently
     * unsubscribes the component (drizzle/0063). NULL means "not recorded" and is never pruned.
     */
    observedRepo: text("observed_repo"),
    /** The git ref the manifest was read at (`refs/heads/main`), so a declaration is attributable to
     *  a point in the repo rather than to "whenever we last looked". */
    observedRef: text("observed_ref"),
    /** WHEN THE MANIFEST WAS READ — the phase-2 provider read, not the phase-3 write. That is what
     *  makes it comparable between two passes that overlap: the ordering guard in
     *  `inventory-ingestion.ts` refuses to apply a pass whose evidence is older than what the row
     *  already carries, and a write-time stamp would say the opposite thing (the pass that landed
     *  last, not the pass that looked last). */
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
  /**
   * THE REPOSITORY THIS ENTRY'S EVIDENCE CAME FROM — which is what makes the array a merge target
   * rather than something a pass replaces wholesale.
   *
   * A pass reads exactly ONE repository, and `source_mappings` is many-per-component: a component
   * legitimately releases from `acme/widgets` (its `go.mod`) and from `acme/charts` (its
   * `Dockerfile`). Keyed by `path` alone, a charts pass replaced the entire array and ERASED the
   * widgets pass's `unreadable` verdict minutes later — state (iii) "manifests unreadable" rendered
   * as state (ii) "genuinely declares nothing", which is precisely the lie this table was built to
   * prevent. So the writer replaces only the `(repo, *)` slice it holds evidence over
   * (`mergeIngestionStamp`), and the component-level `outcome` is computed ACROSS the merged set.
   */
  readonly repo: string;
  /** Repo-relative path, as `component_dependencies.manifest_path` spells it. */
  readonly path: string;
  /** `ok` read and parsed; `unreadable` a read or parse that failed THIS TIME and may succeed on
   *  the next pass; `unsupported` a file SCP structurally cannot read (no parser registered for
   *  that filename in this build, an LFS pointer, a directory, a binary, an encoding the decoder
   *  does not implement). The split is by OPERATOR ACTION, which is the test for whether a reason
   *  deserves its own name (ADR-0032 §7b clause 6). */
  readonly outcome: "ok" | "unreadable" | "unsupported";
  /** `component_dependencies` rows THIS manifest's last observation wrote; 0 on an entry that was
   *  not read and on one whose manifest went away. The row's `rows_written` is the SUM of these
   *  over the merged set — it has to be, or a second repository's pass would report its own count
   *  as the whole component's and `ok` + 0 would stop meaning "declares nothing". */
  readonly rows: number;
  /** WHEN THE PASS THAT WROTE THIS ENTRY LOOKED, ISO-8601. The only thing that orders two passes
   *  over the SAME repository: a late-delivered retry of an earlier pass must not replace a newer
   *  slice (both delivery hops are at-least-once and the ingestion queue is a competing consumer).
   *  Per entry rather than per row because the row's own `last_attempt_at` is now the newest across
   *  ALL repositories, which says nothing about whether this repository's slice is stale. */
  readonly at: string;
  /** The ingestion's own sentence about this path. Absent on the ordinary `ok` entry. */
  readonly detail?: string;
}

/**
 * ================================================================================================
 * THE DEPENDENCY INGESTION'S RECEIPT, PER COMPONENT (migration 0065, ADR-0032 §4)
 * ================================================================================================
 * `component_dependencies.observed_at` is PER ROW, so a component with ZERO rows carries no
 * timestamp at all and three different truths produce the same empty list: never ingested;
 * ingested fine and genuinely declares nothing; ingestion ran and every manifest was unreadable.
 * The ingestion has always COMPUTED which one — the verdict, the per-manifest skip reason and a
 * detail are all on `ComponentIngestionOutcome`, the backfill route reports them per component and
 * the loop logs them — and NOTHING PERSISTED IT, so a reader arriving later has only the absence of
 * rows to go on and is forced to render "no dependencies" over all three. The third rendered as the
 * second is a lie told with a straight face: the component is silently unsubscribed from everything
 * it declares, and the screen says it has nothing to declare.
 *
 * ONE ROW PER COMPONENT, UPSERTED. Bounded by the component count, not by the event rate — a pass
 * updates a row rather than appending one, which is the distinction ADR-0024's 1.44 GB/day
 * measurement is actually about.
 *
 * "NEVER ATTEMPTED" IS THE ABSENCE OF A ROW, never a value: the only writer of "we have never
 * looked at this component" would be a pass that ran, which is a contradiction. `scp_app` holds no
 * DELETE grant here for the same reason — deleting a stamp forges that absence.
 *
 * WHY NOT THE DECISION THE INGESTION ALREADY WRITES: it writes NO Decision on the refused paths
 * (not enabled, not addressable), which are exactly the components whose empty list needs
 * explaining; and it is persist-on-change with the ref, the commit and every timestamp deliberately
 * excluded, so "when did we last look?" is unanswerable from it BY DESIGN.
 */
export const dependencyIngestionStamps = pgTable(
  "dependency_ingestion_stamps",
  {
    orgId: uuid("org_id").notNull(),
    /** Org-unbound `references(objects.id)` — the form `changes.objectId` and
     *  `component_dependencies.component_object_id` use. There is NO composite foreign key here and
     *  that is a finding rather than an omission: `component_dependencies` carries one because a
     *  row of it points at a `dependency_lines` row and 0061 gave that table a `(org_id, id)`
     *  UNIQUE constraint expressly so a composite key had something to reference. This table points
     *  at nothing org-scoped, and `objects` carries no `(org_id, id)` unique constraint to hang one
     *  on. 0061's barrier-2 residue therefore applies verbatim (drizzle/0065's header states it in
     *  full, including what a future read route owes). */
    componentObjectId: uuid("component_object_id")
      .notNull()
      .references(() => objects.id),
    /** WHEN THIS PASS LOOKED — the phase-2 read time where a provider was reached, the start of the
     *  pass where it refused before reaching one. The same clock `component_dependencies.observed_at`
     *  is stamped from, so a pass's stamp and its rows describe one instant and two overlapping
     *  passes order identically in both places. */
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }).notNull(),
    /** `loop` (event-driven, reacting to an accepted change) or `backfill` (an operator ran
     *  `POST /dependencies/inventory/backfill`) — "is this inventory maintained by the component's
     *  own releases, or only by whoever last ran a backfill?", two very different freshnesses
     *  behind one timestamp. Plain text with no CHECK, like `dependencyLines.ecosystem`: the closed
     *  set is enforced by the union type at the one write door, and `source` is a REQUIRED input of
     *  `ingestComponentManifests`, so a third producer does not compile until it names itself. */
    source: text("source").$type<"loop" | "backfill">().notNull(),
    /** What the component's manifests are KNOWN TO BE, across every repository that feeds it —
     *  computed over the merged `manifests` set, not reported by whichever pass wrote last. `ok`
     *  every entry was read; `partial` some read and some not (the mixed case, which `manifests`
     *  names, and which a component fed by two repositories reaches routinely); `unreadable`
     *  nothing was read at all; `not_enabled` the gate is closed so nothing is fetched — the empty
     *  list is correct and is not evidence about the manifests. */
    outcome: text("outcome").$type<"ok" | "partial" | "unreadable" | "not_enabled">().notNull(),
    /** The ingestion's own sentence behind `outcome`, and ONLY when the outcome is one a pass
     *  declared rather than one the merged evidence computed (`not_enabled`, "no repository was
     *  named"). It exists because `manifests` is keyed BY PATH and those refusals have no path to
     *  hang an explanation on; where the evidence decides, the per-path details ARE the
     *  explanation and this is null. */
    detail: text("detail"),
    /** `component_dependencies` rows the component's manifests currently account for — the SUM of
     *  `manifests[].rows` over the merged set, so a pass over one repository cannot report its own
     *  count as the whole component's. 0 IS LEGAL AND MEANINGFUL: `ok` + 0 is "read fine, genuinely
     *  declares nothing", the state that could not be expressed before this table. Counts what was
     *  written, never what was pruned — this describes the observation. */
    rowsWritten: integer("rows_written").notNull(),
    /** Per (REPOSITORY, manifest path), sorted. Per path because `manifest_path` is part of
     *  `component_dependencies`' primary key — one component legitimately declares from several
     *  manifests, so "one readable, one not" is ordinary rather than hypothetical, and a count
     *  cannot tell an operator WHICH file to fix. Per REPOSITORY because a pass reads exactly one
     *  and `source_mappings` is many-per-component: a pass replaces only its own repository's
     *  slice, so a successful charts release can no longer erase a failed widgets read. `[]` —
     *  never NULL — states "no manifest is known for this component". */
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

/**
 * ================================================================================================
 * WHAT COMMANDERSCP ITSELF AUTHORED FOR A DEPENDENCY BUMP (migration 0063, ADR-0032 §8/§9)
 * ================================================================================================
 * SERVER-OWNED STORAGE, AND THAT IS THE ENTIRE POINT OF THE TABLE.
 *
 * Every input that decides whose credential merges what — the repository, the authored ref, the base
 * branch, the component, the line, the branch's head commit, the pull request — used to be read out
 * of `changes.source_ref.scp_authored`. `source_ref` is the raw delivery payload plus a few lifted
 * keys, and ANY authenticated principal can write it verbatim through `POST /api/v1/changes`; the
 * event that starts the merge gate can likewise be produced through `POST
 * /change-sources/{kind}/report`. A tenant could therefore fabricate a "bump" naming any repository
 * and have SCP merge into it with SCP's own installation credential — a confused deputy, not a
 * validation gap, and no amount of validating an attacker-writable field fixes one.
 *
 * A merge is the one irreversible thing this feature does, so it acts ONLY on facts SCP ITSELF
 * RECORDED. These rows are written by `dependencies/bump-actuator.ts` when SCP decides to author, and
 * updated only by the ingress that observes SCP's own branch coming back and by the gate that
 * actuates the merge. There is no route, no IaC type and no federation importer that reaches them. A
 * change with no row here is NOT a bump change and never reaches the merge path.
 *
 * `changes.source_ref.scp_authored` is still written — as the human-readable explanation on the
 * change (principle 6) — and is no longer READ by anything that decides a write.
 */
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
    /** That pull request's web URL AS THE PROVIDER RETURNED IT (migration 0066). NOT derived from
     *  `repo` + `pullRequestNumber`: those compose a working link only for github.com, and nothing
     *  on this row says which provider authored the bump — an outpost-local Gitea (M15) is another
     *  host AND spells the path `/pulls/`, GitHub Enterprise is another host again. NULL means SCP
     *  recorded no link; it never means "compose one". */
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

/**
 * THE PER-OBJECT RUNGS OF THE `governance:move` LATTICE (drizzle/0083,
 * docs/proposals/governance-reach-on-containment-move.md §9.2 — owner ruling 2026-08-18).
 *
 * One row per CONTAINER (org root, containment domain, service, assembly) under which a containment
 * MOVE additionally requires `governance:move` at both ends. The lattice is monotone and top-down:
 * enforcement applies iff the instance rung ({@link governanceMoveInstanceRung}) is enabled OR any
 * object on the moved object's containment chain or on the destination's chain carries a row here.
 * A rung enabled ABOVE therefore cannot be disabled below — the DELETE route answers 409 naming the
 * upper rung rather than reporting a disable that leaves the state enforced anyway.
 *
 * EMPTY IS THE SHIPPED STATE and means no enforcement anywhere, which is why adding this table moved
 * no existing authorization outcome.
 */
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

/**
 * THE INSTANCE (COMMANDER) RUNG — the singleton that ACTIVATES the lattice deployment-wide
 * (drizzle/0083 §2; owner decision Q1-A: "if enabled there, orgs can't disable it").
 *
 * Storage is byte-for-byte the `dependency_subscription_unlock` shape (0062): `CHECK id = 'default'`,
 * tenant SELECT-only, FORCE RLS, no write policy, operator-token `PUT` through the raw admin pool.
 * The MEANING differs — the unlock permits, this activates — but the authority question is the same:
 * a deployment-wide switch no tenant role may flip.
 *
 * NO ROW MEANS DISABLED, decided in exactly one place (`governance/move-enforcement.ts`'s
 * `readInstanceMoveRung`).
 */
export const governanceMoveInstanceRung = pgTable("governance_move_instance_rung", {
  id: text("id").primaryKey().default("default"),
  enabled: boolean("enabled").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

/**
 * M25.3 — THE INSTANCE-SCOPED (PLATFORM) FREEZE TIER, above org (drizzle/0086,
 * docs/proposals/campaigns-rework.md §2 — owner decision D1, 2026-08-23).
 *
 * ONE ROW BINDS EVERY ORG ON THE DEPLOYMENT. No `org_id` — the DESIGN §4.2 exception 0029/0035/
 * 0036/0062/0074/0083 already take, for the same reason: this is an operator statement about the
 * deployment, not tenant data. Tenant-READ (charter principle 6 — a blocked change must be able
 * to name what blocked it), operator-WRITE only (`SCP_OPERATOR_TOKEN` + the `scp_operator`
 * connection; `scp_app` holds SELECT and has no write policy in any verb).
 *
 * ADDRESSES A STAGE COORDINATE, NOT AN OBJECT. `freezes.scopeObjectId` names a graph object and
 * the containment walk decides coverage; that is unavailable here, because object ids are per-org
 * rows and `containmentChain` is org-filtered — no id names anything in a second tenant. So a
 * platform freeze matches on the M15.6 / ADR-0017 §3 coordinate a `deployment-target` DECLARES:
 * `properties.environment` (+ optional `properties.region`), read by
 * `coordination/regional-executors.ts`'s `readStageCoordinate` (the one reader of that
 * convention) INCLUDING the placement -> deployment-target hop.
 *
 * {@link instanceFreezes.matchAllEnvironments} is the EXPLICIT deployment-wide form. An absent
 * `matchEnvironment` is NOT deployment-wide (the proposal said it was; 0086's header states why
 * that was changed) — the widest tightening this table can express must be said out loud, not
 * reached by omitting a field.
 *
 * MERGE IS UNION, NOT MIN. ADR-0016's scan floors take a per-severity MIN because a threshold is
 * a number; a freeze is a PREDICATE and the merge is an OR. An instance freeze blocks even when
 * the org declared nothing, and nothing an org can author subtracts from it — the "floor"
 * property lives entirely in {@link instanceFreezes.overridable}, never in the merge.
 *
 * DOES NOT FEDERATE and structurally cannot: `SyncJournalEntrySchema.orgId` is a required uuid
 * and every layer below it is org-scoped. Hence no `origin` column (0086's header) — a field with
 * no possible writer lies. Distribution to a fleet is deployment tooling, the same path that
 * distributes `SCP_OPERATOR_TOKEN`.
 *
 * EMPTY IS THE SHIPPED STATE, and empty is byte-identical to pre-M25.3 behaviour everywhere.
 */
export const instanceFreezes = pgTable(
  "instance_freezes",
  {
    /** A REAL uuid (uuidv7, stamped by the route), because this id travels into
     *  `ServiceBoardFreezeSchema.id` — published as `z.string().uuid()` in `openapi.v1.json`. A
     *  synthetic `platform:<key>` identity would either violate that shipped response contract or
     *  force widening it. Stable across a `PUT` upsert of the same key. */
    id: uuid("id").primaryKey(),
    /** The operator slug: the `PUT`/`DELETE` path segment. UNIQUE, not the PK. */
    key: text("key").notNull().unique(),
    name: text("name"),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    reason: text("reason").notNull(),
    /** The explicit deployment-wide form — covers every target including one that declares no
     *  stage coordinate at all. Mutually exclusive with `matchEnvironment` (DB CHECK). */
    matchAllEnvironments: boolean("match_all_environments").notNull().default(false),
    /** Matches every stage whose deployment-target declares this `properties.environment`. */
    matchEnvironment: text("match_environment"),
    /** Narrows `matchEnvironment` to one `properties.region`. Null = every region of it. */
    matchRegion: text("match_region"),
    /** Owner decision D5, the same semantics as `freezes.atomic` (0084) one tier up: `true` parks
     *  EVERY target of a wave once it covers any one of them. Read in both places the org-tier
     *  column is read — `gate-orchestrator.ts`'s `partiallyFrozen` and
     *  `coordination/freeze-hold.ts` — because the wave gate fires exactly once. */
    atomic: boolean("atomic").notNull().default(false),
    /** Proposal §2.2 — WHETHER ANY TENANT ROLE MAY OVERRIDE THIS FREEZE AT ALL.
     *
     *  `false` (the default): none can, however privileged — not an org-root Owner holding
     *  `freeze:override`. `hasPermission` builds `scopeExpandCte(orgId, scopeObjectId)` and joins
     *  `role_bindings` filtered `rb.org_id = orgId`, so every id in that query is org-scoped and a
     *  platform freeze has no id in it; the three natural fakes are all wrong (an org-root scope
     *  hands every org Administrator the lift, a synthetic sentinel makes it un-overridable BY
     *  ACCIDENT, and an operator token on the request is impossible for the case that matters
     *  because wave-boundary gates run under `SYSTEM_ACTOR_ID` with no HTTP request in scope).
     *
     *  `true`: the OPERATOR has admitted tenant override for THIS freeze, and an actor holding
     *  `freeze:override` AT THE ORG ROOT may override it with the same mandatory non-empty reason
     *  every other override needs. Two independent authorities, both required. */
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

/**
 * M22.1b (ADR-0033 §7/§7a, migration 0073) — the per-finding projection of ONE scan verdict.
 *
 * A scan verdict was four integers until M22.1a; every rule in ADR-0033 is a rule ABOUT A FINDING,
 * so this is the substrate the rest of M22 queues behind. See 0073's header for the full argument;
 * the four load-bearing facts, restated where the code is:
 *
 *   1. ORDINARY TENANT DATA, `org_id NOT NULL` under the standard `org_isolation` RLS policy. NOT
 *      the DESIGN §4.2 tenancy exception — M22.2's instance-tier ADMISSION rows are that, and the
 *      two land in the same milestone and must not be copied from each other.
 *   2. A PROJECTION TABLE, not a graph object type, on drizzle/0061's four measured tests: a finding
 *      has no sluggable identity (the same CVE recurs per package; an entry may carry no
 *      `VulnerabilityID` at all yet still counts), 2000 rows/scan through the graph write path is
 *      2000 signed journal rows behind two per-org advisory locks, a new builtin type can wedge a
 *      peer's whole signed bundle mid-upgrade, and this is high-churn derived observation data.
 *   3. COMMANDER-LOCAL. `control_runs.evidence` is copied VERBATIM into the promotion bundle, so
 *      findings are deliberately rows here and never on that column — the bundle keeps counts.
 *   4. RETENTION IS PER ROW (ADR-0024 §D1, ADR-0033 D10): an EXCLUDED finding is accepted-risk
 *      evidence ('E'); an ordinary one is telemetry ('O').
 */
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

/**
 * The four DECLARED test hooks per component (D11/D21) — `postMerge`, `postDeploy`, `continuous`,
 * `bakeAlarms`.
 *
 * IDENTITY is `(orgId, componentObjectId, kind, hookId)` and it is a real UNIQUE constraint, not a
 * convention the writer observes. `ManifestPipelineHookSchema` states the rule: there is no update
 * path keyed on a subset, so a changed hook is a delete + create.
 *
 * NO `managedByStack` COLUMN, AND NONE IS EVER ADDED. `packages/schemas/src/iac.ts` settles this for
 * the whole family of per-object configuration tables and this is one of them: "OWNERSHIP IS DERIVED
 * FROM THE OWNING OBJECT ... neither table has a `labels` column, and neither gets one. A row belongs
 * to stack S iff the graph object it hangs off (`component_object_id` / `target_object_id`) is one
 * THIS stack owns." A stack-label column would be a SECOND answer to "who owns this row", and the
 * moment it can disagree with the first, a plan's prune set and its apply's prune set are computed
 * from different facts. `source_mappings` and `executor_bindings` are the precedents.
 *
 * The per-kind nullable columns are not split into four tables: the closed per-kind shape is enforced
 * by the Zod discriminated union at every write door, and a CHECK matrix here would be a second,
 * driftable copy of it.
 */
/**
 * D26 (owner ruling 2026-08-27) — WHICH STACKS A CONFIG SOURCE ACTUALLY DELIVERS.
 *
 * Ownership follows delivery: a stack the sync has applied for a config source is repo-owned
 * whether or not an operator wrote it into that registration's `stackTeams` map, and the D7
 * CLI-apply guard reads this table UNION the explicit claims. See `drizzle/0101` for the full
 * reasoning and for why the PRIMARY KEY is `(org_id, stack_name)` rather than including the source.
 *
 * SERVER-OWNED, like `plans` and `decisions`: no IaC manifest can declare or prune a row here, and
 * there is deliberately no `managed_by_stack` column to suggest otherwise.
 */
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

/**
 * Concluded test runs and asserted alarm-state windows (D21(b)/D23).
 *
 * ===========================================================================================
 * `source` AND `producerSubjectId` ARE SERVER-STAMPED. THEY ARE NEVER SETTABLE FROM A REQUEST BODY.
 * ===========================================================================================
 * `SubmitPipelineEvidenceRequestSchema` carries no `producer`/`source`/`reportedBy` field and must
 * never gain one. The rule, already written down in `federation/scan-evidence.ts`: PROVENANCE —
 * which authenticated principal and which module produced the row — IS THE AUTHORIZATION BOUNDARY,
 * NOT THE PAYLOAD SHAPE, because a shape-valid payload is forgeable by anyone who can read the
 * schema. Both columns are filled at INSERT from the authenticated subject and from which door the
 * row arrived through, the same way `controlRuns.pluginModule` is stamped.
 *
 * That matters beyond bookkeeping: `evaluateBakeGate` evaluates window coverage PER SOURCE (source
 * A's reports never fill source B's gaps), so a caller who could choose its own `source` could
 * manufacture single-source coverage of a window it never observed.
 *
 * TWO WRITE SEMANTICS, ON PURPOSE — `testRun` rows supersede newest-wins (enforced by the partial
 * unique index `pipeline_evidence_test_run_identity`, migration 0096), `alarmState` rows ACCUMULATE.
 * See `recordTestRunEvidence` / `recordAlarmEvidence` for why each is the semantics rather than a
 * retention choice.
 */
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
    /** 'testRun'|'alarmState'. Plain text, Zod-enforced — see `pipelineHooks.kind`. */
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

/**
 * IN-FLIGHT AND CONCLUDED HOOK RUNS (migration 0098) — the state `pipelineEvidence` structurally
 * cannot hold.
 *
 * `TestRunEvidenceSchema.outcome` is `passed|failed` and nothing else, on purpose: "Evidence is a
 * record of something that FINISHED; an in-flight run is expressed by the ABSENCE of evidence." That
 * leaves one fact with nowhere to live — THAT SCP ALREADY ASKED. Without it, the 1s reconcile tick
 * looks for evidence of a postDeploy suite, correctly finds none, and dispatches the suite again;
 * and again; because nothing in the database distinguishes "not started" from "started, running".
 *
 * This table is NOT a second evidence table and must never become one. `evaluatePostDeployGate` does
 * not read it. Evidence records the answer; this records the question having been posed.
 *
 * ===========================================================================================
 * `pipelineHookRunsIdentity` IS THE TRIGGER GUARD, AND IT IS `NULLS NOT DISTINCT`
 * ===========================================================================================
 * The claim row is inserted BEFORE `trigger()` fires, so winning or losing this constraint is what
 * decides who dispatches — the crash-safe three-step shape `reconcile.ts`'s `triggerWaveTarget` uses
 * for wave targets (PR #7 review CRITICAL #2), applied to hooks.
 *
 * `.nullsNotDistinct()` because `postMerge` is not target-specific and belongs to no wave, so its
 * `waveIndex` is NULL — and under PostgreSQL's DEFAULT `NULLS DISTINCT`, NULL never equals NULL, so
 * a plain UNIQUE would leave the guard applying to every hook kind EXCEPT that one. Nothing would
 * error and nothing would log; the suite would simply run once per tick. Requires PostgreSQL 15+;
 * DESIGN.md §3 pins the required floor at 16+.
 */
export const pipelineHookRuns = pgTable(
  "pipeline_hook_runs",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id").notNull(),
    /** The component whose hook this run belongs to — AND the ownership pointer. NO `managedByStack`
     *  column and none is ever added; ownership derives from the owning object, exactly as for
     *  `pipelineHooks` / `sourceMappings` / `executorBindings` (packages/schemas/src/iac.ts). */
    componentObjectId: uuid("component_object_id").notNull(),
    /** NULLABLE, and load-bearing: `postMerge` runs before any artifact exists and is not
     *  target-specific, so there is no target to name. See the constraint note above for what that
     *  NULL does to a plain UNIQUE. */
    targetObjectId: uuid("target_object_id"),
    /** The Change this run gates. Part of the identity — a run for change A says nothing about
     *  change B, even at the same wave index. */
    changeObjectId: uuid("change_object_id").notNull(),
    hookId: text("hook_id").notNull(),
    /** 'postMerge'|'postDeploy'|'continuous'|'bakeAlarms'. Plain text, Zod-owned — see
     *  `pipelineHooks.kind`. */
    kind: text("kind").notNull(),
    /** NULL for `postMerge`, which belongs to no wave. */
    waveIndex: integer("wave_index"),
    /** The binding this run's eventual evidence carries: `postMerge` -> commit, the other three ->
     *  digest. Both nullable here; `PipelineEvidenceSubjectSchema`'s exactly-one refine is enforced
     *  at the evidence write, where a mismatch must be a refusal rather than a widening. */
    artifactDigest: text("artifact_digest"),
    commitSha: text("commit_sha"),
    /** NULLABLE, AND THAT IS THE WHOLE DESIGN. The row is claimed BEFORE `trigger()` is called, so
     *  there is no external run to name yet. NOT NULL would force trigger-then-insert, and a crash
     *  between the two would leave a running workflow in the estate with no record of it here — the
     *  exact double-dispatch this table exists to prevent. NULL therefore means "durably claimed,
     *  not yet dispatched OR did not survive to record the answer"; both recover identically by
     *  re-deriving the SAME `idempotencyKey` and re-calling `trigger()`, which a conformant executor
     *  dedups (`TriggerIntent.idempotencyKey`). */
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
    /** The D23 pin: `CapturedWorkflowRef` — declared (repo, branch, path) PLUS the BUILT `commitSha`
     *  PLUS the digest-pinned `bundle`. Per-BUILD, so it belongs on the run rather than on the hook
     *  declaration (which is only "a pointer into whatever the cluster happens to hold right now").
     *
     *  POPULATED BY `deriveCapturedWorkflow` at claim time, from three facts that must ALL be
     *  present: the hook's declared `WorkflowRef`, the change's built commit, and the test bundle the
     *  build REPORTED on `sourceRef.testBundle` (`ChangeReportRequestSchema.testBundle`). NULL when
     *  any one of them is absent — a build that reports no bundle, most commonly. The driver's
     *  response to NULL is to record the terminal status and write NO evidence, loudly; NOT to
     *  synthesise a digest so the shape type-checks. Fabricated, it would satisfy
     *  `evaluatePostDeployGate` while bound to bytes nobody verified — the failure
     *  `evaluateScanCoverage`'s `not_digest_bound` refusal prevents one layer down. */
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
