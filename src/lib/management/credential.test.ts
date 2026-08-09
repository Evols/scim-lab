import { describe, expect, it } from "vitest";
import { console_users } from "../../db/schema";
import { with_rollback_transaction } from "../database.testing";
import { create_server } from "./server";
import { read_server_credential, rotate_server_auth } from "./credential";

describe("server credentials", () => {
  it(
    "reads and rotates bearer and Basic credentials",
    with_rollback_transaction(async (transaction) => {
      const [user] = await transaction.insert(console_users).values({ is_anonymous: false }).returning();
      const created = await create_server(user!.id, "Credentials", transaction);

      const initial = await read_server_credential(user!.id, created.server.id, transaction);
      expect(initial.auth_mode).toBe("bearer");
      expect(initial.username).toBeNull();
      expect(initial.credential).toMatch(/^scim_/);

      await rotate_server_auth(user!.id, created.server.id, "basic", transaction);
      const basic = await read_server_credential(user!.id, created.server.id, transaction);
      expect(basic.auth_mode).toBe("basic");
      expect(basic.username).toBe(`scim_${created.server.id.replaceAll("-", "").slice(0, 10)}`);
      expect(basic.credential).not.toBe(initial.credential);

      await rotate_server_auth(user!.id, created.server.id, "bearer", transaction);
      const bearer = await read_server_credential(user!.id, created.server.id, transaction);
      expect(bearer.auth_mode).toBe("bearer");
      expect(bearer.username).toBeNull();
      expect(bearer.credential).not.toBe(initial.credential);
    }),
  );

  it(
    "does not reveal credentials to a user without server access",
    with_rollback_transaction(async (transaction) => {
      const [owner, outsider] = await transaction
        .insert(console_users)
        .values([{ is_anonymous: false }, { is_anonymous: false }])
        .returning();
      const created = await create_server(owner!.id, "Private", transaction);

      await expect(read_server_credential(outsider!.id, created.server.id, transaction)).rejects.toThrow(
        "Server not found.",
      );
    }),
  );
});
