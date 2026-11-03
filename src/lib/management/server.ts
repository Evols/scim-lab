import { and, count, desc, eq, inArray, isNotNull, lt, or, sql } from "drizzle-orm";
import { TOUCH_INTERVAL_MS } from "../session/anonymous.ts";
import type { ConsoleUserRecord, ScimServerRecord } from "../../db/schema.ts";
import { console_users, scim_servers, server_members } from "../../db/schema.ts";
import { encrypt_secret, generated_bearer_token, hash_secret } from "../crypto.ts";
import type { Database } from "../database.ts";
import { generated_server_name } from "./server-name.ts";

export interface ServerAccess {
  server: ScimServerRecord;
  creator: ConsoleUserRecord;
}

export type ServerLifecycle = "active" | "deactivated" | "expired";

export function get_server_lifecycle(
  server: ScimServerRecord,
  is_anonymous: boolean,
  now = new Date(),
): ServerLifecycle {
  const inactive_ms = now.getTime() - server.last_console_access_at.getTime();
  const active_window_ms = (is_anonymous ? 7 : 30) * 86_400_000;
  const deactivated_at = server.deactivated_at ?? new Date(server.last_console_access_at.getTime() + active_window_ms);
  if (inactive_ms < active_window_ms && !server.deactivated_at) {
    return "active";
  }
  const recovery_ms = (is_anonymous ? 30 : 90) * 86_400_000;
  return now.getTime() <= deactivated_at.getTime() + recovery_ms ? "deactivated" : "expired";
}

export async function list_servers_for_user(user_id: string, database: Database): Promise<ServerAccess[]> {
  const rows = await database
    .select({ server: scim_servers, creator: console_users })
    .from(server_members)
    .innerJoin(scim_servers, eq(server_members.server_id, scim_servers.id))
    .innerJoin(console_users, eq(scim_servers.created_by_user_id, console_users.id))
    .where(eq(server_members.user_id, user_id))
    .orderBy(desc(scim_servers.created_at));
  const expired_ids = rows
    .filter(({ server, creator }) => get_server_lifecycle(server, creator.is_anonymous) === "expired")
    .map(({ server }) => server.id);
  if (expired_ids.length) {
    await database.delete(scim_servers).where(inArray(scim_servers.id, expired_ids));
  }
  return rows.filter(({ server }) => !expired_ids.includes(server.id));
}

export async function get_server_for_user(
  user_id: string,
  server_id: string,
  database: Database,
): Promise<ServerAccess | null> {
  const rows = await database
    .select({ server: scim_servers, creator: console_users })
    .from(server_members)
    .innerJoin(scim_servers, eq(server_members.server_id, scim_servers.id))
    .innerJoin(console_users, eq(scim_servers.created_by_user_id, console_users.id))
    .where(and(eq(server_members.user_id, user_id), eq(server_members.server_id, server_id)))
    .limit(1);
  return rows[0] ?? null;
}

export async function touch_server_console(server_id: string, database: Database): Promise<void> {
  await database
    .update(scim_servers)
    .set({
      last_console_access_at: new Date(),
      deactivated_at: null,
      updated_at: new Date(),
    })
    .where(
      and(
        eq(scim_servers.id, server_id),
        or(
          lt(scim_servers.last_console_access_at, new Date(Date.now() - TOUCH_INTERVAL_MS)),
          isNotNull(scim_servers.deactivated_at),
        ),
      ),
    );
}

export async function mark_server_deactivated(
  server: ScimServerRecord,
  is_anonymous: boolean,
  database: Database,
): Promise<ScimServerRecord> {
  const lifecycle = get_server_lifecycle(server, is_anonymous);
  if (lifecycle === "active" || server.deactivated_at) {
    return server;
  }
  const active_days = is_anonymous ? 7 : 30;
  const deactivated_at = new Date(server.last_console_access_at.getTime() + active_days * 86_400_000);
  const [updated] = await database
    .update(scim_servers)
    .set({ deactivated_at, updated_at: new Date() })
    .where(eq(scim_servers.id, server.id))
    .returning();
  return updated ?? server;
}

export async function reactivate_server(user_id: string, server_id: string, database: Database): Promise<boolean> {
  const access = await get_server_for_user(user_id, server_id, database);
  if (!access || access.creator.is_anonymous || get_server_lifecycle(access.server, false) === "expired") {
    return false;
  }
  await touch_server_console(server_id, database);
  return true;
}

export async function create_server(user_id: string, name: string, database: Database) {
  return database.transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtext(${user_id}))`);
    const [{ value }] = await transaction
      .select({ value: count() })
      .from(scim_servers)
      .where(eq(scim_servers.created_by_user_id, user_id));
    if (Number(value) >= 3) {
      throw new Error("You can create at most three SCIM servers.");
    }
    const bearer_token = generated_bearer_token();
    const [server] = await transaction
      .insert(scim_servers)
      .values({
        name: name.slice(0, 80) || generated_server_name(),
        created_by_user_id: user_id,
        bearer_token_hash: hash_secret(bearer_token),
        bearer_token_encrypted: encrypt_secret(bearer_token),
      })
      .returning();
    if (!server) {
      throw new Error("Unable to create SCIM server.");
    }
    await transaction.insert(server_members).values({ server_id: server.id, user_id });
    return { server };
  });
}

export async function rename_server(
  user_id: string,
  server_id: string,
  name: string,
  database: Database,
): Promise<void> {
  const access = await get_server_for_user(user_id, server_id, database);
  if (!access) {
    throw new Error("Server not found.");
  }
  await database
    .update(scim_servers)
    .set({ name: name.slice(0, 80), updated_at: new Date() })
    .where(eq(scim_servers.id, server_id));
}

export async function delete_server(user_id: string, server_id: string, database: Database): Promise<void> {
  const access = await get_server_for_user(user_id, server_id, database);
  if (!access) {
    throw new Error("Server not found.");
  }
  await database.delete(scim_servers).where(eq(scim_servers.id, server_id));
}
