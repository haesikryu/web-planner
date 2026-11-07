import { sql } from "drizzle-orm";
import { boolean, check, date, foreignKey, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

const instant = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
export const user = pgTable("users", {
  id: text("id").primaryKey(), name: text("name").notNull(), email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false), image: text("image"),
  timezone: text("timezone").notNull().default("UTC"), settingsVersion: integer("settings_version").notNull().default(1),
  createdAt: instant("created_at").notNull().defaultNow(), updatedAt: instant("updated_at").notNull().defaultNow()
});
export const session = pgTable("sessions", {
  id: text("id").primaryKey(), userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  token: text("token_hash").notNull().unique(), expiresAt: instant("expires_at").notNull(),
  createdAt: instant("created_at").notNull(), updatedAt: instant("updated_at").notNull(),
  ipAddress: text("ip_address"), userAgent: text("user_agent")
}, t => [index("sessions_user_idx").on(t.userId), check("session_hash", sql`${t.token} ~ '^[a-f0-9]{64}$'`)]);
export const account = pgTable("identities", {
  id: text("id").primaryKey(), userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  accountId: text("subject").notNull(), providerId: text("provider_id").notNull(),
  accessToken: text("access_token"), refreshToken: text("refresh_token"), idToken: text("id_token"),
  accessTokenExpiresAt: instant("access_token_expires_at"), refreshTokenExpiresAt: instant("refresh_token_expires_at"),
  scope: text("scope"), password: text("password"),
  createdAt: instant("created_at").notNull(), updatedAt: instant("updated_at").notNull()
}, t => [unique("identity_subject_unique").on(t.providerId, t.accountId), index("identity_user_idx").on(t.userId),
  check("google_only", sql`${t.providerId} = 'google'`),
  check("no_provider_credentials", sql`${t.accessToken} IS NULL AND ${t.refreshToken} IS NULL AND ${t.idToken} IS NULL AND ${t.password} IS NULL`)]);
export const verification = pgTable("verifications", {
  id: text("id").primaryKey(), identifier: text("identifier").notNull(), value: text("value").notNull(),
  expiresAt: instant("expires_at").notNull(), createdAt: instant("created_at").notNull(), updatedAt: instant("updated_at").notNull()
}, t => [index("verification_identifier_idx").on(t.identifier)]);
export const tasks = pgTable("tasks", {
  id: uuid("id").primaryKey().defaultRandom(), ownerId: text("owner_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  title: text("title").notNull(), status: text("status").notNull().default("open"),
  scheduledDate: date("scheduled_date"), dueDate: date("due_date"), isUnprocessed: boolean("is_unprocessed").notNull().default(true),
  completedAt: instant("completed_at"), version: integer("version").notNull().default(1),
  createdAt: instant("created_at").notNull().defaultNow(), updatedAt: instant("updated_at").notNull().defaultNow()
}, t => [unique("task_owner_unique").on(t.id, t.ownerId),
  check("task_title", sql`char_length(${t.title}) BETWEEN 1 AND 200 AND ${t.title} = normalize(btrim(${t.title}), NFC) AND ${t.title} !~ E'[\\r\\n]'`),
  check("task_version", sql`${t.version} > 0`),
  check("task_completion", sql`(${t.status} = 'open' AND ${t.completedAt} IS NULL) OR (${t.status} = 'completed' AND ${t.completedAt} IS NOT NULL)`),
  index("task_inbox_idx").on(t.ownerId, t.isUnprocessed, t.createdAt, t.id),
  index("task_date_idx").on(t.ownerId, t.status, t.scheduledDate, t.id), index("task_completed_idx").on(t.ownerId, t.completedAt, t.id)]);
export const taskActivities = pgTable("task_activities", {
  id: uuid("id").primaryKey().defaultRandom(), ownerId: text("owner_id").notNull(), taskId: uuid("task_id").notNull(),
  type: text("type").notNull(), occurredAt: instant("occurred_at").notNull().defaultNow(), invalidatedBy: uuid("invalidated_by")
}, t => [unique("activity_owner_task_unique").on(t.id, t.ownerId, t.taskId),
  foreignKey({ columns: [t.taskId, t.ownerId], foreignColumns: [tasks.id, tasks.ownerId] }).onDelete("cascade"),
  foreignKey({ columns: [t.invalidatedBy, t.ownerId, t.taskId], foreignColumns: [t.id, t.ownerId, t.taskId] }),
  check("activity_type", sql`${t.type} IN ('completed', 'completion_undone', 'scheduled_date_changed', 'processing_changed')`),
  check("activity_invalidation", sql`${t.invalidatedBy} IS NULL OR (${t.type} = 'completed' AND ${t.invalidatedBy} <> ${t.id})`),
  index("activity_task_idx").on(t.taskId, t.occurredAt)]);
export const idempotencyRecords = pgTable("idempotency_records", {
  ownerId: text("owner_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  method: text("method").notNull(), path: text("path").notNull(), key: text("key").notNull(),
  requestHash: text("request_hash").notNull(), state: text("state").notNull(),
  response: jsonb("response"), expiresAt: instant("expires_at").notNull(), createdAt: instant("created_at").notNull().defaultNow()
}, t => [primaryKey({ columns: [t.ownerId, t.method, t.path, t.key] }),
  check("request_hash", sql`${t.requestHash} ~ '^[a-f0-9]{64}$'`),
  check("request_state", sql`(${t.state} = 'processing' AND ${t.response} IS NULL) OR (${t.state} = 'completed' AND ${t.response} IS NOT NULL)`),
  index("request_expiry_idx").on(t.expiresAt)]);
