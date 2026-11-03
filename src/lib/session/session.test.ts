import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { console_sessions, console_users } from "../../db/schema";
import { hash_secret } from "../crypto";
import { with_rollback_transaction } from "../database.testing";
import { get_server_for_user } from "../management/server";
import { create_anonymous_context, delete_session, find_console_session, replace_session } from "./session";

describe("console sessions", () => {
  it(
    "keeps session timestamps stable on repeated visits and renews older activity",
    with_rollback_transaction(async (transaction) => {
      const context = await create_anonymous_context(transaction);
      const read = async () =>
        (await transaction.select().from(console_sessions).where(eq(console_sessions.user_id, context.user.id)))[0]!;
      const first = await read();
      expect(first.expires_at.getTime() - Date.now()).toBeCloseTo(14 * 86_400_000, -3);
      await find_console_session(context.session_token!, transaction);
      expect(await read()).toEqual(first);
      const old_seen = new Date(Date.now() - 60 * 60_000);
      await transaction
        .update(console_sessions)
        .set({ last_seen_at: old_seen })
        .where(eq(console_sessions.user_id, context.user.id));
      await find_console_session(context.session_token!, transaction);
      const renewed = await read();
      expect(renewed.last_seen_at.getTime()).toBeGreaterThan(old_seen.getTime());
      expect(renewed.expires_at.getTime() - renewed.last_seen_at.getTime()).toBe(14 * 86_400_000);
      await find_console_session(context.session_token!, transaction);
      expect(await read()).toEqual(renewed);
    }),
  );
  it(
    "creates an anonymous user, session, and default server",
    with_rollback_transaction(async (transaction) => {
      const context = await create_anonymous_context(transaction);

      expect(context.user.is_anonymous).toBe(true);
      expect(context.session_token).toBeTruthy();
      expect(context.fresh_server?.name).toMatch(/^[a-z]+-[a-z]+-\d{6}$/);
      expect((await find_console_session(context.session_token!, transaction))?.user.id).toBe(context.user.id);
      expect((await get_server_for_user(context.user.id, context.fresh_server!.id, transaction))?.server.id).toBe(
        context.fresh_server!.id,
      );
    }),
  );

  it(
    "replaces and deletes a user's session",
    with_rollback_transaction(async (transaction) => {
      const context = await create_anonymous_context(transaction);

      const replacement = await replace_session(context.user.id, transaction);
      expect(await find_console_session(context.session_token!, transaction)).toBeNull();
      expect((await find_console_session(replacement, transaction))?.user.id).toBe(context.user.id);
      const [session] = await transaction
        .select()
        .from(console_sessions)
        .where(eq(console_sessions.token_hash, hash_secret(replacement)));
      expect(session!.expires_at.getTime() - Date.now()).toBeCloseTo(14 * 86_400_000, -3);

      await delete_session(replacement, transaction);
      expect(await find_console_session(replacement, transaction)).toBeNull();
    }),
  );

  it.each([true, false])("rejects legacy sessions after 14 inactive days (anonymous: %s)", (is_anonymous) =>
    with_rollback_transaction(async (transaction) => {
      const day = 86_400_000;
      const [user] = await transaction.insert(console_users).values({ is_anonymous }).returning();
      const raw_token = "legacy-session-token";
      await transaction.insert(console_sessions).values({
        token_hash: hash_secret(raw_token),
        user_id: user!.id,
        created_at: new Date(Date.now() - 20 * day),
        last_seen_at: new Date(Date.now() - 13 * day),
        expires_at: new Date(Date.now() + 17 * day),
      });

      expect((await find_console_session(raw_token, transaction))?.user.id).toBe(user!.id);
      await transaction
        .update(console_sessions)
        .set({ last_seen_at: new Date(Date.now() - 15 * day) })
        .where(eq(console_sessions.token_hash, hash_secret(raw_token)));
      expect(await find_console_session(raw_token, transaction)).toBeNull();
    })(),
  );

  it(
    "ignores an expired session",
    with_rollback_transaction(async (transaction) => {
      const [user] = await transaction.insert(console_users).values({}).returning();
      const raw_token = "expired-session-token";
      await transaction.insert(console_sessions).values({
        token_hash: hash_secret(raw_token),
        user_id: user!.id,
        expires_at: new Date(Date.now() - 1),
      });

      expect(await find_console_session(raw_token, transaction)).toBeNull();
    }),
  );
});
