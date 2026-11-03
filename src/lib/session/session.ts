import { and, eq, gt, lt } from "drizzle-orm";
import type { ConsoleUserRecord, ScimServerRecord } from "../../db/schema.ts";
import { console_sessions, console_users, scim_servers, server_members } from "../../db/schema.ts";
import { encrypt_secret, generated_bearer_token, hash_secret, random_secret } from "../crypto.ts";
import type { Database } from "../database.ts";
import { generated_server_name } from "../management/server-name.ts";
import { TOUCH_INTERVAL_MS, type AnonymousWorkspace } from "./anonymous.ts";

export interface ConsoleContext {
  user: ConsoleUserRecord;
  session_token?: string;
  fresh_server?: ScimServerRecord;
  provisional?: AnonymousWorkspace;
}

export async function find_console_session(raw_token: string, database: Database): Promise<ConsoleContext | null> {
  const token_hash = hash_secret(raw_token);
  const rows = await database
    .select({ session: console_sessions, user: console_users })
    .from(console_sessions)
    .innerJoin(console_users, eq(console_sessions.user_id, console_users.id))
    .where(and(eq(console_sessions.token_hash, token_hash), gt(console_sessions.expires_at, new Date())))
    .limit(1);
  if (!rows[0]) {
    return null;
  }
  if (rows[0].session.last_seen_at.getTime() < Date.now() - TOUCH_INTERVAL_MS) {
    await database
      .update(console_sessions)
      .set({
        last_seen_at: new Date(),
        expires_at: new Date(Date.now() + (rows[0].user.is_anonymous ? 37 : 30) * 86_400_000),
      })
      .where(
        and(
          eq(console_sessions.token_hash, token_hash),
          lt(console_sessions.last_seen_at, new Date(Date.now() - TOUCH_INTERVAL_MS)),
        ),
      );
  }
  return { user: rows[0].user };
}

export async function create_anonymous_context(database: Database): Promise<ConsoleContext> {
  const session_token = random_secret();
  const bearer_token = generated_bearer_token();
  return database.transaction(async (transaction) => {
    const [user] = await transaction.insert(console_users).values({}).returning();
    if (!user) {
      throw new Error("Unable to create anonymous console user.");
    }
    await transaction.insert(console_sessions).values({
      token_hash: hash_secret(session_token),
      user_id: user.id,
      expires_at: new Date(Date.now() + 37 * 86_400_000),
    });
    const [server] = await transaction
      .insert(scim_servers)
      .values({
        name: generated_server_name(),
        created_by_user_id: user.id,
        bearer_token_hash: hash_secret(bearer_token),
        bearer_token_encrypted: encrypt_secret(bearer_token),
      })
      .returning();
    if (!server) {
      throw new Error("Unable to create the default SCIM server.");
    }
    await transaction.insert(server_members).values({ server_id: server.id, user_id: user.id });
    return { user, session_token, fresh_server: server };
  });
}

export async function replace_session(user_id: string, database: Database): Promise<string> {
  const session_token = random_secret();
  await database.transaction(async (transaction) => {
    await transaction.delete(console_sessions).where(eq(console_sessions.user_id, user_id));
    await transaction.insert(console_sessions).values({
      token_hash: hash_secret(session_token),
      user_id,
      expires_at: new Date(Date.now() + 30 * 86_400_000),
    });
  });
  return session_token;
}

export async function delete_session(raw_token: string, database: Database): Promise<void> {
  await database.delete(console_sessions).where(eq(console_sessions.token_hash, hash_secret(raw_token)));
}
