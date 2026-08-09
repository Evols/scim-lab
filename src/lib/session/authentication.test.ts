import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { console_users, scim_servers } from "../../db/schema";
import { with_rollback_transaction } from "../database.testing";
import { get_server_for_user } from "../management/server";
import { complete_oidc_login, save_oidc_transaction, take_oidc_transaction } from "./authentication";
import { create_anonymous_context } from "./session";

describe("OIDC session authentication", () => {
  it(
    "stores an OIDC transaction and returns it exactly once",
    with_rollback_transaction(async (transaction) => {
      const [user] = await transaction.insert(console_users).values({}).returning();

      await save_oidc_transaction(user!.id, "state", "verifier", "nonce", "/return", transaction);
      const stored = await take_oidc_transaction("state", transaction);
      expect(stored).toMatchObject({
        user_id: user!.id,
        code_verifier: "verifier",
        nonce: "nonce",
        return_to: "/return",
      });
      expect(await take_oidc_transaction("state", transaction)).toBeNull();
    }),
  );

  it(
    "upgrades an anonymous user and keeps its server",
    with_rollback_transaction(async (transaction) => {
      const anonymous = await create_anonymous_context(transaction);

      const user = await complete_oidc_login(
        anonymous.user.id,
        {
          issuer: "https://issuer.example",
          subject: "subject",
          email: "ada@example.com",
          display_name: "Ada",
        },
        transaction,
      );

      expect(user).toMatchObject({
        id: anonymous.user.id,
        is_anonymous: false,
        oidc_issuer: "https://issuer.example",
        oidc_subject: "subject",
        email: "ada@example.com",
        display_name: "Ada",
      });
      expect((await get_server_for_user(user.id, anonymous.fresh_server!.id, transaction))?.server.id).toBe(
        anonymous.fresh_server!.id,
      );
    }),
  );

  it(
    "merges an anonymous user's server into an existing OIDC account",
    with_rollback_transaction(async (transaction) => {
      const [existing] = await transaction
        .insert(console_users)
        .values({
          is_anonymous: false,
          oidc_issuer: "https://issuer.example",
          oidc_subject: "existing-subject",
        })
        .returning();
      const anonymous = await create_anonymous_context(transaction);

      const user = await complete_oidc_login(
        anonymous.user.id,
        { issuer: "https://issuer.example", subject: "existing-subject" },
        transaction,
      );

      expect(user.id).toBe(existing!.id);
      expect((await get_server_for_user(existing!.id, anonymous.fresh_server!.id, transaction))?.server.id).toBe(
        anonymous.fresh_server!.id,
      );
      expect(
        await transaction.select().from(console_users).where(eq(console_users.id, anonymous.user.id)),
      ).toHaveLength(0);
      expect(
        await transaction.select().from(scim_servers).where(eq(scim_servers.created_by_user_id, existing!.id)),
      ).toHaveLength(1);
    }),
  );
});
