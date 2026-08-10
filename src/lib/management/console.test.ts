import { describe, expect, it } from "vitest";
import { console_users, scim_events, scim_group_members, scim_groups, scim_users } from "../../db/schema";
import { with_rollback_transaction } from "../database.testing";
import { create_server } from "./server";
import { get_console_counts, list_console_events, list_console_groups, list_console_users } from "./console";

describe("console data", () => {
  it(
    "counts and lists users and groups",
    with_rollback_transaction(async (transaction) => {
      const [owner] = await transaction.insert(console_users).values({ is_anonymous: false }).returning();
      const created = await create_server(owner!.id, "Console data", transaction);
      const [zoe, ada] = await transaction
        .insert(scim_users)
        .values([
          { server_id: created.server.id, user_name: "zoe@example.com" },
          { server_id: created.server.id, user_name: "ada@example.com" },
        ])
        .returning();
      const [engineering] = await transaction
        .insert(scim_groups)
        .values([
          { server_id: created.server.id, display_name: "Engineering" },
          { server_id: created.server.id, display_name: "Design" },
        ])
        .returning();
      await transaction.insert(scim_group_members).values([
        { group_id: engineering!.id, member_id: zoe!.id, member_type: "User" },
        { group_id: engineering!.id, member_id: ada!.id, member_type: "User" },
      ]);
      await transaction.insert(scim_events).values({
        server_id: created.server.id,
        method: "POST",
        path: "/Users",
        status: 201,
        duration_ms: 5,
      });

      expect(await get_console_counts(created.server.id, transaction)).toEqual({ users: 2, groups: 2, events: 1 });
      expect((await list_console_users(created.server.id, transaction)).map((user) => user.user_name)).toEqual([
        "ada@example.com",
        "zoe@example.com",
      ]);
      expect(
        (await list_console_groups(created.server.id, transaction)).map((group) => [
          group.display_name,
          group.member_count,
        ]),
      ).toEqual([
        ["Design", 0],
        ["Engineering", 2],
      ]);
    }),
  );

  it(
    "filters events and removes events older than thirty days",
    with_rollback_transaction(async (transaction) => {
      const [owner] = await transaction.insert(console_users).values({ is_anonymous: false }).returning();
      const created = await create_server(owner!.id, "Events", transaction);
      await transaction.insert(scim_events).values([
        {
          server_id: created.server.id,
          method: "GET",
          path: "/Users",
          status: 200,
          duration_ms: 2,
        },
        {
          server_id: created.server.id,
          method: "POST",
          path: "/Users",
          status: 400,
          duration_ms: 3,
        },
        {
          server_id: created.server.id,
          method: "DELETE",
          path: "/Users/old",
          status: 204,
          duration_ms: 1,
          created_at: new Date(Date.now() - 31 * 86_400_000),
        },
      ]);

      const successful_gets = await list_console_events(created.server.id, "success", "GET", transaction);
      expect(successful_gets.map((event) => [event.method, event.status])).toEqual([["GET", 200]]);
      const errors = await list_console_events(created.server.id, "error", undefined, transaction);
      expect(errors.map((event) => [event.method, event.status])).toEqual([["POST", 400]]);
      expect(await get_console_counts(created.server.id, transaction)).toEqual({ users: 0, groups: 0, events: 2 });
    }),
  );
});
