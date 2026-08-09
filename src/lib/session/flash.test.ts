import { describe, expect, it } from "vitest";
import { console_flashes, console_users } from "../../db/schema";
import { hash_secret } from "../crypto";
import { with_rollback_transaction } from "../database.testing";
import { create_flash, take_flash } from "./flash";

describe("flash messages", () => {
  it(
    "returns a flash exactly once",
    with_rollback_transaction(async (transaction) => {
      const [user] = await transaction.insert(console_users).values({}).returning();

      const token = await create_flash(user!.id, { type: "success", message: "Saved" }, transaction);
      expect(await take_flash(user!.id, token, transaction)).toEqual({ type: "success", message: "Saved" });
      expect(await take_flash(user!.id, token, transaction)).toBeNull();
    }),
  );

  it(
    "does not return an expired flash or another user's flash",
    with_rollback_transaction(async (transaction) => {
      const [owner, other_user] = await transaction.insert(console_users).values([{}, {}]).returning();
      const token = "expired-flash-token";
      await transaction.insert(console_flashes).values({
        token_hash: hash_secret(token),
        user_id: owner!.id,
        payload: { message: "Too late" },
        expires_at: new Date(Date.now() - 1),
      });

      expect(await take_flash(owner!.id, token, transaction)).toBeNull();
      const active_token = await create_flash(owner!.id, { message: "Private" }, transaction);
      expect(await take_flash(other_user!.id, active_token, transaction)).toBeNull();
      expect(await take_flash(owner!.id, active_token, transaction)).toEqual({ message: "Private" });
    }),
  );
});
