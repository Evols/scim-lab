import { and, eq, gt } from "drizzle-orm";
import { console_sessions, console_users, oidc_transactions, scim_servers, server_members } from "../../db/schema.ts";
import type { ConsoleUserRecord } from "../../db/schema.ts";
import { hash_secret } from "../crypto.ts";
import type { Database } from "../database.ts";

export interface OidcIdentity {
  issuer: string;
  subject: string;
  email?: string;
  display_name?: string;
}

export async function save_oidc_transaction(
  user_id: string,
  state: string,
  code_verifier: string,
  nonce: string,
  return_to: string,
  database: Database,
): Promise<void> {
  await database.insert(oidc_transactions).values({
    state_hash: hash_secret(state),
    user_id,
    code_verifier,
    nonce,
    return_to,
    expires_at: new Date(Date.now() + 10 * 60_000),
  });
}

export async function take_oidc_transaction(state: string, database: Database) {
  return database.transaction(async (transaction) => {
    const rows = await transaction
      .select()
      .from(oidc_transactions)
      .where(and(eq(oidc_transactions.state_hash, hash_secret(state)), gt(oidc_transactions.expires_at, new Date())))
      .limit(1);
    if (!rows[0]) {
      return null;
    }
    await transaction.delete(oidc_transactions).where(eq(oidc_transactions.state_hash, rows[0].state_hash));
    return rows[0];
  });
}

export async function complete_oidc_login(
  anonymous_user_id: string,
  identity: OidcIdentity,
  database: Database,
): Promise<ConsoleUserRecord> {
  return database.transaction(async (transaction) => {
    const existing = await transaction
      .select()
      .from(console_users)
      .where(and(eq(console_users.oidc_issuer, identity.issuer), eq(console_users.oidc_subject, identity.subject)))
      .limit(1);
    if (!existing[0] || existing[0].id === anonymous_user_id) {
      const [upgraded] = await transaction
        .update(console_users)
        .set({
          is_anonymous: false,
          oidc_issuer: identity.issuer,
          oidc_subject: identity.subject,
          email: identity.email,
          display_name: identity.display_name,
          upgraded_at: new Date(),
          updated_at: new Date(),
        })
        .where(eq(console_users.id, anonymous_user_id))
        .returning();
      if (!upgraded) {
        throw new Error("Unable to upgrade account.");
      }
      await transaction
        .update(scim_servers)
        .set({
          deactivated_at: null,
          last_console_access_at: new Date(),
          updated_at: new Date(),
        })
        .where(eq(scim_servers.created_by_user_id, upgraded.id));
      return upgraded;
    }
    const target = existing[0];
    const anonymous_memberships = await transaction
      .select()
      .from(server_members)
      .where(eq(server_members.user_id, anonymous_user_id));
    if (anonymous_memberships.length) {
      await transaction
        .insert(server_members)
        .values(
          anonymous_memberships.map((membership) => ({
            server_id: membership.server_id,
            user_id: target.id,
          })),
        )
        .onConflictDoNothing();
    }
    await transaction
      .update(scim_servers)
      .set({
        created_by_user_id: target.id,
        deactivated_at: null,
        last_console_access_at: new Date(),
        updated_at: new Date(),
      })
      .where(eq(scim_servers.created_by_user_id, anonymous_user_id));
    await transaction.delete(server_members).where(eq(server_members.user_id, anonymous_user_id));
    await transaction.delete(console_sessions).where(eq(console_sessions.user_id, anonymous_user_id));
    await transaction.delete(console_users).where(eq(console_users.id, anonymous_user_id));
    return target;
  });
}
