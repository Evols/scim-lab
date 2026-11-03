import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  console_flashes,
  console_sessions,
  console_users,
  oidc_transactions,
  scim_servers,
  server_members,
  share_invites,
} from "../../db/schema";
import { with_rollback_transaction } from "../database.testing";
import { create_server } from "./server";
import { purge_expired_records } from "./maintenance";

describe("expired record maintenance", () => {
  it(
    "respects recovery windows, explicit deactivation, active sessions, and shared access",
    with_rollback_transaction(async (transaction) => {
      const day = 86_400_000;
      const old = new Date(Date.now() - 200 * day);
      const users = await transaction
        .insert(console_users)
        .values(
          [
            { created_at: old },
            { created_at: old },
            { is_anonymous: false, created_at: old },
            { is_anonymous: false, created_at: old },
            { created_at: old },
            { created_at: old },
            { created_at: old },
            { created_at: old },
            { created_at: old, updated_at: new Date() },
          ].map((user) => ({ updated_at: old, ...user })),
        )
        .returning();
      const servers = await transaction
        .insert(scim_servers)
        .values([
          {
            name: "anonymous expired",
            created_by_user_id: users[0]!.id,
            last_console_access_at: new Date(Date.now() - 15 * day),
          },
          {
            name: "anonymous recovery",
            created_by_user_id: users[1]!.id,
            last_console_access_at: new Date(Date.now() - 13 * day),
          },
          {
            name: "registered expired",
            created_by_user_id: users[2]!.id,
            last_console_access_at: new Date(Date.now() - 121 * day),
          },
          {
            name: "registered recovery",
            created_by_user_id: users[3]!.id,
            last_console_access_at: new Date(Date.now() - 119 * day),
          },
          {
            name: "explicit deactivation",
            created_by_user_id: users[4]!.id,
            deactivated_at: new Date(Date.now() - 8 * day),
          },
        ])
        .returning();
      await transaction.insert(console_sessions).values({
        token_hash: "protected-live-session",
        user_id: users[5]!.id,
        expires_at: new Date(Date.now() + day),
      });
      await transaction.insert(server_members).values({ server_id: servers[3]!.id, user_id: users[6]!.id });

      await purge_expired_records(transaction, 1000);

      for (const index of [0, 2, 4])
        expect(
          await transaction.select().from(scim_servers).where(eq(scim_servers.id, servers[index]!.id)),
        ).toHaveLength(0);
      for (const index of [1, 3])
        expect(
          await transaction.select().from(scim_servers).where(eq(scim_servers.id, servers[index]!.id)),
        ).toHaveLength(1);
      for (const index of [0, 4, 7])
        expect(
          await transaction.select().from(console_users).where(eq(console_users.id, users[index]!.id)),
        ).toHaveLength(0);
      for (const index of [1, 2, 3, 5, 6, 8])
        expect(
          await transaction.select().from(console_users).where(eq(console_users.id, users[index]!.id)),
        ).toHaveLength(1);
    }),
  );

  it(
    "purges expired session records and old sharing links while retaining active records",
    with_rollback_transaction(async (transaction) => {
      const [user] = await transaction.insert(console_users).values({ is_anonymous: false }).returning();
      const created = await create_server(user!.id, "Maintenance", transaction);
      const future = new Date(Date.now() + 86_400_000);
      const past = new Date(Date.now() - 86_400_000);

      await transaction.insert(console_sessions).values([
        { token_hash: "expired-session", user_id: user!.id, expires_at: past },
        {
          token_hash: "inactive-legacy-session",
          user_id: user!.id,
          last_seen_at: new Date(Date.now() - 15 * 86_400_000),
          expires_at: future,
        },
        {
          token_hash: "active-session",
          user_id: user!.id,
          created_at: new Date(Date.now() - 20 * 86_400_000),
          last_seen_at: new Date(Date.now() - 13 * 86_400_000),
          expires_at: future,
        },
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
