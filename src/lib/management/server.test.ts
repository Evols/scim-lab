import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { ScimServerRecord } from "../../db/schema";
import { console_users, scim_servers } from "../../db/schema";
import { with_rollback_transaction } from "../database.testing";
import {
  create_server,
  delete_server,
  get_server_for_user,
  get_server_lifecycle,
  list_servers_for_user,
  mark_server_deactivated,
  reactivate_server,
  rename_server,
} from "./server";

describe("server management", () => {
  it("calculates anonymous and signed-in server lifecycles", () => {
    const now = new Date("2026-08-08T00:00:00Z");
    const server = {
      id: crypto.randomUUID(),
      name: "Test server",
      created_by_user_id: crypto.randomUUID(),
      auth_mode: "bearer",
      bearer_token_hash: null,
      bearer_token_encrypted: null,
      basic_username: null,
      basic_password_hash: null,
      basic_password_encrypted: null,
      credential_rotated_at: now,
      last_console_access_at: new Date("2026-08-02T00:00:01Z"),
      deactivated_at: null,
      created_at: now,
      updated_at: now,
    } satisfies ScimServerRecord;

    expect(get_server_lifecycle(server, true, now)).toBe("active");
    expect(
      get_server_lifecycle({ ...server, last_console_access_at: new Date("2026-08-01T00:00:00Z") }, true, now),
    ).toBe("deactivated");
    expect(
      get_server_lifecycle({ ...server, last_console_access_at: new Date("2026-07-25T00:00:00Z") }, true, now),
    ).toBe("deactivated");
    expect(
      get_server_lifecycle({ ...server, last_console_access_at: new Date("2026-07-24T23:59:59Z") }, true, now),
    ).toBe("expired");
    expect(
      get_server_lifecycle({ ...server, last_console_access_at: new Date("2026-07-10T00:00:01Z") }, false, now),
    ).toBe("active");
    expect(
      get_server_lifecycle({ ...server, last_console_access_at: new Date("2026-07-09T00:00:00Z") }, false, now),
    ).toBe("deactivated");
    expect(
      get_server_lifecycle({ ...server, last_console_access_at: new Date("2026-03-01T00:00:00Z") }, false, now),
    ).toBe("expired");
  });

  it(
    "creates, finds, lists, renames, and deletes a server",
    with_rollback_transaction(async (transaction) => {
      const [user] = await transaction.insert(console_users).values({ is_anonymous: false }).returning();

      const created = await create_server(user!.id, "Initial name", transaction);
      expect((await get_server_for_user(user!.id, created.server.id, transaction))?.server.name).toBe("Initial name");
      expect((await list_servers_for_user(user!.id, transaction)).map(({ server }) => server.id)).toEqual([
        created.server.id,
      ]);

      await rename_server(user!.id, created.server.id, "Renamed server", transaction);
      expect((await get_server_for_user(user!.id, created.server.id, transaction))?.server.name).toBe("Renamed server");

      await delete_server(user!.id, created.server.id, transaction);
      expect(await get_server_for_user(user!.id, created.server.id, transaction)).toBeNull();
    }),
  );

  it(
    "limits a signed-in user to three created servers",
    with_rollback_transaction(async (transaction) => {
      const [user] = await transaction.insert(console_users).values({ is_anonymous: false }).returning();

      await create_server(user!.id, "One", transaction);
      await create_server(user!.id, "Two", transaction);
      await create_server(user!.id, "Three", transaction);

      await expect(create_server(user!.id, "Four", transaction)).rejects.toThrow(
        "You can create at most three SCIM servers.",
      );
    }),
  );

  it(
    "generates a name when none is supplied",
    with_rollback_transaction(async (transaction) => {
      const [user] = await transaction.insert(console_users).values({ is_anonymous: false }).returning();

      const created = await create_server(user!.id, "", transaction);

      expect(created.server.name).toMatch(/^[a-z]+-[a-z]+-\d{6}$/);
    }),
  );

  it(
    "deactivates an inactive server and lets a signed-in owner reactivate it",
    with_rollback_transaction(async (transaction) => {
      const [user] = await transaction.insert(console_users).values({ is_anonymous: false }).returning();
      const created = await create_server(user!.id, "Inactive", transaction);
      const last_console_access_at = new Date(Date.now() - 31 * 86_400_000);
      const [inactive] = await transaction
        .update(scim_servers)
        .set({ last_console_access_at })
        .where(eq(scim_servers.id, created.server.id))
        .returning();

      const deactivated = await mark_server_deactivated(inactive!, false, transaction);
      expect(deactivated.deactivated_at).toEqual(new Date(last_console_access_at.getTime() + 30 * 86_400_000));
      expect(await reactivate_server(user!.id, created.server.id, transaction)).toBe(true);

      const reactivated = await get_server_for_user(user!.id, created.server.id, transaction);
      expect(reactivated?.server.deactivated_at).toBeNull();
      expect(reactivated!.server.last_console_access_at.getTime()).toBeGreaterThan(last_console_access_at.getTime());
    }),
  );
});
