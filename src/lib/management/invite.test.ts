import { describe, expect, it } from "vitest";
import { console_users } from "../../db/schema";
import { with_rollback_transaction } from "../database.testing";
import { get_server_for_user, create_server } from "./server";
import {
  accept_share_invite,
  create_share_invite,
  get_share_invite,
  list_share_invites,
  revoke_share_invite,
} from "./invite";

describe("server sharing", () => {
  it(
    "creates, accepts, lists, and revokes an invite",
    with_rollback_transaction(async (transaction) => {
      const [owner, invitee] = await transaction
        .insert(console_users)
        .values([{ is_anonymous: false }, { is_anonymous: false }])
        .returning();
      const created = await create_server(owner!.id, "Shared server", transaction);

      const token = await create_share_invite(owner!.id, created.server.id, transaction);
      const invite = await get_share_invite(token, transaction);
      expect(invite?.server.id).toBe(created.server.id);
      expect(await list_share_invites(created.server.id, transaction)).toHaveLength(1);

      expect(await accept_share_invite(invitee!.id, token, transaction)).toBe(created.server.id);
      expect((await get_server_for_user(invitee!.id, created.server.id, transaction))?.server.id).toBe(
        created.server.id,
      );

      await revoke_share_invite(owner!.id, created.server.id, invite!.invite.token_hash, transaction);
      expect(await get_share_invite(token, transaction)).toBeNull();
      expect(await list_share_invites(created.server.id, transaction)).toHaveLength(0);
    }),
  );

  it(
    "does not let an anonymous user create sharing links",
    with_rollback_transaction(async (transaction) => {
      const [user] = await transaction.insert(console_users).values({}).returning();
      const created = await create_server(user!.id, "Anonymous server", transaction);

      await expect(create_share_invite(user!.id, created.server.id, transaction)).rejects.toThrow(
        "Sign in before sharing a server.",
      );
    }),
  );
});
