import { describe, expect, it } from "vitest";
import { console_sessions, console_users } from "../../db/schema";
import { hash_secret } from "../crypto";
import { with_rollback_transaction } from "../database.testing";
import { get_server_for_user } from "../management/server";
import { create_anonymous_context, delete_session, find_console_session, replace_session } from "./session";

describe("console sessions", () => {
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

      await delete_session(replacement, transaction);
      expect(await find_console_session(replacement, transaction)).toBeNull();
    }),
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
