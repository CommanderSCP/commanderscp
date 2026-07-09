import { pgTable, text, timestamp, uuid, unique } from "drizzle-orm/pg-core";

/**
 * M0 minimal schema (BUILD_AND_TEST.md §8 M0: "minimal `objects` table"). This is deliberately
 * NOT the full graph model from DESIGN.md §4.1 (object_types/relationship_types/objects/
 * relationships with UUIDv7, URN, provenance, RLS) — that full substrate is M1's Core Graph
 * Engine. M0 exists to prove the contract pipeline (Zod → OpenAPI → SDK → CLI → UI) and the
 * local-auth bootstrap flow end to end against a real Postgres, with just enough shape to be
 * superseded (not reworked) by M1's migration.
 */

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
    passwordHash: text("password_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [unique("users_org_id_username_key").on(table.orgId, table.username)]
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

export const objects = pgTable("objects", {
  id: uuid("id").primaryKey(),
  orgId: uuid("org_id")
    .notNull()
    .references(() => orgs.id),
  type: text("type").notNull(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});
