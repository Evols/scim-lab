import { lt, or, sql } from "drizzle-orm";
import { console_flashes, console_sessions, oidc_transactions, share_invites } from "../../db/schema.ts";
import type { Database } from "../database.ts";

export async function purge_expired_records(database: Database): Promise<void> {
  await database.delete(console_sessions).where(lt(console_sessions.expires_at, new Date()));
  await database.delete(console_flashes).where(lt(console_flashes.expires_at, new Date()));
  await database.delete(oidc_transactions).where(lt(oidc_transactions.expires_at, new Date()));
  await database
    .delete(share_invites)
    .where(
      or(
        lt(share_invites.expires_at, new Date(Date.now() - 30 * 86_400_000)),
        sql`${share_invites.revoked_at} is not null and ${share_invites.revoked_at} < now() - interval '30 days'`,
      ),
    );
}
