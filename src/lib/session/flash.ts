import { and, eq, gt } from "drizzle-orm";
import { console_flashes } from "../../db/schema.ts";
import { hash_secret, random_secret } from "../crypto.ts";
import type { Database } from "../database.ts";

export async function create_flash(
  user_id: string,
  payload: Record<string, unknown>,
  database: Database,
): Promise<string> {
  const token = random_secret();
  await database.insert(console_flashes).values({
    token_hash: hash_secret(token),
    user_id,
    payload,
    expires_at: new Date(Date.now() + 5 * 60_000),
  });
  return token;
}

export async function take_flash(
  user_id: string,
  token: string,
  database: Database,
): Promise<Record<string, unknown> | null> {
  return database.transaction(async (transaction) => {
    const rows = await transaction
      .select()
      .from(console_flashes)
      .where(
        and(
          eq(console_flashes.token_hash, hash_secret(token)),
          eq(console_flashes.user_id, user_id),
          gt(console_flashes.expires_at, new Date()),
        ),
      )
      .limit(1);
    if (!rows[0]) {
      return null;
    }
    await transaction.delete(console_flashes).where(eq(console_flashes.token_hash, rows[0].token_hash));
    return rows[0].payload;
  });
}
