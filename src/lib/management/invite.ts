import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { console_users, scim_servers, server_members, share_invites } from "../../db/schema.ts";
import { hash_secret, random_secret } from "../crypto.ts";
import type { Database } from "../database.ts";
import { get_server_for_user } from "./server.ts";

export async function create_share_invite(user_id: string, server_id: string, database: Database): Promise<string> {
  const access = await get_server_for_user(user_id, server_id, database);
  const callers = await database.select().from(console_users).where(eq(console_users.id, user_id)).limit(1);
  if (!access || callers[0]?.is_anonymous !== false) {
    throw new Error("Sign in before sharing a server.");
  }
  const token = random_secret();
  await database.insert(share_invites).values({
    token_hash: hash_secret(token),
    server_id,
    created_by_user_id: user_id,
    expires_at: new Date(Date.now() + 30 * 86_400_000),
  });
  return token;
}

export async function list_share_invites(server_id: string, database: Database) {
  return database
    .select()
    .from(share_invites)
    .where(and(eq(share_invites.server_id, server_id), isNull(share_invites.revoked_at)))
    .orderBy(desc(share_invites.created_at));
}

export async function revoke_share_invite(
  user_id: string,
  server_id: string,
  token_hash: string,
  database: Database,
): Promise<void> {
  const access = await get_server_for_user(user_id, server_id, database);
  if (!access) {
    throw new Error("Server not found.");
  }
  await database
    .update(share_invites)
    .set({ revoked_at: new Date() })
    .where(and(eq(share_invites.server_id, server_id), eq(share_invites.token_hash, token_hash)));
}

export async function get_share_invite(token: string, database: Database) {
  const rows = await database
    .select({ invite: share_invites, server: scim_servers })
    .from(share_invites)
    .innerJoin(scim_servers, eq(share_invites.server_id, scim_servers.id))
    .where(
      and(
        eq(share_invites.token_hash, hash_secret(token)),
        isNull(share_invites.revoked_at),
        gt(share_invites.expires_at, new Date()),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function accept_share_invite(user_id: string, token: string, database: Database): Promise<string> {
  const match = await get_share_invite(token, database);
  if (!match) {
    throw new Error("This sharing link is invalid or expired.");
  }
  await database.insert(server_members).values({ server_id: match.server.id, user_id }).onConflictDoNothing();
  return match.server.id;
}
