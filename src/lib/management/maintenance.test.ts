import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { console_flashes, console_sessions, console_users, oidc_transactions, share_invites } from "../../db/schema";
import { with_rollback_transaction } from "../database.testing";
import { create_server } from "./server";
import { purge_expired_records } from "./maintenance";

describe("expired record maintenance", () => {
  it(
    "purges expired session records and old sharing links while retaining active records",
    with_rollback_transaction(async (transaction) => {
      const [user] = await transaction.insert(console_users).values({ is_anonymous: false }).returning();
      const created = await create_server(user!.id, "Maintenance", transaction);
      const future = new Date(Date.now() + 86_400_000);
      const past = new Date(Date.now() - 86_400_000);

      await transaction.insert(console_sessions).values([
        { token_hash: "expired-session", user_id: user!.id, expires_at: past },
        { token_hash: "active-session", user_id: user!.id, expires_at: future },
      ]);
      await transaction.insert(console_flashes).values([
        { token_hash: "expired-flash", user_id: user!.id, payload: {}, expires_at: past },
        { token_hash: "active-flash", user_id: user!.id, payload: {}, expires_at: future },
      ]);
      await transaction.insert(oidc_transactions).values([
        {
          state_hash: "expired-oidc",
          user_id: user!.id,
          code_verifier: "verifier",
          nonce: "nonce",
          expires_at: past,
        },
        {
          state_hash: "active-oidc",
          user_id: user!.id,
          code_verifier: "verifier",
          nonce: "nonce",
          expires_at: future,
        },
      ]);
      await transaction.insert(share_invites).values([
        {
          token_hash: "old-invite",
          server_id: created.server.id,
          created_by_user_id: user!.id,
          expires_at: new Date(Date.now() - 31 * 86_400_000),
        },
        {
          token_hash: "active-invite",
          server_id: created.server.id,
          created_by_user_id: user!.id,
          expires_at: future,
        },
      ]);

      await purge_expired_records(transaction);

      expect(
        (await transaction.select().from(console_sessions).where(eq(console_sessions.user_id, user!.id))).map(
          ({ token_hash }) => token_hash,
        ),
      ).toEqual(["active-session"]);
      expect(
        (await transaction.select().from(console_flashes).where(eq(console_flashes.user_id, user!.id))).map(
          ({ token_hash }) => token_hash,
        ),
      ).toEqual(["active-flash"]);
      expect(
        (await transaction.select().from(oidc_transactions).where(eq(oidc_transactions.user_id, user!.id))).map(
          ({ state_hash }) => state_hash,
        ),
      ).toEqual(["active-oidc"]);
      expect(
        (await transaction.select().from(share_invites).where(eq(share_invites.server_id, created.server.id))).map(
          ({ token_hash }) => token_hash,
        ),
      ).toEqual(["active-invite"]);
    }),
  );
});
