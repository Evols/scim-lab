import {
  bigserial,
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
} from "drizzle-orm/pg-core";

const timestamps = {
  created_at: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updated_at: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
};

export const console_users = pgTable(
  "console_users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    is_anonymous: boolean("is_anonymous").notNull().default(true),
    oidc_issuer: text("oidc_issuer"),
    oidc_subject: text("oidc_subject"),
    email: text("email"),
    display_name: text("display_name"),
    upgraded_at: timestamp("upgraded_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("uq_console_users_oidc_identity")
      .on(table.oidc_issuer, table.oidc_subject)
      .where(
        sql`${table.oidc_issuer} is not null and ${table.oidc_subject} is not null`,
      ),
  ],
);

export const console_sessions = pgTable(
  "console_sessions",
  {
    token_hash: text("token_hash").primaryKey(),
    user_id: uuid("user_id")
      .notNull()
      .references(() => console_users.id, { onDelete: "cascade" }),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    last_seen_at: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("idx_console_sessions_user_id").on(table.user_id),
    index("idx_console_sessions_expires_at").on(table.expires_at),
  ],
);

export const oidc_transactions = pgTable(
  "oidc_transactions",
  {
    state_hash: text("state_hash").primaryKey(),
    user_id: uuid("user_id")
      .notNull()
      .references(() => console_users.id, { onDelete: "cascade" }),
    code_verifier: text("code_verifier").notNull(),
    nonce: text("nonce").notNull(),
    return_to: text("return_to").notNull().default("/"),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [index("idx_oidc_transactions_expires_at").on(table.expires_at)],
);

export const console_flashes = pgTable(
  "console_flashes",
  {
    token_hash: text("token_hash").primaryKey(),
    user_id: uuid("user_id")
      .notNull()
      .references(() => console_users.id, { onDelete: "cascade" }),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [index("idx_console_flashes_expires_at").on(table.expires_at)],
);

export const scim_servers = pgTable(
  "scim_servers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    created_by_user_id: uuid("created_by_user_id")
      .notNull()
      .references(() => console_users.id, { onDelete: "restrict" }),
    auth_mode: text("auth_mode").notNull().default("bearer"),
    bearer_token_hash: text("bearer_token_hash"),
    bearer_token_encrypted: text("bearer_token_encrypted"),
    basic_username: text("basic_username"),
    basic_password_hash: text("basic_password_hash"),
    basic_password_encrypted: text("basic_password_encrypted"),
    credential_rotated_at: timestamp("credential_rotated_at", {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
    last_console_access_at: timestamp("last_console_access_at", {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
    deactivated_at: timestamp("deactivated_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("idx_scim_servers_created_by_user_id").on(table.created_by_user_id),
    index("idx_scim_servers_last_console_access_at").on(
      table.last_console_access_at,
    ),
  ],
);

export const server_members = pgTable(
  "server_members",
  {
    server_id: uuid("server_id")
      .notNull()
      .references(() => scim_servers.id, { onDelete: "cascade" }),
    user_id: uuid("user_id")
      .notNull()
      .references(() => console_users.id, { onDelete: "cascade" }),
    joined_at: timestamp("joined_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.server_id, table.user_id] }),
    index("idx_server_members_user_id").on(table.user_id),
  ],
);

export const share_invites = pgTable(
  "share_invites",
  {
    token_hash: text("token_hash").primaryKey(),
    server_id: uuid("server_id")
      .notNull()
      .references(() => scim_servers.id, { onDelete: "cascade" }),
    created_by_user_id: uuid("created_by_user_id")
      .notNull()
      .references(() => console_users.id, { onDelete: "cascade" }),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    revoked_at: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_share_invites_server_id").on(table.server_id),
    index("idx_share_invites_expires_at").on(table.expires_at),
  ],
);

export const scim_users = pgTable(
  "scim_users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    server_id: uuid("server_id")
      .notNull()
      .references(() => scim_servers.id, { onDelete: "cascade" }),
    external_id: text("external_id"),
    user_name: text("user_name").notNull(),
    display_name: text("display_name"),
    active: boolean("active").notNull().default(true),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    version: integer("version").notNull().default(1),
    ...timestamps,
  },
  (table) => [
    index("idx_scim_users_server_id_created_at").on(
      table.server_id,
      table.created_at,
    ),
    index("idx_scim_users_server_id_external_id").on(
      table.server_id,
      table.external_id,
    ),
    uniqueIndex("uq_scim_users_server_user_name_lower").on(
      table.server_id,
      sql`lower(${table.user_name})`,
    ),
  ],
);

export const scim_groups = pgTable(
  "scim_groups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    server_id: uuid("server_id")
      .notNull()
      .references(() => scim_servers.id, { onDelete: "cascade" }),
    external_id: text("external_id"),
    display_name: text("display_name").notNull(),
    version: integer("version").notNull().default(1),
    ...timestamps,
  },
  (table) => [
    index("idx_scim_groups_server_id_created_at").on(
      table.server_id,
      table.created_at,
    ),
    index("idx_scim_groups_server_id_external_id").on(
      table.server_id,
      table.external_id,
    ),
  ],
);

export const scim_group_members = pgTable(
  "scim_group_members",
  {
    group_id: uuid("group_id")
      .notNull()
      .references(() => scim_groups.id, { onDelete: "cascade" }),
    user_id: uuid("user_id")
      .notNull()
      .references(() => scim_users.id, { onDelete: "cascade" }),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.group_id, table.user_id] }),
    index("idx_scim_group_members_user_id").on(table.user_id),
  ],
);

export const scim_events = pgTable(
  "scim_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    server_id: uuid("server_id")
      .notNull()
      .references(() => scim_servers.id, { onDelete: "cascade" }),
    method: text("method").notNull(),
    path: text("path").notNull(),
    status: integer("status").notNull(),
    duration_ms: integer("duration_ms").notNull(),
    auth_mode: text("auth_mode"),
    auth_success: boolean("auth_success").notNull().default(false),
    request_headers: jsonb("request_headers")
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    request_body: text("request_body"),
    response_body: text("response_body"),
    request_truncated: boolean("request_truncated").notNull().default(false),
    response_truncated: boolean("response_truncated").notNull().default(false),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_scim_events_server_created_at").on(
      table.server_id,
      table.created_at,
    ),
    index("idx_scim_events_server_id_id").on(table.server_id, table.id),
  ],
);

export type ConsoleUserRecord = typeof console_users.$inferSelect;
export type ScimServerRecord = typeof scim_servers.$inferSelect;
export type ScimUserRecord = typeof scim_users.$inferSelect;
export type ScimGroupRecord = typeof scim_groups.$inferSelect;
export type ScimEventRecord = typeof scim_events.$inferSelect;

import { sql } from "drizzle-orm";
